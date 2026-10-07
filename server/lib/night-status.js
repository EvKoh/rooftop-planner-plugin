'use strict';
// Where each night stands, kept in TREK's own bookings (no table of our own): a night is a
// lodging block (accommodation) and its partner reservation of type "hotel".
//   spotted   → a place with no booking
//   contacted → booking "pending"     (asked the host, waiting)
//   booked    → booking "confirmed"   (+ confirmation number when there is one)
//   dropped   → booking "cancelled"   (+ a short reason in its notes)
// This records what the user declares. It never books, pays or writes to a host.
//
// The rules below are the only ones the plugin uses to tie a booking to a night: the night
// list, the check, the planner chip, the place tool and the place panel all read them.
//   - a night booking: type "hotel", or tied to a lodging block;
//   - the booking of a stay: tied to its lodging block, or a hotel booking of the same place
//     for its first evening that is tied to no block; when there are several, the strongest
//     status wins (booked > contacted > dropped), so a cancelled old one never hides a
//     confirmed new one;
//   - an "unlinked" booking: an active night booking that belongs to no stay. TREK shows it
//     booked on the map, but nobody sleeps there in the plan: the list and the check say so,
//     and setting its status again ties it to a new stay.
const placeInfo = require('./place-info');
const contacts = require('./contacts');
const { findDay, stayOn, evenings, isFirstEvening } = require('./trip');
const { t } = require('./i18n');
const { norm } = require('./util');

const { NIGHT_STATUSES: STATUSES } = require('./design');
const TO_TREK = { contacted: 'pending', booked: 'confirmed', dropped: 'cancelled' };
const FROM_TREK = { pending: 'contacted', confirmed: 'booked', cancelled: 'dropped' };
// When one place has several bookings (two nights, an old dropped one), the strongest wins.
const RANK = { booked: 3, contacted: 2, dropped: 1, spotted: 0 };
const STALE_DAYS = 3;
// The plugin's own lines in a booking's notes start with this tag, so a later status change
// replaces them instead of leaving "dropped: full" on a confirmed booking.
const NOTE_TAG = '[vanlife]';
// Words of a free note saying the booking is still waiting: stale once it is confirmed.
const WAITING_NOTE = /\b(en attente|a confirmer|attente de confirmation|pending|waiting|to be confirmed|not confirmed|non confirme|in attesa|da confermare|warten|ausstehend|unbestatigt|pendiente|por confirmar)/;

class NightError extends Error {}

const statusOf = (res) => (res ? FROM_TREK[res.status] || 'contacted' : 'spotted');
const same = (a, b) => a != null && b != null && String(a) === String(b);

/** The place a booking is about: its lodging block's place, else its own place. */
const placeOfReservation = (r) => r.accommodation_place_id ?? r.place_id ?? null;
/** The evening a booking starts: its lodging block's first day, else its own day. */
const dayOfReservation = (r) => r.accommodation_start_day_id ?? r.day_id ?? null;
/** Is this booking about a night (a hotel booking, or one tied to a lodging block)? */
const isNightReservation = (r) => !!r && (r.type === 'hotel' || r.accommodation_id != null);

/** The strongest of several bookings (booked > contacted > dropped), the first on a tie. */
function strongest(list) {
  let best = null;
  for (const r of list) if (!best || RANK[statusOf(r)] > RANK[statusOf(best)]) best = r;
  return best;
}

/** Every booking of a stay: tied to its block, or an untied hotel booking of its place and first evening. */
function bookingsOf(night, reservations) {
  return (reservations || []).filter((r) => same(r.accommodation_id, night.id)
    || (r.type === 'hotel' && r.accommodation_id == null && same(placeOfReservation(r), night.placeId) && same(dayOfReservation(r), night.startDayId)));
}

/** The booking that speaks for a stay (the strongest of its bookings), or null. */
const reservationFor = (night, reservations) => strongest(bookingsOf(night, reservations));

/** A hotel booking of `placeId` for the evening `dayId` that is tied to no lodging block. */
function candidateReservation(reservations, placeId, dayId) {
  return strongest((reservations || []).filter((r) => r.type === 'hotel' && r.accommodation_id == null
    && same(placeOfReservation(r), placeId) && same(dayOfReservation(r), dayId)));
}

/**
 * Active night bookings (not cancelled) that belong to no stay of the plan: TREK shows the
 * place booked, but the plan has nobody sleeping there. { res, placeId, day } each.
 */
function unlinkedBookings(model) {
  const owned = new Set();
  for (const n of model.nights) for (const r of bookingsOf(n, model.reservations)) owned.add(r);
  return (model.reservations || [])
    .filter((r) => isNightReservation(r) && r.status !== 'cancelled' && !owned.has(r))
    .map((r) => ({ res: r, placeId: placeOfReservation(r), day: findDay(model, { dayId: dayOfReservation(r) }) }));
}

/** Map placeId → strongest status of its night bookings: the planner chip of the place. */
function statusByPlace(reservations) {
  const out = new Map();
  for (const r of reservations || []) {
    const id = placeOfReservation(r);
    if (id == null || !isNightReservation(r)) continue;
    const s = statusOf(r);
    const prev = out.get(Number(id));
    if (!prev || RANK[s] > RANK[prev]) out.set(Number(id), s);
  }
  return out;
}

/**
 * Is a booking of this place (a night, a road slot, a ticket) recorded as made: not
 * cancelled, and confirmed or holding the provider's confirmation number. The check's
 * "booking required, none recorded" reads it.
 */
const placeBooked = (reservations, placeId) => (reservations || []).some((r) => same(placeOfReservation(r), placeId) && r.status !== 'cancelled' && (r.status === 'confirmed' || !!r.confirmation_number));

/**
 * The price written on a booking by TREK's expense side or its importer (metadata.price,
 * for the whole booking): { amount, currency } or null.
 */
function bookedPrice(r) {
  let m = r && r.metadata;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { m = null; } }
  const v = m && m.price != null ? Number(m.price) : NaN;
  return Number.isFinite(v) ? { amount: v, currency: (m.priceCurrency || m.currency || null) } : null;
}

/** A confirmed booking whose free notes still say it is waiting for an answer. */
const staleWaitingNote = (r) => statusOf(r) === 'booked' && WAITING_NOTE.test(norm(freeNotes(r.notes)));

/**
 * What the planned nights cost, the way the budget and the check both count it: each stay's
 * cost for the whole party (nightCost), in the trip's currency. A stay whose booking is
 * dropped, a price in another currency and an unknown price are listed apart, never summed.
 */
function nightsMoney(model) {
  const rows = model.nights.map((n) => {
    const res = reservationFor(n, model.reservations);
    return { name: n.name, placeId: n.placeId, nights: n.nights, pricePerNight: n.price, total: n.stayCost, currency: n.currency, status: statusOf(res) };
  });
  const dropped = rows.filter((r) => r.status === 'dropped');
  const live = rows.filter((r) => r.status !== 'dropped');
  const unknown = live.filter((r) => r.total == null);
  const otherCurrency = live.filter((r) => r.total != null && r.currency !== model.currency);
  const counted = live.filter((r) => r.total != null && r.currency === model.currency);
  const total = Math.round(counted.reduce((s, r) => s + r.total, 0) * 100) / 100;
  return { rows, total, unknown, otherCurrency, dropped, complete: !unknown.length && !otherCurrency.length };
}

/** Days since the last message sent with no answer after it, while the booking is pending (null otherwise). */
function waitingDays(res, info, now = Date.now()) {
  if (!res || statusOf(res) !== 'contacted') return null;
  const log = (info && info.log) || [];
  const sent = log.find((e) => e.direction === 'sent');
  const since = sent ? sent.date : res.created_at ? String(res.created_at).slice(0, 10) : null;
  if (!since) return null;
  if (log.some((e) => e.direction === 'received' && e.date >= since)) return null;
  const days = Math.floor((now - Date.parse(`${since}T00:00:00Z`)) / 864e5);
  return Number.isFinite(days) ? days : null;
}

/** The host's ways in, as the widget and the host message read them (contacts.js decides). */
function contactView(info, raw) {
  const c = contacts.reachOf(info, raw);
  return { email: c.email, phone: c.phone, whatsapp: c.whatsapp, website: c.website, preferred_channel: c.preferred_channel, name: c.contact_name };
}

/**
 * The evenings a place can be set for (every evening of the trip; a later night of a stay
 * of this place folds into the stay's first evening): the evening, what is planned there,
 * and this place's booking for it. `dayId` is the evening to propose first: a booking of the
 * place, else its planned stay, else a day it is visited, else the first evening. `status`
 * is that evening's status, the one the panel's chip shows.
 */
function placeNights(model, placeId) {
  const resas = model.reservations || [];
  const rows = [];
  evenings(model).forEach((d) => {
    const night = stayOn(model, d);
    const mine = !!night && night.placeId === placeId;
    if (mine && !isFirstEvening(night, d)) return;
    const res = mine ? reservationFor(night, resas) : candidateReservation(resas, placeId, d.id);
    rows.push({
      dayId: d.id, day: d.n, date: d.date,
      nights: mine ? night.nights : 1,
      planned: night ? { placeId: night.placeId, name: night.name, mine } : null,
      status: res ? statusOf(res) : mine ? 'spotted' : null,
      reservationId: res ? res.id : null,
      confirmation: res ? res.confirmation_number || null : null,
    });
  });
  const pick = rows.find((r) => r.reservationId) || rows.find((r) => r.planned && r.planned.mine)
    || rows.find((r) => (model.days.find((d) => d.id === r.dayId) || { assignments: [] }).assignments.some((x) => x.place.id === placeId))
    || rows[0] || null;
  return { nights: rows, dayId: pick ? pick.dayId : null, status: pick ? pick.status : null };
}

/**
 * One row per evening of the trip, with its status, contact, last exchange and price. The
 * later evenings of a stay are rows too (`continues` names the stay's first day), so the
 * counts are counts of nights. An evening with no stay but an unlinked booking says so.
 */
function list(model, settings, { now } = {}) {
  const L = settings.language;
  const resas = model.reservations || [];
  const unlinked = unlinkedBookings(model);
  const rows = [];
  for (const d of evenings(model)) {
    const night = stayOn(model, d);
    if (!night) {
      const u = unlinked.find((x) => x.day && x.day.id === d.id);
      if (u) {
        const place = model.poolById.get(Number(u.placeId));
        rows.push({
          day: d.n, date: d.date, dayId: d.id, placeId: u.placeId, place: place ? place.name : u.res.title,
          status: statusOf(u.res), statusLabel: t(L, `st.${statusOf(u.res)}`), reservationId: u.res.id,
          confirmation: u.res.confirmation_number || null, unlinked: true, note: t(L, 'night.unlinked', { title: u.res.title || '' }),
        });
      } else rows.push({ day: d.n, date: d.date, dayId: d.id, placeId: null, place: null, status: null, note: t(L, 'night.none') });
      continue;
    }
    const res = reservationFor(night, resas);
    const status = statusOf(res);
    const base = {
      day: d.n, date: d.date, dayId: d.id, nights: night.nights,
      placeId: night.placeId, place: night.name,
      status, statusLabel: t(L, `st.${status}`),
      reservationId: res ? res.id : null,
      confirmation: res ? res.confirmation_number || null : null,
    };
    if (!isFirstEvening(night, d)) {
      const first = model.days.find((x) => x.id === night.startDayId);
      rows.push({ ...base, continues: first ? first.n : null });
      continue;
    }
    const place = model.poolById.get(night.placeId);
    const info = place ? place.info : null;
    const others = resas.filter((r) => r !== res && r.type === 'hotel' && r.accommodation_id == null && !same(placeOfReservation(r), night.placeId) && same(dayOfReservation(r), d.id));
    rows.push({
      ...base,
      contact: contactView(info, place && place.raw),
      lastExchange: info && info.log && info.log.length ? info.log[0] : null,
      waitingDays: waitingDays(res, info, now),
      price: place ? placeInfo.priceText(place.price, night.currency, info, L, { night: true }) : null,
      nightTotal: night.price,
      stayTotal: night.stayCost,
      ...(others.length ? { alsoAsked: others.map((r) => ({ placeId: placeOfReservation(r), title: r.title, status: statusOf(r), reservationId: r.id })) } : {}),
    });
  }
  const counts = Object.fromEntries(STATUSES.map((s) => [s, rows.filter((r) => r.status === s && !r.unlinked).length]));
  if (unlinked.length) counts.unlinked = unlinked.length;
  return { trip: model.trip.title, counts, nights: rows };
}

/** The booking's notes without the plugin's own lines. */
const freeNotes = (notes) => String(notes || '').split('\n').filter((l) => !l.startsWith(NOTE_TAG)).join('\n').trim();

/**
 * The notes to write on a booking: the user's free notes (replaced when `a.notes` is given,
 * kept otherwise), and the plugin's line for a dropped night, translated; the plugin's old
 * line goes whatever the new status. undefined when nothing changes.
 */
function notesText(a, res, L) {
  const before = res ? String(res.notes || '') : '';
  const free = a.notes != null && a.notes !== '' ? String(a.notes).slice(0, 500) : freeNotes(before);
  const own = a.status === 'dropped' && a.reason ? `${NOTE_TAG} ${t(L, 'night.dropped_note', { reason: String(a.reason).slice(0, 200) })}` : null;
  const next = [free, own].filter(Boolean).join('\n');
  return next === before ? undefined : next;
}

/**
 * Record the status of a night: create or update the place's hotel booking for that evening.
 * a: { placeId, dayNumber | dayId | date, status, confirmation?, reason?, notes?, nights?, clear?, language? }
 * `clear` (the place panel only): status "spotted" deletes the place's booking for that night.
 * A booking of the place for an evening with no stay (an unlinked one) is tied to a new stay
 * of that place, so the plan, the list and the map agree again.
 */
async function set(ctx, model, a) {
  if (!STATUSES.includes(a.status)) throw new NightError(`status must be one of ${STATUSES.join(', ')}`);
  const L = a.language || 'en';
  const day = findDay(model, { dayId: a.dayId, dayNumber: a.dayNumber, date: a.date });
  if (!day) throw new NightError('give dayNumber (or dayId) of the evening the night starts');
  const place = model.poolById.get(a.placeId);
  if (!place) throw new NightError(`place ${a.placeId} is not in trip ${model.tripId}`);
  // "A farm we booked": the kind sets the place's category (its pictogram) with the status.
  const kindRes = a.kind ? await require('./place-kind').applyKind(ctx, model, place, a.kind) : null;
  const resas = model.reservations || [];
  const night = stayOn(model, day);
  const isNight = !!night && night.placeId === place.id;
  const res = isNight ? reservationFor(night, resas) : candidateReservation(resas, place.id, day.id);
  const notes = notesText(a, res, L);
  const warnings = [];

  if (a.status === 'spotted') {
    if (res && a.clear) {
      // The user, in TREK's own place panel, puts the night back to available: the
      // booking goes, the stay it was tied to stays planned (unlinked first, or TREK
      // would delete the stay with its booking).
      if (res.accommodation_id != null) await ctx.reservations.update(model.tripId, res.id, { accommodation_id: null });
      await ctx.reservations.delete(model.tripId, res.id);
      return { placeId: place.id, place: place.name, day: day.n, date: day.date, status: 'spotted', action: 'deleted', reservationId: res.id, ...(kindRes ? { kind: kindRes } : {}) };
    }
    if (res) {
      throw new NightError(`"${place.name}" already has a booking for day ${day.n} (${statusOf(res)}, reservation ${res.id}). `
        + 'Use status "dropped" to mark it given up; deleting a booking is done in TREK itself, by the user.');
    }
    return { placeId: place.id, day: day.n, status: 'spotted', changed: false, ...(kindRes ? { kind: kindRes } : {}), note: 'No booking exists: the place is a spotted night.' };
  }

  const input = { status: TO_TREK[a.status] };
  if (a.confirmation != null && a.confirmation !== '') input.confirmation_number = String(a.confirmation).slice(0, 100);
  if (notes !== undefined) input.notes = notes;
  // An evening with no stay: the booking (new, or an unlinked one) comes with a new stay.
  let stay = null;
  if (!night) {
    const nights = Math.max(1, Math.min(30, a.nights || 1));
    const end = model.days[day.index + nights];
    if (!end) throw new NightError(`day ${day.n} + ${nights} night(s) goes past the last day of the trip`);
    stay = { place_id: place.id, start_day_id: day.id, end_day_id: end.id };
  }
  let written;
  let action;
  if (res) {
    // TREK makes and links the stay on an update too, for a hotel booking.
    written = await ctx.reservations.update(model.tripId, res.id, stay ? { ...input, type: 'hotel', create_accommodation: stay } : input);
    action = stay ? 'linked' : 'updated';
  } else {
    const create = { title: place.name, type: 'hotel', place_id: place.id, ...input };
    if (isNight) create.accommodation_id = Number(night.id);
    else if (stay) create.create_accommodation = stay;
    else {
      // Another place is tonight's night: a booking of this candidate only, not planned.
      create.day_id = day.id;
      warnings.push(`Day ${day.n}'s planned night is "${night.name}" (place ${night.placeId}): this booking is recorded for "${place.name}" without changing the plan; vanlife_check_trip lists it as a booking with no night.`);
    }
    written = await ctx.reservations.create(model.tripId, create);
    action = 'created';
  }
  if (a.status === 'booked' && !(input.confirmation_number || (res && res.confirmation_number))) {
    warnings.push('No confirmation number: the trip check lists a confirmed booking without one as a point to verify, until one is recorded (a donation farm may have none: say so in the notes).');
  }
  const after = { status: input.status, notes: notes !== undefined ? notes : res ? res.notes : '' };
  if (staleWaitingNote(after)) warnings.push('The booking\'s notes still say it is waiting for an answer: give notes to replace them.');
  return {
    placeId: place.id, place: place.name, day: day.n, date: day.date,
    status: a.status, trekStatus: input.status, action,
    ...(kindRes ? { kind: kindRes } : {}),
    reservationId: written && written.id != null ? written.id : res ? res.id : null,
    ...(warnings.length ? { warnings } : {}),
    note: 'Recorded as the user declared it. Nothing was booked, paid or sent to the host.',
  };
}

module.exports = {
  STATUSES, TO_TREK, FROM_TREK, RANK, STALE_DAYS, NOTE_TAG, NightError,
  statusOf, isNightReservation, placeOfReservation, dayOfReservation, bookingsOf, reservationFor, candidateReservation,
  unlinkedBookings, nightsMoney, statusByPlace, placeBooked, bookedPrice, staleWaitingNote, freeNotes, notesText, waitingDays, contactView, list, set, placeNights,
};
