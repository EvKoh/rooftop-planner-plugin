'use strict';
// Times for one day, computed from real drive times (one source of truth: the day's
// stops). departure + drive → arrival; arrival + time on site → end; end + drive → next.
// The night must be reached `sunset_margin_min` before sunset; when it is not, the result
// says by how much and what would fix it. The plugin SDK cannot set a per-stop time, so the
// result lists the core `update_assignment_time` calls for the assistant to make.
const { hhmm, hm } = require('./util');
const { sunset } = require('./sun');
const { isHike } = require('./classify');
const rules = require('./rules');
const routing = require('./routing');
const { highwayAllowed } = require('./settings');
const { dayPlan, carPos } = require('./check');

const up5 = (m) => Math.ceil(m / 5) * 5;
const located = (p) => p && p.lat != null && p.lng != null;

function findDay(model, { dayId, dayNumber, date }) {
  return model.days.find((d) => (dayId != null && d.id === dayId) || (dayNumber != null && d.n === dayNumber) || (date && d.date === date)) || null;
}

/**
 * @param stays     { [assignmentId]: minutes } overrides of time on site
 * @param departure "HH:MM" leaving last night's place (default: keep the current first time, else 09:00)
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
    const onFoot = isHike(s.place.categoryName) && car;
    const to = onFoot ? car : carPos(s);
    seq.push({ s, from: car, to });
    car = to;
  }
  const last = nuit && located(nuit) ? { from: car, to: [nuit.lat, nuit.lng] } : null;
  const pairs = seq.filter((x) => x.from && x.to).map((x) => [x.from, x.to]);
  if (last && last.from) pairs.push([last.from, last.to]);
  const r = await routing.legs(ctx, pairs, { tolls, height: settings.vehicle_height_m, deadline, network });
  let k = 0;
  const legMin = [];
  for (const x of seq) legMin.push(x.from && x.to ? r.values.get(k++)?.minutes ?? null : 0);
  const lastMin = last && last.from ? r.values.get(k++)?.minutes ?? null : null;

  let t0 = hm(departure);
  if (t0 == null) {
    const first = visits.find((s) => s.place.time != null);
    t0 = first && legMin[visits.indexOf(first)] != null ? first.place.time - legMin[visits.indexOf(first)] : 9 * 60;
  }
  let tcur = t0;
  const out = [];
  const conflicts = [];
  visits.forEach((s, i) => {
    const drive = legMin[i];
    const arrive = drive == null ? null : up5(tcur + drive);
    const current = s.place.end != null && s.place.time != null ? s.place.end - s.place.time : null;
    const stay = stays[s.id] ?? current ?? s.place.duration ?? 60;
    const start = arrive ?? s.place.time ?? tcur;
    const end = start + stay;
    if (day.wd != null) {
      for (const c of rules.closures(`${s.place.description}\n${s.place.notes}\n${s.notes}`, day.wd, start, end, { placeName: s.place.name })) {
        if (c.level === 'blocking') conflicts.push({ assignmentId: s.id, name: s.place.name, reason: `outside opening hours ${hhmm(c.params.open)}-${hhmm(c.params.close)}` });
      }
    }
    out.push({ assignmentId: s.id, placeId: s.place.id, name: s.place.name, driveMinutes: drive, start: hhmm(start), end: hhmm(end), stayMinutes: stay });
    tcur = end;
  });

  let night = null;
  if (nuit) {
    const arrival = lastMin == null ? null : up5(tcur + lastMin);
    const cs = located(nuit) && day.date ? sunset(nuit.lat, nuit.lng, day.date, settings.timezone) : null;
    const latest = cs == null ? null : Math.floor(rules.latestArrival(cs, settings));
    const lateBy = arrival != null && latest != null ? Math.max(0, Math.ceil(arrival - latest)) : null;
    night = {
      name: nuit.name, assignmentId: day.assignments.find((a) => a.accommodationId === nuit.id)?.id ?? null,
      driveMinutes: lastMin, arrival: hhmm(arrival), sunset: hhmm(cs), latestArrival: hhmm(latest), ok: lateBy === 0, lateByMinutes: lateBy,
    };
    if (lateBy) {
      night.fixes = [
        `leave ${lateBy} min earlier (departure ${hhmm(t0 - lateBy)})`,
        `shorten the visits by ${lateBy} min in total`,
        'or choose a night closer to the last visit (rooftop_tools_find_nights)',
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
    motorway: tolls,
    stops: out,
    night,
    conflicts,
    pendingRoutes: r.pending,
    coreCalls,
  };
}

module.exports = { scheduleDay, findDay };
