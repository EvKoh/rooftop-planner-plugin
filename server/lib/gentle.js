'use strict';
// Every ctx.* call is an RPC the host rate-limits per plugin (burst 60, 20/s sustained,
// 16 in flight) and refuses — retryably — with "rate limit exceeded". A tool reads 14
// settings and a whole trip, so two calls close together can hit the burst (seen on a
// real instance, 2026-10-03). gentle(ctx) retries a refused call with a growing pause
// instead of failing the tool. Other errors pass through untouched.
const RATE = /rate limit exceeded/i;
const DELAYS = [300, 700, 1500, 3000];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, delays = DELAYS) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!RATE.test(String(e && e.message)) || i >= delays.length) throw e;
      await wait(delays[i]);
    }
  }
}

/** A ctx whose namespace methods (ctx.trips.getDays, ctx.meta.set, ...) retry on rate limits. */
function gentle(ctx, delays = DELAYS) {
  if (!ctx || ctx.__gentle) return ctx;
  const cache = new Map();
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === '__gentle') return true;
      const v = target[prop];
      if (!v || typeof v !== 'object' || prop === 'config' || prop === 'log') return v;
      if (!cache.has(prop)) {
        cache.set(prop, new Proxy(v, {
          get(ns, name) {
            const f = ns[name];
            return typeof f === 'function' ? (...args) => retry(() => f.apply(ns, args), delays) : f;
          },
        }));
      }
      return cache.get(prop);
    },
  });
}

module.exports = { gentle, retry, DELAYS };
