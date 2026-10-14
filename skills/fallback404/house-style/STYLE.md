# Fallback404 house style

Read `vendor/frontend-design/frontend-design.md` first: it is the design guide, unchanged. This file says how it applies
to 404, loading and error pages, and which Fallback404 rules win when the two disagree.

## The site first

- Build every page inside what the root layout already renders (header, footer, providers). Never repeat the site header.
- Compose from the site's components (buttons, cards, empty states, badges, headings) with fixed props, and its tokens or
  theme classes. Open a component's source when the site pack does not show what you need; never edit it.
- A scene built from the site's components sits in `<div aria-hidden="true" data-f404-art>`: decorative, with the message
  in real HTML text beside it. Small SVG marks are fine when the site has none to reuse: role colors only, ids from `useId()`.

## On these pages

- The state is the hero. One memorable element per option, taken from the site's own world (a guess row that spells 4 0 4,
  an empty month, a cart with nothing in it, a chart with no data), and everything around it quiet.
- The two options differ in idea, not in color: one stays close to what the site has today, the other changes the scene.
- The generic default here is a centered card with a tracked-out "404" label, a heading, a sentence, a pill button and
  three links. Avoid it unless the site itself looks like that; if the site does, do it in the site's exact classes.
- Copy says what happened and what to do, in the site's language, tone and nouns, with one action. Headings under 60
  characters. Every visible string lives in the flow's `copy.ts`.
- Motion: at most one orchestrated moment, and none under `prefers-reduced-motion`. Text never moves.
- Loaders reuse the site's own loading pattern first (its spinner, its skeleton shimmer), then the presets in `motion/`
  (`.f404-anim-pulse`, `.f404-anim-bounce` on a `data-part="body"` wrapper; `draw-on` for SVG strokes).
- Both themes meet contrast; look at the light and dark screenshots.
- Never reference other brands or characters.

## Color roles

`fallback404.css` maps `--f404-bg`, `--f404-surface`, `--f404-ink`, `--f404-muted`, `--f404-line`, `--f404-accent`,
`--f404-accent-2` and `--f404-on-accent` to the site's tokens, or to readable literals where it has none. Use them, the
site's variables, or the site's theme classes; never a literal color in a flow file.

## When the guide and the rules disagree

`reference/output-rules.md` wins: a real `<h1>`, tokens only, copy in `copy.ts`, `role="status"` on loaders, reduced
motion, one primary action. `check.mjs` enforces them. The guide shapes everything the rules leave open.
