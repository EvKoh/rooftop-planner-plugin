'use strict';
// Planner columns (`tableContributor`, view "places"): the price and a compact amenities
// line on each place, for the places list and the map's hover card. The price is TREK's own
// field (with the per-person / dog-fee details the plugin keeps); amenities come from the
// place's plugin data. The host caps each value at 256 characters and strips emoji, so the
// line uses plain words and the symbols ✓ ✗ ↕ ↔, which survive. Editing happens in the
// place widget, so no button is added here.
const placeInfo = require('./place-info');
const { t } = require('./i18n');

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
    const am = placeInfo.amenitiesText(rec, L);
    if (am) {
      out.push({ kind: 'column', entityId: p.id, id: 'vanlife-amenities', label: t(L, 'col.amenities'), value: am.slice(0, 256), icon: 'Caravan', tone: placeInfo.refuses(rec, settings) ? 'danger' : 'default' });
    }
  }
  return out;
}

module.exports = { placeColumns };
