'use strict';
// Drive times and road geometry from Valhalla (the public FOSSGIS instance behind
// openstreetmap.org's directions). Car costing with the vehicle height (a rooftop tent
// makes the car ~2 m tall: some car parks and tunnels are out) and tolls excluded on
// non-motorway days. Times are cached in db:own; many legs are asked in ONE matrix call
// (`sources_to_targets`) instead of one request each — the public server is shared.
const cache = require('./cache');
const { roundPt, thin } = require('./util');

const VALHALLA = 'https://valhalla1.openstreetmap.de';
const UA = 'rooftop-planner-plugin (TREK plugin; +https://github.com/EvKoh/rooftop-planner-plugin)';
const MATRIX_MAX = 20; // sources (and targets) per matrix request

/** Decode a Valhalla polyline (precision 6) into [lat, lng] pairs. */
function decodePolyline(str, precision = 6) {
  const out = [];
  const f = 10 ** precision;
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < str.length) {
    for (const axis of [0, 1]) {
      let b;
      let shift = 0;
      let res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (axis === 0) lat += d; else lng += d;
    }
    out.push([Math.round((lat / f) * 1e5) / 1e5, Math.round((lng / f) * 1e5) / 1e5]);
  }
  return out;
}

function costing(opts) {
  return { auto: { exclude_tolls: !opts.tolls, height: opts.height ?? 1.95 } };
}

async function post(path, body, timeoutMs) {
  const r = await fetch(`${VALHALLA}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
  });
  let d;
  try { d = await r.json(); } catch { d = {}; }
  if (!r.ok) throw new Error(`Valhalla ${r.status}${d.error ? `: ${d.error}` : ''}`);
  return d;
}

/**
 * Route through `points` ([lat,lng] list, in order). Returns
 * { km, minutes, legs: [{km, minutes}], points: [[lat,lng]...] (≤ maxPoints) }.
 */
async function route(points, opts = {}) {
  const d = await post('/route', {
    locations: points.map((p) => ({ lat: +p[0], lon: +p[1], type: 'break' })),
    costing: 'auto',
    costing_options: costing(opts),
    units: 'kilometers',
    directions_type: 'none',
  }, opts.timeoutMs ?? 12000);
  if (!d.trip) throw new Error('Valhalla: no route');
  const pts = [].concat(...d.trip.legs.map((l) => decodePolyline(l.shape)));
  return {
    km: Math.round(d.trip.summary.length * 10) / 10,
    minutes: Math.round(d.trip.summary.time / 60),
    legs: d.trip.legs.map((l) => ({ km: Math.round(l.summary.length * 10) / 10, minutes: Math.round(l.summary.time / 60) })),
    points: thin(pts, opts.maxPoints ?? 1500),
  };
}

/** sources × targets drive minutes (null where no route). */
async function matrix(sources, targets, opts = {}) {
  const d = await post('/sources_to_targets', {
    sources: sources.map((p) => ({ lat: +p[0], lon: +p[1] })),
    targets: targets.map((p) => ({ lat: +p[0], lon: +p[1] })),
    costing: 'auto',
    costing_options: costing(opts),
    units: 'kilometers',
  }, opts.timeoutMs ?? 12000);
  const rows = d.sources_to_targets || [];
  return sources.map((_, i) => targets.map((__, j) => {
    const c = rows[i] && rows[i][j];
    return c && c.time != null ? { minutes: Math.round(c.time / 60), km: Math.round((c.distance ?? 0) * 10) / 10 } : null;
  }));
}

function legKey(a, b, opts) {
  const ra = roundPt(a);
  const rb = roundPt(b);
  return `route:${opts.tolls ? 'T' : 'N'}:${opts.height ?? 1.95}:${ra.join(',')}|${rb.join(',')}`;
}

/**
 * Drive minutes for many [from, to] pairs, cache first. Missing pairs are computed with
 * matrix calls while `dl` (a deadline) allows and `network` is true.
 * Returns { values: Map(index → {minutes, km} | null), pending: number }.
 */
async function legs(ctx, pairs, opts = {}) {
  const keys = pairs.map(([a, b]) => legKey(a, b, opts));
  const hits = await cache.getMany(ctx, keys);
  const values = new Map();
  const todo = [];
  pairs.forEach((p, i) => {
    if (hits.has(keys[i])) values.set(i, hits.get(keys[i]));
    else todo.push(i);
  });
  let pending = 0;
  if (todo.length && opts.network !== false) {
    // Group by origin: each matrix row is one origin, its targets are that origin's ends.
    const fresh = [];
    for (let s = 0; s < todo.length; s += MATRIX_MAX) {
      const chunk = todo.slice(s, s + MATRIX_MAX);
      if (opts.deadline && opts.deadline.left() < 4000) { pending += todo.length - s; break; }
      const src = [];
      const tgt = [];
      const si = new Map();
      const ti = new Map();
      for (const i of chunk) {
        const [a, b] = pairs[i];
        const ka = roundPt(a).join(',');
        const kb = roundPt(b).join(',');
        if (!si.has(ka)) { si.set(ka, src.length); src.push(a); }
        if (!ti.has(kb)) { ti.set(kb, tgt.length); tgt.push(b); }
      }
      let m;
      try {
        m = await matrix(src, tgt, { ...opts, timeoutMs: opts.deadline ? Math.min(12000, opts.deadline.left() - 1500) : 12000 });
      } catch (e) {
        ctx.log?.warn?.('valhalla matrix failed', { error: String(e && e.message) });
        pending += chunk.length;
        continue;
      }
      for (const i of chunk) {
        const [a, b] = pairs[i];
        const v = m[si.get(roundPt(a).join(','))][ti.get(roundPt(b).join(','))];
        values.set(i, v);
        fresh.push([keys[i], v]);
      }
    }
    await cache.setMany(ctx, fresh);
  } else {
    pending = todo.length;
  }
  return { values, pending };
}

module.exports = { route, matrix, legs, legKey, decodePolyline, VALHALLA };
