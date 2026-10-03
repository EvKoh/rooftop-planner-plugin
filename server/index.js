// rooftop-planner-plugin — plans car + rooftop-tent road trips in TREK.
//
// What it plugs into:
//   • mcpToolProvider  → 8 MCP tools `rooftop_tools_*` (advertised as
//                        plugin_rooftop-planner-plugin_rooftop_tools_*)
//   • warningProvider  → the planner's warnings banner (cache-only, 5 s budget)
//   • routeProvider    → two route profiles in the planner's route toggle
//   • tableContributor → price and amenities columns on each place (view "places")
//   • POST /report, /places, /place-info → data and editor of the "Rooftop" trip tab
//
// Every trip read is membership-checked by the host against the acting user; the plugin
// never names a user. Nothing here books, pays or messages anyone.
const { definePlugin } = require('trek-plugin-sdk');
const cache = require('./lib/cache');
const routing = require('./lib/routing');
const { TOOL_NAMES } = require('./lib/tool-specs');
const { callTool } = require('./lib/tools');
const { readSettings } = require('./lib/settings');
const { loadTrip } = require('./lib/trip');
const { warnings, tripReport } = require('./lib/report');
const placeInfo = require('./lib/place-info');
const { placeColumns } = require('./lib/contributions');
const { gentle } = require('./lib/gentle');

const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

module.exports = definePlugin({
  async onLoad(ctx) {
    await cache.migrate(ctx);
    await placeInfo.migrate(ctx);
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
        return placeColumns(ctx, tripId, await readSettings(ctx, ['language', 'dog', 'vehicle_height_m']));
      },
    },

    routeProvider: {
      // `rooftop`: no tolls (on-site days); `rooftop-highway`: tolls allowed (getting
      // there and back). Both use the vehicle height from the user's settings.
      async getRoute(request, ctx) {
        const settings = await readSettings(gentle(ctx), ['vehicle_height_m']);
        const r = await routing.route(request.waypoints.map((w) => [w.lat, w.lng]), {
          tolls: request.profile === 'rooftop-highway', height: settings.vehicle_height_m, maxPoints: 5000, timeoutMs: 17000,
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
      // The editor's list: every place that is not a route, nights first, with its record.
      method: 'POST',
      path: '/places',
      auth: true,
      async handler(req, raw) {
        const ctx = gentle(raw);
        const tripId = Number(req.body && req.body.tripId);
        if (!Number.isInteger(tripId) || tripId < 1) return json(400, { error: 'tripId required' });
        try {
          const settings = await readSettings(ctx);
          const model = await loadTrip(ctx, tripId, settings);
          const planned = new Set(model.nights.map((n) => n.placeId));
          const places = model.pool.filter((p) => !p.geometry).map((p) => ({
            id: p.id, name: p.name, category: p.categoryName, plannedNight: planned.has(p.id), info: p.info,
          })).sort((a, b) => b.plannedNight - a.plannedNight || a.name.localeCompare(b.name));
          return json(200, { language: settings.language, places, amenities: placeInfo.AMENITIES });
        } catch (e) {
          return json(404, { error: String((e && e.message) || e) });
        }
      },
    },
    {
      // Save (or clear) one place's price and amenities.
      method: 'POST',
      path: '/place-info',
      auth: true,
      async handler(req, raw) {
        const ctx = gentle(raw);
        const b = req.body || {};
        const tripId = Number(b.tripId);
        const placeId = Number(b.placeId);
        if (!Number.isInteger(tripId) || !Number.isInteger(placeId) || tripId < 1 || placeId < 1) return json(400, { error: 'tripId and placeId required' });
        try {
          const places = await ctx.trips.getPlaces(tripId);
          if (!places.some((p) => p.id === placeId)) return json(404, { error: 'place not in this trip' });
          if (b.clear) { await placeInfo.clear(ctx, tripId, placeId); return json(200, { cleared: true }); }
          return json(200, { saved: true, info: await placeInfo.set(ctx, tripId, placeId, b.set || {}) });
        } catch (e) {
          return json(e instanceof placeInfo.InfoError ? 400 : 403, { error: String((e && e.message) || e) });
        }
      },
    },
    {
      method: 'POST',
      path: '/report',
      auth: true,
      async handler(req, raw) {
        const ctx = gentle(raw);
        const tripId = Number(req.body && req.body.tripId);
        if (!Number.isInteger(tripId) || tripId < 1) return json(400, { error: 'tripId required' });
        try {
          const settings = await readSettings(ctx);
          return json(200, await tripReport(ctx, await loadTrip(ctx, tripId, settings), settings));
        } catch (e) {
          return json(404, { error: String((e && e.message) || e) });
        }
      },
    },
  ],
});
