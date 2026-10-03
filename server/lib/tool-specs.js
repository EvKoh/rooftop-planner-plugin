'use strict';
// The 8 MCP tools: the single source of their names, descriptions and input schemas.
// `npm run sync-manifest` copies them into trek-plugin.json (capabilities.mcpTools), and a
// test fails if the two drift — the host advertises only names present in BOTH lists.
// Schemas use only the keywords the host enforces (no oneOf/$ref); `default` is
// advertisement only, so the dispatcher applies defaults itself (withDefaults).

const SAFETY = 'Never book, pay or send a message to a host on the user\'s behalf: draft messages (English, then French) and show the exact text to the user, and act only on their explicit validation.';
const TRIP = { type: 'integer', minimum: 1, description: 'TREK trip id (list_trips gives it).' };
const DAY = { type: 'integer', minimum: 1, maximum: 400, description: 'Day number in the trip (1 = first day).' };
const HHMM = { type: 'string', pattern: '^[0-2]?[0-9]:[0-5][0-9]$', description: 'Local time, HH:MM.' };
const LAT = { type: 'number', minimum: -90, maximum: 90 };
const LNG = { type: 'number', minimum: -180, maximum: 180 };

const TOOL_SPECS = [
  {
    name: 'rooftop_tools_plan_trip',
    title: 'Plan or re-plan a rooftop-tent road trip (all-in-one)',
    description: `All-in-one planner for a car + rooftop-tent trip in TREK. With tripId: full check, challenges each night (cheaper legal campsite or farm nearby), day routes, schedules from real drive times (arrive the configured margin before sunset), budget; returns a report, an ordered action list and the core TREK calls to make (reorder_day_assignments, update_assignment_time, create_budget_item). When "continuation" is returned, call again with it until it is null. apply=false (default) only proposes; apply=true also writes the day route places. Without tripId, pass "request" (destination, dates, wishes) for the steps to create the trip. Research what is marked "toVerify" (price, rooftop tent accepted, open in season) on official sites first. ${SAFETY}`,
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
    name: 'rooftop_tools_check_trip',
    title: 'Check a rooftop-tent trip for problems',
    description: `Full read-only check of a TREK trip, day by day. Levels: blocking (arrival at the night later than sunset minus the margin, stop visited outside its opening hours, check-in window missed, minimum stay not met, motorhome area or car park used as a night, tents banned, booking marked confirmed with no confirmation number), fix (impossible times given real drive times, overlaps, route place missing or not first or not joined to the nights, shopping detour above the limit, nights without water in a row, stale booking/budget/to-do lines), verify (farm in a zone that forbids farm camping, closure mentioned in the notes, day ending after sunset, price above the ceiling or unknown), info (sunset margin of each night). Fix what is certain; ask the user about anything that needs a choice, with the saving in money or time. ${SAFETY}`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tripId'],
      properties: {
        tripId: TRIP,
        levels: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['blocking', 'fix', 'verify', 'info'] }, description: 'Levels to return (default all).' },
        language: { type: 'string', enum: ['en', 'fr'], description: 'Message language (default: the user setting).' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'rooftop_tools_find_nights',
    title: 'Find cheap legal nights for a rooftop tent',
    description: `Campsite and farm (agriturismo) candidates from OpenStreetMap between the evening's last visit and the next morning's first stop, ranked: forbidden last (motorhome areas are excluded: an opened rooftop tent is camping), then legal risk, then price, then the real detour in drive minutes; with total cost (night + fuel of the detour) and the saving versus the current night. Give tripId + dayNumber (the evening's day), or evening lat/lng (+ morning). OSM has no reviews and rarely prices: each candidate lists what to verify. If the tool plugin_rooftop-park4night-searcher_rooftop_tools_park4night_search is available, call it too for prices and ratings. Compare whole chains of nights, not one night at a time. ${SAFETY}`,
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
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'rooftop_tools_compute_routes',
    title: 'Compute the day routes (road geometry)',
    description: 'Road route of each day with Valhalla (car with the configured height; no tolls except on the motorway days set by the user): last night, the stops where the car goes, tonight. Returns km, drive time and legs per day. apply=false (default) proposes; apply=true recreates each day\'s route place in TREK (a place geometry cannot be edited, so the old one is deleted) and returns the core reorder_day_assignments calls that put each route first. Resume with startAt when "continuation" is returned. Re-run the check afterwards.',
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
    name: 'rooftop_tools_schedule_day',
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
    name: 'rooftop_tools_sun_times',
    title: 'Sunset and latest arrival per night',
    description: 'Sunrise, sunset and latest arrival (sunset minus the configured margin, to unfold the tent in daylight) for each day of a trip at that night\'s place, or for given dates at a point. Computed for the exact date and place in the user\'s time zone, never a "usual" hour. Read-only, no network.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tripId: TRIP,
        lat: LAT,
        lng: LNG,
        dates: { type: 'array', maxItems: 60, items: { type: 'string', format: 'date' } },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'rooftop_tools_supplies_on_route',
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
  {
    name: 'rooftop_tools_trip_budget',
    title: 'Trip budget and option comparison',
    description: 'Budget of the trip: each night (price x nights; unknown prices listed, never estimated), fuel per day from road km and the user\'s consumption and fuel price, tolls from budget lines, total. Compare options in money: each option = night price x nights + fuel of its extra km. Returns the core create_budget_item calls for missing fuel lines (make them only if the user agrees). Read-only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tripId'],
      properties: {
        tripId: TRIP,
        options: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label'],
            properties: {
              label: { type: 'string', maxLength: 120 },
              night_price: { type: 'number', minimum: 0 },
              nights: { type: 'integer', minimum: 1, maximum: 60 },
              extra_km: { type: 'number', minimum: -2000, maximum: 2000 },
            },
          },
        },
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
