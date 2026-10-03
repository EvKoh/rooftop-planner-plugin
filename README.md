![Vanlife Planner: a car with an open rooftop tent and a dog at sunset in the Dolomites](./docs/banner.jpg)

# Vanlife Planner

Plans road trips with a **rooftop tent, a campervan or a motorhome** in
[TREK](https://github.com/liketrek/TREK): legal nights, sunset-safe arrivals, routes, schedules,
supplies, the price and amenities of every place, the hosts' contacts and where each night stands
(spotted, in discussion, booked, dropped) — as MCP tools any assistant connected to TREK can call
(ChatGPT, Claude…), as warnings in the planner, as chips on each place (hover card, places list)
and as a small panel at the foot of the place view.

## Screenshots

![At a glance: day route on the map, price and amenity chips on each night, sunset and drive time, camping portals](./docs/overview.jpg)

![screenshot](./docs/screenshot.png)

## What it does

<img src="./docs/vehicles.jpg" alt="A car with a rooftop tent, a campervan and a motorhome parked at sunset" width="420" align="right">

The vehicle is a setting, and the rules follow it. A rooftop tent has to be unfolded in daylight,
and opening it anywhere other than a campsite or a farm that hosts campers is camping. Sleeping
inside a van or a motorhome without setting anything out is parking in Italy (Codice della strada
art. 185), so a motorhome area is fine there, while Tyrol forbids sleeping in a vehicle outside
campsites.

- **Trip check** — day by day, at four levels (blocking / to fix / to verify / info): arrival at
  the night later than *sunset minus a margin* (computed for the exact date and place); a stop
  visited on its closing day or outside the hours quoted in its notes; a check-in window or minimum
  stay not met; a night the vehicle may not use; a farm night where farm camping is illegal (South
  Tyrol); impossible times; a shopping detour over the limit; nights in a row without water; a
  place that refuses the vehicle, the dog, or the vehicle's height, length or weight.
- **Nights** — candidates between the evening's last visit and the next morning's first stop, from
  OpenStreetMap and, if the instance enables it, park4night; ranked by legality, price and real
  detour.
- **Routes** — the road of each day with [Valhalla](https://valhalla1.openstreetmap.de) for the
  vehicle (height; length and weight for a motorhome), no tolls except on the motorway days you
  choose; also two route profiles in the planner's route toggle.
- **Schedules** — start and end of every stop from real drive times.
- **Supplies** — supermarkets, fuel and drinking water along the day's route, with that day's hours.
- **Price and amenities** — per night or per person, dog fee, height/length/weight limits, and the
  amenities park4night and OpenStreetMap know (dog, water, electricity, toilets, shower, dump
  station, wifi, bins, laundry, pool, shop, bakery, restaurant or snack bar, bar, mobile data,
  playground, barbecue, gas bottles, LPG, vehicle wash, open in winter, rooftop tent accepted).
  The price is TREK's own field; the rest is kept on the place by the plugin. Unknown amenities are
  **filled automatically** from OpenStreetMap (the campsite mapped within 150 m) and from
  park4night (the place a park4night link points to), citing the source; a value a person recorded
  is never overwritten.
- **Hosts and nights** — the contact of each host (e-mail, phone, WhatsApp, website, name,
  languages, preferred channel), filled from the place's own notes, OpenStreetMap and park4night;
  a log of what was asked and answered; the status of every night, kept in TREK's own bookings;
  and a ready-to-send information request to a host, in English then French (Italian or German
  on request), built from what is still unknown about the place. The plugin never sends it: the
  assistant shows the exact text and waits for your go.

## MCP tools

Advertised to assistants as `plugin_vanlife_<name>`; the MCP client needs the opt-in
`plugins:use` scope.

| Tool | What it does |
|---|---|
| `vanlife_plan_trip` | All-in-one: check, cheaper legal nights nearby, routes, schedules, budget; proposes by default, writes only when asked. |
| `vanlife_check_trip` | Read-only check of a trip for the user's vehicle, including nights with no contact and hosts who have not answered for over 3 days. |
| `vanlife_find_nights` | Night candidates for one evening (OpenStreetMap, park4night when enabled), with the contacts OpenStreetMap knows. |
| `vanlife_day` | One tool, three actions: `routes` (road route of each day), `schedule` (times of one day from real drive times), `supplies` (groceries, fuel and water along a day's route). |
| `vanlife_place` | Everything about a place: list by filter, read, `set` (amenities, price details, contacts), `log` an exchange, `clear` / `clear_fields`, `fill` from open sources. |
| `vanlife_night` | `list` where each night stands; `set` a night as spotted, contacted, booked or dropped (a TREK booking pending, confirmed or cancelled). |
| `vanlife_host_message` | Drafts the information request to a host (English, then French); sends nothing. |

TREK accepts 8 tools per plugin: the eighth place is left free on purpose.

No tool books, pays or writes to anyone. `vanlife_night` records what you declare, and every tool
that deals with hosts tells the assistant to show you the exact text and wait for your explicit
validation.

## Where it shows in TREK

- **Warnings banner** — blocking and to-verify points, in the user's language.
- **Place chips** — the night's status first (*Booked ✓* green, *In discussion* orange, *Dropped*
  red, on places that have a booking), then the price and one chip per amenity the place has (dog,
  water, electricity first), plus a red chip listing what it lacks when that rules it out: the
  places list, and the map's hover card
  once an admin lets the plugin in (Admin → Default user settings → *Plugin info on places*).
- **Place panel** — a widget at the foot of the place view shows the night's status, the host's
  contact (e-mail, phone and website as links, last exchange) and the amenities; it edits the
  amenities and the contact, and has a *Fill the trip's amenities* button. Opening a place with
  nothing recorded looks it up once.
- **Settings** — TREK's native forms: per user (vehicle, dimensions, dog, target and ceiling price,
  sunset margin, language…) and per instance (park4night on or off, default language).

## Permissions

| Permission | Why |
|---|---|
| `db:read:trips`, `db:read:categories`, `db:read:costs`, `db:read:todos` | Read the trip being checked or planned. |
| `db:write:places`, `db:write:itinerary` | Write a route place or a chosen night, only when an assistant is asked to apply; copy a host's website or phone into the place's empty TREK fields. |
| `db:write:reservations` | Record the status of a night as a TREK booking (pending, confirmed, cancelled), only when you say so. |
| `db:meta` | Keep the price details, amenities, host contacts and exchange log on the place itself (the plugin's own namespaced data; writes need the user's place edit right). |
| `db:own` | Cache of drive times and OpenStreetMap answers; which places were already looked up (ids and dates only). |
| `mcp:tools` | Publish the tools above. |
| `hook:trip-warning-provider` | The warnings banner (cache only, no network). |
| `hook:route-provider` | The two route profiles. |
| `hook:table-contributor` | The night status, price and amenities chips on each place. |
| `http:outbound:valhalla1.openstreetmap.de` | Drive times and road geometry. |
| `http:outbound:overpass-api.de` | Campsites, shops, fuel, water and campsite amenities from OpenStreetMap. |
| `http:outbound:park4night.com` | park4night search and amenities, only if the instance enables it. |

Only coordinates (and, for park4night, the language) leave the server — never names, notes,
contacts or anything about the travellers. Host contacts stay in your TREK instance.

### About park4night

park4night publishes no API: the plugin reads the endpoint its own web map uses, which may change
without notice. Calls are rate-limited (20 per hour, 3 s apart). Search results are not stored;
when amenities are filled, only the yes/no amenities of a place that is already in your trip are
copied onto that place, with its park4night number as the source. An admin can turn park4night
off in the instance settings, and the plugin then uses OpenStreetMap alone.

## Limits worth knowing

Zone outlines are coarse (check a night near a border by hand). The public Overpass server allows
few queries per server, so searches may answer "busy, try again in a minute". OpenStreetMap often
lacks amenities, and has no reviews. Nothing here books, pays or messages anyone.

## Setup

1. Install the plugin from its zip (Admin → Plugins), and grant the permissions it asks for.
2. Optionally, in Admin → Plugins → Instance settings: turn park4night off, choose the default
   language.
3. Each traveller sets the vehicle, its dimensions, the dog, the prices and the sunset margin in
   Settings → Plugins.
4. To use the tools from ChatGPT, Claude or another assistant, connect it to TREK's MCP server
   with the `plugins:use` scope; the tools appear as `plugin_vanlife_vanlife_*`.

## Development

```bash
npm install
npm test               # vitest, mock TREK host, no network
npm run coverage
npm run sync-manifest  # copy server/lib/tool-specs.js into trek-plugin.json
npm run validate && npm run pack
```

Data: © OpenStreetMap contributors (ODbL), routing by Valhalla on the FOSSGIS servers,
park4night data © park4night.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).
