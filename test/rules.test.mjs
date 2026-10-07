import { describe, it, expect } from 'vitest';
import { require } from './helpers.mjs';

const rules = require('../server/lib/rules.js');
const { sunset, sunrise, tzOffsetMin } = require('../server/lib/sun.js');
const { zoneAt, ZONES } = require('../server/lib/zones.js');
const oh = require('../server/lib/opening-hours.js');
const cls = require('../server/lib/classify.js');
const u = require('../server/lib/util.js');
const { t, dayName, MESSAGES, lang, money, num, bundle, CODES } = require('../server/lib/i18n.js');
const { DEFAULTS, readSettings, highwayAllowed, fuelPerKm, instance } = require('../server/lib/settings.js');

describe('sun', () => {
  it('computes sunset for the date and place, in local time with DST', () => {
    expect(u.hhmm(sunset(46.4983, 11.3548, '2026-10-11', 'Europe/Rome'))).toBe('18:36');
    // clocks go back on the last Sunday of October: one hour earlier on the 26th
    expect(u.hhmm(sunset(46.4983, 11.3548, '2026-10-26', 'Europe/Rome'))).toBe('17:09');
    expect(u.hhmm(sunrise(46.4983, 11.3548, '2026-10-11', 'Europe/Rome'))).toBe('07:26');
  });
  it('returns null under the midnight sun and survives an unknown zone', () => {
    expect(sunset(78, 15, '2026-06-21', 'Europe/Oslo')).toBeNull();
    expect(tzOffsetMin('Not/AZone', new Date())).toBe(0);
  });
});

describe('zones', () => {
  it('tells South Tyrol from Veneto and Liguria', () => {
    expect(zoneAt(46.4983, 11.3548).id).toBe('south-tyrol'); // Bolzano
    expect(zoneAt(46.5405, 12.1357).id).toBe('veneto'); // Cortina d'Ampezzo
    expect(zoneAt(44.4056, 8.9463).id).toBe('liguria'); // Genoa
    expect(zoneAt(46.07, 11.12)).toBeNull(); // Trento: no rule known
    expect(zoneAt(null, 1)).toBeNull();
    expect(ZONES.every((z) => z.id && z.polygon.length >= 3)).toBe(true);
  });
});

describe('rules', () => {
  it('reads weekly closures in four languages, and neighbours', () => {
    expect(rules.closures('Fermé le lundi', 1, 600, 660)[0].key).toBe('closure_cited');
    expect(rules.closures('chiuso il lunedì', 1, 600)[0].key).toBe('closure_cited');
    expect(rules.closures('Montag Ruhetag', 1, 600)[0].key).toBe('closure_cited');
    expect(rules.closures('Closed on Tuesday', 1, 600)).toEqual([]);
    expect(rules.closures('The restaurant of the car park is closed on Monday', 1, 600, 700, { placeName: 'Lake' })[0].key).toBe('closure_neighbour');
    expect(rules.closures('Fermé le lundi', 1, 600, 660, { isNight: true })).toEqual([]);
  });
  it('blocks a visit outside the quoted opening hours', () => {
    const [f] = rules.closures('Lundi : 8h00–12h00', 1, 13 * 60, 14 * 60);
    expect(f).toMatchObject({ key: 'outside_hours', level: 'verify', params: { open: 480, close: 720 } });
    expect(rules.closures('Lundi : 8h00–12h00', 1, 9 * 60, 10 * 60)).toEqual([]);
  });
  it('reads check-in windows, minimum stays, water and tent bans', () => {
    expect(rules.welcomeWindow('Arrivée : 15h–23h')).toEqual([900, 1380]);
    expect(rules.welcomeWindow('Check-in: 14:00-20:00')).toEqual([840, 1200]);
    expect(rules.welcomeWindow('nothing')).toBeNull();
    expect(rules.minNights('2 nuits minimum')).toBe(2);
    expect(rules.minNights('minimum stay of 3 nights')).toBe(3);
    expect(rules.minNights('mindestens 2 Nacht')).toBe(2);
    expect(rules.minNights('2 nights minimum, but one night is ok')).toBeNull();
    expect(rules.minNights('no rule')).toBeNull();
    expect(rules.noWater('No water on site')).toBe(true);
    expect(rules.noWater('pas d\'eau, mais eau potable au village')).toBe(false);
    expect(rules.tentBanned('Strictly: no camping behaviour')).toContain('no camping');
    expect(rules.tentBanned('vietato aprire tendalino')).toContain('vietato');
    expect(rules.tentBanned('', { tents: 'no' })).toBe('tents=no');
    expect(rules.tentBanned('welcome')).toBeNull();
    expect(rules.writtenArrival('Planned arrival 18h40')).toBe(1120);
    expect(rules.writtenArrival('')).toBeNull();
  });
  it('judges the legality of a night by its ground and zone', () => {
    expect(rules.nightLegality({ categoryName: 'Night – Motorhome area', placeName: 'X' }).key).toBe('night_aire');
    // a private motorhome park: its operator may accept a rooftop tent → a point to confirm
    expect(rules.nightLegality({ categoryName: 'Night – Motorhome area', placeName: 'Example Camperpark', text: 'Private area, 90 pitches' })).toMatchObject({ key: 'night_private', level: 'verify' });
    expect(rules.nightLegality({ categoryName: 'Night – Motorhome area', placeName: 'Aire X', text: 'aire privée de 20 places' }).level).toBe('verify');
    // a communal one stays blocking
    expect(rules.nightLegality({ categoryName: 'Night – Motorhome area', placeName: 'Aire X', text: 'parking communal pour camping-cars, aire privée' }).key).toBe('night_aire');
    expect(rules.nightLegality({ categoryName: 'Nuitée – Ferme / agricamping', placeName: 'Hof', lat: 46.64, lng: 11.72 }).key).toBe('night_farm_zone');
    expect(rules.nightLegality({ categoryName: 'farm', placeName: 'Hof', lat: 46.64, lng: 11.72, text: 'authorised by the municipality' })).toBeNull();
    expect(rules.nightLegality({ categoryName: 'farm', placeName: 'Agriturismo', lat: 44.52, lng: 8.71 })).toBeNull();
    expect(rules.nightLegality({ categoryName: 'Chez l\'habitant', placeName: 'Garden' }).key).toBe('night_private');
    expect(rules.nightLegality({ categoryName: 'Night – Campsite', placeName: 'Camping', lat: 46.64, lng: 11.72 })).toBeNull();
  });
  it('judges the night by the vehicle: a van may sleep on an aire, a tent may not', () => {
    const aire = { categoryName: 'Night – Motorhome area', placeName: 'X', lat: 46.5405, lng: 12.1357 };
    expect(rules.nightLegality({ ...aire, vehicle: 'rooftop_tent' }).key).toBe('night_aire');
    expect(rules.nightLegality({ ...aire, vehicle: 'campervan' })).toBeNull();
    expect(rules.nightLegality({ ...aire, vehicle: 'motorhome' })).toBeNull();
    const park = { categoryName: 'Nuitée – geoSpot', placeName: 'Forest', lat: 46.4983, lng: 11.3548 };
    expect(rules.nightLegality({ ...park, vehicle: 'rooftop_tent' }).key).toBe('night_aire');
    expect(rules.nightLegality({ ...park, vehicle: 'campervan' })).toMatchObject({ key: 'night_wild', level: 'verify', params: { zoneId: 'south-tyrol', rule: 'van' } });
    expect(rules.nightLegality({ categoryName: 'parking', placeName: 'P', lat: 46.07, lng: 11.12, vehicle: 'motorhome' }).params).toEqual({ zoneId: null, rule: 'van' });
    // a farm in South Tyrol is a point to check for a tent only (protected areas, municipal rules)
    const farm = { categoryName: 'Night – Farm', placeName: 'Hof', lat: 46.64, lng: 11.72 };
    expect(rules.nightLegality({ ...farm, vehicle: 'rooftop_tent' }).key).toBe('night_farm_zone');
    expect(rules.nightLegality({ ...farm, vehicle: 'campervan' })).toBeNull();
    expect(rules.nightLegality({ categoryName: 'Campsite', placeName: 'C', vehicle: 'motorhome' })).toBeNull();
  });

  it('rates prices against the target and the ceiling', () => {
    const s = { night_price_target: 25, night_price_max: 35 };
    expect(rules.priceVerdict(null, s).key).toBe('price_unknown');
    expect(rules.priceVerdict(40, s).key).toBe('price_high');
    expect(rules.priceVerdict(30, s).key).toBe('price_target');
    expect(rules.priceVerdict(20, s)).toBeNull();
    expect(rules.latestArrival(1110, { sunset_margin_min: 60 })).toBe(1050);
    expect(rules.latestArrival(null, {})).toBeNull();
  });
});

describe('opening hours', () => {
  it('reads the usual OSM forms', () => {
    expect(oh.statusAt('Mo-Sa 08:00-20:00; Su off', '2026-10-11', 600)).toBe('closed');
    expect(oh.statusAt('Mo-Sa 08:00-20:00; Su off', '2026-10-12', 600)).toBe('open');
    expect(oh.statusAt('Mo-Sa 08:00-12:00,15:00-19:30', '2026-10-15', 700, 730)).toBe('closed');
    expect(oh.statusAt('Apr-Oct: Mo-Su 08:00-12:00', '2026-11-02', 600)).toBe('closed');
    expect(oh.statusAt('Apr-Oct: Mo-Su 08:00-12:00', '2026-10-02', 600)).toBe('open');
    expect(oh.statusAt('24/7', '2026-10-02', 100)).toBe('open');
    expect(oh.statusAt('Mo-Fr 22:00-02:00', '2026-10-02', 1400)).toBe('open');
    expect(oh.statusAt('Mo,We 09:00-10:00; PH off', '2026-10-14', 560)).toBe('open');
    expect(oh.statusAt('sunrise-sunset', '2026-10-02', 100)).toBe('unknown');
    expect(oh.statusAt('Xx 09:00-10:00', '2026-10-02', 100)).toBe('unknown');
    expect(oh.statusAt(null, '2026-10-02', 100)).toBe('unknown');
    expect(oh.hoursOn('24/7', '2026-10-02')).toBe('00:00-24:00');
    expect(oh.hoursOn('Mo-Sa 08:00-20:00; Su off', '2026-10-11')).toBe('closed');
    expect(oh.hoursOn('bad', '2026-10-11')).toBeNull();
  });
});

describe('classify', () => {
  it('reads the kind of night from category then name', () => {
    expect(cls.nightKind('Nuitée – Aire', 'Camping X')).toBe('aire');
    expect(cls.nightKind('Nuitée – Ferme / agricamping', '')).toBe('farm');
    expect(cls.nightKind('Nuitée – Camping', '')).toBe('campsite');
    expect(cls.nightKind('Nuitée – Chez l\'habitant', '')).toBe('private');
    expect(cls.nightKind('Night – Hut', '')).toBe('hut');
    expect(cls.nightKind('', 'Area sosta camper')).toBe('aire');
    expect(cls.nightKind('', 'Camping Lago')).toBe('campsite');
    expect(cls.nightKind('', 'Agriturismo Bello')).toBe('farm');
    expect(cls.nightKind('', 'Rifugio Alto')).toBe('hut');
    expect(cls.nightKind('', 'Hotel')).toBe('unknown');
    expect(cls.isShopping('Manger – Courses', null)).toBe(true);
    expect(cls.isShopping('x', 'fuel')).toBe(true);
    expect(require('../server/lib/design.js').isHikePlace({ name: 'x', categoryName: 'Voir – Randonnée' })).toBe(true);
    expect(require('../server/lib/design.js').isParkingPlace({ name: 'Car park Lago Example', categoryName: 'Voir' })).toBe(true);
    expect(cls.isTrace('Route – Tracé du jour', {})).toBe(true);
    expect(cls.isTrace('x', { route_geometry: '[]' })).toBe(true);
    expect(cls.parkingFromNotes('Départ : parking du lac, 46.5000, 11.7000')).toEqual([46.5, 11.7]);
    expect(cls.parkingFromNotes('nothing')).toBeNull();
  });
});

describe('util', () => {
  it('formats and measures', () => {
    expect(u.hm('9h')).toBe(540);
    expect(u.hm('18:05')).toBe(1085);
    expect(u.hm('')).toBeNull();
    expect(u.hm('abc')).toBeNull();
    expect(u.hhmm(1085)).toBe('18:05');
    expect(u.hhmm(null)).toBeNull();
    expect(u.toNum('12,5')).toBe(12.5);
    expect(u.toNum('x')).toBeNull();
    expect(u.toNum(null)).toBeNull();
    expect(u.polylineKm([[46, 11], [46.1, 11]])).toBeCloseTo(11.1, 0);
    expect(u.distToPolylineKm([46, 11], [[46.1, 11], [46, 11.001]])).toBeLessThan(0.1);
    expect(u.thin([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]], 2).length).toBeLessThanOrEqual(4);
    expect(u.thin([[0, 0]], 2)).toEqual([[0, 0]]);
    const d = u.deadline(1000, () => 0);
    expect(d.left()).toBe(1000);
    expect(d.expired()).toBe(false);
  });
  it('maps with bounded concurrency, keeping order', async () => {
    let live = 0;
    let peak = 0;
    const out = await u.pmap([1, 2, 3, 4, 5], 2, async (x) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 2)); live--; return x * 2; });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });
});

describe('i18n and settings', () => {
  it('has every key in every language', () => {
    const enKeys = Object.keys(MESSAGES.en).sort();
    const holes = (v) => [...new Set(JSON.stringify(v).match(/\{\w+\}/g) || [])].sort();
    expect(Object.keys(MESSAGES)).toHaveLength(27);
    for (const [code, msgs] of Object.entries(MESSAGES)) {
      expect(Object.keys(msgs).sort(), code).toEqual(enKeys);
      for (const key of enKeys) {
        expect(holes(msgs[key]), `${code} ${key}`).toEqual(holes(MESSAGES.en[key]));
        if (Array.isArray(MESSAGES.en[key])) expect(msgs[key], `${code} ${key}`).toHaveLength(MESSAGES.en[key].length);
      }
    }
    expect(t('fr', 'day', { n: 2, date: 'x' })).toBe('J2 (x)');
    expect(t('xx', 'day', { n: 2, date: 'x' })).toBe('Day 2 (x)');
    expect(t('en', 'unknown_key')).toBe('unknown_key');
    expect(dayName('fr', 1)).toBe('lundi');
  });
  it('maps any language tag to a TREK language and formats like that language', () => {
    expect(lang('fr-FR')).toBe('fr');
    expect(lang('pt-BR')).toBe('br');
    expect(lang('pt')).toBe('br');
    expect(lang('zh-Hant-TW')).toBe('zh-TW');
    expect(lang('zh-CN')).toBe('zh');
    expect(lang('el')).toBe('gr');
    expect(lang('xx')).toBe('en');
    expect(lang(null)).toBe('en');
    expect(lang('zh-TW')).toBe('zh-TW');
    expect(CODES).toHaveLength(27);
    const nb = (x) => x.replace(/\u202f|\u00a0/g, ' ');
    expect(nb(money(44.6, 'EUR', 'fr'))).toBe('44,60 €');
    expect(money(44.6, 'EUR', 'en')).toBe('€44.60');
    expect(money(5, 'ZZZ1', 'en')).toBe('5.00 ZZZ1');
    expect(money(null, 'EUR', 'en')).toBeNull();
    expect(num(2.1, 'fr')).toBe('2,1');
    expect(num(null, 'fr')).toBeNull();
    expect(Object.keys(bundle('fr', ['ui.'])).every((k) => k.startsWith('ui.'))).toBe(true);
    expect(dayName('xx', 0)).toBe('Sunday');
  });

  it('coerces settings and falls back to defaults', async () => {
    const vals = { vehicle_height_m: '2.1', dog: 'false', highway_days: 'weird', language: 'xx', night_price_max: -3, timezone: 'Europe/Rome' };
    const s = await readSettings({ settings: { get: async (k) => vals[k] } });
    expect(s.vehicle_height_m).toBe(2.1);
    expect(s.dog).toBe(false);
    expect(s.highway_days).toBe('first_last');
    expect(s.language).toBe('en');
    expect(s.night_price_max).toBe(DEFAULTS.night_price_max);
    expect(s.timezone).toBe('Europe/Rome');
    const broken = await readSettings({ settings: { get: async () => { throw new Error('no user'); } } });
    expect(broken).toEqual({ ...DEFAULTS, language: 'en', park4night: true });
    expect(highwayAllowed({ highway_days: 'first_last' }, 0, 5)).toBe(true);
    expect(highwayAllowed({ highway_days: 'first_last' }, 2, 5)).toBe(false);
    // A list of day numbers wins: a return split over two days keeps the motorway on both.
    expect(highwayAllowed({ highway_days: 'first_last', highway_day_numbers: '1, 8;9' }, 7, 9)).toBe(true);
    expect(highwayAllowed({ highway_days: 'first_last', highway_day_numbers: '1,8,9' }, 0, 9)).toBe(true);
    expect(highwayAllowed({ highway_days: 'always', highway_day_numbers: '1,8,9' }, 3, 9)).toBe(false);
    expect(highwayAllowed({ highway_days: 'never', highway_day_numbers: 'x, 0' }, 3, 9)).toBe(false);
    expect(highwayAllowed({ highway_days: 'always' }, 2, 5)).toBe(true);
    expect(highwayAllowed({ highway_days: 'never' }, 0, 5)).toBe(false);
    expect(fuelPerKm({ fuel_l_per_100km: 6, fuel_price_per_l: 2 })).toBeCloseTo(0.12);
    const van = await readSettings({ settings: { get: async (k) => ({ vehicle: 'campervan', language: 'auto' })[k] }, config: { default_language: 'de-DE', park4night_enabled: false } });
    expect(van).toMatchObject({ vehicle: 'campervan', language: 'de', park4night: false });
    expect((await readSettings({ settings: { get: async (k) => ({ vehicle: 'tank' })[k] } })).vehicle).toBe('rooftop_tent');
    expect(instance({ config: { park4night_enabled: 'false' } })).toEqual({ park4night: false, defaultLanguage: 'en' });
    expect(instance(null)).toEqual({ park4night: true, defaultLanguage: 'en' });
  });
});

describe('regressions found on a real trip (2026-10-03)', () => {
  it('does not read a statement of the law as a ban at the place', () => {
    expect(rules.tentBanned('Tente de toit : camping interdit hors camping au Tyrol du Sud.')).toBeNull();
    expect(rules.tentBanned('Camping prohibited outside campsites in this region.')).toBeNull();
    expect(rules.tentBanned('camping interdit hors camping; no camping on the beach')).toContain('no camping');
    expect(rules.tentBanned('Camping interdit sur ce parking.')).toContain('camping interdit');
  });
});

describe('closures read in any language TREK ships', () => {
  const rules = require('../server/lib/rules.js');
  const keyFor = (text, wd) => rules.closures(text, wd, 600, 720).map((f) => f.key);
  it('finds a closing day written in Spanish, Dutch, Russian or Japanese', () => {
    expect(keyFor('Museo. Cerrado los lunes.', 1)).toContain('closure_cited');
    expect(keyFor('Museum, maandag gesloten.', 1)).toContain('closure_cited');
    expect(keyFor('Музей: понедельник — закрыто.', 1)).toContain('closure_cited');
    expect(keyFor('博物館 月曜日 休業', 1)).toContain('closure_cited');
    // the same notes say nothing about another day
    expect(keyFor('Museo. Cerrado los lunes.', 2)).not.toContain('closure_cited');
  });
});

describe('the strict rule, anywhere in the world', () => {
  const rules = require('../server/lib/rules.js');
  it('flags a rooftop-tent night on ground it cannot place, far from any zone it knows', () => {
    const r = rules.nightLegality({ categoryName: 'Night', placeName: 'Lakeside spot', lat: 44.0, lng: -110.5, vehicle: 'rooftop_tent' });
    expect(r).toMatchObject({ key: 'night_ground_unknown', level: 'verify' });
    expect(t('en', 'night_ground_unknown', { name: 'Lakeside spot' })).toMatch(/never public ground/);
    // a campsite or a farm there is fine, a car park is blocking
    expect(rules.nightLegality({ categoryName: 'Night – Campsite', placeName: 'X', lat: 44.0, lng: -110.5 })).toBeNull();
    expect(rules.nightLegality({ categoryName: 'Night – Farm', placeName: 'X', lat: 44.0, lng: -110.5 })).toBeNull();
    expect(rules.nightLegality({ categoryName: 'Parking', placeName: 'X', lat: 44.0, lng: -110.5 })).toMatchObject({ level: 'blocking' });
  });

  it('takes the server\'s time zone until the user sets the trip\'s, never a fixed continent', () => {
    expect(DEFAULTS.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  });
});
