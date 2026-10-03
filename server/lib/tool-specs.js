'use strict';
// The MCP tools (TREK takes 8 per plugin; 7 are used, one place is left free): the single source of their names, descriptions and input schemas.
// `npm run sync-manifest` copies them into trek-plugin.json (capabilities.mcpTools), and a
// test fails if the two drift — the host advertises only names present in BOTH lists.
// Schemas use only the keywords the host enforces (no oneOf/$ref); `default` is
// advertisement only, so the dispatcher applies defaults itself (withDefaults).

// Tools that would duplicate TREK's own MCP tools are left out on purpose: budget lines,
// place edits, assignments and trip summaries are core tools (create_budget_item,
// update_place, update_assignment_time, get_trip_summary...); these tools return the core
// calls to make instead of re-implementing them.
const SAFETY = 'Never book, pay or send a message to a host for the user: show them the exact text first and act only on their explicit validation.';
const TRIP = { type: 'integer', minimum: 1, description: 'TREK trip id (list_trips gives it).' };
const DAY = { type: 'integer', minimum: 1, maximum: 400, description: 'Day number in the trip (1 = first day).' };
const HHMM = { type: 'string', pattern: '^[0-2]?[0-9]:[0-5][0-9]$', description: 'Local time, HH:MM.' };
const LAT = { type: 'number', minimum: -90, maximum: 90 };
const LNG = { type: 'number', minimum: -180, maximum: 180 };
const { AMENITIES, PER, PRICE_NOTE_MAX } = require('./place-info');
// One yes/no/unknown property per amenity (dog also takes "fee"), in place-info's order.
const AMENITY_PROPS = Object.fromEntries(Object.entries(AMENITIES).map(([k, v]) => [k, { type: 'string', enum: v }]));

const TOOL_SPECS = [
  {
    name: 'vanlife_plan_trip',
    title: 'Plan or re-plan a vanlife road trip (all-in-one)',
    description: `All-in-one planner for a road trip with a rooftop tent, a campervan or a motorhome (the user's setting). With tripId: full check, challenges each night (cheaper legal night nearby), day routes, schedules from real drive times (arrive the configured margin before sunset), budget total (nights, fuel, tolls); returns a report, an ordered action list and the core TREK calls to make (reorder_day_assignments, update_assignment_time, create_budget_item). When "continuation" is returned, call again with it until it is null. apply=false (default) only proposes; apply=true also writes the day route places. Without tripId, pass "request" (destination, dates, wishes) for the steps to create the trip. Research what is marked "toVerify" on official sites first; vanlife_host_message drafts a question to a host. ${SAFETY}`,
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
    description: `Read-only check of a trip, day by day, for the user's vehicle. Levels: blocking (arrival after sunset minus the margin; stop visited outside its hours; check-in window or minimum stay missed; a night the vehicle may not use — motorhome area or car park for a rooftop tent, tents or dogs refused, height/length/weight limit; booking confirmed with no confirmation number), fix (times impossible with real drive times, overlaps, route place missing/not first/not joined, long shopping detour, nights without water in a row, stale booking/budget/to-do lines), verify (no e-mail or phone for a night, host contacted over 3 days ago with no answer logged, farm where farm camping is forbidden, van night outside a site, closure in the notes, day ending after sunset, price above the ceiling or unknown), info (sunset margin of each night). Fix what is certain; ask the user about choices. ${SAFETY}`,
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
    description: `Night candidates between the evening's last visit and the next morning's first stop, from OpenStreetMap and, if the instance enables it, park4night (unofficial API; nothing stored; each result links to its page). Kinds follow the vehicle: campsites and farms for a rooftop tent; also motorhome areas, and car parks to verify, for a van or a motorhome. With sunset and latest arrival when a date is known; ranked: forbidden last, then legal risk, then price, then the real detour in drive minutes; with total cost (night + fuel of the detour) and the saving versus the current night. Give tripId + dayNumber (the evening's day), or evening lat/lng (+ morning). Each candidate gives the contacts OSM knows (email, phone, website). OSM has no reviews and rarely prices: each candidate lists what to verify. Compare chains of nights, not one at a time. ${SAFETY}`,
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
    name: 'vanlife_day',
    title: 'One day of the trip: routes, schedule or supplies',
    description: 'Work on the days of a trip; pick "action". "routes": road route of each day with Valhalla for the vehicle (height; length and weight for a motorhome; no tolls except on the motorway days set by the user): km, drive time and legs per day; apply=false (default) proposes, apply=true recreates each day\'s route place in TREK (the old one is deleted) and returns the core reorder_day_assignments calls; resume with startAt when "continuation" is returned. "schedule": start and end of every stop of one day (dayNumber) from real drive times, opening hours in the notes, arrival at the night against sunset minus the margin; returns the core update_assignment_time calls; read-only. "supplies": supermarkets, fuel and drinking water along one day\'s route (dayNumber), distance off the route, hours on that date and whether open at the pass time; read-only. Re-run vanlife_check_trip after a change.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tripId', 'action'],
      properties: {
        tripId: TRIP,
        action: { type: 'string', enum: ['routes', 'schedule', 'supplies'], description: 'routes = road geometry of the days; schedule = times of one day; supplies = shops, fuel and water along one day.' },
        dayNumber: { ...DAY, description: 'The day (schedule and supplies: required).' },
        dayNumbers: { type: 'array', maxItems: 60, uniqueItems: true, items: DAY, description: 'routes: days to route (default all).' },
        apply: { type: 'boolean', default: false, description: 'routes: false = propose only (default); true = write the route places.' },
        startAt: { type: 'integer', minimum: 0, maximum: 400, default: 0, description: 'routes: resume index from a previous continuation.' },
        departure: { ...HHMM, description: 'schedule: departure from last night\'s place (default: keep the current plan, else 09:00).' },
        stays: {
          type: 'array',
          maxItems: 40,
          description: 'schedule: time on site overrides.',
          items: { type: 'object', additionalProperties: false, required: ['assignmentId', 'minutes'], properties: { assignmentId: { type: 'integer', minimum: 1 }, minutes: { type: 'integer', minimum: 0, maximum: 1440 } } },
        },
        kinds: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['groceries', 'fuel', 'water'] }, description: 'supplies: default groceries and fuel.' },
        at: { ...HHMM, description: 'supplies: expected pass time, to tell which places are open then.' },
        corridor_km: { type: 'number', minimum: 0.3, maximum: 5, default: 2, description: 'supplies: max distance off the route (km).' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'vanlife_place',
    title: 'Everything about a place: amenities, price, contacts, exchanges',
    description: `Read and keep what TREK has no field for on a place: amenities, price details, the host's contacts and the log of exchanges; used by the planner, the check, the budget and vanlife_host_message. Without placeId: list places by "filter" within "scope" (default: planned nights, i.e. with a lodging; counts of all scopes returned). With placeId: read one; "set" records fields (price on TREK's own price, its unit "per" — never night for a museum, lake or car park — and "price_note" for a free formula; amenities yes/no/unknown; contacts: null erases a field); "log" adds one exchange; "clear" removes the record, "clear_fields" only the named fields; "fill" fills empty amenities and contacts from the place's notes and TREK fields, OpenStreetMap and park4night, citing each source (platform pages are never a website). A known website or phone is copied into TREK's empty fields. Record only what a cited source states; never estimate. Never book, pay or message a host without the user's validation.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tripId'],
      properties: {
        tripId: TRIP,
        placeId: { type: 'integer', minimum: 1, description: 'TREK place id. Omit to list places.' },
        filter: { type: 'string', enum: ['nights', 'missing_contacts', 'missing_amenities', 'all'], default: 'nights', description: 'List (no placeId): nights = the nights of the scope; missing_contacts = those with no e-mail or phone; missing_amenities = those with a key amenity unknown; all = every place (scope ignored).' },
        scope: { type: 'string', enum: ['planned', 'candidates', 'all_nights'], default: 'planned', description: 'Which nights the list covers: planned = places with a lodging in the trip (default); candidates = night-category places with no lodging; all_nights = both.' },
        set: {
          type: 'object',
          additionalProperties: false,
          properties: {
            price_amount: { type: 'number', minimum: 0, maximum: 100000, nullable: true },
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
            per: { type: 'string', enum: PER, nullable: true, description: 'Unit of the price: night, person, person_night, day, hour, entry (a visit), vehicle, flat (lump sum, no unit); null = not said (a night place then reads per night).' },
            price_note: { type: 'string', maxLength: PRICE_NOTE_MAX, nullable: true, description: 'Free price formula, shown instead of the unit, e.g. "free the first 2 hours, then 5 €/h", "donation", "3 €/person + 2 € dog".' },
            dog_fee: { type: 'number', minimum: 0, maximum: 1000, nullable: true },
            max_height_m: { type: 'number', minimum: 1, maximum: 6, nullable: true },
            max_length_m: { type: 'number', minimum: 2, maximum: 25, nullable: true },
            max_weight_t: { type: 'number', minimum: 0.5, maximum: 60, nullable: true },
            ...AMENITY_PROPS,
            source: { type: 'string', maxLength: 300, description: 'Where the amenities and prices come from.' },
            checked: { type: 'string', format: 'date', description: 'Date the source was read.' },
            contacts: {
              type: 'object',
              additionalProperties: false,
              description: 'The host\'s contacts; null erases a field.',
              properties: {
                email: { type: 'string', maxLength: 254, nullable: true },
                phone: { type: 'string', maxLength: 40, nullable: true, description: 'International form preferred: +39 0471 000000.' },
                whatsapp: { type: 'string', maxLength: 40, nullable: true },
                website: { type: 'string', maxLength: 500, nullable: true, description: 'http(s) address.' },
                contact_name: { type: 'string', maxLength: 100, nullable: true },
                languages: { type: 'array', maxItems: 8, nullable: true, items: { type: 'string', maxLength: 20 }, description: 'Languages the host speaks, e.g. ["it", "de", "en"].' },
                preferred_channel: { type: 'string', enum: ['email', 'phone', 'whatsapp', 'website_form'], nullable: true },
                notes: { type: 'string', maxLength: 300, nullable: true, description: 'Short, e.g. "answers in the evening".' },
              },
            },
          },
        },
        log: {
          type: 'object',
          additionalProperties: false,
          required: ['date', 'channel', 'direction', 'summary'],
          description: 'One exchange with the host, added to the place\'s log. Record a message as "sent" only once the user has sent it.',
          properties: {
            date: { type: 'string', format: 'date' },
            channel: { type: 'string', enum: ['email', 'phone', 'whatsapp', 'website_form', 'sms', 'in_person', 'other'] },
            direction: { type: 'string', enum: ['sent', 'received'] },
            summary: { type: 'string', maxLength: 300, description: 'One short sentence: what was asked or answered.' },
          },
        },
        clear: { type: 'boolean', default: false, description: 'Remove the whole record of the place.' },
        clear_fields: { type: 'array', maxItems: 40, uniqueItems: true, items: { type: 'string', maxLength: 40 }, description: 'Clear only these: an amenity key, dog_fee, max_height_m, per, price_note, source, checked, a contact field (email, phone...), or amenities / contacts / log.' },
        fill: { type: 'boolean', default: false, description: 'Fill empty amenities and contacts: the place given by placeId, or the next 20 places of the trip; call again while "remaining" is above 0. Never overwrites a recorded value.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'vanlife_night',
    title: 'Status of each night: spotted, contacted, booked, dropped',
    description: `Where each night of the trip stands, kept in TREK's own bookings. Statuses: spotted (a place with no booking), contacted (booking "pending": the host was asked), booked (booking "confirmed", with its confirmation number when there is one), dropped (booking "cancelled", with a short reason). action "list": one line per night (day, place, status, contact, last exchange, price, days waiting for an answer). action "set": placeId + dayNumber (the evening) + status: creates or updates the hotel booking tied to that place and day (and plans the night if the day has none). Use it after the user says they asked, booked or gave up a place. This only records what the user declares: it never books, pays or contacts anyone; never set "booked" unless the user says the host confirmed.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tripId', 'action'],
      properties: {
        tripId: TRIP,
        action: { type: 'string', enum: ['list', 'set'] },
        placeId: { type: 'integer', minimum: 1, description: 'set: the place of the night.' },
        dayNumber: { ...DAY, description: 'set: the day whose evening the night starts.' },
        dayId: { type: 'integer', minimum: 1, description: 'set: TREK day id, instead of dayNumber.' },
        status: { type: 'string', enum: ['spotted', 'contacted', 'booked', 'dropped'], description: 'set: the new status.' },
        confirmation: { type: 'string', maxLength: 100, description: 'set booked: the host\'s confirmation number or reference.' },
        reason: { type: 'string', maxLength: 200, description: 'set dropped: why, in a few words (full, no tents, too expensive...).' },
        notes: { type: 'string', maxLength: 500, description: 'set: notes written on the booking.' },
        nights: { type: 'integer', minimum: 1, maximum: 30, description: 'set, when the day has no night yet: how many nights (default 1).' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'vanlife_host_message',
    title: 'Draft the information request to a night\'s host',
    description: 'Drafts the message asking the host of a night what is still unknown: rooftop tent (or van) accepted, dog and its supplement, open on the date, estimated arrival time, price, water and electricity when useful. Uses the dates of the night and the crew from the settings (travellers, dog, vehicle). Text in English, then a line of dashes, then French (option language_extra adds Italian or German). Returns the recipient (known contact and preferred channel), a subject, the text and the list of questions. It is a request for information, not a booking. It SENDS NOTHING: show the user the exact text and wait for their explicit validation before it is sent; never send, book or pay on their behalf. After the user sends it, record it with vanlife_place log and vanlife_night status "contacted".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tripId', 'placeId'],
      properties: {
        tripId: TRIP,
        placeId: { type: 'integer', minimum: 1, description: 'The place of the night.' },
        dayNumber: { ...DAY, description: 'The evening of the night (default: the day the place is planned as a night).' },
        nights: { type: 'integer', minimum: 1, maximum: 30, description: 'Number of nights (default: the planned ones, else 1).' },
        arrival: { ...HHMM, description: 'Estimated arrival (default: the planned time of the night in the day).' },
        extra_questions: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 }, description: 'Further questions, in English.' },
        language_extra: { type: 'string', enum: ['it', 'de'], description: 'Add the local language after the French.' },
        signature: { type: 'string', maxLength: 80, description: 'Name to sign with, if the user gives one.' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
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
