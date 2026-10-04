import { describe, it, expect } from 'vitest';
import { require, makeHost } from './helpers.mjs';

const plugin = require('../server/index.js');
const { build } = require('./fixtures/trip.js');

describe('trip overview on the map', () => {
  it('puts every planned stop of every day on the map, nights coloured by their booking', async () => {
    const h = makeHost();
    const markers = await h.run(plugin).hook('mapMarkerProvider', 'getMarkers', 1);
    const byName = (re) => markers.find((m) => re.test(m.label));
    // stops of day 1, day 2 and day 3, whatever day is selected; no route line
    expect(byName(/Braies/)).toMatchObject({ tone: 'success' }); // a planned visit is green
    expect(byName(/Visitor Centre/)).toBeTruthy();
    expect(byName(/Lago di Carezza/)).toBeTruthy();
    expect(markers.some((m) => /^.* · Route day/.test(m.label))).toBe(false);
    // night 1: confirmed booking → green; night 2: pending → amber; night 3: no booking → default
    expect(byName(/Camping Example/)).toMatchObject({ tone: 'success' });
    expect(byName(/Camping Example/).popupText).toMatch(/Night — /);
    expect(byName(/Aire Example/)).toMatchObject({ tone: 'warn' });
    expect(byName(/Farm Example/)).toMatchObject({ tone: 'default' });
    // the day and the times are in the label and the popup
    expect(byName(/Braies/).label).toMatch(/^D1 · /);
    expect(byName(/Braies/).popupText).toMatch(/D1 10:00–12:00/);
  });

  it('lists every day of a place planned more than once, and is off with the setting', async () => {
    const trip = build();
    const camp = trip.days[0].assignments.find((a) => a.place.id === 13);
    trip.days[1].assignments.push({ ...camp, id: 2999, day_id: 102, order_index: 9 });
    const h = makeHost({ trip });
    const markers = await h.run(plugin).hook('mapMarkerProvider', 'getMarkers', 1);
    expect(markers.filter((m) => /Camping Example/.test(m.label))).toHaveLength(1);
    expect(markers.find((m) => /Camping Example/.test(m.label)).label).toMatch(/^D1, D2 · /);

    const off = makeHost({ userSettings: { language: 'en', timezone: 'Europe/Rome', map_overview: false } });
    expect(await off.run(plugin).hook('mapMarkerProvider', 'getMarkers', 1)).toEqual([]);
  });

  it('speaks the user\'s language', async () => {
    const h = makeHost({ userSettings: { language: 'fr', timezone: 'Europe/Rome' } });
    const markers = await h.run(plugin).hook('mapMarkerProvider', 'getMarkers', 1);
    const camp = markers.find((m) => /Camping Example/.test(m.label));
    expect(camp.label).toMatch(/^J1 · /);
    expect(camp.popupText).toMatch(/Nuit — Réservée/);
  });
});
