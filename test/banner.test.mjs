import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { require, makeHost, stubFetch } from './helpers.mjs';
import { createRequire } from 'node:module';

const plugin = require('../server/index.js');
const { shortName, bannerText, bannerFrom, BANNER_MAX } = require('../server/lib/report.js');
const { build } = require('./fixtures/trip.js');

const banner = (h) => h.run(plugin).hook('warningProvider', 'getWarnings', 1);
// What a chip shows before it is cut: the navbar slot is ~42 % of 1280 px shared by up to
// 4 chips at 12 px, i.e. about 30 characters each.
const VISIBLE = 30;

describe('warnings banner', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('sends few short lines, worst first, with no level word, and one summary chip', async () => {
    const w = await banner(makeHost());
    expect(w.length).toBeLessThanOrEqual(BANNER_MAX + 1);
    expect(fetch).not.toHaveBeenCalled(); // cache only, never the network
    const lines = w.slice(0, -1);
    expect(lines.every((x) => x.level === 'error')).toBe(true); // 5 blocking: only those get a chip
    expect(lines.map((x) => x.message)).toEqual([
      'D1 Camping Example: arrives 18:40, latest 17:31',
      'D2 Visitor Centre Ex…: closed at 14:00 (09:00–12:00)',
      'D2 Aire Example Misu…: motorhome area: no tent',
    ]);
    expect(lines.every((x) => !/BLOCKING|TO FIX|TO VERIFY/.test(x.message))).toBe(true);
    // the day and the place are inside the visible part of every chip
    expect(lines.every((x) => /^D\d+ \S/.test(x.message.slice(0, VISIBLE)))).toBe(true);
    expect(lines.every((x) => x.message.length <= 60)).toBe(true);
    expect(lines[0]).toMatchObject({ dayId: 101, placeId: 13 });
    const sum = w[w.length - 1];
    expect(sum).toEqual({ level: 'warning', message: expect.stringMatching(/^\+ \d+ more points to check$/) });
    // every warning counted once: shown + summed up = blocking + fix + verify
    const total = +sum.message.match(/\d+/)[0] + lines.length;
    const check = await h2check();
    // ...except "no contact for this night", which only the tools list (one per night at first)
    const noContact = check.findings.filter((f) => f.key === 'night_no_contact').length;
    expect(noContact).toBe(3);
    expect(total).toBe(check.counts.blocking + check.counts.fix + check.counts.verify - noContact);
  });

  const price = (day) => ({ level: 'verify', key: 'price_high', dayNumber: day, dayId: 100 + day, params: { name: `Camping ${day} Example`, price: '41,00 €', max: '35,00 €' } });
  const fix = (day) => ({ level: 'fix', key: 'no_trace', dayNumber: day, dayId: 100 + day, params: {} });
  const fr = { language: 'fr', night_price_max: 35, currency: 'EUR' };
  const nb = (m) => m.replace(/\u202f|\u00a0/g, ' ');

  it('groups prices above the ceiling into ONE chip, never one chip each', () => {
    const w = bannerFrom([1, 2, 3, 4, 5].map(price), fr);
    expect(w.map((x) => [x.level, nb(x.message)])).toEqual([['info', '+ 5 nuits au-dessus de 35,00 €']]);
  });

  it('shows to-verify points one by one only when 3 at most remain', () => {
    expect(bannerFrom([price(1), price(2)], fr).map((x) => x.message)).toEqual(['J1 Camping 1 Example : 41,00 € > 35,00 €', 'J2 Camping 2 Example : 41,00 € > 35,00 €']);
    expect(bannerFrom([fix(1), price(2), price(3)], fr).map((x) => x.message)).toEqual(['J1 : pas de tracé', 'J2 Camping 2 Example : 41,00 € > 35,00 €', 'J3 Camping 3 Example : 41,00 € > 35,00 €']);
    const w = bannerFrom([fix(1), fix(2), price(3), price(4)], fr);
    expect(w.map((x) => nb(x.message))).toEqual(['J1 : pas de tracé', 'J2 : pas de tracé', '+ 2 nuits au-dessus de 35,00 €']);
    // the real case of 2026-10-03: one farm risk and five prices — the farm keeps its own chip
    const farm = { level: 'verify', key: 'night_farm_zone', dayNumber: 2, dayId: 102, params: { name: 'Farm Example — farm (Town)', zone: 'Tyrol du Sud' } };
    expect(bannerFrom([farm, price(3), price(4), price(5), price(6), price(7)], fr).map((x) => nb(x.message)))
      .toEqual(['J2 Farm Example : ferme au Tyrol du Sud', '+ 5 nuits au-dessus de 35,00 €']);
  });

  it('caps severe points at 3 chips and sums up the rest, severe or not', () => {
    const w = bannerFrom([fix(1), fix(2), fix(3), fix(4), price(5)], fr);
    expect(w).toHaveLength(4);
    expect(w[3]).toEqual({ level: 'warning', message: '+ 2 autres points à vérifier' });
    expect(bannerFrom([], fr)).toEqual([]);
    expect(bannerFrom([{ level: 'info', key: 'night_margin', params: {} }], fr)).toEqual([]); // info never reaches the banner
    expect(bannerFrom([fix(1), fix(2), fix(3), { level: 'verify', key: 'night_private', dayNumber: 4, params: {} }], { language: 'en', night_price_max: 35 })[3])
      .toEqual({ level: 'info', message: '+ 1 points to verify' });
  });

  it('end to end in French: a private farm in South Tyrol raises no chip (allowed with the owner\'s consent)', async () => {
    const trip = build({ fixed: true });
    trip.reservations = []; trip.costs = []; trip.todos = [];
    // no to-fix point left: day 2's route first, a route for day 3, water at the aire
    trip.days[1].assignments.find((a) => a.place.id === 21).order_index = -1;
    trip.places.find((p) => p.id === 16).category_id = 1; // the aire becomes a campsite
    trip.places.find((p) => p.id === 18).notes = 'Farm, one night is ok.';
    trip.places.push({ id: 23, name: 'Route day 3', lat: 46.58, lng: 12.25, category_id: 6, route_geometry: JSON.stringify([[46.58, 12.25], [46.4097, 11.5753], [46.64, 11.72]]) });
    trip.days[2].assignments.unshift({ id: 3000, day_id: 103, order_index: -1, notes: null, accommodation_id: null, place: { id: 23, name: 'Route day 3', category: { id: 6, name: 'Route – Day route' } } });
    trip.places.find((p) => p.id === 16).notes = 'Drinking water.';
    const w = await banner(makeHost({ trip, userSettings: { language: 'fr', timezone: 'Europe/Rome' } }));
    expect(w.some((x) => /Farm Example/.test(x.message))).toBe(false);
    expect(w.every((x) => !/South Tyrol|TO VERIFY|À VÉRIFIER/.test(x.message))).toBe(true);
  });

  it('shortens place names to the words a person recognises', () => {
    expect(shortName('🏠≈ 40 € 🐾 · 3,0/5 · Camping Lakeside Example (Town)')).toBe('Camping Lakeside…');
    expect(shortName('Farm Example — farm (Town, 1 350 m)')).toBe('Farm Example');
    expect(shortName('Lake')).toBe('Lake');
    expect(shortName('')).toBe('');
    // a key without a short form falls back to the full sentence
    expect(bannerText({ key: 'night_margin', dayNumber: 1, params: { name: 'X', arr: '16:00', sunset: '18:00', margin: '2 h' } }, { language: 'en' })).toMatch(/^D1 X: night at "X"/);
    expect(bannerText({ key: 'resa_confirmed', scope: 'Bookings', params: { title: 'Camping Example (night 1)' } }, { language: 'en' })).toBe('Bookings Camping Example: marked booked: check it');
  });
});

async function h2check() {
  const r = require;
  const h = makeHost();
  const { loadTrip } = r('../server/lib/trip.js');
  const { checkTrip } = r('../server/lib/check.js');
  const { readSettings } = r('../server/lib/settings.js');
  const s = await readSettings(h.ctx);
  return checkTrip(h.ctx, await loadTrip(h.ctx, 1, s), { settings: s, network: false });
}
