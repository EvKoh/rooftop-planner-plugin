// Contacts, exchanges, night status and host messages. Every contact here is FICTIONAL:
// example.com addresses and +39 000... numbers only (the repository is public).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { require, makeHost, stubFetch, manifest } from './helpers.mjs';

const plugin = require('../server/index.js');
const c = require('../server/lib/contacts.js');
const pi = require('../server/lib/place-info.js');
const ns = require('../server/lib/night-status.js');
const hm = require('../server/lib/host-message.js');
const fillLib = require('../server/lib/amenity-fill.js');
const { loadTrip } = require('../server/lib/trip.js');
const { checkTrip } = require('../server/lib/check.js');
const { readSettings } = require('../server/lib/settings.js');
const { deadline } = require('../server/lib/util.js');
const { MESSAGES, CODES } = require('../server/lib/i18n.js');
const { TOOL_NAMES } = require('../server/lib/tool-specs.js');
const { build } = require('./fixtures/trip.js');

const call = (h, name, args) => h.run(plugin).hook('mcpToolProvider', 'callTool', { name, args });
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

describe('contact fields', () => {
  it('validates and normalises each field, with readable errors', () => {
    expect(c.field('email', ' Info@Example.com ')).toBe('info@example.com');
    expect(c.field('email', 'mailto:host@farm.example.com')).toBe('host@farm.example.com');
    for (const bad of ['host@', 'host.example.com', 'a b@example.com', 'host@example']) expect(() => c.field('email', bad)).toThrow(/not a valid e-mail/);
    expect(c.field('phone', '+39 0471 000 000')).toBe('+390471000000');
    expect(c.field('phone', '0039 0471 000000')).toBe('+390471000000');
    expect(c.field('phone', '0471  000 000')).toBe('0471 000 000'); // no country code: kept as typed
    expect(c.field('whatsapp', 'tel:+39 000 000 0001')).toBe('+390000000001');
    for (const bad of ['12345', 'call me', '+39 0471 000 000 000 000 0', '0471-ABC']) expect(() => c.field('phone', bad)).toThrow(/not a phone number/);
    expect(() => c.field('whatsapp', 'x')).toThrow(/^whatsapp/);
    expect(c.field('website', 'www.example.com')).toBe('https://www.example.com');
    expect(c.field('website', 'http://camp.example.com/en')).toBe('http://camp.example.com/en');
    for (const bad of ['ftp://example.com', 'javascript:alert(1)', 'not a site', 'https://localhost']) expect(() => c.field('website', bad)).toThrow(/http:\/\/ or https:\/\//);
    expect(c.field('languages', 'it, de; en')).toEqual(['it', 'de', 'en']);
    expect(c.field('languages', ['fr'])).toEqual(['fr']);
    expect(() => c.field('languages', Array(9).fill('x'))).toThrow(/at most 8/);
    expect(c.field('preferred_channel', 'whatsapp')).toBe('whatsapp');
    expect(() => c.field('preferred_channel', 'pigeon')).toThrow(/email, phone, whatsapp, website_form/);
    expect(c.field('notes', '  answers  in the evening ')).toBe('answers in the evening');
    expect(() => c.field('notes', 'x'.repeat(301))).toThrow(/too long/);
    expect(() => c.field('contact_name', 'x'.repeat(101))).toThrow(/100/);
    expect(() => c.field('fax', '1')).toThrow(/unknown contact field "fax"/);
    expect(c.field('email', null)).toBeNull();
    expect(c.field('languages', '')).toEqual([]);
    expect(() => c.patchContacts(null, 'x')).toThrow(/object/);
  });

  it('finds e-mails, phones and the host\'s own site in a free text, never an aggregator page', () => {
    const x = c.extract('Mail HOST@farm.example.com or tel. 0471 000 000, WhatsApp +39 000 000 0002. Site: https://farm.example.com/en. See https://park4night.com/en/place/1 and www.booking.com/x; Ticket 12 €, 2026-10-12.');
    expect(x.emails).toEqual(['host@farm.example.com']);
    expect(x.phones).toEqual(['+390000000002', '0471 000 000']);
    expect(x.urls).toEqual(['https://farm.example.com/en']);
    expect(c.extract('Check-in 8h–21h. Opening hours — Tuesday: 9h00–12h00. 2 nights minimum.')).toEqual({ emails: [], phones: [], urls: [] });
    expect(c.extract(null)).toEqual({ emails: [], phones: [], urls: [] });
  });

  it('reads the OSM contact tags, and orders the channels with the preferred one first', () => {
    expect(c.fromOsmTags({ 'contact:email': 'camp@example.com', phone: '+39 000 111 2222;+39 000 111 3333', 'contact:website': 'https://camp.example.com' }))
      .toEqual({ email: 'camp@example.com', phone: '+390001112222', website: 'https://camp.example.com' });
    expect(c.fromOsmTags({ email: 'broken', website: 'ftp://x.example.com' })).toEqual({ email: null, phone: null, website: null });
    expect(c.fromOsmTags()).toEqual({ email: null, phone: null, website: null });
    const all = { email: 'a@example.com', phone: '+390000000001', whatsapp: '+390000000002', website: 'https://example.com' };
    expect(c.channels(all).map((x) => x.channel)).toEqual(['email', 'whatsapp', 'phone', 'website_form']);
    expect(c.channels({ ...all, preferred_channel: 'phone' })[0]).toEqual({ channel: 'phone', address: '+390000000001' });
    expect(c.channels(null)).toEqual([]);
    // An own website is a way in (a contact form), as the host message uses it; a platform page is not.
    expect(c.hasContact({ website: 'https://example.com' })).toBe(true);
    expect(c.hasContact({ website: 'https://park4night.com/fr/place/1' })).toBe(false);
    expect(c.hasContact({ whatsapp: '+390000000002' })).toBe(true);
  });

  it('keeps a log of exchanges, newest first, 50 at most, each entry validated', () => {
    let log = [];
    for (let i = 1; i <= 55; i++) log = c.addLog(log, c.logEntry({ date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`, channel: 'email', direction: 'sent', summary: `msg ${i}` }));
    expect(log).toHaveLength(50);
    expect(log[0].date).toBe('2026-09-28');
    expect(log.every((e, i) => i === 0 || log[i - 1].date >= e.date)).toBe(true);
    const same = c.addLog([{ date: '2026-10-01', channel: 'email', direction: 'sent', summary: 'first' }], c.logEntry({ date: '2026-10-01', channel: 'phone', direction: 'received', summary: 'then' }));
    expect(same.map((e) => e.summary)).toEqual(['then', 'first']); // same day: the one added last on top
    for (const [bad, msg] of [[null, /object/], [{ date: '01/10/2026' }, /YYYY-MM-DD/], [{ date: '2026-10-01', channel: 'fax' }, /channel/],
      [{ date: '2026-10-01', channel: 'email', direction: 'out' }, /sent" or "received/], [{ date: '2026-10-01', channel: 'email', direction: 'sent', summary: ' ' }, /summary is required/]]) {
      expect(() => c.logEntry(bad)).toThrow(msg);
    }
  });
});

describe('contacts on the place record', () => {
  it('merges contacts, erases with null, drops the automatic source of a field a person sets', () => {
    let r = pi.merge(null, { contacts: { email: 'host@example.com', phone: '+39 000 000 0001' }, contact_sources: { email: 'notes du lieu', phone: 'OpenStreetMap', fax: 'x' } });
    expect(r.contacts).toMatchObject({ email: 'host@example.com', phone: '+390000000001', website: null, languages: [] });
    expect(r.contact_sources).toEqual({ email: 'notes du lieu', phone: 'OpenStreetMap' });
    // a form sending the same values back keeps the sources
    expect(pi.merge(r, { contacts: { email: 'host@example.com', phone: '+390000000001', website: null } }).contact_sources).toEqual({ email: 'notes du lieu', phone: 'OpenStreetMap' });
    r = pi.merge(r, { contacts: { phone: '+39 000 000 0009', email: null } });
    expect(r.contacts.email).toBeNull();
    expect(r.contact_sources).toEqual({}); // phone set by a person, email erased
    r = pi.merge(r, { log: { date: '2026-10-01', channel: 'email', direction: 'sent', summary: 'Asked about the rooftop tent' } });
    expect(r.log).toHaveLength(1);
    expect(pi.merge(r, { log: null }).log).toEqual([]);
    expect(() => pi.merge(r, { contacts: { email: 'nope' } })).toThrow(pi.InfoError);
    expect(() => pi.merge(r, { log: { date: 'x' } })).toThrow(pi.InfoError);
    // an older record without contacts reads as empty contacts
    expect(pi.merge({ amenities: {} }, {}).contacts).toEqual(c.blankContacts());
  });

  it('turns a list of fields into the patch that clears them', () => {
    expect(pi.clearPatch(['water', 'dog_fee', 'per', 'source', 'contacts.email', 'phone', 'log'])).toEqual({
      water: 'unknown', dog_fee: null, per: null, source: null, log: null, contacts: { email: null, phone: null },
    });
    expect(Object.keys(pi.clearPatch(['amenities'])).length).toBe(Object.keys(pi.AMENITIES).length);
    expect(Object.keys(pi.clearPatch(['contacts']).contacts)).toEqual(c.FIELDS);
    expect(() => pi.clearPatch(['colour'])).toThrow(/cannot clear "colour"/);
  });

  it('copies a website or a phone into TREK\'s own empty fields only', () => {
    const rec = pi.merge(null, { contacts: { website: 'https://camp.example.com', phone: '+39 000 000 0001', email: 'a@example.com' } });
    expect(pi.nativeContacts({}, rec)).toEqual({ website: 'https://camp.example.com', phone: '+390000000001' });
    expect(pi.nativeContacts({ website: 'https://other.example.com', phone: '+39 1' }, rec)).toBeNull();
    expect(pi.nativeContacts(null, rec)).toBeNull();
    expect(pi.nativeContacts({}, pi.blank())).toBeNull();
  });
});

describe('vanlife_place', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('records contacts, copies website and phone into TREK, keeps the e-mail in the plugin', async () => {
    const trip = build();
    const h = makeHost({ trip });
    const r = await call(h, 'vanlife_place', { tripId: 1, placeId: 13, set: { contacts: { email: 'Host@Camping.example.com', phone: '+39 000 000 0001', website: 'camping.example.com', preferred_channel: 'email', languages: ['it', 'en'] } } });
    expect(r).toMatchObject({ saved: true, copiedToTrek: { website: 'https://camping.example.com', phone: '+390000000001' } });
    expect(r.contacts).toMatchObject({ email: 'host@camping.example.com', preferred_channel: 'email' });
    expect(r.record.contacts.languages).toEqual(['it', 'en']);
    const place = trip.places.find((p) => p.id === 13);
    expect(place).toMatchObject({ website: 'https://camping.example.com', phone: '+390000000001' });
    expect(place.email).toBeUndefined(); // TREK has no e-mail field
    expect(r.trekFields).toEqual({ website: 'https://camping.example.com', phone: '+390000000001' });
    // a value TREK already has is never replaced
    const again = await call(h, 'vanlife_place', { tripId: 1, placeId: 13, set: { contacts: { website: 'https://new.example.com' } } });
    expect(again.copiedToTrek).toBeUndefined();
    expect(place.website).toBe('https://camping.example.com');
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 13, set: { contacts: { email: 'host-at-example' } } })).rejects.toThrow(/not a valid e-mail address/);
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 13, set: { contacts: { website: 'ftp://example.com' } } })).rejects.toThrow(/must start with http/);
  });

  it('logs exchanges, clears named fields or the whole record, and needs a placeId to write', async () => {
    const h = makeHost();
    await call(h, 'vanlife_place', { tripId: 1, placeId: 16, set: { water: 'yes', contacts: { email: 'aire@example.com' } } });
    const logged = await call(h, 'vanlife_place', { tripId: 1, placeId: 16, log: { date: '2026-10-01', channel: 'email', direction: 'sent', summary: 'Asked if open on 13/10' } });
    expect(logged.lastExchange).toMatchObject({ direction: 'sent', summary: 'Asked if open on 13/10' });
    expect(logged.log).toHaveLength(1);
    const read = await call(h, 'vanlife_place', { tripId: 1, placeId: 16 });
    expect(read).toMatchObject({ recorded: true, contacts: { email: 'aire@example.com' } });
    const cleared = await call(h, 'vanlife_place', { tripId: 1, placeId: 16, clear_fields: ['email', 'water'] });
    expect(cleared.contacts.email).toBeNull();
    expect(cleared.record.amenities.water).toBe('unknown');
    expect(cleared.log).toHaveLength(1); // the log stays unless named
    expect(await call(h, 'vanlife_place', { tripId: 1, placeId: 16, clear_fields: ['all'] })).toEqual({ placeId: 16, cleared: true });
    await expect(call(h, 'vanlife_place', { tripId: 1, set: { water: 'yes' } })).rejects.toThrow(/placeId is required/);
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 16, clear_fields: ['colour'] })).rejects.toThrow(/cannot clear/);
  });

  it('lists the nights that have no contact yet', async () => {
    const h = makeHost({ queryResults: { [pi.COPY_SQL]: [{ place_id: 13, rec: JSON.stringify(pi.merge(null, { contacts: { email: 'host@example.com' } })) }] } });
    const r = await call(h, 'vanlife_place', { tripId: 1, filter: 'missing_contacts' });
    expect(r.places.map((p) => p.placeId)).not.toContain(13);
    // the planned nights only by default: the unplanned campsite 19 is a candidate
    expect(r.places.map((p) => p.placeId)).toEqual([16, 18]);
    const all = await call(h, 'vanlife_place', { tripId: 1, filter: 'missing_contacts', scope: 'all_nights' });
    expect(all.places.map((p) => p.placeId)).toEqual(expect.arrayContaining([16, 18, 19]));
    expect(r.places.every((p) => p.missing[0] === 'contact')).toBe(true);
  });
});

describe('contacts filled from the place itself and open sources', () => {
  afterEach(() => vi.unstubAllGlobals());
  const OSM = [{ type: 'node', id: 70, lat: 46.5304, lon: 12.1302, tags: { tourism: 'camp_site', 'contact:email': 'camp@example.com', 'contact:phone': '+39 000 111 2222', website: 'https://camp.example.com' } }];
  const P4N = [{ id: 777, lat: 46.5802, lng: 12.2501, type: { code: 'ACC_P' }, services: [], phone: '+39 000 777 7777' }];
  function stub() {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('overpass')) return { ok: true, status: 200, json: async () => ({ elements: OSM }) };
      if (String(url).includes('park4night.com')) return { ok: true, status: 200, text: async () => Buffer.from(JSON.stringify(P4N)).toString('base64') };
      throw new Error(`unexpected fetch ${url}`);
    }));
  }

  it('fills only empty contact fields, notes first, then OSM, then park4night, citing each', { timeout: 20000 }, async () => {
    stub();
    const trip = build();
    const camping = trip.places.find((p) => p.id === 13);
    camping.notes += ' Write to booking@camping.example.com.';
    trip.places.find((p) => p.id === 16).website = 'https://park4night.com/en/place/777';
    const h = makeHost({ trip, config: { park4night_enabled: true } });
    await pi.set(h.ctx, 1, 13, { contacts: { phone: '+39 000 999 9999' } }); // a person already gave the phone
    const r = await fillLib.fill(h.ctx, 1, { park4night: true, language: 'fr', placeIds: [13, 16] });
    expect(r.contacts).toBe(2);
    const rec = await pi.get(h.ctx, 13);
    expect(rec.contacts).toMatchObject({ email: 'booking@camping.example.com', phone: '+390009999999', website: 'https://camp.example.com' });
    expect(rec.contact_sources).toEqual({ email: '@src.notes', website: 'OpenStreetMap https://www.openstreetmap.org/node/70' });
    expect(pi.localized(rec, 'fr').contact_sources.email).toBe('notes du lieu');
    expect(camping.website).toBe('https://camp.example.com'); // copied into TREK's empty field
    const aire = await pi.get(h.ctx, 16);
    expect(aire.contacts.phone).toBe('+390007777777');
    expect(aire.contact_sources.phone).toBe('park4night #777');
    expect(aire.source).toBeNull(); // no amenity found: no amenity source written
  });

  it('uses TREK\'s own fields of the place as a source too, and leaves a complete place alone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ elements: [] }) })));
    const trip = build();
    Object.assign(trip.places.find((p) => p.id === 14), { website: 'https://giau.example.com', phone: '+39 000 000 0014' });
    const h = makeHost({ trip });
    await fillLib.fill(h.ctx, 1, { park4night: false, language: 'en', placeIds: [14] });
    const rec = await pi.get(h.ctx, 14);
    expect(rec.contact_sources).toEqual({ website: '@src.trek', phone: '@src.trek' });
    expect(pi.localized(rec, 'en').contact_sources.phone).toBe('TREK place fields');
    expect(fillLib.incomplete(rec)).toBe(true); // no e-mail yet
    const full = pi.merge(null, { ...Object.fromEntries(Object.keys(pi.AMENITIES).map((k) => [k, 'no'])), contacts: { email: 'a@example.com', phone: '+390000000001', website: 'https://example.com' } });
    expect(fillLib.incomplete(full)).toBe(false);
    expect(fillLib.ownContacts({ website: 'https://park4night.com/en/place/1' }, 'en')).toEqual([]);
  });
});

describe('the check: nights without a contact, and hosts who did not answer', () => {
  const run = async (h, now) => {
    const settings = await readSettings(h.ctx);
    return checkTrip(h.ctx, await loadTrip(h.ctx, 1, settings), { settings, network: false, deadline: deadline(5000), now });
  };
  const keys = (r, key) => r.findings.filter((f) => f.key === key).map((f) => f.dayNumber);

  it('flags a night with neither e-mail nor phone at "verify", once per night', async () => {
    const trip = build();
    trip.places.find((p) => p.id === 18).phone = '+39 000 000 0018'; // TREK's own phone counts
    const h = makeHost({ trip, queryResults: { [pi.COPY_SQL]: [{ place_id: 13, rec: JSON.stringify(pi.merge(null, { contacts: { email: 'host@example.com' } })) }] } });
    const r = await run(h);
    expect(keys(r, 'night_no_contact')).toEqual([2]);
    expect(r.findings.find((f) => f.key === 'night_no_contact')).toMatchObject({ level: 'verify', placeId: 16 });
    expect(r.findings.find((f) => f.key === 'night_no_contact').message).toMatch(/no e-mail or phone for "Aire Example Misurina"/);
  });

  it('flags a host contacted more than 3 days ago with no answer logged', async () => {
    const sent = pi.merge(null, { log: { date: day(-5), channel: 'email', direction: 'sent', summary: 'Asked' } });
    const answered = pi.merge(sent, { log: { date: day(-1), channel: 'email', direction: 'received', summary: 'Yes, open' } });
    const recent = pi.merge(null, { log: { date: day(-2), channel: 'email', direction: 'sent', summary: 'Asked' } });
    const seed = (rec) => makeHost({ queryResults: { [pi.COPY_SQL]: [{ place_id: 16, rec: JSON.stringify(rec) }] } });
    const stale = await run(seed(sent));
    expect(stale.findings.find((f) => f.key === 'contact_stale')).toMatchObject({ level: 'verify', dayNumber: 2, params: { n: 5 } });
    expect(keys(await run(seed(answered)), 'contact_stale')).toEqual([]);
    expect(keys(await run(seed(recent)), 'contact_stale')).toEqual([]);
    // no message logged: the booking's creation date stands in for it
    const trip = build();
    trip.reservations[1].created_at = `${day(-4)}T10:00:00Z`;
    expect(keys(await run(makeHost({ trip })), 'contact_stale')).toEqual([2]);
    // a confirmed or missing booking is never "waiting"
    expect(ns.waitingDays(null, sent)).toBeNull();
    expect(ns.waitingDays({ status: 'confirmed' }, sent)).toBeNull();
    expect(ns.waitingDays({ status: 'pending' }, null)).toBeNull();
  });
});

describe('vanlife_night', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('maps the four statuses onto TREK\'s booking statuses, both ways', () => {
    expect(ns.TO_TREK).toEqual({ contacted: 'pending', booked: 'confirmed', dropped: 'cancelled' });
    expect(['pending', 'confirmed', 'cancelled'].map((s) => ns.statusOf({ status: s }))).toEqual(['contacted', 'booked', 'dropped']);
    expect(ns.statusOf(null)).toBe('spotted');
    expect(ns.statusOf({ status: 'weird' })).toBe('contacted');
    const by = ns.statusByPlace([
      { type: 'hotel', place_id: 5, status: 'cancelled' }, { type: 'hotel', place_id: 5, status: 'confirmed' }, { type: 'hotel', place_id: 5, status: 'pending' },
      { type: 'restaurant', place_id: 6, status: 'confirmed' }, { type: 'hotel', status: 'pending' },
    ]);
    expect([...by]).toEqual([[5, 'booked']]);
  });

  it('lists one line per night: status, contact, last exchange, price', async () => {
    const rec = pi.merge(null, { contacts: { email: 'aire@example.com', preferred_channel: 'email' }, log: { date: '2026-10-01', channel: 'email', direction: 'sent', summary: 'Asked if open' } });
    const h = makeHost({ queryResults: { [pi.COPY_SQL]: [{ place_id: 16, rec: JSON.stringify(rec) }] } });
    const r = await call(h, 'vanlife_night', { tripId: 1, action: 'list' });
    expect(r.nights.map((n) => [n.day, n.placeId, n.status])).toEqual([[1, 13, 'booked'], [2, 16, 'contacted'], [3, 18, 'spotted']]);
    expect(r.counts).toEqual({ spotted: 1, contacted: 1, booked: 1, dropped: 0 });
    expect(r.nights[1]).toMatchObject({ statusLabel: 'In discussion', reservationId: 502, contact: { email: 'aire@example.com', preferred_channel: 'email' }, lastExchange: { summary: 'Asked if open' }, price: '€15.00/night' });
    expect(r.nights[0].statusLabel).toBe('Booked');
    // a day with no night planned still gets its line
    const trip = build();
    trip.accommodations = trip.accommodations.slice(0, 2);
    const gap = await call(makeHost({ trip }), 'vanlife_night', { tripId: 1, action: 'list' });
    expect(gap.nights[2]).toMatchObject({ day: 3, place: null, status: null });
    const fr = await call(makeHost({ userSettings: { language: 'fr' } }), 'vanlife_night', { tripId: 1, action: 'list' });
    expect(fr.nights.map((n) => n.statusLabel)).toEqual(['Réservée', 'En discussion', 'Repérée']);
  });

  it('creates the booking of a spotted night, linked to its lodging block, as pending', async () => {
    const trip = build();
    const h = makeHost({ trip });
    const r = await call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 18, dayNumber: 3, status: 'contacted', notes: 'Asked by e-mail' });
    expect(r).toMatchObject({ action: 'created', status: 'contacted', trekStatus: 'pending', day: 3, placeId: 18 });
    expect(r.note).toMatch(/Nothing was booked/);
    const made = trip.reservations.find((x) => x.id === r.reservationId);
    expect(made).toMatchObject({ title: 'Farm Example', type: 'hotel', status: 'pending', place_id: 18, accommodation_id: 3, notes: 'Asked by e-mail' });
  });

  it('confirms with a confirmation number, drops with a reason, and warns when booked has no number', async () => {
    const trip = build();
    const h = makeHost({ trip });
    const booked = await call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 13, dayNumber: 1, status: 'booked', confirmation: 'EX-123' });
    expect(booked).toMatchObject({ action: 'updated', reservationId: 501, trekStatus: 'confirmed' });
    expect(booked.warnings).toBeUndefined();
    expect(trip.reservations[0]).toMatchObject({ status: 'confirmed', confirmation_number: 'EX-123' });
    const dropped = await call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 16, dayNumber: 2, status: 'dropped', reason: 'no tents' });
    expect(trip.reservations[1]).toMatchObject({ status: 'cancelled', notes: '[vanlife] Dropped: no tents' });
    expect(dropped.trekStatus).toBe('cancelled');
    // Back to "contacted": the plugin's own "dropped" line goes, the user's notes stay.
    trip.reservations[1].notes = 'Called the owner\n[vanlife] Dropped: no tents';
    await call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 16, dayNumber: 2, status: 'contacted' });
    expect(trip.reservations[1]).toMatchObject({ status: 'pending', notes: 'Called the owner' });
    const h2 = makeHost();
    const noNumber = await call(h2, 'vanlife_night', { tripId: 1, action: 'set', placeId: 16, dayNumber: 2, status: 'booked' });
    expect(noNumber.warnings[0]).toMatch(/No confirmation number/);
  });

  it('plans the night of an empty day, records a candidate without changing the plan, and refuses what it cannot do', async () => {
    const trip = build();
    trip.accommodations = trip.accommodations.slice(0, 2);
    const h = makeHost({ trip });
    const r = await call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 18, dayNumber: 3, status: 'contacted' });
    expect(trip.reservations.find((x) => x.id === r.reservationId).create_accommodation).toEqual({ place_id: 18, start_day_id: 103, end_day_id: 104 });
    await expect(call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 18, dayNumber: 3, status: 'contacted', nights: 2 })).rejects.toThrow(/past the last day/);
    const other = await call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 19, dayNumber: 1, status: 'contacted' });
    expect(other.warnings[0]).toMatch(/planned night is "Camping Example"/);
    expect(trip.reservations.find((x) => x.id === other.reservationId)).toMatchObject({ place_id: 19, day_id: 101, status: 'pending' });
    expect(trip.reservations.find((x) => x.id === other.reservationId).accommodation_id).toBeUndefined();
    // the same candidate again: its booking is updated, not duplicated
    const n = trip.reservations.length;
    await call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 19, dayNumber: 1, status: 'dropped', reason: 'too far' });
    expect(trip.reservations.length).toBe(n);
    await expect(call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 13, dayNumber: 1, status: 'spotted' })).rejects.toThrow(/Use status "dropped"/);
    expect(await call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 14, dayNumber: 2, status: 'spotted' })).toMatchObject({ changed: false });
    await expect(call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 13, dayNumber: 1, status: 'maybe' })).rejects.toThrow(/status must be one of/);
    await expect(call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 13, status: 'booked' })).rejects.toThrow(/give dayNumber/);
    await expect(call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 999, dayNumber: 1, status: 'booked' })).rejects.toThrow(/not in trip/);
    await expect(call(h, 'vanlife_night', { tripId: 1, action: 'drop' })).rejects.toThrow(/list or set/);
  });

  it('cannot write a booking without db:write:reservations', async () => {
    expect(manifest.permissions).toContain('db:write:reservations');
    const h = makeHost({ grants: manifest.permissions.filter((g) => g !== 'db:write:reservations') });
    await expect(call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 18, dayNumber: 3, status: 'contacted' })).rejects.toThrow(/db:write:reservations|PERMISSION/);
  });
});

describe('a kind and a status in one sentence', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('"a farm we booked": vanlife_night sets the farm category and the booked status at once', async () => {
    const trip = build();
    const h = makeHost({ trip });
    const r = await call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 16, dayNumber: 2, status: 'booked', kind: 'farm', confirmation: 'EX-9' });
    expect(r).toMatchObject({ status: 'booked', kind: { kind: 'farm', category: 'Night – Farm', categoryId: 3, changed: true } });
    expect(trip.places.find((p) => p.id === 16).category_id).toBe(3);
  });

  it('vanlife_place gives a kind alone, and refuses one the trip has no category for', async () => {
    const trip = build();
    const h = makeHost({ trip });
    const r = await call(h, 'vanlife_place', { tripId: 1, placeId: 12, kind: 'lake' });
    expect(r.kind).toMatchObject({ kind: 'lake', categoryId: 4 });
    expect(trip.places.find((p) => p.id === 12).category_id).toBe(4);
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 12, kind: 'zoo' })).rejects.toThrow(/no category of this trip matches "zoo"/);
  });
});

describe('vanlife_host_message', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('drafts English, a line of dashes, then the user\'s language, from what the record leaves open', async () => {
    const h = makeHost({ userSettings: { language: 'fr', timezone: 'Europe/Rome' } });
    const r = await call(h, 'vanlife_host_message', { tripId: 1, placeId: 13 });
    const [en, fr] = r.text.split(`\n\n${hm.SEPARATOR}\n\n`);
    expect(r.text.split(hm.SEPARATOR)).toHaveLength(2);
    expect(en).toMatch(/^Hello,/);
    expect(en).toContain('Monday, 12 October 2026');
    expect(en).toContain('We are 2 people with a dog, travelling by car with a rooftop tent.');
    expect(en).toContain('Do you accept a car with a rooftop tent');
    expect(en).toContain('4.8 m × 1.95 m');
    expect(en).toContain('We expect to arrive around 18:40'); // the night's planned time
    expect(en).toContain('Could you confirm the price of €38.00');
    expect(en).toContain('This is a request for information, not a booking yet');
    expect(fr).toMatch(/^Bonjour,/);
    expect(fr).toContain('lundi 12 octobre 2026');
    expect(fr).toContain('4,8 m × 1,95 m');
    expect(fr).toContain("Il s'agit d'une demande d'informations, pas encore d'une réservation");
    expect(r.questions.map((q) => q.key)).toEqual(['rooftop_tent', 'dog', 'open', 'arrival', 'price_confirm', 'water']);
    expect(r.subject).toBe("Information request / Demande d'informations — 12/10/2026");
    expect(r.to).toBeNull();
    expect(r.noContact).toMatch(/vanlife_place/);
    expect(r.reminder).toMatch(/DRAFT ONLY.*explicit validation/);
  });

  it('writes to the preferred channel, asks only what is unknown, and adds the local language', async () => {
    const rec = pi.merge(null, { rooftop_tent: 'yes', dog: 'fee', water: 'yes', contacts: { email: 'farm@example.com', whatsapp: '+39 000 000 0018', preferred_channel: 'whatsapp', contact_name: 'Example Host', languages: ['it', 'de'] } });
    const trip = build();
    trip.places.find((p) => p.id === 18).price = null;
    const h = makeHost({ trip, userSettings: { language: 'fr', timezone: 'Europe/Rome' }, queryResults: { [pi.COPY_SQL]: [{ place_id: 18, rec: JSON.stringify(rec) }] } });
    const r = await call(h, 'vanlife_host_message', { tripId: 1, placeId: 18, language_extra: 'de', nights: 2, arrival: '17:00', extra_questions: ['Can we buy eggs?'], signature: 'The travellers' });
    expect(r.to).toEqual({ channel: 'whatsapp', address: '+390000000018', name: 'Example Host' });
    expect(r.otherChannels).toEqual([{ channel: 'email', address: 'farm@example.com' }]);
    expect(r.languages).toEqual(['it', 'de']);
    expect(r.questions.map((q) => q.key)).toEqual(['dog_fee', 'open', 'arrival', 'price', 'extra']);
    const parts = r.text.split(`\n\n${hm.SEPARATOR}\n\n`);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain('from Wednesday, 14 October 2026 to Friday, 16 October 2026 (2 nights)');
    expect(parts[0]).toContain('5. Can we buy eggs?');
    expect(parts[0]).toMatch(/The travellers$/);
    expect(parts[2]).toMatch(/^Guten Tag,/);
    expect(parts[2]).toContain('Dies ist eine Anfrage, noch keine Buchung');
    expect(r.subject).toMatch(/ \/ Anfrage — 14\/10\/2026 \(2\)$/);
    const it = await call(h, 'vanlife_host_message', { tripId: 1, placeId: 18, language_extra: 'it' });
    expect(it.text).toContain('Buongiorno,');
  });

  it('asks a van\'s questions for a van, and needs a dated night', async () => {
    const h = makeHost({ userSettings: { language: 'fr', vehicle: 'motorhome', dog: false, travellers: 1, vehicle_length_m: 7.4, vehicle_height_m: 3.1 } });
    const r = await call(h, 'vanlife_host_message', { tripId: 1, placeId: 19, dayNumber: 2 });
    expect(r.questions.map((q) => q.key)).toEqual(['van', 'open', 'arrival_hours', 'price_confirm', 'water', 'electricity']);
    expect(r.text).toContain('Can we stay overnight in our motorhome (7.4 m × 3.1 m)?');
    expect(r.text).toContain('We are 1 person, travelling in a motorhome.');
    expect(r.text).toContain('Nous sommes 1 personne, et voyageons en camping-car.');
    await expect(call(h, 'vanlife_host_message', { tripId: 1, placeId: 19 })).rejects.toThrow(/give dayNumber/);
    await expect(call(h, 'vanlife_host_message', { tripId: 1, placeId: 999 })).rejects.toThrow(/not in trip/);
    // a place known only through TREK's own phone is still reachable
    const trip = build();
    trip.places.find((p) => p.id === 19).phone = '+39 000 000 0019';
    const p = await call(makeHost({ trip }), 'vanlife_host_message', { tripId: 1, placeId: 19, dayNumber: 2 });
    expect(p.to).toMatchObject({ channel: 'phone', address: '+39 000 000 0019' });
  });

  it('writes to an English-speaking traveller\'s host in English alone, wherever the trip is', async () => {
    const r = await call(makeHost(), 'vanlife_host_message', { tripId: 1, placeId: 13 });
    expect(r.text.split(hm.SEPARATOR)).toHaveLength(1);
    expect(r.languages_used).toEqual(['en']);
    expect(r.subject).toBe('Information request — 12/10/2026');
    // a host language with a template is added after English
    const de = await call(makeHost(), 'vanlife_host_message', { tripId: 1, placeId: 13, language_extra: 'de' });
    expect(de.languages_used).toEqual(['en', 'de']);
  });

  it('has a complete host message template in every language, each filled without a gap', async () => {
    const shape = (v) => (Array.isArray(v) ? `array${v.length}` : typeof v);
    const placeholders = (v) => [].concat(v).join(' ').match(/\{\w+\}/g)?.sort() || [];
    const langs = hm.langsOf();
    expect(langs).toHaveLength(27);
    for (const lg of langs) {
      expect(Object.keys(hm.TEXT[lg]).sort(), lg).toEqual(Object.keys(hm.TEXT.en).sort());
      for (const k of Object.keys(hm.TEXT.en)) {
        expect(shape(hm.TEXT[lg][k]), `${lg}.${k}`).toBe(shape(hm.TEXT.en[k]));
        // night: CJK counters and Arabic carry {k} themselves, the number is placed by the code elsewhere
        if (k !== 'night' && k !== 'person') expect(placeholders(hm.TEXT[lg][k]), `${lg}.${k}`).toEqual(placeholders(hm.TEXT.en[k]));
      }
      expect(hm.TEXT[lg].person[1], lg).toContain('{k}');
    }
    // a van, a dog, one night then several, one person then several: every template is used
    const settings = [
      { vehicle: 'rooftop_tent', dog: true, travellers: 2 },
      { vehicle: 'campervan', dog: true, travellers: 1, vehicle_length_m: 5.4, vehicle_height_m: 2.6 },
      { vehicle: 'motorhome', dog: false, travellers: 3, vehicle_length_m: 7.4, vehicle_height_m: 3.1 },
    ];
    for (const lg of langs.filter((x) => x !== 'en')) {
      for (const [i, s] of settings.entries()) {
        const r = await call(makeHost({ userSettings: { language: 'en', ...s } }), 'vanlife_host_message', { tripId: 1, placeId: 13, dayNumber: 1, nights: i === 1 ? 1 : 3, language_extra: lg });
        expect(r.languages_used, lg).toEqual(['en', lg]);
        const parts = r.text.split(`\n\n${hm.SEPARATOR}\n\n`);
        expect(parts, lg).toHaveLength(2);
        expect(parts[1].startsWith(hm.TEXT[lg].hello), lg).toBe(true);
        expect(parts[1], lg).toContain(hm.TEXT[lg].notBooking);
        expect(r.text, lg).not.toMatch(/\{\w+\}/);
        expect(r.subject, lg).toContain(hm.TEXT[lg].subject);
      }
    }
  });
});

describe('vanlife_day, columns, widget and catalogues', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('replaces three tools with one, and leaves the 8th place free', async () => {
    expect(TOOL_NAMES).toEqual(['vanlife_plan_trip', 'vanlife_check_trip', 'vanlife_find_nights', 'vanlife_day', 'vanlife_place', 'vanlife_night', 'vanlife_host_message']);
    const h = makeHost();
    await expect(call(h, 'vanlife_day', { tripId: 1, action: 'schedule' })).rejects.toThrow(/dayNumber is required for action "schedule"/);
    await expect(call(h, 'vanlife_day', { tripId: 1, action: 'supplies' })).rejects.toThrow(/dayNumber is required for action "supplies"/);
    await expect(call(h, 'vanlife_day', { tripId: 1, action: 'fly' })).rejects.toThrow(/routes, schedule or supplies/);
    for (const old of ['vanlife_compute_routes', 'vanlife_schedule_day', 'vanlife_supplies_on_route', 'vanlife_place_info']) {
      await expect(call(h, old, { tripId: 1 })).rejects.toThrow(/unknown tool/);
    }
    const descs = manifest.capabilities.mcpTools;
    for (const name of ['vanlife_place', 'vanlife_night', 'vanlife_host_message']) expect(descs.find((t) => t.name === name).description).toMatch(/[Nn]ever (book|send)|SENDS NOTHING|never books/);
    expect(descs.find((t) => t.name === 'vanlife_host_message').description).toMatch(/request for information, not a booking/);
  });

  it('find_nights gives the contacts OSM knows for each candidate', async () => {
    const r = await call(makeHost(), 'vanlife_find_nights', { tripId: 1, dayNumber: 1 });
    const lake = r.candidates.find((x) => x.name === 'Camping Lakeside Example');
    expect(lake.contacts).toEqual({ email: 'info@lakeside.example.com', phone: '+390000000001', website: 'https://lakeside.example.com' });
    expect(r.candidates.find((x) => x.name === 'Camping Pricey Example').contacts).toEqual({ email: null, phone: null, website: null });
  });

  it('puts a night status chip on each place with a booking, before the price, from one read', async () => {
    const trip = build();
    trip.reservations.push({ id: 503, type: 'hotel', title: 'Farm Example', status: 'cancelled', place_id: 18 });
    const h = makeHost({ trip });
    const resas = vi.spyOn(h.ctx.trips, 'getReservations');
    const cols = await h.run(plugin).hook('tableContributor', 'getContributions', 'places', 1);
    expect(resas).toHaveBeenCalledTimes(1);
    const chip = (id) => cols.find((x) => x.entityId === id && x.id === 'vanlife-night');
    expect(chip(13)).toMatchObject({ label: 'Night', value: 'Booked ✓', tone: 'success', icon: 'BedDouble' });
    expect(chip(16)).toMatchObject({ value: 'In discussion', tone: 'warn', icon: 'Clock' });
    expect(chip(18)).toMatchObject({ value: 'Dropped', tone: 'danger', icon: 'XCircle' });
    expect(chip(10)).toBeUndefined(); // a place with no booking: no chip
    const of13 = cols.filter((x) => x.entityId === 13).map((x) => x.id);
    expect(of13.indexOf('vanlife-night')).toBeLessThan(of13.indexOf('vanlife-price'));
    expect(of13[0]).toBe('vanlife-night');
    const fr = await makeHost({ userSettings: { language: 'fr' } }).run(plugin).hook('tableContributor', 'getContributions', 'places', 1);
    expect(fr.find((x) => x.entityId === 13 && x.id === 'vanlife-night')).toMatchObject({ label: 'Nuit', value: 'Réservé ✓' });
    // bookings unreadable: the other columns still come
    const broken = makeHost();
    broken.ctx.trips.getReservations = async () => { throw new Error('no'); };
    const still = await broken.run(plugin).hook('tableContributor', 'getContributions', 'places', 1);
    expect(still.some((x) => x.id === 'vanlife-price')).toBe(true);
    expect(still.some((x) => x.id === 'vanlife-night')).toBe(false);
  });

  it('widget: shows contacts, TREK\'s own fields and the night status; saves contacts with validation', async () => {
    const trip = build();
    trip.places.find((p) => p.id === 16).phone = '+39 000 000 0016';
    const h = makeHost({ trip, userSettings: { language: 'auto' } });
    const drv = h.run(plugin);
    const post = (path, body) => drv.route({ method: 'POST', path }, { body });
    const d = JSON.parse((await post('/amenities', { tripId: 1, placeId: 16, locale: 'fr' })).body);
    expect(d).toMatchObject({ nightStatus: 'contacted', reach: { phone: '+39 000 000 0016', website: null }, channels: ['email', 'phone', 'whatsapp', 'website_form'] });
    expect(d.info.contacts).toEqual(c.blankContacts());
    expect(d.strings).toMatchObject({ 'ui.contacts': "Contact de l'hôte", 'st.contacted': 'En discussion', 'ch.whatsapp': 'WhatsApp' });
    const bad = await post('/amenities/save', { tripId: 1, placeId: 16, set: { contacts: { email: 'nope' } } });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toMatch(/not a valid e-mail/);
    const ok = await post('/amenities/save', { tripId: 1, placeId: 16, set: { contacts: { email: 'aire@example.com', website: 'https://aire.example.com', phone: null } } });
    expect(JSON.parse(ok.body).info.contacts).toMatchObject({ email: 'aire@example.com', website: 'https://aire.example.com' });
    expect(trip.places.find((p) => p.id === 16).website).toBe('https://aire.example.com'); // TREK's empty field filled
    expect(trip.places.find((p) => p.id === 16).phone).toBe('+39 000 000 0016'); // never erased from TREK
    const none = JSON.parse((await post('/amenities', { tripId: 1, placeId: 10 })).body);
    expect(none.nightStatus).toBeNull();
  });

  it('has every new string in all 27 languages, translated', () => {
    const fresh = Object.keys(MESSAGES.en).filter((k) => /^(st\.|ch\.|src\.)/.test(k) || ['night_no_contact', 's.night_no_contact', 'contact_stale', 's.contact_stale', 'col.night',
      'ui.contacts', 'ui.email', 'ui.phone', 'ui.whatsapp', 'ui.website', 'ui.contactName', 'ui.languages', 'ui.preferredChannel', 'ui.contactNotes', 'ui.noContact', 'ui.night', 'ui.lastExchange', 'ui.noPreference'].includes(k));
    expect(fresh).toHaveLength(32);
    expect(CODES).toHaveLength(27);
    for (const code of CODES) {
      for (const k of fresh) expect(MESSAGES[code][k], `${code} ${k}`).toBeTruthy();
      // placeholders survive translation
      expect(MESSAGES[code].contact_stale).toContain('{n}');
      expect(MESSAGES[code]['ui.lastExchange']).toContain('{summary}');
      if (code !== 'en') expect(MESSAGES[code]['st.booked'], code).not.toBe(MESSAGES.en['st.booked']);
    }
  });
});
