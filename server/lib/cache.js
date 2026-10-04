'use strict';
// Key/value cache in the plugin's OWN sqlite (`db:own`), fronted by an in-process Map.
// Why both: every ctx.db call is an RPC, and the host rate-limits RPCs (burst 60, 20/s),
// so keys are read and written in batches; the Map spares even those on a warm process.
// The warning hook (5 s budget) reads ONLY this cache: it never calls the network.

const TTL_MS = {
  route: 30 * 864e5, // drive times barely change
  walk: 30 * 864e5, // footpaths even less
  osm: 7 * 864e5, // shops, campsites, opening hours
};
const memory = new Map();

const MIGRATION = 'CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL)';

function ttlFor(key) {
  return TTL_MS[key.split(':')[0]] ?? TTL_MS.osm;
}

async function migrate(ctx) {
  await ctx.db.migrate('001_cache', MIGRATION);
  // Drop what is stale anyway, so the file does not grow forever.
  await ctx.db.exec('DELETE FROM cache WHERE at < ?', Date.now() - 60 * 864e5);
}

/** Read many keys at once → Map(key → parsed value). Missing or expired keys are absent. */
async function getMany(ctx, keys, now = Date.now()) {
  const out = new Map();
  const missing = [];
  for (const k of new Set(keys)) {
    const hit = memory.get(k);
    if (hit && now - hit.at < ttlFor(k)) out.set(k, hit.v);
    else missing.push(k);
  }
  for (let i = 0; i < missing.length; i += 200) {
    const chunk = missing.slice(i, i + 200);
    let rows = [];
    try {
      rows = await ctx.db.query(`SELECT k, v, at FROM cache WHERE k IN (${chunk.map(() => '?').join(',')})`, ...chunk);
    } catch {
      rows = []; // no db:own, or the table is missing: behave as an empty cache
    }
    for (const r of rows || []) {
      if (now - r.at >= ttlFor(r.k)) continue;
      try {
        const v = JSON.parse(r.v);
        memory.set(r.k, { v, at: r.at });
        out.set(r.k, v);
      } catch { /* a corrupt row is a miss */ }
    }
  }
  return out;
}

/** Write many entries [[key, value], ...] in transactions of at most 100 statements. */
async function setMany(ctx, entries, now = Date.now()) {
  if (!entries.length) return;
  for (const [k, v] of entries) memory.set(k, { v, at: now });
  for (let i = 0; i < entries.length; i += 100) {
    const ops = entries.slice(i, i + 100).map(([k, v]) => ({
      sql: 'INSERT INTO cache (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at',
      args: [k, JSON.stringify(v), now],
    }));
    try { await ctx.db.tx(ops); } catch { /* the memory layer still serves this process */ }
  }
}

function clearMemory() {
  memory.clear();
}

module.exports = { migrate, getMany, setMany, clearMemory, MIGRATION };
