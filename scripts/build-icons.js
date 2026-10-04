#!/usr/bin/env node
// The lucide pictograms the place widget draws (it has no icon set of its own) →
// server/lib/icons.json, as SVG inner markup. Lucide is ISC-licensed; the names are the
// ones design.js asks for (SHEET_ICONS, NIGHT_STATUS). Run with a lucide-react checkout:
//   LUCIDE_DIR=/path/to/node_modules/lucide-react node scripts/build-icons.js
const fs = require('fs');
const path = require('path');
const design = require('../server/lib/design.js');

const dir = path.join(process.env.LUCIDE_DIR || path.join(__dirname, '..', 'node_modules', 'lucide-react'), 'dist', 'esm', 'icons');
const kebab = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').replace(/([a-zA-Z])(\d)/g, '$1-$2').toLowerCase();
const out = {};
for (const name of [...new Set(design.ICON_NAMES)].sort()) {
  const file = path.join(dir, `${kebab(name)}.js`);
  if (!fs.existsSync(file)) throw new Error(`${name}: no ${file}`);
  const src = fs.readFileSync(file, 'utf8');
  const body = src.slice(src.indexOf('['), src.lastIndexOf(']') + 1);
  const parts = [];
  for (const m of body.matchAll(/\[\s*"(\w+)",\s*\{([^}]*)\}\s*\]/g)) {
    const attrs = [...m[2].matchAll(/(\w+):\s*"([^"]*)"/g)].filter((a) => a[1] !== 'key').map((a) => `${a[1]}="${a[2]}"`).join(' ');
    parts.push(`<${m[1]} ${attrs}/>`);
  }
  if (!parts.length) throw new Error(`${name}: no shapes`);
  out[name] = parts.join('');
}
fs.writeFileSync(path.join(__dirname, '..', 'server', 'lib', 'icons.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`built ${Object.keys(out).length} icons`);
