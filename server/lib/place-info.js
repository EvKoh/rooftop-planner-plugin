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
const { t, money, num } = require('./i18n');
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
const PER = ['night', 'person'];
const LIMITS = { max_height_m: [1, 6], max_length_m: [2, 25], max_weight_t: [0.5, 60] };
const MIGRATION = 'CREATE TABLE IF NOT EXISTS place_info_index (trip_id INTEGER NOT NULL, place_id INTEGER NOT NULL, PRIMARY KEY (trip_id, place_id))';
const COPY_MIGRATION = 'CREATE TABLE IF NOT EXISTS place_info_copy (place_id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL, rec TEXT NOT NULL)';
const COPY_SQL = 'SELECT place_id, rec FROM place_info_copy WHERE trip_id = ?';
const INDEX_SQL = 'SELECT place_id FROM place_info_index WHERE trip_id = ?';
// Records read one by one per call when the copy lacks them (older records): the rest
// waits for the next call, which finds them copied.
const BACKFILL = 24;

class InfoError extends Error {}

const blank = () => ({
  per: 'night',
  dog_fee: null,
  max_height_m: null,
  max_length_m: null,
  max_weight_t: null,
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

/**
 * Merge a patch onto a stored record (or a blank one), validating every field.
 * Patch: { per, dog_fee, max_height_m, max_length_m, max_weight_t, source, checked,
 *          and one value per key of AMENITIES (dog, water, electricity...) }.
 * null clears a number back to unknown. Throws InfoError with a readable message.
 */
function merge(stored, patch) {
  const out = { ...blank(), ...(stored || {}) };
  out.amenities = { ...blank().amenities, ...((stored && stored.amenities) || {}) };
  delete out.price; // an older record carried its own price: TREK's field is the only one now
  const p = patch || {};
  if ('per' in p) {
    if (!PER.includes(p.per)) throw new InfoError(`per must be one of ${PER.join(', ')}`);
    out.per = p.per;
  }
  const fee = numberField(p, 'dog_fee', 0, 1000);
  if (fee !== undefined) out.dog_fee = fee;
  for (const [k, [min, max]] of Object.entries(LIMITS)) {
    const v = numberField(p, k, min, max);
    if (v !== undefined) out[k] = v;
  }
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
  for (const k of Object.keys(out.contact_sources)) if (out.contacts[k] == null || (Array.isArray(out.contacts[k]) && !out.contacts[k].length)) delete out.contact_sources[k];
}

const NUMBER_FIELDS = ['dog_fee', ...Object.keys(LIMITS)];

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
    else if (k === 'per') patch.per = 'night';
    else if (k === 'source' || k === 'checked') patch[k] = null;
    else if (k === 'amenities') for (const a of Object.keys(AMENITIES)) patch[a] = 'unknown';
    else if (k === 'contacts') for (const c of contacts.FIELDS) contactPatch[c] = null;
    else if (k === 'log') patch.log = null;
    else if (contacts.FIELDS.includes(k)) contactPatch[k] = null;
    else throw new InfoError(`cannot clear "${f}": name an amenity (${Object.keys(AMENITIES).slice(0, 4).join(', ')}...), ${NUMBER_FIELDS.join(', ')}, per, source, checked, a contact field (${contacts.FIELDS.join(', ')}), or amenities / contacts / log`);
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
  if (rec.contacts.website && !place.website) out.website = rec.contacts.website;
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

/** Price of one night for the whole party, from TREK's price and the recorded details. */
function nightTotal(price, info, settings) {
  if (price == null) return null;
  const people = info && info.per === 'person' ? (settings.travellers || 2) : 1;
  const dog = settings.dog && info && info.amenities.dog === 'fee' && info.dog_fee != null ? info.dog_fee : 0;
  return Math.round((price * people + dog) * 100) / 100;
}

/** "22,00 €/nuit" (+ " + chien 2,50 €"), or null when TREK has no price for the place. */
function priceText(price, currency, info, lang) {
  if (price == null) return null;
  let s = `${money(price, currency, lang)}${t(lang, `per.${info && info.per === 'person' ? 'person' : 'night'}`)}`;
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

module.exports = { clearPatch, nativeContacts, NUMBER_FIELDS, COPY_SQL, INDEX_SQL, COPY_MIGRATION, merge, nativePrice, nightTotal, priceText, amenitiesText, refuses, get, set, clear, getAll, migrate, blank, AMENITIES, PER, LIMITS, META_KEY, MIGRATION, InfoError };
