'use strict';
// THE design catalogue of the plugin: every colour and every pictogram it shows, in one place.
// Nothing else in the plugin picks a tone or an icon; it asks this module.
//
//   Colour = state.  green  planned / booked
//                    amber  in discussion, or a point to watch (timed access, booking, warning)
//                    red    dropped, or something that rules the place out
//                    neutral information (price, amenity, visit time)
//   Pictogram = kind. A night by the ground it is spent on (tent, farm, home, hut, motorhome
//                    area, hotel), an activity by what it is (hike, lake, viewpoint, village…).
//
// Tones are TREK's palette (default | success | warn | danger); icons are lucide names.
// Map markers can only draw TREK's own icon set (MARKER_ICONS); chips take any lucide name.

const { norm } = require('./util');
const { nightKind, RE } = require('./classify');

/** State → tone. */
const TONE = {
  planned: 'success',
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
const NIGHT_PICTOGRAM = { campsite: 'Tent', farm: 'Leaf', private: 'Home', hut: 'Mountain', aire: 'Car', parking: 'Car', hotel: 'BedDouble', unknown: 'BedDouble' };
const HOTEL = /hotel|b&b|bed and breakfast|chambre d.?hote|gasthof|pension|albergo|hostal|hostel|en dur|apartment|appartement|lodge|motel/;

/** Pictogram of an activity, most specific first (English, French, Italian, German, Spanish). */
const ACTIVITY_PICTOGRAM = [
  ['Flag', /depart|retour|start|finish|home base|domicile|abfahrt|partenza|salida/],
  ['Mountain', /randonn|hike|hiking|trek(king)?\b|trail|wander|escursion|sentier|senderis|via ferrata|sommet|summit|gipfel|cima\b/],
  ['Mountain', /remontee|telepherique|telecabine|telesiege|cable car|gondola|chairlift|seilbahn|sessellift|funivia|seggiovia|teleferico/],
  ['Utensils', /refuge|rifugio|hutte|huette|\bhut\b|baita|\balm\b|restaurant|ristorante|trattoria|pizzeria|bistro|brasserie|gasthaus|osteria|taverna/],
  ['Waves', /\blac\b|\blake\b|\blago\b|\bsee\b|cascade|waterfall|wasserfall|cascata|plage|beach|strand|spiaggia|playa|riviere|river|fluss|fiume/],
  ['TreePine', /nature|forest|foret|wald|bosco|bosque|parc naturel|nature park|naturpark|gorge|canyon|schlucht/],
  ['Camera', /point de vue|viewpoint|view point|belvedere|panorama|aussicht|mirador|lookout/],
  ['Church', /eglise|church|kirche|chiesa|iglesia|cathedral|chapelle|chapel|kapelle|abbaye|abbey|monastere|kloster/],
  ['Store', /marche|market|markt|mercato|mercado|producteur|farmer/],
  ['Landmark', /village|visite|visit|museum|musee|museo|chateau|castle|schloss|castello|castillo|monument|old town|vieille ville|altstadt|centro storico|ruine|ruin/],
  ['ShoppingBag', /courses|supermarket|supermarche|grocer|epicerie|boulangerie|bakery|shop|alimentari|lebensmittel|supermercado|spar\b|lidl|conad|coop/],
  ['Coffee', /cafe|coffee|\bbar\b|pause|break|rast/],
  ['Car', /carburant|fuel|petrol|gas station|station[- ]service|tankstelle|distributore|benzin|gasolinera|parking|parcheggio|parkplatz|peage|toll|maut|pedaggio/],
  ['Cross', /sante|health|veterinaire|\bvet\b|pharmacie|pharmacy|apotheke|farmacia|hopital|hospital|medecin|doctor/],
  ['Waves', /\beau\b|water|wasser|acqua|agua|vidange|dump station|\bwc\b|toilet|douche|shower/],
  ['Ticket', /activite|activity|event|evenement|festival|concert|spectacle|show|aktivit|attivita|actividad/],
];

/** The icons a map marker may carry: TREK draws these and nothing else. */
const MARKER_ICONS = new Set([...Object.values(NIGHT_PICTOGRAM), ...ACTIVITY_PICTOGRAM.map(([icon]) => icon), 'MapPin']);

/** Pictogram of a planned stop: a night by its ground, an activity by what it is (category first). */
function pictogramFor(place, { night = false } = {}) {
  const cat = norm(place.categoryName);
  const name = norm(place.name);
  if (night) {
    if (HOTEL.test(cat) || HOTEL.test(name)) return NIGHT_PICTOGRAM.hotel;
    return NIGHT_PICTOGRAM[nightKind(place.categoryName, place.name)] || NIGHT_PICTOGRAM.unknown;
  }
  for (const text of [cat, name]) {
    for (const [icon, re] of ACTIVITY_PICTOGRAM) if (re.test(text)) return icon;
  }
  if (RE.shop.test(cat)) return 'ShoppingBag';
  return 'MapPin';
}

/**
 * Look of a planned stop on the map: { tone, icon }. `status` is the night's booking state
 * (booked | contacted | dropped | spotted), absent for an activity.
 */
function markerStyle(place, { night = false, status = null } = {}) {
  const tone = night ? (status === 'spotted' || !status ? TONE.spotted : TONE[status] || TONE.spotted) : TONE.planned;
  return { tone, icon: pictogramFor(place, { night }) };
}

module.exports = { TONE, NIGHT_STATUS, AMENITY_ICONS, CHIP, NIGHT_PICTOGRAM, ACTIVITY_PICTOGRAM, MARKER_ICONS, pictogramFor, markerStyle };
