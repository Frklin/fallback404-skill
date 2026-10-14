# Design steps

Each flow in `plan.json` is one step on the picker: two new options, plus the site's current page when there is one. Designer agents build them (`reference/agents.md`); you propose them one at a time, in plan order.

## Flow folder

```
<componentsDir>/flows/<slug>/
  variants/<Component>.v1.tsx   option 1 (NotFound, Loader, ErrorState or GlobalErrorState)
  variants/copy.v1.ts           its visible text
  variants/<Component>.v2.tsx   option 2
  variants/copy.v2.ts
  flow.css                      optional: this flow's .f404- classes
```

- A variant imports its text from `./copy.v<k>`, shared CSS from `../../../fallback404.css`, `flow.css` from `../flow.css`, and the site's components through the project's alias.
- Exports: `NotFound()`, `Loader({ inline })`, `ErrorState({ error, retry })` with `'use client'`, `GlobalErrorState({ error, retry })` with `'use client'`.
- Fallback404 rules apply (`reference/output-rules.md`): text from copy, `data-f404-art` scenes `aria-hidden`, tokens only, `role="status"` on loaders.

## Screenshots

`node ${CLAUDE_SKILL_DIR}/scripts/write.mjs preview` rebuilds the dev-only gallery from every flow folder (it waits for other designers through a lock) and prints its `entries`. Each flow gets its own page, `/fallback404-preview/<slug>`, so another designer's draft that does not compile never breaks your shots. Then write a shoot plan at `.fallback404/steps/<kind>-r<round>/shoot-plan.json` with `"out": ".fallback404/steps/<kind>-r<round>"` and the brand kit's `darkMode`, and run shoot.mjs with the command from SKILL.md phase 8:

| What | Shot path | Name |
| --- | --- | --- |
| option k | `/fallback404-preview/<slug>?variant=<k>&solo=1` | `v<k>` |
| inline loader option k | `/fallback404-preview/<slug>?variant=<k>&inline=1&solo=1` | `v<k>-inline` (look at it; not proposed) |
| current page, `status` exists | `/fallback404-preview/<slug>?variant=current&solo=1` | `current` |
| current page, `status` soft | the made-up URL from coverage (`madeUpPath` of the route; see `.fallback404/coverage/rows.json` token) | `current` |

- `global-error` and `weak` flows have no current page.
- A soft row's current page counts only when its screenshot shows a not-found message; a blank, crashed or full page gets no current card.
- Drop any shot with `pageErrors` (a component that needs a provider the root layout lacks, for example) and fix or replace that option.

## Manifest

`.fallback404/steps/<kind>-r<round>/manifest.json`, asset paths relative to it:

```json
{
  "kind": "flow-f2",
  "title": "404 page · /match/[matchId]",
  "prompt": "Visitors followed a match link; the match ended or the code is wrong.",
  "options": [
    { "title": "As it is today", "description": "What visitors see now, moved to a real 404.", "current": true, "assets": { "light": "current-light.png", "dark": "current-dark.png" } },
    { "title": "Empty board", "description": "The match board with no moves, and a button back to the lobby.", "assets": { "light": "v1-light.png", "dark": "v1-dark.png" } },
    { "title": "Lobby card", "description": "A card in the lobby's style with the three key links.", "assets": { "light": "v2-light.png", "dark": "v2-dark.png" } }
  ]
}
```

- `title`: the flow's `title` from `coverage.mjs apply`. `prompt`: one sentence from the product brief (at most 280 characters).
- Option titles at most 60 characters, descriptions 240. The current option comes first, once, with `"current": true`; the picker shows it with a "Your current page" badge.
- Every option has light and dark PNGs. Limits: PNG 1.5 MB, 40 steps and 50 MB per session.

## After the pick

- A new option `k`: move `variants/<Component>.v<k>.tsx` to `<Component>.tsx` and `variants/copy.v<k>.ts` to `copy.ts` in the flow folder, fixing their imports (`./copy`, `../../fallback404.css`, `./flow.css`). Leave `variants/` for `write.mjs clean --variants` in phase 7.
- The current page of an `exists` flow: nothing to promote; the site's file stays.
- The current page of a `soft` flow: port what the page renders for a missing record into `NotFound.tsx` and `copy.ts`, using the same components, so the look stays and the status becomes a real 404.
- The user kept the root 404 (current pick, or Keep on the coverage page) while section flows have designs: propose in `changes.md` to move the site's root not-found content into `flows/root-not-found/NotFound.tsx` (`reference/review.md`); without it, sections show the site's root page. The moved file keeps the page unchanged (its imports fixed for the new folder, its default export also exported as `NotFound`) and starts with the line `// Fallback404: the site's own page, moved here unchanged from <path>.`, so `check.mjs` leaves it as the user's code. Write it in phase 7 before `write.mjs wrappers`, which then writes the router and replaces `app/not-found` with its wrapper.

## Waiting

- `node ${CLAUDE_SKILL_DIR}/scripts/picker.mjs wait --step <id>` with a Bash timeout of 600000 ms. It prints `{"status":"picked","position":n,"note":…}` or `{"status":"rejected","note":…}`. Exit code 3 means no decision yet: run it again.
- After six runs (about 54 minutes), ask: keep waiting, or stop and resume later (`state.json` and the session survive; links last 7 days).
- `rejected`: the note says what to change. A designer makes round + 1 in a new folder (`.fallback404/steps/<kind>-r<round+1>/`, new variant numbers) and keeps what the user liked.

## Dev server

The dev server runs since phase 2 (`devserver.mjs start` reuses it). If it is down and will not start (`dev_failed`, `dev_timeout`), design steps cannot show previews: tell the user what the log lines say (often a variable missing from `.env.local`) and ask whether to fix it and retry, or stop here and resume later; the picks so far are kept.

## Errors

- 409 (step cap) or 410 (expired): `picker.mjs create` again with the remaining flows as `--plan`; the picks stay in `state.json`.
- `bad_manifest` from propose: the message names the problem (a missing file, a second current option). Fix the manifest and propose again.

## Shoot plan for phase 8

```json
{
  "baseUrl": "<url from devserver.mjs>",
  "basePath": "<basePath from .fallback404/coverage/rows.json>",
  "darkMode": { "strategy": "class", "value": "dark" },
  "checks": [
    { "path": "/fallback404-check-x7k2", "expectStatus": 404, "expectText": "<flows/root-not-found/copy.ts title>" },
    { "path": "/match/fallback404-x7k2", "expectStatus": 404, "expectText": "<that section's copy title>" },
    { "path": "/match/fallback404-x7k2", "expectStatus": 404, "expectText": "<that section's copy title>", "hydrate": false },
    { "path": "/fallback404-preview", "expectStatus": 200 }
  ],
  "shots": [
    { "path": "/fallback404-preview?flow=root-not-found&solo=1", "name": "root-not-found" },
    { "path": "/fallback404-preview?flow=root-loading&solo=1", "name": "root-loading" },
    { "path": "/fallback404-preview?flow=root-loading&inline=1&solo=1", "name": "root-loading-inline" }
  ]
}
```

One shot per flow with a final component (loaders also inline). A check per proxy-fixed section with a made-up id. When the scan left `app/fallback404-missing/` out (the rewrite lands on the root not-found), add a second one with `"hydrate": false`: it shows what visitors see before JavaScript runs and must already be the section's design. With `app/fallback404-missing/` written, leave it out: that body arrives with JavaScript (`reference/nextjs-404.md`). Take `darkMode` from `brand-kit.json`.
