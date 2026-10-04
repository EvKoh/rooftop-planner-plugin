'use strict';
// Fills the amenities of a trip's places from open sources, so the hover card and the
// columns show them without anyone typing them in:
// - OpenStreetMap: the campsite or motorhome area mapped within 150 m of the place;
// - park4night, when the instance enables it: the place it links to (its park4night page).
//   A place without a link is matched within 60 m only against lists already fetched for a
//   linked neighbour: the hourly park4night budget is not spent on museums and lakes.
// Only unknown values are filled: what a person recorded is never overwritten. A source
// that does not mention an amenity leaves it unknown; "no" is written only when OSM says
// so explicitly (park4night lists what a place has, not what it lacks).
// Contacts (e-mail, phone, website) are filled the same way, field by field, from what the
// place itself says first — TREK's own website and phone, then the e-mails, numbers and
// web addresses quoted in its notes or description — then OpenStreetMap, then park4night;
// each filled field names its source. A time on site the notes state ("2h30 round trip")
// fills an empty visit duration, quoting them.
// Places looked at are remembered for a while in the plugin's db (ids and a date only), so
// a place with nothing to find is not asked about on every visit.
const overpass = require('./overpass');
const park4night = require('./park4night');
const placeInfo = require('./place-info');
const contacts = require('./contacts');
const { distKm } = require('./util');
const i18n = require('./i18n');
const { t } = i18n;
const { parseVisit } = require('./visit');

const OSM_RADIUS_M = 150;
const P4N_RADIUS_M = 60;
const RECHECK_DAYS = 30;
const BATCH = 20;
// TREK cuts a route at 30 s and a tool at 15 s: stop starting new places after this.
const BUDGET_MS = 11000;
const MIGRATION = 'CREATE TABLE IF NOT EXISTS amenity_fill_log (place_id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL)';

const yesNo = (v) => (v == null ? null : /^(yes|designated|free|hot|leashed|wlan|wifi|customers)$/.test(v) ? 'yes' : v === 'no' ? 'no' : null);

// Any value but "no" means there is one ("shop=convenience", "restaurant=snack").
const present = (v) => (v == null ? null : v === 'no' ? 'no' : 'yes');

/**
 * OSM tags of a campsite or motorhome area → amenity values (null = the tag says nothing).
 * Only tags OSM documents on tourism=camp_site / caravan_site; amenities with no such tag
 * (bins, bakery, mobile data, gas, LPG, vehicle wash, winter) come from park4night alone.
 */
function fromOsm(tags) {
  return {
    dog: yesNo(tags.dog),
    water: yesNo(tags.drinking_water),
    electricity: present(tags.power_supply),
    toilets: yesNo(tags.toilets),
    shower: yesNo(tags.shower),
    dump_station: yesNo(tags.sanitary_dump_station),
    wifi: yesNo(tags.internet_access),
    laundry: yesNo(tags.washing_machine),
    pool: yesNo(tags.swimming_pool),
    shop: present(tags.shop),
    restaurant: present(tags.restaurant),
    bar: present(tags.bar),
    playground: yesNo(tags.playground),
    bbq: yesNo(tags.bbq),
  };
}

// park4night service codes (and the one activity that is an amenity) → amenity keys.
const P4N = {
  animaux: 'dog', point_eau: 'water', electricite: 'electricity', wc_public: 'toilets', douche: 'shower',
  eau_noire: 'dump_station', eau_usee: 'dump_station', wifi: 'wifi', poubelle: 'bins', laverie: 'laundry',
  piscine: 'pool', boulangerie: 'bakery', donnees_mobile: 'mobile_data', jeux_enfants: 'playground',
  gaz: 'gas', gpl: 'lpg', lavage: 'vehicle_wash', caravaneige: 'winter',
};

/** park4night services (and activities) → amenity values: only what the place has. */
function fromP4n(services) {
  const out = {};
  for (const s of services || []) if (P4N[s]) out[P4N[s]] = 'yes';
  return out;
}

/** The park4night id a place links to (its website or a note), or null. */
function p4nId(place) {
  const m = `${place.website || ''} ${place.notes || ''}`.match(/park4night\.com\/(?:[a-z]{2}\/)?(?:place|lieu)\/(\d+)/i);
  return m ? Number(m[1]) : null;
}

const km = (a, b) => distKm([a.lat, a.lng], [b.lat, b.lng]);

function nearest(place, list, maxM) {
  let best = null;
  for (const e of list) {
    if (e.lat == null || e.lng == null) continue;
    const d = km(place, e) * 1000;
    if (d <= maxM && (!best || d < best.d)) best = { d, e };
  }
  return best && best.e;
}

async function migrate(ctx) {
  await ctx.db.migrate('003_amenity_fill_log', MIGRATION);
}

const LOG_SQL = 'SELECT place_id, checked_at FROM amenity_fill_log';

async function recentlyChecked(ctx, ids) {
  if (!ids.length) return new Set();
  const since = new Date(Date.now() - RECHECK_DAYS * 864e5).toISOString();
  const wanted = new Set(ids);
  try {
    const rows = await ctx.db.query(LOG_SQL);
    return new Set(rows.filter((r) => wanted.has(r.place_id) && r.checked_at >= since).map((r) => r.place_id));
  } catch { return new Set(); }
}

async function remember(ctx, ids) {
  if (!ids.length) return;
  const now = new Date().toISOString();
  try {
    await ctx.db.tx(ids.map((id) => ({ sql: 'INSERT OR REPLACE INTO amenity_fill_log (place_id, checked_at) VALUES (?, ?)', args: [id, now] })));
  } catch { /* the log only saves work */ }
}

const CONTACT_KEYS = ['email', 'phone', 'website'];

/** Is anything left to look for on this record? (an unknown amenity, or an empty contact) */
function incomplete(r) {
  return !r || Object.values(r.amenities).some((v) => v === 'unknown') || CONTACT_KEYS.some((k) => !r.contacts[k]);
}

/**
 * Contacts a place states itself: TREK's own website and phone fields, and what its notes
 * or description quote. → [{ values: {email, phone, website}, source }], best first.
 */
function ownContacts(place, L) {
  const out = [];
  const trek = contacts.fromOsmTags({ website: place.website && !contacts.notOwnSite(place.website) ? place.website : null, phone: place.phone });
  if (trek.website || trek.phone) out.push({ values: trek, source: t(L, 'src.trek') });
  const x = contacts.extract(`${place.notes || ''}\n${place.description || ''}`);
  const fromText = { email: x.emails[0] || null, phone: x.phones[0] || null, website: x.urls[0] || null };
  if (fromText.email || fromText.phone || fromText.website) out.push({ values: fromText, source: t(L, 'src.notes') });
  return out;
}

/** Places worth looking at: real places (no road geometry) with a position. */
function candidates(places) {
  return places.filter((p) => !p.route_geometry && p.lat != null && p.lng != null);
}

/**
 * Fill the amenities of up to BATCH places of a trip that have unknown ones.
 * opts: { placeIds?: number[] (only these, rechecked even if seen lately), park4night: boolean,
 *         language?: the language the "notes of the place" source is named in }
 * → { looked, filled, contacts, nothing, remaining, park4nightLimited, osmBusy }
 */
async function fill(ctx, tripId, opts = {}) {
  const t0 = Date.now();
  const until = t0 + (opts.budgetMs ?? BUDGET_MS);
  const ms = {};
  const lap = (k, since) => { ms[k] = (ms[k] || 0) + Date.now() - since; };
  let t = Date.now();
  const all = candidates(await ctx.trips.getPlaces(Number(tripId)));
  lap('places', t);
  const only = opts.placeIds ? new Set(opts.placeIds.map(Number)) : null;
  const pool = only ? all.filter((p) => only.has(p.id)) : all;
  t = Date.now();
  const seen = only ? new Set() : await recentlyChecked(ctx, pool.map((p) => p.id));
  lap('log', t);
  t = Date.now();
  const todo = pool.filter((p) => !seen.has(p.id));
  // Read records only until the batch is full: a trip can hold hundreds of places.
  const batch = [];
  const records = new Map();
  const complete = [];
  let read = 0;
  for (const p of todo) {
    if (batch.length >= BATCH || Date.now() > until) break;
    read++;
    const r = await placeInfo.get(ctx, p.id);
    if (!incomplete(r)) { complete.push(p.id); continue; }
    records.set(p.id, r);
    batch.push(p);
  }
  lap('read', t);
  const res = { looked: batch.length, filled: 0, contacts: 0, visits: 0, nothing: 0, remaining: todo.length - read, park4nightLimited: false, osmBusy: false, ms };
  if (!batch.length) { await remember(ctx, complete); return res; }

  let osm = [];
  t = Date.now();
  try {
    const body = `(${batch.map((p) => {
      const a = `(around:${OSM_RADIUS_M},${(+p.lat).toFixed(5)},${(+p.lng).toFixed(5)})`;
      return `nwr${a}[tourism~"^(camp_site|caravan_site)$"];nwr${a}[agriturismo=yes];`;
    }).join('')});out tags center;`;
    // Within the time left: the place view gives up on a call after 8 s.
    osm = (await overpass.query(ctx, body, { timeoutMs: Math.max(1500, Math.min(8000, until - Date.now() - 300)) })) || [];
  } catch (e) {
    if (e instanceof overpass.OverpassBusy) res.osmBusy = true; else throw e;
  }

  lap('osm', t);
  const p4nAreas = [];
  const looked = [...complete];
  let done = 0;
  for (const place of batch) {
    if (Date.now() > until) break;
    done++;
    const found = {};
    const sources = [];
    // Contact candidates, best first: the place itself, OSM, park4night.
    const contactFrom = ownContacts(place, opts.language);
    const camp = nearest(place, osm, OSM_RADIUS_M);
    if (camp) {
      for (const [k, v] of Object.entries(fromOsm(camp.tags))) if (v) found[k] = v;
      sources.push(`OpenStreetMap ${overpass.osmUrl(camp.id)}`);
      contactFrom.push({ values: contacts.fromOsmTags(camp.tags), source: `OpenStreetMap ${overpass.osmUrl(camp.id)}` });
    }
    const id = p4nId(place);
    let list = opts.park4night ? p4nAreas.find((a) => km(place, a.center) < 3) : null;
    if (opts.park4night && !res.park4nightLimited && (id || list)) {
      try {
        if (!list) {
          const tp = Date.now();
          list = { center: { lat: +place.lat, lng: +place.lng }, places: await park4night.around(place.lat, place.lng, 5) };
          lap('park4night', tp);
          p4nAreas.push(list);
        }
        const hit = (id && list.places.find((x) => x.id === id)) || nearest(place, list.places, P4N_RADIUS_M);
        if (hit) {
          for (const [k, v] of Object.entries(fromP4n([...(hit.services || []), ...(hit.activities || [])]))) if (!found[k]) found[k] = v;
          sources.push(`park4night #${hit.id}`);
          if (hit.contact) contactFrom.push({ values: hit.contact, source: `park4night #${hit.id}` });
        }
      } catch (e) {
        // Rate limit: stop asking park4night in this batch. Any other failure: OSM alone.
        if (e instanceof park4night.RateLimited) res.park4nightLimited = true;
      }
    }
    // A linked place whose park4night lookup was cut short by the rate limit is retried later.
    if (!(res.park4nightLimited && id && !sources.some((x) => x.startsWith('park4night')))) looked.push(place.id);
    const current = records.get(place.id) || null;
    const patch = {};
    for (const [k, v] of Object.entries(found)) if (!current || current.amenities[k] === 'unknown') patch[k] = v;
    const amenitiesFound = Object.keys(patch).length > 0;
    // Only empty contact fields, each from the first source that has it.
    const cpatch = {};
    const csources = {};
    for (const k of CONTACT_KEYS) {
      if (current && current.contacts[k]) continue;
      // A platform page is never the host's website, whichever source gives it.
      const hit = contactFrom.find((c) => c.values && c.values[k] && !(k === 'website' && contacts.notOwnSite(c.values[k])));
      if (hit) { cpatch[k] = hit.values[k]; csources[k] = hit.source; }
    }
    // Time on site, from what the place's own notes or description say; never over a typed one.
    const visit = (!current || current.visit_min_minutes == null) ? parseVisit(`${place.notes || ''}\n${place.description || ''}`) : null;
    if (visit) {
      Object.assign(patch, { visit_min_minutes: visit.min, visit_max_minutes: visit.max, visit_source: `${i18n.t(opts.language, 'src.notes')}: "${visit.quote}"` });
      res.visits++;
    }
    if (!amenitiesFound && !visit && !Object.keys(cpatch).length) { res.nothing++; continue; }
    if (Object.keys(cpatch).length) { patch.contacts = cpatch; patch.contact_sources = csources; res.contacts++; }
    if (amenitiesFound && (!current || !current.source)) patch.source = `${sources.join(' · ')} (auto)`.slice(0, 300);
    if (amenitiesFound && (!current || !current.checked)) patch.checked = new Date().toISOString().slice(0, 10);
    await placeInfo.set(ctx, tripId, place.id, patch, { place });
    res.filled++;
  }
  res.remaining += batch.length - done;
  ms.total = Date.now() - t0;
  res.looked = done;
  await remember(ctx, looked);
  return res;
}

module.exports = { CONTACT_KEYS, incomplete, ownContacts, P4N, LOG_SQL, fill, fromOsm, fromP4n, p4nId, migrate, MIGRATION, BATCH, OSM_RADIUS_M, P4N_RADIUS_M };
