'use strict';
// Data for the trip tab and the warnings banner. Both must answer fast (the warning hook
// has 5 s), so they read drive times from the cache only — the tools fill it.
const { checkTrip } = require('./check');
const { sunset } = require('./sun');
const { hhmm, distKm, deadline: makeDeadline } = require('./util');
const { nightKind } = require('./classify');
const { zoneAt } = require('./zones');
const { unplannedNights } = require('./trip');
const { t } = require('./i18n');
const placeInfo = require('./place-info');

const WARNING_LEVEL = { blocking: 'error', fix: 'warning', verify: 'warning' };

/** The planner banner: blocking/fix/verify findings, ≤ 20, each ≤ 300 chars, day in the text. */
async function warnings(ctx, model, settings) {
  const r = await checkTrip(ctx, model, { settings, network: false, deadline: makeDeadline(3500) });
  return r.findings
    .filter((f) => WARNING_LEVEL[f.level])
    .slice(0, 20)
    .map((f) => {
      const w = { level: WARNING_LEVEL[f.level], message: `${t(settings.language, `level.${f.level}`)} · ${f.message}`.slice(0, 300) };
      if (f.dayId != null) w.dayId = f.dayId;
      if (f.placeId != null) w.placeId = f.placeId;
      return w;
    });
}

/** One row per planned night (plan A), its alternatives folded underneath, and the check. */
async function tripReport(ctx, model, settings) {
  const check = await checkTrip(ctx, model, { settings, network: false, deadline: makeDeadline(4000) });
  const alts = unplannedNights(model).map((x) => x.place).filter((p) => p.lat != null);
  const resas = model.reservations || [];
  const rows = model.days.filter((d) => model.nights.some((n) => n.startDayId === d.id)).map((d, i) => {
    const n = model.nights.find((x) => x.startDayId === d.id);
    const a = d.assignments.find((x) => x.accommodationId === n.id);
    const arr = a?.place.time ?? null;
    const cs = n.lat != null && d.date ? sunset(n.lat, n.lng, d.date, settings.timezone) : null;
    const latest = cs == null ? null : cs - settings.sunset_margin_min;
    const resa = resas.find((x) => x.accommodation_id != null && String(x.accommodation_id) === n.id);
    const zone = zoneAt(n.lat, n.lng);
    return {
      index: i + 1,
      dayNumber: d.n,
      date: d.date,
      name: n.name,
      kind: nightKind(n.categoryName, n.name),
      zone: zone ? zone.name : null,
      price: n.price,
      priceText: placeInfo.priceText(n.info, settings.language),
      amenities: placeInfo.amenitiesText(n.info, settings.language),
      nights: n.nights,
      status: resa ? (resa.status === 'confirmed' && resa.confirmation_number ? 'booked' : resa.status === 'confirmed' ? 'confirmed-unverified' : 'not-booked') : 'not-booked',
      arrival: hhmm(arr),
      sunset: hhmm(cs),
      latest: hhmm(latest),
      onTime: arr != null && latest != null ? arr <= latest : null,
      lat: n.lat,
      lng: n.lng,
      alternatives: n.lat == null ? [] : alts
        .map((p) => ({ name: p.name, price: p.price, km: Math.round(distKm([n.lat, n.lng], [p.lat, p.lng])), kind: nightKind(p.categoryName, p.name), lat: p.lat, lng: p.lng }))
        .filter((p) => p.km <= 40)
        .sort((x, y) => (x.price ?? 1e9) - (y.price ?? 1e9) || x.km - y.km)
        .slice(0, 6),
    };
  });
  const known = rows.filter((r) => r.price != null);
  return {
    trip: { id: model.tripId, title: model.trip.title || '', currency: model.currency },
    language: settings.language,
    settings: { target: settings.night_price_target, max: settings.night_price_max, margin: settings.sunset_margin_min },
    kpis: {
      nights: rows.reduce((s, r) => s + r.nights, 0),
      nightsTotal: Math.round(known.reduce((s, r) => s + r.price * r.nights, 0) * 100) / 100,
      unknownPrices: rows.length - known.length,
      booked: rows.filter((r) => r.status === 'booked').length,
      late: rows.filter((r) => r.onTime === false).length,
    },
    nights: rows,
    check: { ok: check.ok, counts: check.counts, findings: check.findings.slice(0, 80), pendingRoutes: check.pendingRoutes },
  };
}

module.exports = { warnings, tripReport, WARNING_LEVEL };
