#!/usr/bin/env node
// assets/icons/*.svg (the plugin's own pictograms, 24-unit stroke icons) → server/lib/glyphs.json,
// the shapes the plugin sends on its map markers. TREK accepts path, circle, rect, line and
// polyline with numeric attributes only; anything else fails here, not on the map.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'assets', 'icons');
const ALLOWED = { path: ['d'], circle: ['cx', 'cy', 'r'], rect: ['x', 'y', 'width', 'height', 'rx'], line: ['x1', 'y1', 'x2', 'y2'], polyline: ['points'] };
const out = {};
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.svg')).sort()) {
  const svg = fs.readFileSync(path.join(dir, file), 'utf8');
  if (!/viewBox="0 0 24 24"/.test(svg)) throw new Error(`${file}: viewBox must be 0 0 24 24`);
  const shapes = [];
  for (const m of svg.matchAll(/<(path|circle|rect|line|polyline)\b([^>]*)\/?>/g)) {
    const attrs = {};
    for (const a of m[2].matchAll(/([a-z0-9-]+)="([^"]*)"/g)) {
      if (ALLOWED[m[1]].includes(a[1])) attrs[a[1]] = a[2];
    }
    shapes.push([m[1], attrs]);
  }
  if (!shapes.length || shapes.length > 8) throw new Error(`${file}: 1 to 8 shapes, found ${shapes.length}`);
  out[file.replace(/\.svg$/, '')] = shapes;
}
fs.writeFileSync(path.join(__dirname, '..', 'server', 'lib', 'glyphs.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`built ${Object.keys(out).length} glyphs: ${Object.keys(out).join(', ')}`);
