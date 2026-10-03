# Rooftop Planner

Plans road trips with a rooftop tent in [TREK](https://github.com/liketrek/TREK): sunset-safe
arrivals, legal campsites, routes, schedules, supplies and budget — as MCP tools any assistant
connected to TREK can call, as warnings in the planner, and as a trip tab readable on a phone.

![screenshot](./docs/screenshot.png)

## What it does

A rooftop tent has to be unfolded in daylight, and opening it anywhere other than a campsite or a
farm that hosts campers is camping (a motorhome area or a car park is not enough). This plugin
checks a trip against those rules and helps fix it.

- **Trip check** — day by day, at four levels (blocking / to fix / to verify / info):
  arrival at the night later than *sunset minus a margin* (sunset computed for the exact date and
  place, daylight saving included); a stop visited on its closing day or outside the hours quoted in
  its notes; a check-in window or minimum stay not met; a night on a motorhome area or car park;
  tents banned; a farm night in a zone where farm camping is illegal (South Tyrol); times that real
  drive times make impossible; overlapping stops; a shopping detour over the limit; several nights
  in a row without water; the day's route place missing, not first, or not joined to the nights;
  bookings auto-confirmed by TREK; budget lines and to-dos naming a night that is no longer planned.
- **Nights** — campsites and farms (agriturismo) from OpenStreetMap between the evening's last visit
  and the next morning's first stop, ranked: forbidden last, then legal risk, then price, then the
  real detour in drive minutes, with the total cost (night + fuel of the detour). What OSM cannot
  tell (reviews, often prices, rooftop-tent acceptance) is listed as *to verify*.
- **Routes** — the road of each day with [Valhalla](https://valhalla1.openstreetmap.de) (vehicle
  height, no tolls except on the motorway days you choose), optionally written back as the day's
  route place; also two route profiles in the planner's route toggle.
- **Schedules** — start and end of every stop from real drive times, and how much earlier to leave
  when the night would be reached too late.
- **Supplies** — supermarkets, fuel and drinking water *along* the day's route, with the hours of
  that day.
- **Budget** — nights, fuel per day from road kilometres, tolls from budget lines, and options
  compared in money.
- **Price and amenities** — for any place: price (per night or per person, currency, dog fee) and
  amenities (dog, water, electricity, shower, toilets, dump station, wifi, rooftop tent accepted,
  maximum height), each *yes*, *no* or *unknown*. Shown as two columns on every place in the
  planner (e.g. `22 €/night` and `✓ dog · water · shower  ✗ power  ↕ 2.1 m`), so titles stay plain
  names; edited in the *Places* tab or with `rooftop_tools_place_info`; used by the check (rooftop
  tent refused, dog refused, height too low, water) and by the budget (per-person prices times the
  number of travellers, dog fee).
- **All-in-one** — `rooftop_tools_plan_trip` chains all of the above and returns an ordered action
  list.

### MCP tools

Advertised as `plugin_rooftop-planner-plugin_<name>` to assistants holding the `plugins:use` scope.

| Tool | Does |
|---|---|
| `rooftop_tools_plan_trip` | All-in-one: check → nights → routes → schedules → budget; resumable with `continuation`. `apply` defaults to `false`. |
| `rooftop_tools_check_trip` | The full check, filtered by level; `sun: true` adds sunrise, sunset and latest arrival per night. Read-only. |
| `rooftop_tools_find_nights` | Night candidates for a trip night or around a point, with the sunset at the evening point. |
| `rooftop_tools_compute_routes` | Day routes; `apply: true` recreates the day's route places. |
| `rooftop_tools_schedule_day` | Times of one day from drive times; returns the core `update_assignment_time` calls. |
| `rooftop_tools_place_info` | Read or record the price and amenities of places (only what a cited source states). |
| `rooftop_tools_supplies_on_route` | Groceries, fuel and water along a day's route. |
| `rooftop_tools_trip_budget` | Budget and option comparison. |

The plugin API cannot reorder a day or set a per-stop time, so the tools return the core TREK calls
to make (`reorder_day_assignments`, `update_assignment_time`, `create_budget_item`) for the
assistant to run. Tool descriptions remind assistants never to book, pay or message a host without
the user's explicit validation. Each call answers within the 15 s host limit (long work is split
with a `continuation` token) and under the 64 KiB result cap.

## Screenshots

`docs/screenshot.png` — the trip tab on a desktop width: one card per night (kind, booking status,
legal zone, arrival versus the latest arrival before sunset, price and amenities, alternatives
folded); the check grouped by level in the second tab; the price and amenities editor in the third.
On a phone the cards stack in one column.

## Permissions

| Permission | Why |
|---|---|
| `db:own` | Caches drive times (30 days) and OpenStreetMap answers (7 days) so the warnings banner never waits on the network and the public servers are asked as little as possible. |
| `db:read:trips` | Reads the trip's days, stops, nights (accommodations), places and bookings to check and plan it. |
| `db:read:categories` | Names the category of each place (campsite, farm, motorhome area, route...). |
| `db:read:costs` | Reads budget lines: tolls, and lines naming nights that are no longer planned. Optional: without it the budget skips tolls. |
| `db:read:todos` | Finds to-dos asking to book a night that is no longer planned. |
| `db:write:places` | Only with `apply: true` in `rooftop_tools_compute_routes` / `rooftop_tools_plan_trip`: recreates a day's route place (a place geometry cannot be edited, so the old one is deleted). |
| `db:write:itinerary` | Only with `apply: true`: puts the new route place on its day. |
| `db:meta` | Stores the price and amenities of a place on the place itself (the plugin's own namespaced data; writes need the user's place edit right). |
| `hook:table-contributor` | Shows the price and amenities columns, and a "Price & amenities" button, on each place in the planner. |
| `mcp:tools` | Publishes the eight `rooftop_tools_*` tools on TREK's MCP server. |
| `hook:trip-warning-provider` | Shows blocking / to-fix / to-verify points in the planner's warnings banner (cache only, no network, at most 20). |
| `hook:route-provider` | Adds the "Rooftop tent (no tolls)" and "Rooftop tent (motorway)" route profiles. |
| `http:outbound:valhalla1.openstreetmap.de` | Drive times and road geometry (public Valhalla server of the OpenStreetMap community). |
| `http:outbound:overpass-api.de` | Campsites, farms, shops, fuel and water from OpenStreetMap (public Overpass API). |

No data is sent anywhere else. Only coordinates go to Valhalla and Overpass — never names, notes
or anything about the travellers.

## Setup

1. Install the plugin (Admin → Plugins) and approve its permissions.
2. Each traveller sets their own values in Settings → Plugins → Rooftop Planner: vehicle height,
   target and ceiling price per night, sunset margin, dog, water reserve, fuel consumption and
   price, number of travellers, motorway days, shopping detour limit, time zone of the trip,
   language (English or French).
3. For assistants: give the MCP client the `plugins:use` scope, then ask it to run
   `rooftop_tools_check_trip` on your trip (it also fills the cache the warnings banner reads).

Conventions the check relies on, all optional: opening hours written in a stop's notes as
`Monday: 8h00–21h00`, a check-in window as `Check-in: 15h–23h`, a minimum stay as
`2 nights minimum`, and for a stop reached on foot the car park as `Start: parking X, 46.5000, 11.7000`.

The "Price & amenities" button on a place opens the plugin's tab; until TREK passes the place to a
plugin frame, pick the place in the *Places* tab (it opens on that place by itself once TREK does).

Limits worth knowing: zone outlines are coarse (check a night near a border by hand); the public
Overpass server allows few queries per server, so night and supply searches may answer "busy, try
again in a minute"; OSM has no reviews.

### Development

```bash
npm install
npm test               # vitest, mock TREK host, no network
npm run coverage
npm run sync-manifest  # copy server/lib/tool-specs.js into trek-plugin.json
node scripts/dev-fixtures.js && npm run dev   # fictional trip on http://localhost:4317
npx trek-plugin-sdk shot                      # docs/screenshot.png (see CONTRIBUTING)
npm run validate && npm run pack
```

Data: © OpenStreetMap contributors (ODbL), routing by Valhalla on the FOSSGIS servers.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).
