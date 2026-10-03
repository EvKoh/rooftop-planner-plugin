'use strict';
// Dispatch of the MCP tools. Each call: apply defaults (the host does not), read the user's
// settings, load the trip when one is named, run the tool under a 12.5 s budget (the host
// cuts at 15 s), and shrink the answer under the 64 KiB result cap.
const { TOOL_NAMES, withDefaults } = require('./tool-specs');
const { readSettings } = require('./settings');
const { loadTrip } = require('./trip');
const { checkTrip } = require('./check');
const { findNights, findNightsForDay } = require('./nights');
const { computeRoutes } = require('./traces');
const { scheduleDay } = require('./schedule');
const { suppliesForDay } = require('./supplies');
const { planTrip, planRequest } = require('./plan');
const { sunset, sunrise } = require('./sun');
const { hhmm, deadline: makeDeadline } = require('./util');
const { nightOf } = require('./trip');
const placeInfo = require('./place-info');
const { isNightCategory } = require('./classify');

const TOOL_BUDGET_MS = 12500;
const MAX_BYTES = 60000; // under the host's 64 KiB, with room for its envelope

/** Halve the largest array until the JSON fits; marks the result truncated. */
function fit(result, max = MAX_BYTES) {
  let size = JSON.stringify(result).length;
  if (size <= max) return result;
  const out = JSON.parse(JSON.stringify(result));
  for (let guard = 0; size > max && guard < 60; guard++) {
    let biggest = null;
    const walk = (node, holder, key) => {
      if (Array.isArray(node)) {
        if (node.length > 1 && (!biggest || JSON.stringify(node).length > biggest.len)) biggest = { holder, key, len: JSON.stringify(node).length };
        node.forEach((v, i) => walk(v, node, i));
      } else if (node && typeof node === 'object') {
        for (const k of Object.keys(node)) walk(node[k], node, k);
      }
    };
    walk(out, null, null);
    if (!biggest) break;
    const arr = biggest.holder[biggest.key];
    biggest.holder[biggest.key] = arr.slice(0, Math.ceil(arr.length / 2));
    size = JSON.stringify(out).length;
  }
  out.truncated = 'Result shortened to fit the 64 KiB limit: narrow the request (one day, fewer levels).';
  return out;
}

/** Sunrise, sunset and latest arrival of each day, at that night's place (else the last located stop). */
function sunTable(model, settings) {
  const row = (date, lat, lng, name) => {
    const ss = sunset(lat, lng, date, settings.timezone);
    return { date, place: name || `${lat},${lng}`, sunrise: hhmm(sunrise(lat, lng, date, settings.timezone)), sunset: hhmm(ss), latestArrival: hhmm(ss == null ? null : ss - settings.sunset_margin_min) };
  };
  return model.days.filter((d) => d.date).map((d) => {
    const n = nightOf(model, d);
    const last = n && n.lat != null ? n : [...d.assignments].reverse().map((a) => a.place).find((p) => p.lat != null);
    return last ? { day: d.n, ...row(d.date, last.lat, last.lng, last.name) } : { day: d.n, date: d.date, place: null };
  });
}

/** Read all / read one / write one / clear one place's price and amenities. */
async function placeInfoTool(ctx, model, a, settings) {
  const L = settings.language;
  const view = (p, info) => ({
    placeId: p.id, name: p.name,
    price: placeInfo.priceText(p.price, p.raw ? p.raw.currency || model.currency : model.currency, info, L),
    amenities: placeInfo.amenitiesText(info, L),
    nightTotal: placeInfo.nightTotal(p.price, info, settings),
    record: info,
  });
  if (!a.placeId) {
    const withInfo = model.pool.filter((p) => p.info).map((p) => view(p, p.info));
    const planned = new Set(model.nights.map((n) => n.placeId));
    const toFill = model.pool.filter((p) => !p.info && (planned.has(p.id) || isNightCategory(p.categoryName)) && !p.geometry)
      .map((p) => ({ placeId: p.id, name: p.name, plannedNight: planned.has(p.id) }))
      .sort((x, y) => y.plannedNight - x.plannedNight).slice(0, 60);
    return { places: withInfo, toFill, note: 'Fill from cited sources only; unknown stays unknown.' };
  }
  const place = model.poolById.get(a.placeId);
  if (!place) throw new Error(`place ${a.placeId} is not in trip ${model.tripId}`);
  if (a.clear) { await placeInfo.clear(ctx, model.tripId, place.id); return { placeId: place.id, cleared: true }; }
  if (a.set) {
    const rec = await placeInfo.set(ctx, model.tripId, place.id, a.set);
    const priced = 'price_amount' in a.set ? { ...place, price: a.set.price_amount, raw: { ...place.raw, currency: a.set.currency || place.raw.currency } } : place;
    return { saved: true, ...view(priced, rec) };
  }
  // One place: read its value directly, not through the index.
  return view(place, (await placeInfo.get(ctx, place.id)) || placeInfo.blank());
}

async function callTool({ name, args }, ctx, { now } = {}) {
  if (!TOOL_NAMES.includes(name)) throw new Error(`unknown tool ${name}`);
  const a = withDefaults(name, args);
  const settings = await readSettings(ctx);
  if (a.language) settings.language = a.language;
  const deadline = makeDeadline(TOOL_BUDGET_MS, now);
  const opts = { settings, deadline, network: true };
  const model = a.tripId ? await loadTrip(ctx, a.tripId, settings) : null;
  const needTrip = () => { if (!model) throw new Error('tripId is required'); };
  const timezone = { timezone: settings.timezone, language: settings.language };

  let res;
  switch (name) {
    case 'vanlife_plan_trip':
      res = model ? await planTrip(ctx, model, a, opts) : a.request ? planRequest(a.request) : (() => { throw new Error('give tripId, or request for a new trip'); })();
      break;
    case 'vanlife_check_trip': {
      needTrip();
      const r = await checkTrip(ctx, model, opts);
      const levels = a.levels && a.levels.length ? a.levels : null;
      res = { trip: model.trip.title, ...r, findings: levels ? r.findings.filter((f) => levels.includes(f.level)) : r.findings };
      if (a.sun) res.sun = { ...timezone, marginMinutes: settings.sunset_margin_min, days: sunTable(model, settings) };
      break;
    }
    case 'vanlife_find_nights':
      if (model && a.dayNumber) res = await findNightsForDay(ctx, model, { dayNumber: a.dayNumber, sources: a.sources }, { ...opts, radiusKm: a.radius_km });
      else if (a.lat != null && a.lng != null) {
        res = await findNights(ctx, {
          evening: { lat: a.lat, lng: a.lng }, morning: a.morning_lat != null && a.morning_lng != null ? { lat: a.morning_lat, lng: a.morning_lng } : null, date: a.date, radiusKm: a.radius_km, sources: a.sources,
        }, opts);
      } else throw new Error('give tripId and dayNumber, or lat and lng');
      if (res.date && res.evening) {
        const ss = sunset(res.evening.lat, res.evening.lng, res.date, settings.timezone);
        res.sun = { sunset: hhmm(ss), latestArrival: hhmm(ss == null ? null : ss - settings.sunset_margin_min) };
      }
      break;
    case 'vanlife_compute_routes':
      needTrip();
      res = await computeRoutes(ctx, model, { days: (a.dayNumbers || []).map((n) => ({ dayNumber: n })), apply: a.apply, startAt: a.startAt }, opts);
      break;
    case 'vanlife_schedule_day': {
      needTrip();
      const stays = Object.fromEntries((a.stays || []).map((s) => [s.assignmentId, s.minutes]));
      res = await scheduleDay(ctx, model, { dayNumber: a.dayNumber }, { ...opts, departure: a.departure, stays });
      break;
    }
    case 'vanlife_place_info':
      needTrip();
      res = await placeInfoTool(ctx, model, a, settings);
      break;
    case 'vanlife_supplies_on_route':
      needTrip();
      res = await suppliesForDay(ctx, model, { dayNumber: a.dayNumber }, { kinds: a.kinds, at: a.at, corridorKm: a.corridor_km }, opts);
      break;
    default:
      throw new Error(`unhandled tool ${name}`);
  }
  return fit(res);
}

module.exports = { callTool, fit, sunTable, TOOL_BUDGET_MS };
