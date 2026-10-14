# Fallback404 house style

The contract every generated page follows. Pages are composed from the site's own components and tokens; this folder only holds what the site cannot give: layouts per state, motion presets and a few rules. Names stay stable: `index.json`, the `.f404-anim-<id>` classes and the `--f404-<role>` tokens.

## The site first

- Build every page inside what the root layout already renders (header, footer, providers): read `.fallback404/brief/ui.md`. Never repeat the site header.
- Use the site's components (buttons, cards, empty states, badges, headings) with fixed props, and its tokens or theme classes. Fallback404's own classes start with `.f404-` and live in `fallback404.css` or the flow's `flow.css`.
- A scene built from the site's components (an empty board, a product card with nothing in it, a row of tiles playing 4 0 4) sits in `<div aria-hidden="true" data-f404-art>`: it is decorative, and the message is real HTML text beside it.
- Small SVG marks are fine when the site has none to reuse: role colors only (`var(--f404-<role>)`, `currentColor`, `none`), ids from `useId()`, `aria-hidden="true" focusable="false"`.

## Color roles

Roles: `bg`, `surface`, `ink`, `muted`, `line`, `accent`, `accent-2`, `on-accent`. `fallback404.css` maps each to the site's token, or to the brand kit's light and dark values when the site has none.

## Motion

- Presets in `motion/`: `pulse` and `bounce` move a `data-part="body"` wrapper, so they work on site components and on SVG; `draw-on` works on SVG strokes with `pathLength="1"`.
- A loader may reuse the site's own animation (its spinner, its skeleton shimmer) instead; it still needs the reduced-motion rule.
- Text never moves.

## Copy

- What happened, what to do, one action, in the site's language and tone and with its nouns (`brief/product.md`). "This match doesn't exist" beats "Page not found".
- Every visible string lives in the flow's `copy.ts`.
- Never reference other brands or characters.
