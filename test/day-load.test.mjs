// Visit durations, the overloaded-day and too-many-activities checks, possible savings and
// the route place named in the user's language. FICTIONAL data only (public repository).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { require, makeHost, stubFetch } from './helpers.mjs';

const plugin = require('../server/index.js');
const pi = require('../server/lib/place-info.js');
const fillLib = require('../server/lib/amenity-fill.js');
const { parseVisit, stopMinutes } = require('../server/lib/visit.js');
const { checkTrip } = require('../server/lib/check.js');
const { stayOn, stayBefore } = require('../server/lib/trip.js');
const { bannerText, bannerFrom } = require('../server/lib/report.js');
const { deadline } = require('../server/lib/util.js');
const { loadTrip } = require('../server/lib/trip.js');
const { readSettings, DEFAULTS } = require('../server/lib/settings.js');
const { MESSAGES, CODES } = require('../server/lib/i18n.js');
const { TOOL_SPECS } = require('../server/lib/tool-specs.js');
const manifest = require('../trek-plugin.json');
const { build, P } = require('./fixtures/trip.js');

const call = (h, name, args) => h.run(plugin).hook('mcpToolProvider', 'callTool', { name, args });
const check = (h, args = {}) => call(h, 'vanlife_check_trip', { tripId: 1, ...args });
const of = (r, key) => r.findings.filter((f) => f.key === key);
const asgPlace = (trip, asgId) => trip.days.flatMap((d) => d.assignments).find((a) => a.id === asgId).place;

describe('visit duration read from a text', () => {
  it('reads the durations the notes state', () => {
    expect(parseVisit('Randonnée du lac, 4 h aller-retour')).toMatchObject({ min: 240, max: null });
    expect(parseVisit('Sentier panoramique : 2h30 aller-retour.')).toMatchObject({ min: 150 });
    expect(parseVisit('Visite guidée de 11 h 45 à 15 h 05')).toMatchObject({ min: 200 });
    expect(parseVisit('from 9:30 to 11:00, then lunch')).toMatchObject({ min: 90 });
    expect(parseVisit('Compter 1 h 30 sur place')).toMatchObject({ min: 90 });
    expect(parseVisit('Loop hike, 2-3 h')).toMatchObject({ min: 120, max: 180 });
    expect(parseVisit('Allow 45 min for the visit')).toMatchObject({ min: 45 });
    expect(parseVisit('Lake walk, 2 h.').quote).toContain('lake walk, 2 h');
  });

  it('takes no clock time or opening hours for a duration', () => {
    for (const txt of ['Check-in 8h–21h. Hot showers.', 'Ouvert 9h', 'Visit at 14h with the guide', 'Opening hours — Tuesday: 9h00–12h00.', 'Hike, 3 h – 2 h', 'de 15 h à 11 h', '', null]) {
      expect(parseVisit(txt), String(txt)).toBeNull();
    }
    expect(parseVisit('visit 2 min')).toBeNull(); // under 5 min: not a visit
    expect(parseVisit('walk 8h-21h')).toBeNull(); // a span of hours, not a duration
    // opening hours written as a span are not a visit
    expect(parseVisit('Ouvert 7 j/7 de 8h30 a 20h30. Magasin declare')).toBeNull();
    expect(parseVisit('Open daily from 9:00 to 17:00')).toBeNull();
    expect(parseVisit('Geöffnet von 10:00 bis 16:00')).toBeNull();
    expect(parseVisit('de 7 h à 19 h')).toBeNull(); // 12 h on site: opening hours
    expect(parseVisit('Visite guidée de 11 h 45 à 15 h 05')).toMatchObject({ min: 200 });
  });

  it('takes the recorded duration first, then the stop\'s times that day, then TREK\'s field', () => {
    const info = pi.merge(null, { visit_min_minutes: 200 });
    expect(stopMinutes({ time: 600, end: 660 }, info)).toBe(200);
    expect(stopMinutes({ time: 600, end: 660 }, null)).toBe(60);
    expect(stopMinutes({ time: 600, end: null, duration: 45 }, pi.blank())).toBe(45);
    expect(stopMinutes({ time: null, end: null, duration: null }, null)).toBeNull();
    expect(stopMinutes({ time: 660, end: 600, duration: 0 }, null)).toBeNull();
  });
});

describe('visit duration on the record', () => {
  it('validates, rounds, keeps max over min, and formats', () => {
    const r = pi.merge(null, { visit_min_minutes: 120.4, visit_max_minutes: '210' });
    expect(r).toMatchObject({ visit_min_minutes: 120, visit_max_minutes: 210 });
    expect(pi.visitText(r)).toBe('2 h – 3 h 30');
    expect(pi.visitText(pi.merge(null, { visit_min_minutes: 45 }))).toBe('45 min');
    expect(pi.visitText(pi.merge(null, { visit_max_minutes: 90 }))).toBe('1 h 30');
    expect(pi.visitText(pi.merge(null, { visit_min_minutes: 60, visit_max_minutes: 60 }))).toBe('1 h');
    expect(pi.visitText(pi.blank())).toBeNull();
    expect(pi.visitText(null)).toBeNull();
    expect(pi.duration(null)).toBeNull();
    expect(() => pi.merge(null, { visit_min_minutes: 120, visit_max_minutes: 60 })).toThrow(/visit_max_minutes must be at least/);
    expect(() => pi.merge(null, { visit_min_minutes: 2 })).toThrow(/visit_min_minutes must be a number between 5 and 1440/);
    expect(pi.merge(r, { visit_min_minutes: null }).visit_min_minutes).toBeNull();
    expect(pi.clearPatch(['visit_min_minutes', 'visit_max_minutes'])).toEqual({ visit_min_minutes: null, visit_max_minutes: null });
  });

  it('keeps the automatic source while the value stays, drops it when a person changes it', () => {
    const auto = pi.merge(null, { visit_min_minutes: 120, visit_source: 'place notes: "walk, 2 h"' });
    expect(pi.merge(auto, { visit_min_minutes: 120 }).visit_source).toBe('place notes: "walk, 2 h"'); // the form sends it back
    expect(pi.merge(auto, { visit_min_minutes: 90 }).visit_source).toBeNull();
    expect(pi.merge(auto, { visit_min_minutes: null }).visit_source).toBeNull();
    expect(pi.merge(auto, { visit_source: '' }).visit_source).toBeNull();
  });
});

describe('visit duration through the plugin', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('fill takes it from the notes, quoting them, and never over a typed one', async () => {
    const trip = build();
    trip.places.find((p) => p.id === 17).notes = 'Rundweg um den See: 1 h 30 sur place.';
    const h = makeHost({ trip });
    await pi.set(h.ctx, 1, 10, { visit_min_minutes: 300 }); // typed for the lake of Braies
    const r = await fillLib.fill(h.ctx, 1, { park4night: false, language: 'fr', placeIds: [10, 17] });
    expect(r.visits).toBe(1);
    expect(await pi.get(h.ctx, 17)).toMatchObject({ visit_min_minutes: 90, visit_source: expect.stringMatching(/^@src\.notes: ".*1 h 30 sur place/) });
    expect(pi.localized(await pi.get(h.ctx, 17), 'fr').visit_source).toMatch(/^notes du lieu: /);
    expect((await pi.get(h.ctx, 10)).visit_min_minutes).toBe(300);
  });

  it('vanlife_place sets and reads it; the planner shows a Timer chip; the widget gets it', async () => {
    const h = makeHost({ userSettings: { language: 'fr' }, queryResults: { [pi.INDEX_SQL]: [{ place_id: 11 }] } });
    const saved = await call(h, 'vanlife_place', { tripId: 1, placeId: 11, set: { visit_min_minutes: 210, visit_max_minutes: 240 } });
    expect(saved).toMatchObject({ visit: '3 h 30 – 4 h', record: { visit_min_minutes: 210, visit_max_minutes: 240 } });
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: 11, set: { visit_min_minutes: 5000 } })).rejects.toThrow(/visit_min_minutes/);
    const cols = await h.run(plugin).hook('tableContributor', 'getContributions', 'places', 1);
    expect(cols.find((x) => x.entityId === 11 && x.id === 'vanlife-visit')).toMatchObject({ label: 'Visite', value: '3 h 30 – 4 h', icon: 'Timer' });
    const w = JSON.parse((await h.run(plugin).route({ method: 'POST', path: '/amenities' }, { body: { tripId: 1, placeId: 11 } })).body);
    expect(w).toMatchObject({ visitText: '3 h 30 – 4 h' });
    expect(w.strings).toMatchObject({ 'ui.visitMin': 'Durée minimale sur place (min)' });
    const spec = TOOL_SPECS.find((t) => t.name === 'vanlife_place').inputSchema.properties.set.properties;
    expect(spec.visit_min_minutes).toMatchObject({ type: 'integer', minimum: 5, maximum: 1440, nullable: true });
  });

  it('the schedule uses the recorded duration of a stop with no times', async () => {
    const trip = build();
    Object.assign(asgPlace(trip, 3001), { place_time: null, end_time: null }); // Lago di Carezza
    const h = makeHost({ trip, queryResults: { [pi.INDEX_SQL]: [{ place_id: 17 }] } });
    await pi.set(h.ctx, 1, 17, { visit_min_minutes: 95 });
    const r = await call(h, 'vanlife_day', { tripId: 1, action: 'schedule', dayNumber: 3 });
    expect(r.stops.find((s) => s.placeId === 17).stayMinutes).toBe(95);
  });
});

describe('the day\'s load in the check', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('flags an overloaded day: visits + real drive times + a meal break, against the usable day', async () => {
    const h = makeHost({ userSettings: { language: 'fr', timezone: 'Europe/Rome' }, queryResults: { [pi.INDEX_SQL]: [{ place_id: 10 }] } });
    await h.ctx.meta.set('place', 10, pi.META_KEY, pi.merge(null, { visit_min_minutes: 480 }));
    const [f] = of(await check(h), 'day_overloaded');
    expect(f).toMatchObject({ level: 'fix', dayNumber: 1 });
    // shop 30 + museum 60 + lake 480, then the drives, then 30 min for the meal (over 6 h)
    expect(f.visitMinutes).toBe(570);
    expect(f.needMinutes).toBe(f.visitMinutes + f.driveMinutes + 30);
    expect(f.driveMinutes).toBeGreaterThan(0);
    expect(f.windowMinutes).toBeLessThan(f.needMinutes);
    expect(f.message).toMatch(/^J1 .* — \d+ h \d{2} nécessaires \(visites 9 h 30, route .*\) pour \d+ h \d{2} de jour utile \(08:30–\d\d:\d\d\) : retirer ou déplacer Lago di Braies, Mountain Museum Example$/);
  });

  it('starts the usable day at the setting, or at an earlier first stop', async () => {
    const h = makeHost({ userSettings: { timezone: 'Europe/Rome', day_start: '06:00' }, queryResults: { [pi.INDEX_SQL]: [{ place_id: 10 }] } });
    await h.ctx.meta.set('place', 10, pi.META_KEY, pi.merge(null, { visit_min_minutes: 600 }));
    const early = of(await check(h), 'day_overloaded')[0];
    const h2 = makeHost({ userSettings: { timezone: 'Europe/Rome' }, queryResults: { [pi.INDEX_SQL]: [{ place_id: 10 }] } });
    await h2.ctx.meta.set('place', 10, pi.META_KEY, pi.merge(null, { visit_min_minutes: 600 }));
    const late = of(await check(h2), 'day_overloaded')[0];
    expect(early.windowMinutes - late.windowMinutes).toBe(150);
    expect(early.message).toContain('(06:00–');
    const trip = build();
    asgPlace(trip, 1002).place_time = '07:15'; // a first stop earlier than 08:30
    const h3 = makeHost({ trip, userSettings: { timezone: 'Europe/Rome' }, queryResults: { [pi.INDEX_SQL]: [{ place_id: 10 }] } });
    await h3.ctx.meta.set('place', 10, pi.META_KEY, pi.merge(null, { visit_min_minutes: 600 }));
    expect(of(await check(h3), 'day_overloaded')[0].message).toContain('(07:15–');
    // a day that fits, and no meal break under 6 h: nothing
    expect(of(await check(makeHost({ userSettings: { timezone: 'Europe/Rome' } })), 'day_overloaded')).toEqual([]);
  });

  it('a bad day_start falls back to 08:30; the new settings are declared', async () => {
    const s = await readSettings(makeHost({ userSettings: { day_start: '25:99', big_activity_minutes: '200' } }).ctx);
    expect(s).toMatchObject({ day_start: '08:30', big_activity_minutes: 200 });
    expect(DEFAULTS).toMatchObject({ day_start: '08:30', big_activity_minutes: 150 });
    const keys = manifest.settings.map((x) => x.key);
    expect(keys).toEqual(expect.arrayContaining(['day_start', 'big_activity_minutes']));
  });

  it('one big activity a day, or at most two small ones', async () => {
    // day 1: the lake 2 h and the museum 1 h; day 2: two visits of 1 h (fine)
    const r = await check(makeHost({ userSettings: { timezone: 'Europe/Rome' } }));
    const busy = of(r, 'too_many_activities');
    expect(busy.map((f) => [f.level, f.dayNumber])).toEqual([['fix', 1]]);
    expect(busy[0].message).toContain('Lago di Braies (2 h), Mountain Museum Example (1 h)');
    expect(busy[0].message).toContain('one big activity a day (from 2 h 30), or at most two small ones (up to 1 h)');
    // two big ones on day 2
    const h = makeHost({ userSettings: { timezone: 'Europe/Rome' }, queryResults: { [pi.INDEX_SQL]: [{ place_id: 14 }, { place_id: 15 }] } });
    await h.ctx.meta.set('place', 14, pi.META_KEY, pi.merge(null, { visit_min_minutes: 150 }));
    await h.ctx.meta.set('place', 15, pi.META_KEY, pi.merge(null, { visit_min_minutes: 180 }));
    const two = of(await check(h), 'too_many_activities').find((f) => f.dayNumber === 2);
    expect(two.params.nBig).toBe(2);
    // one big one alone is fine
    const one = makeHost({ userSettings: { timezone: 'Europe/Rome' }, queryResults: { [pi.INDEX_SQL]: [{ place_id: 17 }] } });
    await one.ctx.meta.set('place', 17, pi.META_KEY, pi.merge(null, { visit_min_minutes: 240 }));
    expect(of(await check(one), 'too_many_activities').some((f) => f.dayNumber === 3)).toBe(false);
    // a big hike plus a 20-minute stop on the way is still one activity
    // (a planned slot longer than the recorded minimum is what the day counts: the stop is planned 20 min)
    const short = build();
    short.days[1].assignments.find((a) => a.id === 2003).place.end_time = '14:20';
    const stop = makeHost({ trip: short, userSettings: { timezone: 'Europe/Rome' }, queryResults: { [pi.INDEX_SQL]: [{ place_id: 14 }, { place_id: 15 }] } });
    await stop.ctx.meta.set('place', 14, pi.META_KEY, pi.merge(null, { visit_min_minutes: 240 }));
    await stop.ctx.meta.set('place', 15, pi.META_KEY, pi.merge(null, { visit_min_minutes: 20 }));
    expect(of(await check(stop), 'too_many_activities').some((f) => f.dayNumber === 2)).toBe(false);
    // but a 45-minute visit next to it counts as a second (small) activity
    await stop.ctx.meta.set('place', 15, pi.META_KEY, pi.merge(null, { visit_min_minutes: 45 }));
    expect(of(await check(stop), 'too_many_activities').some((f) => f.dayNumber === 2)).toBe(true);
  });

  it('a car park is not an activity, and on a hike day its time is the hike\'s', async () => {
    const trip = build();
    const day2 = trip.days[1].assignments;
    const lake = day2.find((a) => a.place.id === 14).place;
    const park = day2.find((a) => a.place.id === 15).place;
    lake.category = { id: 90, name: 'See – Hike' };
    park.category = { id: 91, name: 'Route – Parking' };
    const h = makeHost({ trip, userSettings: { timezone: 'Europe/Rome' }, queryResults: { [pi.INDEX_SQL]: [{ place_id: 14 }, { place_id: 15 }] } });
    await h.ctx.meta.set('place', 14, pi.META_KEY, pi.merge(null, { visit_min_minutes: 240 }));
    await h.ctx.meta.set('place', 15, pi.META_KEY, pi.merge(null, { visit_min_minutes: 240 }));
    const r = await check(h);
    expect(of(r, 'too_many_activities').some((f) => f.dayNumber === 2)).toBe(false);
    expect(of(r, 'day_overloaded').some((f) => f.dayNumber === 2)).toBe(false);
  });

  it('lists the visits whose duration nobody knows, not the shop', async () => {
    const trip = build();
    Object.assign(asgPlace(trip, 1002), { place_time: null, end_time: null });
    Object.assign(asgPlace(trip, 1004), { place_time: null, end_time: null });
    const r = await check(makeHost({ trip, userSettings: { timezone: 'Europe/Rome', language: 'fr' } }));
    const u = of(r, 'visit_unknown');
    expect(u.map((f) => [f.level, f.dayNumber])).toEqual([['verify', 1]]);
    expect(u[0].message).toContain('durée de visite inconnue : Lago di Braies');
    expect(u[0].message).not.toContain('Supermarket');
  });

  it('the banner shows an overloaded day from cached drive times, never the unknown durations', async () => {
    const trip = build();
    Object.assign(asgPlace(trip, 3001), { place_time: null, end_time: null });
    const h = makeHost({ trip, userSettings: { timezone: 'Europe/Rome' }, queryResults: { [pi.INDEX_SQL]: [{ place_id: 10 }] } });
    await h.ctx.meta.set('place', 10, pi.META_KEY, pi.merge(null, { visit_min_minutes: 600 }));
    expect(of(await check(h), 'visit_unknown')).toHaveLength(1); // the tool fills the drive-time cache
    const settings = await readSettings(h.ctx);
    // what the banner computes: no network, cached drive times only
    const r = await checkTrip(h.ctx, await loadTrip(h.ctx, 1, settings), { settings, network: false, deadline: deadline(3500) });
    const f = of(r, 'day_overloaded')[0];
    expect(bannerText(f, settings)).toMatch(/^D1: \d+ h \d{2} needed for \d+ h \d{2}$/);
    const shown = bannerFrom(r.findings.filter((x) => ['day_overloaded', 'visit_unknown'].includes(x.key)), settings);
    expect(shown.map((x) => x.message)).toEqual([bannerText(f, settings)]);
    // without a cached drive time the day is not judged
    const cold = makeHost({ trip, userSettings: { timezone: 'Europe/Rome' } });
    const rc = await checkTrip(cold.ctx, await loadTrip(cold.ctx, 1, settings), { settings, network: false, deadline: deadline(3500) });
    expect(of(rc, 'day_overloaded')).toEqual([]);
  });
});

describe('possible savings in the check', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('a cheaper legal open night within 20 min, from the night search\'s cache, with its net saving', async () => {
    const h = makeHost({ userSettings: { timezone: 'Europe/Rome' } });
    expect(of(await check(h), 'saving_night')).toEqual([]); // nothing searched yet: nothing claimed
    await call(h, 'vanlife_find_nights', { tripId: 1, dayNumber: 1 });
    const [f] = of(await check(h), 'saving_night');
    expect(f).toMatchObject({ level: 'verify', dayNumber: 1, placeId: 13 });
    expect(f.message).toMatch(/"Camping Lakeside Example" \(€18\.00, 12 min detour\) is legal, open and cheaper than "Camping Example" \(€38\.00\): saves €\d+\.\d\d net of fuel/);
    expect(f.savingAmount).toBeGreaterThan(15);
    expect(f.savingAmount).toBeLessThan(20); // fuel of the detour taken off
    // a far cheaper campsite whose detour is over 20 min is not proposed; 20 min exactly is
    const base = stubFetch();
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const res = await base(url, init);
      if (!String(url).includes('overpass') || !/camp_site/.test(decodeURIComponent(String(init.body)))) return res;
      const body = await res.json();
      body.elements = [...body.elements, { type: 'node', id: 7, lat: 46.66, lon: 12.42, tags: { tourism: 'camp_site', name: 'Camping Far Cheap Example', charge: '5 EUR', tents: 'yes', dog: 'yes' } }];
      return { ok: true, status: 200, json: async () => body };
    }));
    const far = makeHost({ userSettings: { timezone: 'Europe/Rome' } });
    const found = await call(far, 'vanlife_find_nights', { tripId: 1, dayNumber: 1 });
    expect(found.candidates.find((c) => c.name === 'Camping Far Cheap Example').detourMinutes).toBeGreaterThan(20);
    expect(of(await check(far), 'saving_night')[0].message).toContain('Camping Lakeside Example');
    vi.stubGlobal('fetch', stubFetch());
    const van = makeHost({ userSettings: { timezone: 'Europe/Rome', vehicle: 'campervan' } });
    await call(van, 'vanlife_find_nights', { tripId: 1, dayNumber: 1 });
    expect(of(await check(van), 'saving_night')[0].message).toContain('"Motorhome Area Example" (€10.00, 20 min detour)');
    // a night within the target price: not challenged
    const cheap = makeHost({ userSettings: { timezone: 'Europe/Rome', night_price_target: 40 } });
    await call(cheap, 'vanlife_find_nights', { tripId: 1, dayNumber: 1 });
    expect(of(await check(cheap), 'saving_night')).toEqual([]);
  });

  function backTrip() {
    const trip = build();
    // night 2 back at Camping Example, and the visitor centre moved west of it: tomorrow's
    // first stop (Lago di Carezza) is west too, so the camp is a detour backwards
    Object.assign(trip.accommodations[1], { place_id: 13, place_name: P.camping.name, place_lat: P.camping.lat, place_lng: P.camping.lng });
    trip.days[1].assignments.find((a) => a.id === 2004).place = { ...asgPlace(trip, 1005), place_time: '17:00' };
    Object.assign(asgPlace(trip, 2003), { lat: 46.45, lng: 11.9 });
    return trip;
  }

  it('coming back to the same camp against tomorrow\'s direction: km and fuel lost', async () => {
    const r = await check(makeHost({ trip: backTrip(), userSettings: { timezone: 'Europe/Rome', language: 'fr' } }));
    const [f] = of(r, 'backtrack');
    expect(f).toMatchObject({ level: 'verify', dayNumber: 2, placeId: 13 });
    expect(f.extraKm).toBeGreaterThan(40);
    expect(f.message.replace(/\u202f|\u00a0/g, ' ')).toMatch(/retour à « Camping Example » ce soir, puis \d+ km en arrière vers « Lago di Carezza » demain \(environ \d+,\d\d € de carburant\) : chercher une nuit sur la route du lendemain — la tente de toit est pliée chaque matin/);
    // the same camp with the last visit next door: hardly any km lost, nothing said
    const near = backTrip();
    Object.assign(asgPlace(near, 2003), { lat: P.visitor.lat, lng: P.visitor.lng });
    expect(of(await check(makeHost({ trip: near, userSettings: { timezone: 'Europe/Rome' } })), 'backtrack')).toEqual([]);
    const van = await check(makeHost({ trip: backTrip(), userSettings: { timezone: 'Europe/Rome', vehicle: 'campervan' } }));
    expect(of(van, 'backtrack')[0].message).not.toMatch(/rooftop tent/);
    expect(of(await check(makeHost({ userSettings: { timezone: 'Europe/Rome' } })), 'backtrack')).toEqual([]);
  });

  it('knows the camp of a day inside a stay of several nights', () => {
    const days = [{ id: 1, index: 0 }, { id: 2, index: 1 }, { id: 3, index: 2 }];
    const model = { days, nights: [{ placeId: 9, startDayId: 1, endDayId: 3, startIndex: 0, nights: 2 }] };
    expect(stayOn(model, days[0]).placeId).toBe(9);
    expect(stayOn(model, days[1]).placeId).toBe(9);
    expect(stayOn(model, days[2])).toBeNull();
    expect(stayBefore(model, days[0])).toBeNull();
    expect(stayBefore(model, days[2]).placeId).toBe(9);
  });

  it('plan_trip reports the load and the savings and turns them into actions', async () => {
    const h = makeHost({ userSettings: { timezone: 'Europe/Rome' }, queryResults: { [pi.INDEX_SQL]: [{ place_id: 10 }] } });
    await h.ctx.meta.set('place', 10, pi.META_KEY, pi.merge(null, { visit_min_minutes: 600 }));
    await call(h, 'vanlife_find_nights', { tripId: 1, dayNumber: 1 });
    const r = await call(h, 'vanlife_plan_trip', { tripId: 1 });
    expect(r.results.load.overloadedDays[0]).toMatchObject({ day: 1 });
    expect(r.results.load.savings.find((s) => s.key === 'saving_night')).toMatchObject({ day: 1 });
    expect(r.actions.find((a) => /needed \(visits/.test(a.action)).priority).toBe(2);
    expect(r.actions.find((a) => /too much for one day/.test(a.action)).priority).toBe(2);
    expect(r.actions.find((a) => /net of fuel/.test(a.action)).priority).toBeLessThanOrEqual(3);
    const sched = (r.results.schedule || []).find((d) => d.day === 1);
    if (sched) expect(sched.stays.length).toBeGreaterThan(0);
  });
});

describe('route place named in the user\'s language', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('writes "Route jour 2 — …" for a French user', async () => {
    const trip = build();
    const h = makeHost({ trip, userSettings: { language: 'fr', timezone: 'Europe/Rome' } });
    await call(h, 'vanlife_day', { action: 'routes', tripId: 1, dayNumbers: [2], apply: true });
    const created = trip.places.find((x) => /^Route jour 2 — Camping Example → Aire Example Misurina \(\d+ km, /.test(x.name));
    expect(created).toBeTruthy();
    expect(trip.places.some((x) => /^Route day 2 — /.test(x.name))).toBe(false);
  });
});

describe('0.4.3 strings', () => {
  it('are in all 27 languages, translated, with their placeholders', () => {
    const keys = ['col.visit', 'ui.visit', 'ui.visitMin', 'ui.visitMax', 'day_overloaded', 's.day_overloaded', 'too_many_activities', 's.too_many_activities', 'visit_unknown', 's.visit_unknown', 'saving_night', 's.saving_night', 'backtrack', 'backtrack_tent', 's.backtrack', 'route.name'];
    const holders = { day_overloaded: ['{need}', '{window}', '{list}'], saving_night: ['{alt}', '{saving}'], backtrack: ['{km}', '{tent}'], 'route.name': ['{n}', '{from}', '{to}'] };
    expect(CODES).toHaveLength(27);
    for (const code of CODES) {
      for (const k of keys) expect(MESSAGES[code][k], `${code} ${k}`).toBeTruthy();
      for (const [k, list] of Object.entries(holders)) for (const ph of list) expect(MESSAGES[code][k], `${code} ${k} ${ph}`).toContain(ph);
      if (code !== 'en') expect(MESSAGES[code].day_overloaded, code).not.toBe(MESSAGES.en.day_overloaded);
    }
  });
});

it('the trip model keeps the record for the load check', async () => {
  const h = makeHost({ queryResults: { [pi.INDEX_SQL]: [{ place_id: 10 }] } });
  await h.ctx.meta.set('place', 10, pi.META_KEY, pi.merge(null, { visit_min_minutes: 75 }));
  const m = await loadTrip(h.ctx, 1, await readSettings(h.ctx));
  expect(m.poolById.get(10).info.visit_min_minutes).toBe(75);
});
