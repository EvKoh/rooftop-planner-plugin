'use strict';
// The full trip check (the `rooftop_tools_check_trip` tool, the warnings banner and the tab
// all read it). Two passes: first collect every drive leg the rules need and resolve them
// in one batch (cache, then a Valhalla matrix), then evaluate the rules day by day.
// It never writes anything. Levels: blocking > fix > verify > info.
const { hhmm, distKm, norm } = require('./util');
const { t, dayName } = require('./i18n');
const { sunset } = require('./sun');
const { isShopping, isHike, isTrace, isNightCategory, parkingFromNotes } = require('./classify');
const rules = require('./rules');
const routing = require('./routing');
const { highwayAllowed } = require('./settings');
const { nightOf, nightBefore, nameKey, unplannedNights } = require('./trip');

const LEVELS = ['blocking', 'fix', 'verify', 'info'];
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

async function checkTrip(ctx, model, { settings, network = true, deadline, lang } = {}) {
  const L = lang || settings.language;
  const findings = [];
  const dayLabel = (d) => t(L, 'day', { n: d.n, date: d.date || '?' });
  const add = (level, scope, key, params = {}, extra = {}) => {
    findings.push({ level, key, scope, message: `${scope} — ${t(L, key, params)}`, ...extra });
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
    return { day: d, plan, tolls, legIdx };
  });
  const byTolls = [true, false].map((tolls) => pairs.map((p, i) => [p, i]).filter(([p]) => p.tolls === tolls));
  const minutes = new Array(pairs.length).fill(null);
  let pending = 0;
  for (const group of byTolls) {
    if (!group.length) continue;
    const r = await routing.legs(ctx, group.map(([p]) => [p.a, p.b]), { tolls: group[0][0].tolls, height: settings.vehicle_height_m, network, deadline });
    group.forEach(([, i], j) => { const v = r.values.get(j); minutes[i] = v ? v.minutes : null; });
    pending += r.pending;
  }
  const M = (i) => (i == null ? null : minutes[i]);

  // ---------- pass 2: rules, day by day ----------
  const anyTrace = model.days.some((d) => d.assignments.some((a) => isTrace(a.place.categoryName, a.place)));
  let dryNights = 0;
  for (const { day: d, plan, legIdx } of plans) {
    const J = dayLabel(d);
    const ids = { dayId: d.id, dayNumber: d.n };
    const { veille, nuit, trace, stops } = plan;

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
      if (start == null) {
        if (!isTonight) add('fix', J, 'no_time', { name: p.name }, extra);
        prec = { name: p.name, end: null };
        return;
      }
      if (end != null && end < start) add('fix', J, 'ends_before_start', { name: p.name, start: hhmm(start), end: hhmm(end) }, extra);
      const leg = legIdx[i];
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

      const legal = rules.nightLegality({ categoryName: nuit.categoryName, placeName: nuit.name, lat: nuit.lat, lng: nuit.lng, text: nuit.text });
      if (legal) add(legal.level, J, legal.key, { name: nuit.name, ...legal.params }, extra);
      const banned = rules.tentBanned(nuit.text);
      if (banned) add('blocking', J, 'tent_banned', { name: nuit.name, quote: banned }, extra);
      const win = rules.welcomeWindow(nuit.text);
      if (win && arr != null && (arr < win[0] || arr > win[1])) add('blocking', J, 'welcome_window', { arr: hhmm(arr), name: nuit.name, open: hhmm(win[0]), close: hhmm(win[1]) }, extra);
      const mini = rules.minNights(nuit.text);
      if (mini && nuit.nights < mini) add('blocking', J, 'min_nights', { name: nuit.name, n: nuit.nights }, extra);
      if (nuit.startDayId === d.id) {
        const pv = rules.priceVerdict(nuit.price, settings);
        if (pv) add(pv.level, J, pv.key, { name: nuit.name, price: nuit.price, max: settings.night_price_max, target: settings.night_price_target }, extra);
      }
      dryNights = rules.noWater(nuit.text) ? dryNights + 1 : 0;
      if (dryNights >= 2) {
        const prev = model.days[d.index - 1];
        const planned = [d, prev].filter(Boolean).some((x) => x.notes.some((n) => /\b\d{1,3} ?l\b|bouteille|bottle|refill|remplir|bidon|jerrican/i.test(n)));
        add(planned ? 'info' : 'fix', J, planned ? 'water_ok' : 'water_fix', { n: dryNights, litres: settings.water_reserve_l }, ids);
      }
    }
  }

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
      if (Math.abs(inBudget - planned) > 1) add('fix', budgetScope, 'budget_total', { budget: inBudget.toFixed(2), nights: planned.toFixed(2) });
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

module.exports = { checkTrip, dayPlan, carPos, LEVELS, nameKey };
