// Preload for `trek-plugin-sdk shot`: makes Playwright drive an existing Chromium binary
// (TREK_SHOT_CHROMIUM=/path/to/chrome) instead of a browser downloaded by Playwright.
//   TREK_SHOT_CHROMIUM=/path/to/chrome NODE_OPTIONS="--require ./scripts/shot-chromium.cjs" npx trek-plugin-sdk shot
// shot imports 'playwright' and calls chromium.launch() with no options; the module is shared
// with this require, so patching launch here is enough.
const executablePath = process.env.TREK_SHOT_CHROMIUM;
if (executablePath) {
  try {
    const { chromium } = require('playwright');
    const launch = chromium.launch.bind(chromium);
    chromium.launch = (opts = {}) => launch({ ...opts, executablePath });
  } catch { /* playwright not installed: shot explains what to do */ }
}
