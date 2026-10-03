'use strict';
// Night candidates from OpenStreetMap: campsites and farms (agriturismo) between the last
// visit of the evening and the first stop of the next morning. Ranked the way the trip
// owner ranks them: anything forbidden last, then legal risk, then price (unknown price
// after known ones), then the real detour in drive minutes. OSM has no reviews and rarely
// a price: what it cannot answer is returned as `toVerify` for the assistant to research
// (official site first) or to ask the host — never invented.
const { distKm, norm, toNum } = require('./util');
const overpass = require('./overpass');
const routing = require('./routing');
const rules = require('./rules');
const { statusAt } = require('./opening-hours');
const { highwayAllowed, fuelPerKm } = require('./settings');
const { dayPlan } = require('./check');
const { findDay } = require('./schedule');

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
    current: nuit ? { name: nuit.name, price: nuit.price, lat: nuit.lat, lng: nuit.lng, placeId: nuit.placeId } : null,
  };
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

function overpassBody(center, radiusM) {
  const a = `(around:${Math.round(radiusM)},${center[0].toFixed(5)},${center[1].toFixed(5)})`;
  return `(nwr["tourism"="camp_site"]${a};nwr["tourism"="caravan_site"]${a};nwr["agriturismo"="yes"]${a};nwr["tourism"~"guest_house|farm"]["name"~"agritur|agricamp|bauernhof|ferme|farm",i]${a};);out center tags 120;`;
}

/**
 * @param o.evening {lat,lng,name?}  last visit of the evening (required)
 * @param o.morning {lat,lng,name?}  first stop next morning (defaults to evening)
 * @param o.date    ISO date of the night (opening hours)
 */
async function findNights(ctx, o, { settings, deadline, network = true, highway = false } = {}) {
  const ev = [+o.evening.lat, +o.evening.lng];
  const mo = o.morning ? [+o.morning.lat, +o.morning.lng] : ev;
  const center = [(ev[0] + mo[0]) / 2, (ev[1] + mo[1]) / 2];
  const radiusKm = Math.min(50, Math.max(o.radiusKm ?? 15, distKm(ev, mo) / 2 + 5));
  let els = [];
  let osmError = null;
  try {
    els = (await overpass.query(ctx, overpassBody(center, radiusKm * 1000), { network, timeoutMs: deadline ? Math.min(9000, deadline.left() - 4000) : 9000 })) || [];
  } catch (e) {
    if (!(e instanceof overpass.OverpassBusy)) throw e;
    osmError = e.message; // a busy public server is an answer, not a crash
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
    if (kind === 'aire') reasons.push('motorhome area: an opened rooftop tent is camping');
    const banned = rules.tentBanned(`${tg.description || ''} ${tg.note || ''}`, tg);
    if (banned) reasons.push(`tents not allowed (${banned})`);
    if (settings.dog && tg.dog === 'no') reasons.push('dogs not allowed');
    const open = o.date && tg.opening_hours ? statusAt(tg.opening_hours, o.date, 18 * 60) : 'unknown';
    if (open === 'closed') reasons.push(`closed on ${o.date} (${tg.opening_hours})`);
    if (reasons.length && kind === 'aire') { excluded++; continue; }
    const legal = rules.nightLegality({ categoryName: kind === 'farm' ? 'farm' : kind === 'campsite' ? 'campsite' : '', placeName: name, lat: e.lat, lng: e.lng, text: tg.description || '' });
    const price = parsePrice(tg);
    cands.push({
      name: name || '(unnamed)', kind, lat: e.lat, lng: e.lng, osm: overpass.osmUrl(e.id),
      price, priceText: tg.charge || null,
      website: tg.website || tg['contact:website'] || null,
      dog: tg.dog || null, tents: tg.tents || null,
      water: tg.drinking_water || null, toilets: tg.toilets || null, shower: tg.shower || null, power: tg.power_supply || null,
      openOnDate: open, openingHours: tg.opening_hours || null,
      legalRisk: legal ? legal.params.note || legal.key : null,
      blocked: reasons,
      straightKm: Math.round((distKm(ev, [e.lat, e.lng]) + distKm([e.lat, e.lng], mo)) * 10) / 10,
    });
  }
  cands.sort((a, b) => a.straightKm - b.straightKm);
  const top = cands.slice(0, ROUTE_TOP);

  // Real detour, in drive minutes: evening → night → morning, minus evening → morning.
  const pairs = [[ev, mo], ...top.map((c) => [ev, [c.lat, c.lng]]), ...top.map((c) => [[c.lat, c.lng], mo])];
  const r = await routing.legs(ctx, pairs, { tolls: highway, height: settings.vehicle_height_m, deadline, network });
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
    if (c.tents !== 'yes') tv.push('rooftop tent accepted');
    if (settings.dog && !['yes', 'leashed'].includes(c.dog)) tv.push('dog accepted');
    if (c.openOnDate !== 'open') tv.push(`open on ${o.date || 'the date'}`);
    tv.push('recent reviews (rating >= 4/5)');
    c.toVerify = tv;
    // Night + fuel of the detour: what the option really costs compared to the others.
    if (c.price != null && c.detourKm != null) c.totalCost = Math.round((c.price + Math.max(0, c.detourKm) * fuelPerKm(settings)) * 100) / 100;
  }
  return {
    evening: o.evening, morning: o.morning || o.evening, date: o.date || null,
    directMinutes: direct, searchRadiusKm: Math.round(radiusKm),
    found: cands.length, excludedMotorhomeAreas: excluded, pendingRoutes: r.pending,
    osmError,
    candidates: top,
    source: 'OpenStreetMap contributors (ODbL) via Overpass; drive times via Valhalla',
    note: `Price target ${settings.night_price_target}, ceiling ${settings.night_price_max}. OSM has no reviews and rarely prices: verify each "toVerify" item from the official site first, or ask the host (message validated by the user before sending). Never book without an explicit order from the user.`,
  };
}

/** Night search for a planned trip night: anchors read from the trip. */
async function findNightsForDay(ctx, model, ref, opts) {
  const day = findDay(model, ref);
  if (!day) throw new Error('day not found in this trip');
  const a = anchors(model, day);
  if (!a.evening) throw new Error(`day ${day.n} has no located stop or night to search from`);
  const res = await findNights(ctx, { evening: a.evening, morning: a.morning, date: day.date, radiusKm: opts.radiusKm }, {
    ...opts, highway: highwayAllowed(opts.settings, day.index, model.days.length),
  });
  res.day = { id: day.id, number: day.n, date: day.date };
  res.currentNight = a.current;
  if (a.current && a.current.price != null) {
    for (const c of res.candidates) if (c.price != null) c.savingVsCurrent = Math.round((a.current.price - c.price) * 100) / 100;
  }
  res.sunsetNote = day.date && a.current ? `arrive by sunset - ${opts.settings.sunset_margin_min} min` : null;
  return res;
}

module.exports = { findNights, findNightsForDay, anchors, parsePrice, kindOf, overpassBody };
