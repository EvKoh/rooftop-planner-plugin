// vanlife — plans road trips with a rooftop tent, a campervan or a motorhome in TREK.
//
// What it plugs into (TREK's own surfaces only; the plugin has a single screen):
//   • widget, slot "place-detail" → the place's amenities, price details, host contacts and
//                                   night status, at the foot of the place panel (client/index.html)
//   • mcpToolProvider  → 7 MCP tools `vanlife_*` (advertised as plugin_vanlife_vanlife_*)
//   • warningProvider  → the planner's warnings banner (cache-only, 5 s budget)
//   • routeProvider    → two route profiles in the planner's route toggle
//   • tableContributor → night status, price and amenities columns on each place (view "places")
// Settings are TREK's native forms (user: vehicle and rules; instance: defaults).
//
// Every trip read is membership-checked by the host against the acting user; the plugin
// never names a user. Nothing here books, pays or messages anyone: night statuses are what
// the user declares, and messages to hosts are drafts for the user to send.
const { definePlugin } = require('trek-plugin-sdk');
const cache = require('./lib/cache');
const routing = require('./lib/routing');
const { TOOL_NAMES } = require('./lib/tool-specs');
const { callTool } = require('./lib/tools');
const { readSettings } = require('./lib/settings');
const { loadTrip } = require('./lib/trip');
const { warnings } = require('./lib/report');
const placeInfo = require('./lib/place-info');
const amenityFill = require('./lib/amenity-fill');
const { placeColumns } = require('./lib/contributions');
const nightStatus = require('./lib/night-status');
const contacts = require('./lib/contacts');
const { gentle } = require('./lib/gentle');
const { bundle, lang } = require('./lib/i18n');
const { isNightCategory } = require('./lib/classify');

const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ids = (b) => {
  const tripId = Number(b && b.tripId);
  const placeId = Number(b && b.placeId);
  return Number.isInteger(tripId) && tripId > 0 && Number.isInteger(placeId) && placeId > 0 ? { tripId, placeId } : null;
};

/** The place, if it belongs to the trip (the host checks the user may read the trip). */
async function placeOf(ctx, tripId, placeId) {
  const places = await ctx.trips.getPlaces(tripId);
  return places.find((p) => p.id === placeId) || null;
}

module.exports = definePlugin({
  async onLoad(ctx) {
    await cache.migrate(ctx);
    await placeInfo.migrate(ctx);
    await amenityFill.migrate(ctx);
  },

  hooks: {
    mcpToolProvider: {
      tools: TOOL_NAMES,
      callTool: (call, ctx) => callTool(call, gentle(ctx)),
    },

    warningProvider: {
      async getWarnings(tripId, raw) {
        const ctx = gentle(raw);
        const settings = await readSettings(ctx);
        return warnings(ctx, await loadTrip(ctx, tripId, settings), settings);
      },
    },

    tableContributor: {
      async getContributions(view, tripId, raw) {
        if (view !== 'places') return [];
        const ctx = gentle(raw);
        return placeColumns(ctx, tripId, await readSettings(ctx, ['language', 'dog', 'vehicle', 'vehicle_height_m', 'vehicle_length_m', 'vehicle_weight_t']));
      },
    },

    routeProvider: {
      // `vanlife`: no tolls (on-site days); `vanlife-highway`: tolls allowed (getting there
      // and back). The vehicle's height (and length/weight for a motorhome) from the settings.
      async getRoute(request, ctx) {
        const settings = await readSettings(gentle(ctx), ['vehicle', 'vehicle_height_m', 'vehicle_length_m', 'vehicle_weight_t']);
        const r = await routing.route(request.waypoints.map((w) => [w.lat, w.lng]), {
          ...routing.vehicleOpts(settings, request.profile === 'vanlife-highway'), maxPoints: 5000, timeoutMs: 17000,
        });
        return {
          coordinates: r.points,
          distance: Math.round(r.km * 1000),
          duration: r.minutes * 60,
          legs: r.legs.map((l) => ({ distance: Math.round(l.km * 1000), duration: l.minutes * 60 })),
        };
      },
    },
  },

  routes: [
    {
      // The widget: the place's record, its TREK price, and the strings in the frame's language.
      method: 'POST',
      path: '/amenities',
      auth: true,
      async handler(req, raw) {
        const ctx = gentle(raw);
        const at = ids(req.body);
        if (!at) return json(400, { error: 'tripId and placeId required' });
        try {
          const place = await placeOf(ctx, at.tripId, at.placeId);
          if (!place) return json(404, { error: 'place not in this trip' });
          const settings = await readSettings(ctx, ['language', 'vehicle', 'dog', 'vehicle_height_m', 'vehicle_length_m', 'vehicle_weight_t']);
          // The user's own language setting wins; "auto" follows the language TREK gives the frame.
          const own = await ctx.settings.get('language').catch(() => undefined);
          const L = own && own !== 'auto' ? lang(own) : req.body.locale ? lang(req.body.locale) : settings.language;
          const [info, resas, accs, cats] = await Promise.all([
            placeInfo.get(ctx, at.placeId),
            ctx.trips.getReservations(at.tripId).catch(() => []),
            ctx.trips.getAccommodations(at.tripId).catch(() => []),
            ctx.categories.list().catch(() => []),
          ]);
          const status = nightStatus.statusByPlace(resas).get(at.placeId) || null;
          const catName = (cats || []).find((c) => c.id === place.category_id);
          const night = (accs || []).some((a) => a.place_id === at.placeId) || isNightCategory(place.category_name || (catName && catName.name) || '');
          const site = place.website && !contacts.notOwnSite(place.website) ? place.website : null;
          return json(200, {
            language: L,
            strings: bundle(L, ['ui.', 'am', 'opt.', 'per.', 'fee', 'st.', 'ch.']),
            vehicle: settings.vehicle,
            price: place.price == null ? null : +place.price,
            currency: place.currency || null,
            info: info || placeInfo.blank(),
            night,
            // The price as the planner chip shows it (unit, free note, dog fee).
            priceText: placeInfo.priceText(place.price == null ? null : +place.price, place.currency || 'EUR', info, L, { night }),
            units: placeInfo.PER,
            visitText: placeInfo.visitText(info),
            recorded: !!info,
            summary: placeInfo.amenitiesText(info, L),
            refused: placeInfo.refuses(info, settings),
            amenities: placeInfo.AMENITIES,
            channels: contacts.CHANNELS,
            // TREK's own fields, shown when the plugin's record has nothing.
            // A platform page (park4night, Google Maps...) is not the host's site.
            trek: { website: site, phone: place.phone || null },
            nightStatus: status,
          });
        } catch (e) {
          return json(403, { error: String((e && e.message) || e) });
        }
      },
    },
    {
      // Save: the price on TREK's own place, the rest on the place's plugin data.
      method: 'POST',
      path: '/amenities/save',
      auth: true,
      async handler(req, raw) {
        const ctx = gentle(raw);
        const at = ids(req.body);
        if (!at) return json(400, { error: 'tripId and placeId required' });
        try {
          const place = await placeOf(ctx, at.tripId, at.placeId);
          if (!place) return json(404, { error: 'place not in this trip' });
          return json(200, { saved: true, info: await placeInfo.set(ctx, at.tripId, at.placeId, (req.body && req.body.set) || {}, { place }) });
        } catch (e) {
          return json(e instanceof placeInfo.InfoError ? 400 : 403, { error: String((e && e.message) || e) });
        }
      },
    },
    {
      // Fill unknown amenities from OpenStreetMap (and park4night when enabled): one place
      // (placeId) or the next batch of the trip's places; the widget calls it again while
      // `remaining` is above zero.
      method: 'POST',
      path: '/amenities/fill',
      auth: true,
      async handler(req, raw) {
        const ctx = gentle(raw);
        const tripId = Number(req.body && req.body.tripId);
        const placeId = Number(req.body && req.body.placeId);
        if (!Number.isInteger(tripId) || tripId < 1) return json(400, { error: 'tripId required' });
        try {
          const settings = await readSettings(ctx, ['language']);
          const opts = { park4night: settings.park4night, language: settings.language };
          if (Number.isInteger(placeId) && placeId > 0) {
            if (!(await placeOf(ctx, tripId, placeId))) return json(404, { error: 'place not in this trip' });
            opts.placeIds = [placeId];
          }
          return json(200, await amenityFill.fill(ctx, tripId, opts));
        } catch (e) {
          return json(403, { error: String((e && e.message) || e) });
        }
      },
    },
    {
      method: 'POST',
      path: '/amenities/clear',
      auth: true,
      async handler(req, raw) {
        const ctx = gentle(raw);
        const at = ids(req.body);
        if (!at) return json(400, { error: 'tripId and placeId required' });
        try {
          if (!(await placeOf(ctx, at.tripId, at.placeId))) return json(404, { error: 'place not in this trip' });
          await placeInfo.clear(ctx, at.tripId, at.placeId);
          return json(200, { cleared: true });
        } catch (e) {
          return json(403, { error: String((e && e.message) || e) });
        }
      },
    },
  ],
});
