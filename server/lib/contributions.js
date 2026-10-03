'use strict';
// Planner columns (`tableContributor`, view "places"): on each place, the price, one column
// per amenity the place has, and one column listing what it lacks when that refuses the
// vehicle or the dog. TREK shows each column as a chip on the places list and the map's
// hover card. The price is TREK's own field (with the per-person / dog-fee details the
// plugin keeps); amenities come from the place's plugin data. The host caps each value at
// 256 characters and strips emoji, so icons are lucide names and the text uses plain words
// and the symbols ✗ ↕ ↔, which survive. Editing happens in the place widget, so no button
// is added here.
const placeInfo = require('./place-info');
const { t, num, locale } = require('./i18n');

// Lucide icon per amenity (names known to lucide-react 0.344, the SDK's snapshot).
const ICONS = {
  dog: 'Dog', water: 'Droplet', electricity: 'Zap', toilets: 'Bath', shower: 'ShowerHead',
  dump_station: 'Droplets', wifi: 'Wifi', bins: 'Trash2', laundry: 'WashingMachine', pool: 'Waves',
  shop: 'ShoppingCart', bakery: 'Croissant', restaurant: 'Sandwich', bar: 'Beer', mobile_data: 'Signal',
  playground: 'Baby', bbq: 'Flame', gas: 'Cylinder', lpg: 'Fuel', vehicle_wash: 'CarFront',
  winter: 'Snowflake', rooftop_tent: 'Tent',
};

const cap = (s, L) => s.charAt(0).toLocaleUpperCase(locale(L)) + s.slice(1);

/** One chip per amenity the place has, in AMENITIES order: { key, value }. */
function amenityChips(rec, L) {
  const out = [];
  for (const k of Object.keys(placeInfo.AMENITIES)) {
    const v = rec.amenities[k];
    const name = cap(t(L, `am.${k}`), L);
    if (v === 'yes') out.push({ key: k, label: name, value: name });
    else if (v === 'fee') out.push({ key: k, label: name, value: `${name} (${t(L, 'fee')})` });
  }
  return out;
}

/** "✗ dog · roof tent  ↕ 2.1 m": what the place lacks and its limits, or null. */
function missingText(rec, L) {
  const no = Object.keys(placeInfo.AMENITIES).filter((k) => rec.amenities[k] === 'no').map((k) => t(L, `am.${k}`));
  const parts = [];
  if (no.length) parts.push(`✗ ${no.join(' · ')}`);
  if (rec.max_height_m != null) parts.push(`↕ ${num(rec.max_height_m, L)} m`);
  if (rec.max_length_m != null) parts.push(`↔ ${num(rec.max_length_m, L)} m`);
  if (rec.max_weight_t != null) parts.push(`${num(rec.max_weight_t, L)} t max`);
  return parts.length ? parts.join('  ') : null;
}

async function placeColumns(ctx, tripId, settings) {
  const L = settings.language;
  const places = await ctx.trips.getPlaces(Number(tripId));
  // Route places carry a road geometry, not a price.
  const real = places.filter((p) => !p.route_geometry);
  const info = await placeInfo.getAll(ctx, tripId, real.map((p) => p.id));
  const out = [];
  for (const p of real) {
    const rec = info.get(p.id) || null;
    const price = placeInfo.priceText(p.price == null ? null : +p.price, p.currency || 'EUR', rec, L);
    // A free stop (lunch break, viewpoint) is not a night: no "0,00 €/night" on it.
    if (price && !(+p.price === 0 && !rec)) out.push({ kind: 'column', entityId: p.id, id: 'vanlife-price', label: t(L, 'col.price'), value: price.slice(0, 256), icon: 'Euro' });
    if (!rec) continue;
    for (const c of amenityChips(rec, L)) {
      out.push({ kind: 'column', entityId: p.id, id: `vanlife-am-${c.key}`, label: c.label, value: c.value.slice(0, 256), icon: ICONS[c.key], tone: 'default' });
    }
    // What is missing shows only when it rules the place out for this vehicle or party.
    const missing = placeInfo.refuses(rec, settings) && missingText(rec, L);
    if (missing) out.push({ kind: 'column', entityId: p.id, id: 'vanlife-am-no', label: t(L, 'col.amenities'), value: missing.slice(0, 256), icon: 'Ban', tone: 'danger' });
  }
  return out;
}

module.exports = { placeColumns, amenityChips, missingText, ICONS };
