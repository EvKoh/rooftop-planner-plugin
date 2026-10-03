import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { require, makeHost, stubFetch, manifest } from './helpers.mjs';

const plugin = require('../server/index.js');
const { TOOL_SPECS, TOOL_NAMES, withDefaults } = require('../server/lib/tool-specs.js');
const { fit, sunTable } = require('../server/lib/tools.js');
const { parseToken, planRequest } = require('../server/lib/plan.js');
const { PermissionDenied } = require('trek-plugin-sdk/testing');
const { build } = require('./fixtures/trip.js');

const call = (h, name, args) => h.run(plugin).hook('mcpToolProvider', 'callTool', { name, args });

describe('manifest and tool declarations', () => {
  it('declares exactly the tools the code implements (the host advertises the intersection)', () => {
    expect(plugin.hooks.mcpToolProvider.tools).toEqual(manifest.capabilities.mcpTools.map((t) => t.name));
    expect(manifest.capabilities.mcpTools).toEqual(TOOL_SPECS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })));
    expect(TOOL_NAMES).toHaveLength(8);
  });

  it('keeps every schema within what the host enforces', () => {
    // Mirror of server/src/nest/plugins/mcp-tool-schema.ts (TREK 4.3): an unsupported
    // keyword fails the install instead of being ignored.
    const SUPPORTED = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples',
      'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems', 'nullable']);
    const walk = (s, depth, inProps) => {
      expect(depth).toBeLessThanOrEqual(5);
      for (const [k, v] of Object.entries(s)) {
        if (inProps) { expect(k).toMatch(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/); walk(v, depth + 1, false); continue; }
        expect(SUPPORTED.has(k), `keyword ${k}`).toBe(true);
        if (k === 'properties') walk(v, depth, true);
        if (k === 'items') walk(v, depth + 1, false);
        if (k === 'pattern') expect(v.length).toBeLessThanOrEqual(200);
        if (k === 'format') expect(['email', 'uuid', 'uri', 'date-time', 'date']).toContain(v);
        if (k === 'description' && typeof v === 'string') expect(v.length).toBeLessThanOrEqual(512);
      }
    };
    for (const t of manifest.capabilities.mcpTools) {
      expect(t.name).toMatch(/^[a-z0-9_]{1,48}$/);
      expect(t.name.startsWith('rooftop_tools_')).toBe(true);
      expect(t.description.length).toBeLessThanOrEqual(1024);
      expect(t.title.length).toBeLessThanOrEqual(80);
      expect(t.inputSchema.type).toBe('object');
      expect(JSON.stringify(t.inputSchema).length).toBeLessThanOrEqual(8192);
      walk(t.inputSchema, 0, false);
    }
    const desc = manifest.capabilities.mcpTools.find((t) => t.name === 'rooftop_tools_plan_trip').description;
    expect(desc).toMatch(/Never book/);
  });

  it('grants each outbound host it calls, and keeps settings and route profiles sane', () => {
    for (const host of manifest.egress) expect(manifest.permissions).toContain(`http:outbound:${host}`);
    expect(manifest.capabilities.routeProfiles.map((p) => p.id)).toEqual(['rooftop', 'rooftop-highway']);
    expect(manifest.settings.every((s) => s.scope === 'user')).toBe(true);
  });

  it('applies schema defaults by hand', () => {
    expect(withDefaults('rooftop_tools_find_nights', {})).toEqual({ radius_km: 15 });
    expect(withDefaults('rooftop_tools_compute_routes', { apply: true })).toEqual({ apply: true, startAt: 0 });
    expect(withDefaults('nope', null)).toEqual({});
  });
});

describe('MCP tools through the mock host', () => {
  let f;
  beforeEach(() => { f = stubFetch(); vi.stubGlobal('fetch', f); });
  afterEach(() => vi.unstubAllGlobals());

  it('check_trip filters levels and answers fast', async () => {
    const h = makeHost();
    const t0 = Date.now();
    const r = await call(h, 'rooftop_tools_check_trip', { tripId: 1, levels: ['blocking'] });
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(r.trip).toBe('Example rooftop loop');
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings.every((x) => x.level === 'blocking')).toBe(true);
    const fr = await call(h, 'rooftop_tools_check_trip', { tripId: 1, language: 'fr' });
    expect(fr.findings[0].message).toMatch(/^J\d/);
  });

  it('find_nights ranks legal cheap nights first and excludes motorhome areas', async () => {
    const h = makeHost();
    const r = await call(h, 'rooftop_tools_find_nights', { tripId: 1, dayNumber: 1 });
    expect(r.day.number).toBe(1);
    expect(r.excludedMotorhomeAreas).toBe(1);
    expect(r.candidates.some((c) => c.kind === 'aire')).toBe(false);
    const first = r.candidates[0];
    expect(first.blocked).toEqual([]);
    expect(first.price).not.toBeNull();
    const noTents = r.candidates.find((c) => c.name === 'Camping No Tents Example');
    expect(noTents.blocked.join()).toMatch(/tents not allowed/);
    expect(r.candidates.indexOf(noTents)).toBeGreaterThan(r.candidates.indexOf(first));
    const closed = r.candidates.find((c) => c.name === 'Camping Closed Example');
    expect(closed.blocked.join()).toMatch(/closed on 2026-10-12/);
    expect(first.toVerify).toContain('recent reviews (rating >= 4/5)');
    expect(r.currentNight.name).toBe('Camping Example');
    expect(first.savingVsCurrent).toBeGreaterThan(0);
    expect(first.totalCost).toBeGreaterThanOrEqual(first.price);
    const farm = r.candidates.find((c) => c.kind === 'farm');
    expect(farm.legalRisk).toMatch(/authorised campsite/);
    const free = await call(h, 'rooftop_tools_find_nights', { lat: 46.53, lng: 12.13, morning_lat: 46.58, morning_lng: 12.25, date: '2026-10-12' });
    expect(free.candidates.length).toBeGreaterThan(0);
    await expect(call(h, 'rooftop_tools_find_nights', {})).rejects.toThrow(/give tripId/);
  });

  it('compute_routes proposes by default and writes only with apply=true', async () => {
    const h = makeHost();
    const p = await call(h, 'rooftop_tools_compute_routes', { tripId: 1 });
    expect(p.applied).toBe(false);
    expect(p.days.filter((d) => d.km).length).toBe(3);
    expect(p.days[3].skipped).toMatch(/fewer than 2/); // last day: no destination in the trip
    expect(p.days[0].motorway).toBe(true); // first day: motorway allowed by default
    expect(p.days[1].motorway).toBe(false);
    expect(p.days[0].points).toBeUndefined();
    expect(h.calls.some((c) => c.method === 'places.create')).toBe(false);

    const trip = build();
    const hw = makeHost({ trip });
    const a = await call(hw, 'rooftop_tools_compute_routes', { tripId: 1, dayNumbers: [2], apply: true });
    expect(a.writes).toHaveLength(1);
    expect(a.writes[0].deletedPlaceId).toBe(21);
    expect(hw.calls.map((c) => c.method)).toEqual(expect.arrayContaining(['places.create', 'itinerary.assign', 'places.delete']));
    const created = trip.places.find((x) => /^Route day 2 — /.test(x.name));
    expect(created.route_geometry).toMatch(/^\[\[/);
    expect(created.category_id).toBe(6);
    expect(created.name).toMatch(/Camping Example → Aire Example Misurina \(\d+ km, /);
    expect(a.coreCalls[0]).toMatchObject({ tool: 'reorder_day_assignments', args: { tripId: 1, dayId: 102 } });
    expect(a.coreCalls[0].args.assignmentIds[0]).toBe(a.writes[0].assignmentId);
  });

  it('compute_routes cannot write without the write grants', async () => {
    const h = makeHost({ grants: manifest.permissions.filter((g) => g !== 'db:write:places') });
    await expect(call(h, 'rooftop_tools_compute_routes', { tripId: 1, dayNumbers: [1], apply: true })).rejects.toThrow(/PERMISSION_DENIED|db:write:places/);
  });

  it('schedule_day computes times from drive times and flags a late night', async () => {
    const h = makeHost();
    const r = await call(h, 'rooftop_tools_schedule_day', { tripId: 1, dayNumber: 1, departure: '09:30' });
    expect(r.departure).toBe('09:30');
    expect(r.stops.map((s) => s.name)).toEqual(['Lago di Braies', 'Mountain Museum Example', 'Supermarket Example']);
    expect(r.night.name).toBe('Camping Example');
    expect(r.coreCalls.every((c) => c.tool === 'update_assignment_time')).toBe(true);
    const late = await call(h, 'rooftop_tools_schedule_day', { tripId: 1, dayNumber: 1, departure: '14:00', stays: [{ assignmentId: 1002, minutes: 240 }] });
    expect(late.night.ok).toBe(false);
    expect(late.night.lateByMinutes).toBeGreaterThan(0);
    expect(late.night.fixes[0]).toMatch(/leave \d+ min earlier/);
    const d2 = await call(h, 'rooftop_tools_schedule_day', { tripId: 1, dayNumber: 2, departure: '12:30' });
    expect(d2.conflicts.some((c) => c.name === 'Visitor Centre Example')).toBe(true);
    await expect(call(h, 'rooftop_tools_schedule_day', { tripId: 1, dayNumber: 99 })).rejects.toThrow(/day not found/);
  });

  it('sun_times answers for a trip and for a point, without network', async () => {
    const h = makeHost();
    const r = await call(h, 'rooftop_tools_sun_times', { tripId: 1 });
    expect(r.days).toHaveLength(4);
    expect(r.days[0]).toMatchObject({ day: 1, sunset: '18:31', latestArrival: '17:31', place: 'Camping Example' });
    const p = await call(h, 'rooftop_tools_sun_times', { lat: 46.4983, lng: 11.3548, dates: ['2026-10-11'] });
    expect(p.days[0].sunset).toBe('18:36');
    await expect(call(h, 'rooftop_tools_sun_times', { lat: 1 })).rejects.toThrow(/give tripId/);
    expect(f).not.toHaveBeenCalled();
  });

  it('supplies_on_route lists shops along the route with their hours', async () => {
    const h = makeHost();
    const r = await call(h, 'rooftop_tools_supplies_on_route', { tripId: 1, dayNumber: 1, at: '10:00', kinds: ['groceries', 'fuel', 'water'] });
    expect(r.geometrySource).toBe('route place');
    const m = r.groceries.find((x) => x.name === 'Market On Route Example');
    expect(m.withinDetourLimit).toBe(true);
    expect(m.openAtPass).toBe('open');
    expect(m.hoursOnDate).toBe('08:00-12:00, 15:00-19:00');
    expect(m.dogs).toBe('no');
    expect(r.fuel[0].brand).toBe('FuelCo');
    expect(r.water).toHaveLength(1);
    const far = r.groceries.find((x) => x.name === 'Far Shop Example');
    expect(far.withinDetourLimit).toBe(false);
    // day 3 has no route place: the geometry is computed
    const d3 = await call(h, 'rooftop_tools_supplies_on_route', { tripId: 1, dayNumber: 3 });
    expect(d3.geometrySource).toMatch(/Valhalla/);
    expect(d3.water).toBeUndefined();
  });

  it('trip_budget totals nights, fuel and tolls and compares options', async () => {
    const h = makeHost();
    const r = await call(h, 'rooftop_tools_trip_budget', { tripId: 1, options: [{ label: 'A', night_price: 38 }, { label: 'B', night_price: 18, extra_km: 20 }] });
    expect(r.nightsTotal).toBe(73);
    expect(r.fuel.length).toBeGreaterThan(0);
    expect(r.tollTotal).toBe(18.5);
    expect(r.options[1].vsFirst).toBeLessThan(0);
    expect(r.coreCalls.every((c) => c.tool === 'create_budget_item')).toBe(true);
    expect(r.total).toBeCloseTo(r.nightsTotal + r.fuelTotal + r.tollTotal, 1);
  });

  it('trip_budget says so when budget lines cannot be read', async () => {
    const h = makeHost({ grants: manifest.permissions.filter((g) => g !== 'db:read:costs') });
    const r = await call(h, 'rooftop_tools_trip_budget', { tripId: 1 });
    expect(r.tolls).toBeNull();
    expect(r.note).toMatch(/not readable/);
  });

  it('plan_trip runs every step, or hands back a continuation', async () => {
    const h = makeHost();
    const r = await call(h, 'rooftop_tools_plan_trip', { tripId: 1 });
    expect(r.continuation).toBeNull();
    expect(r.done).toEqual(['check', 'nights', 'routes', 'schedule', 'budget']);
    expect(r.actions[0].priority).toBe(1);
    expect(r.results.nights.length).toBe(3);
    expect(r.results.routes.applied).toBe(false);
    expect(r.reminder).toMatch(/Never book/);
    const resumed = await call(h, 'rooftop_tools_plan_trip', { tripId: 1, continuation: 'budget.0' });
    expect(resumed.done).toEqual(['budget']);
    const req = await call(h, 'rooftop_tools_plan_trip', { request: { destination: 'Dolomites', start_date: '2026-10-09', end_date: '2026-10-16', wishes: ['lakes'] } });
    expect(req.mode).toBe('request');
    expect(req.steps[0].tool).toBe('create_trip');
    await expect(call(h, 'rooftop_tools_plan_trip', {})).rejects.toThrow(/give tripId/);
  });

  it('answers, instead of failing, when the public OSM server is busy', async () => {
    vi.stubGlobal('fetch', stubFetch({ failOverpass: true }));
    const h = makeHost();
    const n = await call(h, 'rooftop_tools_find_nights', { tripId: 1, dayNumber: 1 });
    expect(n.osmError).toMatch(/busy/);
    expect(n.candidates).toEqual([]);
    const s = await call(h, 'rooftop_tools_supplies_on_route', { tripId: 1, dayNumber: 1 });
    expect(s.osmError).toMatch(/busy/);
    const p = await call(makeHost(), 'rooftop_tools_plan_trip', { tripId: 1 });
    expect(p.results.nightsSkipped).toMatch(/busy.*find_nights/);
    expect(p.done).toEqual(['check', 'nights', 'routes', 'schedule', 'budget']);
  });

  it('refuses an unknown tool, a trip the user is not a member of, and tools needing a trip', async () => {
    const h = makeHost();
    await expect(call(h, 'nope', {})).rejects.toThrow(/unknown tool/);
    await expect(call(h, 'rooftop_tools_check_trip', { tripId: 2 })).rejects.toThrow();
    await expect(call(h, 'rooftop_tools_check_trip', {})).rejects.toThrow(/tripId is required/);
  });

  it('is never fired without the mcp:tools grant', async () => {
    const h = makeHost({ grants: manifest.permissions.filter((g) => g !== 'mcp:tools') });
    await expect(call(h, 'rooftop_tools_sun_times', { tripId: 1 })).rejects.toThrow(PermissionDenied);
  });
});

describe('hooks, route and lifecycle', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('warnings: ≤ 20, ≤ 300 chars, day in the text, no network', async () => {
    const h = makeHost();
    const w = await h.run(plugin).hook('warningProvider', 'getWarnings', 1);
    expect(w.length).toBeGreaterThan(0);
    expect(w.length).toBeLessThanOrEqual(20);
    expect(w.every((x) => x.message.length <= 300 && ['error', 'warning'].includes(x.level))).toBe(true);
    expect(w[0].level).toBe('error');
    expect(w.some((x) => /Day 1 \(2026-10-12\)/.test(x.message) && x.dayId === 101)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('route provider: one leg per waypoint gap, metres and seconds, profile → tolls', async () => {
    const h = makeHost();
    const wps = [{ lat: 46.53, lng: 12.13 }, { lat: 46.58, lng: 12.25 }, { lat: 46.64, lng: 11.72 }];
    const r = await h.run(plugin).hook('routeProvider', 'getRoute', { tripId: 1, dayId: 101, profile: 'rooftop-highway', waypoints: wps });
    expect(r.legs).toHaveLength(2);
    expect(r.distance).toBeGreaterThan(1000);
    expect(r.duration % 60).toBe(0);
    expect(JSON.parse(fetch.mock.calls[0][1].body).costing_options.auto.exclude_tolls).toBe(false);
    await h.run(plugin).hook('routeProvider', 'getRoute', { tripId: 1, dayId: 101, profile: 'rooftop', waypoints: wps });
    expect(JSON.parse(fetch.mock.calls[1][1].body).costing_options.auto.exclude_tolls).toBe(true);
  });

  it('POST /report feeds the tab', async () => {
    const h = makeHost();
    const drv = h.run(plugin);
    const res = await drv.route({ method: 'POST', path: '/report' }, { body: { tripId: 1 } });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.nights).toHaveLength(3);
    expect(body.nights[0]).toMatchObject({ name: 'Camping Example', kind: 'campsite', status: 'confirmed-unverified', onTime: false, arrival: '18:40' });
    expect(body.nights[0].alternatives[0].name).toBe('Camping Old Choice');
    expect(body.nights[2].zone).toBe('South Tyrol (Bolzano)');
    expect(body.kpis).toMatchObject({ nights: 3, nightsTotal: 73, late: 1 });
    expect((await drv.route({ method: 'POST', path: '/report' }, { body: {} })).status).toBe(400);
    expect((await drv.route({ method: 'POST', path: '/report' }, { body: { tripId: 9 } })).status).toBe(404);
  });

  it('onLoad creates the cache table', async () => {
    const h = makeHost();
    await h.run(plugin).load();
    expect(h.calls.some((c) => c.method === 'db.migrate' || c.method === 'db.exec')).toBe(true);
  });
});

describe('helpers of the dispatcher', () => {
  it('fit() shrinks a result under the size cap and says so', () => {
    const big = { a: Array.from({ length: 5000 }, (_, i) => ({ i, s: 'x'.repeat(30) })), keep: 1 };
    const out = fit(big, 20000);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(20200);
    expect(out.truncated).toMatch(/64 KiB/);
    expect(fit({ a: 1 })).toEqual({ a: 1 });
  });
  it('parses continuation tokens strictly', () => {
    expect(parseToken('nights.3')).toEqual({ step: 1, index: 3 });
    expect(parseToken('garbage')).toEqual({ step: 0, index: 0 });
    expect(planRequest({}).steps).toHaveLength(4);
  });
  it('sun table needs a point and dates without a trip', () => {
    expect(() => sunTable(null, {}, { timezone: 'UTC', sunset_margin_min: 60 })).toThrow(/give tripId/);
  });
});
