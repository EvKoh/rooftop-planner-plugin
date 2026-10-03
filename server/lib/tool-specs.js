'use strict';
// The 8 MCP tools: the single source of their names, descriptions and input schemas.
// `npm run sync-manifest` copies them into trek-plugin.json (capabilities.mcpTools), and a
// test fails if the two drift — the host advertises only names present in BOTH lists.
// Schemas use only the keywords the host enforces (no oneOf/$ref); `default` is
// advertisement only, so the dispatcher applies defaults itself (withDefaults).

// Tools that would duplicate TREK's own MCP tools are left out on purpose: budget lines,
// place edits, assignments and trip summaries are core tools (create_budget_item,
// update_place, update_assignment_time, get_trip_summary...); these tools return the core
// calls to make instead of re-implementing them.
const SAFETY = 'Never book, pay or send a message to a host on the user\'s behalf: draft messages (English, then French) and show the exact text to the user, and act only on their explicit validation.';
const TRIP = { type: 'integer', minimum: 1, description: 'TREK trip id (list_trips gives it).' };
const DAY = { type: 'integer', minimum: 1, maximum: 400, description: 'Day number in the trip (1 = first day).' };
const HHMM = { type: 'string', pattern: '^[0-2]?[0-9]:[0-5][0-9]$', description: 'Local time, HH:MM.' };
const LAT = { type: 'number', minimum: -90, maximum: 90 };
const LNG = { type: 'number', minimum: -180, maximum: 180 };
const TRI = { type: 'string', enum: ['yes', 'no', 'unknown'] };

const TOOL_SPECS = [
  {
    name: 'vanlife_plan_trip',
    title: 'Plan or re-plan a vanlife road trip (all-in-one)',
    description: `All-in-one planner for a road trip with a rooftop tent, a campervan or a motorhome (the vehicle is the user's setting). With tripId: full check, challenges each night (cheaper legal night nearby), day routes, schedules from real drive times (arrive the configured margin before sunset), budget total (nights, fuel, tolls); returns a report, an ordered action list and the core TREK calls to make (reorder_day_assignments, update_assignment_time, create_budget_item). When "continuation" is returned, call again with it until it is null. apply=false (default) only proposes; apply=true also writes the day route places. Without tripId, pass "request" (destination, dates, wishes) for the steps to create the trip. Research what is marked "toVerify" (price, rooftop tent accepted, open in season) on official sites first. ${SAFETY}`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tripId: TRIP,
        apply: { type: 'boolean', default: false, description: 'false = propose only (default). true = also write the day route places.' },
        continuation: { type: 'string', maxLength: 64, description: 'Opaque token from the previous call, to resume.' },
        request: {
          type: 'object',
          additionalProperties: false,
          description: 'For a trip not yet in TREK.',
          properties: {
            destination: { type: 'string', maxLength: 200 },
            start_date: { type: 'string', format: 'date' },
            end_date: { type: 'string', format: 'date' },
            wishes: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 200 } },
          },
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'vanlife_check_trip',
    title: 'Check a vanlife trip for problems',
    description: `Read-only check of a TREK trip, day by day, for the user's vehicle. Levels: blocking (arrival after sunset minus the margin; stop visited outside its hours; check-in window or minimum stay missed; a night the vehicle may not use — motorhome area or car park for a rooftop tent, tents or dogs refused, height/length/weight limit; booking confirmed with no confirmation number), fix (times impossible with real drive times, overlaps, route place missing/not first/not joined, long shopping detour, nights without water in a row, stale booking/budget/to-do lines), verify (farm where farm camping is forbidden with a rooftop tent, van or motorhome night outside a site, closure in the notes, day ending after sunset, price above the ceiling or unknown), info (sunset margin of each night). Fix what is certain; ask the user about choices. ${SAFETY}`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tripId'],
      properties: {
        tripId: TRIP,
        levels: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['blocking', 'fix', 'verify', 'info'] }, description: 'Levels to return (default all).' },
        language: { type: 'string', enum: ['en', 'fr'], description: 'Message language (default: the user setting).' },
        sun: { type: 'boolean', default: false, description: 'Also return sunrise, sunset and latest arrival for each night.' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'vanlife_find_nights',
    title: 'Find cheap legal nights for the vehicle',
    description: `Night candidates between the evening's last visit and the next morning's first stop, from OpenStreetMap and, if the instance enables it, park4night (unofficial API that may change without notice; nothing stored; each result links to its page). Kinds follow the vehicle: campsites and farms for a rooftop tent; also motorhome areas, and car parks to verify, for a van or a motorhome. With sunset and latest arrival at the evening point when a date is known; ranked: forbidden last, then legal risk, then price, then the real detour in drive minutes; with total cost (night + fuel of the detour) and the saving versus the current night. Give tripId + dayNumber (the evening's day), or evening lat/lng (+ morning). OSM has no reviews and rarely prices: each candidate lists what to verify. Compare chains of nights, not one at a time. ${SAFETY}`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tripId: TRIP,
        dayNumber: DAY,
        lat: { ...LAT, description: 'Evening point latitude (when no trip).' },
        lng: { ...LNG, description: 'Evening point longitude.' },
        morning_lat: LAT,
        morning_lng: LNG,
        date: { type: 'string', format: 'date', description: 'Night date, for opening hours.' },
        radius_km: { type: 'number', minimum: 2, maximum: 50, default: 15, description: 'Search radius around the midpoint (km).' },
        sources: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['osm', 'park4night'] }, description: 'Default: osm, plus park4night when the instance enables it.' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'vanlife_compute_routes',
    title: 'Compute the day routes (road geometry)',
    description: 'Road route of each day with Valhalla, for the vehicle (height; length and weight for a motorhome, routed as a truck; no tolls except on the motorway days set by the user): last night, the stops where the car goes, tonight. Returns km, drive time and legs per day. apply=false (default) proposes; apply=true recreates each day\'s route place in TREK (a place geometry cannot be edited, so the old one is deleted) and returns the core reorder_day_assignments calls that put each route first. Resume with startAt when "continuation" is returned. Re-run the check afterwards.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tripId'],
      properties: {
        tripId: TRIP,
        dayNumbers: { type: 'array', maxItems: 60, uniqueItems: true, items: DAY, description: 'Days to route (default all).' },
        apply: { type: 'boolean', default: false },
        startAt: { type: 'integer', minimum: 0, maximum: 400, default: 0, description: 'Resume index from a previous continuation.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'vanlife_schedule_day',
    title: 'Schedule a day from real drive times',
    description: 'Computes start and end times of every stop of one day from real drive times (departure, drive, time on site, drive...), checks opening hours quoted in the notes, and the arrival at the night against sunset minus the margin; when late, says by how much and what fixes it. Returns the core update_assignment_time calls to write the times (the plugin API cannot set them). Read-only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tripId', 'dayNumber'],
      properties: {
        tripId: TRIP,
        dayNumber: DAY,
        departure: { ...HHMM, description: 'Departure from last night\'s place (default: keep the current plan, else 09:00).' },
        stays: {
          type: 'array',
          maxItems: 40,
          description: 'Time on site overrides.',
          items: { type: 'object', additionalProperties: false, required: ['assignmentId', 'minutes'], properties: { assignmentId: { type: 'integer', minimum: 1 }, minutes: { type: 'integer', minimum: 0, maximum: 1440 } } },
        },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'vanlife_place_info',
    title: 'Read or record the amenities and price details of places',
    description: 'Amenities and price details of the places of a trip, shown in the planner (columns on each place, the place widget) and used by the check and the budget. Without placeId: lists the places that have them, and the nights still to fill. With placeId and "set": the price goes to TREK\'s own place price (price_amount, currency); TREK has no field for the rest, kept by the plugin: per night or per person, dog fee, max height/length/weight, amenities (dog yes/no/fee, water, electricity, shower, toilets, dump station, wifi, rooftop tent accepted), each yes, no or unknown. Record only what a cited source states (official site first, then a dated review or the host\'s written answer, in "source"); leave everything else unknown, never estimate. "clear": true removes the record. "fill": true fills unknown amenities from OpenStreetMap and park4night, citing them in "source". Writes only the plugin\'s own data on the place, never the trip itself. Never book or message a host without the user\'s explicit validation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tripId'],
      properties: {
        tripId: TRIP,
        placeId: { type: 'integer', minimum: 1, description: 'TREK place id.' },
        clear: { type: 'boolean', default: false },
        fill: { type: 'boolean', default: false, description: 'Fill unknown amenities from OpenStreetMap (and park4night if the instance enables it): the place given by placeId, or the next 20 places of the trip; call again while "remaining" is above 0. Never overwrites a recorded value.' },
        set: {
          type: 'object',
          additionalProperties: false,
          properties: {
            price_amount: { type: 'number', minimum: 0, maximum: 100000, nullable: true },
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
            per: { type: 'string', enum: ['night', 'person'] },
            dog_fee: { type: 'number', minimum: 0, maximum: 1000, nullable: true },
            max_height_m: { type: 'number', minimum: 1, maximum: 6, nullable: true },
            max_length_m: { type: 'number', minimum: 2, maximum: 25, nullable: true },
            max_weight_t: { type: 'number', minimum: 0.5, maximum: 60, nullable: true },
            dog: { type: 'string', enum: ['yes', 'no', 'fee', 'unknown'] },
            water: TRI, electricity: TRI, shower: TRI, toilets: TRI, dump_station: TRI, wifi: TRI, rooftop_tent: TRI,
            source: { type: 'string', maxLength: 300 },
            checked: { type: 'string', format: 'date', description: 'Date the source was read.' },
          },
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'vanlife_supplies_on_route',
    title: 'Groceries, fuel and water along a day\'s route',
    description: 'Supermarkets, fuel stations and drinking water along a day\'s route (OpenStreetMap), so shopping costs no detour: distance along the route, distance off it, approximate detour (the check measures the real one once planned), opening hours on that date and whether open at the pass time. Verify hours and the dog rule on the official page. Read-only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tripId', 'dayNumber'],
      properties: {
        tripId: TRIP,
        dayNumber: DAY,
        kinds: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['groceries', 'fuel', 'water'] }, description: 'Default groceries and fuel.' },
        at: { ...HHMM, description: 'Expected pass time, to tell which places are open then.' },
        corridor_km: { type: 'number', minimum: 0.3, maximum: 5, default: 2, description: 'Max distance off the route (km).' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

const TOOL_NAMES = TOOL_SPECS.map((t) => t.name);

/** Copy top-level schema defaults onto missing args (the host never injects them). */
function withDefaults(name, args) {
  const spec = TOOL_SPECS.find((t) => t.name === name);
  const out = { ...(args && typeof args === 'object' ? args : {}) };
  for (const [k, p] of Object.entries(spec?.inputSchema?.properties || {})) {
    if (out[k] === undefined && p.default !== undefined) out[k] = p.default;
  }
  return out;
}

module.exports = { TOOL_SPECS, TOOL_NAMES, withDefaults, SAFETY };
