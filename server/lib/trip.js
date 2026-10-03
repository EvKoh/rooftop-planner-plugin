'use strict';
// Loads one trip from TREK and normalises it into the shape every rule reads:
//   days[]      ordered, each with its assignments (ordered) and day notes;
//   nights[]    the lodging blocks (TREK "accommodations"), with the night's place;
//   pool[]      every place of the trip, with its category name and parsed route geometry.
// All reads run in parallel (8 RPCs). Optional reads (budget, to-dos, categories) degrade
// to null when the grant or the addon is missing — the rules that need them are skipped.
const { hm, norm, weekday, toNum } = require('./util');
const { isNightCategory } = require('./classify');
const placeInfo = require('./place-info');

const soft = (p) => p.then((v) => v, () => null);

function parseGeometry(g) {
  if (!g) return null;
  try {
    const pts = typeof g === 'string' ? JSON.parse(g) : g;
    return Array.isArray(pts) && pts.length > 1 ? pts.map((p) => [+p[0], +p[1]]) : null;
  } catch {
    return null;
  }
}

async function loadTrip(ctx, tripId, settings) {
  const id = Number(tripId);
  const [trip, days, accs, places, resas, categories, costs, todos] = await Promise.all([
    ctx.trips.getById(id),
    ctx.trips.getDays(id),
    ctx.trips.getAccommodations(id),
    ctx.trips.getPlaces(id),
    soft(ctx.trips.getReservations(id)),
    soft(ctx.categories.list()),
    soft(ctx.costs.getByTrip(id)),
    soft(ctx.todos.list(id)),
  ]);
  if (!trip) throw new Error(`trip ${id} not found`);
  const catName = new Map((categories || []).map((c) => [c.id, c.name]));

  const pool = (places || []).map((p) => ({
    id: p.id,
    name: p.name || '',
    lat: toNum(p.lat),
    lng: toNum(p.lng),
    categoryId: p.category_id ?? null,
    categoryName: p.category_name || catName.get(p.category_id) || '',
    notes: p.notes || '',
    description: p.description || '',
    price: toNum(p.price),
    geometry: parseGeometry(p.route_geometry),
    raw: p,
  }));
  const poolById = new Map(pool.map((p) => [p.id, p]));
  // Price and amenities the traveller entered (place-info.js); absent without db:meta.
  const info = await placeInfo.getAll(ctx, id, pool.map((p) => p.id)).catch(() => new Map());
  for (const p of pool) p.info = info.get(p.id) || null;

  const orderedDays = (days || []).slice().sort((a, b) => (a.day_number ?? 0) - (b.day_number ?? 0) || (a.date || '').localeCompare(b.date || ''));
  const normDays = orderedDays.map((d, i) => ({
    id: d.id,
    n: d.day_number ?? i + 1,
    index: i,
    date: d.date || null,
    wd: d.date ? weekday(d.date) : null,
    title: d.title || '',
    notes: (d.notes_items || []).map((x) => x.text || '').concat(d.notes ? [d.notes] : []),
    assignments: (d.assignments || []).slice().sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0)).map((a) => {
      const p = a.place || {};
      const fromPool = poolById.get(p.id);
      return {
        id: a.id,
        order: a.order_index ?? 0,
        notes: a.notes || '',
        accommodationId: a.accommodation_id == null ? null : String(a.accommodation_id),
        place: {
          id: p.id,
          name: p.name || '',
          lat: toNum(p.lat),
          lng: toNum(p.lng),
          categoryName: p.category?.name || fromPool?.categoryName || '',
          notes: p.notes || '',
          description: p.description || '',
          time: hm(p.place_time ?? a.assignment_time),
          end: hm(p.end_time ?? a.assignment_end_time),
          duration: toNum(p.duration_minutes),
          price: toNum(p.price),
          stopType: p.stop_type || null,
          geometry: fromPool?.geometry || null,
        },
      };
    }),
  }));
  const dayIndex = new Map(normDays.map((d) => [d.id, d.index]));

  const nights = (accs || []).map((a) => {
    const pl = poolById.get(a.place_id) || {};
    const s = dayIndex.get(a.start_day_id);
    const e = dayIndex.get(a.end_day_id);
    return {
      id: String(a.id),
      placeId: a.place_id,
      name: a.place_name || pl.name || '',
      lat: toNum(a.place_lat ?? pl.lat),
      lng: toNum(a.place_lng ?? pl.lng),
      startDayId: a.start_day_id,
      endDayId: a.end_day_id,
      nights: s != null && e != null ? Math.max(1, e - s) : 1,
      checkIn: a.check_in || null,
      notes: a.notes || '',
      categoryName: pl.categoryName || '',
      info: pl.info || null,
      // The entered price (per person x travellers, + dog fee) wins over TREK's price field.
      price: (pl.info && settings ? placeInfo.nightTotal(pl.info, settings) : null) ?? pl.price ?? null,
      text: `${pl.description || ''}\n${pl.notes || ''}\n${a.notes || ''}`,
    };
  });

  return {
    trip,
    tripId: id,
    currency: trip.currency || 'EUR',
    days: normDays,
    nights,
    pool,
    poolById,
    reservations: resas,
    costs,
    todos,
    categories,
  };
}

/** The night that starts on `day` (tonight) and the one that ends on it (last night). */
const nightOf = (model, day) => model.nights.find((n) => n.startDayId === day.id) || null;
const nightBefore = (model, day) => model.nights.find((n) => n.endDayId === day.id) || null;

/**
 * Key words of a night place's name, without the "price · rating · " prefix some trips put
 * in titles ("25 € · 4,8/5 · Camping Example — lake"): used to spot stale mentions.
 */
function nameKey(name) {
  return norm(name).split('·').pop().split(/[—(–-]/)[0].trim();
}

/** Night-type places of the pool that are not planned as any night. */
function unplannedNights(model) {
  const plannedIds = new Set(model.nights.map((n) => n.placeId));
  const plannedKeys = model.nights.map((n) => nameKey(n.name));
  return model.pool.filter((p) => isNightCategory(p.categoryName) && !plannedIds.has(p.id) && !p.geometry)
    .map((p) => ({ place: p, key: nameKey(p.name) }))
    .filter(({ key }) => key.length >= 5 && !plannedKeys.some((k) => k.includes(key) || key.includes(k)));
}

module.exports = { loadTrip, nightOf, nightBefore, nameKey, unplannedNights, parseGeometry };
