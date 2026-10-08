'use strict';
// Time on site of a visit, as the place's own notes or description state it: "hike … 4 h",
// "2h30 round trip", "from 11:45 to 15:05", "1 h 30 on site". A bare hour ("open 9h") is
// not a duration: a duration needs a word saying so next to it, or a "from … to …" span.
// Nothing is guessed: no match, no duration.
const { norm } = require('./util');
const { isHikePlace, isParkingPlace } = require('./design');

// Words that make a number of hours a time on site (French, English, Italian, German).
const CUE = /randonn|rando\b|balade|marche|promenade|boucle|aller.?retour|\ba\/r\b|sur place|visite|duree|compter|prevoir|hike|hiking|walk|trail|loop|round.?trip|return trip|on site|visit|duration|allow|takes|escursion|giro|passeggiata|andata e ritorno|durata|wanderung|rundweg|dauer|gehzeit|besuch/;
const DUR = /(\d{1,2})\s*(?:h|hrs?|hours?|heures?|ore|std\.?|stunden?)\s*(\d{2})?(?:\s*min)?(?:\s*[-–à]\s*(\d{1,2})\s*(?:h|hrs?|hours?|heures?|ore|std\.?|stunden?)\s*(\d{2})?)?|(\d{2,3})\s*(?:min|minutes?|minuti|minuten)\b/g;
// "2-3 h": a range of hours with one unit.
const RANGE = /\b(\d{1,2})\s*[-–]\s*(\d{1,2})\s*(?:h|hrs?|hours?|heures?|ore|std)\b/g;
const MIN_RANGE = /\b(\d{1,3})\s*[-–]\s*(\d{1,3})\s*(?:min|minutes?|minuti|minuten)\b/g;
const SPAN = /\b(?:de|from|dalle|von)\s+(\d{1,2})\s*[h:]\s*(\d{2})?\s*(?:a|to|alle|bis|-|–)\s+(\d{1,2})\s*[h:]\s*(\d{2})?/;

const quote = (s, i, len) => s.slice(Math.max(0, i - 30), i + len + 20).replace(/\s+/g, ' ').trim();

// Words that introduce opening hours, in the languages the notes come in (accents removed by norm).
// …and the check-in or reception hours of a night ("Arrivée de 15h à 20h", "Accueil de 8h à 12h").
const OPENING = /\b(ouvert|ouverture|horaires?|open|opening|hours|daily|geoffnet|offnungszeiten|aperto|orari|apertura|abierto|horario|arrivee|arrival|check-?in|accueil|reception|anreise|ankunft|empfang|arrivo|accoglienza|llegada|recepcion|7\s*j\s*\/\s*7|7\s*\/\s*7|24\s*h)\b/;

/** { min, max, quote } in minutes from a free text, or null. */
/**
 * Is the hour written at s[index, index+len) a clock time rather than a duration? The start or
 * the end of a span ("de 9h à 12h", "9h-12h", "entre 9h et 11h", "from 9h to 11h"), or an hour
 * after a clock word ("jusqu'à", "à partir de", "dès", "avant", "après", "from", "until", "at",
 * "before", "after", "by", "vor", "nach", "ab", "bis", "prima delle", "dopo", "desde", "hasta"...).
 * The one test both duration readers apply (parseVisit here, the sheet's minutesOf). `s` is norm()ed.
 */
const SPAN_JOIN = '(?:[-–]|a|à|to|bis|alle|al|et|and|und|e|y)';
const CLOCK_WORD = /(?:jusqu.?a|a partir de|\bdes|\bvers|\bavant|\bapres|\bentre|\bfrom|\buntil|\btill|\bafter|\bbefore|\bbetween|\bby|\bat|\ba|\bum|\bab|\bbis|\bvor|\bnach|\bzwischen|\bdalle|\balle|\bdopo|\bentro|\bprima(?: delle)?|\btra|\bdesde(?: las)?|\bhasta(?: las)?|\bverso)\s*$/;
function isClockHour(s, index, len) {
  const after = s.slice(index + len);
  const before = s.slice(Math.max(0, index - 18), index);
  // Minutes are always a length ("45 min – 1 h"); only an hour can be a clock time.
  if (/min/.test(s.slice(index, index + len))) return false;
  // "1h30-2h" or "2-3 h" is a range of lengths, "9h-12h" a span of the day: a short range that
  // starts before 7 is a length.
  const hours = (txt) => { const m = String(txt).match(/(\d{1,2})\s*[h:]\s*(\d{2})?/); return m ? +m[1] * 60 + +(m[2] || 0) : null; };
  const isLengths = (a, b) => a != null && b != null && a < 7 * 60 && b > a && b - a <= 3 * 60;
  const next = after.match(new RegExp(`^\\s*${SPAN_JOIN}\\s*(\\d{1,2}\\s*[h:]\\s*\\d{0,2})`));
  if (next && !isLengths(hours(s.slice(index, index + len)), hours(next[1]))) return true;
  if (CLOCK_WORD.test(before)) return true;
  const prev = before.match(new RegExp(`(\\d{1,2}\\s*[h:]\\s*\\d{0,2})\\s*${SPAN_JOIN}\\s*$`));
  return !!prev && !isLengths(hours(prev[1]), hours(s.slice(index, index + len)));
}

function parseVisit(text) {
  const s = norm(text);
  const span = s.match(SPAN);
  if (span) {
    const a = +span[1] * 60 + +(span[2] || 0);
    const b = +span[3] * 60 + +(span[4] || 0);
    // "open 7/7 from 8:30 to 20:30" is opening hours, not a time on site.
    const before = s.slice(Math.max(0, span.index - 40), span.index);
    if (b > a && b - a <= 8 * 60 && !OPENING.test(before)) return { min: b - a, max: null, quote: quote(s, span.index, span[0].length) };
  }
  // "30-45 min": a range of minutes, its lower end as the minimum (as the sheet reads it).
  for (const m of s.matchAll(MIN_RANGE)) {
    const a = +m[1];
    const b = +m[2];
    if (b <= a || a < 5) continue;
    if (!CUE.test(s.slice(Math.max(0, m.index - 40), m.index + m[0].length + 30))) continue;
    return { min: a, max: b, quote: quote(s, m.index, m[0].length) };
  }
  for (const m of s.matchAll(RANGE)) {
    const a = +m[1];
    const b = +m[2];
    if (b <= a || b - a > 3 || b > 12) continue;
    if (!CUE.test(s.slice(Math.max(0, m.index - 40), m.index + m[0].length + 30))) continue;
    return { min: a * 60, max: b * 60, quote: quote(s, m.index, m[0].length) };
  }
  for (const m of s.matchAll(DUR)) {
    const around = s.slice(Math.max(0, m.index - 40), m.index + m[0].length + 30);
    if (!CUE.test(around)) continue;
    if (isClockHour(s, m.index, m[0].length)) continue;
    // "8h-21h" is opening hours, not a duration.
    if (/^\d{1,2}\s*h\s*[-–]\s*\d{1,2}\s*h/.test(m[0]) && +m[3] > +m[1] + 4) continue;
    let min;
    let max = null;
    if (m[5]) min = +m[5];
    else {
      if (+m[1] > 12) continue; // "14h" is a clock time, not a time on site
      min = +m[1] * 60 + +(m[2] || 0);
      if (m[3]) max = +m[3] * 60 + +(m[4] || 0);
    }
    if (min < 5 || min > 1440 || (max != null && max < min)) continue;
    return { min, max, quote: quote(s, m.index, m[0].length) };
  }
  return null;
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
  const min = info && info.visit_min_minutes != null ? info.visit_min_minutes : null;
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

module.exports = { SPAN, OPENING, isClockHour, parseVisit, stopMinutes, dayStopMinutes, CUE };
