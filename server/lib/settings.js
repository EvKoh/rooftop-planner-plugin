'use strict';
// Per-user settings (manifest `scope: "user"`). The host already resolves a missing value to
// the manifest default, but a userless context (onLoad) gets undefined, and a number field
// may arrive as a string — so every value is re-read and coerced here, one place only.
const { toNum } = require('./util');

const DEFAULTS = Object.freeze({
  vehicle_height_m: 1.95,
  night_price_target: 25,
  night_price_max: 35,
  sunset_margin_min: 60,
  dog: true,
  water_reserve_l: 20,
  fuel_l_per_100km: 6.1,
  fuel_price_per_l: 1.9,
  highway_days: 'first_last',
  shop_detour_max_min: 20,
  travellers: 2,
  timezone: 'Europe/Paris',
  language: 'en',
});

const NUMBERS = ['vehicle_height_m', 'night_price_target', 'night_price_max', 'sunset_margin_min', 'water_reserve_l',
  'fuel_l_per_100km', 'fuel_price_per_l', 'shop_detour_max_min', 'travellers'];

/** All settings, or only `keys` (each one is an RPC to the host). Missing keys keep their default. */
async function readSettings(ctx, keys) {
  const out = { ...DEFAULTS };
  await Promise.all((keys || Object.keys(DEFAULTS)).map(async (k) => {
    let v;
    try { v = await ctx.settings.get(k); } catch { v = undefined; }
    if (v === undefined || v === null || v === '') return;
    if (NUMBERS.includes(k)) { const n = toNum(v); if (n != null && n >= 0) out[k] = n; return; }
    if (k === 'dog') { out[k] = v === true || v === 'true' || v === 1 || v === '1'; return; }
    out[k] = String(v);
  }));
  if (!['first_last', 'always', 'never'].includes(out.highway_days)) out.highway_days = DEFAULTS.highway_days;
  if (!['en', 'fr'].includes(out.language)) out.language = DEFAULTS.language;
  return out;
}

/** Does `dayIndex` (0-based) of `dayCount` days allow motorways under this setting? */
function highwayAllowed(settings, dayIndex, dayCount) {
  if (settings.highway_days === 'always') return true;
  if (settings.highway_days === 'never') return false;
  return dayIndex === 0 || dayIndex === dayCount - 1;
}

/** Fuel cost of one km, in the trip currency. */
const fuelPerKm = (s) => (s.fuel_l_per_100km / 100) * s.fuel_price_per_l;

module.exports = { DEFAULTS, readSettings, highwayAllowed, fuelPerKm };
