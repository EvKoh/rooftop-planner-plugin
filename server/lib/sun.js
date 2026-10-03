'use strict';
// Sunset for a date and a place (NOAA low-precision formula, ±1–2 min below 60° latitude),
// expressed in the local time of an IANA time zone. A rooftop tent has to be unfolded in
// daylight, so the latest acceptable arrival is sunset minus a margin. Never assume a
// "usual" sunset: in October it moves by about 2 minutes a day, and the clocks change on
// the last Sunday of the month in Europe.

const RAD = Math.PI / 180;

/** Offset of `timeZone` from UTC, in minutes, at instant `date`. Falls back to 0 on an unknown zone. */
function tzOffsetMin(timeZone, date) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date);
    const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const wall = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour, +v.minute, +v.second);
    return Math.round((wall - date.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/** Solar event in UTC minutes after midnight; `rise` true for sunrise. null under polar day/night. */
function solarUtcMin(lat, lng, iso, rise) {
  const d = new Date(`${iso}T12:00:00Z`);
  const n = Math.round((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5);
  const g = ((2 * Math.PI) / 365) * (n - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const dec = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const x = Math.cos(90.833 * RAD) / (Math.cos(lat * RAD) * Math.cos(dec)) - Math.tan(lat * RAD) * Math.tan(dec);
  if (x < -1 || x > 1) return null;
  const ha = Math.acos(x) / RAD;
  return 720 - 4 * (lng + (rise ? ha : -ha)) - eq;
}

function toLocal(utcMin, iso, timeZone) {
  if (utcMin == null) return null;
  const at = new Date(Date.parse(`${iso}T00:00:00Z`) + utcMin * 60000);
  return utcMin + tzOffsetMin(timeZone, at);
}

/** Local sunset (minutes after local midnight) at [lat,lng] on ISO date `iso`. */
function sunset(lat, lng, iso, timeZone = 'UTC') {
  return toLocal(solarUtcMin(+lat, +lng, iso, false), iso, timeZone);
}

function sunrise(lat, lng, iso, timeZone = 'UTC') {
  return toLocal(solarUtcMin(+lat, +lng, iso, true), iso, timeZone);
}

module.exports = { sunset, sunrise, tzOffsetMin };
