import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { require, makeHost, stubFetch, manifest } from './helpers.mjs';

const plugin = require('../server/index.js');
const { TOOL_SPECS, TOOL_NAMES, withDefaults } = require('../server/lib/tool-specs.js');
const { fit } = require('../server/lib/tools.js');
const { parseToken, planRequest } = require('../server/lib/plan.js');
const { PermissionDenied } = require('trek-plugin-sdk/testing');
const { build } = require('./fixtures/trip.js');

const call = (h, name, args) => h.run(plugin).hook('mcpToolProvider', 'callTool', { name, args });

describe('manifest and tool declarations', () => {
  it('declares exactly the tools the code implements (the host advertises the intersection)', () => {
    expect(plugin.hooks.mcpToolProvider.tools).toEqual(manifest.capabilities.mcpTools.map((t) => t.name));
    expect(manifest.capabilities.mcpTools).toEqual(TOOL_SPECS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })));
    expect(TOOL_NAMES).toHaveLength(7);
    expect(TOOL_NAMES.every((n) => n.startsWith('vanlife_'))).toBe(true);
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
      expect(t.name.startsWith('vanlife_')).toBe(true);
      expect(t.description.length).toBeLessThanOrEqual(1024);
      expect(t.title.length).toBeLessThanOrEqual(80);
      expect(t.inputSchema.type).toBe('object');
      expect(JSON.stringify(t.inputSchema).length).toBeLessThanOrEqual(8192);
      walk(t.inputSchema, 0, false);
    }
    const desc = manifest.capabilities.mcpTools.find((t) => t.name === 'vanlife_plan_trip').description;
    expect(desc).toMatch(/Never book/);
  });

  it('grants each outbound host it calls, and keeps settings and route profiles sane', () => {
    for (const host of manifest.egress) expect(manifest.permissions).toContain(`http:outbound:${host}`);
    expect(manifest.capabilities.routeProfiles.map((p) => p.id)).toEqual(['vanlife', 'vanlife-highway']);
    expect(manifest.settings.filter((s) => s.scope === 'instance').map((s) => s.key)).toEqual(['park4night_enabled', 'default_language']);
    expect(manifest.type).toBe('widget');
    expect(manifest.capabilities.widget.slot).toBe('place-detail');
  });

  it('applies schema defaults by hand', () => {
    expect(withDefaults('vanlife_find_nights', {})).toEqual({ radius_km: 15 });
    expect(withDefaults('vanlife_day', { action: 'routes', apply: true })).toEqual({ action: 'routes', apply: true, startAt: 0, corridor_km: 2 });
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
    const r = await call(h, 'vanlife_check_trip', { tripId: 1, levels: ['blocking'] });
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(r.trip).toBe('Example rooftop loop');
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings.every((x) => x.level === 'blocking')).toBe(true);
    const fr = await call(h, 'vanlife_check_trip', { tripId: 1, language: 'fr' });
    expect(fr.findings[0].message).toMatch(/^J\d/);
  });

  it('find_nights ranks legal cheap nights first and excludes motorhome areas', async () => {
    const h = makeHost();
    const r = await call(h, 'vanlife_find_nights', { tripId: 1, dayNumber: 1 });
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
    expect(farm.legalRisk).toMatch(/private farm with the owner's consent it is allowed/);
    const free = await call(h, 'vanlife_find_nights', { lat: 46.53, lng: 12.13, morning_lat: 46.58, morning_lng: 12.25, date: '2026-10-12' });
    expect(free.candidates.length).toBeGreaterThan(0);
    await expect(call(h, 'vanlife_find_nights', {})).rejects.toThrow(/give tripId/);
  });

  it('compute_routes proposes by default and writes only with apply=true', async () => {
    const h = makeHost();
    const p = await call(h, 'vanlife_day', { action: 'routes', tripId: 1 });
    expect(p.applied).toBe(false);
    expect(p.days.filter((d) => d.km).length).toBe(3);
    expect(p.days[3].skipped).toMatch(/fewer than 2/); // last day: no destination in the trip
    expect(p.days[0].motorway).toBe(true); // first day: motorway allowed by default
    expect(p.days[1].motorway).toBe(false);
    expect(p.days[0].points).toBeUndefined();
    expect(h.calls.some((c) => c.method === 'places.create')).toBe(false);

    const trip = build();
    const hw = makeHost({ trip });
    const a = await call(hw, 'vanlife_day', { action: 'routes', tripId: 1, dayNumbers: [2], apply: true });
    expect(a.writes).toHaveLength(1);
    expect(a.writes[0].deletedPlaceId).toBe(21);
    expect(hw.calls.map((c) => c.method)).toEqual(expect.arrayContaining(['places.create', 'itinerary.assign', 'places.delete']));
    const created = trip.places.find((x) => /^Route day 2 — /.test(x.name));
    expect(created.route_geometry).toMatch(/^\[\[/);
    expect(created.category_id).toBe(6);
    // pinned halfway along its line, not on the previous night
    const pts = JSON.parse(created.route_geometry);
    expect([created.lat, created.lng]).toEqual(pts[Math.floor(pts.length / 2)]);
    expect(created.notes).toMatch(/^Computed by the vanlife plugin \(Valhalla, no tolls, height/);
    expect(created.name).toMatch(/Camping Example → Aire Example Misurina \(\d+ km, /);
    expect(a.coreCalls[0]).toMatchObject({ tool: 'reorder_day_assignments', args: { tripId: 1, dayId: 102 } });
    expect(a.coreCalls[0].args.assignmentIds[0]).toBe(a.writes[0].assignmentId);
  });

  it('compute_routes cannot write without the write grants', async () => {
    const h = makeHost({ grants: manifest.permissions.filter((g) => g !== 'db:write:places') });
    await expect(call(h, 'vanlife_day', { action: 'routes', tripId: 1, dayNumbers: [1], apply: true })).rejects.toThrow(/PERMISSION_DENIED|db:write:places/);
  });

  it('schedule_day computes times from drive times and flags a late night', async () => {
    const h = makeHost();
    const r = await call(h, 'vanlife_day', { action: 'schedule', tripId: 1, dayNumber: 1, departure: '09:30' });
    expect(r.departure).toBe('09:30');
    expect(r.stops.map((s) => s.name)).toEqual(['Lago di Braies', 'Mountain Museum Example', 'Supermarket Example']);
    expect(r.night.name).toBe('Camping Example');
    expect(r.coreCalls.every((c) => c.tool === 'update_assignment_time')).toBe(true);
    const late = await call(h, 'vanlife_day', { action: 'schedule', tripId: 1, dayNumber: 1, departure: '14:00', stays: [{ assignmentId: 1002, minutes: 240 }] });
    expect(late.night.ok).toBe(false);
    expect(late.night.lateByMinutes).toBeGreaterThan(0);
    expect(late.night.fixes[0]).toMatch(/leave \d+ min earlier/);
    const d2 = await call(h, 'vanlife_day', { action: 'schedule', tripId: 1, dayNumber: 2, departure: '12:30' });
    expect(d2.conflicts.some((c) => c.name === 'Visitor Centre Example')).toBe(true);
    await expect(call(h, 'vanlife_day', { action: 'schedule', tripId: 1, dayNumber: 99 })).rejects.toThrow(/day not found/);
  });

  it('check_trip can add the sun table; find_nights gives the sunset at the evening point', async () => {
    const h = makeHost();
    const r = await call(h, 'vanlife_check_trip', { tripId: 1, sun: true, levels: ['info'] });
    expect(r.sun.days).toHaveLength(4);
    expect(r.sun.days[0]).toMatchObject({ day: 1, sunset: '18:31', latestArrival: '17:31', place: 'Camping Example' });
    expect(r.sun.days[3].place).toBe('Route day 4'); // no night on the last day: last located stop
    const n = await call(h, 'vanlife_find_nights', { lat: 46.4983, lng: 11.3548, date: '2026-10-11' });
    expect(n.sun).toEqual({ sunset: '18:36', latestArrival: '17:36' });
  });

  it('supplies_on_route lists shops along the route with their hours', async () => {
    const h = makeHost();
    const r = await call(h, 'vanlife_day', { action: 'supplies', tripId: 1, dayNumber: 1, at: '10:00', kinds: ['groceries', 'fuel', 'water'] });
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
    const d3 = await call(h, 'vanlife_day', { action: 'supplies', tripId: 1, dayNumber: 3 });
    expect(d3.geometrySource).toMatch(/Valhalla/);
    expect(d3.water).toBeUndefined();
  });

  it('plan_trip totals the budget: nights, fuel per day and tolls from budget lines', async () => {
    const r = await call(makeHost(), 'vanlife_plan_trip', { tripId: 1, continuation: 'budget.0' });
    expect(r.results.budget.nightsTotal).toBe(73);
    expect(r.results.budget.fuelTotal).toBeGreaterThan(0);
    expect(r.results.budget.tollTotal).toBe(18.5);
    expect(r.coreCalls.every((c) => c.tool === 'create_budget_item')).toBe(true);
    const noCosts = await call(makeHost({ grants: manifest.permissions.filter((g) => g !== 'db:read:costs') }), 'vanlife_plan_trip', { tripId: 1, continuation: 'budget.0' });
    expect(noCosts.results.budget.tollTotal).toBeNull();
    expect(noCosts.results.budget.note).toMatch(/not readable/);
  });

  it('plan_trip runs every step, or hands back a continuation', async () => {
    const h = makeHost();
    const r = await call(h, 'vanlife_plan_trip', { tripId: 1 });
    expect(r.continuation).toBeNull();
    expect(r.done).toEqual(['check', 'nights', 'routes', 'schedule', 'budget']);
    expect(r.actions[0].priority).toBe(1);
    expect(r.results.nights.length).toBe(3);
    expect(r.results.routes.applied).toBe(false);
    expect(r.reminder).toMatch(/Never book/);
    const resumed = await call(h, 'vanlife_plan_trip', { tripId: 1, continuation: 'budget.0' });
    expect(resumed.done).toEqual(['budget']);
    const req = await call(h, 'vanlife_plan_trip', { request: { destination: 'Dolomites', start_date: '2026-10-09', end_date: '2026-10-16', wishes: ['lakes'] } });
    expect(req.mode).toBe('request');
    expect(req.steps[0].tool).toBe('create_trip');
    await expect(call(h, 'vanlife_plan_trip', {})).rejects.toThrow(/give tripId/);
  });

  it('answers, instead of failing, when the public OSM server is busy', async () => {
    vi.stubGlobal('fetch', stubFetch({ failOverpass: true }));
    const h = makeHost();
    const n = await call(h, 'vanlife_find_nights', { tripId: 1, dayNumber: 1 });
    expect(n.osmError).toMatch(/busy/);
    expect(n.candidates).toEqual([]);
    const s = await call(h, 'vanlife_day', { action: 'supplies', tripId: 1, dayNumber: 1 });
    expect(s.osmError).toMatch(/busy/);
    const p = await call(makeHost(), 'vanlife_plan_trip', { tripId: 1 });
    expect(p.results.nightsSkipped).toMatch(/busy.*find_nights/);
    expect(p.done).toEqual(['check', 'nights', 'routes', 'schedule', 'budget']);
  });

  it('refuses an unknown tool, a trip the user is not a member of, and tools needing a trip', async () => {
    const h = makeHost();
    await expect(call(h, 'nope', {})).rejects.toThrow(/unknown tool/);
    await expect(call(h, 'vanlife_check_trip', { tripId: 2 })).rejects.toThrow();
    await expect(call(h, 'vanlife_check_trip', {})).rejects.toThrow(/tripId is required/);
  });

  it('is never fired without the mcp:tools grant', async () => {
    const h = makeHost({ grants: manifest.permissions.filter((g) => g !== 'mcp:tools') });
    await expect(call(h, 'vanlife_check_trip', { tripId: 1 })).rejects.toThrow(PermissionDenied);
  });
});

describe('hooks, route and lifecycle', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('route provider: one leg per waypoint gap, metres and seconds, profile → tolls', async () => {
    const h = makeHost();
    const wps = [{ lat: 46.53, lng: 12.13 }, { lat: 46.58, lng: 12.25 }, { lat: 46.64, lng: 11.72 }];
    const r = await h.run(plugin).hook('routeProvider', 'getRoute', { tripId: 1, dayId: 101, profile: 'vanlife-highway', waypoints: wps });
    expect(JSON.parse(fetch.mock.calls[0][1].body).costing).toBe('auto');
    expect(r.legs).toHaveLength(2);
    expect(r.distance).toBeGreaterThan(1000);
    expect(r.duration % 60).toBe(0);
    expect(JSON.parse(fetch.mock.calls[0][1].body).costing_options.auto.exclude_tolls).toBe(false);
    await h.run(plugin).hook('routeProvider', 'getRoute', { tripId: 1, dayId: 101, profile: 'vanlife', waypoints: wps });
    expect(JSON.parse(fetch.mock.calls[1][1].body).costing_options.auto.exclude_tolls).toBe(true);
    // a motorhome is routed as a truck, with its height, length and weight
    const mh = makeHost({ userSettings: { vehicle: 'motorhome', vehicle_height_m: 3.1, vehicle_length_m: 7.4, vehicle_weight_t: 3.5 } });
    await mh.run(plugin).hook('routeProvider', 'getRoute', { tripId: 1, dayId: 101, profile: 'vanlife', waypoints: wps });
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toMatchObject({ costing: 'truck', costing_options: { truck: { height: 3.1, length: 7.4, weight: 3.5, exclude_tolls: true } } });
  });

  it('widget routes: the place, its TREK price, strings in the frame language; save and clear', async () => {
    const trip = build();
    const h = makeHost({ trip, userSettings: { timezone: 'Europe/Rome' } }); // language: auto
    const drv = h.run(plugin);
    const post = (path, body) => drv.route({ method: 'POST', path }, { body });
    const r = await post('/amenities', { tripId: 1, placeId: 13, locale: 'fr-FR' });
    expect(r.status).toBe(200);
    const d = JSON.parse(r.body);
    expect(d).toMatchObject({ language: 'fr', price: 38, recorded: false, summary: null, vehicle: 'rooftop_tent' });
    expect(d.strings['ui.save']).toBe('Enregistrer');
    expect(d.strings['amLong.water']).toBe('Eau potable');
    expect(Object.keys(d.strings).some((k) => k.startsWith('s.') || k.startsWith('zone.'))).toBe(false); // only what the widget shows
    const saved = await post('/amenities/save', { tripId: 1, placeId: 13, set: { price_amount: 22, currency: 'EUR', per: 'person', water: 'yes', max_height_m: 2.1 } });
    expect(saved.status).toBe(200);
    expect(trip.places.find((p) => p.id === 13).price).toBe(22); // TREK's own price field
    expect(JSON.parse(saved.body).info).toMatchObject({ per: 'person', max_height_m: 2.1, amenities: { water: 'yes' } });
    expect(JSON.parse(saved.body).info.price).toBeUndefined(); // never a second price
    const again = JSON.parse((await post('/amenities', { tripId: 1, placeId: 13, locale: 'en' })).body);
    expect(again).toMatchObject({ language: 'en', price: 22, recorded: true, summary: '✓ water  ↕ 2.1 m', refused: false });
    expect((await post('/amenities/save', { tripId: 1, placeId: 13, set: { per: 'week' } })).status).toBe(400);
    expect((await post('/amenities/save', { tripId: 1, placeId: 13, set: { currency: 'eu' } })).status).toBe(400);
    expect((await post('/amenities/save', { tripId: 1, placeId: 999, set: {} })).status).toBe(404);
    expect((await post('/amenities', { tripId: 1 })).status).toBe(400);
    expect((await post('/amenities', { tripId: 1, placeId: 999 })).status).toBe(404);
    expect((await post('/amenities', { tripId: 9, placeId: 13 })).status).toBe(403);
    expect(JSON.parse((await post('/amenities/clear', { tripId: 1, placeId: 13 })).body)).toEqual({ cleared: true });
    expect((await post('/amenities/clear', { tripId: 1 })).status).toBe(400);
    expect((await post('/amenities/clear', { tripId: 1, placeId: 999 })).status).toBe(404);
    expect((await post('/amenities/save', {})).status).toBe(400);
  });

  it('the widget follows the user language setting over the frame language, and "auto" follows the frame', async () => {
    const fr = makeHost({ userSettings: { language: 'fr' } }).run(plugin);
    expect(JSON.parse((await fr.route({ method: 'POST', path: '/amenities' }, { body: { tripId: 1, placeId: 13, locale: 'de' } })).body).language).toBe('fr');
    const auto = makeHost({ userSettings: { language: 'auto' } }).run(plugin);
    expect(JSON.parse((await auto.route({ method: 'POST', path: '/amenities' }, { body: { tripId: 1, placeId: 13, locale: 'de-DE' } })).body).language).toBe('de');
    const none = makeHost({ userSettings: {}, config: { default_language: 'it', park4night_enabled: false } }).run(plugin);
    expect(JSON.parse((await none.route({ method: 'POST', path: '/amenities' }, { body: { tripId: 1, placeId: 13 } })).body).language).toBe('it');
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
});
