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

## brand-kit.json

```json
{
  "schema": 2,
  "name": "Acme",
  "purpose": "Hand-made kettles, sold online.",
  "audience": "Tea lovers",
  "tone": "warm",
  "lang": "en",
  "logo": { "file": "public/logo.svg" },
  "fonts": { "heading": "var(--font-geist-sans)", "body": "var(--font-geist-sans)" },
  "radius": "var(--radius)",
  "darkMode": { "strategy": "class", "value": "dark" },
  "roles": {
    "bg": { "token": "var(--background)", "light": "#ffffff", "dark": "#0a0a0a" },
    "surface": { "token": null, "light": "#f4f4f5", "dark": "#18181b" }
  }
}
```

- All eight roles are required: `bg`, `surface`, `ink`, `muted`, `line`, `accent`, `accent-2`, `on-accent`.
- `token` is the site's variable for that role (from `identity.json` and the UI brief), or null. `light` and `dark` are the values it resolves to.
- `darkMode` comes from `identity.json`: `media`; `class` with `value`; `attribute` with `attribute` and `value`; or `none`.
- Check contrast: `ink` on `bg` and `on-accent` on `accent` reach 4.5:1.

## fallback404.css

- Map roles to tokens on `:root`, e.g. `--f404-ink: var(--foreground);`. A role with `token: null` gets its light value on `:root` and its dark value in the site's dark-mode block: `@media (prefers-color-scheme: dark) { :root { … } }` for `media`, `.dark { … }` for `class`, `[data-theme="dark"] { … }` for `attribute`.
- Every selector starts with `.f404-`; never style elements globally, since the stylesheet stays loaded across navigations.
- Shared classes: `.f404-screen`, `.f404-title`, `.f404-body`, `.f404-action`, `.f404-art`, `.f404-loader`, `.f404-loader-inline`, `.f404-visually-hidden`. Prefer the site's own classes and components inside them.
- Copy the motion presets loaders may use from `house-style/motion/<id>.css`, reduced-motion rule included.
- Fonts: the brand kit's font variables with a fallback, e.g. `font-family: var(--font-geist-sans), system-ui, sans-serif`.

## Components

- Every flow component imports `./copy` and `../../fallback404.css` (and `./flow.css` when it has one).
- NotFound: an optional `data-f404-art` scene from the site's components, `<h1>`, a sentence, one primary action (the site's button or link), optional links to key pages.
- ErrorState and GlobalErrorState: `<h1>`, a sentence, a button that calls `retry()`. GlobalErrorState uses no site components (`house-style/layouts/global-error.md`).
- Loader: the fixed box (`.f404-loader`, plus `.f404-loader-inline` when `inline`), what moves, visually hidden label text.

## Copy

What happened, what to do, one action, in the site's language (`lang`) and tone, with its nouns. Speak to the visitor's situation in this site's world, not about servers. Keep each `<h1>` under 60 characters. A section's 404 names the section's thing: "This match doesn't exist" beats "Page not found".

## After writing

`write.mjs wrappers`, `write.mjs preview`, then phase 8. To remove Fallback404: delete `<componentsDir>`, the route files listed in `manifest.json`, `app/fallback404-missing/`, `app/fallback404-preview/`, and your block in the proxy.
