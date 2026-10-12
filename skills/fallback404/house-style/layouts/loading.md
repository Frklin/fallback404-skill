# Layout: loading

- Full-page loader (`<Loader />`): a fixed box (`.f404-loader`, `min-block-size: 50vh`) with the mascot centered at 96px and the picked motion.
- Inline loader (`<Loader inline />`, for Suspense fallbacks): `.f404-loader-inline`, a smaller fixed box (`min-block-size: 6rem`), mascot at 48px.
- `role="status"` on the box and visually hidden text from `copy.loading.label`. No text that changes, no progress numbers.
