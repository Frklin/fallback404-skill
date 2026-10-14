# global-error: constraints

- Renders instead of the root layout, inside the `<html>` and `<body>` that write.mjs writes: no site header, footer,
  providers or context. The site's components that need them cannot be used; the screen stands alone.
- The site's name or logo file (an `<img>` of a file in `public/`, or text), one `<h1>`, one sentence, a button that calls `retry()`.
- Fonts: the site's font variables may be missing here; keep a system-ui fallback.
