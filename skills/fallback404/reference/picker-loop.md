# Design steps

Each flow in `plan.json` is one step on the picker: two new options, plus the site's current page when there is one. The designer builds them (`reference/agents.md`); `picker.mjs step` proposes each manifest, waits for the pick, records it and promotes the picked files.

## Flow folder

```
<componentsDir>/flows/<slug>/
  variants/<Component>.v1.tsx   option 1 (NotFound, Loader, ErrorState or GlobalErrorState)
  variants/copy.v1.ts           its visible text
  variants/<Component>.v2.tsx   option 2
  variants/copy.v2.ts
  flow.css                      optional: this flow's .f404- classes
```

- A variant imports its text from `./copy.v<k>`, the shared CSS from `../../../fallback404.css`, `flow.css` from `../flow.css`, and the site's components through the project's alias. Promotion rewrites these imports for the final file.
- Exports: `NotFound()`, `Loader({ inline })`, `ErrorState({ error, retry })` with `'use client'`, `GlobalErrorState({ error, retry })` with `'use client'`.
- Fallback404 rules apply (`reference/output-rules.md`): text from copy, `data-f404-art` scenes `aria-hidden`, tokens only, `role="status"` on loaders.

## Screenshots

`node ${CLAUDE_SKILL_DIR}/scripts/write.mjs preview` rebuilds the dev-only gallery from every flow folder (it waits for other designers through a lock) and prints its `entries`. Each flow gets its own page, `/fallback404-preview/<slug>`, so another designer's draft that does not compile never breaks your shots. A shoot plan is a JSON file with `baseUrl`, `basePath`, `out`, `darkMode` (from the brand kit), `checks` and `shots` (`path`, `name`, optional `themes`, `viewport`); shoot.mjs writes `<name>-<theme>.png` into `out` and prints a report with `status`, `pageErrors` and `overflowX` per shot.

| What | Shot path | Name |
| --- | --- | --- |
| option k | `/fallback404-preview/<slug>?variant=<k>&solo=1` | `v<k>` |
| option k at phone width | the same, with `"viewport": { "width": 390, "height": 844 }` | `v<k>-phone` (look at it; not proposed) |
| inline loader option k | `/fallback404-preview/<slug>?variant=<k>&inline=1&solo=1` | `v<k>-inline` (look at it; not proposed) |
| current page, `status` exists | `/fallback404-preview/<slug>?variant=current&solo=1` | `current` |
| current page, `status` soft | the made-up URL from coverage (the route with `fallback404-<token>` for each dynamic segment; `token` is in `.fallback404/coverage/rows.json`) | `current` |

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
    { "title": "Empty board", "description": "The match board with no moves, and a button back to the lobby.", "variant": 1, "assets": { "light": "v1-light.png", "dark": "v1-dark.png" } },
    { "title": "Lobby card", "description": "A card in the lobby's style with the three key links.", "variant": 2, "assets": { "light": "v2-light.png", "dark": "v2-dark.png" } }
  ]
}
```

- `kind` and `title` come from the flow in `plan.json` (`coverage.mjs apply` prints the titles). `prompt`: one sentence on the visitor's situation (at most 280 characters).
- Option titles at most 60 characters, descriptions 240. The current option comes first, once, with `"current": true`; the picker shows it with a "Your current page" badge.
- Every new option carries `"variant": k`, the number of its `variants/<Component>.v<k>` files: `picker.mjs step` promotes by it, never by card position (round 2 uses new numbers while round 1's files are still there).
- Every option has light and dark PNGs. Limits: PNG 1.5 MB, 40 steps and 50 MB per session.

## Errors

- 409 (step cap) or 410 (expired): `picker.mjs create` again with the remaining flows as `--plan`, then `step` again; the picks stay in `state.json`.
- `bad_manifest` from step: the message names the problem (a missing file, a second current option). Fix the manifest and run `step` again.
