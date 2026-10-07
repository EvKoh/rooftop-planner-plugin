// Price units and free price notes, platform pages kept out of the host's website, and the
// planned / candidate scopes of the night lists. FICTIONAL data only (public repository).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { require, makeHost, stubFetch } from './helpers.mjs';

const plugin = require('../server/index.js');
const pi = require('../server/lib/place-info.js');
const c = require('../server/lib/contacts.js');
const fillLib = require('../server/lib/amenity-fill.js');
const { loadTrip } = require('../server/lib/trip.js');
const { readSettings } = require('../server/lib/settings.js');
const { MESSAGES, CODES } = require('../server/lib/i18n.js');
const { TOOL_SPECS } = require('../server/lib/tool-specs.js');
const { build } = require('./fixtures/trip.js');

const call = (h, name, args) => h.run(plugin).hook('mcpToolProvider', 'callTool', { name, args });
const nb = (s) => s.replace(/ | /g, ' ');

describe('price unit and free note on the record', () => {
  it('accepts every unit, null when not said, and refuses anything else', () => {
    for (const u of ['night', 'person', 'person_night', 'day', 'hour', 'entry', 'vehicle', 'flat']) expect(pi.merge(null, { per: u }).per).toBe(u);
    expect(pi.PER).toHaveLength(8);
    expect(pi.blank().per).toBeNull();
    expect(pi.merge(pi.merge(null, { per: 'hour' }), { per: null }).per).toBeNull();
    expect(pi.merge(pi.merge(null, { per: 'hour' }), { per: '' }).per).toBeNull();
    expect(() => pi.merge(null, { per: 'week' })).toThrow(/per must be one of night, person, person_night/);
  });

  it('keeps a short free note, trimmed, and refuses one over 120 characters', () => {
    expect(pi.merge(null, { price_note: '  don   libre ' }).price_note).toBe('don libre');
    expect(pi.merge(pi.merge(null, { price_note: 'x' }), { price_note: '' }).price_note).toBeNull();
    expect(pi.merge(pi.merge(null, { price_note: 'x' }), { price_note: null }).price_note).toBeNull();
    expect(pi.merge(null, { price_note: 'a'.repeat(120) }).price_note).toHaveLength(120);
    expect(() => pi.merge(null, { price_note: 'a'.repeat(121) })).toThrow(/price_note is too long/);
    expect(pi.clearPatch(['per', 'price_note'])).toEqual({ per: null, price_note: null });
  });

  it('reads the old default "night" as not said, and keeps a unit someone chose', () => {
    const old = { per: 'night', amenities: { water: 'yes' } }; // written before 0.4.2
    expect(pi.merge(old, {}).per).toBeNull();
    expect(pi.merge({ ...old, per: 'person' }, {}).per).toBe('person');
    expect(pi.merge({ ...old, price_note: null }, {}).per).toBe('night'); // written by 0.4.2: kept
    // a night place still reads per night, so nothing changes for the nights
    expect(pi.priceText(19, 'EUR', pi.merge(old, {}), 'en', { night: true })).toBe('€19.00/night');
  });

  it('writes the amount with its translated unit', () => {
    const at = (per, price, L = 'en', night = false) => nb(pi.priceText(price, 'EUR', pi.merge(null, { per }), L, { night }));
    expect(at('night', 19, 'fr')).toBe('19,00 €/nuit');
    expect(at('hour', 5, 'fr')).toBe('5,00 €/h');
    expect(at('day', 12, 'fr')).toBe('12,00 €/jour');
    expect(at('entry', 8, 'fr')).toBe('8,00 €/entrée');
    expect(at('person', 3, 'fr')).toBe('3,00 €/pers.');
    expect(at('person_night', 3, 'fr')).toBe('3,00 €/pers./nuit');
    expect(at('vehicle', 4)).toBe('€4.00/vehicle');
    expect(at('flat', 8, 'en', true)).toBe('€8.00'); // a lump sum has no unit, even on a night
  });

  it('with no unit: per night on a night place, the amount alone anywhere else', () => {
    expect(pi.priceText(8, 'EUR', null, 'en')).toBe('€8.00');
    expect(pi.priceText(8, 'EUR', pi.blank(), 'en')).toBe('€8.00');
    expect(pi.priceText(8, 'EUR', null, 'en', { night: true })).toBe('€8.00/night');
    expect(pi.priceText(null, 'EUR', null, 'en', { night: true })).toBeNull();
  });

  it('shows the free note, after the amount unless the note already states it', () => {
    const note = (price, text, per) => pi.priceText(price, 'EUR', pi.merge(null, { price_note: text, per }), 'en', { night: true });
    expect(note(5, 'free the first 2 hours, then 5 €/h', 'hour')).toBe('free the first 2 hours, then 5 €/h');
    expect(note(3, 'donation')).toBe('€3.00 · donation');
    expect(note(3.5, '3,50 €/person + 2 € dog')).toBe('3,50 €/person + 2 € dog');
    expect(note(null, 'donation')).toBe('donation');
    expect(note(0, 'free')).toBe('€0.00 · free');
    const dog = pi.merge(null, { price_note: 'donation', dog: 'fee', dog_fee: 2 });
    expect(pi.priceText(null, 'EUR', dog, 'en')).toBe('donation + dog €2.00');
    expect(pi.noteHasAmount('then 5,50 €', 5.5)).toBe(true);
    expect(pi.noteHasAmount('no figure', 5)).toBe(false);
  });

  it('makes a night price only from night units: per person ones times the travellers', () => {
    const s = { travellers: 3, dog: false };
    const total = (per) => pi.nightTotal(10, pi.merge(null, { per }), s);
    expect(total('person')).toBe(30);
    expect(total('person_night')).toBe(30);
    expect(total('night')).toBe(10);
    expect(total(null)).toBe(10);
    expect(total('flat')).toBe(10);
    expect(total('vehicle')).toBe(10);
    expect(total('day')).toBe(10);
    expect(total('hour')).toBeNull();
    expect(total('entry')).toBeNull();
  });
});

describe('price units through the plugin', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('planner chips: a museum or a lake has no "/night", a night keeps it', async () => {
    const trip = build();
    trip.places.find((p) => p.id === 11).price = 12; // museum, ticket
    trip.places.find((p) => p.id === 10).price = 5; // lake, car park, no record
    const h = makeHost({ trip, queryResults: { [pi.INDEX_SQL]: [{ place_id: 11 }, { place_id: 16 }] } });
    await h.ctx.meta.set('place', 11, pi.META_KEY, pi.merge(null, { per: 'entry' }));
    await h.ctx.meta.set('place', 16, pi.META_KEY, pi.merge(null, { price_note: 'free the first night' }));
    const cols = await h.run(plugin).hook('tableContributor', 'getContributions', 'places', 1);
    const price = (id) => (cols.find((x) => x.entityId === id && x.id === 'vanlife-price') || {}).value;
    expect(price(11)).toBe('€12.00/entry');
    expect(price(10)).toBe('€5.00');
    expect(price(13)).toBe('€38.00/night'); // a planned night, no record
    expect(price(19)).toBe('€30.00/night'); // a night category, not planned
    expect(price(16)).toBe('€15.00 · free the first night');
  });

  it('sets the unit and the note with vanlife_place; only a night gets a night total', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const trip = build();
    trip.places.find((p) => p.id === 11).price = 12;
    const h = makeHost({ trip, userSettings: { language: 'en', travellers: 3 } });
    const museum = await call(h, 'vanlife_place', { tripId: 1, placeId: 11, set: { per: 'hour', price_note: 'free the first 2 hours' } });
    expect(museum).toMatchObject({ saved: true, price: '€12.00 · free the first 2 hours', nightTotal: null });
    expect(museum.record).toMatchObject({ per: 'hour', price_note: 'free the first 2 hours' });
    const camp = await call(h, 'vanlife_place', { tripId: 1, placeId: 13, set: { per: 'person_night' } });
    expect(camp).toMatchObject({ price: '€38.00/person/night', nightTotal: 114 });
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 13, set: { price_note: 'x'.repeat(121) } })).rejects.toThrow(/price_note/);
    const spec = TOOL_SPECS.find((t) => t.name === 'vanlife_place').inputSchema.properties;
    expect(spec.set.properties.per.enum).toEqual(pi.PER);
    expect(spec.set.properties.price_note.maxLength).toBe(120);
  });

  it('the budget and the check count a night only in night units', async () => {
    const h = makeHost({ queryResults: { [pi.INDEX_SQL]: [{ place_id: 13 }, { place_id: 16 }] }, userSettings: { travellers: 2 } });
    await h.ctx.meta.set('place', 13, pi.META_KEY, pi.merge(null, { per: 'person_night' }));
    await h.ctx.meta.set('place', 16, pi.META_KEY, pi.merge(null, { per: 'hour' }));
    const model = await loadTrip(h.ctx, 1, await readSettings(h.ctx));
    expect(model.nights.map((n) => n.price)).toEqual([76, null, 20]);
  });

  it('the widget gets the price text, the units, and whether the place is a night', async () => {
    const trip = build();
    trip.places.find((p) => p.id === 11).price = 12;
    trip.places.find((p) => p.id === 16).website = 'https://park4night.com/en/place/777';
    const h = makeHost({ trip });
    const drv = h.run(plugin);
    const post = async (body) => JSON.parse((await drv.route({ method: 'POST', path: '/amenities' }, { body })).body);
    const museum = await post({ tripId: 1, placeId: 11 });
    expect(museum).toMatchObject({ night: false, priceText: '€12.00', units: pi.PER });
    expect(museum.strings).toMatchObject({ 'ui.per.entry': 'entry (visit)', 'ui.priceNote': 'Price details', 'per.hour': '/h' });
    const camp = await post({ tripId: 1, placeId: 13 });
    expect(camp).toMatchObject({ night: true, priceText: '€38.00/night' });
    const aire = await post({ tripId: 1, placeId: 16 });
    expect(aire.reach.website).toBeNull(); // a park4night page is not the host's site
    const saved = await drv.route({ method: 'POST', path: '/amenities/save' }, { body: { tripId: 1, placeId: 11, set: { per: 'entry', price_note: null } } });
    expect(JSON.parse(saved.body).info.per).toBe('entry');
    expect((await post({ tripId: 1, placeId: 11 })).priceText).toBe('€12.00/entry');
  });

  it('has the units and their labels in all 27 languages, translated', () => {
    const keys = ['per.night', 'per.person', 'per.person_night', 'per.day', 'per.hour', 'per.entry', 'per.vehicle', 'ui.per', 'ui.perNone', 'ui.priceNote', 'ui.priceNoteHint', ...pi.PER.map((u) => `ui.per.${u}`)];
    expect(CODES).toHaveLength(27);
    for (const code of CODES) for (const k of keys) expect(MESSAGES[code][k], `${code} ${k}`).toBeTruthy();
    for (const code of CODES.filter((x) => x !== 'en')) expect(MESSAGES[code]['ui.priceNote'], code).not.toBe(MESSAGES.en['ui.priceNote']);
  });
});

describe('platform pages are never the host\'s website', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('recognises the platforms, and only Google\'s maps', () => {
    for (const u of [
      'https://park4night.com/en/place/1', 'https://www.google.com/maps/place/x', 'https://www.google.it/maps?q=1', 'https://maps.google.com/?q=1',
      'https://goo.gl/maps/abc', 'https://maps.app.goo.gl/abc', 'https://www.booking.com/hotel/x', 'https://www.airbnb.fr/rooms/1',
      'https://www.tripadvisor.co.uk/x', 'https://www.campercontact.com/x', 'https://www.pitchup.com/x', 'https://www.nomady.fr/x',
      'https://campspace.com/x', 'https://www.alpacacamping.de/x', 'https://www.pincamp.de/x', 'https://www.eurocampings.co.uk/x',
      'https://www.facebook.com/campexample', 'https://m.facebook.com/x', 'https://www.instagram.com/x', 'www.booking.com/x', 'park4night.com/lieu/1',
    ]) expect(c.notOwnSite(u), u).toBe(true);
    for (const u of ['https://camp.example.com', 'https://sites.google.com/view/farm-example', 'https://www.google.com/search?q=x', 'https://bookingexample.com', null, '']) expect(c.notOwnSite(u), String(u)).toBe(false);
    expect(c.notOwnSite('http://[bad')).toBe(false); // unparsable and no platform in it
    expect(c.notOwnSite('http://[bad park4night.com')).toBe(true);
  });

  it('skips them in notes, OSM tags and TREK\'s own field', () => {
    const x = c.extract('See https://www.facebook.com/campexample and https://maps.app.goo.gl/abc or https://camp.example.com.');
    expect(x.urls).toEqual(['https://camp.example.com']);
    expect(c.fromOsmTags({ website: 'https://www.facebook.com/x', 'contact:website': 'https://farm.example.com' }).website).toBe('https://farm.example.com');
    expect(c.fromOsmTags({ website: 'https://www.booking.com/x' }).website).toBeNull();
    expect(fillLib.ownContacts({ website: 'https://www.google.com/maps/place/x', phone: '+39 000 000 0001' }, 'en')[0].values.website).toBeNull();
    // nor copied into TREK's empty field
    expect(pi.nativeContacts({}, pi.merge(null, { contacts: { website: 'https://www.airbnb.com/rooms/1' } }))).toBeNull();
  });

  it('drops one an automatic source wrote, finds the real site, and keeps one a person typed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ elements: [{ type: 'node', id: 70, lat: 46.5304, lon: 12.1302, tags: { tourism: 'camp_site', website: 'https://camp.example.com' } }] }) })));
    const h = makeHost();
    // as an older fill left it: a park4night page recorded as the website, with its source
    await h.ctx.meta.set('place', 13, pi.META_KEY, { ...pi.merge(null, {}), contacts: { ...c.blankContacts(), website: 'https://park4night.com/en/place/1' }, contact_sources: { website: 'park4night #1' } });
    const before = await pi.get(h.ctx, 13);
    expect(before.contacts.website).toBeNull(); // ignored on read
    expect(before.contact_sources.website).toBeUndefined();
    await fillLib.fill(h.ctx, 1, { park4night: false, language: 'en', placeIds: [13] });
    const after = await pi.get(h.ctx, 13);
    expect(after.contacts.website).toBe('https://camp.example.com');
    expect(after.contact_sources.website).toMatch(/^OpenStreetMap/);
    // typed by a person (no source): kept as is
    await pi.set(h.ctx, 1, 16, { contacts: { website: 'https://www.facebook.com/aireexample' } });
    expect((await pi.get(h.ctx, 16)).contacts.website).toBe('https://www.facebook.com/aireexample');
  });

  it('never takes a platform page a source gives as the website during a fill', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ elements: [{ type: 'node', id: 71, lat: 46.5304, lon: 12.1302, tags: { tourism: 'camp_site', url: 'https://www.instagram.com/x' } }] }) })));
    const trip = build();
    trip.places.find((p) => p.id === 13).website = 'https://www.booking.com/hotel/camp-example';
    const h = makeHost({ trip });
    await fillLib.fill(h.ctx, 1, { park4night: false, language: 'en', placeIds: [13] });
    expect(((await pi.get(h.ctx, 13)) || pi.blank()).contacts.website).toBeNull();
  });
});

describe('night lists: planned nights by default', () => {
  it('lists the planned nights, the candidates or both, and counts all three', async () => {
    const h = makeHost();
    const planned = await call(h, 'vanlife_place', { tripId: 1, filter: 'missing_amenities' });
    expect(planned).toMatchObject({ scope: 'planned', nights: { planned: 3, candidates: 1, all_nights: 4 } });
    expect(planned.places.map((p) => p.placeId)).toEqual([13, 16, 18]);
    // an unknown scope (the host checks the schema, a direct call may not) falls back to planned
    expect((await call(h, 'vanlife_place', { tripId: 1, scope: 'bogus' })).scope).toBe('planned');
    const cand = await call(h, 'vanlife_place', { tripId: 1, scope: 'candidates' });
    expect(cand.places.map((p) => p.placeId)).toEqual([19]);
    const both = await call(h, 'vanlife_place', { tripId: 1, filter: 'nights', scope: 'all_nights' });
    expect(both.count).toBe(4);
    const all = await call(h, 'vanlife_place', { tripId: 1, filter: 'all' });
    expect(all.scope).toBeNull();
    expect(all.count).toBe(10);
    const spec = TOOL_SPECS.find((t) => t.name === 'vanlife_place').inputSchema.properties.scope;
    expect(spec).toMatchObject({ enum: ['planned', 'candidates', 'all_nights'], default: 'planned' });
  });
});
