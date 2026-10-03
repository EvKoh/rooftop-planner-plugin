'use strict';
// Data for the trip tab and the warnings banner. Both must answer fast (the warning hook
// has 5 s), so they read drive times from the cache only — the tools fill it.
const { checkTrip } = require('./check');
const { sunset } = require('./sun');
const { hhmm, distKm, deadline: makeDeadline } = require('./util');
const { nightKind } = require('./classify');
const { zoneAt } = require('./zones');
const { unplannedNights } = require('./trip');
const { t, has } = require('./i18n');
const placeInfo = require('./place-info');

const WARNING_LEVEL = { blocking: 'error', fix: 'warning', verify: 'warning' };
const BANNER_MAX = 3; // individual chips; everything else goes into one summary chip

/**
 * "🏠25 € · 4,8/5 · Camping Example — lake (Town)" → "Camping Example": the words a person
 * recognises, without the price/rating prefix, emoji or the description after a dash.
 */
function shortName(name, max = 18) {
  const n = String(name || '').split('·').pop().split(/ [—–-] | \(/)[0]
    .replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim();
  return n.length > max ? `${n.slice(0, max - 1).trimEnd()}…` : n;
}

/** One banner line: "J2 Farm Example : ferme au Tyrol du Sud" — the essential first, no level word. */
function bannerText(f, settings) {
  const L = settings.language;
  const key = `s.${f.key}`;
  const p = f.params || {};
  const what = has(L, key) ? t(L, key, { ...p, zone: p.zone ? String(p.zone).replace(/ \(.*\)$/, '') : p.zone }) : t(L, f.key, p);
  const who = p.name || p.title ? shortName(p.name || p.title) : '';
  const where = f.dayNumber != null ? t(L, 'dayShort', { n: f.dayNumber }) : f.scope;
  return `${[where, who].filter(Boolean).join(' ')} : ${what}`.slice(0, 120);
}

/**
 * The planner banner. The host shows each warning as a chip that shares the navbar on a
 * desktop (truncated to a few words) and as a full-width block over the map on a phone, with
 * no detail view — so it gets few, short, distinct lines:
 *  - blocking first, then to-fix, by day; to-verify only while it fits in 3 chips (prices
 *    above the ceiling last, and only if they all fit);
 *  - at most BANNER_MAX individual lines, the rest summed up in ONE chip that points to the
 *    plugin tab (its click opens it); prices above the ceiling are never one chip each.
 */
function bannerFrom(findings, settings) {
  const sev = findings.filter((f) => f.level === 'blocking' || f.level === 'fix');
  const verify = findings.filter((f) => f.level === 'verify');
  const prices = verify.filter((f) => f.key === 'price_high');
  const other = verify.filter((f) => f.key !== 'price_high');
  // Worst first; a to-verify point only while room is left; prices last, and only if all fit.
  let shown = sev.slice(0, BANNER_MAX);
  if (shown.length + other.length <= BANNER_MAX) shown = shown.concat(other);
  if (shown.length + prices.length <= BANNER_MAX) shown = shown.concat(prices);
  const hidden = sev.concat(other, prices).filter((f) => !shown.includes(f));
  const out = shown.map((f) => {
    const w = { level: WARNING_LEVEL[f.level], message: bannerText(f, settings) };
    if (f.dayId != null) w.dayId = f.dayId;
    if (f.placeId != null) w.placeId = f.placeId;
    return w;
  });
  if (hidden.length) {
    const L = settings.language;
    const onlyPrices = hidden.every((f) => f.key === 'price_high');
    const anySevere = hidden.some((f) => f.level !== 'verify');
    const message = onlyPrices ? t(L, 'group.prices', { n: hidden.length, max: settings.night_price_max })
      : t(L, anySevere ? 'group.mixed' : 'group.verify', { n: hidden.length, tab: 'Rooftop' });
    out.push({ level: anySevere ? 'warning' : 'info', message });
  }
  return out;
}

async function warnings(ctx, model, settings) {
  const r = await checkTrip(ctx, model, { settings, network: false, deadline: makeDeadline(3500) });
  return bannerFrom(r.findings, settings);
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
      zone: zone ? (settings.language === 'fr' && zone.nameFr ? zone.nameFr : zone.name) : null,
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

module.exports = { warnings, tripReport, WARNING_LEVEL, bannerText, bannerFrom, shortName, BANNER_MAX };
