'use strict';
// The travel rules, as pure functions over text and numbers (no TREK, no network), so each
// one is unit-tested on its own. Ported from a planning checker used on a real trip and
// kept because each rule caught a real mistake:
//  - arrive at the night >= `sunset_margin_min` before sunset (unfold the tent in daylight);
//  - never arrive somewhere closed (weekly closure, opening hours, check-in window,
//    minimum stay);
//  - a rooftop tent only on a campsite or a farm; a motorhome area is blocking; a farm in a
//    zone that forbids farm camping is a risk the traveller must accept;
//  - nights without water in a row need a refill plan; shopping detours stay short.
const { norm, hm } = require('./util');
const { nightKind } = require('./classify');
const { zoneAt } = require('./zones');

// Weekday names, accent-stripped, Sunday first: French, Italian, German, English.
const WEEKDAYS = [
  ['dimanche', 'domenica', 'sonntag', 'sunday'], ['lundi', 'lunedi', 'montag', 'monday'],
  ['mardi', 'martedi', 'dienstag', 'tuesday'], ['mercredi', 'mercoledi', 'mittwoch', 'wednesday'],
  ['jeudi', 'giovedi', 'donnerstag', 'thursday'], ['vendredi', 'venerdi', 'freitag', 'friday'],
  ['samedi', 'sabato', 'samstag', 'saturday'],
];
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
    // "fermé le lundi", "closed on Monday", "chiuso il lunedì", "Montag Ruhetag", "lundi : fermé".
    const re = new RegExp(`(ferme|closed|chiuso|geschlossen)\\s+(le |les |on |il |la |am |the )?${day}\\b|\\b${day}s?\\s*[:–-]?\\s*(ferme|closed|chiuso|geschlossen)|\\b${day}( und \\w+)? ruhetag`);
    const i = tn.search(re);
    if (i >= 0) {
      const neighbour = new RegExp(`${NEIGHBOUR.source}\\b[^.;]*$`).test(tn.slice(Math.max(0, i - 70), i)) && !NEIGHBOUR.test(norm(placeName));
      if (neighbour) out.push({ key: 'closure_neighbour', level: 'info', params: { quote: quote(tn, i, 50, 25) } });
      else if (!isNight) out.push({ key: 'closure_cited', level: 'verify', params: { quote: quote(tn, i) } });
    }
    // "Monday : 8h00–21h00", "lundi : 9:00-12:00".
    const h = tn.match(new RegExp(`\\b${day}\\s*:\\s*(\\d{1,2})[h:](\\d{2})?\\s*[–-]\\s*(\\d{1,2})[h:](\\d{2})?`));
    if (h && from != null) {
      const open = +h[1] * 60 + +(h[2] || 0);
      const close = +h[3] * 60 + +(h[4] || 0);
      if (from < open || (to ?? from) > close) out.push({ key: 'outside_hours', level: 'blocking', params: { open, close } });
    }
  }
  return out;
}

/** Check-in window "Arrival: 15h–23h" / "Arrivée : 15:00-22:00" → [open, close] minutes, or null. */
function welcomeWindow(text) {
  const m = norm(text).match(/(?:arrivee|arrival|check-?in|arrivo|anreise)\s*:\s*(\d{1,2})\s*[h:]?(\d{2})?\s*[–-]\s*(\d{1,2})\s*[h:]?(\d{2})?/);
  return m ? [+m[1] * 60 + +(m[2] || 0), +m[3] * 60 + +(m[4] || 0)] : null;
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
/** A quote proving tents/camping are banned at this place, or null. */
function tentBanned(text, tags = {}) {
  if (tags.tents === 'no') return 'tents=no';
  const t = norm(text);
  const re = new RegExp(BANNED.source, 'g');
  let m;
  while ((m = re.exec(t))) {
    if (!LAW_NOT_BAN.test(t.slice(m.index + m[0].length))) return quote(t, m.index, 20, 50);
  }
  return null;
}

/**
 * Is this night's ground legal and fit for a rooftop tent? Returns a finding or null.
 * { key: night_aire | night_farm_zone | night_private, level, params }.
 */
function nightLegality({ categoryName, placeName, lat, lng, text = '' }) {
  const kind = nightKind(categoryName, placeName);
  if (kind === 'aire') return { key: 'night_aire', level: 'blocking', params: {}, kind };
  const zone = zoneAt(lat, lng);
  const authorised = /autoris|authori[sz]ed|agricampeggio|campingplatz|licen[cs]ed/.test(norm(text));
  if (kind === 'farm' && zone && zone.farm === 'risk' && !authorised) {
    return { key: 'night_farm_zone', level: 'verify', params: { zone: zone.name, note: zone.note, noteFr: zone.noteFr }, kind, zone: zone.id };
  }
  if (kind === 'private' || kind === 'hut') return { key: 'night_private', level: 'verify', params: {}, kind };
  return null;
}

/** Price verdict for a night: null when within target. */
function priceVerdict(price, settings) {
  if (price == null) return { key: 'price_unknown', level: 'verify' };
  if (price > settings.night_price_max) return { key: 'price_high', level: 'verify' };
  if (price > settings.night_price_target) return { key: 'price_target', level: 'info' };
  return null;
}

/** Latest acceptable arrival (minutes) given the sunset. */
const latestArrival = (sunsetMin, settings) => (sunsetMin == null ? null : sunsetMin - settings.sunset_margin_min);

/** "Arrival planned 18h40" written in the notes, or null. */
function writtenArrival(text) {
  const m = norm(text).match(/(?:arrivee prevue|planned arrival|expected arrival|arrival planned)[^0-9]{0,6}(\d{1,2}) ?[h:] ?(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : null;
}

module.exports = { WEEKDAYS, closures, welcomeWindow, minNights, noWater, tentBanned, nightLegality, priceVerdict, latestArrival, writtenArrival, hm };
