# Layout: loading

- Full-page loader (`<Loader />`): a fixed box (`.f404-loader`, `min-block-size: 50vh` or the size of the content it stands in for).
- Inline loader (`<Loader inline />`, for Suspense fallbacks): `.f404-loader-inline`, a smaller fixed box (`min-block-size: 6rem`).
- What moves: a skeleton that mirrors the route's layout with the site's surfaces and radius, the site's own spinner or progress component, or the site's logo with a motion preset.
- `role="status"` on the box and visually hidden text from the flow's `copy.ts`. No text that changes, no progress numbers.
