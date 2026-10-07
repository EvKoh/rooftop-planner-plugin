'use strict';
// Groceries, fuel and drinking water ALONG a day's route (OpenStreetMap), so shopping never
// costs a detour: the day's road geometry is searched with one Overpass "around a
// polyline" query. Each result gives how far along the route it is, how far off it is,
// an approximate detour, and its hours on that date. The approximate detour (3 min per km
// off the route, there and back at ~40 km/h) is a sorting aid; check_trip measures the
// real one on the road once a stop is planned.
const { distKm, thin, toNum, hm } = require('./util');
const overpass = require('./overpass');
const routing = require('./routing');
const { statusAt, hoursOn } = require('./opening-hours');
const { highwayAllowed } = require('./settings');
const { dayPlan, carPos } = require('./check');
const { findDay } = require('./trip');

const located = (p) => p && p.lat != null && p.lng != null;
const KINDS = {
  groceries: '["shop"~"^(supermarket|convenience|greengrocer|bakery)$"]',
  fuel: '["amenity"="fuel"]',
  water: '["amenity"~"^(drinking_water|water_point)$"]',
};

async function dayGeometry(ctx, model, day, settings, opts) {
  const { veille, nuit, trace, stops } = dayPlan(model, day);
  if (trace && trace.place.geometry) return { points: trace.place.geometry, source: 'route place' };
  const pts = [];
  if (veille && located(veille)) pts.push([veille.lat, veille.lng]);
  for (const s of stops) if (located(s.place) && !(veille && s.accommodationId === veille.id)) pts.push(carPos(s));
  if (nuit && located(nuit) && !pts.some((p) => p[0] === nuit.lat && p[1] === nuit.lng)) pts.push([nuit.lat, nuit.lng]);
  if (pts.length < 2) return null;
  if (opts.network === false) return null;
  const r = await routing.route(pts, { ...routing.vehicleOpts(settings, highwayAllowed(settings, day.index, model.days.length)), timeoutMs: opts.deadline ? Math.min(10000, opts.deadline.left() - 4000) : 10000 });
  return { points: r.points, source: 'computed (Valhalla)' };
}

/**
 * @param points  [lat,lng] route geometry (or computed from the trip day when absent)
 * @param o.kinds subset of groceries | fuel | water
 * @param o.at    "HH:MM" expected pass time, to say whether each place is open then
 */
async function suppliesAlong(ctx, points, o, { settings, deadline, network = true } = {}) {
  const line = thin(points, 70);
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + distKm(points[i - 1], points[i]));
  const corridorM = Math.round((o.corridorKm ?? 2) * 1000);
  const around = `(around:${corridorM},${line.map((p) => `${(+p[0]).toFixed(4)},${(+p[1]).toFixed(4)}`).join(',')})`;
  const kinds = (o.kinds && o.kinds.length ? o.kinds : ['groceries', 'fuel']).filter((k) => KINDS[k]);
  const body = `(${kinds.map((k) => `nwr${KINDS[k]}${around};`).join('')});out center tags 200;`;
  let els = [];
  let osmError = null;
  try {
    els = (await overpass.query(ctx, body, { network, timeoutMs: deadline ? Math.min(9000, deadline.left() - 2000) : 9000 })) || [];
  } catch (e) {
    if (!(e instanceof overpass.OverpassBusy)) throw e;
    osmError = e.message;
  }
  const at = hm(o.at);
  const res = { groceries: [], fuel: [], water: [] };
  for (const e of els) {
    const tg = e.tags;
    const kind = tg.amenity === 'fuel' ? 'fuel' : /water/.test(tg.amenity || '') ? 'water' : 'groceries';
    let best = Infinity;
    let along = 0;
    points.forEach((p, i) => { const d = distKm([e.lat, e.lng], p); if (d < best) { best = d; along = cum[i]; } });
    const approxDetour = Math.round(best * 3);
    res[kind].push({
      name: tg.name || tg.brand || `(${tg.shop || tg.amenity})`, brand: tg.brand || null, type: tg.shop || tg.amenity,
      lat: e.lat, lng: e.lng, osm: overpass.osmUrl(e.id),
      alongKm: Math.round(along), offRouteKm: Math.round(best * 10) / 10, approxDetourMinutes: approxDetour,
      withinDetourLimit: approxDetour <= settings.shop_detour_max_min,
      hoursOnDate: o.date ? hoursOn(tg.opening_hours, o.date) : null,
      openAtPass: o.date && at != null ? statusAt(tg.opening_hours, o.date, at, at + 30) : 'unknown',
      dogs: tg.dog || null,
      fuelPrice: toNum(tg['fuel:price'] || tg['charge:diesel'] || tg['charge:octane_95']),
    });
  }
  for (const k of Object.keys(res)) {
    res[k].sort((a, b) => (a.withinDetourLimit === b.withinDetourLimit ? a.alongKm - b.alongKm : a.withinDetourLimit ? -1 : 1));
    res[k] = res[k].slice(0, 15);
  }
  return {
    routeKm: Math.round(cum[cum.length - 1]),
    osmError,
    detourLimitMinutes: settings.shop_detour_max_min,
    ...Object.fromEntries(kinds.map((k) => [k, res[k]])),
    source: 'OpenStreetMap contributors (ODbL) via Overpass',
    note: 'Opening hours come from OSM and may be stale: check the official page for the exact day (many shops close at noon or on Sunday), and whether dogs may enter (else one adult waits outside).',
  };
}

async function suppliesForDay(ctx, model, ref, o, opts) {
  const day = findDay(model, ref);
  if (!day) throw new Error('day not found in this trip');
  const g = await dayGeometry(ctx, model, day, opts.settings, opts);
  if (!g) throw new Error(`day ${day.n}: not enough located stops to build a route (or network disabled)`);
  const res = await suppliesAlong(ctx, g.points, { ...o, date: o.date || day.date }, opts);
  return { day: { id: day.id, number: day.n, date: day.date }, geometrySource: g.source, ...res };
}

module.exports = { suppliesAlong, suppliesForDay, dayGeometry, KINDS };
