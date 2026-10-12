# Fallback404 house style (minimal set)

The contract every illustration, motion preset and page layout follows. Sub-project 3 replaces the content of this folder; the names and the shape stay: `index.json`, the role names, the `data-part` names and the `.f404-anim-<id>` classes.

## Canvas

- `viewBox="0 0 240 240"`; keep the artwork on the lower two thirds so it sits well above a heading.
- Geometric, rounded shapes: `stroke-linecap="round"`, `stroke-linejoin="round"`. Outlines 4 units, details 2–3.
- One idea per illustration, at most 8 KB of SVG source.

## Color roles

- Colors are only `var(--f404-<role>)`, `none` or `currentColor`. Roles: `bg`, `surface`, `ink`, `muted`, `line`, `accent`, `accent-2`, `on-accent`.
- Body fill `accent` (or `surface` for calm brands), outlines `ink`, shadows `line`, highlights `accent-2`, small marks `muted`.

## Parts

- Group the artwork with `data-part`: `body`, `face`, `eyes`, `mouth`, `limbs`, `prop`, `shadow`. Motion presets animate these parts.
- Stroked paths that should draw on get `pathLength="1"`.

## Ids

- Components build ids from `useId()` (see `reference/output-rules.md`). In a role SVG for the picker, ids are fine but unique within the file.

## Concepts

- A concept is a metaphor from the site's own world for "what you wanted is not here" (404), "something broke" (error) and "on its way" (loading).
- The same character or motif appears in every state; only its pose, props and scene change.
- Never reference existing characters, mascots or brands.
