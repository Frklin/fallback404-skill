# Output rules

Every file Fallback404 writes follows these rules. `check.mjs` enforces each by its id.

| Rule id | Rule | How |
| --- | --- | --- |
| `svg-aria-hidden` | Illustrations are decorative (SVG or a composition of the site's own components) | `aria-hidden="true"` and `focusable="false"` on every `<svg>`; the message is real HTML text beside it |
| `svg-static-id` | Ids are unique per instance | `const uid = useId().replace(/[^\w-]/g, '')`, then `` id={`f404-${uid}-shade`} `` and `` fill={`url(#f404-${uid}-shade)`} `` |
| `color-literal` | Every color comes from a token, in light and dark | components use only `var(--f404-<role>)`, `currentColor`, `none`, `transparent`; literal colors live only in `--f404-*` definitions in `fallback404.css` |
| `copy-literal` | Visible text lives in `copy.ts` | no text between JSX tags in states and illustrations; `alt`, `title`, `aria-label`, `placeholder` come from `copy` too |
| `state-h1` | Not-found and error screens have a real heading | one `<h1>` with the message |
| `loader-status` | Screen readers hear "loading" | `role="status"` (or `aria-busy`) with visually hidden text or an `aria-label` from `copy.ts` |
| `loader-box` | No layout shift | the loader root has the `f404-loader` class, and `.f404-loader` has a `min-block-size`, `block-size`, `height` or `aspect-ratio` |
| `loader-budget` | Loaders stay light | the loader, what it imports and `fallback404.css` stay within 15 KB gzipped |
| `motion-reduced` | Motion stops when people ask | every animated selector also sits in a `@media (prefers-reduced-motion: reduce)` rule with `animation: none` |
| `client-directive` | Error boundaries are Client Components | `'use client'` in the error and global-error wrappers, `ErrorState`, `GlobalErrorState` and the preview's `client` file |
| `global-error-document` | global-error replaces the root layout | it renders `<html lang>` and `<body>` |
| `error-prop` | Use the prop this Next.js passes | `retry` from 16.3, `reset` before; the wrappers pass it on as `retry` |
| `missing-route-static` | The proxy rewrite target is a build-time 404 | unconditional `notFound()`, no params, `instant = false` with Cache Components on 16.3+ |
| `missing-route-unrouted` | Under a root `loading.*`, the rewrite target stays unrouted | no page in `app/fallback404-missing/` when the scan left it out |
| `section-copy` | Fixed sections get their own 404 text | every approved section fix has an entry in `copy.notFound.sections`, and `NotFound` renders `NotFoundText` |
| `motif-aria-hidden` | UI motifs are decorative | the motif is wrapped in `<div aria-hidden="true" data-f404-motif>`; motifs are exempt from `copy-literal` |
| `preview-prod-404` | The preview page never ships | `notFound()` when `NODE_ENV === 'production'` |
| `write-scope` | Fallback404 touches only its files and approved user files | anything else changed since the branch was created is flagged |

Not machine-checked, still required:
- 404s answer HTTP 404, never 200 and never a redirect home (`shoot.mjs` checks it in the browser).
- Copy speaks to the visitor's situation, in the site's language and tone: what happened, what to do, one action.
- Light and dark both meet WCAG 2.2 AA contrast; look at the screenshots.
