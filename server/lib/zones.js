'use strict';
// Local law on where the night may be spent, by zone (the texts and their sources are in
// the message catalogues, keys zone.<id>.name / .farm / .van). A tent unfolded on a vehicle
// counts as camping, so what matters is the kind of ground the night is spent on.
//
// Polygons are deliberately coarse outlines ([lat, lng] vertices, ~5 km precision): good
// enough to tell Bolzano and Val Pusteria (South Tyrol) from Cortina d'Ampezzo (Veneto),
// not a cadastral boundary. A night close to a border must still be checked by hand (the
// README says so).
//
// Sources (checked 2026-10-03):
//  - South Tyrol: municipal model regulation 2026 — camping outside authorised sites is
//    forbidden, a tent on a vehicle is camping, fine EUR 300–900. Farm camping needs an
//    authorisation, so a farm night there is a legal risk.
//  - Liguria: regional law LR 37/2007 art. 7 — "agricampeggio" on an agriturismo is legal.
//  - Veneto: regional law LR 28/2012 — agriturismo camping pitches are legal.
//  - Italy (all regions): Codice della strada art. 185 — a motorhome area allows parking,
//    not camping; an opened rooftop tent is camping behaviour.

const ZONES = [
  {
    id: 'south-tyrol',
    farm: 'risk',
    note: 'only an authorised campsite is legal; farm camping without authorisation is fined EUR 300-900',
    noteFr: 'seul un camping autorisé est légal ; camper à la ferme sans autorisation coûte 300 à 900 € d\'amende',
    polygon: [
      [46.85, 10.46], [47.0, 11.51], [47.09, 12.18], [46.75, 12.4], [46.65, 12.43], [46.62, 12.24],
      [46.55, 12.05], [46.53, 11.99], [46.52, 11.87], [46.51, 11.76], [46.4, 11.61], [46.24, 11.21],
      [46.42, 11.2], [46.47, 10.85], [46.53, 10.45],
    ],
  },
  {
    id: 'veneto',
    farm: 'ok',
    polygon: [
      [46.68, 12.73], [46.62, 12.24], [46.55, 12.05], [46.52, 11.87], [46.25, 11.68], [45.85, 10.95],
      [45.6, 10.65], [45.1, 11.2], [44.8, 12.3], [45.3, 12.6], [45.65, 13.1], [46.1, 12.5],
    ],
  },
  {
    id: 'liguria',
    farm: 'ok',
    note: 'agricampeggio on an agriturismo is legal (LR 37/2007 art. 7)',
    noteFr: 'l\'agricampeggio d\'un agriturismo est légal (LR 37/2007 art. 7)',
    polygon: [
      [43.78, 7.52], [44.08, 7.7], [44.2, 8.0], [44.42, 8.3], [44.6, 8.75], [44.62, 9.1],
      [44.45, 9.5], [44.35, 9.85], [44.05, 10.07], [44.0, 9.85], [44.25, 9.3], [44.4, 8.8],
      [44.25, 8.4], [43.9, 8.0],
    ],
  },
];

/** Ray-casting point-in-polygon on [lat,lng] vertices. */
function inPolygon([lat, lng], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The zone a point falls in, or null when no rule is known for it. */
function zoneAt(lat, lng) {
  if (lat == null || lng == null) return null;
  return ZONES.find((z) => inPolygon([+lat, +lng], z.polygon)) || null;
}

module.exports = { ZONES, zoneAt, inPolygon };
