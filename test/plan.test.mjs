import { describe, it, expect, afterEach, vi } from 'vitest';
import { require, makeHost, stubFetch } from './helpers.mjs';

const { planTrip } = require('../server/lib/plan.js');
const { loadTrip } = require('../server/lib/trip.js');
const { readSettings } = require('../server/lib/settings.js');
const { deadline } = require('../server/lib/util.js');

describe('plan_trip time budget', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('hands back a continuation instead of overrunning, and resumes from it', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const h = makeHost();
    const model = await loadTrip(h.ctx, 1);
    const settings = await readSettings(h.ctx);
    // A clock that jumps 3 s per reading: the budget runs out part-way.
    let t = 0;
    const clock = () => (t += 3000);
    const first = await planTrip(h.ctx, model, {}, { settings, deadline: deadline(30000, clock), network: true });
    expect(first.continuation).toMatch(/^(check|nights|routes|schedule|budget)\.\d+$/);
    expect(first.done.length).toBeLessThan(5);
    const all = [first];
    let tok = first.continuation;
    for (let i = 0; tok && i < 20; i++) {
      const r = await planTrip(h.ctx, model, { continuation: tok }, { settings, deadline: deadline(12000), network: true });
      all.push(r);
      tok = r.continuation;
    }
    expect(tok).toBeNull();
    expect(all.flatMap((r) => r.done)).toEqual(expect.arrayContaining(['check', 'nights', 'routes', 'schedule', 'budget']));
    const none = await planTrip(h.ctx, model, {}, { settings, deadline: deadline(1000), network: true });
    expect(none.continuation).toBe('check.0');
  });
});
