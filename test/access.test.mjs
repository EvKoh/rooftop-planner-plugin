// Timed access to a place: a road closed after or before a set hour, a booking required, a toll
// per vehicle. FICTIONAL data only (public repository): the fixture trip and example.com links.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { require, makeHost, stubFetch, stubMinutes } from './helpers.mjs';

const plugin = require('../server/index.js');
const pi = require('../server/lib/place-info.js');
const { MESSAGES, CODES, clock } = require('../server/lib/i18n.js');
const { TOOL_SPECS } = require('../server/lib/tool-specs.js');
const { tripBudget } = require('../server/lib/budget.js');
const { bookingNoted } = require('../server/lib/check.js');
const { loadTrip } = require('../server/lib/trip.js');
const { readSettings } = require('../server/lib/settings.js');
const { deadline, hhmm } = require('../server/lib/util.js');
const { build, P } = require('./fixtures/trip.js');

const call = (h, name, args) => h.run(plugin).hook('mcpToolProvider', 'callTool', { name, args });
const check = (h) => call(h, 'vanlife_check_trip', { tripId: 1 });
const schedule = (h, dayNumber, extra = {}) => call(h, 'vanlife_day', { tripId: 1, action: 'schedule', dayNumber, ...extra });
const of = (r, key) => r.findings.filter((f) => f.key === key);
const access = (r) => r.findings.filter((f) => f.key.startsWith('access_'));
const asgPlace = (trip, asgId) => trip.days.flatMap((d) => d.assignments).find((a) => a.id === asgId).place;
const ROME = { timezone: 'Europe/Rome' };

/** A host whose places carry the given records (placeId → patch). */
async function hostWith(records, { trip, lang = 'en' } = {}) {
  const ids = Object.keys(records).map(Number);
  const h = makeHost({ trip, userSettings: { language: lang, ...ROME }, queryResults: { [pi.INDEX_SQL]: ids.map((id) => ({ place_id: id })) } });
  for (const id of ids) await h.ctx.meta.set('place', id, pi.META_KEY, pi.merge(null, records[id]));
  return h;
}

describe('access fields on the record', () => {
  it('stores each field, normalised, and null clears it', () => {
    const r = pi.merge(null, { access_before: '9:05', access_after: '17:30', booking_required: true, booking_url: ' https://booking.example.com/slot ', booking_note: '  30-min   slots ', toll_amount: '40.456', toll_currency: 'chf' });
    expect(r).toMatchObject({ access_before: '09:05', access_after: '17:30', booking_required: true, booking_url: 'https://booking.example.com/slot', booking_note: '30-min slots', toll_amount: 40.46, toll_currency: 'CHF' });
    expect(pi.merge(r, { booking_required: false }).booking_required).toBe(false);
    const cleared = pi.merge(r, Object.fromEntries(pi.ACCESS_FIELDS.map((k) => [k, null])));
    for (const k of pi.ACCESS_FIELDS) expect(cleared[k], k).toBeNull();
    expect(pi.merge(r, { access_before: '', booking_url: '', booking_note: '', toll_amount: '', toll_currency: '', booking_required: '' })).toMatchObject({ access_before: null, booking_url: null, booking_note: null, toll_amount: null, toll_currency: null, booking_required: null });
    expect(pi.merge(r, {})).toMatchObject({ access_before: '09:05', toll_amount: 40.46 }); // untouched when absent
    expect(pi.merge(null, { toll_amount: 0 }).toll_amount).toBe(0);
    for (const k of pi.ACCESS_FIELDS) expect(pi.blank()[k], k).toBeNull();
  });

  it('refuses bad values with a readable message', () => {
    const bad = [
      [{ access_before: '9h' }, /access_before must be a time HH:MM/],
      [{ access_before: '24:00' }, /access_before must be a time HH:MM/],
      [{ access_after: '7:60' }, /access_after must be a time HH:MM/],
      [{ access_before: '09:00', access_after: '9:00' }, /cannot be the same time/],
      [{ booking_required: 'yes' }, /booking_required must be true, false, or null/],
      [{ booking_url: 'booking.example.com' }, /booking_url must be an http:\/\/ or https:\/\//],
      [{ booking_url: 'javascript:alert(1)' }, /booking_url must be an http/],
      [{ booking_url: `https://example.com/${'a'.repeat(500)}` }, /500 characters at most/],
      [{ booking_note: 'x'.repeat(121) }, /booking_note is too long \(120 characters at most\)/],
      [{ toll_amount: -1 }, /toll_amount must be a number from 0 to 10000/],
      [{ toll_amount: 'free' }, /toll_amount must be a number/],
      [{ toll_amount: 10001 }, /toll_amount must be a number/],
      [{ toll_currency: 'EURO' }, /toll_currency must be a 3-letter ISO code/],
    ];
    for (const [patch, msg] of bad) expect(() => pi.merge(null, patch), JSON.stringify(patch)).toThrow(msg);
    expect(() => pi.merge(null, { booking_note: 'x'.repeat(120) })).not.toThrow();
  });

  it('clear_fields clears each access field', () => {
    expect(pi.clearPatch(pi.ACCESS_FIELDS)).toEqual(Object.fromEntries(pi.ACCESS_FIELDS.map((k) => [k, null])));
    expect(() => pi.clearPatch(['nope'])).toThrow(/access_before, access_after, booking_required/);
  });

  it('judges an arrival: before only, after only, closed in between, open in between', () => {
    const v = (rec, arr) => pi.accessVerdict(pi.merge(null, rec), arr);
    expect(v({ access_before: '09:00' }, 540)).toBeNull(); // on the minute is in time
    expect(v({ access_before: '09:00' }, 550)).toMatchObject({ key: 'access_late', before: 540, late: 10 });
    expect(v({ access_after: '17:00' }, 1020)).toBeNull();
    expect(v({ access_after: '17:00' }, 1000)).toMatchObject({ key: 'access_early', after: 1020, wait: 20 });
    const closed = { access_before: '09:00', access_after: '17:00' };
    expect(v(closed, 500)).toBeNull();
    expect(v(closed, 540)).toBeNull(); // on the minute it closes is in time
    expect(v(closed, 1080)).toBeNull();
    expect(v(closed, 600)).toMatchObject({ key: 'access_window', late: 60, wait: 420 });
    const open = { access_before: '18:00', access_after: '07:00' }; // a toll road open 07:00–18:00
    expect(v(open, 400)).toMatchObject({ key: 'access_early', wait: 20 });
    expect(v(open, 1100)).toMatchObject({ key: 'access_late', late: 20 });
    expect(v(open, 720)).toBeNull();
    expect(v({}, 600)).toBeNull();
    expect(pi.accessVerdict(null, 600)).toBeNull();
    expect(v(closed, null)).toBeNull();
  });

  it('writes a clock time the way the language does', () => {
    expect(clock(550, 'fr')).toBe('9 h 10');
    expect(clock(540, 'en')).toBe('9:00 AM');
    expect(clock(1450, 'fr')).toBe('0 h 10');
    expect(clock(null, 'fr')).toBeNull();
    expect(clock(Number.NaN, 'en')).toBeNull();
  });
});

describe('access in the trip check', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('nothing recorded, nothing said', async () => {
    expect(access(await check(makeHost({ userSettings: ROME })))).toEqual([]);
  });

  it('arrival after access_before is blocking, with the minutes to gain', async () => {
    const h = await hostWith({ 10: { access_before: '09:00' } }, { lang: 'fr' });
    const [f] = of(await check(h), 'access_late');
    expect(f).toMatchObject({ level: 'blocking', dayNumber: 1, placeId: 10, arrival: '10:00', lateMinutes: 60 });
    expect(f.message).toBe('J1 (2026-10-12) — « Lago di Braies » : arrivée 10 h 00, route fermée après 9 h 00 — partir 60 min plus tôt');
    const ok = await hostWith({ 10: { access_before: '10:00' } });
    expect(access(await check(ok))).toEqual([]);
  });

  it('arrival before access_after is to fix; inside a closed window too', async () => {
    const early = of(await check(await hostWith({ 10: { access_after: '11:00' } })), 'access_early');
    expect(early.map((f) => [f.level, f.dayNumber, f.waitMinutes])).toEqual([['fix', 1, 60]]);
    expect(early[0].message).toContain('"Lago di Braies": arrival 10:00 AM, cars allowed only after 11:00 AM — leave 60 min later');
    const win = of(await check(await hostWith({ 10: { access_before: '09:00', access_after: '17:00' } })), 'access_window');
    expect(win.map((f) => [f.level, f.lateMinutes, f.waitMinutes])).toEqual([['fix', 60, 420]]);
    expect(win[0].message).toContain('road closed to cars from 9:00 AM to 5:00 PM — arrive before 9:00 AM or after 5:00 PM');
  });

  it('a stop with no time is judged at the arrival the chronology gives', async () => {
    const trip = build();
    Object.assign(asgPlace(trip, 1003), { place_time: null, end_time: null }); // the museum, after the lake (ends 12:00)
    const h = await hostWith({ 11: { access_before: '12:00' } }, { trip });
    const [f] = of(await check(h), 'access_late');
    const drive = stubMinutes([P.braies.lat, P.braies.lng], [P.museum.lat, P.museum.lng]);
    expect(f).toMatchObject({ placeId: 11, arrival: hhmm(720 + drive), lateMinutes: drive });
    // the first stop of a day with no time and nothing before it: no arrival, no verdict
    const first = build();
    Object.assign(asgPlace(first, 3001), { place_time: null, end_time: null });
    expect(access(await check(await hostWith({ 17: { access_before: '06:00' } }, { trip: first })))).toEqual([]);
  });

  it('the night\'s own access is judged at the night\'s arrival', async () => {
    const r = await check(await hostWith({ 13: { access_before: '18:00' }, 16: { access_after: '17:00' } }));
    expect(of(r, 'access_late').map((f) => [f.dayNumber, f.placeId, f.arrival])).toEqual([[1, 13, '18:40']]);
    expect(of(r, 'access_early').map((f) => [f.dayNumber, f.placeId, f.waitMinutes])).toEqual([[2, 16, 30]]);
  });

  it('a required booking with none recorded is to verify, with its link and note', async () => {
    const rec = { 14: { booking_required: true, booking_url: 'https://booking.example.com/road', booking_note: '30-min slots' } };
    const [f] = of(await check(await hostWith(rec)), 'access_booking');
    expect(f).toMatchObject({ level: 'verify', dayNumber: 2, placeId: 14, bookingUrl: 'https://booking.example.com/road' });
    expect(f.message).toBe('Day 2 (2026-10-13) — "Passo Giau": booking required (30-min slots), none recorded — book it, then note the confirmation (https://booking.example.com/road)');
    const bare = of(await check(await hostWith({ 14: { booking_required: true } })), 'access_booking')[0];
    expect(bare.message).toMatch(/booking required, none recorded — book it, then note the confirmation$/);
    expect(bare.bookingUrl).toBeNull();
    expect(of(await check(await hostWith({ 14: { booking_required: false } })), 'access_booking')).toEqual([]);
    // noted on the stop, or a TREK booking confirmed or with a number: nothing to verify
    const noted = build();
    noted.days[1].assignments.find((a) => a.id === 2001).notes = 'Slot booked for 08:30';
    expect(of(await check(await hostWith(rec, { trip: noted })), 'access_booking')).toEqual([]);
    const booked = build();
    booked.reservations.push({ id: 503, type: 'other', title: 'Road slot', status: 'pending', confirmation_number: 'AB12', place_id: 14 });
    expect(of(await check(await hostWith(rec, { trip: booked })), 'access_booking')).toEqual([]);
    const dropped = build();
    dropped.reservations.push({ id: 504, type: 'other', title: 'Road slot', status: 'cancelled', confirmation_number: 'AB12', place_id: 14 });
    expect(of(await check(await hostWith(rec, { trip: dropped })), 'access_booking')).toHaveLength(1);
  });

  it('knows a recorded booking', () => {
    const model = { reservations: [{ status: 'confirmed', place_id: 5 }, { status: 'pending', accommodation_place_id: 6 }] };
    expect(bookingNoted(model, 5, '')).toBe(true);
    expect(bookingNoted(model, 6, '')).toBe(false);
    expect(bookingNoted(model, 6, 'Réservé, confirmation 42')).toBe(true);
    expect(bookingNoted({}, 7, null)).toBe(false);
  });
});

describe('access in the day schedule', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('leaves earlier to pass before access_before', async () => {
    const base = await schedule(makeHost({ userSettings: ROME }), 2);
    expect(base).toMatchObject({ departureMovedForAccess: 0, access: [] });
    expect(base.conflicts.filter((c) => c.access)).toEqual([]);
    const r = await schedule(await hostWith({ 14: { access_before: '09:00' } }), 2);
    expect(r.departureMovedForAccess).toBe(-60);
    expect(hhmm(r.departure ? +r.departure.slice(0, 2) * 60 + +r.departure.slice(3) + 60 : null)).toBe(base.departure);
    expect(r.stops[0]).toMatchObject({ placeId: 14, start: '09:00' });
    expect(r.access).toEqual([{ name: 'Passo Giau', accessBefore: '09:00', accessAfter: null, arrival: '09:00', ok: true }]);
    expect(r.conflicts).toEqual([]);
  });

  it('leaves later to pass after access_after, the night included', async () => {
    const r = await schedule(await hostWith({ 14: { access_after: '11:00' } }), 2);
    expect(r.departureMovedForAccess).toBe(60);
    expect(r.stops[0].start).toBe('11:00');
    const n = await schedule(await hostWith({ 16: { access_after: '13:00' } }), 2);
    expect(n.departureMovedForAccess).toBe(30);
    expect(n.night.arrival).toBe('13:00');
    expect(n.access).toEqual([expect.objectContaining({ name: 'Aire Example Misurina', ok: true })]);
  });

  it('a road closed in between: the smaller move', async () => {
    expect((await schedule(await hostWith({ 14: { access_before: '09:50', access_after: '17:00' } }), 2)).departureMovedForAccess).toBe(-10);
    expect((await schedule(await hostWith({ 14: { access_before: '07:00', access_after: '10:30' } }), 2)).departureMovedForAccess).toBe(30);
  });

  it('a departure given by the caller is kept: the miss is a conflict with its fix', async () => {
    const r = await schedule(await hostWith({ 14: { access_before: '09:00' } }), 2, { departure: '09:30' });
    expect(r).toMatchObject({ departure: '09:30', departureMovedForAccess: 0 });
    expect(r.conflicts).toEqual([expect.objectContaining({ assignmentId: 2001, access: 'access_late', reason: expect.stringMatching(/^arrival 09:45, road closed after 09:00: leave 45 min earlier \(departure 08:45\)$/) })]);
    expect(r.access[0].ok).toBe(false);
    const e = await schedule(await hostWith({ 14: { access_after: '11:00' } }), 2, { departure: '09:30' });
    expect(e.conflicts[0].reason).toMatch(/^arrival 09:45, cars allowed only after 11:00: leave 75 min later \(departure 10:45\)$/);
    const w = await schedule(await hostWith({ 14: { access_before: '07:00', access_after: '17:00' } }), 2, { departure: '09:30' });
    expect(w.conflicts[0].reason).toMatch(/^arrival 09:45, road closed to cars 07:00-17:00: leave 165 min earlier/);
  });

  it('two needs that pull apart move nothing and are both listed', async () => {
    const r = await schedule(await hostWith({ 14: { access_before: '09:00' }, 15: { access_after: '16:00' } }), 2);
    expect(r.departureMovedForAccess).toBe(0);
    expect(r.conflicts.filter((c) => c.access).map((c) => c.access)).toEqual(['access_late', 'access_early']);
  });
});

describe('access tolls in the budget', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  async function budget(h) {
    const settings = await readSettings(h.ctx);
    return tripBudget(h.ctx, await loadTrip(h.ctx, 1, settings), {}, { settings, deadline: deadline(10000) });
  }

  it('adds each day\'s toll to the total and proposes its budget line', async () => {
    const before = await budget(makeHost({ userSettings: ROME }));
    expect(before).toMatchObject({ accessTolls: [], accessTollTotal: 0, accessTollDays: [] });
    const r = await budget(await hostWith({ 14: { toll_amount: 40 } }));
    expect(r.accessTolls).toEqual([expect.objectContaining({ day: 2, placeId: 14, name: 'Passo Giau', amount: 40, currency: 'EUR', inBudget: false, counted: true })]);
    expect(r.accessTollTotal).toBe(40);
    expect(r.accessTollDays).toEqual([{ day: 2, total: 40 }]);
    expect(r.total).toBeCloseTo(before.total + 40, 2);
    expect(r.coreCalls).toContainEqual({ tool: 'create_budget_item', args: { tripId: 1, name: 'Toll day 2 — Passo Giau', category: 'Transport', total_price: 40 } });
  });

  it('a toll already in the budget lines is not counted twice; another currency is listed, not summed', async () => {
    const trip = build();
    trip.costs.push({ id: 603, name: 'Toll Passo Giau', category: 'Transport', total_price: 40 });
    const r = await budget(await hostWith({ 14: { toll_amount: 40 }, 17: { toll_amount: 12, toll_currency: 'CHF' } }, { trip }));
    expect(r.accessTolls.map((x) => [x.name, x.inBudget, x.counted])).toEqual([['Passo Giau', true, false], ['Lago di Carezza', false, false]]);
    expect(r.accessTollTotal).toBe(0);
    expect(r.note).toContain('Access tolls in another currency, not in the total: Lago di Carezza 12 CHF.');
    expect(r.coreCalls.filter((c) => /^Toll day/.test(c.args.name)).map((c) => c.args.name)).toEqual(['Toll day 3 — Lago di Carezza (12 CHF)']);
  });

  it('plan_trip reports the access tolls and the departure moved for an access', async () => {
    const h = await hostWith({ 14: { toll_amount: 40, access_before: '09:00' } });
    const r = await call(h, 'vanlife_plan_trip', { tripId: 1 });
    expect(r.results.budget).toMatchObject({ accessTollTotal: 40, accessTollDays: [{ day: 2, total: 40 }] });
    const d2 = r.results.schedule.find((x) => x.day === 2);
    expect(d2).toMatchObject({ departureMovedForAccess: -60, access: [expect.objectContaining({ name: 'Passo Giau', ok: true })] });
    expect(r.actions).toContainEqual({ priority: 2, action: `Day 2: leave at ${d2.departure} to meet the timed access of "Passo Giau"` });
    expect(r.actions.some((a) => /Passo Giau.*road closed after/.test(a.action) && a.priority === 1)).toBe(true); // the check's blocking point
  });
});

describe('access chips, place tool and widget', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());
  const FULL = { access_before: '09:00', access_after: '17:00', booking_required: true, booking_url: 'https://booking.example.com/road', booking_note: '30-min slots', toll_amount: 40 };

  it('one small chip per recorded field, in the user\'s language, with lucide icons', async () => {
    const h = await hostWith({ 14: FULL, 17: { booking_required: false } }, { lang: 'fr' });
    const cols = await h.run(plugin).hook('tableContributor', 'getContributions', 'places', 1);
    const mine = cols.filter((c) => c.entityId === 14 && /^vanlife-(access|booking|toll)/.test(c.id));
    const nb = (s) => s.replace(/ | /g, ' ');
    expect(mine.map((c) => [c.id, nb(c.value), c.icon, c.tone])).toEqual([
      ['vanlife-access-before', 'Avant 9 h 00', 'AlarmClock', 'warn'],
      ['vanlife-access-after', 'Après 17 h 00', 'Clock', 'warn'],
      ['vanlife-booking', 'Réservation', 'CalendarCheck', 'warn'],
      ['vanlife-toll', 'Péage 40,00 €', 'Ticket', 'default'],
    ]);
    expect(mine.map((c) => c.label)).toEqual(['Accès', 'Accès', 'Réservation', 'Péage']);
    // nothing for a "no booking" or an empty record
    expect(cols.some((c) => c.entityId === 17 && /^vanlife-(access|booking|toll)/.test(c.id))).toBe(false);
    const lucide = readFileSync(new URL('../node_modules/trek-plugin-sdk/dist/lucide-icon-names.js', import.meta.url), 'utf8');
    for (const c of mine) expect(lucide, c.icon).toContain(`"${c.icon}"`);
    expect(nb(pi.accessChips(pi.merge(null, { toll_amount: 12, toll_currency: 'CHF' }), 'en', 'EUR')[0].value)).toBe('Toll CHF 12.00');
    expect(pi.accessChips(null, 'en')).toEqual([]);
    expect(pi.accessChips(pi.merge(null, { toll_amount: 0 }), 'en', 'EUR').map((c) => c.value)).toEqual(['Toll €0.00']); // a free access is recorded too
    expect(pi.accessText(pi.blank(), 'en')).toBeNull();
  });

  it('vanlife_place sets, shows and clears the fields; bad values are refused', async () => {
    const h = makeHost({ userSettings: { language: 'en', ...ROME } });
    const saved = await call(h, 'vanlife_place', { tripId: 1, placeId: 14, set: FULL });
    expect(saved.record).toMatchObject(FULL);
    expect(saved.access).toBe('Before 9:00 AM · After 5:00 PM · Booking · Toll €40.00 · 30-min slots');
    expect(saved.bookingUrl).toBe('https://booking.example.com/road');
    const cleared = await call(h, 'vanlife_place', { tripId: 1, placeId: 14, clear_fields: ['toll_amount', 'booking_required', 'access_after'] });
    expect(cleared.record).toMatchObject({ toll_amount: null, booking_required: null, access_after: null, access_before: '09:00' });
    expect(cleared.access).toBe('Before 9:00 AM · 30-min slots');
    const nulled = await call(h, 'vanlife_place', { tripId: 1, placeId: 14, set: { access_before: null, booking_note: null } });
    expect(nulled.access).toBeNull();
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 14, set: { access_before: '25:00' } })).rejects.toThrow(/access_before must be a time HH:MM/);
    const spec = TOOL_SPECS.find((t) => t.name === 'vanlife_place').inputSchema.properties.set.properties;
    expect(spec.access_before).toMatchObject({ type: 'string', nullable: true, pattern: expect.any(String) });
    expect(spec.booking_required).toMatchObject({ type: 'boolean', nullable: true });
    expect(spec.booking_note).toMatchObject({ maxLength: 120, nullable: true });
    expect(spec.toll_amount).toMatchObject({ type: 'number', minimum: 0, nullable: true });
    expect(spec.toll_currency).toMatchObject({ pattern: '^[A-Z]{3}$', nullable: true });
  });

  it('the widget gets the chips and strings, and saving refuses a bad value with its message', async () => {
    const h = await hostWith({ 14: FULL }, { lang: 'fr' });
    const route = (path, body) => h.run(plugin).route({ method: 'POST', path }, { body });
    const w = JSON.parse((await route('/amenities', { tripId: 1, placeId: 14, locale: 'fr' })).body);
    expect(w.access.map((a) => a.key)).toEqual(['access-before', 'access-after', 'booking', 'toll']);
    expect(w.info).toMatchObject({ booking_url: 'https://booking.example.com/road' });
    expect(w.strings).toMatchObject({ 'ui.accessBefore': 'Arriver avant (fermé après)', 'ui.book': 'Réserver', 'chip.booking': 'Réservation' });
    const bad = await route('/amenities/save', { tripId: 1, placeId: 14, set: { booking_url: 'ftp://example.com' } });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toMatch(/booking_url must be an http/);
    const ok = JSON.parse((await route('/amenities/save', { tripId: 1, placeId: 14, set: { toll_amount: 15, toll_currency: 'eur', booking_required: null } })).body);
    expect(ok.info).toMatchObject({ toll_amount: 15, toll_currency: 'EUR', booking_required: null, access_before: '09:00' });
    // the same walk shorthand as the MCP tool
    const walk = JSON.parse((await route('/amenities/save', { tripId: 1, placeId: 14, set: { walk: { parking_place_id: 16, shape: 'loop', via: [[46.5, 12.1]], url: 'https://trails.example.com/1' } } })).body);
    expect(walk.info).toMatchObject({ access_parking_place_id: 16, walk_shape: 'loop', hike_url: 'https://trails.example.com/1' });
  });

  it('the widget form has every field and sends the right types', () => {
    const html = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
    for (const k of ['access_before', 'access_after', 'booking_required', 'booking_url', 'booking_note', 'toll_amount', 'toll_currency']) expect(html, k).toContain(`'${k}'`);
    expect(html).toContain("set.booking_required = set.booking_required === 'yes' ? true : set.booking_required === 'no' ? false : null;");
    expect(html).toMatch(/'visit_max_minutes', 'toll_amount'\]\.forEach/);
    expect(html).toContain("S('ui.book')");
  });
});

describe('0.4.5 strings', () => {
  const KEYS = ['access_late', 's.access_late', 'access_early', 's.access_early', 'access_window', 's.access_window', 'access_booking', 's.access_booking',
    'chip.accessBefore', 'chip.accessAfter', 'chip.booking', 'chip.toll', 'col.access', 'col.booking', 'col.toll',
    'ui.access', 'ui.accessBefore', 'ui.accessAfter', 'ui.bookingRequired', 'ui.bookingUrl', 'ui.bookingNote', 'ui.bookingNoteHint', 'ui.tollAmount', 'ui.tollCurrency', 'ui.book'];
  const HOLDERS = {
    access_late: ['{name}', '{arr}', '{before}', '{late}'], access_early: ['{name}', '{arr}', '{after}', '{wait}'],
    access_window: ['{name}', '{arr}', '{before}', '{after}'], access_booking: ['{name}', '{note}', '{link}'],
    's.access_late': ['{arr}', '{before}'], 's.access_early': ['{arr}', '{after}'], 's.access_window': ['{before}', '{after}'],
    'chip.accessBefore': ['{time}'], 'chip.accessAfter': ['{time}'], 'chip.toll': ['{amount}'],
  };

  it('are in all 27 languages, translated, with their placeholders', () => {
    expect(CODES).toHaveLength(27);
    for (const code of CODES) {
      for (const k of KEYS) expect(MESSAGES[code][k], `${code} ${k}`).toBeTruthy();
      for (const [k, list] of Object.entries(HOLDERS)) for (const ph of list) expect(MESSAGES[code][k], `${code} ${k} ${ph}`).toContain(ph);
      if (code !== 'en') for (const k of ['access_late', 'access_booking', 'ui.accessBefore', 'chip.accessBefore']) expect(MESSAGES[code][k], `${code} ${k}`).not.toBe(MESSAGES.en[k]);
    }
  });
});
