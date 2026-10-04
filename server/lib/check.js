'use strict';
// The full trip check (the `vanlife_check_trip` tool, the warnings banner and the tab
// all read it). Two passes: first collect every drive leg the rules need and resolve them
// in one batch (cache, then a Valhalla matrix), then evaluate the rules day by day.
// It never writes anything. Levels: blocking > fix > verify > info.
const { hhmm, hm, distKm, norm } = require('./util');
const { t, dayName, money, num, clock } = require('./i18n');
const placeInfo = require('./place-info');
const { sunset } = require('./sun');
const { isShopping, isHike, isTrace, isNightCategory, parkingFromNotes } = require('./classify');
const rules = require('./rules');
const routing = require('./routing');
const { highwayAllowed, fuelPerKm } = require('./settings');
const { stopMinutes } = require('./visit');
const { nightOf, nightBefore, nameKey, unplannedNights } = require('./trip');
const contacts = require('./contacts');
const nightStatus = require('./night-status');

const LEVELS = ['blocking', 'fix', 'verify', 'info'];

/** Zone name and legal note of a legality finding, in language L (texts live in the catalogues). */
function zoneText(L, p) {
  const id = p.zoneId || 'unknown';
  return { zone: t(L, `zone.${id}.name`), note: t(L, `zone.${id}.${p.rule}`) };
}
const fmtDur = (m) => (m == null ? '—' : `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')}`);
const located = (p) => p && p.lat != null && p.lng != null;
const pos = (p) => [p.lat, p.lng];

/** The stops of a day that the car drives between, with where the car actually goes. */
function dayPlan(model, day) {
  const veille = nightBefore(model, day);
  const nuit = nightOf(model, day);
  const trace = day.assignments.find((a) => isTrace(a.place.categoryName, a.place));
  const stops = day.assignments.filter((a) => a !== trace && !(veille && a.accommodationId === veille.id && (!nuit || veille.id !== nuit.id)));
  return { veille, nuit, trace, stops };
}

function carPos(stop) {
  return parkingFromNotes(stop.place.notes, stop.place.description) || pos(stop.place);
}

// A stop that is a visit (not shopping, not a night): what the day's load counts.
const isVisit = (p) => !isShopping(p.categoryName, p.stopType) && !isNightCategory(p.categoryName);
const MEAL_MIN = 30;
const LONG_DAY_MIN = 6 * 60;
const SMALL_MIN = 60;
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
  stops.forEach((s, i) => {
    const leg = legIdx[i];
    if (leg && leg.drive != null) { const m = M(leg.drive); if (m == null) complete = false; else drive += m; }
    if (nuit && s.accommodationId === nuit.id) return;
    const info = (model.poolById.get(s.place.id) || {}).info || null;
    visits.push({ s, minutes: stopMinutes(s.place, info), visit: isVisit(s.place) });
  });
  if (toNight != null) { const m = M(toNight); if (m == null) complete = false; else drive += m; }
  const unknown = visits.filter((v) => v.visit && v.minutes == null).map((v) => v.s.place.name);
  if (unknown.length) add('verify', J, 'visit_unknown', { list: unknown.join(', ') }, ids);

  const acts = visits.filter((v) => v.visit && v.minutes != null);
  const big = settings.big_activity_minutes;
  const load = acts.reduce((n, v) => n + (v.minutes <= STOP_MIN ? 0 : v.minutes <= SMALL_MIN ? 0.5 : 1), 0);
  if (load > 1) {
    add('fix', J, 'too_many_activities', { list: acts.filter((v) => v.minutes > STOP_MIN).map((v) => `${v.s.place.name} (${fmtDur(v.minutes)})`).join(', '), big: fmtDur(big), small: fmtDur(SMALL_MIN), nBig: acts.filter((v) => v.minutes >= big).length }, ids);
  }

  if (!complete || !nuit || !located(nuit) || !d.date) return;
  const cs = sunset(nuit.lat, nuit.lng, d.date, tz);
  const to = rules.latestArrival(cs, settings);
  if (to == null) return;
  const times = stops.map((s) => s.place.time).filter((x) => x != null);
  const from = Math.min(hm(settings.day_start) ?? 510, ...times);
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
const BOOKED_NOTE = /\b(booked|reserved|reservation|confirmation|confirmed|ticket|reserve|prenotat|gebucht|reserviert|buchung)/;

/** Is a booking of this place recorded: a TREK booking confirmed or with a number, or words in the stop's notes? */
function bookingNoted(model, placeId, notes) {
  const res = (model.reservations || []).some((r) => {
    const id = r.accommodation_place_id ?? r.place_id ?? null;
    return id != null && Number(id) === Number(placeId) && r.status !== 'cancelled' && (r.status === 'confirmed' || !!r.confirmation_number);
  });
  return res || BOOKED_NOTE.test(norm(notes));
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

/** The night whose evening is day `d` (a stay over several nights included), or null. */
function campOf(model, dayIndex) {
  const idx = (id) => (model.days.find((x) => x.id === id) || {}).index;
  return model.nights.find((n) => idx(n.startDayId) <= dayIndex && dayIndex < idx(n.endDayId)) || null;
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
    const nuit = nightOf(model, d);
    if (!nuit || nuit.price == null || nuit.price <= settings.night_price_target) continue;
    if (deadline && deadline.left() < 1500) break;
    let r;
    try {
      r = await findNightsForDay(ctx, model, { dayId: d.id, sources: ['osm'] }, { settings, deadline, network: false });
    } catch { continue; }
    const best = r.candidates
      .filter((c) => !c.blocked.length && !c.legalRisk && c.openOnDate !== 'closed' && c.price != null && c.price < nuit.price && c.detourMinutes != null && c.detourMinutes <= 20)
      .map((c) => ({ c, net: Math.round((nuit.price - c.price - Math.max(0, c.detourKm || 0) * perKm) * 100) / 100 }))
      .filter((x) => x.net > 0)
      .sort((a, b) => b.net - a.net)[0];
    if (best) {
      add('verify', dayLabel(d), 'saving_night', {
        name: nuit.name, current: money(nuit.price, cur, L), alt: best.c.name, price: money(best.c.price, cur, L), detour: best.c.detourMinutes, saving: money(best.net, cur, L),
      }, { dayId: d.id, dayNumber: d.n, placeId: nuit.placeId, savingAmount: best.net });
    }
  }
  for (const d of model.days) {
    const next = model.days[d.index + 1];
    const camp = campOf(model, d.index);
    const before = campOf(model, d.index - 1);
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
  const add = (level, scope, key, params = {}, extra = {}) => {
    findings.push({ level, key, scope, message: `${scope} — ${t(L, key, params)}`, params, ...extra });
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
      const onFoot = isHike(s.place.categoryName);
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

    if (anyTrace && (veille || nuit)) {
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
        for (const c of rules.closures(text, d.wd, start, end, { placeName: p.name, isNight: !!isTonight || isNightCategory(p.categoryName) })) {
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

    if (nuit) {
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
      if (legal) add(legal.level, J, legal.key, { name: nuit.name, ...zoneText(L, legal.params) }, extra);
      const am = nuit.info ? nuit.info.amenities : {};
      // A tent ban only matters to a rooftop tent: a van or a motorhome deploys nothing.
      const banned = settings.vehicle !== 'rooftop_tent' ? null : am.rooftop_tent === 'no' ? 'rooftop_tent = no' : rules.tentBanned(nuit.text);
      if (banned) add('blocking', J, 'tent_banned', { name: nuit.name, quote: banned }, extra);
      if (settings.dog && am.dog === 'no') add('blocking', J, 'dog_refused', { name: nuit.name }, extra);
      if (nuit.info && nuit.info.max_height_m != null && nuit.info.max_height_m < settings.vehicle_height_m) {
        add('blocking', J, 'too_low', { name: nuit.name, max: num(nuit.info.max_height_m, L), height: num(settings.vehicle_height_m, L) }, extra);
      }
      if (nuit.info && nuit.info.max_length_m != null && nuit.info.max_length_m < settings.vehicle_length_m) {
        add('blocking', J, 'too_long', { name: nuit.name, max: num(nuit.info.max_length_m, L), length: num(settings.vehicle_length_m, L) }, extra);
      }
      if (nuit.info && nuit.info.max_weight_t != null && nuit.info.max_weight_t < settings.vehicle_weight_t) {
        add('blocking', J, 'too_heavy', { name: nuit.name, max: num(nuit.info.max_weight_t, L), weight: num(settings.vehicle_weight_t, L) }, extra);
      }
      const win = rules.welcomeWindow(nuit.text);
      if (win && arr != null && (arr < win[0] || arr > win[1])) add('blocking', J, 'welcome_window', { arr: hhmm(arr), name: nuit.name, open: hhmm(win[0]), close: hhmm(win[1]) }, extra);
      const mini = rules.minNights(nuit.text);
      if (mini && nuit.nights < mini) add('blocking', J, 'min_nights', { name: nuit.name, n: nuit.nights }, extra);
      if (nuit.startDayId === d.id) {
        const pv = rules.priceVerdict(nuit.price, settings);
        const cur = model.currency;
        if (pv) add(pv.level, J, pv.key, { name: nuit.name, price: money(nuit.price, cur, L), max: money(settings.night_price_max, cur, L), target: money(settings.night_price_target, cur, L) }, extra);
        // No way to ask the host anything: no e-mail, no phone (plugin record or TREK's field).
        if (!contacts.hasContact(nuit.info && nuit.info.contacts) && !nuit.nativePhone) add('verify', J, 'night_no_contact', { name: nuit.name }, extra);
        const waiting = nightStatus.waitingDays(nightStatus.reservationFor(nuit, model.reservations), nuit.info, now);
        if (waiting != null && waiting > nightStatus.STALE_DAYS) add('verify', J, 'contact_stale', { name: nuit.name, n: waiting }, extra);
      }
      // Entered amenities win over words in the notes.
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
  for (const x of model.reservations || []) {
    const acc = model.nights.find((n) => x.accommodation_id != null && n.id === String(x.accommodation_id));
    const words = norm(x.title).split(/[^a-z0-9]+/).filter((w) => w.length >= 5);
    if (acc && words.length && !words.some((w) => norm(acc.name).includes(w))) add('fix', bookings, 'resa_mismatch', { title: x.title, name: acc.name }, { reservationId: x.id });
    // TREK confirms the booking it creates with an accommodation: a "confirmed" status with
    // no confirmation number is the usual sign nobody actually booked.
    if (x.status === 'confirmed' && !x.confirmation_number) add('blocking', bookings, 'resa_confirmed', { title: x.title }, { reservationId: x.id });
  }
  const budgetScope = t(L, 'scope.budget');
  if (Array.isArray(model.costs)) {
    for (const b of model.costs) {
      const c = cites(b.name);
      if (c.length) add('fix', budgetScope, 'stale_budget', { name: b.name, list: c.join(', ') });
    }
    const lodging = model.costs.filter((b) => /hebergement|hotel|accommodation|lodging|camping|nuit|night|alloggio|unterkunft/.test(norm(`${b.category || ''} ${b.name || ''}`)));
    if (lodging.length) {
      const inBudget = lodging.reduce((s, b) => s + (+b.total_price || 0), 0);
      const planned = model.nights.reduce((s, n) => s + (n.price || 0) * n.nights, 0);
      if (Math.abs(inBudget - planned) > 1) add('fix', budgetScope, 'budget_total', { budget: money(inBudget, model.currency, L), nights: money(planned, model.currency, L) });
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
  findings.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || (a.dayNumber ?? 999) - (b.dayNumber ?? 999));
  const counts = Object.fromEntries(LEVELS.map((l) => [l, findings.filter((f) => f.level === l).length]));
  return { ok: counts.blocking === 0, counts, findings, pendingRoutes: pending };
}

module.exports = { checkTrip, dayPlan, carPos, campOf, isVisit, bookingNoted, LEVELS, nameKey };
