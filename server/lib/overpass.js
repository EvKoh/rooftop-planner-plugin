'use strict';
// OpenStreetMap search through the public Overpass API. Answers are cached in db:own for a
// week (keyed by the query text): campsites and shops do not move.
//
// The public server allows 2 query slots per client IP, and a slot stays taken for a while
// after each query (seen 2026-10-03: "Rate limit: 2", next slot "in 60 seconds"); a refused
// request is held ~8 s before the 429 arrives. Every TREK user shares the server's IP, so:
// one query at a time from this process, a short client timeout, and after a refusal the
// plugin stops asking for a minute and says so (OverpassBusy) instead of burning the
// tool's 15 s.
const cache = require('./cache');

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const UA = 'vanlife (TREK plugin; +https://github.com/EvkohLand/TrekPluginVanlife)';
const COOL_DOWN_MS = 60000;

class OverpassBusy extends Error {
  constructor(msg) { super(msg); this.name = 'OverpassBusy'; }
}

let queue = Promise.resolve();
let busyUntil = 0;

function hashKey(s) {
  // FNV-1a, 32 bit: a short stable cache key for a long query text.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

async function fetchOnce(ql, timeoutMs) {
  if (Date.now() < busyUntil) {
    throw new OverpassBusy(`OpenStreetMap search is busy (public Overpass server rate limit): try again in ${Math.ceil((busyUntil - Date.now()) / 1000)} s`);
  }
  let r;
  try {
    r = await fetch(OVERPASS, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
      body: `data=${encodeURIComponent(ql)}`,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    busyUntil = Date.now() + COOL_DOWN_MS / 2;
    throw new OverpassBusy(`OpenStreetMap search did not answer in ${Math.round(timeoutMs / 1000)} s: try again in a minute`);
  }
  if (r.status === 429 || r.status === 504) {
    busyUntil = Date.now() + COOL_DOWN_MS;
    throw new OverpassBusy(`OpenStreetMap search is busy (Overpass ${r.status}): try again in a minute`);
  }
  if (!r.ok) throw new Error(`Overpass ${r.status}`);
  return r.json();
}

/**
 * Run an Overpass QL body (without the [out:json] header) and return its elements, each
 * normalised to { id, type, lat, lng, tags }. Cached per query; null when not cached and
 * `network` is false. Throws OverpassBusy when the public server refuses or is slow.
 */
async function query(ctx, body, opts = {}) {
  const timeoutMs = Math.max(3000, Math.min(9000, opts.timeoutMs ?? 9000));
  const ql = `[out:json][timeout:${Math.floor(timeoutMs / 1000)}];${body}`;
  const key = `osm:${hashKey(body)}:${body.length}`;
  const hit = (await cache.getMany(ctx, [key])).get(key);
  if (hit) return hit;
  if (opts.network === false) return null;
  // One query at a time from this process (the queue survives a failed query).
  const run = queue.then(() => fetchOnce(ql, timeoutMs));
  queue = run.catch(() => {});
  const d = await run;
  const els = (d.elements || [])
    .map((e) => ({
      id: `${e.type}/${e.id}`,
      type: e.type,
      lat: e.lat ?? e.center?.lat,
      lng: e.lon ?? e.center?.lon,
      tags: e.tags || {},
    }))
    .filter((e) => e.lat != null && e.lng != null);
  await cache.setMany(ctx, [[key, els]]);
  return els;
}

const osmUrl = (id) => `https://www.openstreetmap.org/${id}`;
const resetBusy = () => { busyUntil = 0; };

module.exports = { query, osmUrl, OVERPASS, OverpassBusy, resetBusy };
