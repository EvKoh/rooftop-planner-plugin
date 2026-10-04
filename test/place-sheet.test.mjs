// The place's sheet: description and notes read into typed fields. Every place and text
// here is FICTIONAL.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { require, makeHost, stubFetch } from './helpers.mjs';

const ps = require('../server/lib/place-sheet.js');
const plugin = require('../server/index.js');
const { MESSAGES, CODES } = require('../server/lib/i18n.js');
const design = require('../server/lib/design.js');
const { build } = require('./fixtures/trip.js');

const HIKE_NOTES = [
  'Chien : admis',
  'Distance (km) : 10.93',
  'Durée : 4 h 10',
  'D+ (m) : 770',
  'D− (m) : 770',
  'Niveau : officiel : Intermediate ; traduction : moyen',
  'Type : boucle',
  'Départ : Parking Example (1 680 m)',
  'Altitude max (m) : 2420',
  'Risque : Modéré en octobre, aucun refuge ouvert.',
  'Vertige : Niveau : léger ; passages : crête ventée.',
  'Itinéraire : • Parking Example',
  '• sentier 25 → Alm Example (1 920 m)',
  '• Hut Example (2 297 m)',
  '• retour au parking',
  'Statut en octobre : praticable avec prudence ; verglas possible',
  'Meilleur moment : jour sec, départ 9 h',
  'Carte : https://www.example.org/en/activities/ABC',
  'Mystery key : something nobody classified',
  'A free line with no key.',
].join('\n');
const HIKE_DESC = [
  '10.93 km · +770 m · 4 h 10',
  '• views over the Example peaks',
  '• a stretch of the high route',
  '',
  '— suite des notes —',
  '• fermeture 2026 : 30 sept. 2026 ; ouvert aux dates : non',
  'Points forts : • views over the Example peaks',
  '• a stretch of the high route',
  'GPX : https://tracks.example.org/gpx/ABC/download?filter[formatType]=original',
].join('\n');

describe('place sheet: reading', () => {
  it('reads a French hike into typed fields, keeps every unclassified line, repeats nothing', () => {
    const s = ps.parse(HIKE_DESC, HIKE_NOTES, { kind: 'hike' });
    const f = s.fields;
    expect(f.distance_km.value).toBe(10.93);
    expect(f.ascent_m.value).toBe(770);
    expect(f.descent_m.value).toBe(770);
    expect(f.duration.minutes).toBe(250);
    expect(f.level.grade).toBe('medium');
    expect(f.route_type.kind).toBe('loop');
    expect(f.start.text).toBe('Parking Example (1 680 m)');
    expect(f.alt_max_m.value).toBe(2420);
    expect(f.dog.allowed).toBe(true);
    expect(f.itinerary.items).toEqual(['Parking Example', 'sentier 25 → Alm Example (1 920 m)', 'Hut Example (2 297 m)', 'retour au parking']);
    expect(f.conditions.text).toMatch(/praticable/);
    expect(f.best_time.text).toMatch(/jour sec/);
    expect(f.closures.items[0]).toMatch(/30 sept/);
    expect(f.highlights.items).toEqual(['views over the Example peaks', 'a stretch of the high route']);
    expect(f.map_url.url).toBe('https://www.example.org/en/activities/ABC');
    expect(f.gpx_url.url).toBe('https://tracks.example.org/gpx/ABC/download?filter[formatType]=original');
    expect(s.other).toEqual([{ label: 'Mystery key', text: 'something nobody classified' }]);
    expect(s.text).toEqual(['A free line with no key.']);
    expect(s.about).toEqual([]); // the summary line and its bullets became fields
  });

  it('reads the same fields in English, Italian and German', () => {
    const en = ps.parse('', 'Distance: 8.5 km\nElevation gain: 600 m\nWalking time: 3h30\nDifficulty: hard\nRoute: out and back\nStarting point: Car park Example\nDogs: not allowed', { kind: 'hike' }).fields;
    expect([en.distance_km.value, en.ascent_m.value, en.duration.minutes, en.level.grade, en.route_type.kind, en.start.text, en.dog.allowed]).toEqual([8.5, 600, 210, 'hard', 'out_and_back', 'Car park Example', false]);
    const it = ps.parse('', 'Lunghezza: 6,2 km\nDislivello: 450 m\nDurata: 2 ore 15\nDifficoltà: facile\nTipo di percorso: ad anello\nPartenza: Parcheggio Esempio\nCane: ammesso', { kind: 'hike' }).fields;
    expect([it.distance_km.value, it.ascent_m.value, it.duration.minutes, it.level.grade, it.route_type.kind, it.start.text, it.dog.allowed]).toEqual([6.2, 450, 135, 'easy', 'loop', 'Parcheggio Esempio', true]);
    const de = ps.parse('', 'Strecke: 12 km\nAufstieg: 900 m\nAbstieg: 900 m\nGehzeit: 5 Std 0\nSchwierigkeit: mittel\nAusgangspunkt: Parkplatz Beispiel\nHöchster Punkt: 2.300 m\nHund: erlaubt', { kind: 'hike' }).fields;
    expect([de.distance_km.value, de.ascent_m.value, de.descent_m.value, de.duration.minutes, de.level.grade, de.start.text, de.dog.allowed]).toEqual([12, 900, 900, 300, 'medium', 'Parkplatz Beispiel', true]);
  });

  it('reads a night: price, opening, rooftop tent, services; description prose is its "about"', () => {
    const s = ps.parse('A quiet campsite by an example lake.', 'Type : CAMPING autorisé\nPrix : 30 €/nuit\nOuverture : jusqu’à fin octobre\nTente de toit : acceptée\nServices : WC, douches\nPlaces : 50\nAccès : route étroite', { kind: 'night' });
    expect(Object.keys(s.fields)).toEqual(['type', 'price', 'opening', 'rooftop_tent', 'services', 'spots', 'access']);
    expect(s.fields.spots.value).toBe(50);
    expect(s.about).toEqual(['A quiet campsite by an example lake.']);
  });

  it('does not take a time, a URL or a sentence for a key', () => {
    expect(ps.splitKey('Vers 10:30 on part')).toBeNull();
    expect(ps.splitKey('https://example.org/a: b')).toBeNull();
    expect(ps.splitKey('This is a long sentence that happens to have a colon in it somewhere: yes')).toBeNull();
    expect(ps.fieldOf('Statut en octobre')).toBe('conditions');
    expect(ps.fieldOf('Saison 2026')).toBe('closures');
    expect(ps.fieldOf('D− (m)')).toBe('descent_m');
  });
});

describe('place sheet: the card', () => {
  it('fixed sections in a fixed order per kind, translated, with design.js icons and tones', () => {
    const v = ps.view(ps.parse(HIKE_DESC, HIKE_NOTES, { kind: 'hike' }), 'fr', { trackUrl: 'https://www.outdooractive.com/en/route/1' });
    expect(v.title).toBe('Randonnée');
    expect(v.sections.map((x) => x.id)).toEqual(['figures', 'start', 'itinerary', 'conditions', 'highlights', 'links', 'other']);
    const figs = v.sections[0].rows;
    expect(figs.map((r) => r.figure.replace(/\s/g, ' '))).toEqual(['10,9 km', '+770 m', '−770 m', '4 h 10', 'Moyen', 'Boucle', '2 420 m']);
    const risk = v.sections.find((x) => x.id === 'conditions').rows.find((r) => r.field === 'risk');
    expect(risk).toMatchObject({ label: 'Risque', tone: 'warn', color: design.TONE_COLOR.warn });
    expect(risk.icon).toMatch(/^<path/);
    const links = v.sections.find((x) => x.id === 'links').rows;
    expect(links[0]).toMatchObject({ field: 'website', url: 'https://www.outdooractive.com/en/route/1', linkText: 'outdooractive.com' });
    expect(v.sections.at(-1)).toMatchObject({ id: 'other', folded: true });
  });

  it('a price tile shows its amount and keeps the rest as detail; a row named like its section says it once', () => {
    const v = ps.view(ps.parse('', 'Prix : 44,60 €/nuit — tarif officiel (2 × 12 € + voiture 13 €)\nAvis : 4,8/5 sur 57', { kind: 'night' }), 'fr');
    expect(v.sections[0].rows[0]).toMatchObject({ figure: '44,60 €/nuit', detail: '44,60 €/nuit — tarif officiel (2 × 12 € + voiture 13 €)' });
    expect(ps.view(ps.parse('', 'Prix : participation libre', { kind: 'night' }), 'fr').sections[0].rows[0].figure).toBeUndefined();
    const reviews = v.sections.find((x) => x.id === 'reviews');
    expect(reviews).toMatchObject({ title: 'Avis' });
    expect(reviews.rows[0].label).toBe('');
  });

  it('every label, section, value and kind is in every language', () => {
    const keys = [
      ...ps.FIELD_NAMES.map((f) => `sh.f.${f}`),
      ...['figures', 'start', 'itinerary', 'conditions', 'highlights', 'links', 'stay', 'services', 'access', 'reviews', 'visit', 'more', 'other'].map((x) => `sh.s.${x}`),
      ...['loop', 'out_and_back', 'one_way', 'easy', 'medium', 'hard', 'dogYes', 'dogNo'].map((x) => `sh.v.${x}`),
      ...['hike', 'night', 'activity'].map((x) => `sh.k.${x}`),
    ];
    for (const c of CODES) for (const k of keys) expect(MESSAGES[c][k], `${c} ${k}`).toBeTruthy();
    for (const k of Object.keys(ps.FIELDS)) expect(design.svgOf(design.SHEET_ICONS[k]), k).toMatch(/^</);
  });
});

describe('place sheet: writing a field', () => {
  it('replaces the line and its bullets, moves a description line to the notes, appends a new one in the reader\'s language, removes with null', () => {
    const n = 'Chien : admis\nItinéraire : • A\n• B\nRisque : faible';
    expect(ps.setField('', n, 'itinerary', 'X\nY\nZ', 'fr').notes).toBe('Chien : admis\nItinéraire :\n• X\n• Y\n• Z\nRisque : faible');
    expect(ps.setField('Intro\nCarte : http://old.example', n, 'map_url', 'https://new.example', 'fr')).toEqual({ description: 'Intro', notes: `${n}\nCarte : https://new.example` });
    expect(ps.setField('', n, 'gpx_url', 'https://g.example', 'de').notes).toBe(`${n}\nGPX-Track : https://g.example`);
    expect(ps.setField('', n, 'dog', null, 'fr').notes).toBe('Itinéraire : • A\n• B\nRisque : faible');
    expect(() => ps.setField('', n, 'colour', 'x')).toThrow(/unknown sheet field/);
  });
});

describe('place sheet: widget and MCP', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('the widget gets the card of the place, by kind', async () => {
    const trip = build();
    trip.places.push({ id: 30, trip_id: 1, name: 'Hike Example', lat: 46.6, lng: 11.7, category_id: null, category_name: 'See – Hike', description: HIKE_DESC, notes: HIKE_NOTES });
    const drv = makeHost({ trip }).run(plugin);
    const d = JSON.parse((await drv.route({ method: 'POST', path: '/amenities' }, { body: { tripId: 1, placeId: 30, locale: 'en' } })).body);
    expect(d.night).toBe(false);
    expect(d.sheet.kind).toBe('hike');
    expect(d.sheet.sections[0].rows.map((r) => r.field)).toEqual(['distance_km', 'ascent_m', 'descent_m', 'duration', 'level', 'route_type', 'alt_max_m']);
    const camp = JSON.parse((await drv.route({ method: 'POST', path: '/amenities' }, { body: { tripId: 1, placeId: 13, locale: 'en' } })).body);
    expect(camp.sheet.kind).toBe('night');
  });

  it('vanlife_place shows the sheet of one place and writes a field into TREK\'s notes', async () => {
    const trip = build();
    trip.places.push({ id: 30, trip_id: 1, name: 'Hike Example', lat: 46.6, lng: 11.7, category_id: null, category_name: 'See – Hike', description: HIKE_DESC, notes: HIKE_NOTES });
    const h = makeHost({ trip, userSettings: { language: 'fr' } });
    const call = (args) => h.run(plugin).hook('mcpToolProvider', 'callTool', { name: 'vanlife_place', args });
    const r = await call({ tripId: 1, placeId: 30 });
    expect(r.sheet.kind).toBe('hike');
    expect(r.sheet.fields.ascent_m.value).toBe(770);
    const w = await call({ tripId: 1, placeId: 30, sheet_set: { ascent_m: '780', gpx_url: null, marking: '25, 32' } });
    expect(w.sheet.fields.ascent_m.value).toBe(780);
    expect(w.sheet.fields.gpx_url).toBeUndefined();
    const place = trip.places.find((p) => p.id === 30);
    expect(place.notes).toMatch(/^D\+ \(m\) : 780$/m);
    expect(place.notes).toMatch(/^Balisage : 25, 32$/m);
    expect(place.description).not.toMatch(/GPX/);
    await expect(call({ tripId: 1, placeId: 30, sheet_set: { colour: 'red' } })).rejects.toThrow(/unknown sheet field/);
  });
});
