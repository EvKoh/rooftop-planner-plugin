'use strict';
// A FICTIONAL four-day trip (no real booking, no person): public places (lakes, a pass)
// and invented businesses named "... Example". It is built to contain, on purpose, the
// mistakes the checker exists for — each one is asserted in check.test.js:
//   day 1  arrival at the night after sunset - 60 min          → blocking night_late
//          "Closed on Monday" stop visited on a Monday          → verify closure_cited
//          shopping stop far off the road (≥ 30 min detour)     → fix shop_detour
//          night at 38 € (ceiling 35)                           → verify price_high
//   day 2  stop visited outside its Tuesday opening hours        → blocking outside_hours
//          night on a motorhome area                            → blocking night_aire
//          route place not first of the day                     → fix trace_not_first
//   day 3  farm night in South Tyrol                             → verify night_farm_zone
//          2nd night in a row without water                     → fix water_fix
//          "2 nights minimum" for a 1-night stay                → blocking min_nights
//          no route place                                       → fix no_trace
//   stale  booking auto-confirmed, booking titled after another place, budget and to-do
//          lines naming a night that is no longer planned, budget total ≠ planned nights.

const CATS = [
  { id: 1, name: 'Night – Campsite' }, { id: 2, name: 'Night – Motorhome area' }, { id: 3, name: 'Night – Farm' },
  { id: 4, name: 'See – Lake' }, { id: 5, name: 'Food – Groceries' }, { id: 6, name: 'Route – Day route' }, { id: 7, name: 'See – Museum' },
];
const cat = (id) => CATS.find((c) => c.id === id);

const P = {
  braies: { id: 10, name: 'Lago di Braies', lat: 46.6946, lng: 12.0853, category_id: 4, notes: 'Lake walk, 2 h.' },
  museum: { id: 11, name: 'Mountain Museum Example', lat: 46.74, lng: 11.96, category_id: 7, notes: 'Closed on Monday. Ticket 12 €.' },
  shop: { id: 12, name: 'Supermarket Example', lat: 46.8, lng: 11.94, category_id: 5, notes: '' },
  camping: { id: 13, name: 'Camping Example', lat: 46.53, lng: 12.13, category_id: 1, price: 38, notes: 'Check-in 8h–21h. Hot showers, drinking water.' },
  giau: { id: 14, name: 'Passo Giau', lat: 46.4828, lng: 12.0536, category_id: 4, notes: 'Viewpoint.' },
  visitor: { id: 15, name: 'Visitor Centre Example', lat: 46.54, lng: 12.14, category_id: 7, notes: 'Opening hours — Tuesday: 9h00–12h00.' },
  aire: { id: 16, name: 'Aire Example Misurina', lat: 46.58, lng: 12.25, category_id: 2, price: 15, notes: 'No water, no facilities.' },
  carezza: { id: 17, name: 'Lago di Carezza', lat: 46.4097, lng: 11.5753, category_id: 4, notes: '' },
  farm: { id: 18, name: 'Farm Example', lat: 46.64, lng: 11.72, category_id: 3, price: 20, notes: 'No water on site. 2 nights minimum.' },
  oldChoice: { id: 19, name: 'Camping Old Choice', lat: 46.55, lng: 12.15, category_id: 1, price: 30, notes: '' },
  route1: { id: 20, name: 'Route day 1', lat: 46.6946, lng: 12.0853, category_id: 6, route_geometry: JSON.stringify([[46.6946, 12.0853], [46.74, 11.96], [46.8, 11.94], [46.53, 12.13]]) },
  route2: { id: 21, name: 'Route day 2', lat: 46.53, lng: 12.13, category_id: 6, route_geometry: JSON.stringify([[46.53, 12.13], [46.4828, 12.0536], [46.54, 12.14], [46.58, 12.25]]) },
  route4: { id: 22, name: 'Route day 4', lat: 46.64, lng: 11.72, category_id: 6, route_geometry: JSON.stringify([[46.64, 11.72], [46.5, 11.35]]) },
};

function asg(id, order, place, { time = null, end = null, acc = null, notes = null } = {}) {
  return {
    id, day_id: null, order_index: order, notes, accommodation_id: acc,
    place: { ...place, place_time: time, end_time: end, category: place.category_id ? cat(place.category_id) : null, description: '' },
  };
}

function build({ fixed = false } = {}) {
  const days = [
    { id: 101, day_number: 1, date: '2026-10-12', notes_items: [], assignments: [
      asg(1001, 0, P.route1),
      asg(1002, 1, P.braies, { time: '10:00', end: '12:00' }),
      asg(1003, 2, P.museum, { time: '12:45', end: '13:45' }),
      asg(1004, 3, P.shop, { time: '15:00', end: '15:30' }),
      asg(1005, 4, P.camping, { time: fixed ? '17:00' : '18:40', acc: 1 }),
    ] },
    { id: 102, day_number: 2, date: '2026-10-13', notes_items: [], assignments: [
      asg(2001, 0, P.giau, { time: '10:00', end: '11:00' }),
      asg(2002, 1, P.route2),
      asg(2003, 2, P.visitor, { time: fixed ? '11:30' : '14:00', end: fixed ? '11:55' : '15:00' }),
      asg(2004, 3, P.aire, { time: '16:30', acc: 2 }),
    ] },
    { id: 103, day_number: 3, date: '2026-10-14', notes_items: [], assignments: [
      asg(3001, 0, P.carezza, { time: '11:00', end: '12:00' }),
      asg(3002, 1, P.farm, { time: '16:00', acc: 3 }),
    ] },
    { id: 104, day_number: 4, date: '2026-10-15', notes_items: [], assignments: [asg(4001, 0, P.route4)] },
  ];
  for (const d of days) for (const a of d.assignments) a.day_id = d.id;
  const accommodations = [
    { id: 1, place_id: 13, place_name: P.camping.name, place_lat: P.camping.lat, place_lng: P.camping.lng, start_day_id: 101, end_day_id: 102, check_in: null, notes: '' },
    { id: 2, place_id: 16, place_name: P.aire.name, place_lat: P.aire.lat, place_lng: P.aire.lng, start_day_id: 102, end_day_id: 103, check_in: null, notes: '' },
    { id: 3, place_id: 18, place_name: P.farm.name, place_lat: P.farm.lat, place_lng: P.farm.lng, start_day_id: 103, end_day_id: 104, check_in: null, notes: '' },
  ];
  return {
    members: [42],
    data: { id: 1, title: 'Example rooftop loop', currency: 'EUR', start_date: '2026-10-12', end_date: '2026-10-15' },
    places: Object.values(P).map((p) => ({ ...p, trip_id: 1, description: '' })),
    days,
    accommodations,
    reservations: [
      { id: 501, title: 'Camping Example (night 1)', status: 'confirmed', confirmation_number: null, accommodation_id: '1' },
      { id: 502, title: 'Camping Old Choice', status: 'pending', confirmation_number: null, accommodation_id: '2' },
    ],
    costs: [
      { id: 601, name: 'Night 13/10 — Camping Old Choice', category: 'Accommodation', total_price: 30 },
      { id: 602, name: 'Motorway tolls day 1', category: 'Transport', total_price: 18.5 },
    ],
    todos: [{ id: 701, name: 'Book Camping Old Choice', checked: false }],
  };
}

module.exports = { build, CATS, P };
