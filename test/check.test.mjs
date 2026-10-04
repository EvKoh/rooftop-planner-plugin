import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeHost, stubFetch, require } from './helpers.mjs';

const { loadTrip } = require('../server/lib/trip.js');
const { checkTrip } = require('../server/lib/check.js');
const { readSettings } = require('../server/lib/settings.js');
const { deadline } = require('../server/lib/util.js');
const { build } = require('./fixtures/trip.js');

async function run(opts = {}) {
  const h = makeHost(opts);
  const settings = await readSettings(h.ctx);
  const model = await loadTrip(h.ctx, 1);
  return checkTrip(h.ctx, model, { settings, network: opts.network ?? true, deadline: deadline(12000) });
}
const has = (r, level, key, day) => r.findings.some((f) => f.level === level && f.key === key && (day == null || f.dayNumber === day));

describe('check_trip on the fictional trip', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('finds every planted defect at the right level', async () => {
    const r = await run();
    expect(r.ok).toBe(false);
    expect(has(r, 'blocking', 'night_late', 1)).toBe(true);
    expect(has(r, 'verify', 'closure_cited', 1)).toBe(true);
    expect(has(r, 'fix', 'shop_detour', 1)).toBe(true);
    expect(has(r, 'verify', 'price_high', 1)).toBe(true);
    expect(has(r, 'blocking', 'outside_hours', 2)).toBe(true);
    expect(has(r, 'blocking', 'night_aire', 2)).toBe(true);
    expect(has(r, 'fix', 'trace_not_first', 2)).toBe(true);
    expect(has(r, 'verify', 'night_farm_zone', 3)).toBe(true);
    expect(has(r, 'fix', 'water_fix', 3)).toBe(true);
    expect(has(r, 'blocking', 'min_nights', 3)).toBe(true);
    expect(has(r, 'fix', 'no_trace', 3)).toBe(true);
    expect(has(r, 'blocking', 'resa_confirmed')).toBe(true);
    expect(has(r, 'fix', 'resa_mismatch')).toBe(true);
    expect(has(r, 'fix', 'stale_budget')).toBe(true);
    expect(has(r, 'fix', 'budget_total')).toBe(true);
    expect(has(r, 'fix', 'stale_todo')).toBe(true);
    const detour = r.findings.find((f) => f.key === 'shop_detour');
    expect(detour.message).toMatch(/^Day 1 \(2026-10-12\) — \d+ min detour for "Supermarket Example"/);
    expect(+detour.message.match(/(\d+) min detour/)[1]).toBeGreaterThanOrEqual(30);
    const late = r.findings.find((f) => f.key === 'night_late');
    expect(late.message).toContain('arrival at "Camping Example" at 18:40 is TOO LATE');
    expect(late.placeId).toBe(13);
    // sorted: blocking first
    expect(r.findings[0].level).toBe('blocking');
    expect(r.counts.blocking).toBeGreaterThanOrEqual(5);
  });

  it('stays quiet on what the fixed trip corrects (it proved above that it detects them)', async () => {
    const r = await run({ fixed: true });
    expect(has(r, 'blocking', 'night_late', 1)).toBe(false);
    expect(has(r, 'blocking', 'outside_hours', 2)).toBe(false);
    expect(r.findings.some((f) => f.key === 'night_margin' && f.dayNumber === 1)).toBe(true);
  });

  it('writes messages in French when the user asks for it', async () => {
    const r = await run({ userSettings: { language: 'fr', timezone: 'Europe/Rome' } });
    const late = r.findings.find((f) => f.key === 'night_late');
    expect(late.message).toMatch(/^J1 \(2026-10-12\) — arrivée à « Camping Example » à 18:40 : TROP TARD/);
  });

  it('without network and with an empty cache, counts the drive times it could not check', async () => {
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    const r = await run({ network: false });
    expect(f).not.toHaveBeenCalled();
    expect(r.pendingRoutes).toBeGreaterThan(0);
    expect(has(r, 'fix', 'shop_detour')).toBe(false);
    expect(has(r, 'blocking', 'night_late', 1)).toBe(true); // sunset rules need no network
  });

  it('degrades when Valhalla is down: no false drive-time alarms, pending reported', async () => {
    vi.stubGlobal('fetch', stubFetch({ failValhalla: true }));
    const r = await run();
    expect(has(r, 'fix', 'unreachable')).toBe(false);
    expect(r.pendingRoutes).toBeGreaterThan(0);
    expect(has(r, 'info', 'route_pending')).toBe(true);
  });

  it('flags an impossible chain of times and overlapping stops', async () => {
    const trip = build({ fixed: true });
    const d2 = trip.days[1].assignments;
    d2[0].place.end_time = '11:40'; // Passo Giau until 11:40, then the visitor centre at 11:30
    const h = makeHost({ trip });
    const r = await checkTrip(h.ctx, await loadTrip(h.ctx, 1), { settings: await readSettings(h.ctx), deadline: deadline(12000) });
    expect(has(r, 'fix', 'overlap', 2)).toBe(true);
    expect(has(r, 'fix', 'unreachable', 2)).toBe(true);
  });

  it('checks route endpoints, missing times, check-in windows, tent bans and written arrivals', async () => {
    const trip = build({ fixed: true });
    trip.places.find((p) => p.id === 21).route_geometry = JSON.stringify([[46.0, 11.0], [46.1, 11.1]]);
    trip.days[2].assignments[0].place.place_time = null; // Lago di Carezza without time
    trip.days[0].assignments[3].place.end_time = '15:00'; // shop ends before it starts? no: equal
    trip.days[0].assignments[2].place.end_time = '12:30'; // museum ends before it starts
    trip.accommodations[0].notes = 'Arrival: 18h–21h. No camping on the pitches near the lake. Planned arrival 16h30';
    trip.accommodations[0].check_in = '19:00';
    const h = makeHost({ trip });
    const r = await checkTrip(h.ctx, await loadTrip(h.ctx, 1), { settings: await readSettings(h.ctx), deadline: deadline(12000) });
    expect(has(r, 'fix', 'trace_start', 2)).toBe(true);
    expect(has(r, 'fix', 'trace_end', 2)).toBe(true);
    expect(has(r, 'fix', 'no_time', 3)).toBe(true);
    expect(has(r, 'fix', 'ends_before_start', 1)).toBe(true);
    expect(has(r, 'blocking', 'welcome_window', 1)).toBe(true);
    expect(has(r, 'blocking', 'tent_banned', 1)).toBe(true);
    expect(has(r, 'fix', 'checkin_mismatch', 1)).toBe(true);
  });

  it('takes any place with a drawn route as the day\'s route, whatever its category', async () => {
    const trip = build();
    const fuel = { id: 30, name: 'Route day 3', lat: 46.4097, lng: 11.5753, category_id: 4, route_geometry: JSON.stringify([[46.4097, 11.5753], [46.64, 11.72]]) };
    trip.places.push({ ...fuel, trip_id: 1, description: '' });
    trip.days[2].assignments.unshift({ id: 3000, day_id: 103, order_index: -1, notes: null, accommodation_id: null, place: { ...fuel, place_time: '09:00', end_time: '16:00', description: '' } });
    const h = makeHost({ trip });
    const r = await checkTrip(h.ctx, await loadTrip(h.ctx, 1), { settings: await readSettings(h.ctx), deadline: deadline(12000) });
    expect(has(r, 'fix', 'no_trace', 3)).toBe(false);
  });

  it('says a wrong arrival once when the check-in field and the notes repeat it', async () => {
    const trip = build();
    trip.accommodations[0].check_in = '17:00';
    trip.accommodations[0].notes = 'Planned arrival 17h00';
    const h = makeHost({ trip });
    const r = await checkTrip(h.ctx, await loadTrip(h.ctx, 1), { settings: await readSettings(h.ctx), deadline: deadline(12000) });
    expect(r.findings.filter((f) => f.key === 'checkin_mismatch' && f.dayNumber === 1)).toHaveLength(1);
  });

  it('reports a day ending after sunset and a planned water refill', async () => {
    const trip = build({ fixed: true });
    trip.days[2].assignments[0].place.end_time = '19:30'; // Carezza until after sunset
    trip.days[2].notes_items = [{ text: 'Fill the 20 L at the fountain in the village.' }];
    const h = makeHost({ trip });
    const r = await checkTrip(h.ctx, await loadTrip(h.ctx, 1), { settings: await readSettings(h.ctx), deadline: deadline(12000) });
    expect(has(r, 'verify', 'after_sunset', 3)).toBe(true);
    expect(has(r, 'info', 'water_ok', 3)).toBe(true);
  });
});
