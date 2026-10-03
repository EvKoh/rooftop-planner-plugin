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
// Places looked at are remembered for a while in the plugin's db (ids and a date only), so
// a place with nothing to find is not asked about on every visit.
const overpass = require('./overpass');
const park4night = require('./park4night');
const placeInfo = require('./place-info');
const { distKm } = require('./util');

const OSM_RADIUS_M = 150;
const P4N_RADIUS_M = 60;
const RECHECK_DAYS = 30;
const BATCH = 20;
const MIGRATION = 'CREATE TABLE IF NOT EXISTS amenity_fill_log (place_id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL)';

const yesNo = (v) => (v == null ? null : /^(yes|designated|free|hot|leashed|wlan|wifi|customers)$/.test(v) ? 'yes' : v === 'no' ? 'no' : null);

/** OSM tags → amenity values (null = the tag says nothing). */
function fromOsm(tags) {
  const power = tags.power_supply;
  return {
    dog: yesNo(tags.dog),
    water: yesNo(tags.drinking_water),
    electricity: power == null ? null : power === 'no' ? 'no' : 'yes',
    shower: yesNo(tags.shower),
    toilets: yesNo(tags.toilets),
    dump_station: yesNo(tags.sanitary_dump_station),
    wifi: yesNo(tags.internet_access),
    rooftop_tent: null,
  };
}

const P4N = { animaux: 'dog', point_eau: 'water', electricite: 'electricity', douche: 'shower', wc_public: 'toilets', eau_noire: 'dump_station', eau_usee: 'dump_station', wifi: 'wifi' };

/** park4night services → amenity values: only what the place has. */
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

/** Places worth looking at: real places (no road geometry) with a position. */
function candidates(places) {
  return places.filter((p) => !p.route_geometry && p.lat != null && p.lng != null);
}

/**
 * Fill the amenities of up to BATCH places of a trip that have unknown ones.
 * opts: { placeIds?: number[] (only these, rechecked even if seen lately), park4night: boolean }
 * → { looked, filled, nothing, remaining, park4nightLimited, osmBusy }
 */
async function fill(ctx, tripId, opts = {}) {
  const all = candidates(await ctx.trips.getPlaces(Number(tripId)));
  const only = opts.placeIds ? new Set(opts.placeIds.map(Number)) : null;
  const pool = only ? all.filter((p) => only.has(p.id)) : all;
  const records = await placeInfo.getAll(ctx, tripId, pool.map((p) => p.id));
  const open = (p) => {
    const r = records.get(p.id);
    return !r || Object.values(r.amenities).some((v) => v === 'unknown');
  };
  const seen = only ? new Set() : await recentlyChecked(ctx, pool.map((p) => p.id));
  const todo = pool.filter((p) => open(p) && !seen.has(p.id));
  const batch = todo.slice(0, BATCH);
  const res = { looked: batch.length, filled: 0, nothing: 0, remaining: Math.max(0, todo.length - batch.length), park4nightLimited: false, osmBusy: false };
  if (!batch.length) return res;

  let osm = [];
  try {
    const body = `(${batch.map((p) => `nwr(around:${OSM_RADIUS_M},${(+p.lat).toFixed(5)},${(+p.lng).toFixed(5)})[tourism~"^(camp_site|caravan_site)$"];`).join('')});out tags center;`;
    osm = (await overpass.query(ctx, body, { timeoutMs: 8000 })) || [];
  } catch (e) {
    if (e instanceof overpass.OverpassBusy) res.osmBusy = true; else throw e;
  }

  const p4nAreas = [];
  const looked = [];
  for (const place of batch) {
    const found = {};
    const sources = [];
    const camp = nearest(place, osm, OSM_RADIUS_M);
    if (camp) {
      for (const [k, v] of Object.entries(fromOsm(camp.tags))) if (v) found[k] = v;
      sources.push(`OpenStreetMap ${overpass.osmUrl(camp.id)}`);
    }
    const id = p4nId(place);
    let list = opts.park4night ? p4nAreas.find((a) => km(place, a.center) < 3) : null;
    if (opts.park4night && !res.park4nightLimited && (id || list)) {
      try {
        if (!list) {
          list = { center: { lat: +place.lat, lng: +place.lng }, places: await park4night.around(place.lat, place.lng, 5) };
          p4nAreas.push(list);
        }
        const hit = (id && list.places.find((x) => x.id === id)) || nearest(place, list.places, P4N_RADIUS_M);
        if (hit) {
          for (const [k, v] of Object.entries(fromP4n(hit.services))) if (!found[k]) found[k] = v;
          sources.push(`park4night #${hit.id}`);
        }
      } catch (e) {
        // Rate limit: stop asking park4night in this batch. Any other failure: OSM alone.
        if (e instanceof park4night.RateLimited) res.park4nightLimited = true;
      }
    }
    // A linked place whose park4night lookup was cut short by the rate limit is retried later.
    if (!(res.park4nightLimited && id && !sources.some((x) => x.startsWith('park4night')))) looked.push(place.id);
    const current = await placeInfo.get(ctx, place.id);
    const patch = {};
    for (const [k, v] of Object.entries(found)) if (!current || current.amenities[k] === 'unknown') patch[k] = v;
    if (!Object.keys(patch).length) { res.nothing++; continue; }
    if (!current || !current.source) patch.source = `${sources.join(' · ')} (auto)`.slice(0, 300);
    if (!current || !current.checked) patch.checked = new Date().toISOString().slice(0, 10);
    await placeInfo.set(ctx, tripId, place.id, patch);
    res.filled++;
  }
  await remember(ctx, looked);
  return res;
}

module.exports = { LOG_SQL, fill, fromOsm, fromP4n, p4nId, migrate, MIGRATION, BATCH, OSM_RADIUS_M, P4N_RADIUS_M };
