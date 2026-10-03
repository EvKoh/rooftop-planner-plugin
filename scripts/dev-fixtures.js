#!/usr/bin/env node
// Writes dev-fixtures.json (read by `trek-plugin-sdk dev`) from the fictional test trip, so
// the dev server and the tests run on the same data. The output is git-ignored.
const fs = require('fs');
const path = require('path');
const { build, CATS } = require('../test/fixtures/trip');

const out = {
  actingUserId: 42,
  users: { 42: { id: 42, username: 'traveller', display_name: 'Traveller' } },
  categories: CATS,
  userSettings: { language: process.argv[2] === 'fr' ? 'fr' : 'en', timezone: 'Europe/Rome' },
  trips: { 1: build() },
};
fs.writeFileSync(path.join(__dirname, '..', 'dev-fixtures.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log('dev-fixtures.json written');
