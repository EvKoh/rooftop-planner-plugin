'use strict';
// Trip budget the way it is decided: each stay (its cost for the whole party, night-status.js
// nightsMoney: the same count the check compares with the budget lines), fuel per day from the
// day's road kilometres, tolls from the budget lines that name them, and a comparison of
// options in money (night price + fuel of the extra kilometres), and the access tolls and
// tickets recorded on the day's places (toll_amount, per vehicle). Nothing is estimated in
// silence: an unknown price stays unknown and is listed.
const { polylineKm, norm } = require('./util');
const routing = require('./routing');
const { highwayAllowed, fuelPerKm } = require('./settings');
const { waypoints } = require('./traces');
const { dayPlan } = require('./check');
const { nightsMoney } = require('./night-status');
const placeInfo = require('./place-info');
const { t } = require('./i18n');

const r2 = (x) => Math.round(x * 100) / 100;
const TOLL = /peage|toll|pedaggio|\bmaut\b|vignette|autostrada/;
const FUEL = /carburant|fuel|petrol|diesel|essence|benzin|gasolio|sprit/;

async function tripBudget(ctx, model, o, { settings, deadline, network = true }) {
  const perKm = fuelPerKm(settings);
  const L = settings.language;
  const nm = nightsMoney(model);
  const nights = nm.rows;
  const unknown = nm.unknown.map((n) => n.name);

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
    const r = await routing.legs(ctx, pairs, { ...routing.vehicleOpts(settings, tolls), deadline, network });
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

  // Access tolls and tickets recorded on the places of each day (once per place and day); one
  // a budget line already names is not counted twice, one in another currency not summed.
  const accessTolls = [];
  for (const d of model.days) {
    const seen = new Set();
    for (const a of d.assignments) {
      const info = (model.poolById.get(a.place.id) || {}).info;
      if (!info || info.toll_amount == null || seen.has(a.place.id)) continue;
      seen.add(a.place.id);
      const pl = model.poolById.get(a.place.id);
      const currency = placeInfo.tollCurrency(info, placeInfo.currencyOf(pl && pl.raw, model.currency));
      const key = norm(a.place.name);
      const inBudget = !!costs && costs.some((b) => TOLL.test(norm(`${b.name} ${b.category || ''}`)) && key.length >= 3 && norm(b.name).includes(key));
      accessTolls.push({ day: d.n, date: d.date, placeId: a.place.id, name: a.place.name, amount: info.toll_amount, currency, inBudget, counted: !inBudget && currency === model.currency });
    }
  }
  const accessTollTotal = r2(accessTolls.filter((x) => x.counted).reduce((s, x) => s + x.amount, 0));
  const accessTollDays = [...new Set(accessTolls.map((x) => x.day))].map((day) => ({ day, total: r2(accessTolls.filter((x) => x.day === day && x.counted).reduce((s, x) => s + x.amount, 0)) }));
  const otherCurrency = accessTolls.filter((x) => x.currency !== model.currency);

  const nightsTotal = nm.total;
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
      if (!exists) coreCalls.push({ tool: 'create_budget_item', args: { tripId: model.tripId, name: t(L, 'budget.fuel_line', { day: f.day, km: f.km }), category: 'Transport', total_price: f.cost } });
    }
    for (const x of accessTolls.filter((y) => !y.inBudget)) {
      coreCalls.push({ tool: 'create_budget_item', args: { tripId: model.tripId, name: `${t(L, 'budget.toll_line', { day: x.day, name: x.name })}${x.currency !== model.currency ? ` (${x.amount} ${x.currency})` : ''}`, category: 'Transport', total_price: x.amount } });
    }
  }

  return {
    currency: model.currency,
    nights, nightsTotal, unknownNightPrices: unknown,
    fuel, fuelTotal, fuelPerKm: Math.round(perKm * 1000) / 1000,
    tolls, tollTotal, motorwayDays,
    accessTolls, accessTollTotal, accessTollDays,
    total: r2(nightsTotal + fuelTotal + (tollTotal || 0) + accessTollTotal),
    budgetLines: costs ? costs.length : null,
    options,
    coreCalls,
    pendingRoutes: pending,
    note: [
      unknown.length ? `Unknown night prices (not counted): ${unknown.join(', ')}.` : null,
      nm.otherCurrency.length ? `Nights priced in another currency, not in the total: ${nm.otherCurrency.map((x) => `${x.name} ${x.total} ${x.currency}`).join(', ')}.` : null,
      nm.dropped.length ? `Dropped nights, not counted: ${nm.dropped.map((x) => x.name).join(', ')}.` : null,
      tolls && !tolls.length && motorwayDays.length ? `Motorway days ${motorwayDays.join(', ')} have no toll line in the budget: look up the toll for the exact route.` : null,
      otherCurrency.length ? `Access tolls in another currency, not in the total: ${otherCurrency.map((x) => `${x.name} ${x.amount} ${x.currency}`).join(', ')}.` : null,
      costs ? null : 'Budget lines not readable (Costs addon off or permission missing): tolls not counted.',
    ].filter(Boolean).join(' ') || null,
  };
}

module.exports = { tripBudget };
