'use strict';
// Amenities of a place (a night, a car park...) and the price details TREK has no field for.
//
// The price itself is TREK's own: the place's `price` and `currency`, written with
// ctx.places.update and shown by TREK in the place header. It is never stored twice. What
// TREK lacks lives in the plugin's namespaced data on the place, ctx.meta('place', id,
// 'info.v1'): price per night or per person, dog fee, height/length/weight limits, the
// amenities, and the source; the host's contacts (e-mail, phone, WhatsApp, website, name,
// languages, preferred channel, notes), where each automatic one came from, and the log of
// exchanges with the host (contacts.js). The host checks the place belongs to a trip the user can
// access, and writes need place_edit.
//
// An index of (trip, place) pairs that HAVE a record, in the plugin's own db, lets the
// planner columns read only those places (ctx.* calls are rate-limited, and a trip can
// hold hundreds of places); a stale entry is dropped on read. A copy of each record sits
// beside it, so the columns read a whole trip in one query: reading hundreds of records
// one by one does not fit the short time TREK gives a planner column. The copy on the
// place stays the reference; this one is rewritten on every save.
// Every value may be "unknown": nothing is ever guessed.
const { toNum, pmap } = require('./util');
const { t, money, num, clock } = require('./i18n');
const contacts = require('./contacts');

const META_KEY = 'info.v1';
const TRISTATE = ['yes', 'no', 'unknown'];
// In the order the planner shows them, most useful first.
const AMENITIES = {
  dog: ['yes', 'no', 'fee', 'unknown'],
  water: TRISTATE,
  electricity: TRISTATE,
  toilets: TRISTATE,
  shower: TRISTATE,
  dump_station: TRISTATE,
  wifi: TRISTATE,
  bins: TRISTATE,
  laundry: TRISTATE,
  pool: TRISTATE,
  shop: TRISTATE,
  bakery: TRISTATE,
  restaurant: TRISTATE,
  bar: TRISTATE,
  mobile_data: TRISTATE,
  playground: TRISTATE,
  bbq: TRISTATE,
  gas: TRISTATE,
  lpg: TRISTATE,
  vehicle_wash: TRISTATE,
  winter: TRISTATE,
  rooftop_tent: TRISTATE,
};
// The unit the price is for. null = not said: a night place then reads "/night", any
// other place shows the amount alone. 'flat' is a lump sum with no unit.
const PER = ['night', 'person', 'person_night', 'day', 'hour', 'entry', 'vehicle', 'flat'];
const PRICE_NOTE_MAX = 120;
// Units that make a night price for the party: per person ones are multiplied by the travellers.
const PER_PERSON = ['person', 'person_night'];
const NOT_A_NIGHT_PRICE = ['hour', 'entry'];
const LIMITS = { max_height_m: [1, 6], max_length_m: [2, 25], max_weight_t: [0.5, 60] };
// Time on site of a visit (museum, lake, hike...), in minutes: the minimum counts for the
// day's load, the maximum is optional.
const VISIT = { visit_min_minutes: [5, 1440], visit_max_minutes: [5, 1440] };
// Timed access to a place (a toll road to pass before a set hour, a road closed to cars in
// the day, a slot to book, a ticket per vehicle). access_before / access_after are "HH:MM":
// with only one, it is a limit; with both, before < after is a road closed in between
// (arrive before OR after), after < before a road open in between (arrive after AND before).
const ACCESS_FIELDS = ['access_before', 'access_after', 'booking_required', 'booking_url', 'booking_note', 'toll_amount', 'toll_currency'];
const BOOKING_NOTE_MAX = 120;
// A hike's walk: the car park it starts from (a TREK place of the trip), the points it passes
// (a loop's refuges, a pass...) and whether it comes back to the car park. walks.js draws it.
const WALK_FIELDS = ['access_parking_place_id', 'walk_via', 'walk_loop'];
const WALK_VIA_MAX = 8;
const TOLL_MAX = 10000;
const MIGRATION = 'CREATE TABLE IF NOT EXISTS place_info_index (trip_id INTEGER NOT NULL, place_id INTEGER NOT NULL, PRIMARY KEY (trip_id, place_id))';
const COPY_MIGRATION = 'CREATE TABLE IF NOT EXISTS place_info_copy (place_id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL, rec TEXT NOT NULL)';
const COPY_SQL = 'SELECT place_id, rec FROM place_info_copy WHERE trip_id = ?';
const INDEX_SQL = 'SELECT place_id FROM place_info_index WHERE trip_id = ?';
// Records read one by one per call when the copy lacks them (older records): the rest
// waits for the next call, which finds them copied.
const BACKFILL = 24;

class InfoError extends Error {}

const blank = () => ({
  per: null,
  price_note: null,
  dog_fee: null,
  max_height_m: null,
  max_length_m: null,
  max_weight_t: null,
  visit_min_minutes: null,
  visit_max_minutes: null,
  visit_source: null,
  access_before: null,
  access_after: null,
  booking_required: null,
  booking_url: null,
  booking_note: null,
  toll_amount: null,
  toll_currency: null,
  access_parking_place_id: null,
  walk_via: null,
  walk_loop: null,
  amenities: Object.fromEntries(Object.keys(AMENITIES).map((k) => [k, 'unknown'])),
  source: null,
  checked: null,
  contacts: contacts.blankContacts(),
  contact_sources: {},
  log: [],
});

function numberField(p, k, min, max) {
  if (!(k in p)) return undefined;
  if (p[k] === null || p[k] === '') return null;
  const n = toNum(p[k]);
  if (n == null || n < min || n > max) throw new InfoError(`${k} must be a number between ${min} and ${max}, or null for unknown`);
  return Math.round(n * 100) / 100;
}

/** "9:05", "09:05" → "09:05"; null for null or ''; throws on anything else. */
function timeField(p, k) {
  if (p[k] == null || p[k] === '') return null;
  const m = String(p[k]).trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) throw new InfoError(`${k} must be a time HH:MM (e.g. 09:00), or null to clear`);
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/** Timed access, booking and toll fields of a patch, validated onto `out`. */
function mergeAccess(out, p) {
  for (const k of ['access_before', 'access_after']) if (k in p) out[k] = timeField(p, k);
  if (out.access_before && out.access_before === out.access_after) throw new InfoError('access_before and access_after cannot be the same time');
  if ('booking_required' in p) {
    const v = p.booking_required;
    if (v !== null && v !== '' && typeof v !== 'boolean') throw new InfoError('booking_required must be true, false, or null when not known');
    out.booking_required = typeof v === 'boolean' ? v : null;
  }
  if ('booking_url' in p) {
    const u = p.booking_url == null ? '' : String(p.booking_url).trim();
    if (u && (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(u) || u.length > 500)) throw new InfoError('booking_url must be an http:// or https:// address (500 characters at most)');
    out.booking_url = u || null;
  }
  if ('booking_note' in p) {
    const note = p.booking_note == null ? '' : String(p.booking_note).replace(/\s+/g, ' ').trim();
    if (note.length > BOOKING_NOTE_MAX) throw new InfoError(`booking_note is too long (${BOOKING_NOTE_MAX} characters at most)`);
    out.booking_note = note || null;
  }
  if ('toll_amount' in p) {
    if (p.toll_amount === null || p.toll_amount === '') out.toll_amount = null;
    else {
      const n = toNum(p.toll_amount);
      if (n == null || n < 0 || n > TOLL_MAX) throw new InfoError(`toll_amount must be a number from 0 to ${TOLL_MAX} (per vehicle), or null to clear`);
      out.toll_amount = Math.round(n * 100) / 100;
    }
  }
  if ('toll_currency' in p) {
    const c = p.toll_currency == null ? '' : String(p.toll_currency).trim().toUpperCase();
    if (c && !/^[A-Z]{3}$/.test(c)) throw new InfoError('toll_currency must be a 3-letter ISO code (EUR, CHF...), or null for the trip\'s currency');
    out.toll_currency = c || null;
  }
}

/**
 * Merge a patch onto a stored record (or a blank one), validating every field.
 * Patch: { per, price_note, dog_fee, max_height_m, max_length_m, max_weight_t, source, checked,
 *          the ACCESS_FIELDS, and one value per key of AMENITIES (dog, water, electricity...) }.
 * null clears a number back to unknown. Throws InfoError with a readable message.
 */
function merge(stored, patch) {
  const out = { ...blank(), ...(stored || {}) };
  out.amenities = { ...blank().amenities, ...((stored && stored.amenities) || {}) };
  delete out.price; // an older record carried its own price: TREK's field is the only one now
  // A record written before 0.4.2 (no price_note key) carried per 'night' as a default, even
  // on a lake or a museum: read as "not said", which still shows "/night" on a night place.
  if (stored && !('price_note' in stored) && stored.per === 'night') out.per = null;
  const p = patch || {};
  if ('per' in p) {
    if (p.per == null || p.per === '') out.per = null;
    else if (!PER.includes(p.per)) throw new InfoError(`per must be one of ${PER.join(', ')}, or null when not said`);
    else out.per = p.per;
  }
  if ('price_note' in p) {
    const note = p.price_note == null ? '' : String(p.price_note).replace(/\s+/g, ' ').trim();
    if (note.length > PRICE_NOTE_MAX) throw new InfoError(`price_note is too long (${PRICE_NOTE_MAX} characters at most)`);
    out.price_note = note || null;
  }
  const fee = numberField(p, 'dog_fee', 0, 1000);
  if (fee !== undefined) out.dog_fee = fee;
  for (const [k, [min, max]] of Object.entries(LIMITS)) {
    const v = numberField(p, k, min, max);
    if (v !== undefined) out[k] = v;
  }
  let visitChanged = false;
  for (const [k, [min, max]] of Object.entries(VISIT)) {
    const v = numberField(p, k, min, max);
    if (v === undefined) continue;
    const next = v == null ? null : Math.round(v);
    if (next !== out[k]) visitChanged = true;
    out[k] = next;
  }
  if (out.visit_min_minutes != null && out.visit_max_minutes != null && out.visit_max_minutes < out.visit_min_minutes) {
    throw new InfoError('visit_max_minutes must be at least visit_min_minutes');
  }
  // A duration someone types loses its automatic source.
  if (visitChanged && !('visit_source' in p)) out.visit_source = null;
  if ('visit_source' in p) out.visit_source = p.visit_source == null || p.visit_source === '' ? null : String(p.visit_source).slice(0, 200);
  if (out.visit_min_minutes == null && out.visit_max_minutes == null) out.visit_source = null;
  mergeAccess(out, p);
  mergeWalk(out, p);
  for (const [k, allowed] of Object.entries(AMENITIES)) {
    if (!(k in p)) continue;
    if (!allowed.includes(p[k])) throw new InfoError(`${k} must be one of ${allowed.join(', ')}`);
    out.amenities[k] = p[k];
  }
  if ('source' in p) out.source = p.source == null || p.source === '' ? null : String(p.source).slice(0, 300);
  if ('checked' in p) {
    if (p.checked != null && p.checked !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(p.checked))) throw new InfoError('checked must be a date YYYY-MM-DD');
    out.checked = p.checked || null;
  }
  if (out.dog_fee != null && out.amenities.dog === 'unknown') out.amenities.dog = 'fee';
  mergeContacts(out, stored, p);
  return out;
}

/**
 * The tool's `walk` object ({ parking_place_id, via, loop }) as record fields (WALK_FIELDS);
 * null clears the three. Keys left out stay as they are.
 */
function expandWalk(patch) {
  if (!patch || !('walk' in patch)) return patch;
  const { walk, ...rest } = patch;
  if (walk == null) return { ...rest, access_parking_place_id: null, walk_via: null, walk_loop: null };
  if (typeof walk !== 'object' || Array.isArray(walk)) throw new InfoError('walk must be an object { parking_place_id, via, loop }, or null to clear');
  const unknown = Object.keys(walk).filter((k) => !['parking_place_id', 'via', 'loop'].includes(k));
  if (unknown.length) throw new InfoError(`walk takes parking_place_id, via and loop, not ${unknown.join(', ')}`);
  if ('parking_place_id' in walk) rest.access_parking_place_id = walk.parking_place_id;
  if ('via' in walk) rest.walk_via = walk.via;
  if ('loop' in walk) rest.walk_loop = walk.loop;
  return rest;
}

/** The walk fields of a patch (WALK_FIELDS), validated onto `out`. */
function mergeWalk(out, p) {
  if ('access_parking_place_id' in p) {
    const v = p.access_parking_place_id;
    if (v === null || v === '') out.access_parking_place_id = null;
    else if (!Number.isInteger(Number(v)) || Number(v) < 1) throw new InfoError('walk.parking_place_id must be the id of a car park place of the trip, or null to go back to the guess');
    else out.access_parking_place_id = Number(v);
  }
  if ('walk_via' in p) {
    const v = p.walk_via;
    if (v == null || (Array.isArray(v) && !v.length)) out.walk_via = null;
    else {
      const bad = () => new InfoError(`walk_via must be a list of at most ${WALK_VIA_MAX} points [lat, lng], or null to clear`);
      if (!Array.isArray(v) || v.length > WALK_VIA_MAX) throw bad();
      out.walk_via = v.map((pt) => {
        const lat = toNum(Array.isArray(pt) ? pt[0] : pt && pt.lat);
        const lng = toNum(Array.isArray(pt) ? pt[1] : pt && pt.lng);
        if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) throw bad();
        return [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5];
      });
    }
  }
  if ('walk_loop' in p) {
    const v = p.walk_loop;
    if (v !== null && v !== '' && typeof v !== 'boolean') throw new InfoError('walk_loop must be true (the walk comes back to the car park), false, or null');
    out.walk_loop = typeof v === 'boolean' ? v : null;
  }
}

/**
 * Contacts, their sources and the exchange log. Patch keys: `contacts` ({ field: value|null }),
 * `contact_sources` ({ field: text }, written by the filler), `log` (one entry to add, or
 * null to empty the log). A field a person sets loses its automatic source.
 */
function mergeContacts(out, stored, p) {
  out.contacts = { ...contacts.blankContacts(), ...((stored && stored.contacts) || {}) };
  out.contact_sources = { ...((stored && stored.contact_sources) || {}) };
  out.log = Array.isArray(stored && stored.log) ? stored.log.slice(0, contacts.LOG_MAX) : [];
  try {
    if ('contacts' in p && p.contacts != null) {
      const r = contacts.patchContacts(out.contacts, p.contacts);
      out.contacts = r.contacts;
      for (const k of r.changed) delete out.contact_sources[k];
    }
    if (p.contact_sources) {
      for (const [k, v] of Object.entries(p.contact_sources)) if (contacts.FIELDS.includes(k) && v) out.contact_sources[k] = String(v).slice(0, 200);
    }
    if ('log' in p) out.log = p.log === null ? [] : contacts.addLog(out.log, contacts.logEntry(p.log));
  } catch (e) {
    throw new InfoError(e.message);
  }
  // A platform page (park4night, Google Maps...) an automatic source wrote as the website is
  // not the host's site: dropped, so the next fill can find the real one. Typed by a person
  // (no source), it stays.
  if (out.contacts.website && out.contact_sources.website && contacts.notOwnSite(out.contacts.website)) out.contacts.website = null;
  for (const k of Object.keys(out.contact_sources)) if (out.contacts[k] == null || (Array.isArray(out.contacts[k]) && !out.contacts[k].length)) delete out.contact_sources[k];
}

const NUMBER_FIELDS = ['dog_fee', ...Object.keys(LIMITS), ...Object.keys(VISIT)];

/**
 * The patch that clears the named fields: an amenity goes back to unknown, a number to null,
 * a contact field to empty; "amenities", "contacts" and "log" clear the whole group.
 */
function clearPatch(fields) {
  const patch = {};
  const contactPatch = {};
  for (const f of fields || []) {
    const k = String(f).replace(/^contacts\./, '');
    if (k in AMENITIES) patch[k] = 'unknown';
    else if (NUMBER_FIELDS.includes(k)) patch[k] = null;
    else if (k === 'per' || k === 'price_note' || k === 'source' || k === 'checked' || ACCESS_FIELDS.includes(k) || WALK_FIELDS.includes(k)) patch[k] = null;
    else if (k === 'amenities') for (const a of Object.keys(AMENITIES)) patch[a] = 'unknown';
    else if (k === 'contacts') for (const c of contacts.FIELDS) contactPatch[c] = null;
    else if (k === 'log') patch.log = null;
    else if (k === 'walk') for (const w of WALK_FIELDS) patch[w] = null;
    else if (contacts.FIELDS.includes(k)) contactPatch[k] = null;
    else throw new InfoError(`cannot clear "${f}": name an amenity (${Object.keys(AMENITIES).slice(0, 4).join(', ')}...), ${NUMBER_FIELDS.join(', ')}, per, price_note, source, checked, ${ACCESS_FIELDS.join(', ')}, ${WALK_FIELDS.join(', ')}, a contact field (${contacts.FIELDS.join(', ')}), or amenities / contacts / log`);
  }
  if (Object.keys(contactPatch).length) patch.contacts = contactPatch;
  return patch;
}

/**
 * TREK's own website and phone fields of a place, filled from the contacts when they are
 * empty there (TREK has no e-mail field: the e-mail stays in the plugin's record).
 */
function nativeContacts(place, rec) {
  if (!place || !rec || !rec.contacts) return null;
  const out = {};
  if (rec.contacts.website && !place.website && !contacts.notOwnSite(rec.contacts.website)) out.website = rec.contacts.website;
  if (rec.contacts.phone && !place.phone) out.phone = rec.contacts.phone;
  return Object.keys(out).length ? out : null;
}

/** The native price fields of a patch: { price, currency } to send to TREK, or null. */
function nativePrice(p) {
  if (!p || (!('price_amount' in p) && !('currency' in p))) return null;
  const out = {};
  if ('price_amount' in p) {
    const v = numberField(p, 'price_amount', 0, 100000);
    out.price = v === undefined ? null : v;
  }
  if ('currency' in p) {
    if (!/^[A-Z]{3}$/.test(String(p.currency))) throw new InfoError('currency must be a 3-letter ISO code (EUR, CHF...)');
    out.currency = String(p.currency);
  }
  return out;
}

/**
 * Price of one night for the whole party, from TREK's price and the recorded details; null
 * when the unit cannot make a night price (per hour, per entry).
 */
function nightTotal(price, info, settings) {
  if (price == null) return null;
  if (info && NOT_A_NIGHT_PRICE.includes(info.per)) return null;
  const people = info && PER_PERSON.includes(info.per) ? (settings.travellers || 2) : 1;
  const dog = settings.dog && info && info.amenities.dog === 'fee' && info.dog_fee != null ? info.dog_fee : 0;
  return Math.round((price * people + dog) * 100) / 100;
}

/** Does the free price note already state this amount ("5 €/h" for 5)? */
function noteHasAmount(note, price) {
  return (String(note).match(/\d+(?:[.,]\d+)?/g) || []).some((x) => Number(x.replace(',', '.')) === Number(price));
}

/**
 * "22,00 €/nuit", "5,00 €/h", "8,00 €" (+ " + chien 2,50 €"); the free note when there is
 * one, after the amount unless the note already says it. With no unit recorded, a night
 * place (`night`) reads per night and any other place shows the amount alone.
 * null when there is neither a price nor a note.
 */
function priceText(price, currency, info, lang, { night = false } = {}) {
  const note = info && info.price_note;
  const amount = price == null ? null : money(price, currency, lang);
  let s;
  if (note) s = amount && !noteHasAmount(note, price) ? `${amount} · ${note}` : note;
  else if (amount == null) return null;
  else {
    const per = (info && info.per) || (night ? 'night' : null);
    s = `${amount}${per && per !== 'flat' ? t(lang, `per.${per}`) : ''}`;
  }
  if (info && info.amenities.dog === 'fee' && info.dog_fee != null) s += ` + ${t(lang, 'am.dog')} ${money(info.dog_fee, currency, lang)}`;
  return s;
}

/**
 * Compact amenities line, emoji-free (the host strips emoji from planner columns):
 * "✓ chien · eau · douche  ✗ élec.  ↕ 2,1 m". Unknown values are left out. null when empty.
 */
function amenitiesText(info, lang) {
  if (!info) return null;
  const yes = [];
  const no = [];
  for (const k of Object.keys(AMENITIES)) {
    const v = info.amenities[k];
    if (v === 'yes') yes.push(t(lang, `am.${k}`));
    else if (v === 'fee') yes.push(`${t(lang, `am.${k}`)} (${t(lang, 'fee')})`);
    else if (v === 'no') no.push(t(lang, `am.${k}`));
  }
  const parts = [];
  if (yes.length) parts.push(`✓ ${yes.join(' · ')}`);
  if (no.length) parts.push(`✗ ${no.join(' · ')}`);
  if (info.max_height_m != null) parts.push(`↕ ${num(info.max_height_m, lang)} m`);
  if (info.max_length_m != null) parts.push(`↔ ${num(info.max_length_m, lang)} m`);
  if (info.max_weight_t != null) parts.push(`${num(info.max_weight_t, lang)} t max`);
  return parts.length ? parts.join('  ') : null;
}

/** 210 → "3 h 30 min", 45 → "45 min", 120 → "2 h"; null for null. */
function duration(m) {
  if (m == null) return null;
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  if (!h) return `${mm} min`;
  return mm ? `${h} h ${String(mm).padStart(2, '0')} min` : `${h} h`;
}

/** "3 h 30 min" or "2 h – 3 h 30 min" for a record's visit duration, or null. */
function visitText(info) {
  if (!info || (info.visit_min_minutes == null && info.visit_max_minutes == null)) return null;
  const a = duration(info.visit_min_minutes ?? info.visit_max_minutes);
  return info.visit_max_minutes != null && info.visit_min_minutes != null && info.visit_max_minutes > info.visit_min_minutes ? `${a} – ${duration(info.visit_max_minutes)}` : a;
}

const hmOf = (s) => (s ? +s.slice(0, 2) * 60 + +s.slice(3) : null);

/**
 * Is an arrival at `arr` (minutes) allowed by the record's access hours? null when fine or not
 * known; else { key, before, after, late?, wait? } in minutes:
 *  - access_late   (only a "before" limit, or an open window): arrived `late` min after it;
 *  - access_early  (only an "after" limit, or an open window): `wait` min before it;
 *  - access_window (road closed between before and after): late and wait both given.
 */
function accessVerdict(info, arr) {
  if (!info || arr == null) return null;
  const before = hmOf(info.access_before);
  const after = hmOf(info.access_after);
  if (before == null && after == null) return null;
  if (before != null && after != null && before < after) {
    return arr > before && arr < after ? { key: 'access_window', before, after, late: arr - before, wait: after - arr } : null;
  }
  if (before != null && arr > before) return { key: 'access_late', before, after, late: arr - before };
  if (after != null && arr < after) return { key: 'access_early', before, after, wait: after - arr };
  return null;
}

/** The toll's currency: its own, else the place's, else the trip's. */
const tollCurrency = (info, fallback) => (info && info.toll_currency) || fallback || 'EUR';

/**
 * The access chips of a record, in the planner's order: { key, label, value, icon, tone }.
 * Only what is recorded: no chip for an unknown or a "no booking" value.
 */
function accessChips(info, L, currency) {
  if (!info) return [];
  const { CHIP } = require('./design');
  const out = [];
  if (info.access_before) out.push({ key: 'access-before', label: t(L, 'col.access'), value: t(L, 'chip.accessBefore', { time: clock(hmOf(info.access_before), L) }), ...CHIP.accessBefore });
  if (info.access_after) out.push({ key: 'access-after', label: t(L, 'col.access'), value: t(L, 'chip.accessAfter', { time: clock(hmOf(info.access_after), L) }), ...CHIP.accessAfter });
  if (info.booking_required === true) out.push({ key: 'booking', label: t(L, 'col.booking'), value: t(L, 'chip.booking'), ...CHIP.booking });
  if (info.toll_amount != null) out.push({ key: 'toll', label: t(L, 'col.toll'), value: t(L, 'chip.toll', { amount: money(info.toll_amount, tollCurrency(info, currency), L) }), ...CHIP.toll });
  return out;
}

/** "Before 09:00 · Booking · Toll €40.00" for the place tool, or null. */
function accessText(info, L, currency) {
  const chips = accessChips(info, L, currency).map((c) => c.value);
  if (info && info.booking_note) chips.push(info.booking_note);
  return chips.length ? chips.join(' · ') : null;
}

/** Does the place refuse this vehicle or party? (rooftop tent refused, dog refused, a limit exceeded) */
function refuses(info, settings) {
  if (!info) return false;
  return (settings.vehicle === 'rooftop_tent' && info.amenities.rooftop_tent === 'no')
    || (settings.dog && info.amenities.dog === 'no')
    || (info.max_height_m != null && info.max_height_m < settings.vehicle_height_m)
    || (info.max_length_m != null && info.max_length_m < settings.vehicle_length_m)
    || (info.max_weight_t != null && info.max_weight_t < settings.vehicle_weight_t);
}

async function migrate(ctx) {
  await ctx.db.migrate('002_place_info_index', MIGRATION);
  await ctx.db.migrate('004_place_info_copy', COPY_MIGRATION);
}

async function writeCopy(ctx, tripId, placeId, rec) {
  try {
    await ctx.db.exec('INSERT OR REPLACE INTO place_info_copy (place_id, trip_id, rec) VALUES (?, ?, ?)', Number(placeId), Number(tripId), JSON.stringify(rec));
  } catch { /* the copy only speeds up reads */ }
}

async function get(ctx, placeId) {
  const v = await ctx.meta.get('place', Number(placeId), META_KEY);
  return v && typeof v === 'object' && v.amenities ? merge(v, {}) : null;
}

/**
 * Validate; write the price (and an empty website or phone, given `place`, TREK's own row)
 * on TREK's own place, the rest on the place's plugin data; index it.
 */
async function set(ctx, tripId, placeId, patch, { place } = {}) {
  const price = nativePrice(patch);
  const rest = { ...(patch || {}) };
  delete rest.price_amount;
  delete rest.currency;
  const current = await get(ctx, placeId);
  const next = merge(current, rest);
  const native = { ...(price || {}), ...(nativeContacts(place, next) || {}) };
  if (Object.keys(native).length) await ctx.places.update(Number(tripId), Number(placeId), native);
  await ctx.meta.set('place', Number(placeId), META_KEY, next);
  try {
    await ctx.db.exec('INSERT OR IGNORE INTO place_info_index (trip_id, place_id) VALUES (?, ?)', Number(tripId), Number(placeId));
  } catch { /* index is an optimisation; the value is safe on the place */ }
  await writeCopy(ctx, tripId, placeId, next);
  return next;
}

async function clear(ctx, tripId, placeId) {
  await ctx.meta.delete('place', Number(placeId), META_KEY);
  try { await ctx.db.exec('DELETE FROM place_info_index WHERE trip_id = ? AND place_id = ?', Number(tripId), Number(placeId)); } catch { /* ignore */ }
  try { await ctx.db.exec('DELETE FROM place_info_copy WHERE place_id = ?', Number(placeId)); } catch { /* ignore */ }
}

/**
 * Map(placeId → record) for a trip. `placeIds` limits the read to places that still exist
 * on the trip; index rows pointing to deleted places or cleared values are pruned.
 */
async function getAll(ctx, tripId, placeIds) {
  const alive = new Set(placeIds || []);
  const keep = (id) => !placeIds || alive.has(id);
  const out = new Map();
  let copies = [];
  try { copies = await ctx.db.query(COPY_SQL, Number(tripId)); } catch { copies = []; }
  for (const r of copies) {
    if (!keep(r.place_id)) continue;
    try {
      const v = JSON.parse(r.rec);
      if (v && v.amenities) out.set(r.place_id, merge(v, {}));
    } catch { /* an unreadable copy is read again from the place below */ }
  }
  let rows = [];
  try { rows = await ctx.db.query(INDEX_SQL, Number(tripId)); } catch { rows = []; }
  const missing = rows.map((r) => r.place_id).filter((id) => keep(id) && !out.has(id)).slice(0, BACKFILL);
  const stale = rows.map((r) => r.place_id).filter((id) => placeIds && !alive.has(id));
  // At most 8 meta reads in flight: the host allows 16 in-flight RPCs per plugin.
  await pmap(missing, 8, async (id) => {
    try {
      const v = await get(ctx, id);
      if (v) { out.set(id, v); await writeCopy(ctx, tripId, id, v); } else stale.push(id);
    } catch { /* a place the user cannot read contributes nothing */ }
  });
  if (stale.length) {
    try {
      await ctx.db.tx(stale.slice(0, 100).flatMap((id) => [
        { sql: 'DELETE FROM place_info_index WHERE trip_id = ? AND place_id = ?', args: [Number(tripId), id] },
        { sql: 'DELETE FROM place_info_copy WHERE place_id = ?', args: [id] },
      ]));
    } catch { /* ignore */ }
  }
  return out;
}

module.exports = { expandWalk, WALK_FIELDS, WALK_VIA_MAX, ACCESS_FIELDS, BOOKING_NOTE_MAX, TOLL_MAX, accessVerdict, accessChips, accessText, tollCurrency, hmOf, VISIT, duration, visitText, PRICE_NOTE_MAX, noteHasAmount, clearPatch, nativeContacts, NUMBER_FIELDS, COPY_SQL, INDEX_SQL, COPY_MIGRATION, merge, nativePrice, nightTotal, priceText, amenitiesText, refuses, get, set, clear, getAll, migrate, blank, AMENITIES, PER, LIMITS, META_KEY, MIGRATION, InfoError };
