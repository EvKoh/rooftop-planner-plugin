'use strict';
// Time on site of a visit, as the place's own notes or description state it: "hike … 4 h",
// "2h30 round trip", "1 h 30 on site", "1h30-2h". A bare hour ("open 9h") is not a duration:
// a duration needs a word saying so next to it; a span of the day ("de 9h à 12h") is none.
// Nothing is guessed: no match, no duration.
const { norm } = require('./util');
const { isHikePlace, isParkingPlace } = require('./design');

// Words that make a number of hours a time on site (French, English, Italian, German).
const CUE = /randonn|rando\b|balade|marche|promenade|boucle|aller.?retour|\ba\/r\b|sur place|visite|duree|compter|prevoir|hike|hiking|walk|trail|loop|round.?trip|return trip|on site|visit|duration|allow|takes|escursion|giro|passeggiata|andata e ritorno|durata|wanderung|rundweg|dauer|gehzeit|besuch/;

const quoteOf = (s, i, len) => s.slice(Math.max(0, i - 30), i + len + 20).replace(/\s+/g, ' ').trim();

// Words that introduce opening hours, in the languages the notes come in (accents removed by norm).
// …and the check-in or reception hours of a night ("Arrivée de 15h à 20h", "Accueil de 8h à 12h").
const OPENING = /\b(ouvert|ouverture|horaires?|open|opening|hours|daily|geoffnet|offnungszeiten|aperto|orari|apertura|abierto|horario|arrivee|arrival|check-?in|accueil|reception|anreise|ankunft|empfang|arrivo|accoglienza|llegada|recepcion|7\s*j\s*\/\s*7|7\s*\/\s*7|24\s*h)\b/;

// Words after which an hour is a time of day (accents removed by norm).
const CLOCK_WORD = /(?:jusqu.?a|a partir de|\bdepart|\bretour|\brendez.?vous|\brdv|\ble matin|\bmatin|\bstarts?|\bstarting|\bmeet(?:ing)?(?: point)?|\btreffpunkt|\bmorning|\breturn|\bdes|\bvers|\bavant|\bapres|\bentre|\bfrom|\buntil|\btill|\bafter|\bbefore|\bbetween|\bby|\bat|\ba|\bum|\bab|\bbis|\bvor|\bnach|\bzwischen|\bdalle|\balle|\bdopo|\bentro|\bprima(?: delle)?|\btra|\bdesde(?: las)?|\bhasta(?: las)?|\bverso)[\s,:;.]*$/;

// One reader of a length of time for the whole plugin: the free notes (parseVisit) and the
// sheet's duration line (place-sheet minutesOf / maxMinutesOf) both read through readLength,
// so a phrase means the same everywhere.
//   - an amount: "2 h", "2h30", "4 h 10", "1.5 h", "90 min";
//   - a pair, whatever its joint ("2-3 h", "1h30-2h", "de 2h à 3h", "entre 2h et 3h",
//     "30-45 min"): a range of lengths when it is minutes, or hours that start before 7 and
//     span at most 3 h; any other pair of hours ("9h-12h", "de 9h à 12h", "from 11:45 to
//     15:05") is a span of the day, never a length, even under a duration label;
//   - an hour after a clock word ("jusqu'à 11h", "avant 11h", "départ 8h", "starts 10h"), an
//     hour past 12 and a "10:30" time are clock times, never lengths.
// Free text also needs a word saying it is a time on site (CUE) near the amount; a duration
// line needs none (its label says so): the only difference between the two. The first amount that reads as a length is the answer.
const H = 'h|hrs?|hours?|heures?|ore|std\\.?|stunden?|horas?';
const M = 'min|mn|minutes?|minuten|minuti|minutos';
const AMOUNT = new RegExp(`(\\d{1,3}(?:[.,]\\d)?)(?:\\s*(?:(${H})(?![a-z])(?:\\s*(\\d{2})(?!\\d)(?:\\s*(?:${M})(?![a-z]))?)?|(${M})(?![a-z])|:(\\d{2})(?!\\d)))?`, 'g');
const PAIR_OPEN = /(?:\bentre|\bbetween|\bzwischen|\btra|\bde|\bfrom|\bdalle|\bvon)\s*$/;
const JOINT = /^(?:\s*[-–]\s*|\s+(?:a|au|to|bis|alle|al|et|and|und|e|y)\s+)$/;

function amountsIn(s) {
  return [...s.matchAll(AMOUNT)].filter((m) => !(m.index > 0 && /[\d.,:]/.test(s[m.index - 1]))).map((m) => {
    const n = Number(m[1].replace(',', '.'));
    const unit = m[2] ? 'h' : m[4] ? 'min' : m[5] ? 'clock' : null;
    const v = unit === 'h' ? Math.round(n * 60 + +(m[3] || 0)) : unit === 'clock' ? n * 60 + +m[5] : n;
    return { index: m.index, len: m[0].length, unit, n, v };
  });
}

// A clock word, then words that open an hour or a pair ("départ de 9h", "départ entre 6h et
// 7h", "meeting point between 5h and 6h"): the hours are still times of day.
const OPENERS = /(?:\s*\b(?:de|d|du|entre|between|from|zwischen|von|tra|dalle|da|a|at|um)\b)+\s*$/;
function clockBeforeOpener(lead) {
  const bare = lead.replace(OPENERS, '');
  return bare !== lead && CLOCK_WORD.test(bare);
}

/**
 * { min, max, quote } in minutes from a norm()ed text, or null; `labelled`: a duration line.
 * `orig`: the text as written, same length as `s`, for a quote that keeps its accents.
 */
function readLength(s, { labelled = false, orig = null } = {}) {
  const quote = (i, len) => quoteOf(orig && orig.length === s.length ? orig : s, i, len);
  const as = amountsIn(s);
  const cued = (i, len) => labelled || CUE.test(s.slice(Math.max(0, i - 40), i + len + 30));
  for (let k = 0; k < as.length; k++) {
    const a = as[k];
    const b = as[k + 1];
    if (b && b.unit && JOINT.test(s.slice(a.index + a.len, b.index))) {
      k++;
      const at = a.index;
      const len = b.index + b.len - a.index;
      const unit = a.unit || b.unit;
      const lo = a.unit ? a.v : (unit === 'h' ? Math.round(a.n * 60) : a.n);
      const hi = b.v;
      if (hi <= lo || !cued(at, len)) continue;
      // "départ 6h-7h": times of day; a word that opens the pair ("entre 2h et 3h") is its joint.
      const lead = s.slice(Math.max(0, at - 30), at);
      if ((CLOCK_WORD.test(lead) && !PAIR_OPEN.test(lead)) || clockBeforeOpener(lead)) continue;
      const lengths = unit === 'min' || (a.unit !== 'clock' && b.unit !== 'clock' && lo < 7 * 60 && hi - lo <= 3 * 60);
      if (lengths) { if (lo >= 5 && hi <= 1440) return { min: lo, max: hi, quote: quote(at, len) }; continue; }
      continue;
    }
    if (!a.unit || a.unit === 'clock') continue;
    const lead = s.slice(Math.max(0, a.index - 30), a.index);
    if (CLOCK_WORD.test(lead) || clockBeforeOpener(lead)) continue;
    if (a.unit === 'h' && a.n > 12) continue; // "14h" is a clock time, not a time on site
    if (a.v < 5 || a.v > 1440 || !cued(a.index, a.len)) continue;
    return { min: a.v, max: null, quote: quote(a.index, a.len) };
  }
  return null;
}

/** { min, max, quote } in minutes from a free text, or null. */
function parseVisit(text) {
  const orig = String(text || '').normalize('NFC');
  return readLength(norm(orig), { orig });
}

/**
 * The time on site the record holds: its minimum, else its maximum when only that was typed
 * (the figure the panel, the planner, the place tool and the day's load all use); null when none.
 */
function recordedMinutes(info) {
  return info ? (info.visit_min_minutes ?? info.visit_max_minutes ?? null) : null;
}

/**
 * Minutes on site of one stop of a day: the longer of the slot planned that day in TREK and
 * the minimum recorded on the place (a minimum never shortens a longer planned slot, and a
 * slot shorter than the minimum counts as the minimum); else the duration its sheet states
 * (in any language: place-sheet.js factsOf); else TREK's duration field; null when none is
 * known. The check's day load and the schedule both read it.
 */
function stopMinutes(place, info) {
  const slot = place.time != null && place.end != null && place.end > place.time ? place.end - place.time : null;
  const min = recordedMinutes(info);
  if (slot != null || min != null) return Math.max(slot ?? 0, min ?? 0);
  const stated = require('./place-sheet').factsOf(place).visitMinutes;
  if (stated != null) return stated;
  return place.duration != null && place.duration > 0 ? place.duration : null;
}

/**
 * Minutes on site of a stop within its day, the one rule the check (day load) and the
 * schedule share: a car park on a day with a hike is where the car waits during the hike,
 * so its time is the hike's (0); any other stop reads stopMinutes. null when unknown.
 */
function dayStopMinutes(stop, info, stops) {
  const hikeDay = stops.some((s) => isHikePlace(s.place));
  if (hikeDay && isParkingPlace(stop.place)) return 0;
  return stopMinutes(stop.place, info);
}

module.exports = { OPENING, readLength, parseVisit, recordedMinutes, stopMinutes, dayStopMinutes, CUE };
