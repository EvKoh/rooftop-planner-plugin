'use strict';
// Reads what a TREK place is from its category name, its own name and its notes. TREK has
// no fixed category vocabulary (every instance names its own), so the patterns cover the
// common English, French, Italian and German wordings. Matching is accent-insensitive.
const { norm } = require('./util');

const RE = {
  // A motorhome area (a night for a van or a motorhome, never for an opened rooftop tent)
  // and a car park or wild spot (the local rule decides) are told apart.
  aire: /\baire\b|stellplatz|wohnmobil|area (di )?sosta|area camper|motorhome|camper ?stop|camping-?car/,
  parking: /\bparking\b|parcheggio|parkplatz|geospot|wild ?camp|bivouac|bivacco|spot nature|nature spot/,
  campsite: /camping|campsite|camp ?site|campeggio|campingplatz|camp_site/,
  farm: /\bferme\b|\bfarm\b|agri|bauernhof|\bhof\b|masseria|agricamp/,
  privateGround: /habitant|particulier|private (ground|garden|land|pitch)|privat|homecamp|backyard|jardin/,
  hut: /refuge|rifugio|hutte|huette|\bhut\b|baita/,
  night: /nuitee|night|overnight|camping|campsite|aire|stellplatz|agritur|farm|ferme|sleep|accommodation|hebergement|lodging/,
  // The day's route place: TREK draws its stored geometry as the day's line.
  // Never a bare "track": a user's "Hiking track" category is a hike, not the day's line
  // (the day's trace is RECREATED on routes apply, and the old one deleted).
  trace: /trace du jour|route of the day|day route|route jour|route day/,
  shop: /courses|supermarket|supermarche|grocer|epicerie|boulangerie|bakery|shop|alimentari|lebensmittel/,
  fuel: /carburant|fuel|petrol|gas station|station[- ]service|tankstelle|distributore|benzin/,
};

const test = (re, ...texts) => re.test(norm(texts.filter(Boolean).join(' \n ')));

/** Kind of ground a night is spent on: 'campsite' | 'farm' | 'aire' | 'parking' | 'private' | 'hut' | 'unknown'. */
/** The kind of ground the category alone names, or null (the user's own filing). */
function categoryKind(categoryName) {
  const cat = norm(categoryName);
  if (RE.aire.test(cat)) return 'aire';
  if (RE.parking.test(cat)) return 'parking';
  if (RE.farm.test(cat)) return 'farm';
  if (RE.campsite.test(cat)) return 'campsite';
  if (RE.privateGround.test(cat)) return 'private';
  if (RE.hut.test(cat)) return 'hut';
  return null;
}

function nightKind(categoryName, placeName) {
  const name = norm(placeName);
  // The category is the user's own decision, so it wins over words in the name.
  const byCat = categoryKind(categoryName);
  if (byCat) return byCat;
  if (RE.aire.test(name) && !RE.campsite.test(name)) return 'aire';
  if (RE.parking.test(name) && !RE.campsite.test(name)) return 'parking';
  if (RE.campsite.test(name)) return 'campsite';
  if (RE.farm.test(name)) return 'farm';
  if (RE.hut.test(name)) return 'hut';
  return 'unknown';
}

const isNightCategory = (cat) => test(RE.night, cat);
const isShopping = (cat, stopType) => stopType === 'fuel' || test(RE.shop, cat) || test(RE.fuel, cat);
/** A route place carries a geometry; the category name is the fallback when it is not loaded. */
// A drawn route, whatever its category: TREK's row (route_geometry) or the loaded model (geometry).
// The day's trace: the day-route category, or any place with a drawn line, whatever its
// category — except a hike (a walk imported from a GPX, by its category or name): that line is
// the walk, never the day's road, and routes apply would delete it.
const isTrace = (cat, place) => test(RE.trace, cat) || (!!(place && (place.route_geometry || place.geometry?.length))
  && !require('./design').isHikePlace({ name: place.name || '', categoryName: cat || '' }));

/**
 * Where the car is left for a stop reached on foot: a "Departure/Start/Parking ... lat, lng"
 * line in the notes. Returns [lat, lng] or null.
 */
function parkingFromNotes(...texts) {
  const t = texts.filter(Boolean).join('\n');
  const m = t.match(/(?:d[ée]part|start|departure|parking|parcheggio|parkplatz)[^\n]{0,80}?(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/i);
  return m ? [+m[1], +m[2]] : null;
}

module.exports = { categoryKind, nightKind, isNightCategory, isShopping, isTrace, parkingFromNotes, RE };
