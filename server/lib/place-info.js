'use strict';
// Price and amenities of a place (a night, a car park...), shown in the planner instead of
// being packed into the place's title.
//
// Storage:
//  - the value lives on the place itself: ctx.meta('place', placeId, 'info.v1'). The host
//    checks the place belongs to a trip the user can access, and writes need place_edit.
//  - an index of (trip, place) pairs that HAVE a value, in the plugin's own db, so the
//    planner columns read only those places (ctx.* calls are rate-limited, a trip can hold
//    hundreds of places). The index holds ids only; a stale entry is dropped on read.
// Every field may be "unknown": nothing is ever guessed.
const { toNum, pmap } = require('./util');

const META_KEY = 'info.v1';
const TRISTATE = ['yes', 'no', 'unknown'];
const AMENITIES = {
  dog: ['yes', 'no', 'fee', 'unknown'],
  water: TRISTATE,
  electricity: TRISTATE,
  shower: TRISTATE,
  toilets: TRISTATE,
  dump_station: TRISTATE,
  wifi: TRISTATE,
  rooftop_tent: TRISTATE,
};
const PER = ['night', 'person'];
const MIGRATION = 'CREATE TABLE IF NOT EXISTS place_info_index (trip_id INTEGER NOT NULL, place_id INTEGER NOT NULL, PRIMARY KEY (trip_id, place_id))';

class InfoError extends Error {}

const blank = () => ({
  price: { amount: null, currency: 'EUR', per: 'night' },
  dog_fee: null,
  max_height_m: null,
  amenities: Object.fromEntries(Object.keys(AMENITIES).map((k) => [k, 'unknown'])),
  source: null,
  checked: null,
});

/**
 * Merge a patch onto a stored record (or a blank one), validating every field.
 * Patch shape: { price_amount, currency, per, dog_fee, max_height_m, source, checked,
 *                dog, water, electricity, shower, toilets, dump_station, wifi, rooftop_tent }
 * null clears a number back to unknown. Throws InfoError with a readable message.
 */
function merge(stored, patch) {
  const out = JSON.parse(JSON.stringify(stored || blank()));
  const p = patch || {};
  const num = (k, min, max) => {
    if (!(k in p)) return undefined;
    if (p[k] === null || p[k] === '') return null;
    const n = toNum(p[k]);
    if (n == null || n < min || n > max) throw new InfoError(`${k} must be a number between ${min} and ${max}, or null for unknown`);
    return Math.round(n * 100) / 100;
  };
  const amount = num('price_amount', 0, 10000);
  if (amount !== undefined) out.price.amount = amount;
  if ('currency' in p) {
    if (!/^[A-Z]{3}$/.test(String(p.currency))) throw new InfoError('currency must be a 3-letter ISO code (EUR, CHF...)');
    out.price.currency = String(p.currency);
  }
  if ('per' in p) {
    if (!PER.includes(p.per)) throw new InfoError(`per must be one of ${PER.join(', ')}`);
    out.price.per = p.per;
  }
  const fee = num('dog_fee', 0, 1000);
  if (fee !== undefined) out.dog_fee = fee;
  const h = num('max_height_m', 1, 6);
  if (h !== undefined) out.max_height_m = h;
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
  return out;
}

/** Price of one night for the whole party, or null when unknown. */
function nightTotal(info, settings) {
  if (!info || info.price.amount == null) return null;
  const people = info.price.per === 'person' ? (settings.travellers || 2) : 1;
  const dog = settings.dog && info.amenities.dog === 'fee' && info.dog_fee != null ? info.dog_fee : 0;
  return Math.round((info.price.amount * people + dog) * 100) / 100;
}

const LABELS = {
  en: { per: { night: '/night', person: '/person' }, dog: 'dog', water: 'water', electricity: 'power', shower: 'shower', toilets: 'WC', dump_station: 'dump', wifi: 'wifi', rooftop_tent: 'roof tent', price: 'Price', amenities: 'Amenities', edit: 'Price & amenities', fee: 'fee' },
  fr: { per: { night: '/nuit', person: '/pers.' }, dog: 'chien', water: 'eau', electricity: 'élec.', shower: 'douche', toilets: 'WC', dump_station: 'vidange', wifi: 'wifi', rooftop_tent: 'tente de toit', price: 'Prix', amenities: 'Commodités', edit: 'Prix et commodités', fee: 'suppl.' },
};
const lbl = (lang) => LABELS[lang === 'fr' ? 'fr' : 'en'];

function money(amount, currency) {
  if (amount == null) return null;
  const v = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return currency === 'EUR' ? `${v} €` : `${v} ${currency}`;
}

/** "25 €/night" (+ " + dog 2.5 €"), or null when no price is known. */
function priceText(info, lang) {
  if (!info || info.price.amount == null) return null;
  const L = lbl(lang);
  let s = `${money(info.price.amount, info.price.currency)}${L.per[info.price.per]}`;
  if (info.amenities.dog === 'fee' && info.dog_fee != null) s += ` + ${L.dog} ${money(info.dog_fee, info.price.currency)}`;
  return s;
}

/**
 * Compact amenities line, emoji-free (the host strips emoji from planner columns):
 * "✓ dog · water · shower ✗ power ↕ 2.1 m". Unknown values are left out. null when empty.
 */
function amenitiesText(info, lang) {
  if (!info) return null;
  const L = lbl(lang);
  const yes = [];
  const no = [];
  for (const k of Object.keys(AMENITIES)) {
    const v = info.amenities[k];
    if (v === 'yes') yes.push(L[k]);
    else if (v === 'fee') yes.push(`${L[k]} (${L.fee})`);
    else if (v === 'no') no.push(L[k]);
  }
  const parts = [];
  if (yes.length) parts.push(`✓ ${yes.join(' · ')}`);
  if (no.length) parts.push(`✗ ${no.join(' · ')}`);
  if (info.max_height_m != null) parts.push(`↕ ${info.max_height_m} m`);
  return parts.length ? parts.join('  ') : null;
}

async function migrate(ctx) {
  await ctx.db.migrate('002_place_info_index', MIGRATION);
}

async function get(ctx, placeId) {
  const v = await ctx.meta.get('place', Number(placeId), META_KEY);
  return v && typeof v === 'object' && v.price && v.amenities ? v : null;
}

/** Validate, write on the place, index it. Returns the stored record. */
async function set(ctx, tripId, placeId, patch) {
  const current = await get(ctx, placeId);
  const next = merge(current, patch);
  await ctx.meta.set('place', Number(placeId), META_KEY, next);
  try {
    await ctx.db.exec('INSERT OR IGNORE INTO place_info_index (trip_id, place_id) VALUES (?, ?)', Number(tripId), Number(placeId));
  } catch { /* index is an optimisation; the value is safe on the place */ }
  return next;
}

async function clear(ctx, tripId, placeId) {
  await ctx.meta.delete('place', Number(placeId), META_KEY);
  try { await ctx.db.exec('DELETE FROM place_info_index WHERE trip_id = ? AND place_id = ?', Number(tripId), Number(placeId)); } catch { /* ignore */ }
}

/**
 * Map(placeId → record) for a trip. `placeIds` limits the read to places that still
 * exist on the trip; index rows pointing to deleted places or cleared values are pruned.
 */
async function getAll(ctx, tripId, placeIds) {
  let rows = [];
  try { rows = await ctx.db.query('SELECT place_id FROM place_info_index WHERE trip_id = ?', Number(tripId)); } catch { rows = []; }
  const alive = new Set(placeIds || []);
  const ids = rows.map((r) => r.place_id).filter((id) => !placeIds || alive.has(id)).slice(0, 300);
  const out = new Map();
  const stale = rows.map((r) => r.place_id).filter((id) => placeIds && !alive.has(id));
  // At most 8 meta reads in flight: the host allows 16 in-flight RPCs per plugin.
  await pmap(ids, 8, async (id) => {
    try {
      const v = await get(ctx, id);
      if (v) out.set(id, v); else stale.push(id);
    } catch { /* a place the user cannot read contributes nothing */ }
  });
  if (stale.length) {
    try {
      await ctx.db.tx(stale.slice(0, 100).map((id) => ({ sql: 'DELETE FROM place_info_index WHERE trip_id = ? AND place_id = ?', args: [Number(tripId), id] })));
    } catch { /* ignore */ }
  }
  return out;
}

module.exports = { merge, nightTotal, priceText, amenitiesText, get, set, clear, getAll, migrate, blank, AMENITIES, PER, META_KEY, MIGRATION, InfoError, LABELS };
