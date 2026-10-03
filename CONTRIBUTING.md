# Contributing

Thanks for helping. Keep changes small and focused, one topic per pull request.

## Ground rules

- **No personal data, anywhere** — code, tests, fixtures, screenshots, commits. Fixtures are a
  fictional trip on public places ("... Example" for anything invented).
- **No invented data.** A price, an opening hour or a legal rule comes from a cited source; when a
  value is unknown the tools say "to verify", they never guess.
- **The tools never book, pay or message anyone.** Keep that sentence in every tool that could lead
  to it.
- Public servers are shared: keep Valhalla and Overpass requests batched, cached and few.

## Workflow

```bash
npm install
npm test                 # vitest + the SDK mock host; no network
npm run coverage         # stays >= 80 % (lines, statements, functions)
npm run sync-manifest    # after editing server/lib/tool-specs.js
npm run validate         # the TREK-Plugins registry gates, offline
npm run pack
```

- A new rule comes with a test that proves it **detects** the problem (and stays quiet on the fixed
  case) — a check that finds nothing must first have found something.
- User-facing messages live in `server/lib/i18n.js`, in every language.
- Tool schemas use only the JSON Schema keywords the TREK host enforces (see `test/plugin.test.mjs`).
- Screenshot: `node scripts/dev-fixtures.js`, then `npx trek-plugin-sdk shot`. To drive an existing
  Chromium instead of a Playwright-downloaded browser:
  `TREK_SHOT_CHROMIUM=/path/to/chrome NODE_OPTIONS="--require ./scripts/shot-chromium.cjs" npx trek-plugin-sdk shot`.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, ...).

## Releases

`version` in `trek-plugin.json` equals the git tag (`0.1.0` → `v0.1.0`). Releases are cut with
`npx trek-plugin-sdk publish` by the maintainer.
