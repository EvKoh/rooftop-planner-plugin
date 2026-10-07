'use strict';
// Small pure helpers shared by every module. No I/O here.

/** "19:05", "19h05", "9h" → minutes since midnight; null when unreadable. */
function hm(s) {
  if (s == null || s === '') return null;
  const m = String(s).match(/(\d{1,2})\s*[:h]\s*(\d{2})?/);
  return m ? +m[1] * 60 + +(m[2] || 0) : null;
}

/** Minutes since midnight → "HH:MM" (clamped to the day, rounded to the minute). */
function hhmm(min) {
  if (min == null || !Number.isFinite(min)) return null;
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, '0')}:${String(m - h * 60).padStart(2, '0')}`;
}

/** Equirectangular distance in km — accurate enough under a few hundred km. */
function distKm(a, b) {
  const rad = Math.PI / 180;
  return 6371 * Math.hypot((a[0] - b[0]) * rad, (a[1] - b[1]) * rad * Math.cos(a[0] * rad));
}

/** Lowercase, accents stripped: the form every text rule matches against. */
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Round a coordinate pair so cache keys survive float noise (≈ 11 m). */
function roundPt(p) {
  return [Math.round(+p[0] * 1e4) / 1e4, Math.round(+p[1] * 1e4) / 1e4];
}

/** Map with at most `limit` promises in flight; keeps input order. */
async function pmap(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** A wall-clock budget. Tools must answer within 15 s (host limit), hooks within 5 s. */
function deadline(ms, now = Date.now) {
  const end = now() + ms;
  return { left: () => end - now(), expired: () => now() >= end };
}

/** Weekday (0 = Sunday) of an ISO date, independent of the server time zone. */
function weekday(iso) {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

/** Length of a [lat,lng] polyline in km. */
function polylineKm(pts) {
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += distKm(pts[i - 1], pts[i]);
  return km;
}

/** Shortest distance (km) from a point to a polyline, vertex-based (polylines are dense). */
function distToPolylineKm(p, pts) {
  let best = Infinity;
  for (const q of pts) best = Math.min(best, distKm(p, q));
  return best;
}

/** Keep every n-th vertex so a polyline stays under `max` points (ends kept). */
function thin(pts, max) {
  if (pts.length <= max) return pts.slice();
  const step = Math.ceil(pts.length / max);
  const out = pts.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}

function toNum(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** 45 → "45 min", 120 → "2 h", 210 → "3 h 30" (in language L when given): the one duration format of the plugin; null for null. */
function durationText(min, L) {
  if (min == null || !Number.isFinite(+min)) return null;
  const total = Math.round(+min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  // In language L, with its own unit words (ч, мин, 時間...); English form without it.
  if (L) {
    const { t } = require('./i18n');
    return h ? (m ? t(L, 'unit.durHM', { h, mm: String(m).padStart(2, '0') }) : t(L, 'unit.durH', { h })) : t(L, 'unit.durM', { m });
  }
  return h ? `${h} h${m ? ` ${String(m).padStart(2, '0')}` : ''}` : `${m} min`;
}

const URL_RE = /https?:\/\/[^\s<>"'|]+/g;
/**
 * The http(s) addresses in a text, the one extractor of the plugin: a closing bracket or a
 * stop at the end belongs to the sentence, unless the bracket was opened in the address.
 */
const urlsIn = (s) => (String(s || '').match(URL_RE) || []).map((u) => {
  let x = u.replace(/[.,;:!?]+$/, '');
  while (/[)\]]$/.test(x) && (x.split(x.endsWith(')') ? '(' : '[').length <= x.split(x.endsWith(')') ? ')' : ']').length - 1)) x = x.slice(0, -1).replace(/[.,;:!?]+$/, '');
  return x;
});

/**
 * The part of a place name that says what it is, for a banner line or a map label: no
 * "25 € · 4,8/5 · " prefix, no emoji, cut at a spaced dash, an arrow or a bracket, the first
 * part longer than a one-word prefix; at most `max` characters, with an ellipsis.
 */
function shortName(name, max = 18) {
  const core = String(name || '').split('·').pop().replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ');
  const parts = core.split(/\s[—–-]\s|\s→\s|\s\(/).map((x) => x.trim()).filter(Boolean);
  const s = parts.find((x) => x.length > 6) || parts[0] || '';
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

module.exports = { shortName, urlsIn, durationText, hm, hhmm, distKm, norm, roundPt, pmap, deadline, weekday, polylineKm, distToPolylineKm, thin, toNum };
