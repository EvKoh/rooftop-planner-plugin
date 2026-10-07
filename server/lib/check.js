'use strict';
// The full trip check (the `vanlife_check_trip` tool, the planner and the warnings banner
// all read it). Two passes: first collect every drive leg the rules need and resolve them
// in one batch (cache, then a Valhalla matrix), then evaluate the rules day by day.
// It never writes anything. Levels: blocking > fix > verify > info.
const { hhmm, hm, distKm, norm, durationText } = require('./util');
const { t, dayName, money, num, clock } = require('./i18n');
const placeInfo = require('./place-info');
const { sunset } = require('./sun');
const { isShopping, isTrace, parkingFromNotes } = require('./classify');
const rules = require('./rules');
const placeSheet = require('./place-sheet');
const { isHikePlace, isParkingPlace } = require('./design');
const routing = require('./routing');
const { highwayAllowed, fuelPerKm, DEFAULTS } = require('./settings');
const { dayStopMinutes } = require('./visit');
const { stayOn, stayBefore, isFirstEvening, findDay, isNightPlace, nameKey, unplannedNights } = require('./trip');
const contacts = require('./contacts');
const nightStatus = require('./night-status');

const LEVELS = ['blocking', 'fix', 'verify', 'info'];

/** Zone name and legal note of a legality finding, in language L (texts live in the catalogues). */
function zoneText(L, p) {
  const id = p.zoneId || 'unknown';
  return { zone: t(L, `zone.${id}.name`), note: t(L, `zone.${id}.${p.rule}`) };
}
const fmtDur = (m) => (m == null ? '—' : durationText(m));
const located = (p) => p && p.lat != null && p.lng != null;
const pos = (p) => [p.lat, p.lng];

/** The stops of a day that the car drives between, with where the car actually goes. */
function dayPlan(model, day) {
  // Where the car is in the morning (last evening's stay) and tonight's stay: the same stay
  // on the later days of a stay over several nights, so those days start and end at camp.
  const veille = stayBefore(model, day);
  const nuit = stayOn(model, day);
  const trace = day.assignments.find((a) => isTrace(a.place.categoryName, a.place));
  const stops = day.assignments.filter((a) => a !== trace && !(veille && a.accommodationId === veille.id && (!nuit || veille.id !== nuit.id)));
  return { veille, nuit, trace, stops };
}

function carPos(stop) {
  return parkingFromNotes(stop.place.notes, stop.place.description) || pos(stop.place);
}

// A stop that is a visit (not shopping, not a night of the trip): what the day's load counts.
const isVisit = (model, p) => !isShopping(p.categoryName, p.stopType) && !isNightPlace(model, p);
const MEAL_MIN = 30;
const LONG_DAY_MIN = 6 * 60;
// A stop this short (a photo, a lake by the road, a market on the way) is not an activity.
const STOP_MIN = 30;

/**
 * Is the day overloaded? Usable window: the day's start (setting, or the first stop when
 * earlier) to the latest arrival at the night (sunset minus the margin). Need: minimum
 * visit durations + real drive times + a meal break once the day passes 6 h. Also the
 * traveller's rule: one big activity a day, or at most two small ones; and the visits whose
 * duration nobody knows yet. Skipped when a drive time is not known (banner: cache only).
 */
function dayLoad({ model, settings, d, plan, legIdx, toNight, M, add, J, ids, L, tz }) {
  const { nuit, stops } = plan;
  const visits = [];
  let drive = 0;
  let complete = true;
  // A car park is where the car waits, not an activity; on a day with a hike its time is the
  // hike's, so it is not counted twice (visit.js dayStopMinutes, shared with the schedule).
  stops.forEach((s, i) => {
    const leg = legIdx[i];
    if (leg && leg.drive != null) { const m = M(leg.drive); if (m == null) complete = false; else drive += m; }
    if (nuit && s.accommodationId === nuit.id) return;
    const info = (model.poolById.get(s.place.id) || {}).info || null;
    const parking = isParkingPlace(s.place);
    visits.push({ s, minutes: dayStopMinutes(s, info, stops), visit: isVisit(model, s.place) && !parking });
  });
  if (toNight != null) { const m = M(toNight); if (m == null) complete = false; else drive += m; }
  const unknown = visits.filter((v) => v.visit && v.minutes == null).map((v) => v.s.place.name);
  if (unknown.length) add('verify', J, 'visit_unknown', { list: unknown.join(', ') }, ids);

  const acts = visits.filter((v) => v.visit && v.minutes != null);
  const big = settings.big_activity_minutes;
  // The rule as the setting states it: a visit of big_activity_minutes or more is the day's one
  // big activity; a shorter one (over a quick stop) is half of one, so two fit in a day.
  const load = acts.reduce((n, v) => n + (v.minutes <= STOP_MIN ? 0 : v.minutes >= big ? 1 : 0.5), 0);
  if (load > 1) {
    add('fix', J, 'too_many_activities', { list: acts.filter((v) => v.minutes > STOP_MIN).map((v) => `${v.s.place.name} (${fmtDur(v.minutes)})`).join(', '), big: fmtDur(big), nBig: acts.filter((v) => v.minutes >= big).length }, ids);
  }

  if (!complete || !nuit || !located(nuit) || !d.date) return;
  const cs = sunset(nuit.lat, nuit.lng, d.date, tz);
  const to = rules.latestArrival(cs, settings);
  if (to == null) return;
  const times = stops.map((s) => s.place.time).filter((x) => x != null);
  const from = Math.min(hm(settings.day_start) ?? hm(DEFAULTS.day_start), ...times);
  const visitMin = visits.reduce((n, v) => n + (v.minutes || 0), 0);
  let needMin = visitMin + drive;
  if (needMin > LONG_DAY_MIN) needMin += MEAL_MIN;
  const windowMin = to - from;
  if (needMin > windowMin) {
    const biggest = visits.filter((v) => v.minutes != null).sort((a, b) => b.minutes - a.minutes).slice(0, 2).map((v) => v.s.place.name);
    add('fix', J, 'day_overloaded', {
      need: fmtDur(needMin), window: fmtDur(windowMin), from: hhmm(from), to: hhmm(to), visits: fmtDur(visitMin), drive: fmtDur(drive), list: biggest.join(', ') || '—',
    }, { ...ids, needMinutes: needMin, windowMinutes: windowMin, visitMinutes: visitMin, driveMinutes: drive });
  }
}

// Words in a stop's notes saying the slot, car park or road is booked.
const BOOKED_NOTE = /\b(booked|reserved|reservation|confirm|ticket|reserv|prenotat|confermat|gebucht|reserviert|buchung|bestatigt|donation|don\b|offerta libera|spende)/;

/** Is a booking of this place recorded: a TREK booking that reads "booked" (night-status.js), or words in the stop's notes? */
function bookingNoted(model, placeId, notes) {
  return nightStatus.placeBooked(model.reservations, placeId) || BOOKED_NOTE.test(norm(notes));
}

/**
 * Timed access of a place reached at `arr` (minutes): a road closed after a set hour
 * (blocking), open only after one or closed in between (fix), a booking required with none
 * recorded (verify, with the link).
 */
function accessFindings({ model, info, name, arr, notes, placeId, add, J, extra, L }) {
  if (!info) return;
  const v = placeInfo.accessVerdict(info, arr);
  if (v) {
    const params = { name, arr: clock(arr, L), before: clock(v.before, L), after: clock(v.after, L), late: v.late, wait: v.wait };
    add(v.key === 'access_late' ? 'blocking' : 'fix', J, v.key, params, { ...extra, arrival: hhmm(arr), lateMinutes: v.late ?? null, waitMinutes: v.wait ?? null });
  }
  if (info.booking_required === true && !bookingNoted(model, placeId, notes)) {
    add('verify', J, 'access_booking', { name, note: info.booking_note ? ` (${info.booking_note})` : '', link: info.booking_url ? ` (${info.booking_url})` : '' }, { ...extra, bookingUrl: info.booking_url || null });
  }
}

/**
 * Money that could be saved, never blocking:
 *  - a night above the target price when the night search (cache only) knows a legal, open,
 *    cheaper place within 20 min of detour: net saving = price - its price - detour fuel;
 *  - coming back to the same camp although tomorrow's first stop is the other way: the
 *    extra km and fuel (a rooftop tent is folded every morning anyway: staying put saves
 *    no packing).
 */
async function savings({ ctx, model, settings, add, L, deadline, dayLabel }) {
  const cur = model.currency;
  const perKm = fuelPerKm(settings);
  // Lazy: nights.js needs this module.
  const { findNightsForDay } = require('./nights');
  for (const d of model.days) {
    const nuit = stayOn(model, d);
    if (!isFirstEvening(nuit, d)) continue;
    // Only a price in the same unit and currency as the candidates' (per night, for the vehicle).
    const current = nuit.currency === model.currency ? placeInfo.comparableNightPrice(nuit) : null;
    if (current == null || current <= settings.night_price_target) continue;
    if (deadline && deadline.left() < 1500) break;
    let r;
    try {
      r = await findNightsForDay(ctx, model, { dayId: d.id, sources: ['osm'] }, { settings, deadline, network: false });
    } catch { continue; }
    // The same rule as the planner's (nights.js cheaperNight).
    const best = r.cheaper ? { c: r.cheaper.candidate, net: r.cheaper.net } : null;
    if (best) {
      add('verify', dayLabel(d), 'saving_night', {
        name: nuit.name, current: money(current, nuit.currency, L), alt: best.c.name, price: money(best.c.price, nuit.currency, L), detour: best.c.detourMinutes, saving: money(best.net, nuit.currency, L),
      }, { dayId: d.id, dayNumber: d.n, placeId: nuit.placeId, savingAmount: best.net });
    }
  }
  for (const d of model.days) {
    const next = model.days[d.index + 1];
    const camp = stayOn(model, d);
    const before = stayBefore(model, d);
    if (!next || !camp || !before || camp.placeId !== before.placeId || !located(camp)) continue;
    const lastVisit = [...d.assignments].reverse().find((a) => located(a.place) && a.place.id !== camp.placeId && !isTrace(a.place.categoryName, a.place));
    const first = next.assignments.find((a) => located(a.place) && a.place.id !== camp.placeId && !isTrace(a.place.categoryName, a.place));
    if (!lastVisit || !first) continue;
    // Straight lines x 1.3: an estimate of the road, said as such.
    const E = pos(lastVisit.place);
    const F = pos(first.place);
    const C = pos(camp);
    const extra = Math.round((distKm(E, C) + distKm(C, F) - distKm(E, F)) * 1.3);
    if (extra < 20) continue;
    add('verify', dayLabel(d), 'backtrack', {
      name: camp.name, next: first.place.name, km: extra, cost: money(extra * perKm, cur, L), tent: settings.vehicle === 'rooftop_tent' ? t(L, 'backtrack_tent') : '',
    }, { dayId: d.id, dayNumber: d.n, placeId: camp.placeId, extraKm: extra });
  }
}

async function checkTrip(ctx, model, { settings, network = true, deadline, lang, now = Date.now() } = {}) {
  const L = lang || settings.language;
  const findings = [];
  const dayLabel = (d) => t(L, 'day', { n: d.n, date: d.date || '?' });
  const seen = new Set();
  const add = (level, scope, key, params = {}, extra = {}) => {
    const message = `${scope} — ${t(L, key, params)}`;
    if (seen.has(message)) return; // two rules can reach the same sentence (check-in field and notes)
    seen.add(message);
    findings.push({ level, key, scope, message, params, ...extra });
  };
  const tz = settings.timezone;

  // ---------- pass 1: the legs the rules need ----------
  const pairs = [];
  const want = new Map(); // key → index into pairs, per highway flag
  const need = (a, b, tolls) => {
    const k = `${tolls ? 'T' : 'N'}|${a.join(',')}|${b.join(',')}`;
    if (!want.has(k)) { want.set(k, pairs.length); pairs.push({ a, b, tolls }); }
    return want.get(k);
  };
  const plans = model.days.map((d) => {
    const plan = dayPlan(model, d);
    const tolls = highwayAllowed(settings, d.index, model.days.length);
    let prec = plan.veille && located(plan.veille) ? pos(plan.veille) : null;
    const legIdx = [];
    plan.stops.forEach((s, i) => {
      if (!located(s.place)) { legIdx.push(null); return; }
      const car = carPos(s);
      const onFoot = isHikePlace(s.place);
      const leg = { drive: prec && !onFoot ? need(prec, car, tolls) : null };
      const next = plan.stops.slice(i + 1).find((x) => located(x.place));
      if (isShopping(s.place.categoryName, s.place.stopType) && prec && next) {
        leg.detour = [need(prec, pos(s.place), tolls), need(pos(s.place), pos(next.place), tolls), need(prec, pos(next.place), tolls)];
      }
      legIdx.push(leg);
      if (!(onFoot && prec)) prec = car;
    });
    // The drive to tonight's place when the night is not one of the day's stops.
    const nightInStops = plan.nuit && plan.stops.some((x) => x.accommodationId === plan.nuit.id);
    const toNight = plan.nuit && !nightInStops && located(plan.nuit) && prec ? need(prec, pos(plan.nuit), tolls) : null;
    return { day: d, plan, tolls, legIdx, toNight };
  });
  const byTolls = [true, false].map((tolls) => pairs.map((p, i) => [p, i]).filter(([p]) => p.tolls === tolls));
  const minutes = new Array(pairs.length).fill(null);
  let pending = 0;
  for (const group of byTolls) {
    if (!group.length) continue;
    const r = await routing.legs(ctx, group.map(([p]) => [p.a, p.b]), { ...routing.vehicleOpts(settings, group[0][0].tolls), network, deadline });
    group.forEach(([, i], j) => { const v = r.values.get(j); minutes[i] = v ? v.minutes : null; });
    pending += r.pending;
  }
  const M = (i) => (i == null ? null : minutes[i]);

  // ---------- pass 2: rules, day by day ----------
  const anyTrace = model.days.some((d) => d.assignments.some((a) => isTrace(a.place.categoryName, a.place)));
  let dryNights = 0;
  for (const { day: d, plan, legIdx, toNight } of plans) {
    const J = dayLabel(d);
    const ids = { dayId: d.id, dayNumber: d.n };
    const { veille, nuit, trace, stops } = plan;
    dayLoad({ model, settings, d, plan, legIdx, toNight, M, add, J, ids, L, tz });

    // A place closed for the season on the day it is planned (a stop, or the night).
    for (const s2 of [...stops, ...(nuit ? [{ place: { id: nuit.placeId, name: nuit.name } }] : [])]) {
      const info = (model.poolById.get(s2.place.id) || {}).info || null;
      if (d.date && placeInfo.closedOn(info, d.date)) {
        add('blocking', J, 'place_closed', { name: s2.place.name, from: placeInfo.shortDate(info.closed_from, L) || '…', until: placeInfo.shortDate(info.closed_until, L) || '…' }, { ...ids, placeId: s2.place.id });
      }
    }

    // A rest day at camp (same stay last night and tonight) drives nowhere: no route place to ask for.
    const restDay = !!veille && !!nuit && veille.id === nuit.id;
    if (anyTrace && (veille || nuit) && !restDay) {
      if (!trace) add('fix', J, 'no_trace', {}, ids);
      else {
        if (d.assignments[0] !== trace) add('fix', J, 'trace_not_first', {}, { ...ids, placeId: trace.place.id });
        const g = trace.place.geometry;
        if (g && veille && located(veille) && distKm(g[0], pos(veille)) > 1) add('fix', J, 'trace_start', { name: veille.name }, ids);
        if (g && nuit && located(nuit) && distKm(g[g.length - 1], pos(nuit)) > 1) add('fix', J, 'trace_end', { name: nuit.name }, ids);
      }
    }

    let prec = veille ? { name: veille.name, end: null } : null;
    stops.forEach((s, i) => {
      const p = s.place;
      const isTonight = nuit && s.accommodationId === nuit.id;
      const start = p.time;
      const end = p.end;
      const extra = { ...ids, placeId: p.id };
      const leg = legIdx[i];
      const legMin = prec && prec.end != null && leg && leg.drive != null ? M(leg.drive) : null;
      // The night's own access is judged with the night below.
      if (!isTonight) {
        const info = (model.poolById.get(p.id) || {}).info || null;
        const arr = start ?? (legMin != null ? prec.end + legMin : null);
        accessFindings({ model, info, name: p.name, arr, notes: s.notes, placeId: p.id, add, J, extra, L });
      }
      if (start == null) {
        if (!isTonight) add('fix', J, 'no_time', { name: p.name }, extra);
        prec = { name: p.name, end: null };
        return;
      }
      if (end != null && end < start) add('fix', J, 'ends_before_start', { name: p.name, start: hhmm(start), end: hhmm(end) }, extra);
      if (prec && prec.end != null && leg && leg.drive != null) {
        const m = M(leg.drive);
        if (m != null && prec.end + m > start + 5) {
          add('fix', J, 'unreachable', { name: p.name, start: hhmm(start), prev: prec.name, prevEnd: hhmm(prec.end), min: m, eta: hhmm(prec.end + m) }, extra);
        }
      }
      if (prec && prec.end != null && prec.end > start) add('fix', J, 'overlap', { name: p.name, start: hhmm(start), prev: prec.name, prevEnd: hhmm(prec.end) }, extra);
      if (d.wd != null) {
        const text = `${p.description}\n${p.notes}\n${s.notes}`;
        for (const c of rules.closures(text, d.wd, start, end, { placeName: p.name, isNight: !!isTonight || isNightPlace(model, p) })) {
          const params = { name: p.name, day: dayName(L, d.wd), ...c.params };
          if (c.key === 'outside_hours') Object.assign(params, { from: hhmm(start), to: hhmm(end ?? start), open: hhmm(c.params.open), close: hhmm(c.params.close) });
          add(c.level, J, c.key, params, extra);
        }
      }
      if (leg && leg.detour) {
        const [a, b, direct] = leg.detour.map(M);
        if (a != null && b != null && direct != null && a + b - direct > settings.shop_detour_max_min) {
          add('fix', J, 'shop_detour', { min: a + b - direct, name: p.name, max: settings.shop_detour_max_min }, extra);
        }
      }
      if (!isTonight && d.date && located(p)) {
        const cs = sunset(p.lat, p.lng, d.date, tz);
        if (cs != null && (end ?? start) > cs) add('verify', J, 'after_sunset', { name: p.name, end: hhmm(end ?? start), sunset: hhmm(cs) }, extra);
      }
      prec = { name: p.name, end: end ?? start };
    });

    // Tonight's stay. Its arrival, access, ground and vehicle rules are judged on its first
    // evening; a later evening of the same stay is judged on the day's load (dayLoad, back
    // at camp before dark) and on its own date (closures above), and counts as a night for
    // water.
    if (nuit && isFirstEvening(nuit, d)) {
      const extra = { ...ids, placeId: nuit.placeId };
      const a = d.assignments.find((x) => x.accommodationId === nuit.id);
      const arr = a?.place.time ?? rules.hm(nuit.checkIn);
      const cs = located(nuit) && d.date ? sunset(nuit.lat, nuit.lng, d.date, tz) : null;
      const limit = rules.latestArrival(cs, settings);
      if (arr == null) add('blocking', J, 'night_no_arrival', { name: nuit.name }, extra);
      else if (limit != null && arr > limit) add('blocking', J, 'night_late', { name: nuit.name, arr: hhmm(arr), sunset: hhmm(cs), limit: hhmm(limit) }, extra);
      if (a?.place.time != null && nuit.checkIn && Math.abs(rules.hm(nuit.checkIn) - arr) > 5) {
        add('fix', J, 'checkin_mismatch', { name: nuit.name, checkin: nuit.checkIn, arr: hhmm(arr) }, extra);
      }
      const written = rules.writtenArrival(nuit.notes);
      if (arr != null && written != null && Math.abs(written - arr) > 5) add('fix', J, 'checkin_mismatch', { name: nuit.name, checkin: hhmm(written), arr: hhmm(arr) }, extra);
      else if (arr != null && cs != null && arr <= limit) add('info', J, 'night_margin', { name: nuit.name, arr: hhmm(arr), sunset: hhmm(cs), margin: fmtDur(cs - arr) }, extra);

      accessFindings({ model, info: nuit.info, name: nuit.name, arr, notes: a ? a.notes : '', placeId: nuit.placeId, add, J, extra, L });

      const legal = rules.nightLegality({ categoryName: nuit.categoryName, placeName: nuit.name, lat: nuit.lat, lng: nuit.lng, text: nuit.text, vehicle: settings.vehicle });
      // A zone and its note only for a rule that has one (night_private, night_aire have none).
      if (legal) add(legal.level, J, legal.key, { name: nuit.name, ...(legal.params.rule ? zoneText(L, legal.params) : {}) }, extra);
      const am = nuit.info ? nuit.info.amenities : {};
      // What the place's sheet states, in whatever language its notes are written.
      const facts = placeSheet.factsOf((model.poolById.get(nuit.placeId) || {}).raw || { notes: nuit.notes });
      // A tent ban only matters to a rooftop tent: a van or a motorhome deploys nothing.
      // The record or the sheet says no (tent_refused), or free notes do (tent_banned, quoted).
      const refused = settings.vehicle === 'rooftop_tent' && (am.rooftop_tent === 'no' || facts.tentAllowed === false);
      const banned = settings.vehicle !== 'rooftop_tent' || refused ? null : rules.tentBanned(nuit.text);
      if (refused) add('blocking', J, 'tent_refused', { name: nuit.name }, extra);
      if (banned) add('blocking', J, 'tent_banned', { name: nuit.name, quote: banned }, extra);
      if (settings.dog && (am.dog === 'no' || facts.dogAllowed === false)) add('blocking', J, 'dog_refused', { name: nuit.name }, extra);
      if (nuit.info && nuit.info.max_height_m != null && nuit.info.max_height_m < settings.vehicle_height_m) {
        add('blocking', J, 'too_low', { name: nuit.name, max: num(nuit.info.max_height_m, L), height: num(settings.vehicle_height_m, L) }, extra);
      }
      if (nuit.info && nuit.info.max_length_m != null && nuit.info.max_length_m < settings.vehicle_length_m) {
        add('blocking', J, 'too_long', { name: nuit.name, max: num(nuit.info.max_length_m, L), length: num(settings.vehicle_length_m, L) }, extra);
      }
      if (nuit.info && nuit.info.max_weight_t != null && nuit.info.max_weight_t < settings.vehicle_weight_t) {
        add('blocking', J, 'too_heavy', { name: nuit.name, max: num(nuit.info.max_weight_t, L), weight: num(settings.vehicle_weight_t, L) }, extra);
      }
      // Every window the notes or the sheet state; an arrival inside any one of them is fine.
      const wins = [...rules.welcomeWindows(nuit.text), ...facts.arrivalWindows];
      const win = wins[0];
      if (win && arr != null && !wins.some((w) => arr >= w[0] && arr <= w[1])) add('blocking', J, 'welcome_window', { arr: hhmm(arr), name: nuit.name, open: hhmm(win[0]), close: hhmm(win[1]) }, extra);
      const mini = rules.minNights(nuit.text);
      if (mini && nuit.nights < mini) add('blocking', J, 'min_nights', { name: nuit.name, n: nuit.nights }, extra);
      // The price against the target and the ceiling, both in the trip's currency: a night
      // priced in another currency is not compared.
      const pv = nuit.currency === model.currency ? rules.priceVerdict(nuit.price, settings) : null;
      if (pv) add(pv.level, J, pv.key, { name: nuit.name, price: money(nuit.price, model.currency, L), max: money(settings.night_price_max, model.currency, L), target: money(settings.night_price_target, model.currency, L) }, extra);
      // No way to ask the host anything: no e-mail, phone, WhatsApp or own website (contacts.js).
      if (!contacts.hasContact(contacts.reachOf(nuit.info, (model.poolById.get(nuit.placeId) || {}).raw))) add('verify', J, 'night_no_contact', { name: nuit.name }, extra);
      const waiting = nightStatus.waitingDays(nightStatus.reservationFor(nuit, model.reservations), nuit.info, now);
      if (waiting != null && waiting > nightStatus.STALE_DAYS) add('verify', J, 'contact_stale', { name: nuit.name, n: waiting }, extra);
    }
    if (nuit) {
      // Entered amenities win over words in the notes. Every evening of a stay is a night; an
      // evening with no night planned is unknown, not a night with water: the count goes on.
      const am = nuit.info ? nuit.info.amenities : {};
      const dry = am.water === 'no' || (am.water !== 'yes' && rules.noWater(nuit.text));
      dryNights = dry ? dryNights + 1 : 0;
      if (dryNights >= 2) {
        const prev = model.days[d.index - 1];
        const planned = [d, prev].filter(Boolean).some((x) => x.notes.some((n) => /\b\d{1,3} ?l\b|bouteille|bottle|refill|remplir|bidon|jerrican/i.test(n)));
        add(planned ? 'info' : 'fix', J, planned ? 'water_ok' : 'water_fix', { n: dryNights, litres: settings.water_reserve_l }, ids);
      }
    }
  }

  await savings({ ctx, model, settings, add, L, deadline, dayLabel });

  // ---------- stale data: bookings, budget, to-dos ----------
  const unplanned = unplannedNights(model);
  const cites = (txt) => {
    const tn = norm(txt);
    return unplanned.filter(({ key }) => {
      const i = tn.indexOf(key);
      // "via X" / "towards X" is a route mention, not a booking of X.
      return i >= 0 && !/\b(par|via|by|vers|direction|towards)\s*$/.test(tn.slice(Math.max(0, i - 12), i));
    }).map(({ place }) => place.name);
  };
  const bookings = t(L, 'scope.bookings');
  const dayOfStay = (n) => findDay(model, { dayId: n.startDayId });
  const scopeOf = (d) => (d ? dayLabel(d) : bookings);
  const dayIds = (d) => (d ? { dayId: d.id, dayNumber: d.n } : {});
  for (const x of model.reservations || []) {
    const acc = model.nights.find((n) => x.accommodation_id != null && n.id === String(x.accommodation_id));
    const words = norm(x.title).split(/[^a-z0-9]+/).filter((w) => w.length >= 5);
    if (acc && words.length && !words.some((w) => norm(acc.name).includes(w))) add('fix', bookings, 'resa_mismatch', { title: x.title, name: acc.name }, { reservationId: x.id });
    // TREK confirms the booking it creates with an accommodation: a "confirmed" status with
    // no confirmation number is the usual sign nobody actually booked.
    // Only a hint now: the user sets a night booked from the place view or TREK's form, and a
    // farm on a donation has no confirmation number to give.
    if (nightStatus.isNightReservation(x) && x.status === 'confirmed' && !x.confirmation_number && !BOOKED_NOTE.test(norm(`${nightStatus.freeNotes(x.notes)} ${x.title || ''}`))) add('verify', bookings, 'resa_confirmed', { title: x.title }, { reservationId: x.id });
    // A confirmed booking whose notes still say it waits for an answer.
    if (nightStatus.staleWaitingNote(x)) add('fix', bookings, 'resa_note_stale', { title: x.title }, { reservationId: x.id });
  }
  for (const n of model.nights) {
    const res = nightStatus.reservationFor(n, model.reservations);
    const nd = dayOfStay(n);
    // A night whose booking is cancelled (no other booking of it standing) has nowhere to sleep.
    if (res && nightStatus.statusOf(res) === 'dropped') {
      add('fix', scopeOf(nd), 'night_cancelled', { name: n.name }, { reservationId: res.id, accommodationId: n.id, ...dayIds(nd) });
    }
    // The price the booking records (TREK's expense side) against the price the plan counts.
    const bp = res && nightStatus.statusOf(res) !== 'dropped' ? nightStatus.bookedPrice(res) : null;
    if (bp && n.stayCost != null && (bp.currency || n.currency) === n.currency && Math.abs(bp.amount - n.stayCost) > 1) {
      add('fix', scopeOf(nd), 'resa_price', { title: res.title || n.name, booked: money(bp.amount, n.currency, L), planned: money(n.stayCost, n.currency, L) }, { reservationId: res.id, placeId: n.placeId, ...dayIds(nd) });
    }
  }
  // A booking TREK shows as made, but tied to no night of the plan: nobody sleeps there. A
  // request still pending (a second host asked for the same evening) is a comparison, not a fault.
  for (const u of nightStatus.unlinkedBookings(model).filter((x) => nightStatus.statusOf(x.res) === 'booked')) {
    add('fix', scopeOf(u.day), 'resa_unlinked', { title: u.res.title || '', day: u.day ? u.day.n : '?' }, { reservationId: u.res.id, placeId: u.placeId, ...dayIds(u.day) });
  }
  const budgetScope = t(L, 'scope.budget');
  if (Array.isArray(model.costs)) {
    for (const b of model.costs) {
      const c = cites(b.name);
      if (c.length) add('fix', budgetScope, 'stale_budget', { name: b.name, list: c.join(', ') });
    }
    // Compared only when every night's price is known and in the trip's currency: a partial
    // total would ask for a wrong correction.
    const lodging = model.costs.filter((b) => /hebergement|hotel|accommodation|lodging|camping|nuit|night|alloggio|unterkunft/.test(norm(`${b.category || ''} ${b.name || ''}`)));
    const nm = nightStatus.nightsMoney(model);
    // A lodging line in another currency cannot be summed with the trip's money either.
    const sameMoney = lodging.every((b) => !b.currency || b.currency === model.currency);
    if (lodging.length && nm.complete && sameMoney) {
      const inBudget = lodging.reduce((s, b) => s + (+b.total_price || 0), 0);
      if (Math.abs(inBudget - nm.total) > 1) add('fix', budgetScope, 'budget_total', { budget: money(inBudget, model.currency, L), nights: money(nm.total, model.currency, L) });
    }
  }
  const todoScope = t(L, 'scope.todos');
  for (const td of (model.todos || []).filter((x) => !x.checked)) {
    const txt = `${td.name} ${td.description || ''}`;
    if (!/reserv|book|prenot|buchen/.test(norm(txt))) continue;
    const c = cites(txt);
    if (c.length) add('fix', todoScope, 'stale_todo', { name: td.name, list: c.join(', ') });
  }

  if (pending) add('info', model.trip.title || `#${model.tripId}`, 'route_pending', { n: pending });
  // Walks of the hikes: from one car park "P", back to the same P (walks.js).
  for (const w of require('./walks').hikeWalks(model)) {
    if (!w.problem) continue;
    const d = w.day != null ? findDay(model, { dayNumber: w.day }) : null;
    const scope = d ? dayLabel(d) : w.hike;
    const ids = { dayNumber: d ? d.n : null, placeId: w.hikeId };
    if (w.problem.key === 'no_parking') add('fix', scope, 'walk_no_parking', { hike: w.hike }, ids);
    else add('fix', scope, 'walk_parking_to_parking', { hike: w.hike, parking: w.access.name, other: w.problem.other }, ids);
  }

  findings.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || (a.dayNumber ?? 999) - (b.dayNumber ?? 999));
  const counts = Object.fromEntries(LEVELS.map((l) => [l, findings.filter((f) => f.level === l).length]));
  return { ok: counts.blocking === 0, counts, findings, pendingRoutes: pending };
}

module.exports = { checkTrip, dayPlan, carPos, isVisit, bookingNoted, LEVELS, nameKey };
