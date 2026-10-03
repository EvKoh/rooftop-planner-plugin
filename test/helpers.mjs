// Test doubles: a mock TREK host built from the real manifest grants, and a fetch stub
// that answers Valhalla and Overpass deterministically (no network in tests).
// Plugin code is CommonJS: load it with Node's own require so tests and plugin share ONE
// instance of each module (the cache's in-process Map in particular).
import { vi } from 'vitest';
import { createRequire } from 'node:module';

export const require = createRequire(import.meta.url);
const { createMockHost } = require('trek-plugin-sdk/testing');
export const manifest = require('../trek-plugin.json');
const { build, CATS, P } = require('./fixtures/trip.js');
const { distKm } = require('../server/lib/util.js');
const cache = require('../server/lib/cache.js');
const overpass = require('../server/lib/overpass.js');

/** Drive minutes the stub "computes": 1.5 min/km, +15 min to or from the shop (off the road). */
export function stubMinutes(a, b) {
  const shop = (p) => Math.abs(p[0] - P.shop.lat) < 1e-6 && Math.abs(p[1] - P.shop.lng) < 1e-6;
  return Math.round(distKm(a, b) * 1.5) + (shop(a) || shop(b) ? 15 : 0);
}

export function encode(points) {
  let out = '';
  let plat = 0;
  let plng = 0;
  const enc = (v) => {
    let x = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (x >= 0x20) { s += String.fromCharCode((0x20 | (x & 0x1f)) + 63); x >>= 5; }
    return s + String.fromCharCode(x + 63);
  };
  for (const [lat, lng] of points) {
    const la = Math.round(lat * 1e6);
    const ln = Math.round(lng * 1e6);
    out += enc(la - plat) + enc(ln - plng);
    plat = la;
    plng = ln;
  }
  return out;
}

export const OSM_NIGHTS = [
  { type: 'node', id: 1, lat: 46.6, lon: 12.17, tags: { tourism: 'camp_site', name: 'Camping Lakeside Example', charge: '18 EUR', tents: 'yes', dog: 'yes', opening_hours: 'May-Oct: Mo-Su 08:00-22:00' } },
  { type: 'way', id: 2, center: { lat: 46.57, lon: 12.2 }, tags: { tourism: 'camp_site', name: 'Camping Pricey Example', charge: '45 EUR' } },
  { type: 'node', id: 3, lat: 46.56, lon: 12.22, tags: { tourism: 'caravan_site', name: 'Motorhome Area Example', charge: '10 EUR' } },
  { type: 'node', id: 4, lat: 46.62, lon: 12.1, tags: { tourism: 'camp_site', name: 'Camping No Tents Example', tents: 'no', charge: '12 EUR' } },
  { type: 'node', id: 5, lat: 46.66, lon: 11.75, tags: { tourism: 'guest_house', agriturismo: 'yes', name: 'Agriturismo Example', charge: '15' } },
  { type: 'node', id: 6, lat: 46.59, lon: 12.16, tags: { tourism: 'camp_site', name: 'Camping Closed Example', opening_hours: 'Jun-Sep: Mo-Su 08:00-20:00' } },
];
export const OSM_SHOPS = [
  { type: 'node', id: 11, lat: 46.6946, lon: 12.0853, tags: { shop: 'supermarket', name: 'Market On Route Example', opening_hours: 'Mo-Sa 08:00-12:00,15:00-19:00; Su off', dog: 'no' } },
  { type: 'node', id: 12, lat: 46.75, lon: 11.99, tags: { amenity: 'fuel', brand: 'FuelCo', opening_hours: '24/7' } },
  { type: 'node', id: 13, lat: 46.62, lon: 12.3, tags: { shop: 'convenience', name: 'Far Shop Example' } },
  { type: 'node', id: 14, lat: 46.7, lon: 12.0, tags: { amenity: 'drinking_water' } },
];

/** A fetch stub; `calls` records every request. Options make it fail on purpose. */
export function stubFetch({ failValhalla = false, failOverpass = false } = {}) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body });
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (String(url).includes('valhalla')) {
      if (failValhalla) return { ok: false, status: 503, json: async () => ({ error: 'down' }) };
      const b = JSON.parse(init.body);
      if (String(url).endsWith('/sources_to_targets')) {
        return ok({
          sources_to_targets: b.sources.map((s) => b.targets.map((t) => {
            const m = stubMinutes([s.lat, s.lon], [t.lat, t.lon]);
            return { time: m * 60, distance: Math.round(distKm([s.lat, s.lon], [t.lat, t.lon]) * 1.3 * 10) / 10 };
          })),
        });
      }
      const locs = b.locations.map((l) => [l.lat, l.lon]);
      const legs = locs.slice(1).map((p, i) => ({
        shape: encode([locs[i], [(locs[i][0] + p[0]) / 2, (locs[i][1] + p[1]) / 2], p]),
        summary: { length: distKm(locs[i], p) * 1.3, time: stubMinutes(locs[i], p) * 60 },
      }));
      return ok({ trip: { legs, summary: { length: legs.reduce((s, l) => s + l.summary.length, 0), time: legs.reduce((s, l) => s + l.summary.time, 0) } } });
    }
    if (String(url).includes('overpass')) {
      if (failOverpass) return { ok: false, status: 429, json: async () => ({}) };
      const q = decodeURIComponent(String(init.body));
      return ok({ elements: /camp_site/.test(q) ? OSM_NIGHTS : OSM_SHOPS });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  fn.calls = calls;
  return fn;
}

/** Mock host seeded with the fixture trip and the manifest's exact grants. */
export function makeHost({ fixed = false, grants = manifest.permissions, userSettings = { language: 'en', timezone: 'Europe/Rome' }, trip, queryResults } = {}) {
  cache.clearMemory();
  overpass.resetBusy();
  return createMockHost({
    grants,
    actingUserId: 42,
    userSettings,
    categories: CATS,
    queryResults,
    trips: { 1: trip || build({ fixed }) },
  });
}

