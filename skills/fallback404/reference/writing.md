# Writing the files

## Layout

`<componentsDir>` is `components/fallback404` (`src/components/fallback404` with `src/app`). Use `.jsx`/`.js` when the project has no TypeScript.

```
<componentsDir>/
  illustrations/Mascot.tsx      the picked mascot (and Logo.tsx after a logo step)
  illustrations/Motif.tsx       the picked UI motif, when the mascot step picked one
  states/NotFound.tsx           export function NotFound()
  states/NotFoundText.tsx       written by write.mjs: the general or the section's 404 text
  states/ErrorState.tsx         'use client'; export function ErrorState({ error, retry })
  states/GlobalErrorState.tsx   'use client'; export function GlobalErrorState({ error, retry }); content only
  states/Loader.tsx             export function Loader({ inline = false }: { inline?: boolean })
  proxy-checks.ts               only with an approved proxy fix
  copy.ts                       export const copy = { notFound: { …, sections }, error, globalError, loading: { label } }
  fallback404.css               role tokens, layout classes, motion
  manifest.json                 written by manifest.mjs, never by hand
```

`write.mjs` writes route files that import exactly these names and props.

## brand-kit.json

```json
{
  "schema": 1,
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
- `token` is the site's variable for that role (from `identity.json`), or null. `light` and `dark` are hex values used to bake previews.
- `darkMode` comes from `identity.json`: `media`; `class` with `value`; `attribute` with `attribute` and `value`; or `none`.
- Check contrast: `ink` on `bg` and `on-accent` on `accent` reach 4.5:1.

## fallback404.css

- Map roles to tokens on `:root`, e.g. `--f404-ink: var(--foreground);`. A role with `token: null` gets its light value on `:root` and its dark value in the site's dark-mode block: `@media (prefers-color-scheme: dark) { :root { … } }` for `media`, `.dark { … }` for `class`, `[data-theme="dark"] { … }` for `attribute`.
- Every selector starts with `.f404-`; never style elements globally, since the stylesheet stays loaded across navigations.
- Copy the picked motion preset from `house-style/motion/<id>.css`, reduced-motion rule included.
- Fonts: the brand kit's font variables with a fallback, e.g. `font-family: var(--font-geist-sans), system-ui, sans-serif`.

## Components

- Illustrations: the locked role SVG as JSX (`stroke-width` → `strokeWidth`), `aria-hidden="true" focusable="false"`, ids from `useId()` as in `output-rules.md`, colors `var(--f404-<role>)`. Keep `data-part` so motion classes apply.
- Every state imports `../fallback404.css`.
- NotFound: illustration or motif, `<NotFoundText text={copy.notFound} sections={copy.notFound.sections} titleClassName=… bodyClassName=… />` (it renders the `<h1>` and the sentence), one primary action (`<Link href="/">`), optional links to key pages.
- ErrorState and GlobalErrorState: illustration, `<h1>`, a sentence, a button that calls `retry()`.
- Loader: the fixed box (`.f404-loader`, plus `.f404-loader-inline` when `inline`), the mascot with the motion class, visually hidden label text.

## Copy

What happened, what to do, one action, in the site's language (`lang`) and tone. Speak to the visitor's situation in this site's world, not about servers. Keep the 404 `<h1>` under 60 characters.

`notFound.sections`: one `{ route, title, body }` per approved section fix (the `route` exactly as in scan.json, e.g. `/match/[matchId]`), in the voice of that section: "This match doesn't exist" beats "Page not found".

## After writing

`write.mjs wrappers`, `write.mjs preview`, then phase 7. To remove Fallback404: delete `<componentsDir>`, the wrappers listed in `manifest.json`, `app/fallback404-missing/`, `app/fallback404-preview/`, and your block in the proxy.
