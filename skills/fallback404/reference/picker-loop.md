# The pick loop

Steps run in the order of `design` from `coverage.mjs apply`: `logo` (only when the site has no logo), `mascot`, `motion`, `page`. Each step shows N options (`optionsPerStep` in `plan.json`) and waits for one pick.

## Step folder and manifest

`.fallback404/steps/<kind>-r<round>/manifest.json`, with asset paths relative to the manifest. Assets stay inside `.fallback404/` and are the PNG or SVG their extension says: `picker.mjs` refuses anything else, links included.

```json
{
  "kind": "mascot",
  "title": "Pick a mascot",
  "prompt": "It stars in every 404 and loader. Pick only a character that is original to you.",
  "options": [
    {
      "title": "Marker",
      "description": "The guest's map pin, walking to a step that isn't there.",
      "assets": { "light": "1-light.svg", "dark": "1-dark.svg" }
    }
  ]
}
```

- Titles at most 60 characters, descriptions 240, the prompt 280. Every option uses the same asset set (light and dark).
- Limits: SVG 200 KB (bake checks it), PNG 1.5 MB, 2–4 options per step, 12 steps and 25 MB per session.

## logo

N marks built from the site's name and simple shapes: monogram, wordmark, symbol with name. Roles only. Prompt: "Pick only a mark that is original to you; it must not resemble an existing logo."

## mascot: the concept step

1. In two or three sentences, describe what a visitor is doing on this site when they reach a 404, an error and a loading screen, in the site's own words (README, home page text, routes).
2. Find N different metaphors for "what you wanted is not here" in that world. Example: on a site where guests follow steps from a shared link, the step that isn't there.
3. Draw each from a house-style template (`house-style/index.json`): keep its parts and `data-part` names, change shapes, props and scene to tell the metaphor. A motif suits formal brands (finance, legal, enterprise).
4. Option title: the concept in 2–4 words. Description: the metaphor in one sentence.
5. Bake each one: `node ${CLAUDE_SKILL_DIR}/scripts/bake.mjs <dir>/<k>.svg --kit .fallback404/brand-kit.json --out <dir> --name <k>`.

### UI motifs

When phase 1 found distinctive presentational components, at least one of the N options is a UI motif: a scene composed from them (a game row playing 4 0 4, an empty product card, an empty chart).

1. Write `<componentsDir>/illustrations/variants/Motif.v<k>.tsx`, exporting `Motif({ className })`. Import the user's components with fixed props; never edit them. Only presentational components: no data fetching, no auth or session hooks, nothing server-only.
2. Wrap it in `<div aria-hidden="true" data-f404-motif className={className}>`; give the parts motion moves a `data-part` wrapper.
3. `node ${CLAUDE_SKILL_DIR}/scripts/write.mjs preview`, then shoot `/fallback404-preview?state=motif&variant=<k>&solo=1` in light and dark (the dev server runs since phase 2). Drop a motif whose shot has `pageErrors`; with fewer than 2 options left, draw SVG concepts instead.
4. Manifest assets: `{ "light": "motif-v<k>-light.png", "dark": "motif-v<k>-dark.png" }`, next to the baked SVG options.
5. After the pick: the winner becomes `<componentsDir>/illustrations/Motif.tsx`, used where the mascot would be; delete the variants. `global-error` never uses it (it replaces the root layout): give it text and a static mark.

## motion

The picked mascot with N presets from `house-style/index.json`: `bake.mjs … --motion <preset>`. If the site's tone asks for something else, write a preset of the same shape (`.f404-anim-<id>`, keyframes, reduced-motion rule) and embed it in the SVG yourself, then check it by baking without `--motion`. When the mascot step picked a UI motif, skip this step: the picker can only show still frames of a motif, so N motion options would look the same. Use the component's own animation if it has one, else the `pulse` preset (`draw-on` is SVG-only), both with the reduced-motion rule; tell the user which, and run `picker.mjs plan --kinds` again without `motion`.

## page: the 404 page

1. The dev server runs since phase 2 (`devserver.mjs start` reuses it). If it is down and will not start (`dev_failed`, `dev_timeout`), the page step cannot show previews: tell the user what the log lines say (often a variable missing from `.env.local`) and ask whether to fix it and retry, or stop here and resume later; the picks so far are kept.
2. Write the picked mascot as `<componentsDir>/illustrations/Mascot.tsx`, the picked motion into `<componentsDir>/fallback404.css`, the texts into `copy.ts`, and N variants as `<componentsDir>/states/variants/NotFound.v<k>.tsx`, each exporting `NotFound`. Variants differ in scene, copy and layout; all follow `house-style/layouts/not-found.md` and `output-rules.md`. Every variant renders `<NotFoundText text={copy.notFound} sections={copy.notFound.sections} />` for its heading and body.
3. `node ${CLAUDE_SKILL_DIR}/scripts/write.mjs preview`, then `node ${CLAUDE_SKILL_DIR}/scripts/check.mjs` and fix what it reports.
4. A shoot plan with one shot per variant, `{ "path": "/fallback404-preview?state=not-found&variant=<k>&solo=1", "name": "not-found-v<k>" }`, `"out": ".fallback404/steps/page-r<round>"` and the brand kit's `darkMode`; run shoot.mjs with the command from SKILL.md phase 7.
5. Look at the PNGs and fix anything broken before proposing.
6. Manifest assets: `{ "light": "not-found-v<k>-light.png", "dark": "not-found-v<k>-dark.png" }`.
7. After the pick: the winner becomes `<componentsDir>/states/NotFound.tsx`; delete `states/variants/`, drop unused texts from `copy.ts`, run `write.mjs preview` again.

## Waiting

- `node ${CLAUDE_SKILL_DIR}/scripts/picker.mjs wait --step <id>` with a Bash timeout of 600000 ms. It prints `{"status":"picked","position":n,"note":…}` or `{"status":"rejected","note":…}`. Exit code 3 means no decision yet: run it again.
- After six runs (about 54 minutes), ask: keep waiting, or stop and resume later (`state.json` and the session survive; links last 7 days).
- `rejected`: the note says what to change. Make round + 1 in a new folder and keep what the user liked.
- A note on a pick ("love it, but warmer colors") applies to the next steps too.

## Errors

- 415 from propose: the message names the SVG rule. Fix the source, bake again, propose again.
- 409 (step cap) or 410 (expired): `picker.mjs create` again with the remaining plan; the picks stay in `state.json`.

## Shoot plan for phase 7

```json
{
  "baseUrl": "<url from devserver.mjs>",
  "basePath": "<config.basePath from scan.json>",
  "darkMode": { "strategy": "class", "value": "dark" },
  "checks": [
    { "path": "/fallback404-check-x7k2", "expectStatus": 404, "expectText": "<copy.notFound.title>" },
    { "path": "/products/fallback404-x7k2", "expectStatus": 404, "expectText": "<copy.notFound.title>" },
    { "path": "/fallback404-preview", "expectStatus": 200 }
  ],
  "shots": [
    { "path": "/fallback404-preview?state=not-found&solo=1", "name": "not-found" },
    { "path": "/fallback404-preview?state=error&solo=1", "name": "error" },
    { "path": "/fallback404-preview?state=global-error&solo=1", "name": "global-error" },
    { "path": "/fallback404-preview?state=loading&solo=1", "name": "loading" },
    { "path": "/fallback404-preview?state=loading-inline&solo=1", "name": "loading-inline" }
  ]
}
```

Add one check per proxy-fixed route, with a made-up id. When `copy.notFound.sections` has the route, `expectText` is that section's `title`. Take `darkMode` from `brand-kit.json`.
