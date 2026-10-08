'use strict';
const { LOCALES } = require('./i18n');
// The travel rules, as pure functions over text and numbers (no TREK, no network), so each
// one is unit-tested on its own. Ported from a planning checker used on a real trip and
// kept because each rule caught a real mistake:
//  - arrive at the night >= `sunset_margin_min` before sunset (unfold the tent in daylight);
//  - never arrive somewhere closed (weekly closure, opening hours, check-in window,
//    minimum stay);
//  - a rooftop tent only on a campsite or a farm; a motorhome area is blocking; a farm in a
//    zone with local restrictions (protected areas, municipal rules) is a point to check;
//  - nights without water in a row need a refill plan; shopping detours stay short.
const { norm, hm } = require('./util');
const { nightKind, categoryKind } = require('./classify');
const { zoneAt } = require('./zones');

// Weekday names, accent-stripped, Sunday first: the four languages hosts write most in
// Europe, plus every language TREK ships, from the runtime's own calendar data, so a note
// written anywhere in the world is read.
const BASE_WEEKDAYS = [
  ['dimanche', 'domenica', 'sonntag', 'sunday'], ['lundi', 'lunedi', 'montag', 'monday'],
  ['mardi', 'martedi', 'dienstag', 'tuesday'], ['mercredi', 'mercoledi', 'mittwoch', 'wednesday'],
  ['jeudi', 'giovedi', 'donnerstag', 'thursday'], ['vendredi', 'venerdi', 'freitag', 'friday'],
  ['samedi', 'sabato', 'samstag', 'saturday'],
];
const WEEKDAYS = BASE_WEEKDAYS.map((names, wd) => {
  const out = new Set(names);
  for (const loc of Object.values(LOCALES)) {
    try {
      // 2026-10-04 is a Sunday: + wd days gives that weekday.
      const d = new Date(Date.UTC(2026, 9, 4 + wd, 12));
      const name = norm(new Intl.DateTimeFormat(loc, { weekday: 'long', timeZone: 'UTC' }).format(d)).trim();
      if (name.length >= 2) out.add(name);
    } catch { /* a runtime without that locale keeps the base names */ }
  }
  return [...out];
});
// "Closed", accent-stripped, in the languages hosts write in.
const CLOSED = ['ferme', 'fermee', 'closed', 'chiuso', 'geschlossen', 'cerrado', 'fechado', 'gesloten', 'zamkniete', 'zamkniety',
  'zavreno', 'zatvorene', 'stangt', 'tancat', 'zarva', 'kapali', 'suljettu', 'lukk', 'закрыто', 'зачинено', 'κλειστο', 'مغلق',
  '定休', '休業', '休息', '휴무', 'dong cua', 'tutup', 'ปิด'];
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const B = '(?<![\\p{L}\\p{N}])'; // word edges that also hold for non-Latin scripts
const E = '(?![\\p{L}\\p{N}])';
const CLOSED_RE = `(?:${CLOSED.map(esc).join('|')})`;
const NEIGHBOUR = /(restaurant|bar|cafe|baita|rifugio|refuge|hotel|chalet|bistro|pizzeria|trattoria)/;
const quote = (tn, i, before = 60, after = 40) => tn.slice(Math.max(0, i - before), i + after).replace(/\s+/g, ' ').trim();

/**
 * Closures of a stop on weekday `wd`, read from its notes. Returns findings
 * [{ key, level, params }] where key ∈ closure_cited | closure_neighbour | outside_hours.
 * `from`/`to` are the visit's minutes; `isNight` silences the generic closure warning
 * (a campsite "closed on Monday" usually means its restaurant).
 */
function closures(text, wd, from, to, { placeName = '', isNight = false } = {}) {
  const out = [];
  const tn = norm(text);
  for (const day of WEEKDAYS[wd]) {
    // "fermé le lundi", "closed on Monday", "cerrado los lunes", "Montag Ruhetag", "lundi : fermé",
    // "понедельник — закрыто".
    const d = esc(day);
    const re = new RegExp(`${CLOSED_RE}\\s+(?:\\p{L}{1,4}\\s+)?${d}s?${E}|${B}${d}s?\\s*[:–—-]?\\s*${CLOSED_RE}|${B}${d}( und \\p{L}+)? ruhetag`, 'u');
    const i = tn.search(re);
    if (i >= 0) {
      const neighbour = new RegExp(`${NEIGHBOUR.source}\\b[^.;]*$`).test(tn.slice(Math.max(0, i - 70), i)) && !NEIGHBOUR.test(norm(placeName));
      if (neighbour) out.push({ key: 'closure_neighbour', level: 'info', params: { quote: quote(tn, i, 50, 25) } });
      else if (!isNight) out.push({ key: 'closure_cited', level: 'verify', params: { quote: quote(tn, i) } });
    }
    // "Monday : 8h00–21h00", "lundi : 9:00-12:00 / 14:00-19:00": every range of the day counts
    // (windowsIn, the one time-range reader). Hours quoted from free notes are a point to verify,
    // never a block, and a neighbour's hours ("Pizzeria — lundi : 19h-22h") are only info.
    const h = new RegExp(`\\b${day}\\s*:\\s*([^\\n]*)`).exec(tn);
    const ranges = h ? windowsIn(h[1]) : [];
    if (ranges.length && from != null && !ranges.some(([o, c]) => from >= o && (to ?? from) <= c)) {
      const neighbour = new RegExp(`${NEIGHBOUR.source}\\b[^.;\\n]*$`).test(tn.slice(Math.max(0, h.index - 70), h.index)) && !NEIGHBOUR.test(norm(placeName));
      const [open, close] = ranges[0];
      out.push({ key: neighbour ? 'closure_neighbour' : 'outside_hours', level: neighbour ? 'info' : 'verify', params: neighbour ? { quote: quote(tn, h.index, 50, 40) } : { open, close, ranges } });
    }
  }
  return out;
}

/** Check-in window "Arrival: 15h–23h" / "Arrivée : 15:00-22:00" → [open, close] minutes, or null. */
/**
 * The arrival windows a value states, in minutes: "15h–23h", "14:00-20:00", "8h-12h / 14h-20h",
 * "14 h - 16 h 30". Strict: the value must START with a window, and each time needs its "h"
 * or ":" — "self check-in, code sent 1-2 days before" or "by the D12 – 3 km" is no window.
 * [] when there is none. The one window reader of the plugin (notes and sheet alike).
 */
function windowsIn(value) {
  const T = '(\\d{1,2})\\s*(?:h|:)\\s*(\\d{2})?';
  const one = new RegExp(`^\\s*(?:de |from |dalle |von |des )?${T}\\s*(?:[–-]|a |to |alle |bis )\\s*${T}`);
  const out = [];
  let rest = norm(value);
  for (let guard = 0; guard < 4; guard++) {
    const m = rest.match(one);
    if (!m) break;
    const from = +m[1] * 60 + +(m[2] || 0);
    const to = +m[3] * 60 + +(m[4] || 0);
    if (from < 24 * 60 && to <= 24 * 60 && to > from) out.push([from, to]);
    rest = rest.slice(m[0].length).replace(/^\s*(?:[/,;+&]|et|and|und|e|y)\s*/, '');
  }
  return out;
}

/** The arrival windows the notes quote ("Arrivée : 15h–23h"), from the label on. */
function welcomeWindows(text) {
  // Every labelled line: "Arrivée : by the D12" then "Check-in : 15h-20h" — the second counts.
  // The label must open its line (a bullet aside): "Pas d'arrivée : 12h-14h" or "Late arrival:
  // 22h-23h" are not the check-in window.
  return [...norm(text).matchAll(/(?:^|\n)\s*(?:[•*-]\s*)?(?:arrivee|arrival|check-?in|arrivo|anreise|ankunft|llegada)\s*:\s*([^\n]*)/g)].flatMap((m) => windowsIn(m[1]));
}

/** The first arrival window of the notes, or null. */
function welcomeWindow(text) {
  return welcomeWindows(text)[0] || null;
}

/** Minimum stay quoted in the notes ("2 nights minimum", "mindestens 2 Nächte"), or null. */
function minNights(text) {
  const t = norm(text);
  if (/1 nuit acceptee|une nuit acceptee|one night (is )?(ok|fine|possible|accepted)/.test(t)) return null;
  const m = t.match(/(\d) nuits? minimum|minimum (\d) nuits?|minimum (?:stay )?(?:of )?(\d) nights?|(\d) nights? minimum|min(?:imum)?\.? ?(\d) n(?:ights?|uits?)\b|mindestens (\d) nacht|(\d) nachte? minimum|minimo (\d) nott/);
  if (!m) return null;
  return +(m.slice(1).find((x) => x != null)) || 2;
}

const NO_WATER = /aucun sanitaire|pas d.eau|sans eau|no water|kein wasser|nessun servizio|senza acqua|pas de point d.eau|no facilities/;
const WATER_OK = /eau (et [^ ]+ )?sur demande|eau potable|eau (comprise|gratuite|incluse)|💧|water (on request|available|included)|drinking water|acqua potabile|trinkwasser/;
/** true when the notes say there is no water and nothing says water can be had. */
function noWater(text) {
  const t = norm(text);
  return NO_WATER.test(t) && !WATER_OK.test(t);
}

const BANNED = /(no camping|camping (interdit|prohibited|forbidden|not allowed)|campeggio vietato|vietato (il )?campeggi|vietato aprire (la )?(veranda|tendalino|tenda)|solo parcheggio|camping verboten|campieren verboten|zelten verboten|no tents?\b|tents?=no|tente de toit (refusee|interdite)|roof ?top tents? (not allowed|forbidden|refused)|comportement de camping interdit)/;
// "camping forbidden OUTSIDE campsites" states the local law, not a ban at this place
// (seen on a real campsite's notes: "camping interdit hors camping au Tyrol du Sud").
const LAW_NOT_BAN = /^[^.;]{0,12}\b(hors|outside|except|sauf|ausser|al di fuori|fuori)\b/;
// Words saying a motorhome area or car park is privately run (its operator decides who stays).
const PRIVATE_GROUND = /\b(privee?s?|private|privat\w*|privata|privato|camper ?park|wohnmobilpark)\b/;
const PUBLIC_GROUND = /\b(communale?|municipal\w*|comunale|gemeinde\w*|public|publique|pubblic\w*|offentlich\w*)\b/;
/** A quote proving tents/camping are banned at this place, or null. */
function tentBanned(text, tags = {}) {
  if (tags.tents === 'no') return 'tents=no';
  const t = norm(text);
  const re = new RegExp(BANNED.source, 'g');
  let m;
  while ((m = re.exec(t))) {
    if (!LAW_NOT_BAN.test(t.slice(m.index + m[0].length))) {
      // The whole line it sits on, never a word cut at its start.
      const from = t.lastIndexOf('\n', m.index) + 1;
      const to = t.indexOf('\n', m.index);
      return t.slice(from, to < 0 ? undefined : to).replace(/\s+/g, ' ').trim().slice(0, 140);
    }
  }
  return null;
}

/**
 * Is this night's ground legal for the traveller's vehicle? Returns a finding or null.
 *  - rooftop tent: opening the tent is camping. Campsite or farm only; a motorhome area or a
 *    car park is blocking; a farm in a zone with local restrictions is a point to check.
 *  - campervan / motorhome: sleeping inside without deploying anything is parking (Italy:
 *    Codice della strada art. 185), so a motorhome area is a valid night; a car park or a
 *    wild spot depends on the local rule (zone note), so it is a point to verify.
 */
function nightLegality({ categoryName, placeName, lat, lng, text = '', vehicle = 'rooftop_tent' }) {
  const kind = nightKind(categoryName, placeName);
  const zone = zoneAt(lat, lng);
  const zp = { zoneId: zone ? zone.id : null };
  if (vehicle === 'rooftop_tent') {
    // A private motorhome park is private ground: its operator may accept a rooftop tent,
    // so it is a point to confirm. A public (communal) area or car park stays blocking.
    if ((kind === 'aire' || kind === 'parking') && PRIVATE_GROUND.test(norm(`${placeName || ''} ${text}`)) && !PUBLIC_GROUND.test(norm(`${placeName || ''} ${text}`))) {
      return { key: 'night_private', level: 'verify', params: {}, kind };
    }
    // Blocking when the category says so (the user's own filing); guessed from the name only, a
    // point to verify.
    if (kind === 'aire' || kind === 'parking') return { key: 'night_aire', level: categoryKind(categoryName) ? 'blocking' : 'verify', params: {}, kind };
    const authorised = /autoris|authori[sz]ed|agricampeggio|campingplatz|licen[cs]ed/.test(norm(text));
    if (kind === 'farm' && zone && zone.farm === 'check' && !authorised) {
      return { key: 'night_farm_zone', level: 'info', params: { ...zp, rule: 'farm' }, kind, zone: zone.id };
    }
    if (kind === 'private' || kind === 'hut') return { key: 'night_private', level: 'verify', params: {}, kind };
    // The strict rule everywhere: a tent opens on a campsite, a farm or private ground with the
    // owner's consent, never on public ground. A night the plugin cannot place is checked.
    if (kind === 'unknown') return { key: 'night_ground_unknown', level: 'verify', params: {}, kind };
    return null;
  }
  if (kind === 'campsite' || kind === 'farm' || kind === 'aire') return null;
  // A car park, a wild spot, a private garden or a hut: the local rule decides.
  return {
    key: 'night_wild',
    level: 'verify',
    params: { ...zp, rule: 'van' },
    kind,
    zone: zone ? zone.id : null,
  };
}

/** Price verdict for a night: null when within target. */
function priceVerdict(price, settings) {
  if (price == null) return { key: 'price_unknown', level: 'verify' };
  if (price > settings.night_price_max) return { key: 'price_high', level: 'verify' };
  if (price > settings.night_price_target) return { key: 'price_target', level: 'info' };
  return null;
}

/** Latest acceptable arrival (minutes) given the sunset. */
/** The latest arrival: sunset, rounded to the minute as it is shown, minus the margin. The one
 * value the check, the schedule, the sun table and the night search all show and judge with. */
const latestArrival = (sunsetMin, settings) => (sunsetMin == null ? null : Math.round(sunsetMin) - settings.sunset_margin_min);

/** "Arrival planned 18h40" written in the notes, or null. */
function writtenArrival(text) {
  const m = norm(text).match(/(?:arrivee prevue|planned arrival|expected arrival|arrival planned)[^0-9]{0,6}(\d{1,2}) ?[h:] ?(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : null;
}

/**
 * Every range of a day for the hours message "({open}–{close})": open = "08:00–12:00 / 17:30",
 * close = "19:00" — the whole line, not its first range.
 */
function rangesParams(ranges, fmt) {
  const parts = ranges.map(([o, c]) => `${fmt(o)}–${fmt(c)}`);
  const last = ranges[ranges.length - 1];
  return { open: [...parts.slice(0, -1), fmt(last[0])].join(' / '), close: fmt(last[1]) };
}

module.exports = { rangesParams, WEEKDAYS, closures, windowsIn, welcomeWindows, welcomeWindow, minNights, noWater, tentBanned, nightLegality, priceVerdict, latestArrival, writtenArrival, hm };
