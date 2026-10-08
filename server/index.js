// vanlife — plans road trips with a rooftop tent, a campervan or a motorhome in TREK.
//
// What it plugs into (TREK's own surfaces only; the plugin has a single screen):
//   • widget, slot "place-detail" → the place's amenities, price details, host contacts and
//                                   night status (set from there too), at the foot of the place
//                                   panel and in its edit form (client/index.html)
//   • mcpToolProvider  → 7 MCP tools `vanlife_*` (advertised as plugin_vanlife_vanlife_*)
//   • warningProvider  → the planner's warnings banner (cache-only, 5 s budget)
//   • routeProvider    → two route profiles in the planner's route toggle
// The plugin draws no marker: TREK's own place markers carry the state colour and the
// pictogram (the category's icon), and a second marker on top would steal their clicks.
//   • mapLayerProvider → the dotted walking route of each hike, from its car park
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
const { readSettings, rememberUiLanguage } = require('./lib/settings');
const { loadTrip, isNightOf } = require('./lib/trip');
const { warnings } = require('./lib/report');
const placeInfo = require('./lib/place-info');
const amenityFill = require('./lib/amenity-fill');
const { placeColumns } = require('./lib/contributions');
const nightStatus = require('./lib/night-status');
const contacts = require('./lib/contacts');
const { gentle } = require('./lib/gentle');
const { bundle, lang, locale, t } = require('./lib/i18n');
const { NIGHT_STATES } = require('./lib/design');
const placeSheet = require('./lib/place-sheet');
const visit = require('./lib/visit');
const walks = require('./lib/walks');

const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// The panel shows `error` to the person: in their language. A validation message names its
// field first ("visit_max_minutes must…", "phone \"06\" is not…"): the field's label says
// which one; any other failure reads as a plain "it did not work".
const FIELD_LABEL = {
  price_amount: 'ui.price', currency: 'ui.currency', per: 'ui.per', dog_fee: 'ui.dogFee', price_note: 'ui.priceNote',
  visit_min_minutes: 'ui.visitMin', visit_max_minutes: 'ui.visitMax', access_before: 'ui.accessBefore', access_after: 'ui.accessAfter',
  booking_url: 'ui.bookingUrl', booking_note: 'ui.bookingNote', toll_amount: 'ui.tollAmount', toll_currency: 'ui.tollCurrency',
  max_height_m: 'ui.maxHeight', max_length_m: 'ui.maxLength', max_weight_t: 'ui.maxWeight', source: 'ui.source', checked: 'ui.checked',
  email: 'ui.email', phone: 'ui.phone', whatsapp: 'ui.whatsapp', website: 'ui.website', contact_name: 'ui.contactName',
  languages: 'ui.languages', preferred_channel: 'ui.preferredChannel', notes: 'ui.contactNotes',
};
function userError(e, L) {
  const msg = String((e && e.message) || e);
  const m = msg.match(/^(?:contacts\.)?([a-z_]+)\b/);
  const label = m && FIELD_LABEL[m[1]];
  return label ? t(L, 'ui.invalidField', { field: t(L, label) }) : t(L, 'ui.failed');
}
const notInTrip = (L) => json(404, { error: t(L, 'ui.notInTrip') });
const langOf = (req) => lang(req && req.body && req.body.locale);
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

const { deadline: makeDeadline } = require('./lib/util');

// Hooks answer within 5 s: the map layer computes missing walking routes only inside this.
const LAYER_BUDGET_MS = 4200;

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
        const settings = await readSettings(ctx, null, { tripId });
        return warnings(ctx, await loadTrip(ctx, tripId, settings), settings);
      },
    },

    mapLayerProvider: {
      // The walking route of each hike, DOTTED, from its car park (walks.js). Cached routes
      // first; the missing ones are asked to Valhalla only while the hook's budget allows.
      async getLayers(tripId, raw) {
        const dl = makeDeadline(LAYER_BUDGET_MS);
        const ctx = gentle(raw);
        const settings = await readSettings(ctx, null, { tripId });
        if (!settings.map_walks) return [];
        const list = walks.hikeWalks(await loadTrip(ctx, tripId, settings));
        return walks.walkLayers(list, await walks.walkGeometry(ctx, list, { network: true, deadline: dl }), settings);
      },
    },

    tableContributor: {
      async getContributions(view, tripId, raw) {
        if (view !== 'places') return [];
        const ctx = gentle(raw);
        return placeColumns(ctx, tripId, await readSettings(ctx, ['language', 'dog', 'vehicle', 'vehicle_height_m', 'vehicle_length_m', 'vehicle_weight_t'], { tripId }));
      },
    },

    routeProvider: {
      // `vanlife`: no tolls (on-site days); `vanlife-highway`: tolls allowed (getting there
      // and back). The vehicle's height (and length/weight for a motorhome) from the settings.
      async getRoute(request, ctx) {
        const settings = await readSettings(gentle(ctx), ['vehicle', 'vehicle_height_m', 'vehicle_length_m', 'vehicle_weight_t', 'drive_time_factor']);
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
          if (!place) return notInTrip(langOf(req));
          const settings = await readSettings(ctx, ['language', 'vehicle', 'dog', 'vehicle_height_m', 'vehicle_length_m', 'vehicle_weight_t']);
          // The user's own language setting wins; "auto" follows the language TREK gives the frame.
          const own = await ctx.settings.get('language').catch(() => undefined);
          const L = own && own !== 'auto' ? lang(own) : req.body.locale ? lang(req.body.locale) : settings.language;
          // Under "auto", remember the frame's language on the trip for the banner, the
          // columns, the map and the tools (settings.js).
          if ((!own || own === 'auto') && req.body.locale) await rememberUiLanguage(ctx, at.tripId, req.body.locale);
          const [info, resas, accs, cats, trip] = await Promise.all([
            placeInfo.get(ctx, at.placeId),
            ctx.trips.getReservations(at.tripId).catch(() => []),
            ctx.trips.getAccommodations(at.tripId).catch(() => []),
            ctx.categories.list().catch(() => []),
            ctx.trips.getById(at.tripId).catch(() => null),
          ]);
          // The place's currency, else the trip's (place-info.js currencyOf): the same everywhere.
          const currency = placeInfo.currencyOf(place, trip && trip.currency);
          const status = nightStatus.statusByPlace(resas).get(at.placeId) || null;
          const catName = (cats || []).find((c) => c.id === place.category_id);
          const night = isNightOf(new Set((accs || []).map((a) => a.place_id)), at.placeId, place.category_name || (catName && catName.name), place.route_geometry);
          // The structured card: description and notes read into the fixed sections of its kind.
          const categoryName = place.category_name || (catName && catName.name) || '';
          const sheet = placeSheet.view(placeSheet.sheetOf({ ...place, categoryName, raw: place }, { night }), L, {
            trackUrl: walks.hikeUrl({ raw: place, description: place.description, notes: place.notes }, info),
            visitMinutes: visit.recordedMinutes(info),
          });
          return json(200, {
            language: L,
            strings: bundle(L, ['ui.', 'am', 'opt.', 'per.', 'fee', 'st.', 'ch.', 'chip.']),
            vehicle: settings.vehicle,
            price: place.price == null ? null : +place.price,
            currency,
            // The place's own currency, null when it has none (the trip's applies): the panel
            // writes a currency only when the user sets one.
            placeCurrency: place.currency || null,
            // The language's locale, for the dates the widget formats itself.
            locale: locale(L),
            info: placeInfo.localized(info, L) || placeInfo.blank(),
            night,
            // The price as the planner chip shows it (unit, free note, dog fee).
            priceText: placeInfo.priceText(place.price == null ? null : +place.price, currency, info, L, { night }),
            units: placeInfo.PER,
            visitText: placeInfo.visitText(info, L),
            // A car park's hours, payment, motorhomes and overnight rules, notes.
            parkingText: placeInfo.parkingText(info, L),
            // Timed access, booking, toll: the planner's chips, as text.
            access: placeInfo.accessChips(info, L, currency).map((c) => ({ key: c.key, value: c.value, tone: c.tone })),
            recorded: !!info,
            summary: placeInfo.amenitiesText(info, L),
            refused: placeInfo.refuses(info, settings),
            // What the record refuses, in words ("✗ dog"), for the panel's red chip; what only
            // the notes say no to, for an amber one (a point to verify, as in the check).
            refusedText: placeInfo.refusalText(info, settings, L),
            notesRefusedText: placeInfo.notesRefusalText(info, settings, L, placeSheet.factsOf({ ...place, categoryName }, { stayNotes: (accs || []).filter((a) => a.place_id === at.placeId).map((a) => a.notes || '').join('\n') })),
            amenities: placeInfo.AMENITIES,
            channels: contacts.CHANNELS,
            // The host's ways in: the record, then TREK's own fields (contacts.js reachOf; a
            // platform page is never the host's site).
            reach: contacts.reachOf(info, place),
            // Strongest status over the place's evenings; the panel shows the selected
            // evening's own status once /night has answered.
            nightStatus: status,
            states: NIGHT_STATES,
            sheet,
          });
        } catch (e) {
          return json(403, { error: userError(e, langOf(req)) });
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
          if (!place) return notInTrip(langOf(req));
          // The same shorthands as the MCP tool (walk, parking), so both write the same record.
          const patch = placeInfo.expandParking(placeInfo.expandWalk({ ...((req.body && req.body.set) || {}) }));
          return json(200, { saved: true, info: await placeInfo.set(ctx, at.tripId, at.placeId, patch, { place }) });
        } catch (e) {
          return json(e instanceof placeInfo.InfoError ? 400 : 403, { error: userError(e, langOf(req)) });
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
          const settings = await readSettings(ctx, ['language'], { tripId });
          const opts = { park4night: settings.park4night };
          if (Number.isInteger(placeId) && placeId > 0) {
            if (!(await placeOf(ctx, tripId, placeId))) return notInTrip(langOf(req));
            opts.placeIds = [placeId];
            // One place, from the place view: answer well inside TREK's 8 s call limit.
            opts.budgetMs = 5000;
          }
          return json(200, await amenityFill.fill(ctx, tripId, opts));
        } catch (e) {
          return json(403, { error: userError(e, langOf(req)) });
        }
      },
    },
    {
      // The place panel's night controls: the evenings the place can be set for, its
      // booking on each, the four states with their colour and icon (design.js).
      method: 'POST',
      path: '/night',
      auth: true,
      async handler(req, raw) {
        const ctx = gentle(raw);
        const at = ids(req.body);
        if (!at) return json(400, { error: 'tripId and placeId required' });
        try {
          if (!(await placeOf(ctx, at.tripId, at.placeId))) return notInTrip(langOf(req));
          const model = await loadTrip(ctx, at.tripId, null);
          return json(200, { states: NIGHT_STATES, ...nightStatus.placeNights(model, at.placeId) });
        } catch (e) {
          return json(403, { error: userError(e, langOf(req)) });
        }
      },
    },
    {
      // Set a night's state as the user declares it in TREK: available (the booking is
      // deleted, the stay stays planned), in discussion, booked, cancelled.
      method: 'POST',
      path: '/night/set',
      auth: true,
      async handler(req, raw) {
        const ctx = gentle(raw);
        const at = ids(req.body);
        const b = req.body || {};
        const dayId = Number(b.dayId);
        if (!at || !Number.isInteger(dayId) || dayId < 1) return json(400, { error: 'tripId, placeId and dayId required' });
        if (!nightStatus.STATUSES.includes(b.status)) return json(400, { error: `status must be one of ${nightStatus.STATUSES.join(', ')}` });
        try {
          if (!(await placeOf(ctx, at.tripId, at.placeId))) return notInTrip(langOf(req));
          const model = await loadTrip(ctx, at.tripId, null);
          const { language } = await readSettings(ctx, ['language'], { tripId: at.tripId });
          const text = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);
          const result = await nightStatus.set(ctx, model, {
            placeId: at.placeId, dayId, status: b.status, clear: true, language,
            confirmation: b.status === 'booked' ? text(b.confirmation, 100) : undefined,
            reason: b.status === 'dropped' ? text(b.reason, 200) : undefined,
          });
          const fresh = await loadTrip(ctx, at.tripId, null);
          return json(200, { result, ...nightStatus.placeNights(fresh, at.placeId), dayId });
        } catch (e) {
          return json(e instanceof nightStatus.NightError ? 400 : 403, { error: userError(e, langOf(req)) });
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
          if (!(await placeOf(ctx, at.tripId, at.placeId))) return notInTrip(langOf(req));
          await placeInfo.clear(ctx, at.tripId, at.placeId);
          return json(200, { cleared: true });
        } catch (e) {
          return json(403, { error: userError(e, langOf(req)) });
        }
      },
    },
  ],
});
