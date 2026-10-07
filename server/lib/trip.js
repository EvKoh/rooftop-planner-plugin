'use strict';
// Loads one trip from TREK and normalises it into the shape every rule reads:
//   days[]      ordered, each with its assignments (ordered) and day notes;
//   nights[]    the lodging blocks (TREK "accommodations"), with the night's place, the
//               evenings it covers, its price per night and per stay, and its currency;
//   pool[]      every place of the trip, with its category name and parsed route geometry.
// All reads run in parallel (8 RPCs). Optional reads (budget, to-dos, categories) degrade
// to null when the grant or the addon is missing — the rules that need them are skipped.
const { hm, norm, weekday, toNum } = require('./util');
const { isNightCategory } = require('./classify');
const placeInfo = require('./place-info');
const { DEFAULTS } = require('./settings');

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

  const tripCurrency = trip.currency || 'EUR';
  const nights = (accs || []).map((a) => {
    const pl = poolById.get(a.place_id) || {};
    const s = dayIndex.get(a.start_day_id);
    const e = dayIndex.get(a.end_day_id);
    const nightsN = s != null && e != null ? Math.max(1, e - s) : 1;
    // Prices: `unitPrice` is TREK's own field (per its unit); `price` the party's total for
    // one night (per person x travellers, + dog fee), `stayCost` for the whole stay (a flat
    // price is paid once). Always computed, with the default settings when none are given,
    // so `price` means the same thing for every caller.
    const cost = placeInfo.nightCost(pl.price ?? null, pl.info, settings || DEFAULTS, nightsN);
    return {
      id: String(a.id),
      placeId: a.place_id,
      name: a.place_name || pl.name || '',
      lat: toNum(a.place_lat ?? pl.lat),
      lng: toNum(a.place_lng ?? pl.lng),
      startDayId: a.start_day_id,
      endDayId: a.end_day_id,
      // Evenings covered: startIndex <= day.index < startIndex + nights (stayOn reads these).
      startIndex: s ?? null,
      nights: nightsN,
      checkIn: a.check_in || null,
      notes: a.notes || '',
      categoryName: pl.categoryName || '',
      info: pl.info || null,
      // TREK's own phone field counts as a way to reach the host.
      nativePhone: (pl.raw && pl.raw.phone) || null,
      currency: placeInfo.currencyOf(pl.raw, tripCurrency),
      unitPrice: pl.price ?? null,
      price: cost.perNight,
      stayCost: cost.perStay,
      text: `${pl.description || ''}\n${pl.notes || ''}\n${a.notes || ''}`,
    };
  });

  return {
    trip,
    tripId: id,
    currency: tripCurrency,
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

/**
 * The one day lookup of the plugin: by TREK day id, else by day number, else by date
 * ("YYYY-MM-DD"). The first key given decides; a key that matches nothing gives null.
 */
function findDay(model, { dayId, dayNumber, date } = {}) {
  if (dayId != null && dayId !== '') return model.days.find((d) => String(d.id) === String(dayId)) || null;
  if (dayNumber != null && dayNumber !== '') return model.days.find((d) => d.n === Number(dayNumber)) || null;
  if (date) return model.days.find((d) => d.date === String(date).slice(0, 10)) || null;
  return null;
}

/**
 * The stay slept in on the evening of `day`: the lodging block whose evenings cover it
 * (its first evening, or any later one of a stay over several nights). The single answer to
 * "where do we sleep tonight": the check, the night list, the schedule, the routes, the
 * budget and the host message all read it.
 */
function stayOn(model, day) {
  if (!day) return null;
  return model.nights.find((n) => n.startIndex != null && n.startIndex <= day.index && day.index < n.startIndex + n.nights)
    || model.nights.find((n) => n.startIndex == null && n.startDayId === day.id)
    || null;
}

/** The stay slept in the evening before `day`: where the car is in the morning. */
const stayBefore = (model, day) => (day && day.index > 0 ? stayOn(model, model.days[day.index - 1]) : null);

/** Is `day` the first evening of `stay` (its arrival)? */
const isFirstEvening = (stay, day) => !!stay && !!day && stay.startDayId === day.id;

/**
 * The evenings a night can be planned on: every day but the last, plus the last one when a
 * stay starts on it (it is planned, so it is shown and can be set).
 */
function evenings(model) {
  const last = model.days[model.days.length - 1];
  return model.days.filter((d) => d !== last || model.nights.some((n) => n.startDayId === d.id));
}

/**
 * A place that is a night: planned as one (its id among `lodgedIds`, the places of the
 * trip's lodging blocks), or filed in a night category. Route places never are. The raw
 * form, for readers that have TREK's rows rather than the trip model (planner columns,
 * place panel).
 */
const isNightOf = (lodgedIds, id, categoryName, geometry) => !geometry && (lodgedIds.has(id) || isNightCategory(categoryName || ''));

/** A place of the trip model that is a night (isNightOf). */
const isNightPlace = (model, p) => !!p && isNightOf(new Set(model.nights.map((n) => n.placeId)), p.id, p.categoryName, p.geometry);

/** Night places of the pool that are not planned as any night (the "candidates"). */
function candidateNights(model) {
  const planned = new Set(model.nights.map((n) => n.placeId));
  return model.pool.filter((p) => !p.geometry && !planned.has(p.id) && isNightCategory(p.categoryName));
}

/**
 * Key words of a night place's name, without the "price · rating · " prefix some trips put
 * in titles ("25 € · 4,8/5 · Camping Example — lake"): used to spot stale mentions. Only a
 * spaced dash or a bracket ends the name, so "Saint-Jean" stays whole.
 */
function nameKey(name) {
  return norm(name).split('·').pop().split(/\s[-–—]\s|[—(]/)[0].trim();
}

/**
 * Candidate nights whose name is distinct enough to be spotted in a text (budget line,
 * to-do): at least 5 characters, and not part of a planned night's name.
 */
function unplannedNights(model) {
  const plannedKeys = model.nights.map((n) => nameKey(n.name));
  return candidateNights(model)
    .map((p) => ({ place: p, key: nameKey(p.name) }))
    .filter(({ key }) => key.length >= 5 && !plannedKeys.some((k) => k.includes(key) || key.includes(k)));
}

module.exports = {
  loadTrip, findDay, stayOn, isNightOf, stayBefore, isFirstEvening, evenings, isNightPlace, candidateNights, nameKey, unplannedNights, parseGeometry,
};
