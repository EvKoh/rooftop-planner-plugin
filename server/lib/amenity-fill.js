'use strict';
// Fills the amenities of a trip's places from open sources, so the hover card and the
// columns show them without anyone typing them in:
// - OpenStreetMap: the campsite, motorhome area or farm (agriturismo) mapped within 150 m of the place;
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
const placeSheet = require('./place-sheet');
const contacts = require('./contacts');
const { distKm, urlsIn } = require('./util');
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

/**
 * Is anything left to look for on this place? An unknown amenity, an empty contact, or a time
 * on site its notes state that the record does not have yet (what fill promises to read).
 */
function incomplete(r, place) {
  if (!r || Object.values(r.amenities).some((v) => v === 'unknown') || CONTACT_KEYS.some((k) => !r.contacts[k])) return true;
  return !!place && r.visit_min_minutes == null && (placeSheet.factsOf(place).visitMinutes != null || !!parseVisit(`${place.notes || ''}\n${place.description || ''}`));
}

/**
 * Contacts a place states itself: TREK's own website and phone fields, and what its notes
 * or description quote. → [{ values: {email, phone, website}, source }], best first.
 */
/**
 * The text of the notes without the lines that cite a source, a link list, reviews, a map or
 * a photo: a "Sources : …" line and the bullets listed under it.
 */
const NOT_HOST_LABEL = /^(sources?|liens?|links?|avis|reviews?|rating|photos?|images?|cartes?|maps?|plan|gpx|traces?|quellen?|bewertung\w*|fonti|fonte|recension\w*|fuentes?|resenas|webcams?)\b/;

function hostText(text, notHost) {
  let current = null;
  return String(text || '').split('\n').filter((line) => {
    const bullet = placeSheet.BULLET.test(line); // the sheet's own bullets (•, –, 1., ●...)
    // A label may itself be bulleted ("- Sources : …") or start with a pictogram ("📎 Sources :").
    const kv = placeSheet.splitKey(line.replace(placeSheet.BULLET, '').replace(/^[^\p{L}\p{N}]+/u, ''));
    // The sheet's field, else a label that opens with a source / link / review / photo / map word
    // ("Liens utiles", "Avis Google", "Source officielle", "Photos du lieu", "Carte IGN").
    if (kv) current = placeSheet.fieldOf(kv[0]) || (NOT_HOST_LABEL.test(placeSheet.keyForm(kv[0])) ? 'sources' : null);
    else if (!bullet) current = null; // a plain line ends the list; a bullet stays under its label
    return !(current && notHost.has(current));
  }).join('\n');
}

function ownContacts(place) {
  const out = [];
  const trek = contacts.fromOsmTags({ website: place.website && !contacts.notOwnSite(place.website) ? place.website : null, phone: place.phone });
  if (trek.website || trek.phone) out.push({ values: trek, source: placeInfo.SRC.trek });
  // The host's contacts are never taken from a line that cites a source, a link list,
  // reviews, a map or a photo (a tourist-office page is not the host's site).
  const notHost = new Set(['sources', 'links', 'reviews', 'photo', 'map_url', 'gpx_url', 'checked', 'doubts']);
  const x = contacts.extract(hostText(`${place.notes || ''}\n${place.description || ''}`, notHost));
  // A web address is the host's only when the sheet names it so (its "Site" / "Website" or
  // "Contact" line): any other address in the notes may be a source, a review or a map,
  // whatever its layout (bold, heading, indent). E-mails and phones are read anywhere else.
  const sh = placeSheet.sheetOf({ notes: place.notes || '', description: place.description || '' }).fields;
  const named = [sh.website && !sh.website.fromTrek ? sh.website.url : null, ...urlsIn(sh.contact ? sh.contact.text : '')]
    .find((u) => { if (!u || contacts.notOwnSite(u)) return false; try { contacts.website(u); return true; } catch { return false; } }) || null;
  const fromText = { email: x.emails[0] || null, phone: x.phones[0] || null, website: named };
  if (fromText.email || fromText.phone || fromText.website) out.push({ values: fromText, source: placeInfo.SRC.notes });
  return out;
}

/** Places worth looking at: real places (no road geometry) with a position. */
function candidates(places) {
  return places.filter((p) => !p.route_geometry && p.lat != null && p.lng != null);
}

/**
 * Fill up to BATCH places of a trip that still miss something (incomplete): amenities,
 * contacts, a time on site their notes state.
 * opts: { placeIds?: number[] (only these, rechecked even if seen lately), park4night: boolean,
 *         budgetMs?: number (time allowed; the rest is left for the next call) }
 * → { looked, filled, contacts, nothing, remaining, park4nightLimited, osmBusy }
 */
async function fill(ctx, tripId, opts = {}) {
  const t0 = Date.now();
  const until = t0 + (opts.budgetMs ?? BUDGET_MS);
  const ms = {};
  const lap = (k, since) => { ms[k] = (ms[k] || 0) + Date.now() - since; };
  let t = Date.now();
  // The category's name, as the trip model, the panel and the columns read it: the sheet of a
  // hike filed only by its category reads its summary line ("10.93 km · +770 m · 4 h 10").
  const [rows, cats] = await Promise.all([ctx.trips.getPlaces(Number(tripId)), ctx.categories.list().catch(() => [])]);
  const catName = new Map((cats || []).map((c) => [c.id, c.name]));
  const all = candidates(rows).map((p) => ({ ...p, categoryName: p.category_name || catName.get(p.category_id) || '' }));
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
    if (!incomplete(r, p)) { complete.push(p.id); continue; }
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
    const contactFrom = ownContacts(place);
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
    // The place's own sheet already answers the dog and the rooftop tent: an open source
    // never fills over what the host's text says (a "Chiens : non" stays a no).
    const sheetFacts = placeSheet.factsOf(place);
    const answered = { dog: sheetFacts.dogAllowed != null, rooftop_tent: sheetFacts.tentAllowed != null };
    for (const [k, v] of Object.entries(found)) if ((!current || current.amenities[k] === 'unknown') && !answered[k]) patch[k] = v;
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
    // Time on site, from what the place's own notes or description say; never over a typed one
    // (a typed maximum alone is a recorded time on site too: the fill leaves it whole).
    const stated = placeSheet.factsOf(place);
    const visit = (!current || (current.visit_min_minutes == null && current.visit_max_minutes == null))
      ? (stated.visitMinutes != null ? { min: stated.visitMinutes, max: stated.visitMax, quote: stated.visitQuote } : parseVisit(`${place.notes || ''}\n${place.description || ''}`))
      : null;
    if (visit) {
      Object.assign(patch, { visit_min_minutes: visit.min, visit_max_minutes: visit.max, visit_source: `${placeInfo.SRC.notes}: "${visit.quote}"` });
      res.visits++;
    }
    if (!amenitiesFound && !visit && !Object.keys(cpatch).length) { res.nothing++; continue; }
    if (Object.keys(cpatch).length) { patch.contacts = cpatch; patch.contact_sources = csources; res.contacts++; }
    // The sources say where every amenity came from: a new one is added to those already
    // named. The check date is this fill's when the record was filled automatically; a date
    // the user gave (a host's answer) is theirs and stays.
    if (amenitiesFound) {
      const named = (current && current.source) || '';
      const added = sources.filter((x) => !named.includes(x));
      if (!named) patch.source = `${sources.join(' · ')} ${placeInfo.SRC.auto}`.slice(0, 300);
      else if (added.length) patch.source = `${named} · ${added.join(' · ')}`.slice(0, 300);
      if (!current || !current.checked || !named || named.includes(placeInfo.SRC.auto)) patch.checked = new Date().toISOString().slice(0, 10);
    }
    await placeInfo.set(ctx, tripId, place.id, patch, { place });
    res.filled++;
  }
  res.remaining += batch.length - done;
  ms.total = Date.now() - t0;
  res.looked = done;
  await remember(ctx, looked);
  return res;
}

module.exports = { hostText, CONTACT_KEYS, incomplete, ownContacts, P4N, LOG_SQL, fill, fromOsm, fromP4n, p4nId, migrate, MIGRATION, BATCH, OSM_RADIUS_M, P4N_RADIUS_M };
