#!/usr/bin/env node
// Copies the MCP tool declarations from server/lib/tool-specs.js (the single source) into
// trek-plugin.json capabilities.mcpTools. `npm test` fails when the two disagree.
const fs = require('fs');
const path = require('path');
const { TOOL_SPECS } = require('../server/lib/tool-specs');

const file = path.join(__dirname, '..', 'trek-plugin.json');
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.capabilities.mcpTools = TOOL_SPECS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`synced ${TOOL_SPECS.length} tools into trek-plugin.json`);
