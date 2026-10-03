// rooftop-planner-plugin — plans car + rooftop-tent road trips in TREK.
//
// What it plugs into:
//   • mcpToolProvider  → 8 MCP tools `rooftop_tools_*` (advertised as
//                        plugin_rooftop-planner-plugin_rooftop_tools_*)
//   • warningProvider  → the planner's warnings banner (cache-only, 5 s budget)
//   • routeProvider    → two route profiles in the planner's route toggle
//   • POST /report     → data for the "Rooftop" trip tab (client/index.html)
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

const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

module.exports = definePlugin({
  async onLoad(ctx) {
    await cache.migrate(ctx);
  },

  hooks: {
    mcpToolProvider: {
      tools: TOOL_NAMES,
      callTool: (call, ctx) => callTool(call, ctx),
    },

    warningProvider: {
      async getWarnings(tripId, ctx) {
        const settings = await readSettings(ctx);
        return warnings(ctx, await loadTrip(ctx, tripId), settings);
      },
    },

    routeProvider: {
      // `rooftop`: no tolls (on-site days); `rooftop-highway`: tolls allowed (getting
      // there and back). Both use the vehicle height from the user's settings.
      async getRoute(request, ctx) {
        const settings = await readSettings(ctx);
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
      method: 'POST',
      path: '/report',
      auth: true,
      async handler(req, ctx) {
        const tripId = Number(req.body && req.body.tripId);
        if (!Number.isInteger(tripId) || tripId < 1) return json(400, { error: 'tripId required' });
        try {
          const settings = await readSettings(ctx);
          return json(200, await tripReport(ctx, await loadTrip(ctx, tripId), settings));
        } catch (e) {
          return json(404, { error: String((e && e.message) || e) });
        }
      },
    },
  ],
});
