'use strict';
// Reads what a TREK place is from its category name, its own name and its notes. TREK has
// no fixed category vocabulary (every instance names its own), so the patterns cover the
// common English, French, Italian and German wordings. Matching is accent-insensitive.
const { norm } = require('./util');

const RE = {
  // A rooftop tent may only be opened on a campsite or a farm that hosts campers.
  aire: /\baire\b|stellplatz|area (di )?sosta|area camper|motorhome|camper ?stop|camping-?car|\bparking\b|parcheggio|parkplatz|geospot|wild ?camp/,
  campsite: /camping|campsite|camp ?site|campeggio|campingplatz|camp_site/,
  farm: /\bferme\b|\bfarm\b|agri|bauernhof|\bhof\b|masseria|agricamp/,
  privateGround: /habitant|particulier|private (ground|garden|land|pitch)|privat|homecamp|backyard|jardin/,
  hut: /refuge|rifugio|hutte|huette|\bhut\b|baita/,
  night: /nuitee|night|overnight|camping|campsite|aire|stellplatz|agritur|farm|ferme|sleep|accommodation|hebergement|lodging/,
  // The day's route place: TREK draws its stored geometry as the day's line.
  trace: /trace du jour|route of the day|day route|route jour|route day|\btrack\b/,
  shop: /courses|supermarket|supermarche|grocer|epicerie|boulangerie|bakery|shop|alimentari|lebensmittel/,
  fuel: /carburant|fuel|petrol|gas station|station[- ]service|tankstelle|distributore|benzin/,
  hike: /randonn|hike|hiking|trek(king)?\b|trail|wander|escursion|on foot|a pied/,
};

const test = (re, ...texts) => re.test(norm(texts.filter(Boolean).join(' \n ')));

/** Kind of ground a night is spent on: 'campsite' | 'farm' | 'aire' | 'private' | 'hut' | 'unknown'. */
function nightKind(categoryName, placeName) {
  const cat = norm(categoryName);
  const name = norm(placeName);
  // The category is the user's own decision, so it wins over words in the name.
  if (RE.aire.test(cat)) return 'aire';
  if (RE.farm.test(cat)) return 'farm';
  if (RE.campsite.test(cat)) return 'campsite';
  if (RE.privateGround.test(cat)) return 'private';
  if (RE.hut.test(cat)) return 'hut';
  if (RE.aire.test(name) && !RE.campsite.test(name)) return 'aire';
  if (RE.campsite.test(name)) return 'campsite';
  if (RE.farm.test(name)) return 'farm';
  if (RE.hut.test(name)) return 'hut';
  return 'unknown';
}

const isNightCategory = (cat) => test(RE.night, cat);
const isShopping = (cat, stopType) => stopType === 'fuel' || test(RE.shop, cat) || test(RE.fuel, cat);
const isHike = (cat) => test(RE.hike, cat);
/** A route place carries a geometry; the category name is the fallback when it is not loaded. */
const isTrace = (cat, place) => !!(place && place.route_geometry) || test(RE.trace, cat);

/**
 * Where the car is left for a stop reached on foot: a "Departure/Start/Parking ... lat, lng"
 * line in the notes. Returns [lat, lng] or null.
 */
function parkingFromNotes(...texts) {
  const t = texts.filter(Boolean).join('\n');
  const m = t.match(/(?:d[ée]part|start|departure|parking|parcheggio|parkplatz)[^\n]{0,80}?(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/i);
  return m ? [+m[1], +m[2]] : null;
}

module.exports = { nightKind, isNightCategory, isShopping, isHike, isTrace, parkingFromNotes, RE };
