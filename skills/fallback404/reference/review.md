# The review: changes.md

After the last pick, and before anything but drafts is written, list every change and wait for the user's yes.

## Inputs

- `node ${CLAUDE_SKILL_DIR}/scripts/write.mjs wrappers --dry-run`: the route files and generated files (`planned[]`: `file`, `kind`, `replace`, `blocked`) and `warnings`.
- `plan.json` (`flows`, `approved`), `state.json` (`picks`, with `current: true` for kept pages), `scan.json` (findings and proposals).
- Proposed user-file changes: for each one, write the full proposed file to `.fallback404/proposed/<same path>` and get its diff with `git diff --no-index -- <path> .fallback404/proposed/<path>`. These cover a proxy or middleware you extend, a `page.tsx` that gets `notFound()`, a Suspense fallback that gets `<Loader inline />`, and the site's root `not-found` that you move into `flows/root-not-found/` when sections have designs but the user kept their root page.

## changes.md

~~~markdown
# Fallback404: changes on branch <branch>

## Your picks
| Flow | Pick |
| --- | --- |
| 404 · whole site | Kept your current page |
| 404 · /match/[matchId] | Empty board |

## New files
- `components/fallback404/flows/match-matchid-not-found/NotFound.tsx`: the empty match board (MatchBoard, Button from components/ui) and "This match doesn't exist".
- `components/fallback404/NotFoundRouter.tsx`, `NotFoundGate.tsx`: generated; show each section's design on the root not-found page.

## Replaced files (yours today)
- `app/loading.tsx` → wrapper for `flows/root-loading/Loader`. Today: a spinner.

## Changed files (yours)
- `proxy.ts`: an existence check for `/match/:matchId`, rewriting missing matches to `/fallback404-missing`.

  ```diff
  …
  ```

## Removed at write time
- Draft options: `components/fallback404/flows/*/variants/`.

## Untouched
- `app/error.tsx` (kept).
~~~

- Every file in `planned[]` appears under "New files" or "Replaced files". A `blocked` entry means the site has that file and nobody approved replacing it: either list it under "Replaced files" (when the user picked a new design for that flow) or explain why it stays.
- Every `warnings` line from the dry run appears in plain words.
- The preview route (`app/fallback404-preview/`) is dev-only and stays until the user removes Fallback404; say so once.

## In the chat

A short summary, then the question:

> 5 new files, 1 replaced (app/loading.tsx), 1 of yours changed (proxy.ts). Details and diffs: .fallback404/changes.md.
> Write these changes? Reply yes, no, or what to change.
