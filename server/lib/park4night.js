'use strict';
// On-demand park4night search around a point. UNOFFICIAL: park4night publishes no API;
// this reads the endpoint its own web map uses (GET /api/places/around, answer = JSON
// encoded in base64, ~100-200 nearest places), checked 2026-10-03. It can change without
// notice. Nothing is stored or cached: each call asks park4night, returns a few fields and a
// link to the place page, and forgets. Calls are rate-limited in-process so a chatty
// assistant cannot hammer the service.

const BASE = 'https://park4night.com';
const UA = 'vanlife (TREK plugin; +https://github.com/EvkohLand/Vanlife)';
const MIN_GAP_MS = 3000; // between two requests
const MAX_PER_HOUR = 20;

// park4night type codes → our kinds. Which kinds are searched depends on the vehicle
// (see KINDS_FOR): an opened rooftop tent is camping, so only campsites, farms and private
// pitches; a van or a motorhome may also sleep on a motorhome area, and on a car park or a
// nature spot where the local rule allows it (flagged "verify" by the planner).
const KINDS = { campsite: ['C'], farm: ['F'], private: ['EP'], aire: ['ACC_G', 'ACC_P', 'ACC_PR', 'ASS'], parking: ['P', 'PN'] };
const KINDS_FOR = {
  rooftop_tent: ['campsite', 'farm', 'private'],
  campervan: ['campsite', 'farm', 'private', 'aire', 'parking'],
  motorhome: ['campsite', 'farm', 'private', 'aire', 'parking'],
};
const SERVICES = {
  animaux: 'dogs', point_eau: 'water', eau_usee: 'grey water', eau_noire: 'black water', poubelle: 'bins', wc_public: 'toilets',
  douche: 'shower', electricite: 'electricity', wifi: 'wifi', laverie: 'laundry', boulangerie: 'bakery', donnees_mobile: 'mobile data',
  lavage: 'washing', gaz: 'gas', caravaneige: 'winter camping',
};

class RateLimited extends Error {
  constructor(msg) { super(msg); this.name = 'RateLimited'; }
}

const state = { last: 0, recent: [] };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for the next free slot, or refuse when the hourly budget is spent. */
async function takeSlot(now = Date.now) {
  state.recent = state.recent.filter((t) => now() - t < 3600e3);
  if (state.recent.length >= MAX_PER_HOUR) {
    const retry = Math.ceil((3600e3 - (now() - state.recent[0])) / 60000);
    throw new RateLimited(`park4night search limit reached (${MAX_PER_HOUR} per hour): try again in ${retry} min`);
  }
  const gap = state.last + MIN_GAP_MS - now();
  if (gap > 0) await wait(gap);
  state.last = now();
  state.recent.push(state.last);
}

/** The lowest euro amount quoted in a text ("12 €", "€15", "15 eur"), or null. */
function priceHint(text) {
  const m = String(text || '').match(/(?:€\s*(\d{1,3}(?:[.,]\d{1,2})?)|(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:€|eur\b|euros?\b))/i);
  return m ? parseFloat((m[1] || m[2]).replace(',', '.')) : null;
}

function decode(text) {
  const t = String(text).trim();
  try { return JSON.parse(t); } catch { /* base64 is the usual answer */ }
  return JSON.parse(Buffer.from(t.replace(/^"|"$/g, ''), 'base64').toString('utf8'));
}

/**
 * @param a { lat, lng, radius_km, types[], dog, min_rating, max_price, limit, lang }
 */
async function search(a, { now } = {}) {
  const allowed = KINDS_FOR[a.vehicle] || KINDS_FOR.rooftop_tent;
  const types = (a.types && a.types.length ? a.types : allowed).filter((k) => allowed.includes(k));
  const codes = new Set(types.flatMap((k) => KINDS[k] || []));
  await takeSlot(now);
  const url = `${BASE}/api/places/around?lat=${(+a.lat).toFixed(5)}&lng=${(+a.lng).toFixed(5)}&radius=${Math.round(a.radius_km)}&filter=%7B%7D&lang=${a.lang}`;
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (r.status === 429) throw new RateLimited('park4night is limiting requests: try again later');
  if (!r.ok) throw new Error(`park4night ${r.status}`);
  let list;
  try { list = decode(await r.text()); } catch { throw new Error('park4night answer not readable (the unofficial endpoint may have changed)'); }
  if (!Array.isArray(list)) throw new Error('park4night answer not a list (the unofficial endpoint may have changed)');

  const places = [];
  let skipped = 0;
  for (const p of list) {
    const code = p.type && p.type.code;
    if (!codes.has(code)) { skipped++; continue; }
    const services = (p.services || []).map((s) => SERVICES[s] || s);
    if (a.dog && !(p.services || []).includes('animaux')) continue;
    if (a.min_rating && (p.rating ?? 0) < a.min_rating) continue;
    const price = priceHint(p.description);
    if (a.max_price != null && price != null && price > a.max_price) continue;
    places.push({
      name: p.title_short || p.name || p.title || '(unnamed)',
      kind: Object.keys(KINDS).find((k) => KINDS[k].includes(code)),
      source: 'park4night',
      typeLabel: p.type && p.type.label,
      lat: p.lat,
      lng: p.lng,
      distanceKm: p.distance != null ? Math.round(p.distance * 10) / 10 : null,
      rating: p.rating ?? null,
      reviews: p.review ?? 0,
      services,
      priceHint: price,
      page: p.url ? `${BASE}${p.url}` : null,
    });
  }
  places.sort((x, y) => (y.rating ?? 0) - (x.rating ?? 0) || (x.distanceKm ?? 99) - (y.distanceKm ?? 99));
  return {
    source: 'park4night (UNOFFICIAL, undocumented endpoint; data © park4night). Nothing stored.',
    center: { lat: +a.lat, lng: +a.lng }, radiusKm: a.radius_km,
    found: places.length, skippedOtherTypes: skipped,
    places: places.slice(0, a.limit),
    toVerify: 'Price (rarely in this list: priceHint is read from the description, may be stale), opening in season, rooftop tent accepted, recent reviews: open each page. Never book or message a host without the user\'s explicit validation.',
  };
}

const resetRate = () => { state.last = 0; state.recent = []; };

module.exports = { search, priceHint, decode, RateLimited, KINDS, KINDS_FOR, SERVICES, resetRate, MAX_PER_HOUR };
