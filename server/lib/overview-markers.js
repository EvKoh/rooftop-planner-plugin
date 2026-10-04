'use strict';
// Every planned stop of the whole trip as a small dot on the map, whatever day is selected:
// the overview the planner's one-day view does not give. Nights take their booking state
// (green booked, amber in discussion, red dropped, blue otherwise) and a pictogram for their
// kind, all from design.js. A place planned
// on several days is one dot listing them. Declarative markers only: TREK draws them.

const { isTrace } = require('./classify');
const nightStatus = require('./night-status');
const { t } = require('./i18n');
const { hhmm } = require('./util');
const { markerStyle } = require('./design');
const { statsText } = require('./walks');

const MAX = 200; // the host's cap per provider

const span = (p) => (p.time == null ? '' : p.end == null ? hhmm(p.time) : `${hhmm(p.time)}–${hhmm(p.end)}`);

/**
 * `walks` (walks.hikeWalks) ties each hike to its car park: the hike's popup says which car
 * park it starts from (and the walk's length once computed), the car park's which hike it
 * serves; a hike tied to a planned car park shows even when it is not planned itself.
 */
function overviewMarkers(model, settings, { walks = [], geometry = new Map() } = {}) {
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
  const extra = new Map();
  const add = (id, line) => { if (!extra.has(id)) extra.set(id, []); if (!extra.get(id).includes(line)) extra.get(id).push(line); };
  for (const w of walks) {
    if (!w.planned && w.access && byPlace.has(w.access.placeId) && !byPlace.has(w.hikeId)) {
      const park = byPlace.get(w.access.placeId);
      const p = model.poolById.get(w.hikeId);
      if (p) byPlace.set(w.hikeId, { id: `stop-${w.hikeId}`, lat: p.lat, lng: p.lng, name: p.name, days: [...park.days], lines: [...park.days], night: false, place: p });
    }
    if (w.access && w.access.name) add(w.hikeId, t(L, 'walk.from', { parking: w.access.name }));
    const stats = statsText(geometry.get(w.key), L);
    if (stats) add(w.hikeId, stats);
    if (w.access && w.access.placeId) add(w.access.placeId, t(L, 'walk.access', { hike: w.hike }));
  }
  return [...byPlace.entries()].slice(0, MAX).map(([placeId, m]) => {
    const st = m.night ? status.get(Number(placeId)) || 'spotted' : null;
    const lines = [...(st ? [...m.lines, t(L, 'overview.night', { status: t(L, `st.${st}`) })] : m.lines), ...(extra.get(Number(placeId)) || [])];
    return {
      id: m.id,
      lat: m.lat,
      lng: m.lng,
      label: `${m.days.join(', ')} · ${m.name}`.slice(0, 120),
      popupText: lines.join('\n').slice(0, 500),
      ...markerStyle(m.place, { night: m.night, status: st, vehicle: settings.vehicle }),
    };
  });
}

module.exports = { overviewMarkers };
