'use strict';
// Every planned stop of the whole trip as a small dot on the map, whatever day is selected:
// the overview the planner's one-day view does not give. Nights take their booking state
// (green booked, amber in discussion, red dropped), visits green: green means planned, the
// same rule as the bed marker of a booked night. A place planned
// on several days is one dot listing them. Declarative markers only: TREK draws them.

const { isTrace } = require('./classify');
const nightStatus = require('./night-status');
const { t } = require('./i18n');
const { hhmm } = require('./util');
const { markerStyle } = require('./design');

const MAX = 200; // the host's cap per provider

const span = (p) => (p.time == null ? '' : p.end == null ? hhmm(p.time) : `${hhmm(p.time)}–${hhmm(p.end)}`);

function overviewMarkers(model, settings) {
  if (!settings.map_overview) return [];
  const L = settings.language;
  const nightPlaces = new Set(model.nights.map((n) => n.placeId));
  const status = nightStatus.statusByPlace(model.reservations);
  const byPlace = new Map();
  for (const d of model.days) {
    for (const a of d.assignments) {
      const p = a.place;
      if (p.lat == null || p.lng == null || isTrace(p.categoryName, p)) continue;
      const night = nightPlaces.has(p.id);
      let m = byPlace.get(p.id);
      if (!m) {
        m = { id: `stop-${p.id}`, lat: p.lat, lng: p.lng, name: p.name, days: [], lines: [], night, place: p };
        byPlace.set(p.id, m);
      }
      const day = t(L, 'dayShort', { n: d.n });
      if (!m.days.includes(day)) m.days.push(day);
      const when = span(p);
      m.lines.push(when ? `${day} ${when}` : day);
    }
  }
  return [...byPlace.entries()].slice(0, MAX).map(([placeId, m]) => {
    const st = m.night ? status.get(Number(placeId)) || 'spotted' : null;
    const lines = st ? [...m.lines, t(L, 'overview.night', { status: t(L, `st.${st}`) })] : m.lines;
    return {
      id: m.id,
      lat: m.lat,
      lng: m.lng,
      label: `${m.days.join(', ')} · ${m.name}`.slice(0, 120),
      popupText: lines.join('\n').slice(0, 500),
      ...markerStyle(m.place, { night: m.night, status: st }),
    };
  });
}

module.exports = { overviewMarkers };
