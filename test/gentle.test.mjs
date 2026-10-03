import { describe, it, expect, vi } from 'vitest';
import { require, makeHost, stubFetch, manifest } from './helpers.mjs';

const { gentle, retry } = require('../server/lib/gentle.js');
const plugin = require('../server/index.js');

describe('gentle ctx', () => {
  it('retries a call the host refused for rate limiting, then succeeds', async () => {
    let n = 0;
    const ctx = { trips: { getById: async () => { n++; if (n < 3) throw new Error('HOST_ERROR: rate limit exceeded — slow down ctx.* calls'); return { id: 1 }; } }, config: { a: 1 }, log: console };
    const g = gentle(ctx, [1, 1, 1]);
    expect(await g.trips.getById(1)).toEqual({ id: 1 });
    expect(n).toBe(3);
    expect(g.config).toEqual({ a: 1 });
    expect(gentle(g)).toBe(g);
    expect(g.trips).toBe(g.trips); // namespaces are wrapped once
    expect(gentle(null)).toBeNull();
  });
  it('gives up after the last pause, and never retries other errors', async () => {
    const always = vi.fn(async () => { throw new Error('rate limit exceeded'); });
    await expect(retry(always, [1, 1])).rejects.toThrow(/rate limit/);
    expect(always).toHaveBeenCalledTimes(3);
    const denied = vi.fn(async () => { throw new Error('PERMISSION_DENIED'); });
    await expect(retry(denied, [1, 1])).rejects.toThrow(/PERMISSION_DENIED/);
    expect(denied).toHaveBeenCalledTimes(1);
  });
  it('is used by every entry point: tools, hooks and routes still answer', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const h = makeHost();
    const drv = h.run(plugin);
    expect((await drv.hook('mcpToolProvider', 'callTool', { name: 'rooftop_tools_place_info', args: { tripId: 1 } })).toFill.length).toBeGreaterThan(0);
    expect(Array.isArray(await drv.hook('warningProvider', 'getWarnings', 1))).toBe(true);
    expect((await drv.route({ method: 'POST', path: '/places' }, { body: { tripId: 1 } })).status).toBe(200);
    // the columns hook reads only the 3 settings it needs
    const before = h.calls.filter((c) => c.method === 'settings.get').length;
    await drv.hook('tableContributor', 'getContributions', 'places', 1);
    expect(h.calls.filter((c) => c.method === 'settings.get').length - before).toBe(3);
    vi.unstubAllGlobals();
    expect(manifest.permissions).toContain('db:meta');
  });
});
