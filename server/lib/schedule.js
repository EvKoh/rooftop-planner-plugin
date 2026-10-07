'use strict';
// Times for one day, computed from real drive times (one source of truth: the day's
// stops). departure + drive → arrival; arrival + time on site → end; end + drive → next.
// The night must be reached `sunset_margin_min` before sunset; when it is not, the result
// says by how much and what would fix it. The plugin SDK cannot set a per-stop time, so the
// result lists the core `update_assignment_time` calls for the assistant to make.
// A place with timed access (a road closed after or before a set hour) moves the proposed
// departure, unless the caller gave one: then the miss is listed as a conflict.
const { hhmm, hm } = require('./util');
const { sunset } = require('./sun');
const { isHikePlace } = require('./design');
const rules = require('./rules');
const routing = require('./routing');
const { highwayAllowed } = require('./settings');
const { dayPlan, carPos } = require('./check');
const placeInfo = require('./place-info');
const { findDay } = require('./trip');
const { dayStopMinutes } = require('./visit');

const up5 = (m) => Math.ceil(m / 5) * 5;
// Time on site when nothing is known: listed in the result (assumedStays), never silent.
const DEFAULT_STAY = 60;
// A road that closes before the arrival is met by leaving earlier; one closed in between, by
// the smaller move.
const goesEarlier = (a) => a.key === 'access_late' || (a.key === 'access_window' && a.late <= a.wait);
const located = (p) => p && p.lat != null && p.lng != null;


/**
 * @param stays     { [assignmentId]: minutes } overrides of time on site
 * @param departure "HH:MM" leaving last night's place (default: keep the current first time, else the day_start setting)
 */
async function scheduleDay(ctx, model, ref, { settings, departure, stays = {}, deadline, network = true } = {}) {
  const day = findDay(model, ref);
  if (!day) throw new Error('day not found in this trip');
  const { veille, nuit, stops } = dayPlan(model, day);
  const tolls = highwayAllowed(settings, day.index, model.days.length);
  const visits = stops.filter((s) => !(nuit && s.accommodationId === nuit.id));

  // Where the car goes, in order: last night → each stop (on foot: the car waits) → tonight.
  const seq = [];
  let car = veille && located(veille) ? [veille.lat, veille.lng] : null;
  for (const s of visits) {
    if (!located(s.place)) { seq.push({ s, from: null, to: null }); continue; }
    const onFoot = isHikePlace(s.place) && car;
    const to = onFoot ? car : carPos(s);
    seq.push({ s, from: car, to });
    car = to;
  }
  const last = nuit && located(nuit) ? { from: car, to: [nuit.lat, nuit.lng] } : null;
  const pairs = seq.filter((x) => x.from && x.to).map((x) => [x.from, x.to]);
  if (last && last.from) pairs.push([last.from, last.to]);
  const r = await routing.legs(ctx, pairs, { ...routing.vehicleOpts(settings, tolls), deadline, network });
  let k = 0;
  const legMin = [];
  for (const x of seq) legMin.push(x.from && x.to ? r.values.get(k++)?.minutes ?? null : 0);
  const lastMin = last && last.from ? r.values.get(k++)?.minutes ?? null : null;

  const infoOf = (id) => ((model.poolById && model.poolById.get(id)) || {}).info || null;
  const asked = hm(departure);
  let t0 = asked;
  if (t0 == null) {
    const first = visits.find((s) => s.place.time != null);
    t0 = first && legMin[visits.indexOf(first)] != null ? first.place.time - legMin[visits.indexOf(first)] : hm(settings.day_start) ?? 9 * 60;
  }

  /** The day's times from a departure: the stops, the arrival at the night, the access verdicts. */
  const assumed = new Set();
  const timeline = (from) => {
    let tcur = from;
    const out = [];
    const access = [];
    visits.forEach((s, i) => {
      const drive = legMin[i];
      const arrive = drive == null ? null : up5(tcur + drive);
      // The caller's override, else the time on site the check counts (visit.js), else an
      // hour, listed in `assumedStays` so it is never silent.
      const info = infoOf(s.place.id);
      const known = stays[s.id] ?? dayStopMinutes(s, info, visits);
      const stay = known ?? DEFAULT_STAY;
      if (known == null) assumed.add(s.id);
      const start = arrive ?? s.place.time ?? tcur;
      const end = start + stay;
      const v = placeInfo.accessVerdict(info, arrive);
      if (v) access.push({ assignmentId: s.id, name: s.place.name, arrival: arrive, ...v });
      out.push({ assignmentId: s.id, placeId: s.place.id, name: s.place.name, driveMinutes: drive, start: hhmm(start), end: hhmm(end), stayMinutes: stay, s, startMin: start, endMin: end });
      tcur = end;
    });
    const arrival = nuit && lastMin != null ? up5(tcur + lastMin) : null;
    const v = nuit ? placeInfo.accessVerdict(nuit.info, arrival) : null;
    if (v) access.push({ assignmentId: null, name: nuit.name, arrival, ...v });
    return { out, arrival, access };
  };

  /**
   * How far to move the departure so every timed access is met: earlier when a road closes
   * before the arrival, later when it opens after it; for a road closed in between, the
   * smaller of the two. 0 when nothing to move (or the two needs contradict each other).
   */
  const shiftFor = (access) => {
    let earlier = 0;
    let later = 0;
    for (const a of access) {
      if (goesEarlier(a)) earlier = Math.max(earlier, a.late);
      else later = Math.max(later, a.wait);
    }
    if (earlier && later) return 0;
    return earlier ? -up5(earlier) : up5(later);
  };

  let plan = timeline(t0);
  let accessShift = 0;
  if (asked == null) {
    // Rounding to 5 min can leave a few minutes over: try again, at most three times.
    for (let k = 0; k < 3 && plan.access.length; k++) {
      const d = shiftFor(plan.access);
      if (!d) break;
      accessShift += d;
      t0 += d;
      plan = timeline(t0);
    }
  }
  const conflicts = [];
  const out = plan.out.map(({ s, startMin, endMin, ...x }) => {
    if (day.wd != null) {
      for (const c of rules.closures(`${s.place.description}\n${s.place.notes}\n${s.notes}`, day.wd, startMin, endMin, { placeName: s.place.name })) {
        if (c.level === 'blocking') conflicts.push({ assignmentId: s.id, name: s.place.name, reason: `outside opening hours ${hhmm(c.params.open)}-${hhmm(c.params.close)}` });
      }
    }
    return x;
  });
  for (const a of plan.access) {
    const fix = !goesEarlier(a) ? `leave ${a.wait} min later (departure ${hhmm(t0 + up5(a.wait))})` : `leave ${a.late} min earlier (departure ${hhmm(t0 - up5(a.late))})`;
    const what = a.key === 'access_late' ? `arrival ${hhmm(a.arrival)}, road closed after ${hhmm(a.before)}`
      : a.key === 'access_early' ? `arrival ${hhmm(a.arrival)}, cars allowed only after ${hhmm(a.after)}`
        : `arrival ${hhmm(a.arrival)}, road closed to cars ${hhmm(a.before)}-${hhmm(a.after)}`;
    conflicts.push({ assignmentId: a.assignmentId, name: a.name, reason: `${what}: ${fix}`, access: a.key });
  }
  // Timed access of each stop, as the schedule meets it.
  const access = [...visits.map((s) => ({ s, info: infoOf(s.place.id) })), ...(nuit ? [{ s: null, info: nuit.info }] : [])]
    .filter(({ info }) => info && (info.access_before || info.access_after))
    .map(({ s, info }) => {
      const arrival = s ? hm(out.find((x) => x.assignmentId === s.id).start) : plan.arrival;
      return { name: s ? s.place.name : nuit.name, accessBefore: info.access_before, accessAfter: info.access_after, arrival: hhmm(arrival), ok: arrival == null ? null : !placeInfo.accessVerdict(info, arrival) };
    });

  let night = null;
  if (nuit) {
    const arrival = plan.arrival;
    const cs = located(nuit) && day.date ? sunset(nuit.lat, nuit.lng, day.date, settings.timezone) : null;
    const latest = cs == null ? null : Math.floor(rules.latestArrival(cs, settings));
    const lateBy = arrival != null && latest != null ? Math.max(0, Math.ceil(arrival - latest)) : null;
    night = {
      name: nuit.name, assignmentId: day.assignments.find((a) => a.accommodationId === nuit.id)?.id ?? null,
      driveMinutes: lastMin, arrival: hhmm(arrival), sunset: hhmm(cs), latestArrival: hhmm(latest), ok: lateBy == null ? null : lateBy === 0, lateByMinutes: lateBy,
    };
    if (lateBy) {
      night.fixes = [
        `leave ${lateBy} min earlier (departure ${hhmm(t0 - lateBy)})`,
        `shorten the visits by ${lateBy} min in total`,
        'or choose a night closer to the last visit (vanlife_find_nights)',
      ];
    }
  }

  const coreCalls = out.filter((x) => x.start != null).map((x) => ({
    tool: 'update_assignment_time', args: { tripId: model.tripId, assignmentId: x.assignmentId, place_time: x.start, end_time: x.end },
  }));
  if (night && night.assignmentId && night.arrival) {
    coreCalls.push({ tool: 'update_assignment_time', args: { tripId: model.tripId, assignmentId: night.assignmentId, place_time: night.arrival } });
  }
  return {
    day: { id: day.id, number: day.n, date: day.date },
    departure: hhmm(t0),
    // Minutes the departure was moved to meet a timed access (negative = earlier); 0 when none.
    departureMovedForAccess: accessShift,
    access,
    motorway: tolls,
    stops: out,
    night,
    conflicts,
    ...(assumed.size ? { assumedStays: { minutes: DEFAULT_STAY, assignmentIds: [...assumed], note: 'Time on site unknown: an hour assumed. Record it with vanlife_place set.visit.' } } : {}),
    pendingRoutes: r.pending,
    coreCalls,
  };
}

module.exports = { scheduleDay };
