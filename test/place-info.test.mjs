import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { require, makeHost, stubFetch, manifest } from './helpers.mjs';

const plugin = require('../server/index.js');
const pi = require('../server/lib/place-info.js');
const { loadTrip } = require('../server/lib/trip.js');
const { checkTrip } = require('../server/lib/check.js');
const { readSettings } = require('../server/lib/settings.js');
const { deadline } = require('../server/lib/util.js');

const INDEX_SQL = 'SELECT place_id FROM place_info_index WHERE trip_id = ?';
const call = (h, name, args) => h.run(plugin).hook('mcpToolProvider', 'callTool', { name, args });
const has = (r, level, key, day) => r.findings.some((f) => f.level === level && f.key === key && (day == null || f.dayNumber === day));

describe('place info record', () => {
  it('starts unknown, merges and validates every field', () => {
    const b = pi.blank();
    expect(Object.values(b.amenities).every((v) => v === 'unknown')).toBe(true);
    const r = pi.merge(null, { price_amount: '12,5', per: 'person', currency: 'CHF', water: 'yes', dog_fee: 3, max_height_m: 2.2, source: 'Official site', checked: '2026-10-01' });
    expect(r.price).toEqual({ amount: 12.5, currency: 'CHF', per: 'person' });
    expect(r.amenities.dog).toBe('fee'); // a dog fee implies dogs are accepted for a fee
    expect(r.amenities.water).toBe('yes');
    expect(pi.merge(r, { price_amount: null, source: '', checked: '' })).toMatchObject({ price: { amount: null }, source: null, checked: null });
    for (const bad of [{ price_amount: -1 }, { currency: 'eur' }, { per: 'week' }, { water: 'maybe' }, { dog: 'sometimes' }, { max_height_m: 9 }, { checked: '01/10/2026' }]) {
      expect(() => pi.merge(null, bad)).toThrow(pi.InfoError);
    }
  });

  it('computes the night total for the party and formats compact, emoji-free text', () => {
    const r = pi.merge(null, { price_amount: 12, per: 'person', dog: 'fee', dog_fee: 2.5, water: 'yes', shower: 'yes', electricity: 'no', max_height_m: 2.1 });
    expect(pi.nightTotal(r, { travellers: 2, dog: true })).toBe(26.5);
    expect(pi.nightTotal(r, { travellers: 3, dog: false })).toBe(36);
    expect(pi.nightTotal(null, {})).toBeNull();
    expect(pi.nightTotal(pi.blank(), {})).toBeNull();
    expect(pi.priceText(r, 'en')).toBe('12 €/person + dog 2.50 €');
    expect(pi.priceText(pi.merge(null, { price_amount: 20.5, currency: 'CHF' }), 'fr')).toBe('20.50 CHF/nuit');
    expect(pi.priceText(pi.blank(), 'en')).toBeNull();
    const am = pi.amenitiesText(r, 'en');
    expect(am).toBe('✓ dog (fee) · water · shower  ✗ power  ↕ 2.1 m');
    expect(pi.amenitiesText(r, 'fr')).toContain('✓ chien (suppl.) · eau · douche');
    expect(pi.amenitiesText(pi.blank(), 'en')).toBeNull();
    expect(pi.amenitiesText(null, 'en')).toBeNull();
    // the host strips emoji from planner columns: nothing here may be one
    expect(/\p{Emoji_Presentation}/u.test(am)).toBe(false);
  });
});

describe('place info through the plugin', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('records with the MCP tool, lists, reads one and clears', async () => {
    const h = makeHost();
    const saved = await call(h, 'rooftop_tools_place_info', { tripId: 1, placeId: 13, set: { price_amount: 18, water: 'yes', rooftop_tent: 'yes', source: 'Camping Example website' } });
    expect(saved).toMatchObject({ saved: true, placeId: 13, price: '18 €/night', nightTotal: 18 });
    expect(h.calls.map((c) => c.method)).toEqual(expect.arrayContaining(['meta.set', 'db.exec']));
    const one = await call(h, 'rooftop_tools_place_info', { tripId: 1, placeId: 13 });
    expect(one.record.price.amount).toBe(18);
    const empty = await call(h, 'rooftop_tools_place_info', { tripId: 1, placeId: 16 });
    expect(empty.record.amenities.water).toBe('unknown');
    // the list reads the index (the mock db does not run SQL: seed its answer)
    const h2 = makeHost({ queryResults: { [INDEX_SQL]: [{ place_id: 13 }] } });
    await h2.ctx.meta.set('place', 13, pi.META_KEY, pi.merge(null, { price_amount: 18 }));
    const list = await call(h2, 'rooftop_tools_place_info', { tripId: 1 });
    expect(list.places.map((p) => p.placeId)).toEqual([13]);
    expect(list.toFill[0]).toMatchObject({ plannedNight: true });
    expect(list.toFill.some((p) => p.placeId === 13)).toBe(false);
    const cleared = await call(h2, 'rooftop_tools_place_info', { tripId: 1, placeId: 13, clear: true });
    expect(cleared).toEqual({ placeId: 13, cleared: true });
    await expect(call(h, 'rooftop_tools_place_info', { tripId: 1, placeId: 999, set: {} })).rejects.toThrow(/not in trip/);
    await expect(call(h, 'rooftop_tools_place_info', { tripId: 1, placeId: 13, set: { water: 'maybe' } })).rejects.toThrow(/water must be/);
  });

  it('feeds the check and the budget: entered values win over notes and TREK prices', async () => {
    const h = makeHost({ queryResults: { [INDEX_SQL]: [{ place_id: 13 }, { place_id: 16 }, { place_id: 18 }, { place_id: 77 }] } });
    // Camping Example: 12 €/person (2 travellers) + dog 3 €, refuses... nothing; Aire: water yes
    await h.ctx.meta.set('place', 13, pi.META_KEY, pi.merge(null, { price_amount: 12, per: 'person', dog_fee: 3 }));
    await h.ctx.meta.set('place', 16, pi.META_KEY, pi.merge(null, { water: 'yes', rooftop_tent: 'no', max_height_m: 1.9 }));
    await h.ctx.meta.set('place', 18, pi.META_KEY, pi.merge(null, { dog: 'no' }));
    const settings = await readSettings(h.ctx);
    const model = await loadTrip(h.ctx, 1, settings);
    expect(model.nights[0].price).toBe(27); // 12 x 2 + 3, instead of the 38 € in TREK
    const r = await checkTrip(h.ctx, model, { settings, network: false, deadline: deadline(5000) });
    expect(has(r, 'verify', 'price_high', 1)).toBe(false);
    expect(has(r, 'info', 'price_target', 1)).toBe(true); // 27 > 25 target
    expect(r.findings.find((f) => f.key === 'tent_banned' && f.dayNumber === 2).message).toContain('rooftop_tent = no');
    expect(has(r, 'blocking', 'too_low', 2)).toBe(true);
    expect(has(r, 'blocking', 'dog_refused', 3)).toBe(true);
    expect(has(r, 'fix', 'water_fix', 3)).toBe(false); // the aire has water after all
    const b = await call(h, 'rooftop_tools_trip_budget', { tripId: 1 });
    expect(b.nightsTotal).toBe(27 + 15 + 20);
  });

  it('shows price and amenities columns and an editor button on places', async () => {
    const h = makeHost({ queryResults: { [INDEX_SQL]: [{ place_id: 13 }, { place_id: 16 }] } });
    await h.ctx.meta.set('place', 13, pi.META_KEY, pi.merge(null, { price_amount: 22, water: 'yes', dog: 'yes' }));
    await h.ctx.meta.set('place', 16, pi.META_KEY, pi.merge(null, { rooftop_tent: 'no' }));
    const drv = h.run(plugin);
    const c = await drv.hook('tableContributor', 'getContributions', 'places', 1);
    const cols = c.filter((x) => x.kind === 'column');
    expect(cols.find((x) => x.entityId === 13 && x.id === 'rooftop-price').value).toBe('22 €/night');
    expect(cols.find((x) => x.entityId === 13 && x.id === 'rooftop-amenities').value).toBe('✓ dog · water');
    expect(cols.find((x) => x.entityId === 16 && x.id === 'rooftop-amenities')).toMatchObject({ value: '✗ roof tent', tone: 'danger' });
    expect(cols.some((x) => x.entityId === 16 && x.id === 'rooftop-price')).toBe(false);
    const acts = c.filter((x) => x.kind === 'action');
    expect(acts.some((x) => x.entityId === 20)).toBe(false); // route places get nothing
    expect(acts.find((x) => x.entityId === 10)).toMatchObject({ label: 'Price & amenities', target: { kind: 'frame', sub: '/?place=10' } });
    expect(c.every((x) => !x.value || x.value.length <= 256)).toBe(true);
    expect(await drv.hook('tableContributor', 'getContributions', 'reservations', 1)).toEqual([]);
    const fr = makeHost({ userSettings: { language: 'fr' }, queryResults: { [INDEX_SQL]: [{ place_id: 13 }] } });
    await fr.ctx.meta.set('place', 13, pi.META_KEY, pi.merge(null, { price_amount: 22 }));
    const cf = await fr.run(plugin).hook('tableContributor', 'getContributions', 'places', 1);
    expect(cf.find((x) => x.id === 'rooftop-price')).toMatchObject({ label: 'Prix', value: '22 €/nuit' });
  });

  it('editor routes: list places, save, clear, refuse bad input', async () => {
    const h = makeHost({ queryResults: { [INDEX_SQL]: [{ place_id: 13 }] } });
    const drv = h.run(plugin);
    const post = (path, body) => drv.route({ method: 'POST', path }, { body });
    const list = JSON.parse((await post('/places', { tripId: 1 })).body);
    expect(list.places[0].plannedNight).toBe(true);
    expect(list.places.some((p) => p.name === 'Route day 1')).toBe(false);
    expect(Object.keys(list.amenities)).toContain('rooftop_tent');
    const ok = await post('/place-info', { tripId: 1, placeId: 13, set: { price_amount: 21, per: 'night', water: 'no' } });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).info.price.amount).toBe(21);
    expect((await post('/place-info', { tripId: 1, placeId: 13, set: { per: 'week' } })).status).toBe(400);
    expect((await post('/place-info', { tripId: 1, placeId: 999, set: {} })).status).toBe(404);
    expect((await post('/place-info', { tripId: 1 })).status).toBe(400);
    expect(JSON.parse((await post('/place-info', { tripId: 1, placeId: 13, clear: true })).body)).toEqual({ cleared: true });
    expect((await post('/places', {})).status).toBe(400);
    expect((await post('/places', { tripId: 9 })).status).toBe(404);
    const noMeta = makeHost({ grants: manifest.permissions.filter((g) => g !== 'db:meta') }).run(plugin);
    expect((await noMeta.route({ method: 'POST', path: '/place-info' }, { body: { tripId: 1, placeId: 13, set: {} } })).status).toBe(403);
  });

  it('prunes index rows whose place is gone or whose value was cleared', async () => {
    const h = makeHost({ queryResults: { [INDEX_SQL]: [{ place_id: 13 }, { place_id: 404 }, { place_id: 16 }] } });
    await h.ctx.meta.set('place', 13, pi.META_KEY, pi.merge(null, { price_amount: 1 }));
    const all = await pi.getAll(h.ctx, 1, [13, 16]);
    expect([...all.keys()]).toEqual([13]);
    expect(h.calls.some((c) => c.method === 'db.tx')).toBe(true);
    await pi.migrate(h.ctx);
    const broken = { db: { query: async () => { throw new Error('x'); }, exec: async () => { throw new Error('x'); }, tx: async () => { throw new Error('x'); } }, meta: { get: async () => null, set: async () => ({}), delete: async () => ({}) } };
    expect((await pi.getAll(broken, 1, [1])).size).toBe(0);
    await pi.set(broken, 1, 1, { water: 'yes' });
    await pi.clear(broken, 1, 1);
  });
});
