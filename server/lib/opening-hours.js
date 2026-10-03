'use strict';
// A deliberately small reader for OpenStreetMap `opening_hours`: the forms shops, fuel
// stations and campsites actually use ("Mo-Sa 08:00-20:00; Su off", "Apr-Oct: Mo-Su
// 08:00-12:00,15:00-19:00", "24/7"). Anything it cannot read is 'unknown', never a guess.

const DAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function expand(spec, names) {
  const out = new Set();
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map((s) => names.indexOf(s.trim().slice(0, 3).toLowerCase().slice(0, names[0].length)));
    if (a < 0 || (b !== undefined && b < 0)) return null;
    if (b === undefined) out.add(a);
    else for (let i = a; ; i = (i + 1) % names.length) { out.add(i); if (i === b) break; }
  }
  return out;
}

function parseTimes(spec) {
  const out = [];
  for (const r of spec.split(',')) {
    const m = r.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    let close = +m[3] * 60 + +m[4];
    const open = +m[1] * 60 + +m[2];
    if (close <= open) close += 24 * 60; // past midnight
    out.push([open, close]);
  }
  return out;
}

/** Parse into rules [{months:Set|null, days:Set, times:[[o,c]]|'off'}]; null when unreadable. */
function parse(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (t === '24/7') return [{ months: null, days: new Set([0, 1, 2, 3, 4, 5, 6]), times: [[0, 1440]] }];
  const rules = [];
  for (let raw of t.split(';')) {
    raw = raw.trim();
    if (!raw) continue;
    let months = null;
    const mm = raw.match(/^([A-Za-z]{3}(?:\s*-\s*[A-Za-z]{3})?(?:,[A-Za-z]{3}(?:-[A-Za-z]{3})?)*)\s*:?\s+(?=[A-Za-z]{2}\b|\d|off|closed)/);
    if (mm && expand(mm[1].replace(/\s/g, ''), MONTHS)) {
      months = expand(mm[1].replace(/\s/g, ''), MONTHS);
      raw = raw.slice(mm[0].length).trim();
    }
    if (/^PH\b/i.test(raw)) continue; // public holidays: not modelled
    const m = raw.match(/^([A-Za-z]{2}(?:[-,][A-Za-z]{2})*)?\s*(.*)$/);
    const days = m[1] ? expand(m[1].replace(/,?PH/i, ''), DAYS) : new Set([0, 1, 2, 3, 4, 5, 6]);
    if (!days) return null;
    const rest = m[2].trim();
    if (/^(off|closed)$/i.test(rest)) rules.push({ months, days, times: 'off' });
    else {
      const times = parseTimes(rest);
      if (!times) return null;
      rules.push({ months, days, times });
    }
  }
  return rules.length ? rules : null;
}

/**
 * Is the place open for the whole window [from, to] (minutes) on ISO date `iso`?
 * 'open' | 'closed' | 'unknown'. Later rules override earlier ones for the same day.
 */
function statusAt(text, iso, from, to = from) {
  const rules = parse(text);
  if (!rules) return 'unknown';
  const d = new Date(`${iso}T12:00:00Z`);
  const wd = d.getUTCDay();
  const mo = d.getUTCMonth();
  let times = null;
  let matched = false;
  for (const r of rules) {
    if (r.months && !r.months.has(mo)) continue;
    if (!r.days.has(wd)) continue;
    matched = true;
    times = r.times;
  }
  if (!matched || times === 'off') return 'closed';
  return times.some(([o, c]) => from >= o && to <= c) ? 'open' : 'closed';
}

/** Today's hours as text, e.g. "08:00-12:30, 15:00-19:00", "closed", or null. */
function hoursOn(text, iso) {
  const rules = parse(text);
  if (!rules) return null;
  const d = new Date(`${iso}T12:00:00Z`);
  let times = null;
  for (const r of rules) {
    if (r.months && !r.months.has(d.getUTCMonth())) continue;
    if (r.days.has(d.getUTCDay())) times = r.times;
  }
  if (!times || times === 'off') return 'closed';
  const f = (m) => m === 1440 ? '24:00' : `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return times.map(([o, c]) => `${f(o)}-${f(c)}`).join(', ');
}

module.exports = { parse, statusAt, hoursOn };
