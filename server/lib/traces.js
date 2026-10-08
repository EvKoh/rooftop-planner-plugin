'use strict';
// Road geometry of each day: last night → the day's stops (where the car goes) → tonight.
// TREK draws a place's `route_geometry` as a line on the map, so a "Route day N" place
// carries the day's road. A place's geometry cannot be updated through the plugin API, so
// applying a new route RECREATES the place (create + assign + delete the old one). The SDK
// cannot reorder a day either: the result lists the core `reorder_day_assignments` call that
// puts the route first (otherwise TREK draws a straight line to the morning start).
const { pmap, norm, durationText } = require('./util');
const routing = require('./routing');
const { highwayAllowed } = require('./settings');
const { dayPlan, carPos } = require('./check');
const { findDay } = require('./trip');
const { isHikePlace } = require('./design');
const { t, num } = require('./i18n');

const located = (p) => p && p.lat != null && p.lng != null;
const COLORS = ['#059669', '#c026d3', '#0891b2', '#e11d48', '#d97706', '#65a30d', '#7c3aed', '#2563eb'];

function waypoints(model, day) {
  const { veille, nuit, stops } = dayPlan(model, day);
  const pts = [];
  const names = [];
  const push = (p, n) => {
    const last = pts[pts.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) { pts.push(p); names.push(n); }
  };
  if (veille && located(veille)) push([veille.lat, veille.lng], veille.name);
  for (const s of stops) {
    if (!located(s.place) || (nuit && s.accommodationId === nuit.id)) continue;
    if (isHikePlace(s.place) && pts.length) continue; // on foot: the car waits
    push(carPos(s), s.place.name);
  }
  if (nuit && located(nuit)) push([nuit.lat, nuit.lng], nuit.name);
  return { pts: pts.slice(0, 30), names: names.slice(0, 30) };
}

function routeCategoryId(model) {
  // Always the day-route category: the old line may have been a place of another category.  // The day-route category as classify recognises it (classify.RE.trace), never a bare "route":
  // a user's "Hiking route" is a hike category, and the plugin would read its own line as a hike.
  const c = (model.categories || []).find((x) => require('./classify').RE.trace.test(norm(x.name)));
  return c ? c.id : null;
}

/**
 * @param o.days   day refs ({dayNumber}) to route; default every day
 * @param o.apply  write the route places (default false: propose only)
 * @param o.startAt index in the day list to resume from (continuation)
 */
async function computeRoutes(ctx, model, o, { settings, deadline, network = true }) {
  const all = o.days && o.days.length ? o.days.map((r) => findDay(model, r)).filter(Boolean) : model.days;
  const days = all.slice(o.startAt || 0);
  const results = [];
  let next = null;
  await pmap(days, 2, async (day, i) => {
    if (next != null && i >= next) return;
    if (deadline && deadline.left() < 5000) { next = next == null ? i : Math.min(next, i); return; }
    const { pts, names } = waypoints(model, day);
    if (pts.length < 2) { results[i] = { day: { id: day.id, number: day.n, date: day.date }, skipped: 'fewer than 2 located points' }; return; }
    const motorway = highwayAllowed(settings, day.index, model.days.length);
    if (network === false) { results[i] = { day: { id: day.id, number: day.n }, skipped: 'network disabled' }; return; }
    try {
      const r = await routing.route(pts, { ...routing.vehicleOpts(settings, motorway), maxPoints: 800, timeoutMs: deadline ? Math.min(12000, deadline.left() - 2000) : 12000 });
      results[i] = { day: { id: day.id, number: day.n, date: day.date }, from: names[0], to: names[names.length - 1], via: names.slice(1, -1), motorway, km: r.km, minutes: r.minutes, drive: durationText(r.minutes, settings.language), legs: r.legs, points: r.points };
    } catch (e) {
      results[i] = { day: { id: day.id, number: day.n }, error: String(e.message || e) };
    }
  });
  const done = results.filter(Boolean);
  const writes = [];
  const coreCalls = [];
  if (o.apply) {
    for (const r of done.filter((x) => x.points)) {
      const day = findDay(model, { dayId: r.day.id });
      const { trace } = dayPlan(model, day);
      const old = trace ? model.poolById.get(trace.place.id) : null;
      const place = await ctx.places.create(model.tripId, {
        // In the user's language, like every text a person reads in TREK.
        name: t(settings.language, 'route.name', { n: day.n, from: r.from, to: r.to, km: Math.round(r.km), drive: r.drive }).slice(0, 200),
        // Pinned halfway along the line, not on its first point: that point is the previous
        // night, and a route pin there hides the lodging under a cluster at every zoom.
        lat: r.points[Math.floor(r.points.length / 2)][0], lng: r.points[Math.floor(r.points.length / 2)][1],
        route_geometry: JSON.stringify(r.points),
        route_color: old?.raw?.route_color || COLORS[day.index % COLORS.length],
        category_id: routeCategoryId(model),
        notes: t(settings.language, 'route.notes', {
          mode: t(settings.language, r.motorway ? 'route.mode.motorway' : 'route.mode.notolls'),
          height: num(settings.vehicle_height_m, settings.language),
          legs: r.legs.map((l) => t(settings.language, 'route.leg', { km: num(l.km, settings.language, 1), time: durationText(l.minutes, settings.language) })).join('; '),
        }).slice(0, 2000),
      });
      const asg = await ctx.itinerary.assign(model.tripId, day.id, place.id, null);
      // The old line goes only when it is the plugin's kind of place (the day-route category, or
      // none): a drawn line filed in a user's category (a bike ride from a GPX) is theirs, kept.
      // A line with no category is the plugin's only when the trip has no day-route category (the
      // plugin files its lines there when there is one): otherwise it is a user's import, kept.
      const ownLine = old && (require('./classify').RE.trace.test(norm(old.categoryName || '')) || (!old.categoryId && routeCategoryId(model) == null));
      if (ownLine) await ctx.places.delete(model.tripId, old.id);
      writes.push({ day: day.n, createdPlaceId: place.id, assignmentId: asg.id, deletedPlaceId: ownLine ? old.id : null, ...(old && !ownLine ? { kept: `place ${old.id} ("${old.name}") is filed as "${old.categoryName || 'no category'}": kept; remove it in TREK if it was an old route` } : {}) });
      // Only the deleted line leaves the order: a kept line (a user's) stays, after the new trace.
      const rest = day.assignments.filter((a) => !(ownLine && a === trace)).map((a) => a.id);
      coreCalls.push({ tool: 'reorder_day_assignments', args: { tripId: model.tripId, dayId: day.id, assignmentIds: [asg.id, ...rest] }, why: 'put the route first, or TREK draws a straight line to the morning start' });
    }
  }
  for (const r of done) delete r.points; // geometry is written to TREK, not sent to the assistant
  return {
    applied: !!o.apply,
    days: done,
    totalKm: Math.round(done.reduce((s, r) => s + (r.km || 0), 0)),
    writes,
    coreCalls,
    continuation: next != null ? { startAt: (o.startAt || 0) + next } : null,
    note: o.apply ? 'Route places recreated. Make the core calls listed, then re-run the check.' : 'Proposal only (apply=false). Call again with apply=true to write the route places.',
  };
}

module.exports = { routeCategoryId, computeRoutes, waypoints };
