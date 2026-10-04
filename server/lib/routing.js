'use strict';
// Drive times and road geometry from Valhalla (the public FOSSGIS instance behind
// openstreetmap.org's directions). Car costing with the vehicle height (a rooftop tent
// makes the car ~2 m tall: some car parks and tunnels are out) and tolls excluded on
// non-motorway days. Times are cached in db:own; many legs are asked in ONE matrix call
// (`sources_to_targets`) instead of one request each — the public server is shared.
const cache = require('./cache');
const { roundPt, thin, distKm, pmap } = require('./util');

const VALHALLA = 'https://valhalla1.openstreetmap.de';
const UA = 'vanlife (TREK plugin; +https://github.com/EvkohLand/TrekPluginVanlife)';
// The public server refuses a matrix above 100 cells ("Exceeded max locations: 100",
// seen 2026-10-03 with 20 x 20): chunks keep sources x targets <= 100.
const MATRIX_CELLS = 100;
// It also refuses any matrix path over 150 km ("Path distance exceeds the max distance
// limit: 150000 meters"), and one such pair fails its whole chunk: pairs farther apart
// than this (straight line) are routed one by one with /route instead.
const MATRIX_MAX_KM = 110;

/** Decode a Valhalla polyline (precision 6) into [lat, lng] pairs. */
/** Routing options of the traveller's vehicle, from the settings. */
function vehicleOpts(settings, tolls) {
  return { tolls, vehicle: settings.vehicle, height: settings.vehicle_height_m, length: settings.vehicle_length_m, weight: settings.vehicle_weight_t, factor: settings.drive_time_factor };
}

// The open router is slow on mountain roads (measured against the traveller's own map):
// the user's factor rescales every drive time. The cache keeps the router's own minutes.
const scaled = (minutes, opts) => (minutes == null || !(opts.factor > 0) || opts.factor === 1 ? minutes : Math.round(minutes * opts.factor));

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

/**
 * Valhalla costing for the vehicle: a motorhome is routed as a truck so its length and
 * weight count (narrow passes, weight-limited bridges); a car with a rooftop tent or a van
 * as a car with its height.
 */
function costingOf(opts) {
  if (opts.vehicle === 'motorhome') {
    return { costing: 'truck', costing_options: { truck: { exclude_tolls: !opts.tolls, height: opts.height ?? 3, length: opts.length ?? 7, weight: opts.weight ?? 3.5 } } };
  }
  return { costing: 'auto', costing_options: { auto: { exclude_tolls: !opts.tolls, height: opts.height ?? 1.95 } } };
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
    ...costingOf(opts),
    units: 'kilometers',
    directions_type: 'none',
  }, opts.timeoutMs ?? 12000);
  if (!d.trip) throw new Error('Valhalla: no route');
  const pts = [].concat(...d.trip.legs.map((l) => decodePolyline(l.shape)));
  return {
    km: Math.round(d.trip.summary.length * 10) / 10,
    minutes: scaled(Math.round(d.trip.summary.time / 60), opts),
    legs: d.trip.legs.map((l) => ({ km: Math.round(l.summary.length * 10) / 10, minutes: scaled(Math.round(l.summary.time / 60), opts) })),
    points: thin(pts, opts.maxPoints ?? 1500),
  };
}

/** sources × targets drive minutes (null where no route). */
async function matrix(sources, targets, opts = {}) {
  const d = await post('/sources_to_targets', {
    sources: sources.map((p) => ({ lat: +p[0], lon: +p[1] })),
    targets: targets.map((p) => ({ lat: +p[0], lon: +p[1] })),
    ...costingOf(opts),
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
  const v = opts.vehicle === 'motorhome' ? `M${opts.height}x${opts.length}x${opts.weight}` : `A${opts.height ?? 1.95}`;
  return `route:${opts.tolls ? 'T' : 'N'}:${v}:${ra.join(',')}|${rb.join(',')}`;
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
    const fresh = [];
    const far = todo.filter((i) => distKm(pairs[i][0], pairs[i][1]) > MATRIX_MAX_KM);
    const near = todo.filter((i) => !far.includes(i));
    await pmap(far, 2, async (i) => {
      if (opts.deadline && opts.deadline.left() < 5000) { pending++; return; }
      try {
        const r = await route(pairs[i], { ...opts, factor: 1, maxPoints: 2, timeoutMs: opts.deadline ? Math.min(12000, opts.deadline.left() - 1500) : 12000 });
        const v = { minutes: r.minutes, km: r.km };
        values.set(i, v);
        fresh.push([keys[i], v]);
      } catch (e) {
        ctx.log?.warn?.('valhalla route failed', { error: String(e && e.message) });
        pending++;
      }
    });
    // Greedy chunks of pairs whose distinct sources x distinct targets stay <= MATRIX_CELLS.
    const ptKey = (p) => roundPt(p).join(',');
    const chunks = [];
    let cur = null;
    for (const i of near) {
      const [a, b] = pairs[i];
      const ns = cur && !cur.si.has(ptKey(a)) ? 1 : 0;
      const nt = cur && !cur.ti.has(ptKey(b)) ? 1 : 0;
      if (!cur || (cur.src.length + ns) * (cur.tgt.length + nt) > MATRIX_CELLS) {
        cur = { idx: [], src: [], tgt: [], si: new Map(), ti: new Map() };
        chunks.push(cur);
      }
      if (!cur.si.has(ptKey(a))) { cur.si.set(ptKey(a), cur.src.length); cur.src.push(a); }
      if (!cur.ti.has(ptKey(b))) { cur.ti.set(ptKey(b), cur.tgt.length); cur.tgt.push(b); }
      cur.idx.push(i);
    }
    for (let c = 0; c < chunks.length; c++) {
      const { idx: chunk, src, tgt, si, ti } = chunks[c];
      if (opts.deadline && opts.deadline.left() < 4000) { pending += chunks.slice(c).reduce((n, x) => n + x.idx.length, 0); break; }
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
        const v = m[si.get(ptKey(a))][ti.get(ptKey(b))];
        values.set(i, v);
        fresh.push([keys[i], v]);
      }
    }
    await cache.setMany(ctx, fresh);
  } else {
    pending = todo.length;
  }
  for (const [i, v] of values) if (v) values.set(i, { ...v, minutes: scaled(v.minutes, opts) });
  return { values, pending };
}

/**
 * Walking route through `points` ([lat,lng] list, in order) on footpaths (Valhalla
 * pedestrian costing): { km, minutes, points } with at most `maxPoints` vertices.
 */
async function walk(points, opts = {}) {
  const d = await post('/route', {
    locations: points.map((p) => ({ lat: +p[0], lon: +p[1], type: 'break' })),
    costing: 'pedestrian',
    units: 'kilometers',
    directions_type: 'none',
  }, opts.timeoutMs ?? 12000);
  if (!d.trip) throw new Error('Valhalla: no walking route');
  const pts = [].concat(...d.trip.legs.map((l) => decodePolyline(l.shape)));
  return { km: Math.round(d.trip.summary.length * 10) / 10, minutes: Math.round(d.trip.summary.time / 60), points: thin(pts, opts.maxPoints ?? 600) };
}

/** Ground heights (m) along `points` ([lat,lng] list), from Valhalla's elevation service. */
async function heights(points, opts = {}) {
  const d = await post('/height', { shape: points.map((p) => ({ lat: +p[0], lon: +p[1] })), range: false }, opts.timeoutMs ?? 8000);
  if (!Array.isArray(d.height) || d.height.length !== points.length) throw new Error('Valhalla: no heights');
  return d.height;
}

module.exports = { heights, walk, route, matrix, legs, legKey, decodePolyline, costingOf, vehicleOpts, VALHALLA };
