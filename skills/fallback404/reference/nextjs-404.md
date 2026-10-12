# Real 404s in Next.js (App Router)

Measured on Next.js 16.4 in October 2026, in `next dev` and in `next build` + `next start`; the root `loading` rows also on 16.3.6.

## What answers what

| Pattern | Cache Components on | Cache Components off |
| --- | --- | --- |
| Unknown URL (root `not-found`) | 404 | 404 |
| Static route, `notFound()` at build time | 404 | 404 |
| The same under a root `loading.js` (`app/loading.*`) | 200 + noindex on 16.3.6, 404 on 16.4 | same |
| Dynamic route, `notFound()` at the top of the page, nothing streams first | build error (needs Suspense) | 404 |
| `notFound()` inside `<Suspense>`, or under any `loading.js` above the page | 200 + noindex | 200 + noindex |
| `generateStaticParams` route, unknown param | 200 on the first request | 404 |
| `export const instant = false` on such a route | 200 in production | n/a |
| Proxy rewrite to a route that calls `notFound()` at build time | 404 (200 under a root `loading.js` on 16.3.6) | same |
| Proxy rewrite to a path no route matches | 404 | 404 |

What follows:
- With Cache Components, the only real 404 for a dynamic URL is a proxy existence check that rewrites to `/fallback404-missing`.
- A client page, or any page under a `loading.js`, cannot answer 404 with `notFound()`: its real 404 comes from the proxy check too.
- Never add a `loading.tsx` above a dynamic route whose 404 is real today (status `real` in scan.json): it turns the 404 into a 200. The scan already marks those findings report-only.
- Page-level 404s ship an empty HTML body until JavaScript runs, so check the text in a browser (`shoot.mjs`), never in raw HTML.

## The proxy pattern

The proxy rewrites to `/fallback404-missing`. `write.mjs wrappers` writes that route (`app/fallback404-missing/page.tsx`, a build-time `notFound()`) when the proposal lists it. Under a root `loading.js` the scan leaves it out: the path then matches no route, and Next.js answers with the root not-found page and a real 404. Never write that page by hand; `check.mjs` flags it. You write two files.

`<componentsDir>/proxy-checks.ts`, with the project's own data access, existence only (no full fetch, no joins):

```ts
import { db } from '@/lib/db'

// Existence checks for proxy.ts: "does this record exist?", never a full fetch.
export async function productExists(id: string): Promise<boolean> {
  return (await db.product.count({ where: { id } })) > 0
}
```

`proxy.ts` next to the app directory (Next.js 16; on 15 the file is `middleware.ts` and the function `middleware`):

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { productExists } from '@/components/fallback404/proxy-checks'

export async function proxy(request: NextRequest) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return NextResponse.next()
  const id = request.nextUrl.pathname.split('/')[2] ?? ''
  let exists = true
  try {
    exists = await productExists(id)
  } catch {
    // Fail open: an outage in the check must never turn real pages into 404s.
  }
  if (exists) return NextResponse.next()
  const url = request.nextUrl.clone()
  url.pathname = '/fallback404-missing'
  return NextResponse.rewrite(url)
}

export const config = { matcher: ['/products/:id'] }
```

Rules:
- One branch per approved route; its matcher entry is the finding's `proposal.matcher`. Matchers must be literals.
- Read segments from `request.nextUrl.pathname` (it excludes `basePath`); `nextUrl.clone()` keeps `basePath` on the rewrite.
- `GET` and `HEAD` only, so Server Actions are never affected.
- An existing proxy or middleware: add your branch at the top of its function and your entries to its matcher, show the diff, ask, then add the file to `userFiles`.
- Keep the page's own `notFound()`: the proxy turns away unknown records, the page still handles records that disappear later.

## Version table

| | Next 15 | 16.0–16.2 | 16.3+ |
| --- | --- | --- | --- |
| Request hook | `middleware.ts`, `export function middleware` | `proxy.ts`, `export function proxy` | same |
| Error prop | `reset` | `reset` | `retry` |
| Cache Components flag | `experimental.dynamicIO` or `ppr` (canary) | `cacheComponents` | same |
| `instant = false` on build-time 404 routes | no | no | with Cache Components |

`write.mjs` applies this table to the files it writes. State components always take `{ error, retry }`; the wrappers pass `reset` on as `retry` on older versions.

## Status checks (phase 7)

- Dev: `/fallback404-check-<random>` → 404 with the not-found `<h1>` text; each proxy-fixed route with a made-up id → 404 with the same text; `/fallback404-preview` → 200.
- Production (`next build`, then `next start -p <free port>`): the same, plus `/fallback404-preview` → 404. Under a root `loading.js`, Next.js 16.3.6 answers 200 + noindex there (16.4 answers 404), with the not-found text: the gallery still never renders in production, so expect that and tell the user.
- Prefix every path with `config.basePath`, or set `basePath` in the shoot plan.
- Section text: the root not-found page is the same HTML for every URL; `NotFoundText` swaps in the section's text after hydration, so check it in a browser (`shoot.mjs`), never in raw HTML.
