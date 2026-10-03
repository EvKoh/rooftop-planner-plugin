import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { require, stubFetch, encode } from './helpers.mjs';

const routing = require('../server/lib/routing.js');
const cache = require('../server/lib/cache.js');
const overpass = require('../server/lib/overpass.js');
const { deadline } = require('../server/lib/util.js');

/** A ctx whose db is a real little key/value store, to exercise the cache SQL paths. */
function fakeDbCtx() {
  const rows = new Map();
  const db = {
    migrate: vi.fn(async () => ({ applied: true })),
    exec: vi.fn(async () => ({ changes: 0 })),
    query: vi.fn(async (sql, ...keys) => keys.filter((k) => rows.has(k)).map((k) => ({ k, ...rows.get(k) }))),
    tx: vi.fn(async (ops) => { for (const o of ops) rows.set(o.args[0], { v: o.args[1], at: o.args[2] }); return { results: [] }; }),
  };
  return { ctx: { db, log: { warn: vi.fn() } }, rows, db };
}

describe('routing', () => {
  beforeEach(() => cache.clearMemory());
  afterEach(() => vi.unstubAllGlobals());

  it('decodes a precision-6 polyline', () => {
    const pts = [[46.5, 11.6], [46.51, 11.62], [46.4, 11.5]];
    expect(routing.decodePolyline(encode(pts))).toEqual(pts);
  });

  it('routes through points and reports km, minutes and legs', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const r = await routing.route([[46.53, 12.13], [46.58, 12.25], [46.64, 11.72]], { tolls: false, height: 2 });
    expect(r.legs).toHaveLength(2);
    expect(r.km).toBeGreaterThan(0);
    expect(r.points[0]).toEqual([46.53, 12.13]);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.costing_options.auto).toEqual({ exclude_tolls: true, height: 2 });
  });

  it('turns a Valhalla error into an exception', async () => {
    vi.stubGlobal('fetch', stubFetch({ failValhalla: true }));
    await expect(routing.route([[46, 11], [46.1, 11.1]])).rejects.toThrow(/Valhalla 503/);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
    await expect(routing.route([[46, 11], [46.1, 11.1]])).rejects.toThrow(/no route/);
  });

  it('answers many legs with one matrix call, then from the db cache', async () => {
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    const { ctx, rows, db } = fakeDbCtx();
    const pairs = [[[46.5, 11.6], [46.6, 11.7]], [[46.5, 11.6], [46.7, 11.8]], [[46.6, 11.7], [46.7, 11.8]]];
    const a = await routing.legs(ctx, pairs, { tolls: false });
    expect(f).toHaveBeenCalledTimes(1);
    expect(a.pending).toBe(0);
    expect(a.values.get(0).minutes).toBeGreaterThan(0);
    expect(rows.size).toBe(3);
    cache.clearMemory(); // a fresh process: must come back from sqlite, not the network
    const b = await routing.legs(ctx, pairs, { tolls: false });
    expect(f).toHaveBeenCalledTimes(1);
    expect(b.values.get(2)).toEqual(a.values.get(2));
    expect(db.query).toHaveBeenCalled();
    const c = await routing.legs(ctx, pairs, { tolls: true, network: false });
    expect(c.pending).toBe(3);
  });

  it('stops asking when the deadline is near, and survives a matrix failure', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const { ctx } = fakeDbCtx();
    const near = deadline(1000);
    const r = await routing.legs(ctx, [[[46, 11], [46.2, 11.2]]], { deadline: near });
    expect(r.pending).toBe(1);
    vi.stubGlobal('fetch', stubFetch({ failValhalla: true }));
    const r2 = await routing.legs(ctx, [[[46, 11], [46.3, 11.3]]], {});
    expect(r2.pending).toBe(1);
    expect(ctx.log.warn).toHaveBeenCalled();
  });
});

describe('cache', () => {
  beforeEach(() => cache.clearMemory());
  it('migrates, expires old rows and survives a broken db', async () => {
    const { ctx, rows } = fakeDbCtx();
    await cache.migrate(ctx);
    expect(ctx.db.migrate).toHaveBeenCalledWith('001_cache', cache.MIGRATION);
    rows.set('route:old', { v: '1', at: 0 });
    rows.set('osm:bad', { v: '{not json', at: Date.now() });
    const got = await cache.getMany(ctx, ['route:old', 'osm:bad', 'osm:none']);
    expect(got.size).toBe(0);
    const broken = { db: { query: async () => { throw new Error('no table'); }, tx: async () => { throw new Error('no table'); } } };
    await cache.setMany(broken, [['osm:x', { a: 1 }]]);
    expect((await cache.getMany(broken, ['osm:x'])).get('osm:x')).toEqual({ a: 1 }); // memory layer
    cache.clearMemory();
    expect((await cache.getMany(broken, ['osm:x'])).size).toBe(0);
    await cache.setMany(broken, []);
  });
});

describe('overpass', () => {
  beforeEach(() => cache.clearMemory());
  afterEach(() => vi.unstubAllGlobals());
  it('queries once, normalises elements and caches them', async () => {
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    const { ctx } = fakeDbCtx();
    const els = await overpass.query(ctx, 'nwr["tourism"="camp_site"](around:1000,46,11);out center tags;');
    expect(els.find((e) => e.id === 'way/2')).toMatchObject({ lat: 46.57, lng: 12.2 });
    await overpass.query(ctx, 'nwr["tourism"="camp_site"](around:1000,46,11);out center tags;');
    expect(f).toHaveBeenCalledTimes(1);
    expect(await overpass.query(ctx, 'other', { network: false })).toBeNull();
    vi.stubGlobal('fetch', stubFetch({ failOverpass: true }));
    await expect(overpass.query(ctx, 'third')).rejects.toThrow(overpass.OverpassBusy);
    // after a refusal it stops asking for a while, without touching the network
    const g = stubFetch();
    vi.stubGlobal('fetch', g);
    await expect(overpass.query(ctx, 'fourth')).rejects.toThrow(/try again in \d+ s/);
    expect(g).not.toHaveBeenCalled();
    overpass.resetBusy();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout'); }));
    await expect(overpass.query(ctx, 'fifth')).rejects.toThrow(/did not answer/);
    overpass.resetBusy();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) })));
    await expect(overpass.query(ctx, 'sixth')).rejects.toThrow(/Overpass 400/);
    overpass.resetBusy();
    expect(overpass.osmUrl('node/1')).toBe('https://www.openstreetmap.org/node/1');
  });
});

describe('matrix size limit of the public server', () => {
  beforeEach(() => cache.clearMemory());
  afterEach(() => vi.unstubAllGlobals());
  it('never asks for more than 100 cells at once (20 x 20 was refused)', async () => {
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    const pts = Array.from({ length: 31 }, (_, i) => [46 + i * 0.01, 11 + i * 0.01]);
    const pairs = pts.slice(1).map((p, i) => [pts[i], p]); // 30 consecutive legs, all distinct points
    const r = await routing.legs({ db: { query: async () => [], tx: async () => ({}) } }, pairs, {});
    expect(r.pending).toBe(0);
    expect(r.values.size).toBe(30);
    for (const c of f.calls) {
      const b = JSON.parse(c.body);
      expect(b.sources.length * b.targets.length).toBeLessThanOrEqual(100);
    }
    expect(f.calls.length).toBeGreaterThan(1);
  });
});
