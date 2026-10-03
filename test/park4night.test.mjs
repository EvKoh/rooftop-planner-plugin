import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { require, makeHost, stubFetch } from './helpers.mjs';

const plugin = require('../server/index.js');
const s = require('../server/lib/park4night.js');

// A FICTIONAL answer in park4night's shape (invented names, no real data), base64 like the real one.
const LIST = [
  { id: 1, url: '/en/place/1', type: { code: 'C', label: 'Camping' }, title_short: 'Camping Example', description: 'Pitch 22 € per night.', lat: 46.53, lng: 12.13, services: ['animaux', 'douche', 'point_eau'], review: 40, rating: 4.6, distance: 1.23 },
  { id: 2, url: '/en/place/2', type: { code: 'F', label: 'Farm' }, name: 'Farm Example', description: 'Donation.', lat: 46.55, lng: 12.1, services: ['point_eau'], review: 8, rating: 4.9, distance: 3.4 },
  { id: 3, url: '/en/place/3', type: { code: 'ACC_P', label: 'Paying motorhome area' }, title_short: 'Area Example', description: '10 €', lat: 46.5, lng: 12.1, services: [], review: 2, rating: 3, distance: 0.5 },
  { id: 4, url: '/en/place/4', type: { code: 'EP', label: 'Homestay' }, title: 'Garden Example', description: '€ 45 with breakfast', lat: 46.6, lng: 12.2, services: ['animaux'], review: 3, rating: 3.5, distance: 6 },
  { id: 5, url: null, type: { code: 'PJ', label: 'Daily parking only' }, title_short: 'Car park Example', description: '', lat: 46.52, lng: 12.12, services: [], review: 0, rating: 0, distance: 0.2 },
  { id: 6, url: '/en/place/6', type: { code: 'PN', label: 'Nature' }, title_short: 'Meadow Example', description: '', lat: 46.51, lng: 12.11, services: [], review: 5, rating: 4.2, distance: 2.2 },
];
const b64 = Buffer.from(JSON.stringify(LIST)).toString('base64');
const ok = (text) => ({ ok: true, status: 200, text: async () => text });
const q = (a) => ({ lat: 46.53, lng: 12.13, radius_km: 15, limit: 15, lang: 'en', ...a });

describe('park4night (unofficial API, nothing stored)', () => {
  beforeEach(() => s.resetRate());
  afterEach(() => vi.unstubAllGlobals());

  it('a rooftop tent gets campsites, farms and private pitches only, best rated first, with links', async () => {
    const f = vi.fn(async () => ok(b64));
    vi.stubGlobal('fetch', f);
    const r = await s.search(q({ vehicle: 'rooftop_tent' }));
    expect(r.places.map((p) => p.name)).toEqual(['Farm Example', 'Camping Example', 'Garden Example']);
    expect(r.skippedOtherTypes).toBe(3);
    expect(r.places[1]).toMatchObject({ kind: 'campsite', source: 'park4night', priceHint: 22, rating: 4.6, reviews: 40, page: 'https://park4night.com/en/place/1', services: ['dogs', 'shower', 'water'] });
    expect(r.source).toMatch(/UNOFFICIAL/);
    expect(f.mock.calls[0][0]).toBe('https://park4night.com/api/places/around?lat=46.53000&lng=12.13000&radius=15&filter=%7B%7D&lang=en');
  });

  it('a van or a motorhome also gets motorhome areas and nature spots, never day-only car parks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(b64)));
    const r = await s.search(q({ vehicle: 'campervan' }));
    expect(r.places.map((p) => p.kind).sort()).toEqual(['aire', 'campsite', 'farm', 'parking', 'private']);
    expect(r.places.some((p) => p.name === 'Car park Example')).toBe(false); // PJ: daily parking only
    // asking for a kind the vehicle may not use is ignored
    s.resetRate();
    const t = await s.search(q({ vehicle: 'rooftop_tent', types: ['aire', 'campsite'] }));
    expect(t.places.map((p) => p.kind)).toEqual(['campsite']);
  });

  it('applies the filters and reads plain JSON too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(JSON.stringify(LIST))));
    const r = await s.search(q({ types: ['campsite', 'private'], dog: true, max_price: 30, min_rating: 4, limit: 1, lang: 'fr', radius_km: 5 }));
    expect(r.places.map((p) => p.name)).toEqual(['Camping Example']);
    expect(fetch.mock.calls[0][0]).toContain('radius=5');
    expect(fetch.mock.calls[0][0]).toContain('lang=fr');
  });

  it('fails readably when the unofficial endpoint changes or refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok('%%%not base64 json')));
    await expect(s.search(q())).rejects.toThrow(/may have changed/);
    s.resetRate();
    vi.stubGlobal('fetch', vi.fn(async () => ok(Buffer.from('{"a":1}').toString('base64'))));
    await expect(s.search(q())).rejects.toThrow(/not a list/);
    s.resetRate();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, text: async () => '' })));
    await expect(s.search(q())).rejects.toThrow(s.RateLimited);
    s.resetRate();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => '' })));
    await expect(s.search(q())).rejects.toThrow(/park4night 500/);
  });

  it('limits its own rate: 20 requests per hour, 3 s apart', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(b64)));
    let t = 1e9;
    const now = () => t;
    for (let i = 0; i < s.MAX_PER_HOUR; i++) { await s.search(q(), { now }); t += 3000; }
    await expect(s.search(q(), { now })).rejects.toThrow(/20 per hour/);
    s.resetRate();
    const t0 = Date.now();
    await s.search(q());
    await s.search(q());
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
  });

  it('reads quoted prices', () => {
    expect(s.priceHint('Pitch 22 € per night')).toBe(22);
    expect(s.priceHint('€ 12,50')).toBe(12.5);
    expect(s.priceHint('15 euros')).toBe(15);
    expect(s.priceHint('free')).toBeNull();
    expect(s.priceHint(null)).toBeNull();
  });
});

describe('find_nights with park4night as a source', () => {
  afterEach(() => vi.unstubAllGlobals());
  const call = (h, args) => h.run(plugin).hook('mcpToolProvider', 'callTool', { name: 'vanlife_find_nights', args });

  it('merges park4night with OSM when the instance enables it, without duplicates', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const h = makeHost({ config: { park4night_enabled: true }, userSettings: { vehicle: 'campervan', language: 'en' } });
    const r = await call(h, { tripId: 1, dayNumber: 1 });
    expect(r.sources).toEqual(['osm', 'park4night']);
    const p4n = r.candidates.filter((c) => c.source === 'park4night');
    expect(p4n.length).toBeGreaterThan(0);
    expect(p4n.every((c) => c.page && c.page.startsWith('https://park4night.com/'))).toBe(true);
    expect(r.candidates.some((c) => c.name === 'Day Car Park Example')).toBe(false);
    const spot = r.candidates.find((c) => c.name === 'Forest Spot Example');
    expect(spot.legalRisk).toBeTruthy(); // a van on a nature spot: the local rule decides
    expect(spot.toVerify).toContain('overnight parking allowed there (local rule, signs)');
    expect(r.source).toMatch(/park4night \(unofficial API/);
  });

  it('never asks park4night when the instance disables it, even if the assistant does', async () => {
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    const r = await call(makeHost(), { tripId: 1, dayNumber: 1, sources: ['osm', 'park4night'] });
    expect(r.sources).toEqual(['osm']);
    expect(f.calls.some((c) => c.url.includes('park4night'))).toBe(false);
  });

  it('osm only on request; a park4night failure is reported, not thrown', async () => {
    vi.stubGlobal('fetch', stubFetch({ failPark4night: true }));
    const h = makeHost({ config: { park4night_enabled: true } });
    const r = await call(h, { tripId: 1, dayNumber: 1, sources: ['park4night'] });
    expect(r.sources).toEqual(['park4night']);
    expect(r.park4nightError).toMatch(/park4night 500/);
    expect(r.osmError).toBeNull();
  });
});
