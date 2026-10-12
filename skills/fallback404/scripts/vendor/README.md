# Vendored code

- `babel-parser.cjs`: `@babel/parser` 7.29.9, `lib/index.js` copied unmodified (MIT, see `LICENSE-babel-parser`).
  It has no runtime `require()`, so the skill parses TypeScript and JSX in projects that lack the dependency.
  To update: copy the new `lib/index.js` over it, update the version here, run `npm test`.
