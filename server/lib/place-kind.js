'use strict';
// Give a place a kind in plain words ("farm", "campsite", "hike"…): the plugin finds the trip's
// own category for it (design.categoryForKind) and sets it on TREK's place, so its pictogram
// and colour follow from the design catalogue without the user naming a category.

const { KINDS, categoryForKind } = require('./design');

class KindError extends Error {}

/** → { kind, category, categoryId, changed } */
async function applyKind(ctx, model, place, kind) {
  if (!KINDS.includes(kind)) throw new KindError(`kind must be one of: ${KINDS.join(', ')}`);
  const categories = await ctx.categories.list();
  const cat = categoryForKind(categories, kind);
  if (!cat) throw new KindError(`no category of this trip matches "${kind}"; categories: ${categories.map((c) => c.name).join(', ')}`);
  const changed = place.categoryId !== cat.id;
  if (changed) await ctx.places.update(Number(model.tripId), Number(place.id), { category_id: cat.id });
  return { kind, category: cat.name, categoryId: cat.id, changed };
}

module.exports = { applyKind, KindError, KINDS };
