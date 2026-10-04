// Hikes on the map: each hike tied to its car park, and its walking route DOTTED from the car
// park (the walker and the P are TREK's own markers, from the place's category). FICTIONAL places only (public repository).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { require, makeHost, stubFetch } from './helpers.mjs';

const plugin = require('../server/index.js');
const pi = require('../server/lib/place-info.js');
const walks = require('../server/lib/walks.js');
const design = require('../server/lib/design.js');
const { build } = require('./fixtures/trip.js');

const call = (h, name, args) => h.run(plugin).hook('mcpToolProvider', 'callTool', { name, args });
const layers = (h) => h.run(plugin).hook('mapLayerProvider', 'getLayers', 1);

const PARK = { id: 80, name: 'Example Trailhead Car Park', lat: 46.6, lng: 11.8, category_name: 'Route – Parking' };
const HIKE = { id: 81, name: 'Example Hut Chairs', lat: 46.612, lng: 11.79, category_name: 'See – Viewpoint', description: 'Reached on foot only. Links: https://www.wikiloc.com/hiking-trails/example-1 • https://www.outdooractive.com/en/route/hiking-trail/example/123/.' };
const RIDGE = { id: 82, name: 'Hike to Example Ridge', lat: 46.62, lng: 11.83, category_name: 'See – Hike' };
const LOOP = { id: 83, name: 'Example Lakes Loop', lat: 46.55, lng: 12.0, category_name: 'See – Hike' };
const PARK2 = { id: 84, name: 'Example Pass Car Park', lat: 46.551, lng: 12.001, category_name: 'Route – Parking' };
const FAR = { id: 85, name: 'Example Summit Trail', lat: 46.7, lng: 11.4, category_name: 'See – Hike', notes: 'Start: lay-by on the pass road, 46.6950, 11.4100' };
const PARK3 = { id: 86, name: 'Example Upper Car Park', lat: 46.6205, lng: 11.8305, category_name: 'Route – Parking' };

/** The fixture trip with: day 1 car park → viewpoint walked to (renamed "on foot"); day 2 a car park only, its loop not planned; day 3 a far hike with a start point in its notes. */
function trip() {
  const t = build();
  const hike = { ...HIKE, name: `${HIKE.name} on foot` };
  for (const p of [PARK, hike, RIDGE, LOOP, PARK2, FAR, PARK3]) t.places.push({ ...p, trip_id: 1, description: p.description || '', notes: p.notes || '' });
  const asg = (id, order, p) => ({ id, day_id: null, order_index: order, notes: null, accommodation_id: null, place: { ...p, place_time: null, end_time: null, category: { name: p.category_name }, description: p.description || '', notes: p.notes || '' } });
  t.days[0].assignments.splice(2, 0, asg(1101, 2, PARK), asg(1102, 2, hike));
  t.days[1].assignments.push(asg(2101, 9, PARK2));
  t.days[2].assignments.push(asg(3101, 9, FAR));
  for (const d of t.days) for (const a of d.assignments) a.day_id = d.id;
  return t;
}

async function hostWith(records = {}) {
  const ids = Object.keys(records).map(Number);
  const h = makeHost({ trip: trip(), queryResults: { [pi.INDEX_SQL]: ids.map((id) => ({ place_id: id })) } });
  for (const id of ids) await h.ctx.meta.set('place', id, pi.META_KEY, pi.merge(null, records[id]));
  return h;
}

describe('hikes and their car park on the map', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('draws no marker: TREK\'s own place markers carry the pictogram and stay clickable', () => {
    expect(plugin.hooks.mapMarkerProvider).toBeUndefined();
    expect(require('../trek-plugin.json').permissions).not.toContain('hook:map-marker-provider');
  });

  it('draws each walk dotted from its car park, on footpaths, and caches the route', async () => {
    const h = await hostWith();
    const [layer] = await layers(h);
    expect(layer.id).toBe('walks');
    const chairs = layer.features.find((f) => /Hut Chairs/.test(f.label));
    expect(chairs).toMatchObject({ type: 'polyline', dash: 'dot', tone: 'default' });
    expect(chairs.points[0]).toEqual([PARK.lat, PARK.lng]);
    expect(chairs.points.at(-1)).toEqual([HIKE.lat, HIKE.lng]);
    expect(chairs.label).toMatch(/km · .* on foot · On foot from Example/);
    const asked = fetch.calls.filter((c) => c.url.endsWith('/route') && JSON.parse(c.body).costing === 'pedestrian');
    expect(asked.length).toBeGreaterThan(0);
    // every feature is dotted: the dotted line means a walk and nothing else
    for (const f of layer.features) expect(f.dash).toBe('dot');
    // second load: from the cache, no new request
    const before = fetch.calls.length;
    await layers(h);
    expect(fetch.calls.length).toBe(before);
  });

  it('opens a hike card on click: shape, total walk, climb, hiking time, car park, and the page of the full track', async () => {
    const [layer] = await layers(await hostWith({ [LOOP.id]: { access_parking_place_id: PARK2.id, walk_via: [[46.56, 12.02]], walk_shape: 'loop' } }));
    const chairs = layer.features.find((f) => /Hut Chairs/.test(f.label));
    const lines = chairs.popupText.split('\n');
    expect(lines[0]).toBe('Example Hut Chairs on foot');
    // the hike's place is the turnaround: an out-and-back, counted both ways
    expect(lines[1]).toMatch(/^Out and back · [\d.]+ km · .* on foot · \+\d+ m$/);
    expect(lines[2]).toBe('On foot from Example Trailhead Car Park');
    // Outdooractive wins over Wikiloc, trailing punctuation dropped
    expect(chairs.url).toBe('https://www.outdooractive.com/en/route/hiking-trail/example/123/');
    // no track page written anywhere: the card says so, no link is made up
    const loop = layer.features.find((f) => /Lakes Loop/.test(f.label));
    expect(loop.popupText).toMatch(/\nLoop · /);
    expect(loop.url).toBeUndefined();
    expect(loop.popupText).toMatch(/No page with the full track is known yet/);
  });

  it('draws no walk without a car park "P" to start from, and the check reports it', async () => {
    const h = await hostWith();
    const [layer] = await layers(h);
    expect(layer.features.find((f) => /Summit Trail/.test(f.label))).toBeUndefined();
    const r = await call(h, 'vanlife_check_trip', { tripId: 1 });
    expect(r.findings.find((f) => f.key === 'walk_no_parking' && f.placeId === FAR.id)).toBeTruthy();
  });

  it('draws the walk of a hike that is not planned once the user ties it to a planned car park, with its loop', async () => {
    const h = await hostWith({ [LOOP.id]: { access_parking_place_id: PARK2.id, walk_via: [[46.56, 12.02], [46.57, 12.0]], walk_loop: true } });
    const [layer] = await layers(h);
    const f = layer.features.find((x) => /Lakes Loop/.test(x.label));
    expect(f.points[0]).toEqual([PARK2.lat, PARK2.lng]);
    expect(f.points.at(-1)).toEqual([PARK2.lat, PARK2.lng]); // back to the car park
  });

  it('draws the straight dotted line when the router cannot answer, and never fails the hook', async () => {
    vi.stubGlobal('fetch', stubFetch({ failValhalla: true }));
    const [layer] = await layers(await hostWith());
    const chairs = layer.features.find((f) => /Hut Chairs/.test(f.label));
    expect(chairs.points).toEqual([[PARK.lat, PARK.lng], [HIKE.lat, HIKE.lng]]);
    expect(chairs.label).not.toMatch(/km/);
  });

  it('is off with the walking routes setting', async () => {
    const h = makeHost({ trip: trip(), userSettings: { language: 'en', timezone: 'Europe/Rome', map_walks: false } });
    expect(await layers(h)).toEqual([]);
  });
});

describe('the hike\'s car park in the place tool', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('lists every hike with its car park, how it was found, and the walk', async () => {
    const r = await call(await hostWith(), 'vanlife_place', { tripId: 1, filter: 'hikes' });
    const chairs = r.hikes.find((x) => x.hikeId === HIKE.id);
    expect(chairs.accessParking).toMatchObject({ placeId: PARK.id, found: 'plan' });
    expect(chairs.walk.km).toBeGreaterThan(0);
    expect(r.hikes.find((x) => x.hikeId === FAR.id).accessParking).toMatchObject({ placeId: null, found: 'notes' });
  });

  it('sets the car park explicitly, refuses a place outside the trip, and clears back to the guess', async () => {
    const h = await hostWith();
    const r = await call(h, 'vanlife_place', { tripId: 1, placeId: RIDGE.id, set: { walk: { parking_place_id: PARK.id, shape: 'loop' } } });
    expect(r.hike.accessParking).toMatchObject({ placeId: PARK.id, found: 'set' });
    expect(r.hike.shape).toBe('loop');
    expect(r.hike.problem).toBeNull();
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: RIDGE.id, set: { walk: { parking_place_id: 9999 } } })).rejects.toThrow(/not in trip/);
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: RIDGE.id, set: { walk: { parking_place_id: RIDGE.id } } })).rejects.toThrow(/another place/);
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: RIDGE.id, set: { walk: { parking_place_id: HIKE.id, shape: 'loop' } } })).rejects.toThrow(/not a car park/);
    const cleared = await call(h, 'vanlife_place', { tripId: 1, placeId: RIDGE.id, clear_fields: ['walk'] });
    expect(cleared.record).toMatchObject({ access_parking_place_id: null, walk_loop: null, walk_via: null });
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: RIDGE.id, set: { walk: { start: 1 } } })).rejects.toThrow(/walk takes/);
    expect((await call(h, 'vanlife_place', { tripId: 1, placeId: RIDGE.id, clear_fields: ['all'] })).cleared).toBe(true);
  });

  it('puts a whole hike on the map from the place tool: a new place, a new car park, the walk', async () => {
    const CATS2 = [{ id: 1, name: 'Night – Campsite' }, { id: 6, name: 'Route – Day route' }, { id: 8, name: 'Route – Parking' }, { id: 9, name: 'See – Hike' }];
    const h = makeHost({ trip: trip(), categories: CATS2 });
    // the planned hike gets a car park that is not in the trip yet
    const r = await call(h, 'vanlife_place', { tripId: 1, placeId: HIKE.id, set: { walk: { parking: { name: 'Example New Car Park', lat: 46.601, lng: 11.801, price_amount: 5, per: 'day' }, shape: 'loop', via: [[46.61, 11.79]] } } });
    expect(r.created).toHaveLength(1);
    expect(r.created[0]).toMatchObject({ name: 'Example New Car Park', kind: 'parking', categoryId: 8 });
    expect(r.hike).toMatchObject({ shape: 'loop', problem: null });
    expect(r.hike.accessParking.placeId).toBe(r.created[0].placeId);
    // a new hike, filed under the hike category and planned on day 1
    const c = await call(h, 'vanlife_place', { tripId: 1, create: { name: 'Example Gorge Walk', lat: 46.63, lng: 11.85, kind: 'hike', day_number: 1 } });
    expect(c.created[0]).toMatchObject({ name: 'Example Gorge Walk', kind: 'hike', categoryId: 9, dayNumber: 1 });
    await expect(call(h, 'vanlife_place', { tripId: 1, create: { lat: 46, lng: 11 } })).rejects.toThrow(/create.name/);
    await expect(call(h, 'vanlife_place', { tripId: 1, create: { name: 'X', lat: 46, lng: 11, colour: 'red' } })).rejects.toThrow(/create takes/);
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: HIKE.id, set: { walk: { parking: { name: 'P', lat: 46, lng: 11 }, parking_place_id: PARK.id, shape: 'loop' } } })).rejects.toThrow(/not both/);
  });

  it('refuses a walk from one car park to another, and a walk with no shape', async () => {
    const h = await hostWith();
    // the ridge is next to another car park: an out-and-back there goes P → P
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: RIDGE.id, set: { walk: { parking_place_id: PARK.id, shape: 'out_and_back' } } }))
      .rejects.toThrow(/to another car park, "Example Upper Car Park"/);
    await expect(call(h, 'vanlife_place', { tripId: 1, placeId: RIDGE.id, set: { walk: { parking_place_id: PARK.id } } })).rejects.toThrow(/walk.shape is required/);
    // the same as a loop back to the first car park is fine
    const ok = await call(h, 'vanlife_place', { tripId: 1, placeId: RIDGE.id, set: { walk: { parking_place_id: PARK.id, shape: 'loop', via: [[46.615, 11.82]] } } });
    expect(ok.hike).toMatchObject({ shape: 'loop', problem: null });
    expect(() => pi.merge(null, pi.expandWalk({ walk: { shape: 'one_way' } }))).toThrow(/walk.shape/);
  });

  it('validates the walk fields', () => {
    expect(pi.merge(null, { walk_via: [[46.1, 11.2], { lat: 46.2, lng: 11.3 }] }).walk_via).toEqual([[46.1, 11.2], [46.2, 11.3]]);
    expect(() => pi.merge(null, { walk_via: [[100, 0]] })).toThrow(/walk_via/);
    expect(() => pi.merge(null, { walk_via: Array(9).fill([46, 11]) })).toThrow(/walk_via/);
    expect(() => pi.merge(null, { walk_loop: 'yes' })).toThrow(/walk_loop/);
    expect(() => pi.merge(null, { access_parking_place_id: -1 })).toThrow(/parking_place_id/);
  });

  it('names places by the first meaningful part of their name in the line\'s label', () => {
    expect(walks.shortName('Rando — Boucle Example → Hut Example', 32)).toBe('Boucle Example');
    expect(walks.shortName('Example Lakes Car Park - Upper Example', 24)).toBe('Example Lakes Car Park');
    expect(walks.shortName('P1 Example — Example Plateau', 24)).toBe('P1 Example');
    expect(walks.shortName('A very long example hike name that goes on', 20)).toBe('A very long example…');
  });

  it('counts the climb and times the walk by the hiking rule', () => {
    // The 1-2 m wobble of the terrain model is not a climb.
    expect(walks.climb([1000, 1002, 1001, 1010, 1020, 1015, 1000])).toEqual({ up: 20, down: 20 });
    expect(walks.climb([1000, 1001, 1000, 1002, 1000, 1001])).toEqual({ up: 0, down: 0 });
    // 8.8 km, +550/-550 m: about 4 h, the official time of such a loop
    expect(walks.walkMinutes({ km: 8.8, minutes: 154, up: 550, down: 550 })).toBe(242);
    expect(walks.walkMinutes({ km: 4, minutes: 50, up: null })).toBe(50);
  });

  it('keeps the page of the full hike set on the record first', () => {
    const place = { raw: { website: 'https://www.komoot.com/tour/1' }, notes: 'https://www.alltrails.com/trail/x' };
    expect(walks.hikeUrl(place, null)).toBe('https://www.komoot.com/tour/1');
    expect(walks.hikeUrl(place, { hike_url: 'https://trails.example.com/1' })).toBe('https://trails.example.com/1');
    expect(walks.hikeUrl({ raw: { website: 'https://hut.example.com' } }, null)).toBeNull();
    expect(pi.merge(null, pi.expandWalk({ walk: { url: ' https://trails.example.com/2 ' } })).hike_url).toBe('https://trails.example.com/2');
    expect(() => pi.merge(null, pi.expandWalk({ walk: { url: 'javascript:alert(1)' } }))).toThrow(/walk.url/);
  });

  it('puts the hike\'s place where it lengthens a long loop least, not always last', () => {
    const access = { point: [46.635, 11.763] };
    const hike = { lat: 46.621, lng: 11.7495, categoryName: 'See – Hike' };
    const info = { walk_shape: 'loop', walk_via: [[46.628, 11.78], [46.62, 11.76], [46.6135, 11.744], [46.6357, 11.7258]] };
    const pts = walks.walkPoints(hike, access, info);
    // P → east corner → Adolf Munkel → the hut → south → west → back to P
    expect(pts.map((p) => p.join(','))).toEqual(['46.635,11.763', '46.628,11.78', '46.62,11.76', '46.621,11.7495', '46.6135,11.744', '46.6357,11.7258', '46.635,11.763']);
  });

  it('routes walks on mountain paths (SAC T2), where the hikes are', async () => {
    const routing = require('../server/lib/routing.js');
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ trip: { summary: { length: 1, time: 900 }, legs: [{ shape: '' }] } }) }));
    vi.stubGlobal('fetch', f);
    await routing.walk([[46.6, 11.8], [46.61, 11.79]]);
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.costing).toBe('pedestrian');
    expect(body.costing_options.pedestrian.max_hiking_difficulty).toBe(2);
    vi.unstubAllGlobals();
  });

  it('merges the points of a walk that coincide', () => {
    const pts = walks.walkPoints({ lat: 46.6, lng: 11.8 }, { point: [46.6, 11.8] }, { walk_via: [[46.61, 11.81]], walk_loop: true });
    expect(pts).toEqual([[46.6, 11.8], [46.61, 11.81], [46.6, 11.8]]);
    expect(walks.walkPoints({ lat: 46.6, lng: 11.8 }, null, null)).toEqual([]);
  });
});
