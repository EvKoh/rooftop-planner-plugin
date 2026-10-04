import { describe, it, expect } from 'vitest';
import { require } from './helpers.mjs';

const d = require('../server/lib/design.js');

// TREK's own map icon set (client/src/components/shared/categoryIcons.ts): a map marker can
// only carry one of these.
const TREK_MARKER_ICONS = ['MapPin', 'Building2', 'BedDouble', 'UtensilsCrossed', 'Landmark', 'ShoppingBag', 'Bus', 'Train',
  'Car', 'Plane', 'Ship', 'Bike', 'Activity', 'Dumbbell', 'Mountain', 'Tent', 'Anchor', 'Coffee', 'Beer', 'Wine', 'Utensils',
  'Camera', 'Music', 'Theater', 'Ticket', 'TreePine', 'Waves', 'Leaf', 'Flower2', 'Sun', 'Globe', 'Compass', 'Flag',
  'Navigation', 'Map', 'Church', 'Library', 'Store', 'Home', 'Cross', 'Heart', 'Star', 'CreditCard', 'Wifi', 'Luggage',
  'Backpack', 'Zap'];
const TONES = ['default', 'success', 'warn', 'danger'];

describe('design catalogue', () => {
  it('gives every map marker an icon TREK can draw, and every look a TREK tone', () => {
    for (const icon of d.MARKER_ICONS) expect(TREK_MARKER_ICONS).toContain(icon);
    for (const tone of Object.values(d.TONE)) expect(TONES).toContain(tone);
    for (const c of [...Object.values(d.NIGHT_STATUS), ...Object.values(d.CHIP)]) expect(TONES).toContain(c.tone);
  });

  it('colours by state only: green booked, amber in discussion, red cancelled, blue otherwise', () => {
    const camp = { name: 'Camping X', categoryName: 'Night – Campsite' };
    expect(d.markerStyle({ name: 'Lake walk', categoryName: 'Hike' })).toEqual({ tone: 'default', icon: 'Mountain' }); // planned is not booked
    expect(d.markerStyle(camp, { night: true, status: 'booked' })).toMatchObject({ tone: 'success', icon: 'Tent', glyph: d.GLYPHS.tent });
    expect(d.markerStyle(camp, { night: true, status: 'contacted' }).tone).toBe('warn');
    expect(d.markerStyle(camp, { night: true, status: 'dropped' }).tone).toBe('danger');
    expect(d.markerStyle(camp, { night: true }).tone).toBe('default'); // planned, not asked yet: blue
    expect(d.markerStyle(camp, { night: true, status: 'spotted' }).tone).toBe('default');
  });

  it('draws the plugin\'s own pictograms for the ways to sleep, with a TREK icon as fallback', () => {
    const night = (categoryName, name, vehicle) => d.markerStyle({ categoryName, name }, { night: true, vehicle });
    expect(night('Nuitée – Aire', 'Area sosta')).toMatchObject({ icon: 'Car', glyph: d.GLYPHS.motorhome });
    expect(night('Nuitée – geoSpot', 'Spot', 'rooftop_tent').glyph).toEqual(d.GLYPHS['rooftop-tent']);
    expect(night('Nuitée – geoSpot', 'Spot', 'campervan').glyph).toEqual(d.GLYPHS.campervan);
    expect(night('Nuitée – geoSpot', 'Spot', 'motorhome').glyph).toEqual(d.GLYPHS.motorhome);
    expect(night('Night', 'Bivouac under the stars').glyph).toEqual(d.GLYPHS['sleeping-bag']);
    expect(night('Nuitée – Ferme / agricamping', 'Farm')).toEqual({ tone: 'default', icon: 'Leaf' });
    for (const g of Object.values(d.GLYPHS)) {
      expect(g.length).toBeGreaterThan(0);
      expect(g.length).toBeLessThanOrEqual(8);
      for (const [tag] of g) expect(['path', 'circle', 'rect', 'line', 'polyline']).toContain(tag);
    }
  });

  it('draws a pictogram per kind of place, from the category first, in several languages', () => {
    const night = (categoryName, name = 'X') => d.pictogramFor({ categoryName, name }, { night: true });
    const act = (categoryName, name = 'X') => d.pictogramFor({ categoryName, name });
    expect(night('Nuitée – Camping')).toBe('Tent');
    expect(night('Nuitée – Ferme / agricamping')).toBe('Leaf');
    expect(night('Nuitée – Chez l’habitant')).toBe('Home');
    expect(night('Night', 'Hotel Bellevue')).toBe('BedDouble');
    expect(night('Nuitée – Aire')).toBe('Car');
    expect(act('Voir – Randonnée')).toBe('Mountain');
    expect(act('Voir – Lac / nature')).toBe('Waves');
    expect(act('Voir – Point de vue')).toBe('Camera');
    expect(act('Manger – Marché / producteur')).toBe('Store');
    expect(act('Manger – Courses / boulangerie')).toBe('ShoppingBag');
    expect(act('Route – Carburant')).toBe('Car');
    expect(act('Visita', 'Museo del Prado')).toBe('Landmark');
    expect(act('', 'Rifugio Example')).toBe('Utensils');
    expect(act('', 'Somewhere')).toBe('MapPin');
    expect(night('Night', 'Chalet des Pins')).toBe('Home');
    expect(night('Unterkunft', 'Gasthof zur Post')).toBe('BedDouble');
    for (const [name, icon] of [['Location vélo', 'Bike'], ['Kayak sur le lac', 'Ship'], ['Gare de Brunico', 'Train'], ['Navette Tre Cime', 'Bus'],
      ['Aéroport', 'Plane'], ['Cinéma', 'Theater'], ['Concert', 'Music'], ['Dégustation de vin', 'Wine'], ['Brauerei', 'Beer'],
      ['Piscine municipale', 'Waves'], ['Escalade', 'Dumbbell'], ['Office de tourisme', 'Compass'], ['Zoo', 'Heart']]) {
      expect([name, act('', name)]).toEqual([name, icon]);
    }
  });
});

describe('a place given a kind in plain words', () => {
  it('finds the trip category for each kind from the instance\'s own names', () => {
    const cats = [
      { id: 1, name: 'Nuitée – Camping' }, { id: 2, name: 'Nuitée – Ferme / agricamping' }, { id: 3, name: 'Nuitée – Aire' },
      { id: 4, name: 'Voir – Randonnée' }, { id: 5, name: 'Voir – Lac / nature' }, { id: 6, name: 'Manger – Marché / producteur' },
    ];
    expect(d.categoryForKind(cats, 'farm').id).toBe(2);
    expect(d.categoryForKind(cats, 'campsite').id).toBe(1);
    expect(d.categoryForKind(cats, 'aire').id).toBe(3);
    expect(d.categoryForKind(cats, 'hike').id).toBe(4);
    expect(d.categoryForKind(cats, 'lake').id).toBe(5);
    expect(d.categoryForKind(cats, 'market').id).toBe(6);
    expect(d.categoryForKind(cats, 'zoo')).toBeNull();
    expect(d.KINDS).toEqual(expect.arrayContaining(['farm', 'campsite', 'aire', 'hotel', 'wild', 'hike', 'lake', 'groceries']));
  });
});
