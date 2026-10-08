// One rule per question: every reader of a night, a booking and a price gives the same
// answer (trip.js stayOn, night-status.js, place-info.js nightCost). Each rule is first shown
// finding its problem, then staying quiet once the trip is fixed. Fictional data only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeHost, stubFetch, require } from './helpers.mjs';

const plugin = require('../server/index.js');
const { loadTrip, stayOn, stayBefore } = require('../server/lib/trip.js');
const { checkTrip, dayPlan } = require('../server/lib/check.js');
const { readSettings } = require('../server/lib/settings.js');
const { deadline } = require('../server/lib/util.js');
const pi = require('../server/lib/place-info.js');
const ns = require('../server/lib/night-status.js');
const { build } = require('./fixtures/trip.js');
const { cheaperNight } = require('../server/lib/nights.js');
const { dayStopMinutes, stopMinutes } = require('../server/lib/visit.js');
const { plannedStops } = require('../server/lib/walks.js');

const call = (h, name, args) => h.run(plugin).hook('mcpToolProvider', 'callTool', { name, args });
async function check(h) {
  const settings = await readSettings(h.ctx);
  return checkTrip(h.ctx, await loadTrip(h.ctx, 1, settings), { settings, network: true, deadline: deadline(12000) });
}
const keys = (r, key) => r.findings.filter((f) => f.key === key);

/** Day 3's farm booked in TREK, but its night taken out of the plan (no stay tied to the booking). */
function unlinkedTrip() {
  const trip = build();
  trip.accommodations = trip.accommodations.filter((a) => a.id !== 3);
  trip.days[2].assignments.find((a) => a.id === 3002).accommodation_id = null;
  trip.reservations.push({ id: 503, type: 'hotel', title: 'Farm Example', status: 'confirmed', confirmation_number: 'EX-9', place_id: 18, day_id: 103, accommodation_id: null });
  return trip;
}

/** The campsite booked for two nights (days 1 and 2); no motorhome area any more. */
function twoNightTrip() {
  const trip = build();
  trip.accommodations = trip.accommodations.filter((a) => a.id !== 2);
  trip.accommodations[0].end_day_id = 103;
  trip.days[1].assignments = trip.days[1].assignments.filter((a) => a.id !== 2004);
  trip.reservations = trip.reservations.filter((r) => r.id !== 502);
  return trip;
}

describe('a booking tied to no night', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('is flagged by the check and listed as unlinked, not as "no night"', async () => {
    const h = makeHost({ trip: unlinkedTrip() });
    const r = await check(h);
    const [f] = keys(r, 'resa_unlinked');
    expect(f).toMatchObject({ level: 'fix', dayNumber: 3, reservationId: 503, placeId: 18 });
    expect(f.message).toMatch(/tied to no night of the plan/);
    const list = await call(h, 'vanlife_night', { tripId: 1, action: 'list' });
    const d3 = list.nights.find((x) => x.day === 3);
    expect(d3).toMatchObject({ unlinked: true, status: 'booked', placeId: 18, reservationId: 503 });
    expect(d3.note).toMatch(/tied to no night/);
    expect(list.counts.unlinked).toBe(1);
    expect(list.counts.booked).toBe(1); // night 1 only: an unlinked booking is not a booked night
  });

  it('is tied to a new stay when its status is set again, then the check is quiet', async () => {
    const trip = unlinkedTrip();
    const h = makeHost({ trip });
    const update = vi.spyOn(h.ctx.reservations, 'update');
    const r = await call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 18, dayNumber: 3, status: 'booked' });
    expect(r).toMatchObject({ action: 'linked', reservationId: 503 });
    expect(update).toHaveBeenCalledWith(1, 503, expect.objectContaining({ type: 'hotel', create_accommodation: { place_id: 18, start_day_id: 103, end_day_id: 104 } }));
    // What TREK does with it: the stay is made and the booking tied to it.
    trip.accommodations.push({ id: 3, place_id: 18, place_name: 'Farm Example', place_lat: 46.64, place_lng: 11.72, start_day_id: 103, end_day_id: 104, check_in: null, notes: '' });
    Object.assign(trip.reservations.find((x) => x.id === 503), { accommodation_id: '3', accommodation_place_id: 18, accommodation_start_day_id: 103 });
    expect(keys(await check(makeHost({ trip })), 'resa_unlinked')).toEqual([]);
  });
});

describe('a booking whose notes or price disagree with it', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('flags "waiting" notes left on a confirmed booking, and stays quiet once they are updated', async () => {
    const trip = build();
    trip.reservations[0].notes = 'En attente de confirmation explicite';
    expect(keys(await check(makeHost({ trip })), 'resa_note_stale')).toHaveLength(1);
    trip.reservations[0].notes = 'Confirmed by e-mail on 02/10';
    expect(keys(await check(makeHost({ trip })), 'resa_note_stale')).toEqual([]);
  });

  it('flags a booked price unlike the plan, and stays quiet once the place says the same', async () => {
    const trip = build();
    trip.reservations[0].metadata = JSON.stringify({ price: 34 });
    const [f] = keys(await check(makeHost({ trip })), 'resa_price');
    expect(f).toMatchObject({ level: 'fix', dayNumber: 1, placeId: 13 });
    expect(f.message).toMatch(/€34\.00.*€38\.00/);
    trip.places.find((p) => p.id === 13).price = 34;
    expect(keys(await check(makeHost({ trip })), 'resa_price')).toEqual([]);
  });

  it('a stronger booking of the same night wins over a cancelled one', async () => {
    const trip = build();
    trip.reservations[1].status = 'cancelled';
    expect(keys(await check(makeHost({ trip })), 'night_cancelled')).toHaveLength(1);
    trip.reservations.push({ id: 504, type: 'hotel', title: 'Aire Example Misurina', status: 'confirmed', confirmation_number: 'EX-2', accommodation_id: '2', accommodation_place_id: 16, accommodation_start_day_id: 102 });
    const h = makeHost({ trip });
    expect(keys(await check(h), 'night_cancelled')).toEqual([]);
    const list = await call(h, 'vanlife_night', { tripId: 1, action: 'list' });
    expect(list.nights.find((x) => x.day === 2)).toMatchObject({ status: 'booked', reservationId: 504 });
  });
});

describe('a stay of several nights', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('is every evening it covers: the day plan, the night list and its counts', async () => {
    const h = makeHost({ trip: twoNightTrip() });
    const model = await loadTrip(h.ctx, 1);
    const d2 = model.days[1];
    expect(stayOn(model, d2).placeId).toBe(13);
    expect(stayBefore(model, d2).placeId).toBe(13);
    const plan = dayPlan(model, d2);
    expect(plan.veille.placeId).toBe(13); // the morning starts at camp
    expect(plan.nuit.placeId).toBe(13); // and the evening ends there
    const list = await call(h, 'vanlife_night', { tripId: 1, action: 'list' });
    expect(list.nights.find((x) => x.day === 2)).toMatchObject({ placeId: 13, continues: 1, status: 'booked' });
    expect(list.nights.some((x) => x.note === 'no night planned on this day')).toBe(false);
    expect(list.counts.booked).toBe(2); // two booked nights, not one stay
  });

  it('drafts the host message for the whole stay, without stepping a booked night back', async () => {
    const h = makeHost({ trip: twoNightTrip() });
    const m = await call(h, 'vanlife_host_message', { tripId: 1, placeId: 13, dayNumber: 2 });
    expect(m).toMatchObject({ date: '2026-10-12', nights: 2, nightStatus: 'booked' });
    expect(m.reminder).not.toMatch(/set status "contacted"/);
    expect(m.reminder).toMatch(/already "booked"/);
  });
});

describe('the price of a night', () => {
  it('is the party\'s, per night and per stay; a flat price is paid once', () => {
    const settings = { travellers: 2, dog: true };
    const perPerson = pi.merge(null, { per: 'person', dog: 'fee', dog_fee: 3 });
    expect(pi.nightCost(12, perPerson, settings, 3)).toEqual({ perNight: 27, perStay: 81 });
    expect(pi.nightCost(60, pi.merge(null, { per: 'flat' }), settings, 3)).toEqual({ perNight: 20, perStay: 60 });
    expect(pi.nightCost(5, pi.merge(null, { per: 'hour' }), settings, 1)).toEqual({ perNight: null, perStay: null });
    // Candidates are quoted per night for the vehicle: a per-person night does not compare.
    expect(pi.comparableNightPrice({ price: 27, info: perPerson })).toBeNull();
    expect(pi.comparableNightPrice({ price: 38, info: null })).toBe(38);
  });

  it('leaves the lodging budget alone while a night price is unknown', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const trip = build();
      expect(keys(await check(makeHost({ trip })), 'budget_total')).toHaveLength(1);
      trip.places.find((p) => p.id === 18).price = null;
      expect(keys(await check(makeHost({ trip })), 'budget_total')).toEqual([]);
      // The three planned nights count; once one is dropped, it is listed apart, not summed.
      expect(ns.nightsMoney(await loadTrip(makeHost({ trip: build() }).ctx, 1)).total).toBe(73); // 38 + 15 + 20
      const dropped = build();
      dropped.reservations[1].status = 'cancelled';
      const money = ns.nightsMoney(await loadTrip(makeHost({ trip: dropped }).ctx, 1));
      expect(money.total).toBe(58);
      expect(money.dropped.map((x) => x.placeId)).toEqual([16]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('falls back on the trip\'s currency in the planner columns and the place panel', async () => {
    const trip = build();
    trip.data.currency = 'CHF';
    const h = makeHost({ trip });
    const cols = await h.run(plugin).hook('tableContributor', 'getContributions', 'places', 1);
    expect(cols.find((x) => x.entityId === 13 && x.id === 'vanlife-price').value).toMatch(/CHF/);
    const w = JSON.parse((await h.run(plugin).route({ method: 'POST', path: '/amenities' }, { body: { tripId: 1, placeId: 13 } })).body);
    expect(w.currency).toBe('CHF');
    expect(w.priceText).toMatch(/CHF/);
  });
});

describe('the schedule\'s defaults', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('leaves at the day_start setting, and says when it assumes a time on site', async () => {
    const trip = build();
    for (const a of trip.days[2].assignments) { a.place.place_time = null; a.place.end_time = null; }
    const h = makeHost({ trip, userSettings: { language: 'en', timezone: 'Europe/Rome', day_start: '07:30' } });
    const r = await call(h, 'vanlife_day', { tripId: 1, action: 'schedule', dayNumber: 3 });
    expect(r.departure).toBe('07:30');
    expect(r.assumedStays).toMatchObject({ minutes: 60, assignmentIds: [3001] });
  });
});

describe('contacts', () => {
  it('erasing a contact that TREK\'s own field holds empties that field too', async () => {
    const h = makeHost();
    const update = vi.spyOn(h.ctx.places, 'update');
    await pi.set(h.ctx, 1, 13, { contacts: { phone: '+39 000 000 0001' } }, { place: { id: 13 } });
    expect(update).toHaveBeenLastCalledWith(1, 13, { phone: '+390000000001' });
    await pi.set(h.ctx, 1, 13, { contacts: { phone: null } }, { place: { id: 13, phone: '+390000000001' } });
    expect(update).toHaveBeenLastCalledWith(1, 13, { phone: null });
  });
});

describe('the review\'s counter-checks: each shared rule is held by a test', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('a later evening of a stay does not repeat the arrival rules (no arrival asked for day 2)', async () => {
    const r = await check(makeHost({ trip: twoNightTrip() }));
    expect(keys(r, 'night_no_arrival').map((f) => f.dayNumber)).not.toContain(2);
  });

  it('a rest day at camp asks for no route place; a day that drives still does', async () => {
    const trip = twoNightTrip();
    trip.days[1].assignments = trip.days[1].assignments.filter((a) => a.id !== 2002);
    const days = keys(await check(makeHost({ trip })), 'no_trace').map((f) => f.dayNumber);
    expect(days).not.toContain(2);
    expect(days).toContain(3);
  });

  it('an evening with no night planned does not break a run of dry nights', async () => {
    const trip = build();
    trip.places.find((p) => p.id === 13).notes = 'Check-in 8h–21h. No water on site.';
    trip.accommodations = trip.accommodations.filter((a) => a.id !== 2);
    trip.days[1].assignments.find((a) => a.id === 2004).accommodation_id = null;
    trip.reservations = trip.reservations.filter((r) => r.id !== 502);
    expect(keys(await check(makeHost({ trip })), 'water_fix').map((f) => f.dayNumber)).toContain(3);
  });

  it('a pending request to a second host is not an unlinked booking; a confirmed one is', async () => {
    const trip = build();
    const h = makeHost({ trip });
    await call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 19, dayNumber: 1, status: 'contacted' });
    expect(keys(await check(makeHost({ trip })), 'resa_unlinked')).toEqual([]);
    trip.reservations.find((r) => r.place_id === 19).status = 'confirmed';
    expect(keys(await check(makeHost({ trip })), 'resa_unlinked')).toHaveLength(1);
  });

  it('lists every unlinked booking of an evening, one row each', async () => {
    const trip = unlinkedTrip();
    trip.reservations.push({ id: 504, type: 'hotel', title: 'Camping Old Choice', status: 'confirmed', confirmation_number: 'EX-5', place_id: 19, day_id: 103, accommodation_id: null });
    const list = await call(makeHost({ trip }), 'vanlife_night', { tripId: 1, action: 'list' });
    expect(list.nights.filter((x) => x.day === 3).map((x) => x.reservationId)).toEqual([503, 504]);
  });

  it('an untied hotel booking of a stay\'s place and first evening is that stay\'s booking', async () => {
    const trip = build();
    trip.reservations.push({ id: 505, type: 'hotel', title: 'Farm Example', status: 'confirmed', confirmation_number: 'EX-6', place_id: 18, day_id: 103, accommodation_id: null });
    const h = makeHost({ trip });
    const list = await call(h, 'vanlife_night', { tripId: 1, action: 'list' });
    expect(list.nights.find((x) => x.day === 3)).toMatchObject({ status: 'booked', reservationId: 505 });
    expect(keys(await check(h), 'resa_unlinked')).toEqual([]);
  });

  it('money in another currency is listed apart, never summed nor compared', async () => {
    const trip = build();
    trip.places.find((p) => p.id === 18).currency = 'CHF';
    trip.reservations[0].metadata = JSON.stringify({ price: 99, priceCurrency: 'CHF' });
    const h = makeHost({ trip });
    const money = ns.nightsMoney(await loadTrip(h.ctx, 1));
    expect(money.otherCurrency.map((x) => x.placeId)).toEqual([18]);
    expect(money.total).toBe(53);
    const r = await check(h);
    expect(keys(r, 'budget_total')).toEqual([]); // incomplete: not compared
    expect(keys(r, 'resa_price')).toEqual([]); // a CHF booking against a EUR night
  });

  it('a cancelled booking\'s price is not compared (the night is flagged cancelled instead)', async () => {
    const trip = build();
    Object.assign(trip.reservations[1], { status: 'cancelled', metadata: JSON.stringify({ price: 99 }) });
    const r = await check(makeHost({ trip }));
    expect(keys(r, 'night_cancelled')).toHaveLength(1);
    expect(keys(r, 'resa_price')).toEqual([]);
  });

  it('an old untagged "Dropped:" line goes on the next status change', async () => {
    const trip = build();
    trip.reservations[1].notes = 'Called the owner\nDropped: full';
    await call(makeHost({ trip }), 'vanlife_night', { tripId: 1, action: 'set', placeId: 16, dayNumber: 2, status: 'contacted' });
    expect(trip.reservations[1].notes).toBe('Called the owner');
  });

  it('the cheaper night compares prices in the same unit only', () => {
    const cand = { name: 'Camping Cheap Example', price: 20, blocked: [], legalRisk: null, openOnDate: 'open', detourMinutes: 10, detourKm: 5 };
    const settings = { fuel_l_per_100km: 8, fuel_price_per_l: 1.8 };
    expect(cheaperNight({ currentNight: { comparablePrice: null }, candidates: [cand] }, settings)).toBeNull();
    const best = cheaperNight({ currentNight: { comparablePrice: 38 }, candidates: [cand] }, settings);
    expect(best.candidate.name).toBe('Camping Cheap Example');
    expect(best.net).toBeLessThan(18); // the detour's fuel is paid
  });

  it('a car park on a hike day costs no time of its own; a planned slot beats a shorter minimum', () => {
    const park = { place: { name: 'P Example', categoryName: 'Parking' } };
    const hike = { place: { name: 'Summit Example', categoryName: 'Hike' } };
    expect(dayStopMinutes(park, null, [park, hike])).toBe(0);
    expect(dayStopMinutes(park, pi.merge(null, { visit_min_minutes: 30 }), [park])).toBe(30);
    const slot = { time: 600, end: 900 };
    expect(stopMinutes(slot, pi.merge(null, { visit_min_minutes: 60 }))).toBe(300);
    expect(stopMinutes({ time: 600, end: 630 }, pi.merge(null, { visit_min_minutes: 60 }))).toBe(60);
  });

  it('a night place is still a hike\'s car park or a stop on the days nobody sleeps there', async () => {
    const trip = build();
    trip.days[2].assignments.push({ id: 3003, day_id: 103, order_index: 2, notes: null, accommodation_id: null, place: { ...trip.places.find((p) => p.id === 13), place_time: null, end_time: null, category: { id: 1, name: 'Night – Campsite' } } });
    const model = await loadTrip(makeHost({ trip }).ctx, 1);
    const stops = plannedStops(model).map((x) => [x.place.id, x.day.n]);
    expect(stops).toContainEqual([13, 3]);
    expect(stops).not.toContainEqual([13, 1]); // its own night that evening
  });

  it('says the arrival is unknown, not late, when it cannot be computed', async () => {
    const trip = build();
    Object.assign(trip.accommodations[2], { place_lat: null, place_lng: null });
    Object.assign(trip.places.find((p) => p.id === 18), { lat: null, lng: null });
    const r = await call(makeHost({ trip }), 'vanlife_day', { tripId: 1, action: 'schedule', dayNumber: 3 });
    expect(r.night.ok).toBeNull();
  });

  it('the panel writes no currency the user did not pick', async () => {
    const h = makeHost();
    const w = JSON.parse((await h.run(plugin).route({ method: 'POST', path: '/amenities' }, { body: { tripId: 1, placeId: 13 } })).body);
    expect(w).toMatchObject({ currency: 'EUR', placeCurrency: null });
  });
});

describe('one language on one screen', () => {
  it('under "auto", the columns follow the language the place panel was shown in', async () => {
    const h = makeHost({ userSettings: { language: 'auto', timezone: 'Europe/Rome' } });
    const label = async () => (await h.run(plugin).hook('tableContributor', 'getContributions', 'places', 1)).find((x) => x.id === 'vanlife-price').label;
    expect(await label()).toBe('Price'); // the instance default, before any panel was opened
    await h.run(plugin).route({ method: 'POST', path: '/amenities' }, { body: { tripId: 1, placeId: 13, locale: 'de-DE' } });
    expect(await label()).toBe((require('../server/i18n/de.json'))['col.price']);
    // A language the user chose wins over the panel's.
    const fr = makeHost({ userSettings: { language: 'fr', timezone: 'Europe/Rome' } });
    await fr.run(plugin).route({ method: 'POST', path: '/amenities' }, { body: { tripId: 1, placeId: 13, locale: 'de-DE' } });
    expect((await fr.run(plugin).hook('tableContributor', 'getContributions', 'places', 1)).find((x) => x.id === 'vanlife-price').label).toBe('Prix');
  });
});

describe('the last audit: car parks, currencies, the day\'s road', () => {
  it('a car park known by its name only costs no time on a hike day', () => {
    const park = { place: { name: 'Car park Example', categoryName: 'Misc' } }; // a generic category: the name decides
    const hike = { place: { name: 'Summit Example', categoryName: 'Hike' } };
    expect(dayStopMinutes(park, null, [park, hike])).toBe(0);
  });

  it('a night priced in another currency is never compared with candidates', async () => {
    const { anchors } = require('../server/lib/nights.js');
    const trip = build();
    const h = makeHost({ trip });
    const model = await loadTrip(h.ctx, 1);
    expect(anchors(model, model.days[0]).current.comparablePrice).toBe(38);
    trip.places.find((p) => p.id === 13).currency = 'HUF';
    const other = await loadTrip(makeHost({ trip }).ctx, 1);
    expect(anchors(other, other.days[0]).current.comparablePrice).toBeNull();
  });

  it('supplies are searched along the road the car drives, not up to a hike\'s summit', async () => {
    const routing = require('../server/lib/routing.js');
    const { dayGeometry } = require('../server/lib/supplies.js');
    const trip = build();
    trip.days[2].assignments.find((a) => a.id === 3001).place.category = { id: 9, name: 'Hike' };
    trip.days[2].assignments.find((a) => a.id === 3001).place.name = 'Summit Example';
    const model = await loadTrip(makeHost({ trip }).ctx, 1);
    const spy = vi.spyOn(routing, 'route').mockResolvedValue({ points: [[0, 0], [1, 1]] });
    try {
      await dayGeometry({}, model, model.days[2], { vehicle: 'rooftop_tent', highway_days: 'never' }, { network: true });
      const pts = spy.mock.calls[0][0];
      expect(pts.some((p) => p[0] === 46.4097 && p[1] === 11.5753)).toBe(false); // the summit is walked
    } finally { spy.mockRestore(); }
  });
});

describe('the post-fix audit', () => {
  it('the planner route profiles apply the drive-time factor, as every other drive time', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const route = async (factor) => (await makeHost({ userSettings: { language: 'en', timezone: 'Europe/Rome', drive_time_factor: factor } }).run(plugin)
        .hook('routeProvider', 'getRoute', { tripId: 1, dayId: 101, profile: 'vanlife', waypoints: [{ lat: 46.69, lng: 12.08 }, { lat: 46.53, lng: 12.13 }] })).duration;
      const one = await route(1);
      const slow = await route(1.5);
      expect(slow).toBeGreaterThan(one * 1.45); // rounded to the minute
      expect(slow).toBeLessThan(one * 1.55);
    } finally { vi.unstubAllGlobals(); }
  });

  it('a candidate\'s price is read in its own currency and compared only in the trip\'s', () => {
    const { priceCurrency } = require('../server/lib/nights.js');
    expect(priceCurrency({ charge: '15 EUR' }, 'CHF')).toBe('EUR');
    expect(priceCurrency({ charge: 'CHF 20' }, 'EUR')).toBe('CHF');
    expect(priceCurrency({ charge: '15' }, 'CHF')).toBe('CHF'); // a bare amount: the money of the place
    const cand = { name: 'Camping Cheap Example', price: 20, currency: 'EUR', blocked: [], legalRisk: null, openOnDate: 'open', detourMinutes: 10, detourKm: 5 };
    const settings = { fuel_l_per_100km: 8, fuel_price_per_l: 1.8 };
    expect(cheaperNight({ currentNight: { comparablePrice: 38, currency: 'CHF' }, candidates: [cand] }, settings)).toBeNull();
    expect(cheaperNight({ currentNight: { comparablePrice: 38, currency: 'EUR' }, candidates: [cand] }, settings)).not.toBeNull();
    expect(cheaperNight({ currentNight: { comparablePrice: 38, currency: 'EUR' }, candidates: [{ ...cand, openOnDate: 'unknown' }] }, settings)).toBeNull();
  });

  it('a new trip\'s plan allows motorhome areas to a van, never to a rooftop tent', () => {
    const { planRequest } = require('../server/lib/plan.js');
    const why = (vehicle) => planRequest({ destination: 'Example' }, { vehicle }).steps[2].why;
    expect(why('rooftop_tent')).toMatch(/never a motorhome area/);
    expect(why('campervan')).toMatch(/campsite, farm or motorhome area/);
  });

  it('a donation farm\'s "confirmed" note clears the no-number hint, as the warning says', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const trip = build();
      expect(keys(await check(makeHost({ trip })), 'resa_confirmed')).toHaveLength(1);
      trip.reservations[0].notes = 'Donation farm, no number';
      expect(keys(await check(makeHost({ trip })), 'resa_confirmed')).toEqual([]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('the schedule points to a field vanlife_place accepts', async () => {
    const { TOOL_SPECS } = require('../server/lib/tool-specs.js');
    const set = TOOL_SPECS.find((t) => t.name === 'vanlife_place').inputSchema.properties.set.properties;
    vi.stubGlobal('fetch', stubFetch());
    try {
      const trip = build();
      for (const a of trip.days[2].assignments) { a.place.place_time = null; a.place.end_time = null; }
      const r = await call(makeHost({ trip }), 'vanlife_day', { tripId: 1, action: 'schedule', dayNumber: 3 });
      const field = r.assumedStays.note.match(/set\.(\w+)/)[1];
      expect(set[field]).toBeDefined();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('the 0.6.2 audit: what the plugin writes, it reads back', () => {
  it('a sheet field written in any language reads back as that field, and is replaced, not repeated', () => {
    const sheet = require('../server/lib/place-sheet.js');
    for (const L of ['nl', 'ja', 'it', 'fr']) {
      let txt = sheet.setField('', '', 'duration', '2 h', L);
      txt = sheet.setField(txt.description, txt.notes, 'duration', '3 h', L);
      const s = sheet.sheetOf({ name: 'Example', categoryName: 'Hike', description: txt.description, notes: txt.notes });
      expect(s.fields.duration.minutes, L).toBe(180);
      expect(txt.notes.split('\n').filter(Boolean), L).toHaveLength(1);
    }
    // Italian "Percorso" is route_type's own label: it reads back as route_type.
    const it = sheet.setField('', '', 'route_type', 'anello', 'it');
    expect(sheet.sheetOf({ name: 'Example', categoryName: 'Hike', description: '', notes: it.notes }).fields.route_type.text).toBe('anello');
  });

  it('a budget line the plugin proposed is recognised in every language, and other currencies are not summed', async () => {
    const { isFuelLine, isTollLine, tripBudget } = require('../server/lib/budget.js');
    expect(isFuelLine({ name: 'Kraftstoff Tag 2 (120 km)' })).toBe(true);
    expect(isTollLine({ name: 'Peaje día 3 — Lago di Carezza' })).toBe(true);
    expect(isTollLine({ name: 'Tol dag 3 — Lago di Carezza' })).toBe(true);
    vi.stubGlobal('fetch', stubFetch());
    try {
      const trip = build();
      trip.costs.push({ id: 603, name: 'Péage jour 3 — Example', category: 'Transport', total_price: 40, currency: 'CHF' });
      const h = makeHost({ trip });
      const settings = await readSettings(h.ctx);
      const r = await tripBudget(h.ctx, await loadTrip(h.ctx, 1, settings), {}, { settings, deadline: deadline(10000) });
      expect(r.tollTotal).toBe(18.5); // the CHF line is listed, not added as euros
      expect(r.note).toMatch(/Toll lines in another currency, not in the total: Péage jour 3 — Example 40 CHF/);
    } finally { vi.unstubAllGlobals(); }
  });

  it('a lodging line in another currency stops the lodging comparison', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const trip = build();
      expect(keys(await check(makeHost({ trip })), 'budget_total')).toHaveLength(1);
      trip.costs[0].currency = 'CHF';
      expect(keys(await check(makeHost({ trip })), 'budget_total')).toEqual([]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('a candidate in another currency gets no saving nor total cost', async () => {
    const base = stubFetch();
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const res = await base(url, init);
      if (!String(url).includes('overpass') || !/camp_site/.test(decodeURIComponent(String(init.body)))) return res;
      const body = await res.json();
      body.elements = [...body.elements, { type: 'node', id: 8, lat: 46.6, lon: 12.16, tags: { tourism: 'camp_site', name: 'Camping Franc Example', charge: 'CHF 20', tents: 'yes' } }];
      return { ok: true, status: 200, json: async () => body };
    }));
    try {
      const r = await call(makeHost(), 'vanlife_find_nights', { tripId: 1, dayNumber: 1 });
      const chf = r.candidates.find((c) => c.name === 'Camping Franc Example');
      expect(chf).toMatchObject({ currency: 'CHF', price: 20 });
      expect(chf.savingVsCurrent).toBeUndefined();
      expect(chf.totalCost).toBeUndefined();
      expect(r.candidates.find((c) => c.name === 'Camping Lakeside Example').savingVsCurrent).toBe(20);
    } finally { vi.unstubAllGlobals(); }
  });

  it('fill reads a time on site the notes state, even on an otherwise complete record', () => {
    const fillLib = require('../server/lib/amenity-fill.js');
    const full = pi.merge(null, { contacts: { email: 'a@example.com', phone: '+39 000 000 0001', website: 'https://example.com' } });
    for (const k of Object.keys(full.amenities)) full.amenities[k] = 'no';
    expect(fillLib.incomplete(full, { notes: '' })).toBe(false);
    expect(fillLib.incomplete(full, { notes: 'Hike, 2h30 round trip.' })).toBe(true);
  });
});

describe('the 0.6.3 audit: the sheet speaks every language to every rule', () => {
  const sheet = require('../server/lib/place-sheet.js');
  const { MESSAGES, CODES } = require('../server/lib/i18n.js');

  it('no two sheet fields share a label in any language', () => {
    for (const c of CODES) {
      const labels = Object.keys(MESSAGES[c]).filter((k) => k.startsWith('sh.f.')).map((k) => sheet.keyForm(MESSAGES[c][k]));
      expect(new Set(labels).size, c).toBe(labels.length);
    }
  });

  it('a duration, a welcome window, a dog or tent answer written in any language counts in the check', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      for (const L of ['es', 'nl', 'de', 'ru']) {
        const trip = build();
        const lake = trip.days[2].assignments.find((a) => a.id === 3001);
        Object.assign(lake.place, { place_time: null, end_time: null }); // no slot: only the sheet says how long
        lake.place.notes = sheet.setField('', '', 'duration', '2 h 30', L).notes;
        trip.places.find((p) => p.id === 17).notes = lake.place.notes;
        const farm = trip.places.find((p) => p.id === 18);
        let txt = sheet.setField('', '', 'arrival', '17:00-19:00', L); // the farm is reached at 16:00
        txt = sheet.setField(txt.description, txt.notes, 'dog', MESSAGES[L]['opt.no'], L);
        farm.notes = txt.notes;
        const r = await check(makeHost({ trip, userSettings: { language: L, timezone: 'Europe/Rome', dog: true } }));
        expect(keys(r, 'visit_unknown').some((f) => f.dayNumber === 3), L).toBe(false);
        expect(keys(r, 'welcome_window').some((f) => f.dayNumber === 3), L).toBe(true);
        // read from the notes: a point to verify, quoted (only the record's no blocks)
        expect(keys(r, 'sheet_refusal').some((f) => f.dayNumber === 3 && f.level === 'verify'), L).toBe(true);
      }
    } finally { vi.unstubAllGlobals(); }
  });

  it('the planner and the check challenge a night only above the target price', () => {
    const cand = { name: 'Camping Cheap Example', price: 18, currency: 'EUR', blocked: [], legalRisk: null, openOnDate: 'open', detourMinutes: 10, detourKm: 5 };
    const res = { currentNight: { comparablePrice: 38, currency: 'EUR' }, candidates: [cand] };
    expect(cheaperNight(res, { fuel_l_per_100km: 8, fuel_price_per_l: 1.8, night_price_target: 40 })).toBeNull();
    expect(cheaperNight(res, { fuel_l_per_100km: 8, fuel_price_per_l: 1.8, night_price_target: 25 })).not.toBeNull();
  });

  it('a fuel line\'s day is its day, never its kilometres', () => {
    const { fuelDayOf } = require('../server/lib/budget.js');
    expect(fuelDayOf({ name: 'Fuel day 1 (4 km)' })).toBe(1);
    expect(fuelDayOf({ name: 'Kraftstoff Tag 2 (120 km)' })).toBe(2);
    expect(fuelDayOf({ name: 'Carburant (12 km) J3' })).toBe(3);
  });

  it('the place tool shows the time on site the plan counts, as the panel does', async () => {
    const trip = build();
    trip.places.find((p) => p.id === 10).notes = 'Durée : 4 h';
    const h = makeHost({ trip, queryResults: { [pi.INDEX_SQL]: [{ place_id: 10 }] } });
    await h.ctx.meta.set('place', 10, pi.META_KEY, pi.merge(null, { visit_min_minutes: 150 }));
    const r = await call(h, 'vanlife_place', { tripId: 1, placeId: 10 });
    expect(r.visit).toBe('2 h 30');
    expect(r.sheet.fields.duration.minutes).toBe(150);
  });

  it('a refusal stated in the sheet shows in the planner columns', async () => {
    const trip = build();
    trip.places.find((p) => p.id === 18).notes = 'Chien : interdit';
    const cols = await makeHost({ trip, userSettings: { language: 'fr', dog: true } }).run(plugin).hook('tableContributor', 'getContributions', 'places', 1);
    // only the notes say no: an amber point to verify, not the red "ruled out" chip
    expect(cols.some((x) => x.entityId === 18 && x.id === 'vanlife-am-no')).toBe(false);
    expect(cols.find((x) => x.entityId === 18 && x.id === 'vanlife-am-check')).toMatchObject({ value: 'Notes : ✗ chien — à vérifier', tone: 'warn' });
  });
});

describe('an unstated answer is not a refusal', () => {
  it('"non précisé" and "not stated" leave the dog unknown; a bare "Non" or "Нет" is a no', () => {
    const { dogOf } = require('../server/lib/place-sheet.js');
    expect(dogOf('non précisé')).toBeNull();
    expect(dogOf('non specificato')).toBeNull();
    expect(dogOf('Non.')).toBe(false);
    expect(dogOf('Нет')).toBe(false);
    expect(dogOf('はい')).toBe(true);
  });
});

describe('finding params', () => {
  it('a finding carries no placeholder text from a missing zone rule', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const r = await check(makeHost());
      for (const f of r.findings) expect(JSON.stringify(f.params), f.key).not.toMatch(/undefined/);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('the 0.6.6 audit: the sheet is read strictly', () => {
  const sheet = require('../server/lib/place-sheet.js');
  const rules = require('../server/lib/rules.js');

  it('a duration: a range gives its lower end, a clock time or 3 min is none', () => {
    expect(sheet.minutesOf('2-3 h')).toBe(120);
    expect(sheet.minutesOf('45 min – 1 h')).toBe(45);
    expect(sheet.minutesOf('10:30')).toBeNull();
    expect(sheet.minutesOf('3 min')).toBeNull();
    expect(sheet.minutesOf('2h30')).toBe(150);
  });

  it('a window must open the value; several windows all count', () => {
    expect(rules.windowsIn('self check-in, code sent 1-2 days before')).toEqual([]);
    expect(rules.windowsIn('par la D12 – 3 km après le village')).toEqual([]);
    expect(rules.windowsIn('8h-12h / 14h-20h')).toEqual([[480, 720], [840, 1200]]);
    expect(rules.windowsIn('14 h - 16 h 30')).toEqual([[840, 990]]);
  });

  it('the answer is the first clause', () => {
    expect(sheet.dogOf('allowed on a leash, not allowed in the pool area')).toBe(true);
    expect(sheet.dogOf('willkommen, im Restaurant verboten')).toBe(true);
    expect(sheet.dogOf('non, sauf si accord préalable')).toBe(false);
  });

  it('in the check: no window, refusal or overload invented from such text', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const trip = build();
      const camp = trip.places.find((p) => p.id === 13);
      camp.notes = 'Check-in : self check-in, code sent 1-2 days before\nDogs : allowed on a leash, not allowed in the pool area';
      trip.days[0].assignments.find((a) => a.id === 1005).place.notes = camp.notes;
      const r = await check(makeHost({ trip, userSettings: { language: 'en', timezone: 'Europe/Rome', dog: true } }));
      expect(keys(r, 'welcome_window').filter((f) => f.dayNumber === 1)).toEqual([]);
      expect(keys(r, 'dog_refused').filter((f) => f.dayNumber === 1)).toEqual([]);
      camp.notes = 'Arrival : 8h-12h / 14h-20h';
      trip.days[0].assignments.find((a) => a.id === 1005).place.notes = camp.notes;
      trip.days[0].assignments.find((a) => a.id === 1005).place.place_time = '17:00';
      expect(keys(await check(makeHost({ trip })), 'welcome_window').filter((f) => f.dayNumber === 1)).toEqual([]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('a too-short duration in one sheet does not stop the fill of the trip', async () => {
    const fillLib = require('../server/lib/amenity-fill.js');
    vi.stubGlobal('fetch', stubFetch());
    try {
      const trip = build();
      trip.places.find((p) => p.id === 14).notes = 'Time: 3 min';
      const h = makeHost({ trip });
      await pi.migrate(h.ctx); await fillLib.migrate(h.ctx);
      await expect(fillLib.fill(h.ctx, 1, { park4night: false })).resolves.toBeTruthy();
    } finally { vi.unstubAllGlobals(); }
  });

  it('the planner chip says why a place is ruled out', async () => {
    const trip = build();
    trip.places.find((p) => p.id === 13).notes = 'Dogs : not allowed';
    const cols = await makeHost({ trip, userSettings: { language: 'en', dog: true } }).run(plugin).hook('tableContributor', 'getContributions', 'places', 1);
    expect(cols.find((x) => x.entityId === 13 && x.id === 'vanlife-am-check').value).toBe('Notes: ✗ dog — to verify');
  });
});

describe('the 0.6.7 audit', () => {
  const sheet = require('../server/lib/place-sheet.js');
  const rules = require('../server/lib/rules.js');
  const { parseVisit } = require('../server/lib/visit.js');

  it('a negated approval is a refusal; the answer is read at the start only', () => {
    expect(sheet.dogOf('non autorisés')).toBe(false);
    expect(sheet.dogOf('not accepted')).toBe(false);
    expect(sheet.dogOf('nicht willkommen')).toBe(false);
    expect(sheet.dogOf('interdits')).toBe(false);
    // read at the start: a no (from the notes it is only a point to verify, see check.js)
    expect(sheet.dogOf('not allowed in the pool area')).toBe(false);
    expect(sheet.dogOf('Oui, pas de problème')).toBe(true);
    expect(sheet.dogOf('pas de problème')).toBe(true);
    expect(sheet.dogOf('acceptés et ne doivent pas rester seuls')).toBe(true);
    expect(sheet.dogOf('non admis dans le camping')).toBe(false);
    expect(sheet.dogOf('non précisé')).toBeNull();
    expect(sheet.dogOf('admis')).toBe(true);
  });

  it('a check-in window on a later labelled line counts', () => {
    expect(rules.welcomeWindows('Arrivée : par la D12, chemin de terre\nCheck-in : 15h-20h')).toEqual([[900, 1200]]);
  });

  it('both duration readers read a range the same way', () => {
    expect(sheet.minutesOf('1h30-2h')).toBe(90);
    expect(sheet.minutesOf('30-45 min')).toBe(30);
    expect(parseVisit('Visite guidée 30-45 min').min).toBe(30);
    expect(parseVisit('Visite 1h30-2h').min).toBe(90);
  });

  it('the schedule waits for the check-in window rather than proposing a blocked arrival', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const trip = build();
      trip.places.find((p) => p.id === 18).notes = 'Arrivée : 17h-20h';
      const r = await call(makeHost({ trip, userSettings: { language: 'en', timezone: 'Europe/Rome', sunset_margin_min: 30 } }), 'vanlife_day', { tripId: 1, action: 'schedule', dayNumber: 3 });
      expect(r.night.arrival).toBe('17:00');
      expect(r.coreCalls.find((c) => c.args.assignmentId === 3002).args.place_time).toBe('17:00');
    } finally { vi.unstubAllGlobals(); }
  });

  it('the record\'s answer wins over the notes, everywhere', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const trip = build();
      trip.places.find((p) => p.id === 13).notes = 'Chiens : non';
      const h = makeHost({ trip, userSettings: { language: 'en', timezone: 'Europe/Rome', dog: true }, queryResults: { [pi.INDEX_SQL]: [{ place_id: 13 }] } });
      expect(keys(await check(h), 'sheet_refusal').filter((f) => f.dayNumber === 1)).toHaveLength(1);
      expect(keys(await check(h), 'dog_refused').filter((f) => f.dayNumber === 1)).toEqual([]); // the notes alone never block
      await h.ctx.meta.set('place', 13, pi.META_KEY, pi.merge(null, { dog: 'yes' }));
      // the record says yes, the notes no: nothing blocks, and the disagreement is a point to verify
      expect(keys(await check(h), 'dog_refused').filter((f) => f.dayNumber === 1)).toEqual([]);
      expect(keys(await check(h), 'sheet_refusal').filter((f) => f.dayNumber === 1 && f.level === 'verify')).toHaveLength(1);
      const yes = JSON.parse((await h.run(plugin).route({ method: 'POST', path: '/amenities' }, { body: { tripId: 1, placeId: 13 } })).body);
      expect(yes.refused).toBe(false); // the panel follows the record too
      await h.ctx.meta.set('place', 13, pi.META_KEY, pi.merge(null, { dog: 'no' }));
      expect(keys(await check(h), 'dog_refused').filter((f) => f.dayNumber === 1)).toHaveLength(1); // the record's no blocks
      const w = JSON.parse((await h.run(plugin).route({ method: 'POST', path: '/amenities' }, { body: { tripId: 1, placeId: 13 } })).body);
      expect(w.refused).toBe(true); // the record's no
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('the 0.6.8 audit', () => {
  it('an open source never fills over the dog answer the notes give', async () => {
    const fillLib = require('../server/lib/amenity-fill.js');
    // A campsite mapped on the place itself, which OSM says takes dogs.
    const base = stubFetch();
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const res = await base(url, init);
      if (!String(url).includes('overpass')) return res;
      const body = await res.json();
      body.elements = [...(body.elements || []), { type: 'node', id: 99, lat: 46.53, lon: 12.13, tags: { tourism: 'camp_site', name: 'Camping Example', dog: 'yes', drinking_water: 'yes' } }];
      return { ok: true, status: 200, json: async () => body };
    }));
    try {
      const trip = build();
      trip.places.find((p) => p.id === 13).notes = 'Chiens : non';
      const h = makeHost({ trip });
      await pi.migrate(h.ctx); await fillLib.migrate(h.ctx);
      await fillLib.fill(h.ctx, 1, { park4night: false, placeIds: [13] });
      const rec = await pi.get(h.ctx, 13);
      expect(rec.amenities.water).toBe('yes'); // the fill did run on this place
      expect(rec.amenities.dog).toBe('unknown'); // but left the dog to the notes' "non"
    } finally { vi.unstubAllGlobals(); }
  });

  it('the schedule applies the check-in window on the stay\'s first evening only', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const trip = build();
      trip.accommodations = trip.accommodations.filter((a) => a.id !== 2);
      trip.accommodations[0].end_day_id = 103;
      trip.days[1].assignments = trip.days[1].assignments.filter((a) => a.id !== 2004);
      trip.reservations = trip.reservations.filter((r) => r.id !== 502);
      trip.places.find((p) => p.id === 13).notes = 'Check-in : 8h-10h';
      const r = await call(makeHost({ trip }), 'vanlife_day', { tripId: 1, action: 'schedule', dayNumber: 2 });
      expect(r.conflicts.filter((c) => /check-in/.test(c.reason))).toEqual([]);
      expect(r.night.waitMinutes).toBeUndefined();
    } finally { vi.unstubAllGlobals(); }
  });

  it('a range in a sheet line keeps its upper end, as in free notes', () => {
    const sheet = require('../server/lib/place-sheet.js');
    expect(sheet.factsOf({ notes: 'Durée : 1h30-2h' })).toMatchObject({ visitMinutes: 90, visitMax: 120 });
  });
});

describe('the 0.6.9 audit: free notes never block', () => {
  it('a tent ban or a minimum stay quoted from notes is a point to verify, quoted whole', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const trip = build();
      const camp = trip.places.find((p) => p.id === 13);
      camp.notes = 'Règlement : camping interdit sur le parking du lac\n2 nuits minimum en juillet-août';
      trip.days[0].assignments.find((a) => a.id === 1005).place.notes = camp.notes;
      const r = await check(makeHost({ trip }));
      const ban = keys(r, 'tent_banned').find((f) => f.dayNumber === 1);
      expect(ban.level).toBe('verify');
      expect(ban.params.quote).toBe('reglement : camping interdit sur le parking du lac');
      expect(keys(r, 'min_nights').find((f) => f.dayNumber === 1).level).toBe('verify');
      expect(r.findings.filter((f) => f.level === 'blocking' && f.dayNumber === 1 && /tent|min_nights|dog/.test(f.key))).toEqual([]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('the panel shows a no from the notes as amber, a no from the record as red', async () => {
    const trip = build();
    trip.places.find((p) => p.id === 13).notes = 'Chiens : non';
    const h = makeHost({ trip, userSettings: { language: 'en', dog: true } });
    const w = JSON.parse((await h.run(plugin).route({ method: 'POST', path: '/amenities' }, { body: { tripId: 1, placeId: 13 } })).body);
    expect(w).toMatchObject({ refused: false, refusedText: null, notesRefusedText: 'Notes: ✗ dog — to verify' });
  });
});

describe('the 0.6.10 audit', () => {
  const rules = require('../server/lib/rules.js');
  it('a check-in label must open its line', () => {
    expect(rules.welcomeWindows("Pas d'arrivée : 12h-14h (pause déjeuner)")).toEqual([]);
    expect(rules.welcomeWindows('Late arrival: 22h-23h, 10 € extra')).toEqual([]);
    expect(rules.welcomeWindows('Notes\n• Arrivée : 15h-20h')).toEqual([[900, 1200]]);
  });

  it('a no from the notes colours the sheet row amber, dog and tent alike', () => {
    const sheet = require('../server/lib/place-sheet.js');
    const v = sheet.view(sheet.sheetOf({ name: 'Example', notes: 'Chiens : non\nTente de toit : non' }, { night: true }), 'fr');
    const rows = v.sections.flatMap((s) => s.rows);
    expect(rows.find((r) => r.field === 'dog').tone).toBe('warn');
    expect(rows.find((r) => r.field === 'rooftop_tent').tone).toBe('warn');
  });

  it('the schedule and the check judge a night\'s opening hours alike', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const trip = build();
      trip.places.find((p) => p.id === 13).notes = 'Accueil — lundi : 8h00-12h00';
      trip.days[0].assignments.find((a) => a.id === 1005).place.notes = 'Accueil — lundi : 8h00-12h00';
      const h = makeHost({ trip });
      const checkSays = keys(await check(h), 'outside_hours').some((f) => f.dayNumber === 1);
      const r = await call(h, 'vanlife_day', { tripId: 1, action: 'schedule', dayNumber: 1 });
      const scheduleSays = r.conflicts.some((c) => /opening hours/.test(c.reason) && c.name === 'Camping Example');
      expect(checkSays).toBe(true);
      expect(scheduleSays).toBe(checkSays);
    } finally { vi.unstubAllGlobals(); }
  });

  it('budget lines use TREK\'s fixed category keys', async () => {
    const { tripBudget } = require('../server/lib/budget.js');
    vi.stubGlobal('fetch', stubFetch());
    try {
      const h = makeHost({ userSettings: { language: 'ja', timezone: 'Europe/Rome' } });
      const settings = await readSettings(h.ctx);
      const r = await tripBudget(h.ctx, await loadTrip(h.ctx, 1, settings), {}, { settings, deadline: deadline(10000) });
      expect(new Set(r.coreCalls.map((c) => c.args.category))).toEqual(new Set(['fuel']));
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('the 0.6.11 audit', () => {
  const rules = require('../server/lib/rules.js');
  it('hours from the notes: every range counts, a neighbour\'s are info, outside is only to verify', () => {
    expect(rules.closures('Accueil — lundi : 8h00-12h00 / 14h00-19h00', 1, 1020, 1020, { isNight: true })).toEqual([]);
    expect(rules.closures('Pizzeria — lundi : 19h00-22h00', 1, 1020, 1020, { isNight: true })[0]).toMatchObject({ key: 'closure_neighbour', level: 'info' });
    expect(rules.closures('Accueil — lundi : 8h00-12h00', 1, 1020, 1020, { isNight: true })[0]).toMatchObject({ key: 'outside_hours', level: 'verify' });
  });

  it('an aire guessed from the name only is to verify; filed as one, it blocks', () => {
    expect(rules.nightLegality({ categoryName: '', placeName: 'Agriturismo Example — area camper', vehicle: 'rooftop_tent' }).level).toBe('verify');
    expect(rules.nightLegality({ categoryName: 'Night – Motorhome area', placeName: 'X', vehicle: 'rooftop_tent' }).level).toBe('blocking');
  });

  it('the check and the schedule read a night\'s hours from the same text, on its first evening', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const trip = build();
      trip.accommodations[0].notes = 'Accueil — lundi : 8h00-12h00';
      const h = makeHost({ trip });
      const checkSays = keys(await check(h), 'outside_hours').some((f) => f.dayNumber === 1);
      const r = await call(h, 'vanlife_day', { tripId: 1, action: 'schedule', dayNumber: 1 });
      expect(checkSays).toBe(true);
      expect(r.conflicts.some((c) => /opening hours/.test(c.reason) && c.level === 'verify')).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });

  it('a tent ban written as a free sentence shows on the amber chip too', async () => {
    const trip = build();
    trip.places.find((p) => p.id === 13).notes = 'No tents.';
    const w = JSON.parse((await makeHost({ trip }).run(plugin).route({ method: 'POST', path: '/amenities' }, { body: { tripId: 1, placeId: 13 } })).body);
    expect(w.notesRefusedText).toBe('Notes: ✗ roof tent — to verify');
  });

  it('durations speak the reader\'s language', () => {
    const { durationText } = require('../server/lib/util.js');
    expect(durationText(210, 'ru')).toBe('3 ч 30');
    expect(durationText(45, 'ja')).toBe('45分');
    expect(durationText(210, 'en')).toBe('3 h 30');
    expect(pi.visitText(pi.merge(null, { visit_min_minutes: 90 }), 'ru')).toBe('1 ч 30');
  });
});

describe('the 0.6.12 audit', () => {
  const rules = require('../server/lib/rules.js');
  const withOsm = (extra) => {
    const base = stubFetch();
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const res = await base(url, init);
      if (!String(url).includes('overpass') || !/camp_site/.test(decodeURIComponent(String(init.body)))) return res;
      const body = await res.json();
      body.elements = [...body.elements, ...extra];
      return { ok: true, status: 200, json: async () => body };
    }));
  };

  it('the night search keeps a place whose free note bans tents, to verify, and never for a van', async () => {
    withOsm([{ type: 'node', id: 77, lat: 46.6, lon: 12.16, tags: { tourism: 'camp_site', name: 'Camping Alpha Example', charge: '12 EUR', note: 'No tents.' } },
      { type: 'node', id: 78, lat: 46.6, lon: 12.17, tags: { tourism: 'caravan_site', name: 'Area Sosta Beta Example', charge: '10 EUR', note: 'no tents' } }]);
    try {
      const tent = await call(makeHost(), 'vanlife_find_nights', { tripId: 1, dayNumber: 1 });
      const a = tent.candidates.find((c) => c.name === 'Camping Alpha Example');
      expect(a.blocked).toEqual([]);
      expect(a.toVerify.some((x) => /OSM note/.test(x))).toBe(true);
      const van = await call(makeHost({ userSettings: { language: 'en', timezone: 'Europe/Rome', vehicle: 'campervan' } }), 'vanlife_find_nights', { tripId: 1, dayNumber: 1 });
      expect(van.candidates.some((c) => c.name === 'Area Sosta Beta Example')).toBe(true);
      expect(van.candidates.find((c) => c.name === 'Camping Alpha Example').toVerify.some((x) => /OSM note/.test(x))).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });

  it('the hours message gives every range of the day', () => {
    const { hhmm } = require('../server/lib/util.js');
    const [f] = rules.closures('Accueil — lundi : 8h00-12h00 / 17h30-19h00', 1, 1020, 1020, { isNight: true });
    expect(rules.rangesParams(f.params.ranges, hhmm)).toEqual({ open: '08:00–12:00 / 17:30', close: '19:00' });
  });

  it('a tent ban in a stay\'s notes shows on the chip as the check reads it', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const trip = build();
      trip.accommodations[0].notes = 'No tents.';
      const h = makeHost({ trip });
      expect(keys(await check(h), 'tent_banned').some((f) => f.dayNumber === 1)).toBe(true);
      const w = JSON.parse((await h.run(plugin).route({ method: 'POST', path: '/amenities' }, { body: { tripId: 1, placeId: 13 } })).body);
      expect(w.notesRefusedText).toBe('Notes: ✗ roof tent — to verify');
    } finally { vi.unstubAllGlobals(); }
  });

  it('a route place\'s legs are written in the reader\'s units', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const trip = build();
      const h = makeHost({ trip, userSettings: { language: 'ru', timezone: 'Europe/Rome' } });
      const create = vi.spyOn(h.ctx.places, 'create');
      await call(h, 'vanlife_day', { tripId: 1, action: 'routes', dayNumbers: [3], apply: true });
      const notes = create.mock.calls.map((c) => c[1].notes).find(Boolean);
      expect(notes).toMatch(/км \//);
      expect(notes).not.toMatch(/\d km \//);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('the 0.6.13 audit', () => {
  it('a check-in window from the notes is a point to verify in the check, the schedule and the plan', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const trip = build();
      trip.places.find((p) => p.id === 13).notes = 'Arrivée : 8h-10h'; // the camp is reached at 18:40
      const h = makeHost({ trip });
      expect(keys(await check(h), 'welcome_window').find((f) => f.dayNumber === 1).level).toBe('verify');
      const r = await call(h, 'vanlife_day', { tripId: 1, action: 'schedule', dayNumber: 1 });
      expect(r.conflicts.filter((c) => /check-in/.test(c.reason)).every((c) => c.level === 'verify')).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });

  it('a source line is never taken for the host\'s contact', () => {
    const fillLib = require('../server/lib/amenity-fill.js');
    const txt = 'Sources :\n• https://www.tourism.example.com/camping-list\nSite : https://camp.example.com';
    const kept = fillLib.hostText(txt, new Set(['sources']));
    expect(kept).not.toMatch(/tourism\.example/);
    expect(kept).toMatch(/camp\.example\.com/);
    expect(fillLib.ownContacts({ notes: 'Sources : https://www.tourism.example.com/x' })).toEqual([]);
  });

  it('a check-in or reception span is not a time on site', () => {
    const { parseVisit } = require('../server/lib/visit.js');
    expect(parseVisit('Arrivée de 15h à 20h.')).toBeNull();
    expect(parseVisit('Accueil de 9h à 17h. Fermé le lundi.')).toBeNull();
    expect(parseVisit('Visite guidée de 10h à 12h.')).toBeNull(); // a span of the day is a time of day (0.6.19)
  });

  it('a free-text tent ban shows on the chip even when a sheet line says yes', async () => {
    const trip = build();
    trip.places.find((p) => p.id === 13).notes = 'Rooftop tent: yes\nNo tents on the lakeside meadow.';
    const w = JSON.parse((await makeHost({ trip }).run(plugin).route({ method: 'POST', path: '/amenities' }, { body: { tripId: 1, placeId: 13 } })).body);
    expect(w.notesRefusedText).toBe('Notes: ✗ roof tent — to verify');
  });

  it('a place\'s currency can be cleared back to the trip\'s', async () => {
    const trip = build();
    const h = makeHost({ trip });
    await call(h, 'vanlife_place', { tripId: 1, placeId: 13, set: { currency: 'CHF' } });
    expect(trip.places.find((p) => p.id === 13).currency).toBe('CHF');
    await call(h, 'vanlife_place', { tripId: 1, placeId: 13, clear_fields: ['currency'] });
    expect(trip.places.find((p) => p.id === 13).currency).toBeNull();
  });
});

describe('the 0.6.14 audit', () => {
  it('sources listed with any bullet are never the host\'s contact', () => {
    const fillLib = require('../server/lib/amenity-fill.js');
    for (const b of ['–', '1.', '●']) {
      expect(fillLib.ownContacts({ notes: `Sources :\n${b} https://www.tourism.example.com/camping-list` }), b).toEqual([]);
    }
  });

  it('an hour opening a span is not a time on site', () => {
    const { parseVisit } = require('../server/lib/visit.js');
    expect(parseVisit('Ouvert de 9h à 12h, visite libre.')).toBeNull();
    expect(parseVisit('Accueil de 8h à 10h, visite de la ferme possible.')).toBeNull();
    expect(parseVisit('Lake walk, 2 h.')).toMatchObject({ min: 120 });
  });

  it('two campsites sharing a name stay two candidates; a tagged campsite named "Ferme" is a campsite', async () => {
    const { kindOf } = require('../server/lib/nights.js');
    expect(kindOf({ tourism: 'camp_site', name: 'Camping La Ferme du Lac' })).toBe('campsite');
    expect(kindOf({ tourism: 'guest_house', name: 'Ferme Example' })).toBe('farm');
    const base = stubFetch();
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const res = await base(url, init);
      if (!String(url).includes('overpass') || !/camp_site/.test(decodeURIComponent(String(init.body)))) return res;
      const body = await res.json();
      body.elements = [{ type: 'node', id: 91, lat: 46.6, lon: 12.16, tags: { tourism: 'camp_site', name: 'Camping Sole', charge: '40 EUR' } },
        { type: 'node', id: 92, lat: 46.6, lon: 12.34, tags: { tourism: 'camp_site', name: 'Camping Sole', charge: '18 EUR' } },
        { type: 'way', id: 93, lat: 46.6005, lon: 12.1605, tags: { tourism: 'camp_site', name: 'Camping Sole', charge: '40 EUR' } }];
      return { ok: true, status: 200, json: async () => body };
    }));
    try {
      const r = await call(makeHost(), 'vanlife_find_nights', { tripId: 1, dayNumber: 1 });
      expect(r.candidates.filter((c) => c.name === 'Camping Sole').map((c) => c.price).sort()).toEqual([18, 40]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('metres and kilometres speak the reader\'s language', () => {
    const sheet = require('../server/lib/place-sheet.js');
    const v = sheet.view(sheet.sheetOf({ name: 'Example', categoryName: 'Hike', notes: 'Distance : 10.9 km\nD+ : 770 m' }), 'ru');
    const figs = v.sections.flatMap((s) => s.rows).filter((r) => r.figure).map((r) => r.figure);
    expect(figs).toEqual(expect.arrayContaining(['10,9 км', '+770 м']));
    expect(pi.refusalText(pi.merge(null, { max_height_m: 2.1 }), { vehicle_height_m: 2.5, vehicle_length_m: 5, vehicle_weight_t: 2 }, 'ru')).toBe('↕ 2,1 м');
  });
});

describe('the 0.6.15 audit', () => {
  it('an hour after a clock word is not a time on site', () => {
    const { parseVisit } = require('../server/lib/visit.js');
    for (const s of ["Accueil jusqu'à 11h, visite de la ferme possible.", 'Accueil à partir de 9h, visite de la ferme.', 'Visite dès 10h.', 'Open until 11h, guided visit.', 'Visits from 10h.', 'Guided visit at 11h.']) {
      expect(parseVisit(s), s).toBeNull();
    }
    expect(parseVisit('Visite guidée, 1 h 30.')).toMatchObject({ min: 90 });
  });

  it('the check and the schedule share the latest arrival to the minute', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const trip = build();
      trip.days[0].assignments.find((a) => a.id === 1005).place.place_time = '17:31';
      const h = makeHost({ trip, userSettings: { language: 'en', timezone: 'Europe/Rome' } });
      const r = await check(h);
      expect(keys(r, 'night_late').some((f) => f.dayNumber === 1)).toBe(false); // 17:31 is the shown limit
      const s = await call(h, 'vanlife_day', { tripId: 1, action: 'schedule', dayNumber: 1 });
      expect(s.night.latestArrival).toBe('17:31');
    } finally { vi.unstubAllGlobals(); }
  });

  it('a link, review or photo label is never the host\'s contact', () => {
    const fillLib = require('../server/lib/amenity-fill.js');
    for (const l of ['Liens utiles', 'Avis Google', 'Source officielle', 'Photos du lieu', 'Carte IGN']) {
      expect(fillLib.ownContacts({ notes: `${l} :\n• https://www.tourism.example.com/list` }), l).toEqual([]);
    }
  });

  it('an arrival written in the notes is a point to verify, said as the notes\'', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const trip = build();
      trip.accommodations[0].notes = 'Arrivée prévue 16h00';
      const r = await check(makeHost({ trip }));
      expect(keys(r, 'checkin_notes').find((f) => f.dayNumber === 1)).toMatchObject({ level: 'verify' });
      expect(keys(r, 'checkin_mismatch').some((f) => f.dayNumber === 1)).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });

  it('the host message writes sizes in the language\'s unit; the radius spec says its floor', () => {
    const hm = require('../server/lib/host-message.js');
    const { TOOL_SPECS } = require('../server/lib/tool-specs.js');
    expect(TOOL_SPECS.find((t) => t.name === 'vanlife_find_nights').inputSchema.properties.radius_km.minimum).toBe(5);
    expect(Object.keys(hm.TEXT)).toContain('ru');
  });

  it('the host message\'s vehicle size is in the user\'s unit', async () => {
    const m = await call(makeHost({ userSettings: { language: 'ru', timezone: 'Europe/Rome' } }), 'vanlife_host_message', { tripId: 1, placeId: 13, dayNumber: 1 });
    expect(m.text).toMatch(/\d м × \d/);
  });
});

describe('the 0.6.16 audit: one clock-hour test for both duration readers', () => {
  const sheet = require('../server/lib/place-sheet.js');
  const { parseVisit } = require('../server/lib/visit.js');
  it('the sheet never reads a clock time as a length, and reads spans and ranges as parseVisit does', () => {
    expect(sheet.minutesOf("jusqu'à 11h")).toBeNull();
    expect(sheet.minutesOf('9h-12h')).toBeNull();
    expect(sheet.minutesOf('de 10h à 12h30')).toBeNull(); // a span of the day, even under the label (0.6.19)
    expect(sheet.minutesOf('1h30-2h')).toBe(90);
    expect(sheet.minutesOf('45 min – 1 h')).toBe(45);
  });
  it('more clock words: avant, après, entre, between, vor, prima delle, by', () => {
    for (const s of ['Visite libre avant 11h.', 'Visite possible après 10h.', 'Visite entre 9h et 11h.', 'Visit between 9h and 11h.', 'Besuch vor 11h.', 'Visita prima delle 11h.', 'Visit by 11h.']) expect(parseVisit(s), s).toBeNull();
  });
  it('a bulleted or pictogram-led source label never gives the host\'s contact', () => {
    const fillLib = require('../server/lib/amenity-fill.js');
    for (const n of ['- Sources : https://www.t.example.com/x', '• Liens utiles : https://www.t.example.com/x', '1. Avis Google : https://www.t.example.com/x', '📎 Sources :\n• https://www.t.example.com/x']) {
      expect(fillLib.ownContacts({ notes: n }), n).toEqual([]);
    }
  });
  it('find_nights in trip mode gives the latest arrival at tonight\'s stay, as the check', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const h = makeHost();
      const n = await call(h, 'vanlife_find_nights', { tripId: 1, dayNumber: 2 });
      const c = await call(h, 'vanlife_check_trip', { tripId: 1, sun: true, levels: ['info'] });
      expect(n.sun.latestArrival).toBe(c.sun.days.find((d) => d.day === 2).latestArrival);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('the 0.6.17 audit: two rules instead of guessing layouts', () => {
  it('a web address from the notes is the host\'s only on a Site / Website / Contact line', () => {
    const fillLib = require('../server/lib/amenity-fill.js');
    for (const n of ['**Sources :** https://www.t.example.com/x', 'Sources\n• https://www.t.example.com/x', '## Sources\n- https://www.t.example.com/x', 'Accès : route D12\nSources :\n  https://www.t.example.com/x', '🔗 **Liens utiles :** https://www.t.example.com/x']) {
      expect(fillLib.ownContacts({ notes: n }), n).toEqual([]);
    }
    expect(fillLib.ownContacts({ notes: 'Site : https://camp.example.com' })[0].values.website).toBe('https://camp.example.com');
    expect(fillLib.ownContacts({ notes: 'Réservation : info@camp.example.com' })[0].values.email).toBe('info@camp.example.com');
  });

  it('a day span or a clock word never gives a time on site, in either reader', () => {
    const { parseVisit } = require('../server/lib/visit.js');
    const sheet = require('../server/lib/place-sheet.js');
    for (const s of ['Durée : 9h-12h', 'Visit 9h-11h', 'Rando : départ 8h, retour 12h', 'Guided visit: starts 10h', 'Visite : rendez-vous 9h', 'Visite le matin, 9h.']) {
      expect(parseVisit(s), s).toBeNull();
    }
    expect(sheet.minutesOf('9h-12h')).toBeNull();
    expect(parseVisit('Visite 1h30-2h')).toMatchObject({ min: 90, max: 120 });
  });
});

describe('the 0.6.18 audit: one reader of a length for the whole plugin', () => {
  const { parseVisit } = require('../server/lib/visit.js');
  const sheet = require('../server/lib/place-sheet.js');
  const pair = (s) => { const r = parseVisit(`Durée : ${s}`); return [sheet.minutesOf(s), sheet.factsOf({ notes: `Durée : ${s}` }).visitMax, r && r.min, r && r.max]; };
  it('both readers read every phrase the same, a range whatever its joint', () => {
    expect(pair('entre 2h et 3h')).toEqual([120, 180, 120, 180]);
    expect(pair('de 2h à 3h')).toEqual([120, 180, 120, 180]);
    expect(pair('de 1h30 à 2h')).toEqual([90, 120, 90, 120]);
    expect(pair('2-3 h')).toEqual([120, 180, 120, 180]);
    expect(pair('2 h (ouvert 9h-18h)')).toEqual([120, null, 120, null]);
    expect(pair('9h-12h')).toEqual([null, null, null, null]);
    expect(pair('de 9h à 12h')).toEqual([null, null, null, null]);
  });
  it('a span of the day is never a time on site in free text', () => {
    expect(parseVisit('Visite guidée de 9h à 12h.')).toBeNull();
  });
  it('the fill never overwrites a typed maximum, and a lone maximum is what the day counts', async () => {
    const { stopMinutes } = require('../server/lib/visit.js');
    expect(stopMinutes({ notes: 'Durée : 1 h' }, { visit_min_minutes: null, visit_max_minutes: 180 })).toBe(180);
    const trip = build();
    trip.places.find((p) => p.id === 13).notes = 'Durée : 1 h';
    const h = makeHost({ trip });
    await call(h, 'vanlife_place', { tripId: 1, placeId: 13, set: { visit_max_minutes: 180 } });
    vi.stubGlobal('fetch', stubFetch());
    try { await call(h, 'vanlife_place', { tripId: 1, fill: true }); } finally { vi.unstubAllGlobals(); }
    const rec = JSON.stringify(await call(h, 'vanlife_place', { tripId: 1, placeId: 13 }));
    expect(rec).toContain('"visit_max_minutes":180');
    expect(rec).toContain('"visit_min_minutes":null');
  });
});

describe('the 0.6.19 audit', () => {
  const { parseVisit, recordedMinutes } = require('../server/lib/visit.js');
  const sheet = require('../server/lib/place-sheet.js');
  it('three-digit minutes are read by both readers', () => {
    for (const [s, v] of [['120 min', 120], ['150 min', 150], ['180 min', 180]]) {
      expect(sheet.minutesOf(s), s).toBe(v);
      expect(parseVisit(`Durée : ${s}`).min, s).toBe(v);
    }
  });
  it('a pair of hours after a clock word is times of day; a pair opener is its joint', () => {
    for (const s of ['Randonnée, départ 6h-7h.', 'Visite guidée, rendez-vous 5h-6h30.', 'Visite guidée, avant 5h-6h.']) expect(parseVisit(s), s).toBeNull();
    expect(parseVisit('Durée : entre 2h et 3h')).toMatchObject({ min: 120, max: 180 });
  });
  it('the place tool shows a lone typed maximum, as the day counts it', async () => {
    expect(recordedMinutes({ visit_min_minutes: null, visit_max_minutes: 180 })).toBe(180);
    const trip = build();
    trip.places.find((p) => p.id === 13).notes = 'Durée : 1 h';
    const h = makeHost({ trip });
    await call(h, 'vanlife_place', { tripId: 1, placeId: 13, set: { visit_max_minutes: 180 } });
    const out = await call(h, 'vanlife_place', { tripId: 1, placeId: 13 });
    expect(JSON.stringify(out)).toContain('"duration":{"minutes":180');
  });
});

describe('the 0.6.20 audit', () => {
  const { parseVisit } = require('../server/lib/visit.js');
  it('a clock word, then an opener: the hours are still times of day', () => {
    for (const s of ['Randonnée : départ de 9h.', 'Randonnée : départ entre 6h et 7h.', 'Randonnée : rendez-vous de 6h à 7h.', 'Hike: meeting point between 5h and 6h.']) expect(parseVisit(s), s).toBeNull();
    expect(parseVisit('Durée : entre 2h et 3h')).toMatchObject({ min: 120, max: 180 });
  });
  it('the quote keeps the notes as written', () => {
    expect(parseVisit('Randonnée très prisée, 2 h 30 à pied.').quote).toBe('Randonnée très prisée, 2 h 30 à pied.');
  });
});

describe('the 0.6.21 audit: an imported hike\'s summary line', () => {
  const sheet = require('../server/lib/place-sheet.js');
  it('a labelled line wins over the summary line, wherever it stands', () => {
    const f = sheet.factsOf({ categoryName: 'See – Hike', notes: '10.93 km · +770 m · 4 h 10\nDurée : 3 h' });
    expect(f.visitMinutes).toBe(180);
    const s = sheet.sheetOf({ categoryName: 'See – Hike', notes: '10.93 km · +770 m · 4 h 10\nDistance : 12' }).fields;
    expect(JSON.stringify(s.distance_km)).toMatch(/\b12\b/);
    expect(JSON.stringify(s.distance_km)).not.toMatch(/10[.,]93/);
    expect(sheet.factsOf({ categoryName: 'See – Hike', notes: '10.93 km · +770 m · 4 h 10' }).visitMinutes).toBe(250);
  });
  it('the fill reads the summary of a hike filed only by its category', async () => {
    const trip = build();
    const p = trip.places.find((x) => x.id === 10);
    Object.assign(p, { category_id: 9, notes: '10.93 km · +770 m · 4 h 10' });
    delete p.category_name; delete p.category;
    const h = makeHost({ trip, categories: [{ id: 4, name: 'See – Lake' }, { id: 9, name: 'See – Hike' }] });
    vi.stubGlobal('fetch', stubFetch());
    try { await call(h, 'vanlife_place', { tripId: 1, placeIds: [10], fill: true }); } finally { vi.unstubAllGlobals(); }
    expect(JSON.stringify(await call(h, 'vanlife_place', { tripId: 1, placeId: 10 }))).toContain('"visit_min_minutes":250');
  });
});

describe('the 0.6.22 audit: what the fill copied from the notes follows the notes', () => {
  const fillIt = async (h, placeId) => {
    vi.stubGlobal('fetch', stubFetch());
    try { await call(h, 'vanlife_place', { tripId: 1, placeIds: [placeId], placeId, fill: true }); } finally { vi.unstubAllGlobals(); }
  };
  const read = async (h, placeId) => JSON.stringify(await call(h, 'vanlife_place', { tripId: 1, placeId }));
  it('a copied time on site follows a sheet_set, and the answer matches the read', async () => {
    const trip = build();
    trip.places.find((x) => x.id === 10).notes = 'Lake walk, 4 h.';
    const h = makeHost({ trip });
    await fillIt(h, 10);
    expect(await read(h, 10)).toContain('"visit_min_minutes":240');
    const ans = await call(h, 'vanlife_place', { tripId: 1, placeId: 10, sheet_set: { duration: '3 h' } });
    expect(ans.sheet.fields.duration.minutes).toBe(180);
    const r = await read(h, 10);
    expect(r).toContain('"visit_min_minutes":180');
    expect(r).toContain('"duration":{"minutes":180');
  });
  it('a typed time on site never moves', async () => {
    const trip = build();
    const h = makeHost({ trip });
    await call(h, 'vanlife_place', { tripId: 1, placeId: 10, set: { visit_min_minutes: 90 } });
    const ans = await call(h, 'vanlife_place', { tripId: 1, placeId: 10, sheet_set: { duration: '3 h' } });
    expect(await read(h, 10)).toContain('"visit_min_minutes":90');
    expect(ans.sheet.fields.duration.minutes).toBe(90); // the answer shows what the read shows
  });
  it('a copied website follows the Site line, in the record and in TREK', async () => {
    const trip = build();
    const p = trip.places.find((x) => x.id === 13);
    Object.assign(p, { notes: 'Site : https://old-host.example.com', website: null });
    const h = makeHost({ trip });
    await fillIt(h, 13);
    expect(p.website).toBe('https://old-host.example.com');
    await call(h, 'vanlife_place', { tripId: 1, placeId: 13, sheet_set: { website: 'https://new-host.example.com' } });
    const r = await read(h, 13);
    expect(r).toContain('"website":"https://new-host.example.com"');
    expect(r).not.toContain('old-host');
    expect(p.website).toBe('https://new-host.example.com');
  });
});

describe('the 0.6.24 audit: copied contacts and TREK\'s fields follow the notes', () => {
  const fillIt = async (h, placeId) => {
    vi.stubGlobal('fetch', stubFetch());
    try { return await call(h, 'vanlife_place', { tripId: 1, placeIds: [placeId], placeId, fill: true }); } finally { vi.unstubAllGlobals(); }
  };
  it('a contact removed from the notes stays removed, at the next fill too', async () => {
    const trip = build();
    const p = trip.places.find((x) => x.id === 11);
    Object.assign(p, { notes: 'Site : https://old-host.example.com\nContact : +39 0471 111111', website: null, phone: null });
    const h = makeHost({ trip });
    await fillIt(h, 11);
    expect([p.website, p.phone]).toEqual(['https://old-host.example.com', '+390471111111']);
    p.notes = 'Camping au bord du lac.';
    await fillIt(h, 11);
    const r = JSON.stringify(await call(h, 'vanlife_place', { tripId: 1, placeId: 11 }));
    expect(r).not.toContain('old-host');
    expect(r).not.toContain('111111');
    expect([p.website, p.phone]).toEqual([null, null]);
  });
  it('TREK\'s phone field follows a corrected Contact line', async () => {
    const trip = build();
    const p = trip.places.find((x) => x.id === 11);
    Object.assign(p, { notes: 'Contact : +39 0471 111111', website: null, phone: null });
    const h = makeHost({ trip });
    await fillIt(h, 11);
    await call(h, 'vanlife_place', { tripId: 1, placeId: 11, sheet_set: { contact: '+39 0471 222222' } });
    expect(p.phone).toBe('+390471222222');
  });
});

describe('the 0.6.25 audit', () => {
  it('a fill that drops a copied phone on a complete record finds its replacement in the same call', async () => {
    // a night place (0.6.41: only a night is matched to a campsite nearby)
    const trip = build();
    const p = trip.places.find((x) => x.id === 13);
    Object.assign(p, { notes: 'Contact : +39 0471 111111', website: null, phone: null });
    const h = makeHost({ trip });
    const { AMENITIES } = require('../server/lib/place-info.js');
    await call(h, 'vanlife_place', { tripId: 1, placeId: 13, set: Object.fromEntries(Object.keys(AMENITIES).map((k) => [k, 'no'])) });
    const osm = { elements: [{ type: 'node', id: 5, lat: 46.53, lon: 12.13, tags: { tourism: 'camp_site', phone: '+39 0471 999999' } }] };
    const base = stubFetch();
    vi.stubGlobal('fetch', (url, init) => (String(url).includes('overpass') ? Promise.resolve({ ok: true, status: 200, json: async () => osm }) : base(url, init)));
    try {
      await call(h, 'vanlife_place', { tripId: 1, placeIds: [13], placeId: 13, fill: true });
      expect(p.phone).toBe('+390471111111');
      p.notes = 'Musée de la montagne.';
      await call(h, 'vanlife_place', { tripId: 1, placeIds: [13], placeId: 13, fill: true });
      expect(p.phone).toBe('+390471999999');
    } finally { vi.unstubAllGlobals(); }
  });
  it('the sheet_set answer shows TREK\'s fields as resync left them, even when the kind changes in the same call', async () => {
    const trip = build();
    const p = trip.places.find((x) => x.id === 11);
    Object.assign(p, { notes: 'Site : https://old-host.example.com', website: null, phone: null });
    const h = makeHost({ trip });
    vi.stubGlobal('fetch', stubFetch());
    try { await call(h, 'vanlife_place', { tripId: 1, placeIds: [11], placeId: 11, fill: true }); } finally { vi.unstubAllGlobals(); }
    const ans = await call(h, 'vanlife_place', { tripId: 1, placeId: 11, kind: 'village', sheet_set: { website: null } });
    expect(JSON.stringify(ans)).not.toContain('old-host');
  });
});

describe('the 0.6.26 audit', () => {
  it('a free sentence that states a time on site beats a hike\'s summary line', () => {
    const sheet = require('../server/lib/place-sheet.js');
    expect(sheet.factsOf({ categoryName: 'See – Hike', notes: '10.93 km · +770 m · 4 h 10\nThe round trip takes 5 h 30 with the breaks.' }).visitMinutes).toBe(330);
    expect(sheet.factsOf({ categoryName: 'See – Hike', notes: '10.93 km · +770 m · 4 h 10\nNice views.' }).visitMinutes).toBe(250);
  });
  it('the sheet_set answer reads the trip as TREK holds it after the write, on a host that returns copies', async () => {
    const trip = build();
    const p = trip.places.find((x) => x.id === 11);
    Object.assign(p, { notes: 'Site : https://old-host.example.com', website: null, phone: null });
    const h = makeHost({ trip });
    for (const k of ['getPlaces', 'getDays', 'getById', 'getAccommodations', 'getReservations']) {
      const f = h.ctx.trips[k];
      if (f) h.ctx.trips[k] = async (...x) => structuredClone(await f(...x));
    }
    const ans = await call(h, 'vanlife_place', { tripId: 1, placeId: 11, sheet_set: { website: null }, set: { visit_min_minutes: 60 } });
    const read = await call(h, 'vanlife_place', { tripId: 1, placeId: 11 });
    expect(JSON.stringify(ans)).not.toContain('old-host');
    expect(ans.sheet.fields.website || null).toEqual(read.sheet.fields.website || null);
  });
});

describe('the 0.6.27 audit', () => {
  it('a free sentence beats the summary with the minutes the one reader gave, never a re-read quote', () => {
    const sheet = require('../server/lib/place-sheet.js');
    expect(sheet.factsOf({ categoryName: 'See – Hike', notes: '10.93 km · +770 m · 4 h 10\nStart from 8 h; the round trip takes 3 h.' }).visitMinutes).toBe(180);
  });
  it('fill=true says which other changes it did not apply', async () => {
    const h = makeHost();
    vi.stubGlobal('fetch', stubFetch());
    try {
      const r = await call(h, 'vanlife_place', { tripId: 1, placeId: 13, fill: true, set: { water: 'yes' } });
      expect(r.ignored).toMatch(/^set:/);
    } finally { vi.unstubAllGlobals(); }
  });
  it('the panel shows a track page as the reference page of a hike only', async () => {
    const trip = build();
    trip.places.find((x) => x.id === 11).notes = 'Sources : https://www.komoot.com/tour/123';
    const h = makeHost({ trip });
    const w = JSON.parse((await h.run(plugin).route({ method: 'POST', path: '/amenities' }, { body: { tripId: 1, placeId: 11 } })).body);
    expect(JSON.stringify(w.sheet)).not.toContain('"field":"website"');
  });
});

describe('the 0.6.28 audit', () => {
  it('routes for one dayNumber touch that day only', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const r = await call(makeHost(), 'vanlife_day', { tripId: 1, action: 'routes', dayNumber: 2 });
      expect(r.days.map((d) => d.day.number)).toEqual([2]);
    } finally { vi.unstubAllGlobals(); }
  });
  it('the fill keeps a duration line that gives no figure: no figure taken from the summary', () => {
    const fillLib = require('../server/lib/amenity-fill.js');
    expect(fillLib.statedVisit({ categoryName: 'See – Hike', notes: '10.93 km · +770 m · 4 h 10\nDuration: depends on the snow, ask at the hut' })).toBeNull();
    expect(fillLib.statedVisit({ categoryName: 'See – Hike', notes: '10.93 km · +770 m · 4 h 10' })).toMatchObject({ min: 250 });
  });
  it('fill=true creates no car park, and says set was not applied', async () => {
    const trip = build();
    const h = makeHost({ trip });
    const n = trip.places.length;
    vi.stubGlobal('fetch', stubFetch());
    try {
      const r = await call(h, 'vanlife_place', { tripId: 1, placeId: 10, fill: true, set: { walk: { parking: { name: 'P Example', lat: 46.69, lng: 12.08 } } } });
      expect(r.ignored).toMatch(/set/);
      expect(r.created).toBeUndefined();
    } finally { vi.unstubAllGlobals(); }
    expect(trip.places.length).toBe(n);
  });
  it('arguments a mode does not use are refused or reported', async () => {
    await expect(call(makeHost(), 'vanlife_place', { tripId: 1, kind: 'farm' })).rejects.toThrow(/placeId/);
    vi.stubGlobal('fetch', stubFetch());
    try {
      const r = await call(makeHost(), 'vanlife_find_nights', { lat: 46.5, lng: 12.1, dayNumber: 3 });
      expect(r.ignored).toMatch(/dayNumber/);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('the 0.6.29 audit', () => {
  it('a user category named "… track" is never taken for the day\'s line', () => {
    const { isTrace } = require('../server/lib/classify.js');
    expect(isTrace('Hiking track', { id: 30 })).toBe(false);
    expect(isTrace('Route – Day route', { id: 31 })).toBe(true);
  });
  it('a free length that beats the summary keeps the notes\' line as its text', () => {
    const sheet = require('../server/lib/place-sheet.js');
    const s = sheet.sheetOf({ categoryName: 'See – Hike', notes: '10.93 km · +770 m · 4 h 10\nThe round trip takes 5 h 30 with the breaks.' });
    expect(s.fields.duration).toMatchObject({ minutes: 330, text: 'The round trip takes 5 h 30 with the breaks.' });
    expect(sheet.factsOf({ categoryName: 'See – Hike', notes: '10.93 km · +770 m · 4 h 10\nStart from 8 h; the round trip takes 3 h.' }).visitMinutes).toBe(180);
    // the minutes the free reader gave, not the line re-read as a duration line (which takes the 2 h)
    expect(sheet.factsOf({ categoryName: 'See – Hike', notes: '10.93 km · +770 m · 4 h 10\nFree car park 2 h for vans, lots of space there; the round trip takes 3 h.' }).visitMinutes).toBe(180);
  });
  it('a full clear and a fill report what they did not apply', async () => {
    // since 0.6.35 a full clear is a call of its own: refused with other writes, before any write
    await expect(call(makeHost(), 'vanlife_place', { tripId: 1, placeId: 11, clear_fields: ['all'], set: { water: 'yes' } })).rejects.toThrow(/full clear/);
    vi.stubGlobal('fetch', stubFetch());
    try {
      const f = await call(makeHost(), 'vanlife_place', { tripId: 1, fill: true, filter: 'missing_contacts', scope: 'candidates' });
      expect(f.ignored).toMatch(/filter, scope/);
    } finally { vi.unstubAllGlobals(); }
  });
  it('night set refuses a date that is not its dayNumber, and warns about a reason or nights it cannot use', async () => {
    const h = makeHost();
    await expect(call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 13, dayNumber: 1, date: '2026-10-14', status: 'contacted' })).rejects.toThrow(/date/);
    const r = await call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 13, dayNumber: 1, status: 'contacted', reason: 'full', nights: 3 });
    expect(r.warnings.join(' ')).toMatch(/reason/);
    expect(r.warnings.join(' ')).toMatch(/nights/);
  });
});

describe('the 0.6.30 audit', () => {
  it('the day\'s route place never goes into a user\'s "… route" hike category', () => {
    const { routeCategoryId } = require('../server/lib/traces.js');
    expect(routeCategoryId({ categories: [{ id: 9, name: 'Hiking route' }] }, null)).toBeNull();
    expect(routeCategoryId({ categories: [{ id: 9, name: 'Hiking route' }, { id: 6, name: 'Route – Day route' }] }, null)).toBe(6);
  });
  it('a trip-wide fill resyncs places it looked at lately', async () => {
    const af = require('../server/lib/amenity-fill.js');
    const qr = { [pi.INDEX_SQL]: [{ place_id: 10 }], [af.LOG_SQL]: [] };
    const h = makeHost({ trip: build(), queryResults: qr });
    vi.stubGlobal('fetch', stubFetch());
    try {
      await call(h, 'vanlife_place', { tripId: 1, fill: true });
      expect((await pi.get(h.ctx, 10)).visit_min_minutes).toBe(120);
      qr[af.LOG_SQL] = (await h.ctx.trips.getPlaces(1)).map((p) => ({ place_id: p.id, checked_at: new Date().toISOString() }));
      await h.ctx.places.update(1, 10, { notes: 'Lake walk, 3 h.' });
      const f = await call(h, 'vanlife_place', { tripId: 1, fill: true });
      expect(f.resynced).toBe(1);
      expect((await pi.get(h.ctx, 10)).visit_min_minutes).toBe(180);
    } finally { vi.unstubAllGlobals(); }
  });
  it('night set "spotted" refuses before writing a kind, and says what a spotted night cannot keep', async () => {
    const trip = build();
    const h = makeHost({ trip });
    await call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 19, dayNumber: 1, status: 'contacted' });
    const before = trip.places.find((p) => p.id === 19).category_id;
    await expect(call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 19, dayNumber: 1, status: 'spotted', kind: 'farm' })).rejects.toThrow(/already has a booking/);
    expect(trip.places.find((p) => p.id === 19).category_id).toBe(before);
    const r = await call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 13, dayNumber: 2, status: 'spotted', notes: 'x', confirmation: 'C1' });
    expect((r.warnings || []).join(' ')).toMatch(/notes, confirmation/);
  });
});

describe('the 0.6.31 audit', () => {
  it('a hike with a GPX line is never taken for the day\'s trace', () => {
    const { isTrace } = require('../server/lib/classify.js');
    expect(isTrace('See – Hike', { name: 'Lago di Carezza loop hike', route_geometry: '[[1,2],[3,4]]' })).toBe(false);
    expect(isTrace('See – Lake', { name: 'Route day 3', route_geometry: '[[1,2],[3,4]]' })).toBe(true);
  });
  it('vanlife_place refuses before any write: no kind, no new place, no car park', async () => {
    const trip = build();
    const h = makeHost({ trip });
    const cat = trip.places.find((p) => p.id === 13).category_id;
    const n = trip.places.length;
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 13, kind: 'farm', set: { visit_min_minutes: 120, visit_max_minutes: 60 } })).rejects.toThrow();
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 13, kind: 'farm', sheet_set: { opening_hourz: 'x' } })).rejects.toThrow(/unknown sheet field/);
    expect(trip.places.find((p) => p.id === 13).category_id).toBe(cat);
    await expect(call(h, 'vanlife_place', { tripId: 1, create: { name: 'New', lat: 46.5, lng: 12.1 }, set: { visit_min_minutes: 120, visit_max_minutes: 60 } })).rejects.toThrow();
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 10, set: { walk: { parking: { name: 'P', lat: 46.69, lng: 12.08 } } } })).rejects.toThrow();
    expect(trip.places.length).toBe(n);
  });
  it('create keeps or refuses its currency, never drops it', async () => {
    const trip = build();
    const h = makeHost({ trip });
    await call(h, 'vanlife_place', { tripId: 1, create: { name: 'Swiss camp', lat: 46.5, lng: 12.1, price_amount: 30, currency: 'CHF ' } });
    expect(trip.places.find((p) => p.name === 'Swiss camp').currency).toBe('CHF');
    await expect(call(h, 'vanlife_place', { tripId: 1, create: { name: 'X', lat: 46.5, lng: 12.1, currency: 'francs' } })).rejects.toThrow(/currency/);
  });
  it('night set: dayId and dayNumber must agree, the trip end is checked before the kind, notes "" empties', async () => {
    const trip = build();
    const h = makeHost({ trip });
    await expect(call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 19, dayId: 102, dayNumber: 3, status: 'contacted' })).rejects.toThrow(/dayId/);
    const cat = trip.places.find((p) => p.id === 13).category_id;
    const last = trip.days.length;
    await expect(call(h, 'vanlife_night', { tripId: 1, action: 'set', placeId: 13, dayNumber: last, status: 'contacted', kind: 'farm', nights: 5 })).rejects.toThrow(/last day/);
    expect(trip.places.find((p) => p.id === 13).category_id).toBe(cat);
    const ns = require('../server/lib/night-status.js');
    expect(ns.notesText({ notes: '', status: 'contacted' }, { notes: 'Waiting for the host to confirm' }, 'en')).toBe('');
  });
  it('arguments a mode does not read are said, and destructive tools say so', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const r = await call(makeHost(), 'vanlife_day', { tripId: 1, action: 'routes', dayNumber: 2, departure: '08:00', kinds: ['fuel'] });
      expect(r.ignored).toMatch(/departure, kinds/);
    } finally { vi.unstubAllGlobals(); }
    const specs = require('../server/lib/tool-specs.js');
    const list = specs.TOOL_SPECS || specs;
    for (const n of ['vanlife_place', 'vanlife_plan_trip']) expect(list.find((t) => t.name === n).annotations.destructiveHint, n).toBe(true);
  });
});

describe('the 0.6.32 audit', () => {
  const CATS = [{ id: 1, name: 'Night – Campsite' }, { id: 4, name: 'See – Lake' }, { id: 5, name: 'Food – Groceries' }, { id: 6, name: 'Route – Day route' }, { id: 7, name: 'See – Museum' }, { id: 8, name: 'Route – Parking' }, { id: 9, name: 'See – Hike' }, { id: 10, name: 'Bike' }];
  it('vanlife_place writes nothing before a refusal: create, walk.parking, an unknown place, a non-car park', async () => {
    const trip = build();
    const h = makeHost({ trip, categories: CATS });
    const n = trip.places.length;
    await expect(call(h, 'vanlife_place', { tripId: 1, create: { name: 'Swiss lake', lat: 46.5, lng: 12.1, per: 'week' } })).rejects.toThrow(/per/);
    await expect(call(h, 'vanlife_place', { tripId: 1, create: { name: 'Ridge hike', lat: 46.5, lng: 12.1, kind: 'hike' }, set: { walk: { shape: 'loop', parking: { name: 'P' } } } })).rejects.toThrow(/lat/);
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 999, set: { walk: { shape: 'loop', parking: { name: 'P', lat: 46.5, lng: 12.1 } } } })).rejects.toThrow(/not in trip/);
    expect(trip.places.length).toBe(n);
    const p17 = trip.places.find((p) => p.id === 17);
    const before = [p17.category_id, p17.notes];
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 17, kind: 'hike', sheet_set: { duration: '2 h' }, set: { walk: { shape: 'loop', parking_place_id: 12 } } })).rejects.toThrow(/not a car park/);
    expect([p17.category_id, p17.notes]).toEqual(before);
  });
  it('the new day route is filed in the day-route category, and a user\'s line in another category is kept', async () => {
    const trip = build();
    const ride = { id: 30, trip_id: 1, name: 'Cycling loop', lat: 46.41, lng: 11.58, category_id: 10, notes: '', description: '', route_geometry: JSON.stringify([[46.41, 11.58], [46.64, 11.72]]) };
    trip.places.push(ride);
    trip.days[2].assignments.unshift({ id: 3000, day_id: 103, order_index: -1, notes: null, accommodation_id: null, place: { ...ride, place_time: null, end_time: null } });
    const h = makeHost({ trip, categories: CATS });
    vi.stubGlobal('fetch', stubFetch());
    try {
      const r = await call(h, 'vanlife_day', { tripId: 1, action: 'routes', dayNumber: 3, apply: true });
      expect(r.writes[0].deletedPlaceId).toBeNull();
      expect(trip.places.some((p) => p.id === 30)).toBe(true);
      const created = trip.places.find((p) => p.id === r.writes[0].createdPlaceId && p.route_geometry && p.name !== 'Cycling loop');
      expect(created && created.category_id).toBe(6);
    } finally { vi.unstubAllGlobals(); }
  });
  it('vanlife_night is marked destructive', () => {
    const { TOOL_SPECS } = require('../server/lib/tool-specs.js');
    expect(TOOL_SPECS.find((t) => t.name === 'vanlife_night').annotations.destructiveHint).toBe(true);
  });
});

describe('the 0.6.33 audit', () => {
  const CATS = [{ id: 1, name: 'Night – Campsite' }, { id: 4, name: 'See – Lake' }, { id: 5, name: 'Food – Groceries' }, { id: 6, name: 'Route – Day route' }, { id: 7, name: 'See – Museum' }, { id: 8, name: 'Route – Parking' }, { id: 9, name: 'See – Hike' }, { id: 10, name: 'Bike – Cycling tour' }];
  it('a drawn line is the day\'s trace (day-route category first) unless it is an activity (hike, bike), which is a stop', () => {
    const { dayPlan } = require('../server/lib/check.js');
    const ride = { id: 30, name: 'Braies bike ride', categoryName: 'Bike – Cycling tour', route_geometry: '[[1,2],[3,4]]' };
    const own = { id: 20, name: 'Route day 1', categoryName: 'Route – Day route', route_geometry: '[[1,2],[3,4]]' };
    const lake = { id: 10, name: 'Lake', categoryName: 'See – Lake' };
    const day = { assignments: [{ id: 1, place: ride }, { id: 2, place: own }, { id: 3, place: lake }] };
    const plan = dayPlan({ days: [day], nights: [], accommodations: [] }, { ...day, index: 0, n: 1 });
    expect(plan.trace.place.id).toBe(20);
    expect(plan.stops.map((s) => s.place.id)).toEqual([30, 10]); // the bike ride is an activity of the day (0.6.35)
  });
  it('vanlife_place refuses a bad kind, an empty log or a walk to another car park before any write', async () => {
    const trip = build();
    const h = makeHost({ trip, categories: CATS });
    const n = trip.places.length;
    await expect(call(h, 'vanlife_place', { tripId: 1, create: { name: 'Swiss lake', lat: 46.5, lng: 12.1 }, kind: 'spaceship' })).rejects.toThrow(/kind/);
    await expect(call(h, 'vanlife_place', { tripId: 1, create: { name: 'Swiss lake', lat: 46.5, lng: 12.1 }, log: { date: '2026-10-01', channel: 'email', direction: 'sent', summary: '   ' } })).rejects.toThrow(/summary/);
    expect(trip.places.length).toBe(n);
    const p17 = trip.places.find((p) => p.id === 17);
    const before = [p17.category_id, p17.notes];
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 17, kind: 'hike', sheet_set: { duration: '2 h' }, log: { date: '2026-10-01', channel: 'email', direction: 'sent', summary: ' ' } })).rejects.toThrow(/summary/);
    expect([p17.category_id, p17.notes]).toEqual(before);
  });
});

describe('the 0.6.34 audit', () => {
  const CATS = [{ id: 1, name: 'Night – Campsite' }, { id: 4, name: 'See – Lake' }, { id: 5, name: 'Food – Groceries' }, { id: 6, name: 'Route – Day route' }, { id: 7, name: 'See – Museum' }, { id: 8, name: 'Route – Parking' }, { id: 9, name: 'See – Hike' }, { id: 10, name: 'Bike – Cycling tour' }];
  it('a refused vanlife_place call undoes what it wrote: a new place, a category, the notes', async () => {
    const trip = build();
    const h = makeHost({ trip, categories: CATS });
    const n = trip.places.length;
    let fail = false;
    // a refusal only a later step makes: simulated by a record write that fails
    h.ctx.meta.set = ((f) => async (...x) => { if (fail) throw new Error('later refusal'); return f(...x); })(h.ctx.meta.set);
    fail = true;
    await expect(call(h, 'vanlife_place', { tripId: 1, create: { name: 'New hike', lat: 46.5, lng: 12.1 }, set: { water: 'yes' } })).rejects.toThrow(/later refusal/);
    expect(trip.places.length).toBe(n);
    const p17 = trip.places.find((p) => p.id === 17);
    const before = [p17.category_id, p17.notes || ''];
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 17, kind: 'hike', sheet_set: { duration: '2 h' }, set: { water: 'yes' } })).rejects.toThrow(/later refusal/);
    expect([p17.category_id, p17.notes || '']).toEqual(before);
  });
  it('a set answers with TREK\'s new values (currency alone)', async () => {
    const trip = build();
    const h = makeHost({ trip });
    for (const k of ['getPlaces', 'getDays', 'getById', 'getAccommodations', 'getReservations']) {
      const f = h.ctx.trips[k];
      if (f) h.ctx.trips[k] = async (...x) => structuredClone(await f(...x)); // copies, as over TREK's RPC
    }
    const r = await call(h, 'vanlife_place', { tripId: 1, placeId: 13, set: { currency: 'CHF' } });
    expect(JSON.stringify(r.price)).toMatch(/CHF/);
  });
});

describe('the 0.6.35 audit', () => {
  it('routes apply keeps a user\'s uncategorised line when the trip has a day-route category', async () => {
    const trip = build();
    const line = { id: 30, trip_id: 1, name: 'Sella pass scenic drive (GPX)', lat: 46.41, lng: 11.58, category_id: null, notes: '', description: '', route_geometry: JSON.stringify([[46.41, 11.58], [46.64, 11.72]]) };
    trip.places.push(line);
    trip.days[2].assignments.unshift({ id: 3000, day_id: 103, order_index: -1, notes: null, accommodation_id: null, place: { ...line, place_time: null, end_time: null } });
    const h = makeHost({ trip });
    vi.stubGlobal('fetch', stubFetch());
    try {
      const r = await call(h, 'vanlife_day', { tripId: 1, action: 'routes', dayNumber: 3, apply: true });
      expect(r.writes[0].deletedPlaceId).toBeNull();
      expect(r.writes[0].kept).toMatch(/no category/);
      expect(trip.places.some((p) => p.id === 30)).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it('a walk refused after a kind writes neither the notes nor the record nor TREK\'s website', async () => {
    const cats = [{ id: 1, name: 'Night – Campsite' }, { id: 4, name: 'See – Lake' }, { id: 6, name: 'Route – Day route' }, { id: 8, name: 'Parking' }, { id: 9, name: 'Hike' }];
    const trip = build();
    const p17 = trip.places.find((p) => p.id === 17);
    p17.notes = 'Duration : 2 h\nWebsite : https://lake-a.example';
    trip.places.push({ id: 31, trip_id: 1, name: 'Carezza car park A', lat: 46.42, lng: 11.58, category_id: 8, notes: '', description: '' });
    trip.places.push({ id: 33, trip_id: 1, name: 'Carezza car park C', lat: 46.4098, lng: 11.5754, category_id: 8, notes: '', description: '' });
    const h = makeHost({ trip, categories: cats });
    const u = h.ctx.places.update;
    // TREK shows a new category in the days too
    h.ctx.places.update = async (tripId, id, patch) => {
      const r = await u(tripId, id, patch);
      if ('category_id' in patch) for (const d of trip.days) for (const x of d.assignments) if (x.place.id === id) { x.place.category_id = patch.category_id; x.place.category = cats.find((c) => c.id === patch.category_id); }
      return r;
    };
    vi.stubGlobal('fetch', stubFetch());
    try {
      await call(h, 'vanlife_place', { tripId: 1, placeIds: [17], placeId: 17, fill: true });
      const before = JSON.stringify([p17.category_id, p17.notes, p17.website, await pi.get(h.ctx, 17)]);
      await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 17, kind: 'hike', sheet_set: { duration: '4 h', website: 'https://lake-b.example' }, set: { walk: { parking_place_id: 31, shape: 'out_and_back' } } })).rejects.toThrow(/another car park/);
      expect(JSON.stringify([p17.category_id, p17.notes, p17.website, await pi.get(h.ctx, 17)])).toBe(before);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('the 0.6.36 audit', () => {
  it('a line is an activity by its category only, never by a name word', () => {
    const { isTrace } = require('../server/lib/classify.js');
    expect(isTrace('', { name: 'Route day 3 — Aire Example → Agriturismo Al Sentiero (108 km)', route_geometry: '[[1,2],[3,4]]' })).toBe(true);
    expect(isTrace('See – Hike', { name: 'Loop', route_geometry: '[[1,2],[3,4]]' })).toBe(false);
  });
  it('filter "hikes" refuses writes rather than drop them', async () => {
    await expect(call(makeHost(), 'vanlife_place', { tripId: 1, filter: 'hikes', create: { name: 'Lago di Sorapis', lat: 46.5, lng: 12.2 } })).rejects.toThrow(/hikes/);
  });
  it('a refused call puts the record and TREK\'s website back after sheet_set\'s resync', async () => {
    const trip = build();
    const p17 = trip.places.find((p) => p.id === 17);
    p17.notes = 'Duration : 1 h\nWebsite : https://lake-a.example';
    const h = makeHost({ trip });
    vi.stubGlobal('fetch', stubFetch());
    try {
      await call(h, 'vanlife_place', { tripId: 1, placeIds: [17], placeId: 17, fill: true });
      const before = JSON.stringify([p17.notes, p17.website, await pi.get(h.ctx, 17)]);
      await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 17, sheet_set: { duration: '2 h', website: 'https://lake-b.example' }, set: { visit_max_minutes: 90 } })).rejects.toThrow(/visit_max/);
      expect(JSON.stringify([p17.notes, p17.website, await pi.get(h.ctx, 17)])).toBe(before);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('the 0.6.37 audit', () => {
  it('routes apply keeps a kept line in the reorder call, after the new trace', async () => {
    const trip = build();
    const line = { id: 30, trip_id: 1, name: 'My drive, imported GPX', lat: 46.41, lng: 11.58, category_id: null, notes: '', description: '', route_geometry: JSON.stringify([[46.41, 11.58], [46.64, 11.72]]) };
    trip.places.push(line);
    trip.days[2].assignments.unshift({ id: 3000, day_id: 103, order_index: -1, notes: null, accommodation_id: null, place: { ...line, place_time: null, end_time: null } });
    vi.stubGlobal('fetch', stubFetch());
    try {
      const r = await call(makeHost({ trip }), 'vanlife_day', { tripId: 1, action: 'routes', dayNumber: 3, apply: true });
      const order = r.coreCalls[0].args.orderedIds || r.coreCalls[0].args.assignmentIds || Object.values(r.coreCalls[0].args).find(Array.isArray);
      expect(order[0]).toBe(r.writes[0].assignmentId);
      expect(order).toContain(3000);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('the 0.6.38 audit', () => {
  it('sheet_set route_type replaces a "Type : boucle" line, which the reader reads as the route type', () => {
    const sheet = require('../server/lib/place-sheet.js');
    const r = sheet.setField('', 'Type : boucle\nDurée : 4 h', 'route_type', 'aller-retour', 'fr');
    expect(r.notes).not.toMatch(/boucle/);
    expect(sheet.setField('', 'Type : boucle\nDurée : 4 h', 'route_type', null, 'fr').notes).toBe('Durée : 4 h');
    expect(sheet.setField('', 'Type : camping', 'route_type', null, 'fr').notes).toBe('Type : camping');
  });
  it('routes says a dayNumber it does not use when dayNumbers are given', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      const r = await call(makeHost(), 'vanlife_day', { tripId: 1, action: 'routes', dayNumber: 2, dayNumbers: [1] });
      expect(r.ignored).toMatch(/dayNumber/);
      const r2 = await call(makeHost(), 'vanlife_day', { tripId: 1, action: 'routes', dayNumber: 2 });
      expect(r2.ignored).toBeUndefined();
    } finally { vi.unstubAllGlobals(); }
  });
  it('a field both set and cleared in one call is refused', async () => {
    await expect(call(makeHost(), 'vanlife_place', { tripId: 1, placeId: 13, set: { dog: 'yes' }, clear_fields: ['dog'] })).rejects.toThrow(/both set and cleared/);
  });
  it('a hike with its GPX line is a place for the list and the fill; its track page is the tool\'s website too', async () => {
    const trip = build();
    const hike = { id: 41, trip_id: 1, name: 'Seceda ridge', lat: 46.6, lng: 11.7, category_id: 9, notes: 'Duration : 4 h\nTrack: https://www.komoot.com/tour/123456', description: '', website: 'https://www.valgardena.it', route_geometry: JSON.stringify([[46.6, 11.7], [46.61, 11.72]]) };
    trip.places.push(hike);
    const cats = [{ id: 1, name: 'Night – Campsite' }, { id: 4, name: 'See – Lake' }, { id: 6, name: 'Route – Day route' }, { id: 9, name: 'See – Hike' }];
    const h = makeHost({ trip, categories: cats });
    const all = await call(h, 'vanlife_place', { tripId: 1, filter: 'all' });
    expect(all.places.some((p) => p.placeId === 41 || p.id === 41)).toBe(true);
    vi.stubGlobal('fetch', stubFetch());
    try {
      const f = await call(h, 'vanlife_place', { tripId: 1, placeIds: [41], placeId: 41, fill: true });
      expect(f.looked).toBe(1);
    } finally { vi.unstubAllGlobals(); }
    const t = await call(h, 'vanlife_place', { tripId: 1, placeId: 41 });
    expect(t.sheet.fields.website.url).toMatch(/komoot/);
  });
});

describe('the 0.6.38 audit: plan_trip apply', () => {
  it('the budget reads the routes written in the same call, not the lines they replaced', async () => {
    vi.stubGlobal('fetch', stubFetch());
    try {
      let r = await call(makeHost(), 'vanlife_plan_trip', { tripId: 1, apply: true });
      const h = makeHost();
      r = await call(h, 'vanlife_plan_trip', { tripId: 1, apply: true });
      while (r.continuation) r = await call(h, 'vanlife_plan_trip', { tripId: 1, apply: true, continuation: r.continuation });
      const fuel = (r.coreCalls || []).find((c) => /Fuel day 1 /.test(c.args && c.args.name));
      const day1 = r.results.routes && r.results.routes.days.find((d) => d.day.number === 1);
      if (fuel && day1) expect(fuel.args.name).toContain(`(${Math.round(day1.km)} km)`);
      else expect(fuel || day1).toBeTruthy();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('the 0.6.39 audit', () => {
  it('sheet_set route_type leaves a "Parcours" line with no route shape, a free note for the reader', () => {
    const sheet = require('../server/lib/place-sheet.js');
    const notes = 'Parcours : par le sentier des crêtes, via le refuge Firenze\nDurée : 4 h';
    expect(sheet.sheetOf({ notes, categoryName: 'See – Hike' }).fields.route_type).toBeUndefined();
    expect(sheet.setField('', notes, 'route_type', 'boucle', 'fr').notes).toMatch(/sentier des crêtes/);
  });
  it('contacts set and another contact cleared are both kept; a contact or the amenities set and cleared is refused', async () => {
    const h = makeHost();
    await call(h, 'vanlife_place', { tripId: 1, placeId: 13, set: { contacts: { email: 'a@example.com', phone: '+39 0471 111111' } }, clear_fields: ['whatsapp'] });
    const rec = await pi.get(h.ctx, 13);
    expect([rec.contacts.email, rec.contacts.phone]).toEqual(['a@example.com', '+390471111111']);
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 13, set: { contacts: { email: 'b@example.com' } }, clear_fields: ['email'] })).rejects.toThrow(/both set and cleared/);
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 13, set: { dog: 'yes' }, clear_fields: ['amenities'] })).rejects.toThrow(/both set and cleared/);
  });
  it('without a day-route category, routes apply deletes only a line carrying the plugin\'s own note', () => {
    const { isOwnRouteNote } = require('../server/lib/traces.js');
    expect(isOwnRouteNote('Computed by the vanlife plugin (Valhalla, no tolls, height 2.1 m). Legs: …')).toBe(true);
    expect(isOwnRouteNote(`${require('../server/i18n/fr.json')['route.notes'].split('{')[0]}sans péage…`)).toBe(true); // any language
    expect(isOwnRouteNote('My GPX drive')).toBe(false);
    expect(isOwnRouteNote('')).toBe(false);
  });
  it('a GPX hike in a hike category has its planner columns', async () => {
    const { placeColumns } = require('../server/lib/contributions.js');
    const trip = build();
    trip.places.push({ id: 45, trip_id: 1, name: 'Seceda ridge', lat: 46.6, lng: 11.7, category_id: 9, notes: '', description: '', route_geometry: JSON.stringify([[46.6, 11.7], [46.61, 11.72]]) });
    const h = makeHost({ trip, categories: [{ id: 1, name: 'Night – Campsite' }, { id: 6, name: 'Route – Day route' }, { id: 9, name: 'See – Hike' }], queryResults: { [pi.INDEX_SQL]: [{ place_id: 45 }] } });
    await pi.set(h.ctx, 1, 45, { visit_min_minutes: 180 });
    const cols = await placeColumns(h.ctx, 1, await readSettings(h.ctx));
    expect(JSON.stringify(cols)).toMatch(/3 h/);
  });
  it('routes refuses a day that is not in the trip, as schedule does', async () => {
    await expect(call(makeHost(), 'vanlife_day', { tripId: 1, action: 'routes', dayNumbers: [1, 9] })).rejects.toThrow(/day 9/);
  });
});

describe('the 0.6.40 audit', () => {
  it('the fill never copies a campsite nearby onto a place that is not a night', async () => {
    const trip = build();
    const museum = trip.places.find((p) => p.id === 11);
    Object.assign(museum, { website: null, phone: null });
    const h = makeHost({ trip });
    const osm = { elements: [{ type: 'node', id: 77, lat: museum.lat + 0.0005, lon: museum.lng, tags: { tourism: 'camp_site', phone: '+39 0471 555111', website: 'https://camping-nextdoor.example', dog: 'no' } }] };
    const base = stubFetch();
    vi.stubGlobal('fetch', (url, init) => (String(url).includes('overpass') ? Promise.resolve({ ok: true, status: 200, json: async () => osm }) : base(url, init)));
    try { await call(h, 'vanlife_place', { tripId: 1, placeIds: [11], placeId: 11, fill: true }); } finally { vi.unstubAllGlobals(); }
    expect([museum.website, museum.phone]).toEqual([null, null]);
    const rec = await pi.get(h.ctx, 11);
    expect(rec ? rec.amenities.dog : 'unknown').not.toBe('no');
  });
  it('a nested walk or parking field set and cleared in one call is refused', async () => {
    const h = makeHost();
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 13, set: { parking: { hours: '8-20' } }, clear_fields: ['parking_hours'] })).rejects.toThrow(/both set and cleared/);
  });
  it('sheet_set route_type replaces a "Parcours" line whose shape is in its bullets', () => {
    const s = require('../server/lib/place-sheet.js');
    expect(s.setField('', 'Parcours :\n• boucle par le lac\n• retour par la forêt\nDurée : 4 h', 'route_type', 'aller-retour', 'fr').notes).toBe('Parcours : aller-retour\nDurée : 4 h');
  });
  it('the walk shape follows the sheet\'s route type when none is recorded', () => {
    const walks = require('../server/lib/walks.js');
    const shape = walks.shapeOf({ lat: 46.6, lng: 11.7, notes: 'Type : boucle', categoryName: 'See – Hike' }, { point: { lat: 46.0, lng: 11.0 } }, null);
    expect(shape).toBe('loop');
  });
});

describe('the 0.6.41 audit', () => {
  it('a park4night link in a free sentence is never the place\'s own page', () => {
    const fillLib = require('../server/lib/amenity-fill.js');
    expect(fillLib.p4nId({ notes: 'Si complet : plan B https://park4night.com/fr/place/456 (parking à 20 km)' })).toBeNull();
  });
  it('sheet_set reads a dashed list of fields as the reader does', () => {
    const s = require('../server/lib/place-sheet.js');
    const notes = '- Durée : 3 h\n- Distance : 9 km';
    expect(s.sheetOf({ notes, categoryName: 'See – Hike' }).fields.duration.minutes).toBe(180);
    const out = s.setField('', notes, 'duration', '5 h', 'fr').notes;
    expect(s.sheetOf({ notes: out, categoryName: 'See – Hike' }).fields.duration.minutes).toBe(300);
    expect(s.setField('', notes, 'duration', null, 'fr').notes).toBe('- Distance : 9 km');
  });
  it('sheet_set refuses a value that is not a text', async () => {
    await expect(call(makeHost(), 'vanlife_place', { tripId: 1, placeId: 13, sheet_set: { price: { amount: 30 } } })).rejects.toThrow(/must be a text/);
  });
  it('the recorded walk shape is the route type the sheet shows', () => {
    const s = require('../server/lib/place-sheet.js');
    const f = s.withRecord({ route_type: { text: 'boucle', kind: 'loop' } }, 'en', { walkShape: 'out_and_back' });
    expect(f.route_type).toEqual({ text: 'Out and back', kind: 'out_and_back' });
  });
});
