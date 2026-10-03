import { describe, it, expect, afterEach, vi } from 'vitest';
import { require, makeHost } from './helpers.mjs';

const plugin = require('../server/index.js');
const fillLib = require('../server/lib/amenity-fill.js');
const pi = require('../server/lib/place-info.js');
const p4nLib = require('../server/lib/park4night.js');
const { build } = require('./fixtures/trip.js');

// FICTIONAL sources. OSM: a campsite 50 m from "Camping Example" (place 13), one 2 km from
// everything. park4night: a place 30 m from "Aire Example Misurina" (16), and #888, far from
// "Farm Example" (18) but named by the farm's park4night link.
const OSM = [
  { type: 'node', id: 70, lat: 46.5304, lon: 12.1302, tags: { tourism: 'camp_site', dog: 'yes', drinking_water: 'yes', power_supply: 'schuko', shower: 'hot', toilets: 'yes', internet_access: 'wlan', sanitary_dump_station: 'no' } },
  { type: 'node', id: 71, lat: 46.55, lon: 12.17, tags: { tourism: 'camp_site', dog: 'no' } },
];
const P4N = [
  { id: 777, lat: 46.5802, lng: 12.2501, type: { code: 'ACC_P' }, services: ['point_eau', 'eau_noire', 'wc_public'] },
  { id: 888, lat: 46.7, lng: 11.8, type: { code: 'F' }, services: ['animaux', 'electricite', 'douche', 'laverie'], activities: ['jeux_enfants', 'vtt'] },
];

function sources({ overpassStatus = 200, p4nStatus = 200 } = {}) {
  const calls = { overpass: 0, p4n: 0 };
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('overpass')) {
      calls.overpass++;
      if (overpassStatus !== 200) return { ok: false, status: overpassStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ elements: OSM }) };
    }
    if (String(url).includes('park4night.com')) {
      calls.p4n++;
      if (p4nStatus !== 200) return { ok: false, status: p4nStatus, text: async () => '' };
      return { ok: true, status: 200, text: async () => Buffer.from(JSON.stringify(P4N)).toString('base64') };
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
  return calls;
}

function host({ park4night = true, queryResults } = {}) {
  const trip = build();
  trip.places.find((p) => p.id === 14).price = 0;
  trip.places.find((p) => p.id === 18).website = 'https://park4night.com/fr/place/888';
  trip.places.find((p) => p.id === 16).website = 'https://park4night.com/en/place/777';
  return makeHost({ trip, queryResults, config: { park4night_enabled: park4night } });
}

describe('amenities filled from open sources', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps OSM tags and park4night services, writing "no" only when OSM says so', () => {
    expect(fillLib.fromOsm({ dog: 'leashed', drinking_water: 'yes', power_supply: 'cee_blue', shower: 'hot', toilets: 'no', internet_access: 'wlan', sanitary_dump_station: 'yes' }))
      .toMatchObject({ dog: 'yes', water: 'yes', electricity: 'yes', shower: 'yes', toilets: 'no', dump_station: 'yes', wifi: 'yes', pool: null, bar: null });
    expect(fillLib.fromOsm({ power_supply: 'no', fee: 'yes' })).toMatchObject({ electricity: 'no', dog: null, water: null });
    expect(fillLib.fromP4n(['animaux', 'eau_usee', 'vtt'])).toEqual({ dog: 'yes', dump_station: 'yes' });
    expect(fillLib.p4nId({ website: 'https://park4night.com/fr/place/434199' })).toBe(434199);
    expect(fillLib.p4nId({ notes: 'see park4night.com/lieu/12 for photos' })).toBe(12);
    expect(fillLib.p4nId({ website: 'https://www.campingcortina.it' })).toBeNull();
  });

  it('maps the campsite tags OSM documents for the newer amenities', () => {
    expect(fillLib.fromOsm({ washing_machine: 'yes', swimming_pool: 'no', shop: 'convenience', restaurant: 'snack', bar: 'yes', playground: 'yes', bbq: 'no' }))
      .toMatchObject({ laundry: 'yes', pool: 'no', shop: 'yes', restaurant: 'yes', bar: 'yes', playground: 'yes', bbq: 'no' });
    expect(fillLib.fromOsm({ shop: 'no', restaurant: 'no', bar: 'no' })).toMatchObject({ shop: 'no', restaurant: 'no', bar: 'no' });
    // every key it returns is an amenity the record can hold
    expect(Object.keys(fillLib.fromOsm({})).every((k) => k in pi.AMENITIES)).toBe(true);
  });

  it('maps every park4night service code onto an amenity', () => {
    const codes = ['animaux', 'point_eau', 'electricite', 'wc_public', 'douche', 'eau_noire', 'eau_usee', 'wifi', 'poubelle', 'laverie', 'piscine', 'boulangerie', 'donnees_mobile', 'gaz', 'gpl', 'lavage', 'caravaneige'];
    expect(fillLib.fromP4n([...codes, 'jeux_enfants'])).toEqual({
      dog: 'yes', water: 'yes', electricity: 'yes', toilets: 'yes', shower: 'yes', dump_station: 'yes', wifi: 'yes', bins: 'yes', laundry: 'yes',
      pool: 'yes', bakery: 'yes', mobile_data: 'yes', gas: 'yes', lpg: 'yes', vehicle_wash: 'yes', winter: 'yes', playground: 'yes',
    });
    expect(Object.values(fillLib.P4N).every((k) => k in pi.AMENITIES)).toBe(true);
    // the search tool names every code the filler knows
    for (const c of codes) expect(Object.keys(p4nLib.SERVICES)).toContain(c);
  });

  it('fills the campsite from OSM, the area and the linked farm from park4night, and cites them', { timeout: 20000 }, async () => {
    const calls = sources();
    const h = host();
    const ctx = h.ctx;
    await pi.migrate(ctx); await fillLib.migrate(ctx);
    const r = await fillLib.fill(ctx, 1, { park4night: true });
    // + the lake: its notes say "Lake walk, 2 h.", a visit duration
    expect(r).toMatchObject({ filled: 4, visits: 1, remaining: 0, park4nightLimited: false, osmBusy: false });
    expect(calls.overpass).toBe(1); // one query for the whole batch
    expect(calls.p4n).toBe(2); // only the two linked places cost a park4night request

    const camping = await pi.get(ctx, 13);
    expect(camping.amenities).toMatchObject({ dog: 'yes', water: 'yes', electricity: 'yes', shower: 'yes', toilets: 'yes', wifi: 'yes', dump_station: 'no', rooftop_tent: 'unknown' });
    expect(camping.source).toMatch(/^OpenStreetMap https:\/\/www\.openstreetmap\.org\/node\/70 \(auto\)$/);
    expect(camping.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const aire = await pi.get(ctx, 16); // 20 m from #777, also its link
    expect(aire.amenities).toMatchObject({ water: 'yes', dump_station: 'yes', toilets: 'yes', dog: 'unknown', electricity: 'unknown' });
    expect(aire.source).toBe('park4night #777 (auto)');

    const farm = await pi.get(ctx, 18); // 9 km from #888, matched by its link
    expect(farm.amenities).toMatchObject({ dog: 'yes', electricity: 'yes', shower: 'yes', laundry: 'yes', playground: 'yes', water: 'unknown' });

    // Places with nothing near them get no record (no empty line in the planner).
    expect(await pi.get(ctx, 14)).toBeNull();
  });

  it('never overwrites a recorded value and fills only the unknown ones', async () => {
    sources();
    const h = host({ park4night: false });
    const ctx = h.ctx;
    await pi.migrate(ctx); await fillLib.migrate(ctx);
    await pi.set(ctx, 1, 13, { dog: 'no', source: 'Host e-mail', checked: '2026-10-01' });
    await fillLib.fill(ctx, 1, { park4night: false });
    const camping = await pi.get(ctx, 13);
    expect(camping.amenities.dog).toBe('no'); // the host's answer wins over OSM's "yes"
    expect(camping.amenities.water).toBe('yes');
    expect(camping).toMatchObject({ source: 'Host e-mail', checked: '2026-10-01' });
  });

  it('does not ask again about places it looked at lately, unless one is named', async () => {
    sources();
    const now = new Date().toISOString();
    const rows = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map((id) => ({ place_id: id, checked_at: now }));
    const h = host({ park4night: false, queryResults: { [fillLib.LOG_SQL]: rows } });
    const ctx = h.ctx;
    expect(await fillLib.fill(ctx, 1, { park4night: false })).toMatchObject({ looked: 0, filled: 0 });
    expect((await fillLib.fill(ctx, 1, { park4night: false, placeIds: [14] })).looked).toBe(1);
    const old = host({ park4night: false, queryResults: { [fillLib.LOG_SQL]: rows.map((r) => ({ ...r, checked_at: '2020-01-01T00:00:00Z' })) } });
    expect((await fillLib.fill(old.ctx, 1, { park4night: false })).looked).toBe(10);
  });

  it('says so when a source is busy, and leaves places park4night could not answer for to a later run', { timeout: 20000 }, async () => {
    sources({ overpassStatus: 429 });
    const h = host();
    const ctx = h.ctx;
    const r = await fillLib.fill(ctx, 1, { park4night: true });
    expect(r.osmBusy).toBe(true);
    expect(r.filled).toBe(3); // the aire and the farm, from park4night alone, + the lake's visit duration

    vi.unstubAllGlobals();
    sources({ p4nStatus: 429 });
    const h2 = host();
    const tx = vi.spyOn(h2.ctx.db, 'tx');
    const r2 = await fillLib.fill(h2.ctx, 1, { park4night: true });
    expect(r2).toMatchObject({ park4nightLimited: true, filled: 2 }); // the campsite, from OSM, and the lake's visit duration
    const logged = tx.mock.calls.flatMap((c) => c[0].map((op) => op.args && op.args[0]));
    expect(logged).toContain(13);
    expect(logged).not.toContain(16);
    expect(logged).not.toContain(18);
  });

  it('stops starting new places when its time is up, and counts them as remaining', async () => {
    sources();
    const h = host({ park4night: false });
    const r = await fillLib.fill(h.ctx, 1, { park4night: false, budgetMs: -1 });
    expect(r).toMatchObject({ looked: 0, filled: 0, remaining: 10 });
  });

  it('is reachable from the MCP tool and from the widget route, and a free stop shows no price', async () => {
    sources();
    const h = host({ park4night: false, queryResults: { 'SELECT place_id FROM place_info_index WHERE trip_id = ?': [{ place_id: 13 }] } });
    await pi.migrate(h.ctx); await fillLib.migrate(h.ctx);
    const r = await h.run(plugin).hook('mcpToolProvider', 'callTool', { name: 'vanlife_place', args: { tripId: 1, fill: true } });
    expect(r.filled).toBe(2); // the campsite, and the lake's visit duration
    const drv = h.run(plugin);
    const post = (path, body) => drv.route({ method: 'POST', path }, { body });
    const route = await post('/amenities/fill', { tripId: 1, placeId: 13 });
    expect(route.status).toBe(200);
    expect(JSON.parse(route.body)).toMatchObject({ looked: 1 });
    const bad = await post('/amenities/fill', {});
    expect(bad.status).toBe(400);
    const notHere = await post('/amenities/fill', { tripId: 1, placeId: 9999 });
    expect(notHere.status).toBe(404);
    const cols = await h.run(plugin).hook('tableContributor', 'getContributions', 'places', 1);
    expect(cols.find((c) => c.id === 'vanlife-am-water' && c.entityId === 13)).toMatchObject({ value: 'Water', icon: 'Droplet' });
    expect(cols.some((c) => c.id === 'vanlife-amenities')).toBe(false);
    // Passo Giau has price 0 and no record: a free stop, no "0.00/night" chip.
    expect(cols.some((c) => c.id === 'vanlife-price' && c.entityId === 14)).toBe(false);
  });
});
