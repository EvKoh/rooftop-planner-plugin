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
