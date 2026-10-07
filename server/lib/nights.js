'use strict';
// Night candidates from OpenStreetMap (campsites and farms; motorhome areas too for a van or
// a motorhome) and park4night when the instance enables it, between the last visit of the
// evening and the first stop of the next morning. Ranked the way the trip owner ranks them:
// anything forbidden last, then legal risk, then a detour over 60 min, then price (unknown
// price after known ones), then the real detour in drive minutes. OSM has no reviews and rarely
// a price: what it cannot answer is returned as `toVerify` for the assistant to research
// (official site first) or to ask the host — never invented.
const { distKm, norm, toNum } = require('./util');
const overpass = require('./overpass');
const routing = require('./routing');
const rules = require('./rules');
const { statusAt } = require('./opening-hours');
const park4night = require('./park4night');
const { t } = require('./i18n');
const { fromOsmTags } = require('./contacts');
const { highwayAllowed, fuelPerKm } = require('./settings');
const { dayPlan } = require('./check');
const { findDay } = require('./trip');
const placeInfo = require('./place-info');

const located = (p) => p && p.lat != null && p.lng != null;
const ROUTE_TOP = 12; // candidates whose detour is measured on the road

/** Evening and morning anchor points of a trip night (day = the evening's day). */
function anchors(model, day) {
  const { veille, nuit, stops } = dayPlan(model, day);
  const visits = stops.filter((s) => !(nuit && s.accommodationId === nuit.id) && located(s.place));
  const evening = visits.length ? visits[visits.length - 1].place : veille;
  const next = model.days[day.index + 1];
  let morning = null;
  if (next) {
    const np = dayPlan(model, next);
    const first = np.stops.find((s) => !(np.veille && s.accommodationId === np.veille.id) && located(s.place));
    morning = first ? first.place : null;
  }
  return {
    evening: located(evening) ? { name: evening.name, lat: evening.lat, lng: evening.lng } : null,
    morning: located(morning) ? { name: morning.name, lat: morning.lat, lng: morning.lng } : null,
    // `price`: the party's total for one night; `comparablePrice`: the same night in the unit
    // candidates are quoted in (per night, for the vehicle, in the trip's currency), null when
    // they do not compare.
    current: nuit ? { name: nuit.name, price: nuit.price, comparablePrice: nuit.currency === model.currency ? placeInfo.comparableNightPrice(nuit) : null, currency: nuit.currency, lat: nuit.lat, lng: nuit.lng, placeId: nuit.placeId } : null,
  };
}

/**
 * The currency an OSM charge states ("15 EUR", "€ 12", "CHF 20", "20 Fr."), else `local`:
 * a bare amount is in the money of the place, which the caller gives.
 */
function priceCurrency(tags, local) {
  const txt = String(tags.charge || tags['charge:tent'] || tags['charge:caravan'] || '');
  if (/€|\beur\b/i.test(txt)) return 'EUR';
  if (/\bchf\b|\bfr\.?(?=\s|$)/i.test(txt)) return 'CHF';
  const code = txt.match(/\b([A-Z]{3})\b/);
  return code ? code[1] : local;
}

/** "15 EUR", "€ 12-18", "12,50" → the lowest number, or null. */
function parsePrice(tags) {
  if (tags.fee === 'no') return 0;
  const txt = tags.charge || tags['charge:tent'] || tags['charge:caravan'] || '';
  const n = String(txt).match(/(\d+(?:[.,]\d+)?)/);
  return n ? toNum(n[1]) : null;
}

function kindOf(tags) {
  const name = norm(tags.name);
  if (tags.tourism === 'caravan_site') return 'aire';
  if (tags.agriturismo === 'yes' || /agritur|agricamp|bauernhof|\bferme\b|\bfarm\b/.test(name)) return 'farm';
  if (tags.tourism === 'camp_site') return 'campsite';
  return 'unknown';
}

/** Campsites and farms for every vehicle; motorhome areas too for a van or a motorhome. */
function overpassBody(center, radiusM, vehicle = 'rooftop_tent') {
  const a = `(around:${Math.round(radiusM)},${center[0].toFixed(5)},${center[1].toFixed(5)})`;
  const aires = vehicle === 'rooftop_tent' ? '' : `nwr["tourism"="caravan_site"]${a};`;
  return `(nwr["tourism"="camp_site"]${a};${aires}nwr["agriturismo"="yes"]${a};nwr["tourism"~"guest_house|farm"]["name"~"agritur|agricamp|bauernhof|ferme|farm",i]${a};);out center tags 120;`;
}

/** The legal note of a night, in the user's language (zone rule, or the finding's short form). */
function riskText(legal, L) {
  return legal.params.rule ? t(L, `zone.${legal.params.zoneId || 'unknown'}.${legal.params.rule}`) : t(L, `s.${legal.key}`);
}

const KIND_CATEGORY = { farm: 'farm', campsite: 'campsite', aire: 'motorhome area', private: 'private', parking: 'parking' };

/**
 * @param o.evening {lat,lng,name?}  last visit of the evening (required)
 * @param o.morning {lat,lng,name?}  first stop next morning (defaults to evening)
 * @param o.date    ISO date of the night (opening hours)
 * @param o.currency the money of the area (the trip's): a bare OSM charge is read in it
 */
async function findNights(ctx, o, { settings, deadline, network = true, highway = false } = {}) {
  const ev = [+o.evening.lat, +o.evening.lng];
  const mo = o.morning ? [+o.morning.lat, +o.morning.lng] : ev;
  const center = [(ev[0] + mo[0]) / 2, (ev[1] + mo[1]) / 2];
  const radiusKm = Math.min(50, Math.max(o.radiusKm ?? 15, distKm(ev, mo) / 2 + 5));
  const vehicle = settings.vehicle || 'rooftop_tent';
  const sources = (o.sources && o.sources.length ? o.sources : ['osm', ...(settings.park4night ? ['park4night'] : [])])
    .filter((x) => x === 'osm' || (x === 'park4night' && settings.park4night));
  let els = [];
  let osmError = null;
  if (sources.includes('osm')) {
    try {
      els = (await overpass.query(ctx, overpassBody(center, radiusKm * 1000, vehicle), { network, timeoutMs: deadline ? Math.min(9000, deadline.left() - 4000) : 9000 })) || [];
    } catch (e) {
      if (!(e instanceof overpass.OverpassBusy)) throw e;
      osmError = e.message; // a busy public server is an answer, not a crash
    }
  }
  let p4n = [];
  let park4nightError = null;
  if (sources.includes('park4night') && network !== false) {
    try {
      // No dog filter: a spot that does not list dogs is unknown, not refused (as for OSM,
      // where only dog=no blocks); "dog accepted" is then listed to verify.
      const r = await park4night.search({ lat: center[0], lng: center[1], radius_km: radiusKm, vehicle, dog: false, limit: 30, lang: 'en' });
      p4n = r.places;
    } catch (e) {
      park4nightError = String(e.message || e); // unofficial API: may change or refuse
    }
  }

  const seen = new Set();
  const cands = [];
  let excluded = 0;
  for (const e of els) {
    const tg = e.tags;
    const name = tg.name || tg['name:en'] || '';
    const key = norm(name) || e.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = kindOf(tg);
    const reasons = [];
    if (kind === 'aire' && vehicle === 'rooftop_tent') reasons.push('motorhome area: an opened rooftop tent is camping');
    const banned = rules.tentBanned(`${tg.description || ''} ${tg.note || ''}`, tg);
    if (banned) reasons.push(`tents not allowed (${banned})`);
    if (settings.dog && tg.dog === 'no') reasons.push('dogs not allowed');
    const open = o.date && tg.opening_hours ? statusAt(tg.opening_hours, o.date, 18 * 60) : 'unknown';
    if (open === 'closed') reasons.push(`closed on ${o.date} (${tg.opening_hours})`);
    if (reasons.length && kind === 'aire') { excluded++; continue; }
    const legal = rules.nightLegality({ categoryName: KIND_CATEGORY[kind] || '', placeName: name, lat: e.lat, lng: e.lng, text: tg.description || '', vehicle });
    const price = parsePrice(tg);
    cands.push({
      name: name || '(unnamed)', kind, source: 'osm', lat: e.lat, lng: e.lng, osm: overpass.osmUrl(e.id),
      price, priceText: tg.charge || null, currency: price == null ? null : priceCurrency(tg, o.currency || null),
      website: tg.website || tg['contact:website'] || null,
      // What OSM states to reach the host (email, phone, website and their contact:* forms).
      contacts: fromOsmTags(tg),
      dog: tg.dog || null, tents: tg.tents || null,
      water: tg.drinking_water || null, toilets: tg.toilets || null, shower: tg.shower || null, power: tg.power_supply || null,
      openOnDate: open, openingHours: tg.opening_hours || null,
      legalRisk: legal ? riskText(legal, settings.language) : null,
      blocked: reasons,
      straightKm: Math.round((distKm(ev, [e.lat, e.lng]) + distKm([e.lat, e.lng], mo)) * 10) / 10,
    });
  }
  for (const p of p4n) {
    const key = norm(p.name);
    if (seen.has(key)) continue; // OSM already has it: keep one row
    seen.add(key);
    const legal = rules.nightLegality({ categoryName: KIND_CATEGORY[p.kind] || '', placeName: p.name, lat: p.lat, lng: p.lng, vehicle });
    // The same exclusions as the OSM results: a motorhome area is no night for a rooftop tent.
    if (p.kind === 'aire' && vehicle === 'rooftop_tent') { excluded++; continue; }
    cands.push({
      name: p.name, kind: p.kind, source: 'park4night', lat: p.lat, lng: p.lng, page: p.page,
      // park4night quotes euros only (park4night.js priceHint).
      price: p.priceHint, priceText: null, currency: p.priceHint == null ? null : 'EUR', rating: p.rating, reviews: p.reviews,
      contacts: p.contact || { email: null, phone: null, website: null },
      dog: p.services.includes('dogs') ? 'yes' : null, tents: null,
      water: p.services.includes('water') ? 'yes' : null, toilets: p.services.includes('toilets') ? 'yes' : null,
      shower: p.services.includes('shower') ? 'yes' : null, power: p.services.includes('electricity') ? 'yes' : null,
      openOnDate: 'unknown', openingHours: null,
      legalRisk: legal ? riskText(legal, settings.language) : null,
      blocked: [],
      straightKm: Math.round((distKm(ev, [p.lat, p.lng]) + distKm([p.lat, p.lng], mo)) * 10) / 10,
    });
  }
  cands.sort((a, b) => a.straightKm - b.straightKm);
  const top = cands.slice(0, ROUTE_TOP);

  // Real detour, in drive minutes: evening → night → morning, minus evening → morning.
  const pairs = [[ev, mo], ...top.map((c) => [ev, [c.lat, c.lng]]), ...top.map((c) => [[c.lat, c.lng], mo])];
  const r = await routing.legs(ctx, pairs, { ...routing.vehicleOpts(settings, highway), deadline, network });
  const v = (i) => r.values.get(i)?.minutes ?? null;
  const km = (i) => r.values.get(i)?.km ?? null;
  const direct = v(0);
  top.forEach((c, i) => {
    c.eveningMinutes = v(1 + i);
    c.morningMinutes = v(1 + top.length + i);
    c.detourMinutes = direct != null && c.eveningMinutes != null && c.morningMinutes != null ? c.eveningMinutes + c.morningMinutes - direct : null;
    const dk = km(0) != null && km(1 + i) != null && km(1 + top.length + i) != null ? km(1 + i) + km(1 + top.length + i) - km(0) : null;
    c.detourKm = dk == null ? null : Math.round(dk * 10) / 10;
  });

  const priceKey = (c) => (c.price == null ? settings.night_price_max + 1 : c.price);
  top.sort((a, b) => (a.blocked.length > 0) - (b.blocked.length > 0)
    || (!!a.legalRisk) - (!!b.legalRisk)
    || ((a.detourMinutes ?? 999) > 60) - ((b.detourMinutes ?? 999) > 60)
    || priceKey(a) - priceKey(b)
    || (a.detourMinutes ?? 999) - (b.detourMinutes ?? 999));

  for (const c of top) {
    const tv = [];
    if (c.price == null) tv.push('price');
    if (settings.vehicle === 'rooftop_tent' && c.tents !== 'yes') tv.push('rooftop tent accepted');
    if (settings.vehicle !== 'rooftop_tent' && (c.kind === 'parking' || c.kind === 'unknown')) tv.push('overnight parking allowed there (local rule, signs)');
    if (settings.dog && !['yes', 'leashed'].includes(c.dog)) tv.push('dog accepted');
    if (c.openOnDate !== 'open') tv.push(`open on ${o.date || 'the date'}`);
    if (c.rating == null) tv.push('recent reviews (rating >= 4/5)');
    c.toVerify = tv;
    // Night + fuel of the detour: what the option really costs compared to the others.
    if (c.price != null && c.detourKm != null) c.totalCost = Math.round((c.price + Math.max(0, c.detourKm) * fuelPerKm(settings)) * 100) / 100;
  }
  return {
    evening: o.evening, morning: o.morning || o.evening, date: o.date || null,
    directMinutes: direct, searchRadiusKm: Math.round(radiusKm),
    found: cands.length, excludedMotorhomeAreas: excluded, pendingRoutes: r.pending,
    osmError,
    park4nightError,
    sources,
    candidates: top,
    source: `${sources.includes('osm') ? 'OpenStreetMap contributors (ODbL) via Overpass' : ''}${sources.includes('park4night') ? '; park4night (unofficial API, may change without notice; nothing stored, open each page)' : ''}; drive times via Valhalla`.replace(/^; /, ''),
    note: `Price target ${settings.night_price_target}, ceiling ${settings.night_price_max}. OSM has no reviews and rarely prices: verify each "toVerify" item from the official site first, or ask the host (vanlife_host_message drafts it; the user validates it before it is sent). Never book without an explicit order from the user.`,
  };
}

/**
 * The cheaper night worth proposing, the one rule the check and the planner share: legal,
 * not blocked, not closed that night, within 20 min of detour, cheaper than the current
 * night in the same unit, and still cheaper once the detour's fuel is paid. The best net
 * saving first; null when none.
 */
function cheaperNight(res, settings) {
  const cur = res.currentNight && res.currentNight.comparablePrice;
  if (cur == null) return null;
  const sameCurrency = (c) => c.currency === res.currentNight.currency;
  const perKm = fuelPerKm(settings);
  const best = res.candidates
    // "legal, open and cheaper", as the message says: an opening not known is not an open place.
    .filter((c) => !c.blocked.length && !c.legalRisk && c.openOnDate === 'open' && sameCurrency(c) && c.price != null && c.price < cur && c.detourMinutes != null && c.detourMinutes <= 20)
    .map((c) => ({ candidate: c, net: Math.round((cur - c.price - Math.max(0, c.detourKm || 0) * perKm) * 100) / 100 }))
    .filter((x) => x.net > 0)
    .sort((a, b) => b.net - a.net)[0];
  return best || null;
}

/** Night search for a planned trip night: anchors read from the trip. */
async function findNightsForDay(ctx, model, ref, opts) {
  const day = findDay(model, ref);
  if (!day) throw new Error('day not found in this trip');
  const a = anchors(model, day);
  if (!a.evening) throw new Error(`day ${day.n} has no located stop or night to search from`);
  const res = await findNights(ctx, { evening: a.evening, morning: a.morning, date: day.date, currency: model.currency, radiusKm: opts.radiusKm, sources: ref.sources }, {
    ...opts, highway: highwayAllowed(opts.settings, day.index, model.days.length),
  });
  res.day = { id: day.id, number: day.n, date: day.date };
  res.currentNight = a.current;
  if (a.current && a.current.comparablePrice != null) {
    for (const c of res.candidates) if (c.price != null) c.savingVsCurrent = Math.round((a.current.comparablePrice - c.price) * 100) / 100;
  }
  res.cheaper = cheaperNight(res, opts.settings);
  res.sunsetNote = day.date && a.current ? `arrive by sunset - ${opts.settings.sunset_margin_min} min` : null;
  return res;
}

module.exports = { priceCurrency, findNights, findNightsForDay, cheaperNight, anchors, parsePrice, kindOf, overpassBody };
