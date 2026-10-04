'use strict';
// THE design catalogue of the plugin: every colour and every pictogram it shows, in one place.
// Nothing else in the plugin picks a tone or an icon; it asks this module.
//
//   Colour = state, on the marker's disc and border (the user's specification, 04/10/2026):
//                    green  booked — and nothing else is ever green
//                    amber  in discussion, or a point to watch (timed access, booking, warning)
//                    red    cancelled / dropped, or something that rules the place out
//                    blue   available: planned or not, but neither booked, in discussion nor
//                           cancelled (TREK's default tone)
//   The plugin's own pictograms (assets/icons/*.svg → glyphs.json, built by
//   scripts/build-glyphs.js) cover what TREK's icon set lacks: the vanlife vehicles and ways
//   to sleep. A marker sends the glyph, plus the closest TREK icon as a fallback.
//   Pictogram = kind. A night by the ground it is spent on (tent, farm, home, hut, motorhome
//                    area, hotel), an activity by what it is (hike, lake, viewpoint, village…).
//
// Tones are TREK's palette (default | success | warn | danger); icons are lucide names.
// Map markers can only draw TREK's own icon set (MARKER_ICONS); chips take any lucide name.

const { norm } = require('./util');
const { nightKind, RE } = require('./classify');
const GLYPHS = require('./glyphs.json');

/** The vehicle a night in a car park or a wild spot is spent in: its own pictogram. */
const VEHICLE_GLYPH = { rooftop_tent: 'rooftop-tent', campervan: 'campervan', motorhome: 'motorhome', car: 'car' };
/** Glyphs by kind of night, with the TREK icon used where a host cannot draw glyphs. */
const NIGHT_GLYPH = { campsite: ['tent', 'Tent'], aire: ['motorhome', 'Car'], bivouac: ['sleeping-bag', 'Tent'] };
const BIVOUAC = /bivouac|bivacco|biwak|vivac|duvet|sleeping bag|schlafsack|sacco a pelo|saco de dormir|a la belle etoile/;

/** State → tone. */
const TONE = {
  planned: 'default',
  booked: 'success',
  contacted: 'warn',
  spotted: 'default',
  dropped: 'danger',
  watch: 'warn',
  rulesOut: 'danger',
  info: 'default',
};

/** Night status chip (a spotted place, with no booking, gets no chip). */
const NIGHT_STATUS = {
  booked: { tone: TONE.booked, icon: 'BedDouble' },
  contacted: { tone: TONE.contacted, icon: 'Clock' },
  dropped: { tone: TONE.dropped, icon: 'XCircle' },
};

/** One icon per amenity (names known to lucide-react 0.344, the SDK's snapshot). */
const AMENITY_ICONS = {
  dog: 'Dog', water: 'Droplet', electricity: 'Zap', toilets: 'Bath', shower: 'ShowerHead',
  dump_station: 'Droplets', wifi: 'Wifi', bins: 'Trash2', laundry: 'WashingMachine', pool: 'Waves',
  shop: 'ShoppingCart', bakery: 'Croissant', restaurant: 'Sandwich', bar: 'Beer', mobile_data: 'Signal',
  playground: 'Baby', bbq: 'Flame', gas: 'Cylinder', lpg: 'Fuel', vehicle_wash: 'CarFront',
  winter: 'Snowflake', rooftop_tent: 'Tent',
};

/** The other chips on a place. */
const CHIP = {
  price: { icon: 'Euro', tone: TONE.info },
  visit: { icon: 'Timer', tone: TONE.info },
  accessBefore: { icon: 'AlarmClock', tone: TONE.watch },
  accessAfter: { icon: 'Clock', tone: TONE.watch },
  booking: { icon: 'CalendarCheck', tone: TONE.watch },
  toll: { icon: 'Ticket', tone: TONE.info },
  missing: { icon: 'Ban', tone: TONE.rulesOut },
};

/** Pictogram of a night, by the ground it is spent on (classify.nightKind). */
const NIGHT_PICTOGRAM = { campsite: 'Tent', farm: 'Leaf', private: 'Home', cabin: 'Home', hut: 'Mountain', aire: 'Car', parking: 'Car', hotel: 'BedDouble', unknown: 'BedDouble' };
const HOTEL = /hotel|b&b|bed and breakfast|chambre d.?hote|gasthof|pension|albergo|hostal|hostel|auberge|en dur|apartment|appartement|ferienwohnung|lodge|motel|guesthouse|guest house|ryokan/;
const CABIN = /chalet|cabin|cabane|bungalow|glamping|yourte|yurt|tiny house|mobil-?home|hutte en bois|baita privata/;

/** Kind, pictogram and pattern of an activity, most specific first (English, French, Italian, German, Spanish). */
const ACTIVITY_PICTOGRAM = [
  ['start', 'Flag', /depart|retour|start|finish|home base|domicile|abfahrt|partenza|salida/],
  ['plane', 'Plane', /aeroport|airport|flughafen|aeroporto|aeropuerto/],
  ['train', 'Train', /\bgare\b|train|bahnhof|stazione|estacion|railway/],
  ['bus', 'Bus', /\bbus\b|navette|shuttle|autobus|pullman/],
  ['boat', 'Ship', /bateau|boat|ferry|fahre|faehre|traghetto|ferri|canoe|kayak|rafting|paddle|barca|croisiere|cruise/],
  ['bike', 'Bike', /velo|bike|cycl|vtt|radtour|fahrrad|bici|mountain ?bike/],
  ['hike', 'Mountain', /randonn|hike|hiking|trek(king)?\b|trail|wander|escursion|sentier|senderis|via ferrata|sommet|summit|gipfel|cima\b/],
  ['lift', 'Mountain', /remontee|telepherique|telecabine|telesiege|cable car|gondola|chairlift|seilbahn|sessellift|funivia|seggiovia|teleferico/],
  ['restaurant', 'Utensils', /refuge|rifugio|hutte|huette|\bhut\b|baita|\balm\b|restaurant|ristorante|trattoria|pizzeria|bistro|brasserie|gasthaus|osteria|taverna/],
  ['lake', 'Waves', /\blac\b|\blake\b|\blago\b|\bsee\b|cascade|waterfall|wasserfall|cascata|plage|beach|strand|spiaggia|playa|riviere|river|fluss|fiume/],
  ['nature', 'TreePine', /nature|forest|foret|wald|bosco|bosque|parc naturel|nature park|naturpark|gorge|canyon|schlucht/],
  ['viewpoint', 'Camera', /point de vue|viewpoint|view point|belvedere|panorama|aussicht|mirador|lookout/],
  ['church', 'Church', /eglise|church|kirche|chiesa|iglesia|cathedral|chapelle|chapel|kapelle|abbaye|abbey|monastere|kloster/],
  ['market', 'Store', /marche|market|markt|mercato|mercado|producteur|farmer/],
  ['village', 'Landmark', /village|visite|visit|museum|musee|museo|chateau|castle|schloss|castello|castillo|monument|old town|vieille ville|altstadt|centro storico|ruine|ruin/],
  ['groceries', 'ShoppingBag', /courses|supermarket|supermarche|grocer|epicerie|boulangerie|bakery|shop|alimentari|lebensmittel|supermercado|spar\b|lidl|conad|coop/],
  ['cafe', 'Coffee', /cafe|coffee|\bbar\b|pause|break|rast/],
  ['fuel', 'Car', /carburant|fuel|petrol|gas station|station[- ]service|tankstelle|distributore|benzin|gasolinera|parking|parcheggio|parkplatz|peage|toll|maut|pedaggio/],
  ['health', 'Cross', /sante|health|veterinaire|\bvet\b|pharmacie|pharmacy|apotheke|farmacia|hopital|hospital|medecin|doctor/],
  ['water', 'Waves', /\beau\b|water|wasser|acqua|agua|vidange|dump station|\bwc\b|toilet|douche|shower/],
  ['theatre', 'Theater', /theatre|theater|cinema|kino|teatro|opera/],
  ['concert', 'Music', /concert|musique|music|konzert|concerto|festival/],
  ['wine', 'Wine', /\bvin\b|wine|wein|vino|winery|cantina|bodega|degustation|tasting|domaine viticole/],
  ['beer', 'Beer', /biere|beer|\bbier\b|birra|brewery|brauerei|birrificio/],
  ['pool', 'Waves', /piscine|swimming|baignade|schwimm|piscina|thermal|therme|terme|spa\b/],
  ['sport', 'Dumbbell', /sport|escalade|climbing|kletter|arrampicata|escalada|ski\b|luge|rodel|golf/],
  ['tourist_office', 'Compass', /office de tourisme|tourist (info|office)|touristinfo|tourismusburo|ufficio turistico|oficina de turismo/],
  ['library', 'Library', /bibliotheque|library|bibliothek|biblioteca/],
  ['zoo', 'Heart', /\bzoo\b|animal|tierpark|wildpark|parco faunistico|safari|ferme pedagogique/],
  ['activity', 'Ticket', /activite|activity|event|evenement|spectacle|show|aktivit|attivita|actividad|parc d.?attraction|theme park|freizeitpark/],
];

/** The icons a map marker may carry: TREK draws these and nothing else. */
const MARKER_ICONS = new Set([...Object.values(NIGHT_PICTOGRAM), ...ACTIVITY_PICTOGRAM.map(([, icon]) => icon), 'MapPin']);

/** Pictogram of a planned stop: a night by its ground, an activity by what it is (category first). */
function pictogramFor(place, { night = false } = {}) {
  const cat = norm(place.categoryName);
  const name = norm(place.name);
  if (night) {
    if (HOTEL.test(cat) || HOTEL.test(name)) return NIGHT_PICTOGRAM.hotel;
    if (CABIN.test(cat) || CABIN.test(name)) return NIGHT_PICTOGRAM.cabin;
    return NIGHT_PICTOGRAM[nightKind(place.categoryName, place.name)] || NIGHT_PICTOGRAM.unknown;
  }
  for (const text of [cat, name]) {
    for (const [, icon, re] of ACTIVITY_PICTOGRAM) if (re.test(text)) return icon;
  }
  if (RE.shop.test(cat)) return 'ShoppingBag';
  return 'MapPin';
}

/** The plugin glyph of a night, or null: [glyph name, fallback TREK icon]. */
function nightGlyph(place, vehicle) {
  const cat = norm(place.categoryName);
  const name = norm(place.name);
  if (BIVOUAC.test(cat) || BIVOUAC.test(name)) return NIGHT_GLYPH.bivouac;
  const kind = nightKind(place.categoryName, place.name);
  if (kind === 'parking') return [VEHICLE_GLYPH[vehicle] || 'rooftop-tent', 'Car'];
  return NIGHT_GLYPH[kind] || null;
}

/**
 * Look of a planned stop on the map: { tone, icon, glyph? }. `status` is the night's booking
 * state (booked | contacted | dropped | spotted), absent for an activity; `vehicle` the
 * traveller's (settings), for a night spent in it.
 */
function markerStyle(place, { night = false, status = null, vehicle = 'rooftop_tent' } = {}) {
  const tone = night ? (TONE[status] && status !== 'spotted' ? TONE[status] : TONE.spotted) : TONE.planned;
  const g = night ? nightGlyph(place, vehicle) : null;
  if (g && GLYPHS[g[0]]) return { tone, icon: g[1], glyph: GLYPHS[g[0]] };
  return { tone, icon: pictogramFor(place, { night }) };
}

/** The kinds a place can be given (tools take these words): nights by ground, activities by what they are. */
const NIGHT_KINDS = { campsite: RE.campsite, farm: RE.farm, aire: RE.aire, private: RE.privateGround, hut: RE.hut, wild: RE.parking, hotel: HOTEL, cabin: CABIN };
const ACTIVITY_KINDS = Object.fromEntries(ACTIVITY_PICTOGRAM.map(([kind, , re]) => [kind, re]));
const KINDS = [...new Set([...Object.keys(NIGHT_KINDS), ...Object.keys(ACTIVITY_KINDS)])];

/**
 * The trip category that matches `kind`, from the instance's own category names (TREK has no
 * fixed vocabulary): a night kind prefers a night category, an activity kind any other.
 * Returns the category, or null when none matches.
 */
function categoryForKind(categories, kind) {
  const night = kind in NIGHT_KINDS;
  const re = NIGHT_KINDS[kind] || ACTIVITY_KINDS[kind];
  if (!re) return null;
  const list = (categories || []).filter((c) => re.test(norm(c.name)));
  return list.find((c) => RE.night.test(norm(c.name)) === night) || list[0] || null;
}

module.exports = { KINDS, NIGHT_KINDS, categoryForKind, TONE, NIGHT_STATUS, AMENITY_ICONS, CHIP, NIGHT_PICTOGRAM, ACTIVITY_PICTOGRAM, MARKER_ICONS, GLYPHS, VEHICLE_GLYPH, pictogramFor, markerStyle };
