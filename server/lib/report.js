'use strict';
// The warnings banner. It must answer fast (the warning hook has 5 s), so it reads drive
// times from the cache only — the tools fill it.
const { checkTrip } = require('./check');
const { deadline: makeDeadline } = require('./util');
const { t, has, money } = require('./i18n');

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
 *  - at most BANNER_MAX individual lines, the rest summed up in ONE chip (the full list is
 *    what vanlife_check_trip returns); prices above the ceiling are never one chip each.
 */
// Points worth a list, not a chip: every night of a new trip lacks a contact at first, and
// a chip per night would push the real problems out of the banner. vanlife_check_trip and
// vanlife_night list them.
// Same for the visits with no known duration and the possible savings (never a problem).
const NOT_IN_BANNER = new Set(['night_no_contact', 'visit_unknown', 'saving_night', 'backtrack']);

function bannerFrom(all, settings) {
  const findings = all.filter((f) => !NOT_IN_BANNER.has(f.key));
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
    const message = onlyPrices ? t(L, 'group.prices', { n: hidden.length, max: money(settings.night_price_max, settings.currency || 'EUR', L) })
      : t(L, anySevere ? 'group.mixed' : 'group.verify', { n: hidden.length });
    out.push({ level: anySevere ? 'warning' : 'info', message });
  }
  return out;
}

async function warnings(ctx, model, settings) {
  const r = await checkTrip(ctx, model, { settings, network: false, deadline: makeDeadline(3500) });
  return bannerFrom(r.findings, { ...settings, currency: model.currency });
}

module.exports = { NOT_IN_BANNER, warnings, WARNING_LEVEL, bannerText, bannerFrom, shortName, BANNER_MAX };
