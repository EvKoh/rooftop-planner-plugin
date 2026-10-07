'use strict';
// Dispatch of the MCP tools. Each call: apply defaults (the host does not), read the user's
// settings, load the trip when one is named, run the tool under a 12.5 s budget (the host
// cuts at 15 s), and shrink the answer under the 64 KiB result cap.
const { TOOL_NAMES, withDefaults } = require('./tool-specs');
const placeSheet = require('./place-sheet');
const { readSettings } = require('./settings');
const { loadTrip, findDay, stayOn, isNightPlace, candidateNights } = require('./trip');
const { applyKind } = require('./place-kind');
const { checkTrip } = require('./check');
const { findNights, findNightsForDay } = require('./nights');
const { computeRoutes } = require('./traces');
const { scheduleDay } = require('./schedule');
const { suppliesForDay } = require('./supplies');
const { planTrip, planRequest } = require('./plan');
const { sunset, sunrise } = require('./sun');
const { hhmm, deadline: makeDeadline } = require('./util');
const { lang } = require('./i18n');
const placeInfo = require('./place-info');
const amenityFill = require('./amenity-fill');
const contacts = require('./contacts');
const nightStatus = require('./night-status');
const hostMessage = require('./host-message');
const walks = require('./walks');
const { activityKind, KINDS, categoryForKind } = require('./design');

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

/** Sunrise, sunset and latest arrival of each day, at that evening's stay (else the last located stop). */
function sunTable(model, settings) {
  const row = (date, lat, lng, name) => {
    const ss = sunset(lat, lng, date, settings.timezone);
    return { date, place: name || `${lat},${lng}`, sunrise: hhmm(sunrise(lat, lng, date, settings.timezone)), sunset: hhmm(ss), latestArrival: hhmm(ss == null ? null : ss - settings.sunset_margin_min) };
  };
  return model.days.filter((d) => d.date).map((d) => {
    const n = stayOn(model, d);
    const last = n && n.lat != null ? n : [...d.assignments].reverse().map((a) => a.place).find((p) => p.lat != null);
    return last ? { day: d.n, ...row(d.date, last.lat, last.lng, last.name) } : { day: d.n, date: d.date, place: null };
  });
}

// Amenities that decide whether a night works for this party, for the "missing_amenities" list.
function keyAmenities(settings) {
  return ['water', 'toilets', 'shower', ...(settings.dog ? ['dog'] : []), ...(settings.vehicle === 'rooftop_tent' ? ['rooftop_tent'] : ['electricity'])];
}

/** One place, as the place tool shows it. */
function placeView(model, p, info, settings, { full = false } = {}) {
  const L = settings.language;
  const rec = info || placeInfo.blank();
  const plannedNights = model.nights.filter((n) => n.placeId === p.id).map((n) => (findDay(model, { dayId: n.startDayId }) || {}).n).filter(Boolean);
  // A night place: planned as a night, or of a night category (trip.js). Only a night has a night total.
  const night = isNightPlace(model, p);
  const site = (p.raw && p.raw.website) || null;
  const currency = placeInfo.currencyOf(p.raw, model.currency);
  const statuses = (model.reservations || []).filter((r) => nightStatus.isNightReservation(r) && Number(nightStatus.placeOfReservation(r)) === p.id);
  const out = {
    placeId: p.id, name: p.name,
    plannedNights,
    price: placeInfo.priceText(p.price, currency, info, L, { night }),
    nightTotal: night ? placeInfo.nightTotal(p.price, info, settings) : null,
    amenities: placeInfo.amenitiesText(info, L),
    parking: placeInfo.parkingText(info, L),
    visit: placeInfo.visitText(info),
    // Timed access, booking and toll: "Before 09:00 · Booking · Toll €40.00", or null.
    access: placeInfo.accessText(info, L, currency),
    bookingUrl: (info && info.booking_url) || null,
    contacts: { ...rec.contacts, ...(full ? {} : { notes: undefined, languages: undefined }) },
    // TREK's own website field, unless it is a platform page (park4night, Google Maps...).
    trekFields: { website: site && !contacts.notOwnSite(site) ? site : null, phone: (p.raw && p.raw.phone) || null },
    lastExchange: rec.log[0] || null,
    nightStatus: statuses.map((r) => ({ reservationId: r.id, status: nightStatus.statusOf(r), confirmation: r.confirmation_number || null, day: (findDay(model, { dayId: nightStatus.dayOfReservation(r) }) || {}).n ?? null, unlinked: nightStatus.unlinkedBookings(model).some((u) => u.res === r) })),
  };
  if (full) {
    Object.assign(out, { recorded: !!info, record: rec, contactSources: rec.contact_sources, log: rec.log });
    // The description and notes read into typed fields (place-sheet.js): what the widget's
    // card shows; edit a field with sheet_set, which rewrites its line in the notes.
    const sh = placeSheet.sheetOf(p, { night });
    out.sheet = { kind: sh.kind, fields: sh.fields, otherNotes: sh.other, about: sh.about, freeNotes: sh.text };
  }
  return out;
}

/** A hike's walk as the place tool shows it: car park, how it was found, km and minutes. */
function walkView(w, geo, L) {
  return {
    hikeId: w.hikeId, hike: w.hike, day: w.day, planned: w.planned,
    accessParking: w.access ? { placeId: w.access.placeId, name: w.access.name, point: w.access.point, found: w.access.how } : null,
    shape: w.shape, via: Math.max(0, w.points.length - 2),
    // Breaks "from one P, back to the same P": not drawn until fixed.
    problem: w.problem ? w.problem.key : null,
    ...(w.problem && w.problem.other ? { otherParking: w.problem.other } : {}),
    walk: geo ? (({ km, up, down }) => ({ km, minutes: walks.walkMinutes(walks.walked(geo, w.shape)), climb_m: up ?? null, descent_m: down ?? null, text: walks.statsText(walks.walked(geo, w.shape), L) }))(walks.walked(geo, w.shape)) : null,
    url: w.url,
  };
}

/** Every hike of the plan with its car park and walking route (computed and cached here). */
async function hikesList(ctx, model, settings, opts) {
  const list = walks.hikeWalks(model);
  const geo = await walks.walkGeometry(ctx, list, { network: opts.network !== false, deadline: opts.deadline });
  return {
    filter: 'hikes', count: list.length,
    hikes: list.map((w) => walkView(w, geo.get(w.key), settings.language)),
    note: 'found: set = chosen by the user (set.access_parking_place_id); plan = a car park planned next to the hike; notes = a start point in the hike\'s notes. A hike with no car park walks from its own place. The map draws each walk dotted.',
  };
}

/** List / read / set / log / clear / fill the record of the places of a trip. */
async function placeTool(ctx, model, a, settings, opts = {}) {
  if (!a.placeId && a.filter === 'hikes') return hikesList(ctx, model, settings, opts);
  // A new place (create), and a hike's car park given inline (set.walk.parking): made first,
  // so a whole hike — car park, hike, dotted walk — goes on the map in one call.
  const created = [];
  if (a.create) {
    if (a.placeId) throw new Error('create makes a new place: leave placeId out');
    const p = await createPlace(ctx, model, a.create);
    created.push(p);
    a = { ...a, placeId: p.placeId };
  }
  const walkIn = a.set && a.set.walk && typeof a.set.walk === 'object' && !Array.isArray(a.set.walk) ? a.set.walk : null;
  if (walkIn && walkIn.parking != null) {
    if (typeof walkIn.parking !== 'object' || Array.isArray(walkIn.parking)) throw new Error('walk.parking is a new car park: { name, lat, lng, price_amount, per, day_number }');
    if ('parking_place_id' in walkIn) throw new Error('give walk.parking_place_id (a car park of the trip) or walk.parking (a new one), not both');
    const { parking, ...rest } = walkIn;
    const park = await createPlace(ctx, model, { ...parking, kind: 'parking' });
    created.push(park);
    a = { ...a, set: { ...a.set, walk: { ...rest, parking_place_id: park.placeId } } };
  }
  if (created.length) model = await loadTrip(ctx, model.tripId, settings);
  const out = await placeToolOn(ctx, model, a, settings, opts);
  return created.length && out && typeof out === 'object' ? { created, ...out } : out;
}

const CREATE_KEYS = ['name', 'lat', 'lng', 'kind', 'address', 'website', 'description', 'notes', 'price_amount', 'currency', 'per', 'day_number'];

/** A new place of the trip, filed under the category of its kind, planned on a day if asked. */
async function createPlace(ctx, model, c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('create is an object: { name, lat, lng, kind, ... }');
  const unknown = Object.keys(c).filter((k) => !CREATE_KEYS.includes(k));
  if (unknown.length) throw new Error(`create takes ${CREATE_KEYS.join(', ')}, not ${unknown.join(', ')}`);
  const name = typeof c.name === 'string' ? c.name.trim() : '';
  if (!name || name.length > 200) throw new Error('create.name is required (200 characters at most)');
  const lat = Number(c.lat);
  const lng = Number(c.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error('create.lat and create.lng are required, in degrees');
  const input = { name, lat, lng };
  if (c.kind != null) {
    if (!KINDS.includes(c.kind)) throw new Error(`create.kind must be one of: ${KINDS.join(', ')}`);
    const cat = categoryForKind(await ctx.categories.list(), c.kind);
    if (!cat) throw new Error(`no category of this trip matches "${c.kind}"`);
    input.category_id = cat.id;
  }
  for (const k of ['address', 'website', 'description', 'notes']) {
    if (c[k] == null) continue;
    if (typeof c[k] !== 'string' || c[k].length > (k === 'notes' || k === 'description' ? 2000 : 500)) throw new Error(`create.${k} must be a text`);
    input[k] = c[k];
  }
  if (c.website != null && !/^https?:\/\//i.test(c.website)) throw new Error('create.website must be an http(s) address');
  if (c.price_amount != null) {
    const v = Number(c.price_amount);
    if (!Number.isFinite(v) || v < 0) throw new Error('create.price_amount must be a positive number');
    input.price = v;
    input.currency = typeof c.currency === 'string' && /^[A-Za-z]{3}$/.test(c.currency) ? c.currency.toUpperCase() : model.currency;
  }
  let day = null;
  if (c.day_number != null) {
    day = findDay(model, { dayNumber: c.day_number });
    if (!day) throw new Error(`day ${c.day_number} is not in trip ${model.tripId}`);
  }
  const place = await ctx.places.create(Number(model.tripId), input);
  if (c.per != null) await placeInfo.set(ctx, model.tripId, place.id, { per: c.per }, { place });
  if (day) await ctx.itinerary.assign(Number(model.tripId), Number(day.id), Number(place.id));
  return { placeId: place.id, name, kind: c.kind || null, categoryId: input.category_id || null, dayNumber: day ? day.n : null };
}

async function placeToolOn(ctx, model, a, settings, opts = {}) {
  if (a.fill) return amenityFill.fill(ctx, model.tripId, { placeIds: a.placeId ? [a.placeId] : undefined, park4night: settings.park4night, language: settings.language, budgetMs: 6000 });
  if (!a.placeId) {
    if (a.set || a.log || a.clear || a.sheet_set || (a.clear_fields && a.clear_fields.length)) throw new Error('placeId is required to set, log or clear');
    // Three sets of nights: planned (a lodging in the trip), candidates (a night category but
    // no lodging), and both together (trip.js decides both).
    const planned = new Set(model.nights.map((n) => n.placeId));
    const real = model.pool.filter((p) => !p.geometry);
    const sets = {
      planned: real.filter((p) => planned.has(p.id)),
      candidates: candidateNights(model),
    };
    sets.all_nights = [...sets.planned, ...sets.candidates];
    const scope = sets[a.scope] ? a.scope : 'planned';
    const nightish = sets[scope];
    const keys = keyAmenities(settings);
    const missingContact = (p) => !contacts.hasContact(contacts.reachOf(p.info, p.raw));
    const missingAmenities = (p) => keys.filter((k) => !p.info || p.info.amenities[k] === 'unknown');
    const filter = a.filter || 'nights';
    const chosen = filter === 'all' ? real
      : filter === 'missing_contacts' ? nightish.filter(missingContact)
        : filter === 'missing_amenities' ? nightish.filter((p) => missingAmenities(p).length) : nightish;
    const rows = chosen.map((p) => {
      const missing = [...(missingContact(p) ? ['contact'] : []), ...missingAmenities(p)];
      return { ...placeView(model, p, p.info, settings), missing };
    }).sort((x, y) => (y.plannedNights.length > 0) - (x.plannedNights.length > 0)).slice(0, 80);
    return {
      filter, scope: filter === 'all' ? null : scope, count: chosen.length,
      nights: { planned: sets.planned.length, candidates: sets.candidates.length, all_nights: sets.all_nights.length },
      places: rows,
      note: 'Fill from cited sources only; unknown stays unknown. fill=true looks the empty ones up. scope: planned = nights with a lodging in the trip (default); candidates = night-category places with no lodging; all_nights = both.',
    };
  }
  const place = model.poolById.get(a.placeId);
  if (!place) throw new Error(`place ${a.placeId} is not in trip ${model.tripId}`);
  // The kind first: it moves the place to the matching category, so the rest of the answer
  // (and the map) shows its new pictogram.
  const kindRes = a.kind ? await applyKind(ctx, model, place, a.kind) : null;
  if (kindRes) { place.categoryId = kindRes.categoryId; place.categoryName = kindRes.category; place.raw = { ...place.raw, category_id: kindRes.categoryId }; }
  if (a.clear || (a.clear_fields || []).includes('all')) { await placeInfo.clear(ctx, model.tripId, place.id); return { placeId: place.id, cleared: true }; }
  const sheetSet = a.sheet_set && typeof a.sheet_set === 'object' ? Object.entries(a.sheet_set) : [];
  if (sheetSet.length) {
    // Field by field into TREK's own description and notes: the only copy.
    const raw = place.raw || {};
    let texts = { description: raw.description || '', notes: raw.notes || '' };
    for (const [field, value] of sheetSet) texts = placeSheet.setField(texts.description, texts.notes, field, value == null ? null : Array.isArray(value) ? value.map(String) : String(value), settings.language);
    const patchTexts = { notes: texts.notes, ...(texts.description !== (raw.description || '') ? { description: texts.description } : {}) };
    await ctx.places.update(model.tripId, place.id, patchTexts);
    Object.assign(raw, patchTexts);
    place.raw = raw;
    if (!a.set && !a.log && !(a.clear_fields && a.clear_fields.length)) {
      const sh = placeSheet.sheetOf(place, { night: isNightPlace(model, place) });
      return { saved: true, placeId: place.id, sheetFields: sheetSet.map(([f]) => f), sheet: { kind: sh.kind, fields: sh.fields, otherNotes: sh.other } };
    }
  }
  const patch = placeInfo.expandParking(placeInfo.expandWalk({ ...(a.set || {}) }));
  const parkId = patch.access_parking_place_id;
  if (parkId != null && parkId !== '') {
    if (Number(parkId) === place.id) throw new Error('walk.parking_place_id must be another place: the car park the hike starts from');
    const park = model.poolById.get(Number(parkId));
    if (!park) throw new Error(`place ${parkId} is not in trip ${model.tripId}`);
    if (activityKind(park) !== 'parking') throw new Error(`place ${parkId} ("${park.name}") is not a car park (category "${park.categoryName || 'none'}"): file it as one first (vanlife_place kind "parking"), a walk starts at a car park "P"`);
  }
  if (placeInfo.WALK_FIELDS.some((k) => k in patch)) await checkWalk(ctx, model, place, patch);
  if (a.clear_fields && a.clear_fields.length) Object.assign(patch, placeInfo.clearPatch(a.clear_fields));
  if (a.log) patch.log = a.log;
  if (Object.keys(patch).length) {
    const before = await placeInfo.get(ctx, place.id);
    const native = placeInfo.nativeContacts(place.raw, placeInfo.merge(before, { ...patch, price_amount: undefined, currency: undefined }));
    const rec = await placeInfo.set(ctx, model.tripId, place.id, patch, { place: place.raw });
    place.info = rec;
    const walk = await hikeWalk(ctx, model, place.id, settings, opts);
    const priced = 'price_amount' in patch ? { ...place, price: patch.price_amount, raw: { ...place.raw, currency: patch.currency || place.raw.currency } } : place;
    const raw = native ? { ...priced.raw, ...native } : priced.raw;
    return { saved: true, ...(kindRes ? { kind: kindRes } : {}), ...(native ? { copiedToTrek: native } : {}), ...placeView(model, { ...priced, raw }, rec, settings, { full: true }), ...(walk ? { hike: walk } : {}) };
  }
  // One place: read its value directly, not through the index.
  const walk = await hikeWalk(ctx, model, place.id, settings, opts);
  return { ...(kindRes ? { kind: kindRes } : {}), ...placeView(model, place, await placeInfo.get(ctx, place.id), settings, { full: true }), ...(walk ? { hike: walk } : {}) };
}

/**
 * A walk being set must keep the rule: from a car park "P", back to the same P, as a loop or
 * an out-and-back. Throws a readable error, before anything is saved, when it would not.
 */
async function checkWalk(ctx, model, place, patch) {
  const before = await placeInfo.get(ctx, place.id);
  const rec = placeInfo.merge(before, patch);
  if (placeInfo.WALK_FIELDS.every((k) => rec[k] == null)) return; // cleared
  if (!rec.walk_shape && !rec.walk_loop) throw new Error('walk.shape is required: "loop" (back to the same car park another way) or "out_and_back" (to a turnaround point and back the same way)');
  const saved = place.info;
  place.info = rec;
  try {
    const w = walks.hikeWalks(model).find((x) => x.hikeId === place.id);
    if (!w) return; // neither the hike nor its car park is planned: nothing drawn
    if (w.problem && w.problem.key === 'no_parking') throw new Error(`a walk starts at a car park "P": give walk.parking_place_id, the car park place of this trip the walk leaves from and comes back to`);
    if (w.problem && w.problem.key === 'parking_to_parking') throw new Error(`the walk would go from car park "${w.access.name}" to another car park, "${w.problem.other}": a walk comes back to the car park it left. Make it a loop (shape "loop", via points) or an out-and-back to a turnaround that is not a car park`);
  } finally {
    place.info = saved;
  }
}

/** The walk of one hike (its route computed now, so the map finds it cached), or null. */
async function hikeWalk(ctx, model, placeId, settings, opts) {
  const w = walks.hikeWalks(model).find((x) => x.hikeId === placeId);
  if (!w) return null;
  const geo = await walks.walkGeometry(ctx, [w], { network: opts.network !== false, deadline: opts.deadline });
  return walkView(w, geo.get(w.key), settings.language);
}

/** The three day actions that used to be three tools. */
async function dayTool(ctx, model, a, opts) {
  const needDay = () => { if (!a.dayNumber) throw new Error(`dayNumber is required for action "${a.action}"`); };
  if (a.action === 'routes') return computeRoutes(ctx, model, { days: (a.dayNumbers || []).map((n) => ({ dayNumber: n })), apply: a.apply, startAt: a.startAt }, opts);
  if (a.action === 'schedule') {
    needDay();
    const stays = Object.fromEntries((a.stays || []).map((x) => [x.assignmentId, x.minutes]));
    return scheduleDay(ctx, model, { dayNumber: a.dayNumber }, { ...opts, departure: a.departure, stays });
  }
  if (a.action === 'supplies') {
    needDay();
    return suppliesForDay(ctx, model, { dayNumber: a.dayNumber }, { kinds: a.kinds, at: a.at, corridorKm: a.corridor_km }, opts);
  }
  throw new Error('action must be routes, schedule or supplies');
}

async function callTool({ name, args }, ctx, { now } = {}) {
  if (!TOOL_NAMES.includes(name)) throw new Error(`unknown tool ${name}`);
  const a = withDefaults(name, args);
  const settings = await readSettings(ctx);
  if (a.language) settings.language = lang(a.language);
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
      if (model && a.dayNumber) {
        res = await findNightsForDay(ctx, model, { dayNumber: a.dayNumber, sources: a.sources }, { ...opts, radiusKm: a.radius_km });
        // In trip mode the day gives the date and both anchors: say so rather than drop them silently.
        const ignored = ['lat', 'lng', 'morning_lat', 'morning_lng', 'date'].filter((k) => args && args[k] != null);
        if (ignored.length) res.ignored = `${ignored.join(', ')}: not used with tripId + dayNumber (the day's own date and stops are the anchors)`;
      }
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
    case 'vanlife_day':
      needTrip();
      res = await dayTool(ctx, model, a, opts);
      break;
    case 'vanlife_place':
      needTrip();
      res = await placeTool(ctx, model, a, settings, opts);
      break;
    case 'vanlife_night':
      needTrip();
      if (a.action === 'list') res = nightStatus.list(model, settings, { now: now ? now() : undefined });
      else if (a.action === 'set') res = await nightStatus.set(ctx, model, { ...a, language: settings.language });
      else throw new Error('action must be list or set');
      break;
    case 'vanlife_host_message':
      needTrip();
      res = hostMessage.draft(model, settings, a);
      break;
    default:
      throw new Error(`unhandled tool ${name}`);
  }
  return fit(res);
}

module.exports = { callTool, fit, sunTable, keyAmenities, TOOL_BUDGET_MS };
