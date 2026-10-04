'use strict';
// Settings, read through TREK's native forms only (no settings screen of our own):
//  - scope "user"  (Settings → Plugins): the vehicle and the traveller's own rules;
//    read with ctx.settings.get(), each key one RPC to the host.
//  - scope "instance" (Admin → Plugins → Instance settings): instance defaults, frozen in
//    ctx.config at activation.
// Values are coerced here, one place only: a number field may arrive as a string, and a
// userless context (onLoad) gets undefined.
const { toNum } = require('./util');
const { lang } = require('./i18n');

const VEHICLES = ['rooftop_tent', 'campervan', 'motorhome'];

const DEFAULTS = Object.freeze({
  vehicle: 'rooftop_tent',
  vehicle_height_m: 1.95,
  vehicle_length_m: 4.8,
  vehicle_weight_t: 2.0,
  night_price_target: 25,
  night_price_max: 35,
  sunset_margin_min: 60,
  dog: true,
  water_reserve_l: 20,
  fuel_l_per_100km: 6.1,
  fuel_price_per_l: 1.9,
  travellers: 2,
  highway_days: 'first_last',
  // Day numbers with motorway allowed, e.g. "1,8,9": when set, it wins over highway_days.
  highway_day_numbers: '',
  shop_detour_max_min: 20,
  // When the day starts (leaving last night's place) unless the first stop is earlier.
  day_start: '08:30',
  // A visit this long or longer is a big activity: one a day, or at most two small ones.
  big_activity_minutes: 150,
  drive_time_factor: 1,
  // The dotted walking route of each hike, from its car park (map layer).
  map_walks: true,
  // The server's own zone until the user sets the trip's: no continent is assumed.
  timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })(),
  language: 'auto',
});

const NUMBERS = ['vehicle_height_m', 'vehicle_length_m', 'vehicle_weight_t', 'night_price_target', 'night_price_max',
  'sunset_margin_min', 'water_reserve_l', 'fuel_l_per_100km', 'fuel_price_per_l', 'shop_detour_max_min', 'travellers', 'big_activity_minutes', 'drive_time_factor'];

/** The instance defaults an admin set (ctx.config is frozen at activation). */
function instance(ctx) {
  const c = (ctx && ctx.config) || {};
  return {
    park4night: c.park4night_enabled !== false && c.park4night_enabled !== 'false',
    defaultLanguage: c.default_language ? lang(c.default_language) : 'en',
  };
}

/** All settings, or only `keys` (each one is an RPC). Missing keys keep their default. */
async function readSettings(ctx, keys) {
  const out = { ...DEFAULTS };
  await Promise.all((keys || Object.keys(DEFAULTS)).map(async (k) => {
    let v;
    try { v = await ctx.settings.get(k); } catch { v = undefined; }
    if (v === undefined || v === null || v === '') return;
    if (NUMBERS.includes(k)) { const n = toNum(v); if (n != null && n >= 0) out[k] = n; return; }
    if (k === 'dog' || k === 'map_walks') { out[k] = v === true || v === 'true' || v === 1 || v === '1'; return; }
    out[k] = String(v);
  }));
  if (!VEHICLES.includes(out.vehicle)) out.vehicle = DEFAULTS.vehicle;
  if (!(out.drive_time_factor >= 0.5 && out.drive_time_factor <= 2)) out.drive_time_factor = DEFAULTS.drive_time_factor;
  if (!['first_last', 'always', 'never'].includes(out.highway_days)) out.highway_days = DEFAULTS.highway_days;
  if (!/^([01]?\d|2[0-3])[:h][0-5]\d$/.test(out.day_start)) out.day_start = DEFAULTS.day_start;
  // "auto": the host passes no language to hooks and tools, so the admin's instance default
  // decides there; the widget uses the language TREK hands its frame instead.
  out.language = out.language === 'auto' || !out.language ? instance(ctx).defaultLanguage : lang(out.language);
  out.park4night = instance(ctx).park4night;
  return out;
}

/** Does `dayIndex` (0-based) of `dayCount` days allow motorways under this setting? */
function highwayAllowed(settings, dayIndex, dayCount) {
  const listed = String(settings.highway_day_numbers || '').split(/[\s,;]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (listed.length) return listed.includes(dayIndex + 1);
  if (settings.highway_days === 'always') return true;
  if (settings.highway_days === 'never') return false;
  return dayIndex === 0 || dayIndex === dayCount - 1;
}

/** Fuel cost of one km, in the trip currency. */
const fuelPerKm = (s) => (s.fuel_l_per_100km / 100) * s.fuel_price_per_l;

module.exports = { DEFAULTS, VEHICLES, readSettings, highwayAllowed, fuelPerKm, instance };
