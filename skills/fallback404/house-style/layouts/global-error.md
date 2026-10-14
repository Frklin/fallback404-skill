# Layout: global-error

- Rendered instead of the root layout, inside the `<html>` and `<body>` that `write.mjs` writes: no site header, footer, providers or context, so the site's components that need them cannot be used. The screen must stand alone.
- Order: the site's name or logo file (an `<img>` of the file in `public/`, or text), `<h1>`, one sentence, a button that calls `retry()`.
- Fonts: the site's font variables may be missing here; keep a system-ui fallback in the font stack.
