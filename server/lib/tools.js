'use strict';
// Dispatch of the MCP tools. Each call: apply defaults (the host does not), read the user's
// settings, load the trip when one is named, run the tool under a 12.5 s budget (the host
// cuts at 15 s), and shrink the answer under the 64 KiB result cap.
const { TOOL_NAMES, withDefaults } = require('./tool-specs');
const placeSheet = require('./place-sheet');
const { recordedMinutes } = require('./visit');
const rules = require('./rules');
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
const { hhmm, durationText, deadline: makeDeadline } = require('./util');
const { lang } = require('./i18n');
const placeInfo = require('./place-info');
const amenityFill = require('./amenity-fill');
const contacts = require('./contacts');
const nightStatus = require('./night-status');
const hostMessage = require('./host-message');
const walks = require('./walks');
const { isParkingPlace, KINDS, categoryForKind } = require('./design');

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
    return { date, place: name || `${lat},${lng}`, sunrise: hhmm(sunrise(lat, lng, date, settings.timezone)), sunset: hhmm(ss), latestArrival: hhmm(rules.latestArrival(ss, settings)) };
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
  const rec = placeInfo.localized(info, L) || placeInfo.blank();
  const plannedNights = model.nights.filter((n) => n.placeId === p.id).map((n) => (findDay(model, { dayId: n.startDayId }) || {}).n).filter(Boolean);
  // A night place: planned as a night, or of a night category (trip.js). Only a night has a night total.
  const night = isNightPlace(model, p);
  const stay = model.nights.find((n) => n.placeId === p.id) || null;
  // Computed from the price shown (it may have just been saved), with the stay's nights.
  const cost = placeInfo.nightCost(p.price, info, settings, stay ? stay.nights : 1);
  const site = (p.raw && p.raw.website) || null;
  const currency = placeInfo.currencyOf(p.raw, model.currency);
  const statuses = (model.reservations || []).filter((r) => nightStatus.isNightReservation(r) && Number(nightStatus.placeOfReservation(r)) === p.id);
  const out = {
    placeId: p.id, name: p.name,
    plannedNights,
    price: placeInfo.priceText(p.price, currency, info, L, { night }),
    // The party's price for one night: the planned stay's share (a flat price spread over its
    // nights, as vanlife_night shows it), else a one-night stay's. stayTotal: the whole stay.
    nightTotal: night ? cost.perNight : null,
    stayTotal: stay ? cost.perStay : null,
    amenities: placeInfo.amenitiesText(info, L),
    parking: placeInfo.parkingText(info, L),
    visit: placeInfo.visitText(info, L),
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
    // The time on site the plan counts wins over the notes' figure, as on the panel's card.
    const fields = withRecordedDuration(sh.fields, info, L);
    out.sheet = { kind: sh.kind, fields, otherNotes: sh.other, about: sh.about, freeNotes: sh.text };
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
/** The sheet's fields with the time on site the plan counts (the record's) as its duration, as on the panel's card. */
function withRecordedDuration(fields, info, L) {
  const onSite = recordedMinutes(info);
  return onSite != null ? { ...fields, duration: { minutes: onSite, text: durationText(onSite, L) } } : fields;
}

async function hikesList(ctx, model, settings, opts) {
  const list = walks.hikeWalks(model);
  const geo = await walks.walkGeometry(ctx, list, { network: opts.network !== false, deadline: opts.deadline });
  return {
    filter: 'hikes', count: list.length,
    hikes: list.map((w) => walkView(w, geo.get(w.key), settings.language)),
    note: 'found: set = chosen by the user (set.access_parking_place_id); plan = a car park planned next to the hike; notes = a start point in the hike\'s notes. A walk starts at a car park place of the trip: without one (problem no_parking, even with a start point in the notes) it is not drawn and the check flags it; file the car park as a place (vanlife_place create kind "parking") and set walk.parking_place_id. The map draws each walk dotted.',
  };
}

/** List / read / set / log / clear / fill the record of the places of a trip. */
/**
 * Every write of a vanlife_place call checked before the first one (a new place, a car park, a
 * kind): a refusal never comes after something was written.
 */
/** A hike's car park must be another place of the trip, filed as a car park. */
function checkParkId(model, placeId, parkId) {
  if (parkId == null || parkId === '') return;
  if (Number(parkId) === Number(placeId)) throw new Error('walk.parking_place_id must be another place: the car park the hike starts from');
  const park = model.poolById.get(Number(parkId));
  if (!park) throw new Error(`place ${parkId} is not in trip ${model.tripId}`);
  if (!isParkingPlace(park)) throw new Error(`place ${parkId} ("${park.name}") is not a car park (category "${park.categoryName || 'none'}"): file it as one first (vanlife_place kind "parking"), a walk starts at a car park "P"`);
}

async function precheck(ctx, model, a, settings) {
  if (a.placeId && !model.poolById.get(a.placeId)) throw new Error(`place ${a.placeId} is not in trip ${model.tripId}`);
  if (a.create) {
    if (a.placeId) throw new Error('create makes a new place: leave placeId out');
    await createInput(ctx, model, a.create);
  }
  const walkIn = a.set && a.set.walk && typeof a.set.walk === 'object' && !Array.isArray(a.set.walk) ? a.set.walk : null;
  if (walkIn && walkIn.parking != null) {
    if (typeof walkIn.parking !== 'object' || Array.isArray(walkIn.parking)) throw new Error('walk.parking is a new car park: { name, lat, lng, price_amount, per, day_number }');
    if ('parking_place_id' in walkIn) throw new Error('give walk.parking_place_id (a car park of the trip) or walk.parking (a new one), not both');
    await createInput(ctx, model, { ...walkIn.parking, kind: 'parking' });
  } else if (walkIn) checkParkId(model, a.placeId, walkIn.parking_place_id);
  for (const [f, v] of Object.entries(a.sheet_set && typeof a.sheet_set === 'object' ? a.sheet_set : {})) placeSheet.setField('', '', f, v == null ? null : Array.isArray(v) ? v.map(String) : String(v), settings.language);
  if (a.clear_fields && a.clear_fields.length) placeInfo.clearPatch(a.clear_fields.filter((f) => f !== 'all'));
  if (a.set && typeof a.set === 'object') {
    const walk = a.set.walk && typeof a.set.walk === 'object' && a.set.walk.parking != null ? (({ parking, ...rest }) => ({ ...rest, parking_place_id: 1 }))(a.set.walk) : a.set.walk;
    const patch = placeInfo.expandParking(placeInfo.expandWalk({ ...a.set, ...(walk !== undefined ? { walk } : {}) }));
    placeInfo.nativePrice(patch);
    const rest = { ...patch };
    delete rest.price_amount;
    delete rest.currency;
    const rec = placeInfo.merge(a.placeId ? await placeInfo.get(ctx, a.placeId) : null, rest);
    if (placeInfo.WALK_FIELDS.some((k) => k in patch) && rec.access_parking_place_id != null && !rec.walk_shape && !rec.walk_loop) {
      throw new Error('walk.shape is required: "loop" (back to the same car park another way) or "out_and_back" (to a turnaround point and back the same way)');
    }
  }
}

async function placeTool(ctx, model, a, settings, opts = {}) {
  // fill is a call of its own: nothing else is written, no place is created (placeToolOn says so).
  if (a.fill) return placeToolOn(ctx, model, a, settings, opts);
  await precheck(ctx, model, a, settings);
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
/** A create checked whole, nothing written: { input, day, per } for createPlace. */
async function createInput(ctx, model, c) {
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
  }
  // A currency only when given: the trip's applies otherwise (currencyOf), and would stay
  // frozen on the place if the trip's currency changed. A wrong one is refused, never dropped.
  if (c.currency != null) {
    const cur = String(c.currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) throw new Error('create.currency must be a 3-letter code (EUR, CHF...)');
    input.currency = cur;
  }
  let day = null;
  if (c.day_number != null) {
    day = findDay(model, { dayNumber: c.day_number });
    if (!day) throw new Error(`day ${c.day_number} is not in trip ${model.tripId}`);
  }
  if (c.per != null) placeInfo.merge(null, { per: c.per }); // refused here, before the place exists
  return { input, day, name };
}

async function createPlace(ctx, model, c) {
  const { input, day, name } = await createInput(ctx, model, c);
  const place = await ctx.places.create(Number(model.tripId), input);
  if (c.per != null) await placeInfo.set(ctx, model.tripId, place.id, { per: c.per }, { place });
  if (day) await ctx.itinerary.assign(Number(model.tripId), Number(day.id), Number(place.id));
  return { placeId: place.id, name, kind: c.kind || null, categoryId: input.category_id || null, dayNumber: day ? day.n : null };
}

async function placeToolOn(ctx, model, a, settings, opts = {}) {
  if (a.fill) {
    const res = await amenityFill.fill(ctx, model.tripId, { placeIds: a.placeId ? [a.placeId] : undefined, park4night: settings.park4night, budgetMs: 6000 });
    // fill is a call of its own: say what it did not do rather than drop it silently.
    // filter and scope come with their defaults (withDefaults): only a list other than the default counts.
    const DEFAULT_LIST = { filter: 'nights', scope: 'planned' };
    const ignored = ['create', 'set', 'sheet_set', 'log', 'kind', 'clear', 'clear_fields', 'filter', 'scope'].filter((k) => a[k] != null && a[k] !== DEFAULT_LIST[k] && !(Array.isArray(a[k]) && !a[k].length));
    if (ignored.length) res.ignored = `${ignored.join(', ')}: not applied with fill=true; call again without fill`;
    return res;
  }
  if (!a.placeId) {
    if (a.set || a.log || a.clear || a.sheet_set || a.kind || (a.clear_fields && a.clear_fields.length)) throw new Error('placeId is required to set, log, clear or give a kind');
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
  let place = model.poolById.get(a.placeId);
  if (!place) throw new Error(`place ${a.placeId} is not in trip ${model.tripId}`);
  // The kind first: it moves the place to the matching category, so the rest of the answer
  // (and the map) shows its new pictogram.
  const kindRes = a.kind ? await applyKind(ctx, model, place, a.kind) : null;
  if (kindRes) { place.categoryId = kindRes.categoryId; place.categoryName = kindRes.category; place.raw = { ...place.raw, category_id: kindRes.categoryId }; }
  if (a.clear || (a.clear_fields || []).includes('all')) {
    await placeInfo.clear(ctx, model.tripId, place.id);
    const ignored = ['set', 'sheet_set', 'log'].filter((k) => a[k] != null);
    return { placeId: place.id, cleared: true, ...(ignored.length ? { ignored: `${ignored.join(', ')}: not applied with a full clear; call again` } : {}) };
  }
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
    // What the fill copied from the notes follows the new notes (time on site, contacts).
    await amenityFill.resync(ctx, model.tripId, { ...raw, id: place.id, categoryName: place.categoryName }, await placeInfo.get(ctx, place.id));
    // The rest of the call and its answer read the trip as TREK now holds it (notes, website,
    // phone, the day's copies of the place), never a copy patched by hand.
    model = await loadTrip(ctx, model.tripId, settings);
    place = model.poolById.get(a.placeId);
    if (!a.set && !a.log && !(a.clear_fields && a.clear_fields.length)) {
      const sh = placeSheet.sheetOf(place, { night: isNightPlace(model, place) });
      return { saved: true, placeId: place.id, sheetFields: sheetSet.map(([f]) => f), sheet: { kind: sh.kind, fields: withRecordedDuration(sh.fields, await placeInfo.get(ctx, place.id), settings.language), otherNotes: sh.other } };
    }
  }
  const patch = placeInfo.expandParking(placeInfo.expandWalk({ ...(a.set || {}) }));
  checkParkId(model, place.id, patch.access_parking_place_id);
  if (placeInfo.WALK_FIELDS.some((k) => k in patch)) await checkWalk(ctx, model, place, patch);
  if (a.clear_fields && a.clear_fields.length) Object.assign(patch, placeInfo.clearPatch(a.clear_fields));
  if (a.log) patch.log = a.log;
  if (Object.keys(patch).length) {
    const before = await placeInfo.get(ctx, place.id);
    const native = placeInfo.nativeContacts(place.raw, placeInfo.merge(before, { ...patch, price_amount: undefined, currency: undefined }), before);
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
  // dayNumbers, else the one dayNumber given: never every day when one was named.
  if (a.action === 'routes') return computeRoutes(ctx, model, { days: (a.dayNumbers && a.dayNumbers.length ? a.dayNumbers : a.dayNumber != null ? [a.dayNumber] : []).map((n) => ({ dayNumber: n })), apply: a.apply, startAt: a.startAt }, opts);
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
  const settings = await readSettings(ctx, null, { tripId: a.tripId });
  if (a.language) settings.language = lang(a.language);
  const deadline = makeDeadline(TOOL_BUDGET_MS, now);
  const opts = { settings, deadline, network: true };
  const model = a.tripId ? await loadTrip(ctx, a.tripId, settings) : null;
  const needTrip = () => { if (!model) throw new Error('tripId is required'); };
  const timezone = { timezone: settings.timezone, language: settings.language };

  let res;
  switch (name) {
    case 'vanlife_plan_trip':
      res = model ? await planTrip(ctx, model, a, opts) : a.request ? planRequest(a.request, settings) : (() => { throw new Error('give tripId, or request for a new trip'); })();
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
        if (a.dayNumber != null) res.ignored = 'dayNumber: used only with tripId (trip mode)';
      } else throw new Error('give tripId and dayNumber, or lat and lng');
      if (res.date && res.evening) {
        // At tonight's planned stay when there is one (the check's and the schedule's point), else at
        // the evening point.
        const at = res.currentNight && res.currentNight.lat != null ? res.currentNight : res.evening;
        const ss = sunset(at.lat, at.lng, res.date, settings.timezone);
        res.sun = { sunset: hhmm(ss), latestArrival: hhmm(rules.latestArrival(ss, settings)) };
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
  return fit(withUnused(name, args, a, res));
}

// The arguments each mode reads: any other one given is said (ignored), never dropped silently.
const MODE_ARGS = {
  vanlife_day: {
    routes: ['dayNumber', 'dayNumbers', 'apply', 'startAt'],
    schedule: ['dayNumber', 'departure', 'stays'],
    supplies: ['dayNumber', 'kinds', 'at', 'corridor_km'],
  },
};
const COMMON_ARGS = ['tripId', 'action', 'language'];
function withUnused(name, args, a, res) {
  if (!res || typeof res !== 'object' || Array.isArray(res)) return res;
  const given = Object.keys(args || {}).filter((k) => args[k] != null && !COMMON_ARGS.includes(k));
  let unused = [];
  if (MODE_ARGS[name] && MODE_ARGS[name][a.action]) unused = given.filter((k) => !MODE_ARGS[name][a.action].includes(k));
  if (name === 'vanlife_plan_trip' && a.tripId && args && args.request != null) unused = ['request'];
  if (name === 'vanlife_place' && a.placeId && !a.fill) unused = given.filter((k) => ['filter', 'scope'].includes(k));
  if (!unused.length) return res;
  const note = `${unused.join(', ')}: not used here`;
  return { ...res, ignored: res.ignored ? `${res.ignored}; ${note}` : note };
}

module.exports = { callTool, fit, sunTable, keyAmenities, TOOL_BUDGET_MS };
