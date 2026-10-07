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
