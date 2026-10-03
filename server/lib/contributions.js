'use strict';
// Planner columns (`tableContributor`, view "places"): the price and a compact amenities
// line on every place that has them, plus a button that opens the editor. The host caps
// each value at 256 characters and strips emoji, so the amenities line uses plain words
// and the symbols ✓ ✗ ↕, which survive.
const placeInfo = require('./place-info');
const { LABELS } = placeInfo;

async function placeColumns(ctx, tripId, settings) {
  const L = LABELS[settings.language === 'fr' ? 'fr' : 'en'];
  const places = await ctx.trips.getPlaces(Number(tripId));
  // Route places carry a road geometry, not a price.
  const ids = places.filter((p) => !p.route_geometry).map((p) => p.id);
  const info = await placeInfo.getAll(ctx, tripId, ids);
  const out = [];
  for (const id of ids) {
    const rec = info.get(id);
    if (rec) {
      const price = placeInfo.priceText(rec, settings.language);
      if (price) out.push({ kind: 'column', entityId: id, id: 'rooftop-price', label: L.price, value: price.slice(0, 256), icon: 'Euro' });
      const am = placeInfo.amenitiesText(rec, settings.language);
      if (am) {
        const refused = rec.amenities.rooftop_tent === 'no' || (settings.dog && rec.amenities.dog === 'no') || (rec.max_height_m != null && rec.max_height_m < settings.vehicle_height_m);
        out.push({ kind: 'column', entityId: id, id: 'rooftop-amenities', label: L.amenities, value: am.slice(0, 256), icon: 'Tent', tone: refused ? 'danger' : 'default' });
      }
    }
    // The editor lives in the trip tab; `sub` names the place for when the host passes it on.
    out.push({ kind: 'action', entityId: id, id: 'rooftop-edit', label: L.edit, icon: 'Pencil', target: { kind: 'frame', sub: `/?place=${id}` } });
  }
  return out;
}

module.exports = { placeColumns };
