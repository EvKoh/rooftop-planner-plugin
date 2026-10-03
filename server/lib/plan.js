'use strict';
// rooftop_tools_plan_trip: the whole method in one tool, in this order —
// check → challenge the nights → routes → schedules → budget — then one action list.
// A tool call must answer within 15 s (host limit) and the night search hits the network
// for every night, so work is cut into steps; when the time budget runs out the result
// carries a `continuation` token ("<step>.<index>") and the assistant calls again.
const { checkTrip } = require('./check');
const { findNightsForDay } = require('./nights');
const { computeRoutes } = require('./traces');
const { scheduleDay } = require('./schedule');
const { tripBudget } = require('./budget');
const { SAFETY } = require('./tool-specs');

const STEPS = ['check', 'nights', 'routes', 'schedule', 'budget'];

function parseToken(tok) {
  const m = String(tok || '').match(/^(check|nights|routes|schedule|budget)\.(\d{1,3})$/);
  return m ? { step: STEPS.indexOf(m[1]), index: +m[2] } : { step: 0, index: 0 };
}

/** Plan for a trip that does not exist yet: the core calls to create it, then come back. */
function planRequest(req) {
  const wishes = (req.wishes || []).map((w, i) => `${i + 1}. ${w}`);
  return {
    mode: 'request',
    steps: [
      { tool: 'create_trip', args: { title: req.destination ? `${req.destination}` : 'Road trip', start_date: req.start_date, end_date: req.end_date }, why: 'days are generated from the dates' },
      { tool: 'search_place / create_and_assign_place', why: 'one sourced place per wish (closing days, hours, season, booking, parking, dog rules, time on site), grouped by area so no valley is crossed twice', wishes },
      { tool: 'create_place + create_accommodation', why: 'one campsite or farm per night (never a motorhome area); use rooftop_tools_find_nights for candidates, then set booking status back to pending' },
      { tool: 'plugin_vanlife_vanlife_plan_trip', args: { tripId: '<new trip id>' }, why: 'check, routes, schedules and budget' },
    ],
    reminder: SAFETY,
  };
}

async function planTrip(ctx, model, o, opts) {
  const { deadline } = opts;
  let { step, index } = parseToken(o.continuation);
  const out = { tripId: model.tripId, done: [], results: {}, actions: [], coreCalls: [] };
  const stop = (s, i) => { out.continuation = `${STEPS[s]}.${i}`; };

  while (step < STEPS.length) {
    if (deadline.left() < 5000) { stop(step, index); break; }
    const name = STEPS[step];
    if (name === 'check') {
      const r = await checkTrip(ctx, model, { ...opts, network: true });
      out.results.check = { ok: r.ok, counts: r.counts, findings: r.findings.filter((f) => f.level !== 'info').slice(0, 60) };
      for (const f of r.findings.filter((x) => x.level === 'blocking')) out.actions.push({ priority: 1, action: f.message });
    } else if (name === 'nights') {
      out.results.nights = out.results.nights || [];
      const nightDays = model.days.filter((d) => model.nights.some((n) => n.startDayId === d.id));
      for (; index < nightDays.length; index++) {
        if (deadline.left() < 6000) break;
        const d = nightDays[index];
        try {
          const r = await findNightsForDay(ctx, model, { dayId: d.id }, opts);
          if (r.osmError) {
            // The public OSM server is rate-limited: the other nights would fail the same
            // way. Move on; the assistant can call find_nights per night later.
            out.results.nightsSkipped = `${r.osmError} — nights ${d.n} and later not challenged; call rooftop_tools_find_nights for each later`;
            index = nightDays.length;
            break;
          }
          const best = r.candidates.filter((c) => !c.blocked.length).slice(0, 3);
          out.results.nights.push({ day: d.n, current: r.currentNight, best });
          const cheaper = best.find((c) => c.price != null && r.currentNight && r.currentNight.price != null && c.price < r.currentNight.price && (c.detourMinutes ?? 99) <= 30 && !c.legalRisk);
          if (cheaper) out.actions.push({ priority: 2, action: `Day ${d.n}: "${cheaper.name}" (${cheaper.price}, ${cheaper.detourMinutes} min detour) could replace "${r.currentNight.name}" (${r.currentNight.price}): verify ${cheaper.toVerify.join(', ')}, then ask the user` });
        } catch (e) {
          out.results.nights.push({ day: d.n, error: String(e.message || e) });
        }
      }
      if (index < nightDays.length) { stop(step, index); break; }
    } else if (name === 'routes') {
      const r = await computeRoutes(ctx, model, { apply: !!o.apply, startAt: index }, opts);
      out.results.routes = { applied: r.applied, totalKm: r.totalKm, days: r.days, writes: r.writes };
      out.coreCalls.push(...r.coreCalls);
      if (r.continuation) { stop(step, r.continuation.startAt); break; }
    } else if (name === 'schedule') {
      out.results.schedule = out.results.schedule || [];
      for (; index < model.days.length; index++) {
        if (deadline.left() < 5000) break;
        const d = model.days[index];
        try {
          const r = await scheduleDay(ctx, model, { dayId: d.id }, opts);
          out.results.schedule.push({ day: d.n, departure: r.departure, night: r.night, conflicts: r.conflicts });
          if (r.night && r.night.ok === false) out.actions.push({ priority: 1, action: `Day ${d.n}: arrival ${r.night.arrival} at "${r.night.name}" is ${r.night.lateByMinutes} min too late (latest ${r.night.latestArrival}) — ${r.night.fixes[0]}` });
          for (const c of r.conflicts) out.actions.push({ priority: 1, action: `Day ${d.n}: "${c.name}" ${c.reason}` });
          out.coreCalls.push(...r.coreCalls);
        } catch (e) {
          out.results.schedule.push({ day: d.n, error: String(e.message || e) });
        }
      }
      if (index < model.days.length) { stop(step, index); break; }
    } else if (name === 'budget') {
      const r = await tripBudget(ctx, model, {}, opts);
      out.results.budget = { total: r.total, nightsTotal: r.nightsTotal, fuelTotal: r.fuelTotal, tollTotal: r.tollTotal, unknownNightPrices: r.unknownNightPrices, note: r.note };
      out.coreCalls.push(...r.coreCalls);
    }
    out.done.push(STEPS[step]);
    step++;
    index = 0;
  }
  if (!out.continuation) out.continuation = null;
  out.actions.sort((a, b) => a.priority - b.priority);
  out.reminder = `${SAFETY} Re-run rooftop_tools_check_trip after each change; a change is finished when it reports no blocking point.`;
  return out;
}

module.exports = { planTrip, planRequest, parseToken, STEPS };
