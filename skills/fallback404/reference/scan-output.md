# scan.json and the coverage report

`node ${CLAUDE_SKILL_DIR}/scripts/scan.mjs --report` writes `.fallback404/scan.json` and prints the coverage report.

## Fields you use

- `next.version`, `next.major`: pick version-specific code from `nextjs-404.md`.
- `appDir` (`app` or `src/app`), `componentsDir` (`components/fallback404` or `src/components/fallback404`), `typescript`, `alias` (`@/`, another prefix, or null).
- `config.cacheComponents` (true, false or "unknown"); `config.basePath`: prefix every URL you check with it.
- `proxy`: the existing `proxy.ts`/`middleware.ts` (`file`, `kind`, `matcher`), or null.
- `routes[]`: `route`, `page`, `dynamic`, `notFound.use` (direct, indirect, none, unknown; `notFound.via` names the helper), `status404` (real, soft, none, review, or null for static routes), `statusReason`.
- `findings[]`: `id`, `kind`, `route`, `file`, `line`, `confidence`, `reason`, `proposal` (`type`: write, proxy, diff, replace or report; `files`; `matcher` for proxy).
- `owned[]`: files an earlier run wrote, `unchanged` or `edited` (edited ones are the user's now).
- `warnings[]`: show them; they explain every "unknown".

## What to do with each finding

| kind | before the coverage step | when the user makes it |
| --- | --- | --- |
| `missing-root-not-found`, `missing-error`, `missing-global-error` | nothing | `write.mjs wrappers` writes the file |
| `soft-404`, confidence high | read the page and its data helper (`notFound.via`): how can a proxy test cheaply that the record exists? | write the proxy check (`nextjs-404.md`) |
| `soft-404`, confidence review | read what the reason names (the proxy, the Suspense, the config) and decide whether it is really soft; drop it if not | same as above |
| `no-notfound-candidate` | read the page: does a missing record render an empty page or crash? drop the finding if the page handles it | show the `page.tsx` diff that adds `notFound()`, ask, edit, add the file to `userFiles`. When the proposal type is `proxy` (the page is under a `loading.js` or Cache Components is on, so `notFound()` alone answers 200), also write the proxy check (`nextjs-404.md`); the diff is in `proposal.diff` |
| `missing-loading` (write) | nothing | `write.mjs wrappers` writes `loading.tsx` |
| `missing-loading` (report) | show the reason | nothing |
| `weak-suspense-fallback` | nothing | show the diff that sets `fallback={<Loader inline />}` (import from the components folder), ask, edit, add the file to `userFiles` |
| `existing-state` | list it as covered | only if the user asks: add its file to `replace` |
| `unsupported` | explain | nothing |

## plan.json

`coverage.mjs apply` writes it from the user's choices on the coverage page; keep `userFiles` current.

```json
{ "schema": 1, "optionsPerStep": 3, "approved": ["F1", "F2"], "replace": [], "userFiles": [] }
```

- `approved`: finding ids the user approved.
- `replace`: user files the user asked to replace with Fallback404 wrappers.
- `userFiles`: user files you changed after the user approved the diff (`proxy.ts`, a `page.tsx`). `check.mjs` flags any other change.
