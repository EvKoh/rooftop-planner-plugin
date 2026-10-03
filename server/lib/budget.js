'use strict';
// Trip budget the way it is decided: each night (price × nights), fuel per day from the
// day's road kilometres, tolls from the budget lines that name them, and a comparison of
// options in money (night price + fuel of the extra kilometres). Nothing is estimated in
// silence: an unknown price stays unknown and is listed.
const { polylineKm, norm } = require('./util');
const routing = require('./routing');
const { highwayAllowed, fuelPerKm } = require('./settings');
const { waypoints } = require('./traces');
const { dayPlan } = require('./check');

const r2 = (x) => Math.round(x * 100) / 100;
const TOLL = /peage|toll|pedaggio|\bmaut\b|vignette|autostrada/;
const FUEL = /carburant|fuel|petrol|diesel|essence|benzin|gasolio|sprit/;

async function tripBudget(ctx, model, o, { settings, deadline, network = true }) {
  const perKm = fuelPerKm(settings);
  const nights = model.nights.map((n) => ({
    name: n.name, nights: n.nights, pricePerNight: n.price, total: n.price == null ? null : r2(n.price * n.nights),
  }));
  const unknown = nights.filter((n) => n.total == null).map((n) => n.name);

  // Kilometres per day: the route place when there is one, else the drive legs.
  const dayKm = [];
  const legDays = [];
  for (const d of model.days) {
    const { trace } = dayPlan(model, d);
    if (trace && trace.place.geometry) dayKm.push({ day: d, km: polylineKm(trace.place.geometry), source: 'route place' });
    else legDays.push(d);
  }
  let pending = 0;
  for (const tolls of [true, false]) {
    const ds = legDays.filter((d) => highwayAllowed(settings, d.index, model.days.length) === tolls);
    const pairs = [];
    const owner = [];
    for (const d of ds) {
      const { pts } = waypoints(model, d);
      for (let i = 1; i < pts.length; i++) { pairs.push([pts[i - 1], pts[i]]); owner.push(d); }
    }
    if (!pairs.length) continue;
    const r = await routing.legs(ctx, pairs, { tolls, height: settings.vehicle_height_m, deadline, network });
    pending += r.pending;
    for (const d of ds) {
      let km = 0;
      let missing = false;
      pairs.forEach((_, i) => { if (owner[i] === d) { const v = r.values.get(i); if (v) km += v.km; else missing = true; } });
      dayKm.push({ day: d, km, source: missing ? 'drive legs (incomplete)' : 'drive legs' });
    }
  }
  dayKm.sort((a, b) => a.day.index - b.day.index);
  const fuel = dayKm.filter((x) => x.km > 0).map((x) => ({ day: x.day.n, date: x.day.date, km: Math.round(x.km), cost: r2(x.km * perKm), source: x.source }));

  const costs = Array.isArray(model.costs) ? model.costs : null;
  const tolls = costs ? costs.filter((b) => TOLL.test(norm(`${b.name} ${b.category || ''}`))).map((b) => ({ name: b.name, amount: +b.total_price || 0 })) : null;
  const motorwayDays = model.days.filter((d) => highwayAllowed(settings, d.index, model.days.length)).map((d) => d.n);

  const nightsTotal = r2(nights.reduce((s, n) => s + (n.total || 0), 0));
  const fuelTotal = r2(fuel.reduce((s, f) => s + f.cost, 0));
  const tollTotal = tolls ? r2(tolls.reduce((s, x) => s + x.amount, 0)) : null;

  const options = (o.options || []).map((x) => {
    const n = x.nights ?? 1;
    const total = r2((x.night_price ?? 0) * n + (x.extra_km ?? 0) * perKm);
    return { label: x.label, nightPrice: x.night_price ?? null, nights: n, extraKm: x.extra_km ?? 0, total };
  });
  if (options.length) options.forEach((x) => { x.vsFirst = r2(x.total - options[0].total); });

  // Budget lines the trip is missing, as core calls the assistant can make (after the
  // user agrees): one fuel line per driving day.
  const coreCalls = [];
  if (costs) {
    for (const f of fuel) {
      const exists = costs.some((b) => FUEL.test(norm(b.name)) && new RegExp(`\\b${f.day}\\b`).test(b.name));
      if (!exists) coreCalls.push({ tool: 'create_budget_item', args: { tripId: model.tripId, name: `Fuel day ${f.day} (${f.km} km)`, category: 'Transport', total_price: f.cost } });
    }
  }

  return {
    currency: model.currency,
    nights, nightsTotal, unknownNightPrices: unknown,
    fuel, fuelTotal, fuelPerKm: Math.round(perKm * 1000) / 1000,
    tolls, tollTotal, motorwayDays,
    total: r2(nightsTotal + fuelTotal + (tollTotal || 0)),
    budgetLines: costs ? costs.length : null,
    options,
    coreCalls,
    pendingRoutes: pending,
    note: [
      unknown.length ? `Unknown night prices (not counted): ${unknown.join(', ')}.` : null,
      tolls && !tolls.length && motorwayDays.length ? `Motorway days ${motorwayDays.join(', ')} have no toll line in the budget: look up the toll for the exact route.` : null,
      costs ? null : 'Budget lines not readable (Costs addon off or permission missing): tolls not counted.',
    ].filter(Boolean).join(' ') || null,
  };
}

module.exports = { tripBudget };
