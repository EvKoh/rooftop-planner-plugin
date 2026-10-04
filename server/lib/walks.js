'use strict';
// Hikes on the map. Each hike is tied to the car park that gives access to it, and its walking
// route is drawn DOTTED from that car park (design.WALK_LINE): the only dotted line the plugin
// draws. The car park, in order of trust:
//   1. the one the user set on the hike (place record, access_parking_place_id);
//   2. a car park planned the same day right before or after the hike (within 5 km);
//   3. the nearest car park planned the same day within 3 km, then any day within 2 km;
//   4. a "Start/Departure/Parking … lat, lng" line in the hike's notes (a point, no place).
// A hike that is not planned still shows when the user tied it to a planned car park.
// The route itself: Valhalla on footpaths, car park → points of the walk (walk_via) → the hike
// (→ back to the car park for a loop), cached in db:own. The map hook reads the cache and
// computes what is missing only while its 5 s budget allows; the place tool fills it.

const { activityKind, WALK_LINE, TONE } = require('./design');
const { distKm, roundPt, pmap } = require('./util');
const { parkingFromNotes, isTrace } = require('./classify');
const routing = require('./routing');
const cache = require('./cache');
const { t, num } = require('./i18n');

const ADJACENT_KM = 5;
const SAME_DAY_KM = 3;
const ANY_DAY_KM = 2;
const SAME_POINT_KM = 0.05;
const MAX_WALKS = 60;

const pt = (p) => [p.lat, p.lng];

/** Located, non-night, non-route stops of the plan: { place, day, i, kind }. */
function plannedStops(model) {
  const nightIds = new Set(model.nights.map((n) => n.placeId));
  const out = [];
  for (const d of model.days) {
    d.assignments.forEach((a, i) => {
      const p = a.place;
      if (p.lat == null || p.lng == null || nightIds.has(p.id) || isTrace(p.categoryName, p)) return;
      out.push({ place: p, day: d, i, kind: activityKind(p) });
    });
  }
  return out;
}

const nearest = (list, p, maxKm) => list
  .map((s) => ({ s, km: distKm(pt(s.place), pt(p)) }))
  .filter((x) => x.km <= maxKm)
  .sort((a, b) => a.km - b.km)[0]?.s || null;

/** The car park of a planned hike: { place?, point, how: set|plan|near|notes } or null. */
function accessFor(model, stop, info, parkings) {
  const hike = stop.place;
  const setId = info && info.access_parking_place_id;
  const set = setId ? model.poolById.get(setId) : null;
  if (set && set.lat != null) return { place: set, point: pt(set), how: 'set' };
  const sameDay = parkings.filter((s) => s.day.id === stop.day.id);
  const adjacent = nearest(sameDay.filter((s) => Math.abs(s.i - stop.i) === 1), hike, ADJACENT_KM);
  const found = adjacent || nearest(sameDay, hike, SAME_DAY_KM) || nearest(parkings, hike, ANY_DAY_KM);
  if (found) return { place: found.place, point: pt(found.place), how: 'plan' };
  const raw = model.poolById.get(hike.id);
  const fromNotes = parkingFromNotes(hike.description, hike.notes, raw && raw.description, raw && raw.notes);
  return fromNotes ? { point: fromNotes, how: 'notes' } : null;
}

/** The points walked: car park → via → hike (→ car park for a loop), close points merged. */
function walkPoints(hike, access, info) {
  const start = access ? access.point : pt(hike);
  const seq = [start, ...((info && info.walk_via) || []), pt(hike)];
  const out = [];
  for (const p of seq) if (!out.length || distKm(out[out.length - 1], p) > SAME_POINT_KM) out.push(p);
  if (info && info.walk_loop && out.length > 1 && distKm(out[out.length - 1], start) > SAME_POINT_KM) out.push(start);
  return out.length > 1 ? out : [];
}

const walkKey = (points) => `walk:${points.map((p) => roundPt(p).join(',')).join('|')}`;

function entry(hike, info, access, day, planned) {
  const points = walkPoints(hike, access, info);
  return {
    hikeId: hike.id,
    hike: hike.name,
    hikePoint: pt(hike),
    planned,
    day: day ? day.n : null,
    access: access ? { placeId: access.place ? access.place.id : null, name: access.place ? access.place.name : null, point: access.point, how: access.how } : null,
    loop: !!(info && info.walk_loop),
    points,
    key: points.length ? walkKey(points) : null,
  };
}

/** Every hike of the plan with its car park and the points of its walk. */
function hikeWalks(model) {
  const stops = plannedStops(model);
  const parkings = stops.filter((s) => s.kind === 'parking');
  const out = [];
  const seen = new Set();
  for (const s of stops) {
    if (s.kind !== 'hike' || seen.has(s.place.id)) continue;
    seen.add(s.place.id);
    const info = model.poolById.get(s.place.id)?.info || null;
    out.push(entry(s.place, info, accessFor(model, s, info, parkings), s.day, true));
  }
  for (const p of model.pool) {
    const id = p.info && p.info.access_parking_place_id;
    if (!id || seen.has(p.id) || p.lat == null || p.lng == null) continue;
    const park = parkings.find((s) => s.place.id === id);
    if (!park) continue;
    seen.add(p.id);
    out.push(entry(p, p.info, { place: park.place, point: pt(park.place), how: 'set' }, park.day, false));
  }
  return out.slice(0, MAX_WALKS);
}

/**
 * Geometry of the walks: Map(key → { km, minutes, points }). Cache first; what is missing is
 * computed while `network` is on and the deadline leaves room. Never throws.
 */
async function walkGeometry(ctx, walks, { network = false, deadline = null, concurrency = 2 } = {}) {
  const keys = [...new Set(walks.map((w) => w.key).filter(Boolean))];
  let out = new Map();
  try { out = await cache.getMany(ctx, keys); } catch { out = new Map(); }
  const missing = keys.filter((k) => !out.has(k));
  if (!network || !missing.length) return out;
  const fresh = [];
  const byKey = new Map(walks.map((w) => [w.key, w]));
  await pmap(missing, concurrency, async (k) => {
    const left = deadline ? deadline.left() : 12000;
    if (left < 1500) return;
    try {
      const r = await routing.walk(byKey.get(k).points, { timeoutMs: Math.min(9000, left - 700) });
      out.set(k, r);
      fresh.push([k, r]);
    } catch (e) {
      ctx.log?.warn?.('valhalla walk failed', { error: String(e && e.message) });
    }
  });
  try { await cache.setMany(ctx, fresh); } catch { /* the memory layer still has them */ }
  return out;
}

/** "4.4 km · 1 h 20 on foot", or null without a computed route. */
function statsText(geo, L) {
  if (!geo) return null;
  const h = Math.floor(geo.minutes / 60);
  const m = geo.minutes % 60;
  const time = h ? `${h} h${m ? ` ${String(m).padStart(2, '0')}` : ''}` : `${m} min`;
  return t(L, 'walk.stats', { km: num(geo.km, L, 1), time });
}

/** The map layer: one dotted polyline per walk (the straight line until the route is computed). */
function walkLayers(walks, geometry, settings) {
  const L = settings.language;
  const features = walks.filter((w) => w.key).map((w) => {
    const geo = geometry.get(w.key);
    // TREK caps a label at 80 characters: the hike, the walk, then the car park.
    const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const label = [short(w.hike, 34), statsText(geo, L), w.access && w.access.name ? t(L, 'walk.from', { parking: w.access.name }) : null].filter(Boolean).join(' · ');
    return { type: 'polyline', points: geo && geo.points && geo.points.length > 1 ? geo.points : w.points, tone: TONE.planned, ...WALK_LINE, label: label.slice(0, 80) };
  });
  return features.length ? [{ id: 'walks', name: t(L, 'walk.layer'), features }] : [];
}

module.exports = { hikeWalks, walkGeometry, walkLayers, walkPoints, walkKey, statsText, accessFor, plannedStops };
