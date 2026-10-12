# Layout: error

- Same column as not-found (`.f404-screen`).
- Order: illustration in a "something broke" pose, `<h1>` with the message, one sentence, a primary button that calls `retry()`, and a secondary link home.
- Client Component (`'use client'`). Never show the error message itself to visitors; `error.digest` may go in a data attribute for support.
