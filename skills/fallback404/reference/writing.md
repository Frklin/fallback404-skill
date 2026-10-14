# Writing the files

## Layout

`<componentsDir>` is `components/fallback404` (`src/components/fallback404` with `src/app`). Use `.jsx`/`.js` when the project has no TypeScript.

```
<componentsDir>/
  flows/<slug>/NotFound.tsx          export function NotFound()
  flows/<slug>/Loader.tsx            export function Loader({ inline = false }: { inline?: boolean })
  flows/<slug>/ErrorState.tsx        'use client'; export function ErrorState({ error, retry })
  flows/<slug>/GlobalErrorState.tsx  'use client'; export function GlobalErrorState({ error, retry }); content only
  flows/<slug>/copy.ts               export const copy = { title, body, action, … } as const
  flows/<slug>/flow.css              optional, the flow's own .f404- classes
  NotFoundRouter.tsx, NotFoundGate.tsx   written by write.mjs: the root not-found shows each section's design
  proxy-checks.ts                    only with an approved proxy fix
  fallback404.css                    role tokens, shared layout classes, motion
  manifest.json                      written by manifest.mjs, never by hand
```

`write.mjs wrappers` writes route files that import exactly these names: `app/not-found` imports the router; `loading`, `error` and `global-error` files import their flow's component. A flow that kept the site's current page has no folder, and its file stays the site's.

## brand-kit.json and fallback404.css

Both are generated and never edited by hand: the kit by `coverage.mjs run` (through `identity.mjs --write`), the stylesheet by `branch.mjs create` (through `identity.mjs --css`) once the branch exists, so nothing lands in the repo before it. `brand-kit.json` (schema 2) holds the site's name, purpose, language, logo file, fonts, radius, `darkMode` (`media`; `class` with `value`; `attribute` with `attribute` and `value`; or `none`) and the eight roles `bg`, `surface`, `ink`, `muted`, `line`, `accent`, `accent-2`, `on-accent`, each with the site token it maps to (or null) and its light and dark values, checked for contrast. `fallback404.css` maps `--f404-<role>` to those tokens on `:root` (literal values in the site's dark-mode block where it has no token), carries the shared classes `.f404-screen`, `.f404-title`, `.f404-body`, `.f404-action`, `.f404-art`, `.f404-loader`, `.f404-loader-inline`, `.f404-visually-hidden`, and the motion presets `.f404-anim-pulse` and `.f404-anim-bounce` with their reduced-motion rule. Every selector in it starts with `.f404-`; the flow's own classes go in its `flow.css`.

## plan.json

`coverage.mjs apply` writes it from the user's choices on the coverage page; keep `userFiles` current.

```json
{
  "schema": 2,
  "approved": ["F2", "F6"],
  "flows": [{ "kind": "flow-f6", "rowId": "F6", "slug": "root-not-found", "route": "/", "state": "not-found", "status": "exists", "file": "app/not-found.tsx" }],
  "userFiles": []
}
```

- `approved`: finding ids the user chose to make (a fixed section brings a missing root 404 along).
- `flows`: one design step each, in order; `slug` names its folder in `<componentsDir>/flows/`.
- `userFiles`: user files you changed after the user's yes in the review. `check.mjs` flags any other change.

## A kept root page

When the user kept the root 404 (the current pick, or Keep on the coverage page) while section flows have designs, propose in `changes.md` to move the site's root not-found content into `flows/root-not-found/NotFound.tsx` (`reference/review.md`); without it, sections show the site's root page. The moved file keeps the page unchanged (its imports fixed for the new folder, its default export also exported as `NotFound`) and starts with the line `// Fallback404: the site's own page, moved here unchanged from <path>.`, so `check.mjs` leaves it as the user's code. Write it in phase 5 before `write.mjs apply`, which then writes the router and replaces `app/not-found` with its wrapper. The current page of a `soft` flow is ported the same way after the pick (`port: true`): what the page renders for a missing record goes into `NotFound.tsx` and `copy.ts`, using the same components, so the look stays and the status becomes a real 404.

## Components

- Every flow component imports `./copy` and `../../fallback404.css` (and `./flow.css` when it has one).
- NotFound: an optional `data-f404-art` scene from the site's components, `<h1>`, a sentence, one primary action (the site's button or link), optional links to key pages.
- ErrorState and GlobalErrorState: `<h1>`, a sentence, a button that calls `retry()`. GlobalErrorState uses no site components (`house-style/layouts/global-error.md`).
- Loader: the fixed box (`.f404-loader`, plus `.f404-loader-inline` when `inline`), what moves, visually hidden label text.

## Copy

What happened, what to do, one action, in the site's language (`lang`) and tone, with its nouns. Speak to the visitor's situation in this site's world, not about servers. Keep each `<h1>` under 60 characters. A section's 404 names the section's thing: "This match doesn't exist" beats "Page not found".

## After writing

`write.mjs apply`, then phase 6. To remove Fallback404: delete `<componentsDir>`, the route files listed in `manifest.json`, `app/fallback404-missing/`, `app/fallback404-preview/`, and your block in the proxy.
