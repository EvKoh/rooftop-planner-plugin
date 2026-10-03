'use strict';
// Where each night stands, kept in TREK's own bookings (no table of our own): a night is a
// lodging block (accommodation) and its partner reservation of type "hotel".
//   spotted   → a place with no booking
//   contacted → booking "pending"     (asked the host, waiting)
//   booked    → booking "confirmed"   (+ confirmation number when there is one)
//   dropped   → booking "cancelled"   (+ a short reason in its notes)
// This records what the user declares. It never books, pays or writes to a host.
const placeInfo = require('./place-info');
const contacts = require('./contacts');
const { nightOf } = require('./trip');
const { t } = require('./i18n');

const STATUSES = ['spotted', 'contacted', 'booked', 'dropped'];
const TO_TREK = { contacted: 'pending', booked: 'confirmed', dropped: 'cancelled' };
const FROM_TREK = { pending: 'contacted', confirmed: 'booked', cancelled: 'dropped' };
// When one place has several bookings (two nights, an old dropped one), the strongest wins.
const RANK = { booked: 3, contacted: 2, dropped: 1, spotted: 0 };
const STALE_DAYS = 3;

class NightError extends Error {}

// schedule.js has the same lookup, but requiring it here would loop (schedule → check → here).
const findDay = (model, { dayId, dayNumber }) => model.days.find((d) => (dayId != null && d.id === dayId) || (dayNumber != null && d.n === dayNumber)) || null;
const statusOf = (res) => (res ? FROM_TREK[res.status] || 'contacted' : 'spotted');
const same = (a, b) => a != null && b != null && String(a) === String(b);

/** The place a booking is about: its lodging block's place, else its own place. */
const placeOfReservation = (r) => r.accommodation_place_id ?? r.place_id ?? null;

/** The booking of a planned night: linked to its lodging block, else a hotel booking of that place and day. */
function reservationFor(night, reservations) {
  const list = reservations || [];
  return list.find((r) => same(r.accommodation_id, night.id))
    || list.find((r) => r.type === 'hotel' && same(placeOfReservation(r), night.placeId) && (same(r.accommodation_start_day_id, night.startDayId) || same(r.day_id, night.startDayId)))
    || null;
}

/** A hotel booking of `placeId` starting on `dayId` that is not tied to another lodging block. */
function candidateReservation(reservations, placeId, dayId) {
  return (reservations || []).find((r) => r.type === 'hotel' && same(placeOfReservation(r), placeId)
    && (same(r.day_id, dayId) || same(r.accommodation_start_day_id, dayId))) || null;
}

/** Map placeId → strongest TREK status of its bookings ("confirmed" | "pending" | "cancelled"). */
function statusByPlace(reservations) {
  const out = new Map();
  for (const r of reservations || []) {
    const id = placeOfReservation(r);
    if (id == null || !(r.type === 'hotel' || r.accommodation_id != null)) continue;
    const s = statusOf(r);
    const prev = out.get(Number(id));
    if (!prev || RANK[s] > RANK[prev]) out.set(Number(id), s);
  }
  return out;
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

function contactView(info, raw) {
  const c = (info && info.contacts) || contacts.blankContacts();
  return {
    email: c.email, phone: c.phone || (raw && raw.phone) || null, whatsapp: c.whatsapp,
    website: c.website || (raw && raw.website) || null, preferred_channel: c.preferred_channel, name: c.contact_name,
  };
}

/** One row per night of the trip (every day but the last), with its status, contact, last exchange and price. */
function list(model, settings, { now } = {}) {
  const L = settings.language;
  const resas = model.reservations || [];
  const rows = [];
  model.days.forEach((d, i) => {
    const night = nightOf(model, d);
    if (!night) {
      if (i < model.days.length - 1) rows.push({ day: d.n, date: d.date, dayId: d.id, placeId: null, place: null, status: null, note: 'no night planned on this day' });
      return;
    }
    const place = model.poolById.get(night.placeId);
    const info = place ? place.info : null;
    const res = reservationFor(night, resas);
    const status = statusOf(res);
    const others = resas.filter((r) => r !== res && r.type === 'hotel' && !same(placeOfReservation(r), night.placeId) && same(r.day_id, d.id));
    rows.push({
      day: d.n, date: d.date, dayId: d.id, nights: night.nights,
      placeId: night.placeId, place: night.name,
      status, statusLabel: t(L, `st.${status}`),
      reservationId: res ? res.id : null,
      confirmation: res ? res.confirmation_number || null : null,
      contact: contactView(info, place && place.raw),
      lastExchange: info && info.log && info.log.length ? info.log[0] : null,
      waitingDays: waitingDays(res, info, now),
      price: place ? placeInfo.priceText(place.price, (place.raw && place.raw.currency) || model.currency, info, L) : null,
      ...(others.length ? { alsoAsked: others.map((r) => ({ placeId: placeOfReservation(r), title: r.title, status: statusOf(r), reservationId: r.id })) } : {}),
    });
  });
  const counts = Object.fromEntries(STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]));
  return { trip: model.trip.title, counts, nights: rows };
}

function notesText(a, res) {
  const parts = [];
  if (a.status === 'dropped' && a.reason) parts.push(`Dropped: ${String(a.reason).slice(0, 200)}`);
  if (a.notes) parts.push(String(a.notes).slice(0, 500));
  if (!parts.length) return undefined;
  return parts.join('\n');
}

/**
 * Record the status of a night: create or update the place's hotel booking for that day.
 * a: { placeId, dayNumber | dayId, status, confirmation?, reason?, notes?, nights? }
 */
async function set(ctx, model, a) {
  if (!STATUSES.includes(a.status)) throw new NightError(`status must be one of ${STATUSES.join(', ')}`);
  const day = findDay(model, { dayId: a.dayId, dayNumber: a.dayNumber });
  if (!day) throw new NightError('give dayNumber (or dayId) of the evening the night starts');
  const place = model.poolById.get(a.placeId);
  if (!place) throw new NightError(`place ${a.placeId} is not in trip ${model.tripId}`);
  const resas = model.reservations || [];
  const night = nightOf(model, day);
  const isNight = !!night && night.placeId === place.id;
  const res = isNight ? reservationFor(night, resas) : candidateReservation(resas, place.id, day.id);
  const notes = notesText(a, res);
  const warnings = [];

  if (a.status === 'spotted') {
    if (res) {
      throw new NightError(`"${place.name}" already has a booking for day ${day.n} (${statusOf(res)}, reservation ${res.id}). `
        + 'Use status "dropped" to mark it given up; deleting a booking is done in TREK itself, by the user.');
    }
    return { placeId: place.id, day: day.n, status: 'spotted', changed: false, note: 'No booking exists: the place is a spotted night.' };
  }

  const input = { status: TO_TREK[a.status] };
  if (a.confirmation != null && a.confirmation !== '') input.confirmation_number = String(a.confirmation).slice(0, 100);
  if (notes !== undefined) input.notes = notes;
  let written;
  let action;
  if (res) {
    written = await ctx.reservations.update(model.tripId, res.id, input);
    action = 'updated';
  } else {
    const create = { title: place.name, type: 'hotel', place_id: place.id, ...input };
    if (isNight) {
      create.accommodation_id = Number(night.id);
    } else if (!night) {
      const nights = Math.max(1, Math.min(30, a.nights || 1));
      const end = model.days[day.index + nights];
      if (!end) throw new NightError(`day ${day.n} + ${nights} night(s) goes past the last day of the trip`);
      // TREK creates the lodging block with the booking: the night is then planned.
      create.create_accommodation = { place_id: place.id, start_day_id: day.id, end_day_id: end.id };
    } else {
      // Another place is tonight's night: a booking of this candidate only, not planned.
      create.day_id = day.id;
      warnings.push(`Day ${day.n}'s planned night is "${night.name}" (place ${night.placeId}): this booking is recorded for "${place.name}" without changing the plan.`);
    }
    written = await ctx.reservations.create(model.tripId, create);
    action = 'created';
  }
  if (a.status === 'booked' && !(input.confirmation_number || (res && res.confirmation_number))) {
    warnings.push('No confirmation number: the trip check flags a confirmed booking without one as blocking until it is recorded.');
  }
  return {
    placeId: place.id, place: place.name, day: day.n, date: day.date,
    status: a.status, trekStatus: input.status, action,
    reservationId: written && written.id != null ? written.id : res ? res.id : null,
    ...(warnings.length ? { warnings } : {}),
    note: 'Recorded as the user declared it. Nothing was booked, paid or sent to the host.',
  };
}

module.exports = {
  STATUSES, TO_TREK, FROM_TREK, STALE_DAYS, NightError,
  statusOf, reservationFor, candidateReservation, statusByPlace, placeOfReservation, waitingDays, list, set,
};
