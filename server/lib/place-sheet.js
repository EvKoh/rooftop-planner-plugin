'use strict';
// The place's sheet: what its description and notes say, read into typed fields, so every
// place of a kind shows the same sections in the same order instead of a block of text.
//
// Notes are written as "Key : value" lines (imported sheets, the assistant, the user), with
// bullet lines under a key for lists ("Itinéraire : • … • …"), in any language. This module
// reads them; it stores nothing: TREK's description and notes stay the only copy, and an edit
// of a field rewrites its line in the notes (setField). Nothing is dropped: a line it cannot
// classify is kept as an "other note", free text as text.
const { norm } = require('./util');
const { isNightCategory, isHike } = require('./classify');
const { t, locale } = require('./i18n');
const design = require('./design');

/**
 * Every field the sheet knows: its type and the key wordings that name it (accent-free,
 * lowercase; English, French, Italian, German, Spanish). A wording ending in "*" matches
 * any key starting with it.
 *   number: { value, text }   duration: { minutes, text }   url: { url, text }
 *   list: { items, text }     text: { text }   (+ grade, kind or allowed for some)
 */
const FIELDS = {
  distance_km: ['number', 'distance', 'distance aller retour', 'distance aller-retour', 'longueur', 'length', 'laenge', 'lange', 'strecke', 'streckenlaenge', 'distanza', 'lunghezza', 'distancia', 'longitud'],
  ascent_m: ['number', 'd+', 'denivele positif', 'denivele', 'denivellation', 'ascent', 'elevation gain', 'climb', 'total ascent', 'aufstieg', 'hoehenmeter', 'hohenmeter', 'hm', 'salita', 'dislivello', 'dislivello positivo', 'desnivel', 'desnivel positivo'],
  descent_m: ['number', 'd-', 'denivele negatif', 'descent', 'total descent', 'abstieg', 'discesa', 'dislivello negativo', 'desnivel negativo', 'bajada'],
  duration: ['duration', 'duree', 'duree conseillee', 'duree de visite', 'temps', 'temps de marche', 'time', 'walking time', 'hiking time', 'visit duration', 'dauer', 'gehzeit', 'wanderzeit', 'durata', 'tempo', 'tempo di percorrenza', 'duracion', 'tiempo'],
  level: ['level', 'niveau', 'difficulte', 'difficulty', 'grade', 'schwierigkeit', 'schwierigkeitsgrad', 'difficolta', 'livello', 'dificultad', 'nivel'],
  route_type: ['route', 'type de parcours', 'parcours', 'route type', 'tour type', 'tourtyp', 'tipo di percorso', 'tipo de ruta', 'boucle'],
  alt_max_m: ['number', 'altitude max', 'altitude maximale', 'altitude maxi', 'point haut', 'point culminant', 'max altitude', 'maximum altitude', 'highest point', 'hoechster punkt', 'hochster punkt', 'maximale hoehe', 'quota massima', 'altitudine massima', 'punto piu alto', 'altitud maxima', 'punto mas alto'],
  alt_min_m: ['number', 'altitude min', 'altitude minimale', 'altitude mini', 'point bas', 'min altitude', 'minimum altitude', 'lowest point', 'tiefster punkt', 'minimale hoehe', 'quota minima', 'altitudine minima', 'altitud minima'],
  altitude_m: ['number', 'altitude', 'elevation', 'hoehe', 'seehoehe', 'quota', 'altitudine', 'altitud'],
  start: ['depart', 'point de depart', 'start', 'starting point', 'trailhead', 'ausgangspunkt', 'startpunkt', 'partenza', 'punto di partenza', 'salida', 'punto de partida'],
  arrival: ['arrivee', 'arrival', 'finish', 'end point', 'check-in', 'check in', 'ankunft', 'ziel', 'endpunkt', 'arrivo', 'llegada'],
  parking: ['parking', 'car park', 'parking lot', 'parkplatz', 'parken', 'parcheggio', 'aparcamiento', 'estacionamiento'],
  transport: ['transports', 'transport', 'transports en commun', 'public transport', 'bus', 'navette', 'shuttle', 'oeffentliche verkehrsmittel', 'offentliche verkehrsmittel', 'anreise', 'mezzi pubblici', 'trasporti', 'transporte publico'],
  itinerary: ['list', 'itineraire', 'itineraire detaille', 'parcours detaille', 'itinerary', 'route description', 'the route', 'wegbeschreibung', 'wegverlauf', 'routenbeschreibung', 'itinerario', 'percorso', 'descrizione del percorso', 'recorrido'],
  conditions: ['statut', 'etat', 'etat du sentier', 'conditions', 'condition', 'status', 'trail status', 'trail conditions', 'zustand', 'wegzustand', 'condizioni', 'stato', 'estado', 'praticabilite'],
  closures: ['list', 'fermeture*', 'fermetures', 'saison*', 'closure*', 'closed', 'season*', 'sperrung*', 'chiusura*', 'stagione*', 'cierre*', 'temporada*'],
  best_time: ['meilleur moment', 'meilleure periode', 'meilleure saison', 'quand y aller', 'best time', 'best season', 'when to go', 'beste zeit', 'beste jahreszeit', 'periodo migliore', 'momento migliore', 'mejor momento', 'mejor epoca'],
  risk: ['risque', 'risques', 'danger', 'dangers', 'risk', 'risks', 'hazards', 'risiko', 'risiken', 'gefahren', 'rischio', 'rischi', 'pericoli', 'riesgo', 'riesgos', 'peligros'],
  vertigo: ['vertige', 'vertigo', 'exposure', 'head for heights', 'schwindel', 'schwindelfreiheit', 'trittsicherheit', 'vertigini', 'esposizione', 'vertigo'],
  marking: ['balisage', 'balises', 'signalisation', 'waymarking', 'markings', 'trail markers', 'markierung', 'beschilderung', 'segnaletica', 'segnavia', 'senalizacion'],
  water: ['eau', 'point d eau', 'water', 'drinking water', 'wasser', 'trinkwasser', 'acqua', 'agua'],
  supplies: ['ravitaillement', 'refuges', 'restauration', 'food', 'huts', 'refreshments', 'verpflegung', 'einkehr', 'huetten', 'ristoro', 'rifugi', 'avituallamiento'],
  dog: ['chien', 'chiens', 'avec un chien', 'animaux', 'dog', 'dogs', 'pets', 'with a dog', 'hund', 'hunde', 'mit hund', 'haustiere', 'cane', 'cani', 'animali', 'perro', 'perros', 'mascotas'],
  highlights: ['list', 'points forts', 'a voir', 'a ne pas manquer', 'highlights', 'highlight', 'must see', 'hoehepunkte', 'hohepunkte', 'punti salienti', 'punti forti', 'da non perdere', 'puntos destacados', 'imprescindible'],
  website: ['url', 'site officiel', 'site', 'site web', 'website', 'official site', 'official website', 'web', 'webseite', 'homepage', 'sito', 'sito ufficiale', 'sitio web', 'pagina'],
  map_url: ['url', 'carte', 'map', 'karte', 'mappa', 'carta', 'mapa', 'carte openstreetmap'],
  gpx_url: ['url', 'gpx', 'trace gpx', 'gpx track', 'track', 'gpx-track', 'traccia gpx', 'track gpx'],
  links: ['list', 'liens', 'lien', 'links', 'link', 'collegamenti', 'enlaces', 'webcam', 'webcams'],
  doubts: ['list', 'doutes', 'a verifier', 'incertitudes', 'doubts', 'to check', 'caveats', 'unsure', 'zweifel', 'zu pruefen', 'dubbi', 'da verificare', 'dudas', 'por verificar'],
  sources: ['list', 'sources', 'source', 'quellen', 'quelle', 'fonti', 'fonte', 'fuentes', 'fuente'],
  checked: ['verifie', 'verifie le', 'releve', 'controle', 'checked', 'verified', 'last checked', 'geprueft', 'gepruft', 'verificato', 'verificado'],
  price: ['prix', 'tarif', 'tarifs', 'cout', 'prix du stationnement', 'price', 'prices', 'rate', 'rates', 'cost', 'fee', 'preis', 'preise', 'kosten', 'gebuehr', 'prezzo', 'prezzi', 'costo', 'tariffa', 'tariffe', 'precio', 'precios', 'tarifa'],
  services_price: ['prix des services', 'services price', 'service fee', 'preis der dienstleistungen', 'prezzo dei servizi', 'precio de los servicios'],
  spots: ['number', 'places', 'emplacements', 'nombre de places', 'pitches', 'spots', 'stellplaetze', 'stellplatze', 'piazzole', 'posti', 'plazas'],
  type: ['type', 'typ', 'tipo', 'categorie', 'category', 'kategorie', 'categoria'],
  opening: ['ouverture', 'ouverture/fermeture', 'periode d ouverture', 'disponibilite', 'open', 'opening', 'opening period', 'open season', 'geoeffnet', 'geoffnet', 'oeffnungszeitraum', 'apertura', 'periodo di apertura', 'apertura stagionale', 'abierto', 'apertura'],
  hours: ['horaires', 'heures d ouverture', 'horaire', 'hours', 'opening hours', 'opening times', 'oeffnungszeiten', 'offnungszeiten', 'orari', 'orario', 'orari di apertura', 'horario', 'horarios'],
  booking: ['reservation', 'reserver', 'reservations', 'booking', 'book', 'bookings', 'buchung', 'reservierung', 'prenotazione', 'prenotare', 'reserva', 'reservar'],
  rooftop_tent: ['tente de toit', 'rooftop tent', 'roof tent', 'roof-top tent', 'dachzelt', 'tenda da tetto', 'tenda sul tetto', 'tienda de techo'],
  services: ['list', 'services', 'equipements', 'services et equipements', 'pratique', 'facilities', 'amenities', 'services and facilities', 'ausstattung', 'einrichtungen', 'service', 'servizi', 'dotazioni', 'servicios', 'equipamiento'],
  electricity: ['electricite', 'electricity', 'power', 'hook-up', 'strom', 'elettricita', 'corrente', 'electricidad'],
  access: ['acces', 'acces en voiture', 'access', 'road access', 'getting there', 'zufahrt', 'anfahrt', 'zugang', 'accesso', 'come arrivare', 'acceso'],
  location: ['situation', 'localisation', 'emplacement', 'location', 'setting', 'lage', 'posizione', 'ubicacion', 'commune', 'municipality', 'gemeinde', 'comune', 'municipio'],
  address: ['adresse', 'address', 'anschrift', 'adresse postale', 'indirizzo', 'direccion'],
  reviews: ['avis', 'note', 'note google', 'reviews', 'review', 'rating', 'ratings', 'bewertung', 'bewertungen', 'recensioni', 'valutazione', 'resenas', 'valoracion', 'niveau de prix', 'price level'],
  contact: ['contact', 'contacts', 'kontakt', 'contatto', 'contatti', 'contacto'],
  rules: ['reglement', 'regles', 'rules', 'regulations', 'regeln', 'hausordnung', 'regolamento', 'regole', 'normas', 'reglamento'],
  fuel: ['carburant', 'carburants', 'fuel', 'kraftstoff', 'tanken', 'carburante', 'combustible'],
  photo: ['url', 'photo', 'photos', 'image', 'picture', 'foto', 'bild', 'immagine', 'imagen'],
};

const TYPES = new Set(['number', 'list', 'url']);
const typeOf = (k) => (TYPES.has(FIELDS[k][0]) ? FIELDS[k][0] : k === 'duration' ? 'duration' : 'text');
const aliasesOf = (k) => FIELDS[k].filter((a) => !TYPES.has(a));

// Month names (and "in October") at the end of a key say when, not what: "Statut en octobre".
const MONTHS = 'janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|january|february|march|april|may|june|july|august|september|october|november|december|januar|februar|maerz|marz|juni|juli|oktober|dezember|gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|dicembre|enero|febrero|abril|mayo|junio|julio|septiembre|octubre|noviembre|diciembre';
const WHEN = new RegExp(`\\s+(?:(?:en|in|im|a|ad|di|nel|del|de|en el)\\s+)?(?:${MONTHS})\\b.*$`);

/** The form a key is matched in: no accents, no unit, no year, no month, single spaces. */
function keyForm(raw) {
  return norm(raw)
    .replace(/[−–—]/g, '-')
    .replace(/[’'`]/g, ' ')
    .replace(/\(([^)]*)\)/g, ' ')
    .replace(/\b(19|20)\d\d\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(WHEN, '')
    .replace(/\s*[:.]+$/, '')
    .trim();
}

const EXACT = new Map();
const PREFIX = [];
for (const k of Object.keys(FIELDS)) {
  for (const a of aliasesOf(k)) {
    if (a.endsWith('*')) PREFIX.push([a.slice(0, -1), k]);
    else if (!EXACT.has(a)) EXACT.set(a, k);
  }
}

/** The field a written key names, or null. */
function fieldOf(rawKey) {
  const f = keyForm(rawKey);
  if (!f) return null;
  if (EXACT.has(f)) return EXACT.get(f);
  for (const [p, k] of PREFIX) if (f.startsWith(p)) return k;
  return null;
}

const URL_RE = /https?:\/\/[^\s<>"'|]+/g;
/** URLs in a text; a closing bracket or stop at the end is the sentence's, unless opened in the URL. */
const urlsIn = (s) => (String(s || '').match(URL_RE) || []).map((u) => {
  let x = u.replace(/[.,;:]+$/, '');
  while (/[)\]]$/.test(x) && (x.split(x.endsWith(')') ? '(' : '[').length <= x.split(x.endsWith(')') ? ')' : ']').length - 1)) x = x.slice(0, -1).replace(/[.,;:]+$/, '');
  return x;
});
const BULLET = /^\s*(?:[•●▪◦*]|-(?=\s)|–(?=\s)|\d+[.)](?=\s))\s*/;
const SEPARATOR = /^[-—–=_\s]*(?:suite des notes|continued|fortsetzung|continua|continuacion)?[-—–=_\s]*$/i;

/** A "Key : value" line: [key, value] or null (a time "10:30", a URL, a sentence are not keys). */
function splitKey(line) {
  const m = line.match(/^([^:\n]{1,48}?)\s*:(?:\s+(.*)|\s*)$/);
  if (!m) return null;
  const key = m[1].trim();
  if (!key || /https?$|\/\//.test(key) || /^\d+([.,]\d+)?$/.test(key) || key.split(/\s+/).length > 7) return null;
  return [key, (m[2] || '').trim()];
}

/**
 * Lines of a text, as entries: { key, field, value, items } for keyed lines (bullets under a
 * key are its items), { text } for free lines. A blank line closes the open key.
 */
function lines(text) {
  const out = [];
  let open = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const t = rawLine.trim();
    if (!t) { open = null; continue; }
    if (SEPARATOR.test(t) && /[-—–=_]{1,}/.test(t)) { open = null; continue; }
    const bullet = BULLET.test(t);
    const body = t.replace(BULLET, '');
    if (bullet && open) { open.items.push(body); continue; }
    const kv = splitKey(body);
    if (kv) {
      const [key, value] = kv;
      open = { key, field: fieldOf(key), value: '', items: [] };
      // "Itinéraire : • A • B" on one line.
      const inline = value.split(/\s+•\s+|^•\s*/).map((x) => x.trim()).filter(Boolean);
      if (/^•/.test(value) || inline.length > 1) open.items.push(...inline); else open.value = value;
      out.push(open);
      continue;
    }
    open = null;
    out.push({ text: body, bullet });
  }
  return out;
}

const num = (s) => {
  const m = String(s || '').replace(/(\d)[\s  ](?=\d{3}\b)/g, '$1').match(/-?\d+(?:[.,]\d+)?/);
  return m ? Number(m[0].replace(',', '.')) : null;
};

/** "4 h 10", "0 h 51 (…)", "2h30", "90 min", "1.5 h" → minutes. */
function minutesOf(s) {
  const t = norm(s);
  let m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hours?|heures?|std|stunden?|ore|horas?)(?![a-z])\s*(?:(\d{1,2})\s*(?:min|mn|m\b)?)?/);
  if (m) return Math.round(Number(m[1].replace(',', '.')) * 60 + (m[2] ? Number(m[2]) : 0));
  m = t.match(/(\d+)\s*(?:min|mn|minutes?|minuten|minuti|minutos)\b/);
  if (m) return Number(m[1]);
  m = t.match(/\b(\d{1,2}):(\d{2})\b/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const GRADES = [
  ['hard', /\b(difficile|tres difficile|difficult|hard|demanding|strenuous|schwer|schwierig|anspruchsvoll|impegnativ\w*|dificil|exigente|expert)\b/],
  ['medium', /\b(moyen|moyenne|intermediate|medium|moderate|mittel|mittelschwer|medio|media|moderato|moderada|intermedi\w*)\b/],
  ['easy', /\b(facile|tres facile|easy|leicht|einfach|semplice|facil|sencillo)\b/],
];
const gradeOf = (s) => { const t = norm(s); const g = GRADES.find(([, re]) => re.test(t)); return g ? g[0] : null; };

const ROUTE_KINDS = [
  ['loop', /\b(boucle|loop|circular|circuit|round ?trip|rundweg|rundwanderung|runde|rundtour|anello|ad anello|giro ad anello|circolare|circular)\b/],
  ['out_and_back', /\b(aller-? ?retour|out and back|out-and-back|there and back|hin und zurueck|hin und zuruck|andata e ritorno|ida y vuelta)\b/],
  ['one_way', /\b(aller simple|one way|one-way|point to point|traversee|linear|streckenwanderung|strecke|solo andata|traversata|lineal|solo ida)\b/],
];
const routeKindOf = (s) => { const t = norm(s); const r = ROUTE_KINDS.find(([, re]) => re.test(t)); return r ? r[0] : null; };

const DOG_NO = /\b(non admis|interdit|pas admis|refuse|not allowed|no dogs|forbidden|prohibited|verboten|nicht erlaubt|vietato|non ammess\w*|prohibido|no se admiten|no permitido)\b/;
const DOG_YES = /\b(admis|bienvenu\w*|accepte\w*|autorise\w*|allowed|welcome|accepted|ok|oui|yes|erlaubt|willkommen|ammess\w*|benvenut\w*|consentit\w*|si|ja|permitid\w*|admitid\w*|bienvenid\w*)\b/;
const dogOf = (s) => { const t = norm(s); return DOG_NO.test(t) ? false : DOG_YES.test(t) ? true : null; };

/** "Itinéraire : A, B, C, D" with no bullets → steps, when it reads as a list of 3 or more. */
function stepsOf(value) {
  const byArrow = value.split(/\s*(?:→|->|➜|—>)\s*/).filter(Boolean);
  if (byArrow.length >= 3) return byArrow;
  const byComma = value.split(/\s*[,;]\s+/).filter(Boolean);
  return byComma.length >= 3 && byComma.every((x) => x.length <= 80) ? byComma : null;
}

/** The typed value of one field from its written value and items. */
function typed(field, value, items) {
  const text = [value, ...items.map((i) => `• ${i}`)].filter(Boolean).join('\n');
  const type = typeOf(field);
  if (type === 'number') return { value: num(value || items[0]), text };
  if (type === 'duration') return { minutes: minutesOf(value || items[0]), text };
  if (type === 'url') { const u = urlsIn(text)[0] || null; return { url: u, text }; }
  if (type === 'list') {
    let list = items.slice();
    if (value) {
      const parts = field === 'sources' ? value.split(/\s+\|\s+/) : field === 'itinerary' ? stepsOf(value) || [value] : [value];
      list = [...parts, ...list];
    }
    return { items: list.map((x) => x.trim()).filter(Boolean), text };
  }
  const out = { text };
  if (field === 'level') out.grade = gradeOf(text);
  if (field === 'route_type') out.kind = routeKindOf(text);
  if (field === 'dog') out.allowed = dogOf(text);
  return out;
}

/** The kind of sheet a place gets: 'night' | 'hike' | 'activity'. */
function kindOf(place, { night = false } = {}) {
  const cat = (place && (place.categoryName || place.category_name)) || '';
  if (night || isNightCategory(cat)) return 'night';
  if (isHike(cat)) return 'hike';
  return 'activity';
}

// "10.93 km · +770 m · 4 h 10": the one-line summary an imported hike starts with.
const SUMMARY = /^(\d+(?:[.,]\d+)?)\s*km\s*[·•|,]\s*\+\s*(\d[\d\s ]*)\s*m(?:\s*[·•|,]\s*(.+))?$/i;

/**
 * Read a place's description and notes into its sheet:
 *   { kind, fields: { name: typed }, other: [{ label, text }], about: [description prose],
 *     text: [free lines of the notes] }
 * Notes are read first (they are the record); a description line already said in the notes
 * is not repeated. A key written twice keeps both values.
 */
function parse(description, notes, { kind = 'activity' } = {}) {
  const fields = {};
  const other = [];
  const text = [];
  const said = new Set();
  const sig = (s) => norm(s).replace(BULLET, '').replace(/\s+/g, ' ').trim();
  const keep = (label, value, items) => other.push({ label, text: [value, ...items.map((i) => `• ${i}`)].filter(Boolean).join('\n') });
  const add = (field, value, items, label) => {
    let f = field;
    // "Type : boucle" on a hike is the route's shape; "Type : camping" is the place's type.
    if (f === 'type' && routeKindOf(value)) f = 'route_type';
    if (f === 'route_type' && !routeKindOf([value, ...items].join(' '))) { keep(label, value, items); return; }
    const prev = fields[f];
    if (!prev) { fields[f] = { value, items }; return; }
    if (sig(prev.value) === sig(value) && !items.length) return;
    // Same key twice: one more value, kept as a list item, never lost.
    if (value && sig(prev.value) !== sig(value)) prev.items.push(value);
    for (const i of items) if (!prev.items.some((x) => sig(x) === sig(i))) prev.items.push(i);
  };
  const seen = new Set();
  let afterSummary = false;
  const read = (src, fromNotes) => {
    afterSummary = false;
    for (const e of lines(src)) {
      if (e.text !== undefined) {
        const s = sig(e.text);
        if (said.has(s) || seen.has(s)) continue;
        if (fromNotes) said.add(s); else seen.add(s);
        // Bullets right under an imported hike's summary line are its highlights.
        if (afterSummary && e.bullet) { add('highlights', '', [e.text], 'highlights'); continue; }
        afterSummary = false;
        const m = kind === 'hike' && e.text.match(SUMMARY);
        if (m) {
          afterSummary = true;
          if (!fields.distance_km) add('distance_km', m[1], []);
          if (!fields.ascent_m) add('ascent_m', m[2], []);
          if (m[3] && !fields.duration) add('duration', m[3], []);
          continue;
        }
        if (!text.some((x) => sig(x.text) === s)) text.push({ text: e.text, from: fromNotes ? 'notes' : 'description' });
        continue;
      }
      afterSummary = false;
      const lineSig = sig(`${e.key} : ${e.value}`);
      const items = fromNotes ? e.items : e.items.filter((i) => !said.has(sig(i)));
      if (!fromNotes && said.has(lineSig) && !items.length) continue;
      if (fromNotes) { said.add(lineSig); e.items.forEach((i) => said.add(sig(i))); }
      if (e.field) add(e.field, e.value, items, e.key);
      else keep(e.key, e.value, items);
    }
  };
  read(notes, true);
  read(description, false);
  const out = {};
  for (const [f, v] of Object.entries(fields)) out[f] = typed(f, v.value, v.items);
  // A free line that is the same as a field's items (a highlight repeated as prose) goes.
  const known = new Set(Object.values(out).flatMap((v) => (v.items || []).map(sig)));
  const free = text.filter((x) => !known.has(sig(x.text)));
  // Prose of the description says what the place is; free lines of the notes are other notes.
  return {
    kind, fields: out, other,
    about: free.filter((x) => x.from === 'description').map((x) => x.text),
    text: free.filter((x) => x.from === 'notes').map((x) => x.text),
  };
}

/** The sheet of a TREK place (its raw row or the model's), with its kind. */
function sheetOf(place, { night = false } = {}) {
  const raw = (place && place.raw) || place || {};
  const kind = kindOf(place, { night });
  const sheet = parse(raw.description ?? place.description, raw.notes ?? place.notes, { kind });
  // TREK's own website field is the reference page when the notes give none.
  if (!sheet.fields.website && raw.website && /^https?:\/\//i.test(raw.website)) sheet.fields.website = { url: raw.website, text: raw.website, fromTrek: true };
  return sheet;
}

/** The sections of a kind of sheet, in their fixed order, with the fields each one shows. */
const SECTIONS = {
  hike: [
    ['figures', ['distance_km', 'ascent_m', 'descent_m', 'duration', 'level', 'route_type', 'alt_max_m', 'alt_min_m', 'altitude_m']],
    ['start', ['start', 'parking', 'transport', 'arrival', 'access']],
    ['itinerary', ['itinerary']],
    ['conditions', ['conditions', 'closures', 'best_time', 'risk', 'vertigo', 'marking', 'water', 'supplies', 'dog', 'opening', 'hours']],
    ['highlights', ['highlights']],
    ['links', ['website', 'map_url', 'gpx_url', 'links', 'photo']],
  ],
  night: [
    ['figures', ['price', 'services_price', 'spots', 'altitude_m']],
    ['stay', ['type', 'opening', 'hours', 'arrival', 'booking', 'rooftop_tent', 'dog', 'rules', 'closures']],
    ['services', ['services', 'electricity', 'water', 'fuel', 'supplies']],
    ['access', ['access', 'location', 'address', 'parking', 'transport']],
    ['reviews', ['reviews']],
    ['links', ['website', 'map_url', 'links', 'photo']],
  ],
  activity: [
    ['figures', ['duration', 'price', 'level', 'distance_km', 'ascent_m', 'altitude_m']],
    ['visit', ['type', 'hours', 'opening', 'closures', 'booking', 'best_time', 'dog', 'rules', 'conditions', 'risk']],
    ['access', ['access', 'start', 'parking', 'transport', 'location', 'address']],
    ['highlights', ['highlights', 'itinerary', 'services', 'supplies', 'water']],
    ['links', ['website', 'map_url', 'gpx_url', 'links', 'photo']],
  ],
};
/** Last, on every kind: what was checked and where it comes from, then the rest. */
const TAIL = ['doubts', 'sources', 'checked', 'contact'];


const FIGURE_FIELDS = new Set(['distance_km', 'ascent_m', 'descent_m', 'duration', 'level', 'route_type', 'alt_max_m', 'alt_min_m', 'altitude_m', 'price', 'services_price', 'spots']);

/** "4 h 10", "51 min". */
function durationText(min) {
  if (min == null) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} h${m ? ` ${String(m).padStart(2, '0')}` : ''}` : `${m} min`;
}

/** The short value a key figure shows ("10.9 km", "+770 m", "Medium"); its full text stays the title. */
function figure(field, v, L) {
  const n = (x, d = 0) => new Intl.NumberFormat(locale(L), { maximumFractionDigits: d }).format(x);
  if (field === 'distance_km' && v.value != null) return `${n(v.value, 1)} km`;
  if (field === 'ascent_m' && v.value != null) return `+${n(v.value)} m`;
  if (field === 'descent_m' && v.value != null) return `−${n(Math.abs(v.value))} m`;
  if (/^alt/.test(field) && v.value != null) return `${n(v.value)} m`;
  if (field === 'spots' && v.value != null) return n(v.value);
  if (field === 'duration' && v.minutes != null) return durationText(v.minutes);
  if (field === 'level' && v.grade) return t(L, `sh.v.${v.grade}`);
  if (field === 'route_type' && v.kind) return t(L, `sh.v.${v.kind}`);
  // A price: its leading amount and unit ("44,60 €/nuit"), the rest stays its detail.
  if ((field === 'price' || field === 'services_price') && v.text) {
    const m = v.text.match(/^[^\n—(;]*?(?:\d[\d.,  ]*\s?(?:€|eur|chf|\$|£|kr)|(?:€|\$|£)\s?\d[\d.,]*)[^\n—(;,]*/i);
    const lead = m ? m[0].trim().replace(/[.:]$/, '') : null;
    return lead && lead.length <= 28 ? lead : null;
  }
  return null;
}

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

/** One row of the card: label, pictogram, colour, and the value as text, items or a link. */
function row(field, v, L) {
  const tone = design.sheetTone(field, v);
  const out = { field, label: t(L, `sh.f.${field}`), icon: design.svgOf(design.SHEET_ICONS[field]), color: design.TONE_COLOR[tone], tone };
  const short = figure(field, v, L);
  if (short) out.figure = short;
  // A price says more than its amount (what it includes, the source): kept as its detail.
  if (short && (field === 'price' || field === 'services_price') && v.text.length > short.length + 8) out.detail = v.text;
  if (field === 'dog' && v.allowed != null) out.chip = t(L, v.allowed ? 'sh.v.dogYes' : 'sh.v.dogNo');
  if (v.url) { out.url = v.url; out.linkText = host(v.url); }
  if (v.items && v.items.length) out.items = v.items;
  if (field === 'links' || field === 'sources') out.links = (v.items || []).map((i) => urlsIn(i)[0]).filter(Boolean);
  out.text = v.text || '';
  return out;
}

/**
 * The card of a sheet, in the reader's language: fixed sections for its kind, each with the
 * rows it has (an empty section is left out), then "more" (doubts, sources, checks, any
 * field outside the kind's sections) and "other" (unclassified keys and free notes).
 * opts.trackUrl: the hike's track page (walks.hikeUrl), the reference link when known.
 */
function view(sheet, L, { trackUrl = null } = {}) {
  const f = { ...sheet.fields };
  if (trackUrl && (!f.website || f.website.fromTrek)) f.website = { url: trackUrl, text: trackUrl };
  const used = new Set();
  const sections = [];
  for (const [id, names] of SECTIONS[sheet.kind] || SECTIONS.activity) {
    const rows = names.filter((n) => f[n] && (f[n].text || f[n].url || (f[n].items && f[n].items.length))).map((n) => { used.add(n); return row(n, f[n], L); });
    const title = t(L, `sh.s.${id}`);
    // A row named like its section says it once.
    for (const r of rows) if (r.label === title) r.label = '';
    if (rows.length) sections.push({ id, title, rows, figures: id === 'figures' });
  }
  const more = [...TAIL, ...Object.keys(f)].filter((n, i, a) => a.indexOf(n) === i && !used.has(n) && f[n] && (f[n].text || f[n].url))
    .map((n) => row(n, f[n], L));
  if (more.length) sections.push({ id: 'more', title: t(L, 'sh.s.more'), rows: more, folded: true });
  const other = [
    ...sheet.other.map((o) => ({ field: 'other', label: o.label, icon: design.svgOf(design.SHEET_ICONS.other), color: design.TONE_COLOR.default, text: o.text })),
    ...sheet.text.map((x) => ({ field: 'other', label: '', icon: design.svgOf(design.SHEET_ICONS.other), color: design.TONE_COLOR.default, text: x })),
  ];
  if (other.length) sections.push({ id: 'other', title: t(L, 'sh.s.other'), rows: other, folded: true });
  return { kind: sheet.kind, title: t(L, `sh.k.${sheet.kind}`), about: sheet.about, sections };
}

/**
 * Write one field into a place's texts, where it is kept: its "Key : value" line (and the
 * bullets under it) is replaced, in the notes, or moved there from the description; a new
 * field is appended to the notes with its label in the reader's language. value null (or
 * an empty list) removes it. Returns { description, notes } as they must be saved.
 */
function setField(description, notes, field, value, L = 'en') {
  if (!FIELDS[field]) throw new Error(`unknown sheet field "${field}"; one of: ${Object.keys(FIELDS).join(', ')}`);
  const strip = (text) => {
    const out = [];
    let at = -1;
    let label = null;
    let inField = false;
    for (const line of String(text || '').split(/\r?\n/)) {
      const tt = line.trim();
      if (inField && tt && BULLET.test(tt)) continue;
      inField = false;
      const kv = tt && !BULLET.test(tt) ? splitKey(tt) : null;
      if (kv && fieldOf(kv[0]) === field) {
        if (at < 0) { at = out.length; label = kv[0]; }
        inField = true;
        continue;
      }
      out.push(line);
    }
    return { lines: out, at, label };
  };
  const n = strip(notes);
  const d = strip(description);
  // A text of several lines is a list: one item per line.
  if (typeof value === 'string' && value.includes('\n')) value = value.split(/\r?\n/).map((x) => x.replace(BULLET, '').trim()).filter(Boolean);
  const empty = value == null || value === '' || (Array.isArray(value) && !value.length);
  const label = n.label || d.label || t(L, `sh.f.${field}`);
  const block = empty ? [] : Array.isArray(value)
    ? [`${label} :`, ...value.map((v) => `• ${String(v).trim()}`)]
    : [`${label} : ${String(value).trim()}`];
  const lines = n.lines.slice();
  if (block.length) {
    if (n.at >= 0) lines.splice(n.at, 0, ...block);
    else { while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); lines.push(...block); }
  }
  return {
    description: d.at >= 0 ? d.lines.join('\n') : description ?? '',
    notes: lines.join('\n'),
  };
}

module.exports = {
  FIELDS, SECTIONS, TAIL, FIELD_NAMES: Object.keys(FIELDS),
  typeOf, aliasesOf, keyForm, fieldOf, splitKey, lines, minutesOf, gradeOf, routeKindOf, dogOf, urlsIn,
  parse, sheetOf, kindOf, view, setField, durationText, FIGURE_FIELDS,
};
