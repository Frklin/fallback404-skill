# Layout: global-error

- Rendered instead of the root layout, inside the `<html>` and `<body>` that `write.mjs` writes: no site header or footer, so the screen must stand alone.
- Order: illustration, `<h1>`, one sentence, a button that calls `retry()`.
- Fonts: the site's font variables may be missing here; keep a system-ui fallback in the font stack.
