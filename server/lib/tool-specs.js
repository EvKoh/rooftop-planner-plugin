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
const { AMENITIES, PER, PRICE_NOTE_MAX, BOOKING_NOTE_MAX, TOLL_MAX } = require('./place-info');
// One yes/no/unknown property per amenity (dog also takes "fee"), in place-info's order.
const AMENITY_PROPS = Object.fromEntries(Object.entries(AMENITIES).map(([k, v]) => [k, { type: 'string', enum: v }]));

const TOOL_SPECS = [
  {
    name: 'vanlife_plan_trip',
    title: 'Plan or re-plan a vanlife road trip (all-in-one)',
    description: `All-in-one planner for a road trip with a rooftop tent, a campervan or a motorhome (the user's setting). With tripId: full check, challenges each night (cheaper legal night nearby), day routes, schedules from real drive times (arrive the configured margin before sunset), budget total (nights, fuel, tolls incl. places' access tolls), overloaded days from visit durations, possible savings; returns a report, an ordered action list and the core TREK calls to make (reorder_day_assignments, update_assignment_time, create_budget_item). When "continuation" is returned, call again with it until it is null. apply=false (default) only proposes; apply=true also writes the day route places. Without tripId, pass "request" (destination, dates, wishes) for the steps to create the trip. Research what is marked "toVerify" on official sites first; vanlife_host_message drafts a question to a host. ${SAFETY}`,
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
    description: `Read-only check of a trip, by day for the user's vehicle. Levels: blocking (arrival after sunset minus margin; stop outside its hours; arrival after a place's access_before; check-in window or minimum stay missed; a night the vehicle may not use: motorhome area or car park for a rooftop tent, tent or dog refused, size limit; booking confirmed with no number), fix (impossible times, overlaps, arrival before access_after or in closed hours; route place missing/not first/not joined; long shopping detour; dry nights in a row; stale lines; overloaded day; over one big or two small activities a day), verify (booking required, none recorded, with link; no host contact or host silent 3 days; farm zone; van night off-site; closure in the notes; after sunset; price above the ceiling or unknown; visit duration unknown; cheaper legal night within 20 min; back to the same camp against the next day's route), info (sunset margins). Fix what is certain; ask the user about choices. Never book, pay or message a host for them.`,
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
    description: 'Work on the days of a trip; pick "action". "routes": road route of each day with Valhalla for the vehicle (height; length and weight for a motorhome; no tolls except on the motorway days set by the user): km, drive time and legs per day; apply=false (default) proposes, apply=true recreates each day\'s route place in TREK (the old one is deleted) and returns the core reorder_day_assignments calls; resume with startAt when "continuation" is returned. "schedule": start and end of every stop of one day (dayNumber) from real drive times, opening hours in the notes, arrival at the night against sunset minus the margin; with no departure given, moves it to meet places\' access_before/access_after (else a conflict); returns the core update_assignment_time calls; read-only. "supplies": supermarkets, fuel and drinking water along one day\'s route (dayNumber), distance off the route, hours on that date and whether open at the pass time; read-only. Re-run vanlife_check_trip after a change.',
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
    description: `Keep what TREK has no field for on a place: amenities, price details, visit duration, timed access, the host's contacts and exchanges. Without placeId: list places by "filter" within "scope" (default: planned nights; counts per scope). With placeId: read one; "set" records fields (price on TREK's own price, unit "per" — never night for a museum, lake or car park — and "price_note", a free formula; visit minutes; access_before/access_after "HH:MM", booking_required (+ booking_url, booking_note), toll_amount per vehicle (+ toll_currency); amenities yes/no/unknown; null erases a field); "log" adds an exchange; "clear" removes the record, "clear_fields" named fields; "fill" fills empty amenities, contacts and a stated visit duration from the place's notes and TREK fields, OpenStreetMap and park4night, citing each source (a platform page is never a website). A website or phone is copied into TREK's empty fields. Record only what a cited source states. Never book, pay or message a host unvalidated.`,
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
            visit_min_minutes: { type: 'integer', minimum: 5, maximum: 1440, nullable: true, description: 'Least time on site of a visit (museum, lake, hike), in minutes; the check sums it into the day. null erases.' },
            visit_max_minutes: { type: 'integer', minimum: 5, maximum: 1440, nullable: true, description: 'Most time on site, optional.' },
            access_before: { ...HHMM, nullable: true, description: 'Timed access: arrive before this local time, the road (toll road, pass, valley) is closed to cars after it. null erases.' },
            access_after: { ...HHMM, nullable: true, description: 'Timed access: cars allowed only after this local time. With access_before earlier than it, the road is closed in between (arrive before OR after); with access_before later, open in between. null erases.' },
            booking_required: { type: 'boolean', nullable: true, description: 'true = a booking is required to get in (time slot, car park, road permit); null = not known.' },
            booking_url: { type: 'string', maxLength: 500, nullable: true, description: 'http(s) address where the booking is made.' },
            booking_note: { type: 'string', maxLength: BOOKING_NOTE_MAX, nullable: true, description: 'Short booking detail, e.g. "30-min slots, book 2 days ahead".' },
            toll_amount: { type: 'number', minimum: 0, maximum: TOLL_MAX, nullable: true, description: 'Toll or access ticket per vehicle (mountain toll road, park entry); added to that day\'s budget.' },
            toll_currency: { type: 'string', pattern: '^[A-Z]{3}$', nullable: true, description: '3-letter ISO code of the toll; default: the place\'s or trip\'s currency.' },
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
        clear_fields: { type: 'array', maxItems: 40, uniqueItems: true, items: { type: 'string', maxLength: 40 }, description: 'Clear only these: an amenity key, dog_fee, max_height_m, visit_min_minutes, per, price_note, source, checked, access_before, access_after, booking_required, booking_url, booking_note, toll_amount, toll_currency, a contact field (email, phone...), or amenities / contacts / log.' },
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
