// A car park set in one call: its price per day or per hour (TREK's own price) and the details
// TREK has no field for, shown on the place. FICTIONAL data only (public repository).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { require, makeHost, stubFetch } from './helpers.mjs';

const plugin = require('../server/index.js');
const pi = require('../server/lib/place-info.js');

const call = (h, name, args) => h.run(plugin).hook('mcpToolProvider', 'callTool', { name, args });

describe('a car park in one call', () => {
  beforeEach(() => vi.stubGlobal('fetch', stubFetch()));
  afterEach(() => vi.unstubAllGlobals());

  it('records the price per day and the details, and shows them on the place', async () => {
    const h = makeHost({ queryResults: { [pi.INDEX_SQL]: [{ place_id: 14 }] } });
    const r = await call(h, 'vanlife_place', {
      tripId: 1, placeId: 14,
      set: {
        price_amount: 15, currency: 'EUR', per: 'day', max_height_m: 2.1, source: 'Example park authority',
        parking: { hours: '05:00-23:00', payment: 'online booking only', camper_allowed: 'no', overnight_allowed: 'no', notes: 'enter before 09:30', source_url: 'https://parking.example.com/p1' },
      },
    });
    expect(r.saved).toBe(true);
    expect(r.price).toBe('€15.00/day');
    expect(r.parking).toBe('05:00-23:00 · online booking only · no motorhomes · no overnight · enter before 09:30');
    expect(r.record).toMatchObject({ source_url: 'https://parking.example.com/p1', max_height_m: 2.1, checked: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    const cols = await h.run(plugin).hook('tableContributor', 'getContributions', 'places', 1);
    const mine = cols.filter((c) => c.entityId === 14);
    expect(mine.find((c) => c.id === 'vanlife-price').value).toBe('€15.00/day');
    expect(mine.find((c) => c.id === 'vanlife-parking')).toMatchObject({ icon: 'ParkingSquare', value: expect.stringContaining('no overnight') });
  });

  it('refuses a bad detail and clears them all', () => {
    expect(() => pi.merge(null, pi.expandParking({ parking: { camper_allowed: 'maybe' } }))).toThrow(/camper_allowed/);
    expect(() => pi.merge(null, pi.expandParking({ parking: { source_url: 'ftp://x' } }))).toThrow(/source_url/);
    expect(() => pi.merge(null, pi.expandParking({ parking: { fee: 1 } }))).toThrow(/parking takes/);
    const r = pi.merge(null, pi.expandParking({ parking: { hours: '24/7', overnight_allowed: true } }));
    expect(pi.parkingText(r, 'en')).toBe('24/7 · overnight allowed');
    expect(pi.merge(r, pi.clearPatch(['parking'])).parking_hours).toBeNull();
  });
});
