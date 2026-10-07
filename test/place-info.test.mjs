import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { require, makeHost, stubFetch, manifest } from './helpers.mjs';

const plugin = require('../server/index.js');
const pi = require('../server/lib/place-info.js');
const { loadTrip } = require('../server/lib/trip.js');
const { checkTrip } = require('../server/lib/check.js');
const { readSettings } = require('../server/lib/settings.js');
const { deadline } = require('../server/lib/util.js');
const { build } = require('./fixtures/trip.js');
const contrib = require('../server/lib/contributions.js');
const { MESSAGES, CODES } = require('../server/lib/i18n.js');

const INDEX_SQL = 'SELECT place_id FROM place_info_index WHERE trip_id = ?';
const call = (h, name, args) => h.run(plugin).hook('mcpToolProvider', 'callTool', { name, args });
const has = (r, level, key, day) => r.findings.some((f) => f.level === level && f.key === key && (day == null || f.dayNumber === day));
const tent = { vehicle: 'rooftop_tent', dog: true, travellers: 2, vehicle_height_m: 1.95, vehicle_length_m: 4.8, vehicle_weight_t: 2 };

describe('place record (what TREK has no field for)', () => {
  it('starts unknown, merges and validates every field, never stores a price', () => {
    const b = pi.blank();
    expect(Object.values(b.amenities).every((v) => v === 'unknown')).toBe(true);
    const r = pi.merge(null, { per: 'person', water: 'yes', dog_fee: '3,5', max_height_m: 2.2, max_length_m: 8, max_weight_t: 3.5, source: 'Official site', checked: '2026-10-01' });
    expect(r).toMatchObject({ per: 'person', dog_fee: 3.5, max_height_m: 2.2, max_length_m: 8, max_weight_t: 3.5, source: 'Official site', checked: '2026-10-01' });
    expect(r.amenities.dog).toBe('fee'); // a dog fee implies dogs are accepted for a fee
    expect(r.price).toBeUndefined();
    expect(pi.merge({ ...r, price: { amount: 9 } }, {}).price).toBeUndefined(); // an older record's own price is dropped
    expect(pi.merge(r, { dog_fee: null, source: '', checked: '' })).toMatchObject({ dog_fee: null, source: null, checked: null });
    for (const bad of [{ per: 'week' }, { water: 'maybe' }, { dog: 'sometimes' }, { max_height_m: 9 }, { max_length_m: 1 }, { max_weight_t: 100 }, { dog_fee: -1 }, { checked: '01/10/2026' }]) {
      expect(() => pi.merge(null, bad)).toThrow(pi.InfoError);
    }
  });

  it('splits the native price from the rest', () => {
    expect(pi.nativePrice({ water: 'yes' })).toBeNull();
    expect(pi.nativePrice({ price_amount: '44,6', currency: 'EUR' })).toEqual({ price: 44.6, currency: 'EUR' });
    expect(pi.nativePrice({ price_amount: null })).toEqual({ price: null });
    expect(() => pi.nativePrice({ currency: 'eur' })).toThrow(/3-letter/);
    expect(() => pi.nativePrice({ price_amount: -2 })).toThrow(/price_amount/);
  });

  it('totals a night for the party and formats localized, emoji-free text', () => {
    const r = pi.merge(null, { per: 'person', dog: 'fee', dog_fee: 2.5, water: 'yes', shower: 'yes', electricity: 'no', max_height_m: 2.1 });
    expect(pi.nightTotal(12, r, { travellers: 2, dog: true })).toBe(26.5);
    expect(pi.nightTotal(12, r, { travellers: 3, dog: false })).toBe(36);
    expect(pi.nightTotal(12, null, { travellers: 3 })).toBe(12);
    expect(pi.nightTotal(null, r, {})).toBeNull();
    expect(pi.priceText(44.6, 'EUR', null, 'fr', { night: true }).replace(/ | /g, ' ')).toBe('44,60 €/nuit');
    expect(pi.priceText(12, 'EUR', r, 'en')).toBe('€12.00/person + dog €2.50');
    expect(pi.priceText(null, 'EUR', r, 'en')).toBeNull();
    const am = pi.amenitiesText(r, 'en');
    expect(am).toBe('✓ dog (fee) · water · shower  ✗ power  ↕ 2.1 m');
    expect(pi.amenitiesText(r, 'fr')).toBe('✓ chien (suppl.) · eau · douche  ✗ élec.  ↕ 2,1 m');
    expect(pi.amenitiesText(pi.merge(null, { max_length_m: 7.5, max_weight_t: 3.5 }), 'en')).toBe('↔ 7.5 m  3.5 t max');
    expect(pi.amenitiesText(pi.blank(), 'en')).toBeNull();
    expect(pi.amenitiesText(null, 'en')).toBeNull();
    // the host strips emoji from planner columns: nothing here may be one
    expect(/\p{Emoji_Presentation}/u.test(am)).toBe(false);
  });

  it('knows when a place refuses the vehicle or the dog', () => {
    expect(pi.refuses(null, tent)).toBe(false);
    expect(pi.refuses(pi.merge(null, { rooftop_tent: 'no' }), tent)).toBe(true);
    expect(pi.refuses(pi.merge(null, { rooftop_tent: 'no' }), { ...tent, vehicle: 'campervan' })).toBe(false); // a van deploys nothing
    expect(pi.refuses(pi.merge(null, { dog: 'no' }), tent)).toBe(true);
    expect(pi.refuses(pi.merge(null, { dog: 'no' }), { ...tent, dog: false })).toBe(false);
    expect(pi.refuses(pi.merge(null, { max_height_m: 1.9 }), tent)).toBe(true);
    expect(pi.refuses(pi.merge(null, { max_length_m: 4 }), tent)).toBe(true);
    expect(pi.refuses(pi.merge(null, { max_weight_t: 1.5 }), tent)).toBe(true);
    expect(pi.refuses(pi.merge(null, { water: 'no' }), tent)).toBe(false);
  });
});

describe('place info through the plugin', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('records with the MCP tool (price on TREK\'s place), lists, reads one and clears', async () => {
    const trip = build();
    const h = makeHost({ trip });
    const saved = await call(h, 'vanlife_place', { tripId: 1, placeId: 13, set: { price_amount: 18, water: 'yes', rooftop_tent: 'yes', source: 'Camping Example website' } });
    expect(saved).toMatchObject({ saved: true, placeId: 13, price: '€18.00/night', nightTotal: 18 });
    expect(trip.places.find((p) => p.id === 13).price).toBe(18);
    expect(h.calls.map((c) => c.method)).toEqual(expect.arrayContaining(['places.update', 'meta.set', 'db.exec']));
    const one = await call(h, 'vanlife_place', { tripId: 1, placeId: 13 });
    expect(one.record.amenities.water).toBe('yes');
    const empty = await call(h, 'vanlife_place', { tripId: 1, placeId: 16 });
    expect(empty.record.amenities.water).toBe('unknown');
    // the list reads the index (the mock db does not run SQL: seed its answer)
    const h2 = makeHost({ queryResults: { [INDEX_SQL]: [{ place_id: 13 }] } });
    await h2.ctx.meta.set('place', 13, pi.META_KEY, pi.merge(null, { water: 'yes' }));
    const list = await call(h2, 'vanlife_place', { tripId: 1 });
    // the default list: planned nights first, each with what is still missing
    expect(list.filter).toBe('nights');
    expect(list.places.slice(0, 3).map((p) => p.placeId)).toEqual([13, 16, 18]);
    expect(list.places[0]).toMatchObject({ price: '€38.00/night', plannedNights: [1], amenities: '✓ water' }); // TREK's price
    expect(list.places[0].missing).toEqual(['contact', 'toilets', 'shower', 'dog', 'rooftop_tent']);
    const noAmenity = await call(h2, 'vanlife_place', { tripId: 1, filter: 'missing_amenities' });
    expect(noAmenity.places.every((p) => p.missing.some((m) => m !== 'contact'))).toBe(true);
    const all = await call(h2, 'vanlife_place', { tripId: 1, filter: 'all' });
    expect(all.count).toBe(10); // every place but the three route places
    expect(await call(h2, 'vanlife_place', { tripId: 1, placeId: 13, clear_fields: ['all'] })).toEqual({ placeId: 13, cleared: true });
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 999, set: {} })).rejects.toThrow(/not in trip/);
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 13, set: { water: 'maybe' } })).rejects.toThrow(/water must be/);
  });

  it('feeds the check and the budget: recorded details count, notes are overridden', async () => {
    const h = makeHost({ queryResults: { [INDEX_SQL]: [{ place_id: 13 }, { place_id: 16 }, { place_id: 18 }, { place_id: 77 }] } });
    // Camping Example: TREK's 38 € plus a 3 € dog fee; the aire and the farm refuse things
    await h.ctx.meta.set('place', 13, pi.META_KEY, pi.merge(null, { dog_fee: 3 }));
    await h.ctx.meta.set('place', 16, pi.META_KEY, pi.merge(null, { water: 'yes', rooftop_tent: 'no', max_height_m: 1.9 }));
    await h.ctx.meta.set('place', 18, pi.META_KEY, pi.merge(null, { dog: 'no', max_length_m: 4, max_weight_t: 1.5 }));
    const settings = await readSettings(h.ctx);
    const model = await loadTrip(h.ctx, 1, settings);
    expect(model.nights[0].price).toBe(41); // 38 € + dog 3 €
    const r = await checkTrip(h.ctx, model, { settings, network: false, deadline: deadline(5000) });
    expect(r.findings.find((f) => f.key === 'price_high' && f.dayNumber === 1).message).toContain('€41.00');
    expect(r.findings.find((f) => f.key === 'tent_refused' && f.dayNumber === 2).message).toMatch(/refuses rooftop tents \(recorded on the place\)/);
    expect(has(r, 'blocking', 'too_low', 2)).toBe(true);
    expect(has(r, 'blocking', 'dog_refused', 3)).toBe(true);
    expect(has(r, 'blocking', 'too_long', 3)).toBe(true);
    expect(has(r, 'blocking', 'too_heavy', 3)).toBe(true);
    expect(has(r, 'fix', 'water_fix', 3)).toBe(false); // the aire has water after all
    const b = await call(h, 'vanlife_plan_trip', { tripId: 1, continuation: 'budget.0' });
    expect(b.results.budget.nightsTotal).toBe(41 + 15 + 20);
  });

  it('per person: TREK\'s price times the travellers', async () => {
    const h = makeHost({ queryResults: { [INDEX_SQL]: [{ place_id: 13 }] }, userSettings: { travellers: 3 } });
    await h.ctx.meta.set('place', 13, pi.META_KEY, pi.merge(null, { per: 'person' }));
    const settings = await readSettings(h.ctx);
    expect((await loadTrip(h.ctx, 1, settings)).nights[0].price).toBe(114);
  });

  it('shows price and amenities columns, in the user language, and no button', async () => {
    const h = makeHost({ queryResults: { [INDEX_SQL]: [{ place_id: 13 }, { place_id: 16 }] } });
    await h.ctx.meta.set('place', 13, pi.META_KEY, pi.merge(null, { water: 'yes', dog: 'yes' }));
    await h.ctx.meta.set('place', 16, pi.META_KEY, pi.merge(null, { rooftop_tent: 'no' }));
    const drv = h.run(plugin);
    const c = await drv.hook('tableContributor', 'getContributions', 'places', 1);
    expect(c.every((x) => x.kind === 'column')).toBe(true);
    expect(c.find((x) => x.entityId === 13 && x.id === 'vanlife-price')).toMatchObject({ label: 'Price', value: '€38.00/night', icon: 'Euro' });
    // one chip per amenity the place has, dog first, then water; the old grouped line is gone
    expect(c.filter((x) => x.entityId === 13 && x.id.startsWith('vanlife-am-')).map((x) => [x.id, x.value, x.icon]))
      .toEqual([['vanlife-am-dog', 'Dog', 'Dog'], ['vanlife-am-water', 'Water', 'Droplet']]);
    expect(c.some((x) => x.id === 'vanlife-amenities')).toBe(false);
    expect(c.find((x) => x.entityId === 16 && x.id === 'vanlife-am-no')).toMatchObject({ value: '✗ roof tent', tone: 'danger', icon: 'Ban' });
    expect(c.find((x) => x.entityId === 16 && x.id === 'vanlife-price').value).toBe('€15.00/night');
    expect(c.some((x) => x.entityId === 20)).toBe(false); // route places get nothing
    expect(c.some((x) => x.entityId === 10)).toBe(false); // no price, no record: nothing
    expect(c.every((x) => !x.value || x.value.length <= 256)).toBe(true);
    expect(await drv.hook('tableContributor', 'getContributions', 'reservations', 1)).toEqual([]);
    const fr = makeHost({ userSettings: { language: 'fr' }, queryResults: { [INDEX_SQL]: [{ place_id: 13 }] } });
    const cf = await fr.run(plugin).hook('tableContributor', 'getContributions', 'places', 1);
    expect(cf.find((x) => x.id === 'vanlife-price' && x.entityId === 13)).toMatchObject({ label: 'Prix' });
    expect(cf.find((x) => x.id === 'vanlife-price' && x.entityId === 13).value.replace(/ | /g, ' ')).toBe('38,00 €/nuit');
  });

  it('gives each amenity its own chip, in a fixed order, and lists what is missing only when it refuses', async () => {
    const order = Object.keys(pi.AMENITIES);
    expect(order.slice(0, 7)).toEqual(['dog', 'water', 'electricity', 'toilets', 'shower', 'dump_station', 'wifi']);
    expect(order[order.length - 1]).toBe('rooftop_tent');
    const all = pi.merge(null, Object.fromEntries(order.map((k) => [k, 'yes'])));
    const h = makeHost({ userSettings: { language: 'fr' }, queryResults: { [INDEX_SQL]: [{ place_id: 13 }, { place_id: 18 }] } });
    await h.ctx.meta.set('place', 13, pi.META_KEY, all);
    await h.ctx.meta.set('place', 18, pi.META_KEY, pi.merge(null, { dog: 'fee', wifi: 'yes', bar: 'yes', pool: 'no' }));
    const c = await h.run(plugin).hook('tableContributor', 'getContributions', 'places', 1);
    const chips = (id) => c.filter((x) => x.entityId === id && x.id.startsWith('vanlife-am-'));
    expect(chips(13).map((x) => x.id)).toEqual(order.map((k) => `vanlife-am-${k}`));
    expect(chips(13).every((x) => x.icon && x.label && x.value && x.tone === 'default')).toBe(true);
    expect(new Set(chips(13).map((x) => x.icon)).size).toBe(order.length); // one icon per amenity
    expect(chips(18).map((x) => x.value)).toEqual(['Chien (suppl.)', 'Wifi', 'Bar']);
    // a pool marked "no" refuses nothing: no "missing" chip
    expect(c.some((x) => x.entityId === 18 && x.id === 'vanlife-am-no')).toBe(false);
    const dogNo = pi.merge(null, { dog: 'no', pool: 'no', max_height_m: 2.1 });
    expect(contrib.missingText(dogNo, 'fr')).toBe('✗ chien · piscine  ↕ 2,1 m');
    expect(contrib.missingText(pi.merge(null, { max_length_m: 7.5, max_weight_t: 3.5 }), 'en')).toBe('↔ 7.5 m  3.5 t max');
    expect(contrib.missingText(pi.blank(), 'en')).toBeNull();
  });

  it('has a translated short and long name for every amenity in every language', () => {
    for (const code of CODES) {
      for (const k of Object.keys(pi.AMENITIES)) {
        expect(MESSAGES[code][`am.${k}`], `${code} am.${k}`).toBeTruthy();
        expect(MESSAGES[code][`amLong.${k}`], `${code} amLong.${k}`).toBeTruthy();
      }
      for (const k of ['fee', 'col.price', 'col.amenities']) expect(MESSAGES[code][k], `${code} ${k}`).toBeTruthy();
    }
    // a language other than English really is translated, not copied
    expect(MESSAGES.de['am.water']).not.toBe(MESSAGES.en['am.water']);
  });

  it('prunes index rows whose place is gone or whose value was cleared', async () => {
    const h = makeHost({ queryResults: { [INDEX_SQL]: [{ place_id: 13 }, { place_id: 404 }, { place_id: 16 }] } });
    await h.ctx.meta.set('place', 13, pi.META_KEY, pi.merge(null, { water: 'yes' }));
    const all = await pi.getAll(h.ctx, 1, [13, 16]);
    expect([...all.keys()]).toEqual([13]);
    expect(h.calls.some((c) => c.method === 'db.tx')).toBe(true);
    await pi.migrate(h.ctx);
    const broken = { db: { query: async () => { throw new Error('x'); }, exec: async () => { throw new Error('x'); }, tx: async () => { throw new Error('x'); } }, meta: { get: async () => null, set: async () => ({}), delete: async () => ({}) }, places: { update: async () => ({}) } };
    expect((await pi.getAll(broken, 1, [1])).size).toBe(0);
    await pi.set(broken, 1, 1, { water: 'yes', price_amount: 5 });
    await pi.clear(broken, 1, 1);
  });

  it('cannot write without db:meta', async () => {
    const h = makeHost({ grants: manifest.permissions.filter((g) => g !== 'db:meta') });
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 13, set: { water: 'yes' } })).rejects.toThrow(/db:meta|PERMISSION/);
  });
});

describe('place records read from the plugin\'s copy', () => {
  it('reads a whole trip in one query, backfills older records and drops deleted places', async () => {
    const rec = pi.merge(null, { water: 'yes', dog: 'yes', source: 'Example' });
    const h = makeHost({ queryResults: {
      [pi.COPY_SQL]: [{ place_id: 13, rec: JSON.stringify(rec) }, { place_id: 77, rec: JSON.stringify(rec) }, { place_id: 18, rec: '{broken' }],
      [pi.INDEX_SQL]: [{ place_id: 13 }, { place_id: 16 }, { place_id: 77 }],
    } });
    await h.ctx.meta.set('place', 16, pi.META_KEY, pi.merge(null, { shower: 'yes' }));
    const exec = vi.spyOn(h.ctx.db, 'exec');
    const tx = vi.spyOn(h.ctx.db, 'tx');
    const meta = vi.spyOn(h.ctx.meta, 'get');
    const all = await pi.getAll(h.ctx, 1, [13, 16, 18]);
    expect(all.get(13).amenities).toMatchObject({ water: 'yes', dog: 'yes' });
    expect(all.get(16).amenities.shower).toBe('yes'); // older record, read from the place
    expect(all.has(77)).toBe(false); // place no longer on the trip
    expect(meta.mock.calls.map((c) => c[1])).toEqual([16]); // 13 came from the copy
    expect(exec.mock.calls.some((c) => /INSERT OR REPLACE INTO place_info_copy/.test(c[0]) && c[1] === 16)).toBe(true);
    expect(tx.mock.calls[0][0].map((op) => op.args.at(-1))).toEqual([77, 77]);
  });
});

