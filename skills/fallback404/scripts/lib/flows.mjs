// Flows: a coverage row the user chose to make (a route and a state), its picker step kind, its folder in the
// components folder and the route file that renders it. Shared by coverage, write, manifest and check.
// Spec: docs/superpowers/specs/2026-10-13-flow-steps-design.md (sections 5 and 8).

export const COMPONENTS = { 'not-found': 'NotFound', loading: 'Loader', error: 'ErrorState', 'global-error': 'GlobalErrorState' }
export const STATE_LABELS = { 'not-found': '404 page', loading: 'Loading', error: 'Error page', 'global-error': 'Global error' }
export const ROOT_NOT_FOUND = 'root-not-found'
const SLUG_MAX = 40

const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** The picker step kind for a coverage row: `flow-` and the row id, a slug the picker accepts (24 characters at most). */
export function flowKind(rowId) {
  return `flow-${rowId.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`.slice(0, 24).replace(/-+$/, '')
}

/** A flow's folder name: `root-<state>` for the whole site, else the route's segment names and the state. */
export function flowSlug(route, state) {
  const parts = route
    .split('/')
    .map((part) =>
      part
        .replace(/^\[{1,2}(?:\.\.\.)?|\]{1,2}$/g, '')
        .replace(/^\(|\)$/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .filter(Boolean)
  const base = parts.length === 0 ? 'root' : parts.join('-')
  return `${base.slice(0, SLUG_MAX - state.length - 1).replace(/-+$/, '')}-${state}`
}

/** Folder names for flows in order; a name already taken gets -2, -3… */
export function uniqueSlugs(items) {
  const seen = new Map()
  return items.map(({ route, state }) => {
    const slug = flowSlug(route, state)
    const count = (seen.get(slug) ?? 0) + 1
    seen.set(slug, count)
    return count === 1 ? slug : `${slug}-${count}`
  })
}

/** The picker step title: "404 page · /match/[id]", or "404 page · whole site" for the root. */
export function stepTitle(route, state) {
  return clip(`${STATE_LABELS[state]} · ${route === '/' ? 'whole site' : route}`, 80)
}

/** A flow's final component file. */
export const componentFile = (scan, slug, state) => `${scan.componentsDir}/flows/${slug}/${COMPONENTS[state]}.${scan.typescript ? 'tsx' : 'jsx'}`

/**
 * The route file that renders a flow: its wrapper kind (router | not-found | loading | error | global-error), the
 * file, and whether it replaces the site's own file. Null for flows routed another way: a fixed section (the proxy
 * rewrites to the root not-found, where the router shows its design) or a weak Suspense fallback (an edit of the page).
 */
export function wrapperTarget(finding) {
  if (!finding) return null
  const proposed = finding.proposal?.files?.[0]
  switch (finding.kind) {
    case 'missing-root-not-found':
      return { kind: 'router', file: proposed, replace: false }
    case 'missing-error':
      return { kind: 'error', file: proposed, replace: false }
    case 'missing-global-error':
      return { kind: 'global-error', file: proposed, replace: false }
    case 'missing-loading':
      return finding.proposal?.type === 'write' ? { kind: 'loading', file: proposed, replace: false } : null
    case 'existing-state':
      if (finding.state === 'not-found') return { kind: finding.route === '/' ? 'router' : 'not-found', file: finding.file, replace: true }
      return { kind: finding.state, file: finding.file, replace: true }
    default:
      return null
  }
}

/** The root not-found route file: the site's own, the one the scan proposes, or `<appDir>/not-found`. */
export function rootNotFoundTarget(scan) {
  for (const finding of scan.findings ?? []) {
    if (finding.kind === 'existing-state' && finding.state === 'not-found' && finding.route === '/') return { kind: 'router', file: finding.file, replace: true }
    if (finding.kind === 'missing-root-not-found') return { kind: 'router', file: finding.proposal.files[0], replace: false }
  }
  return { kind: 'router', file: `${scan.appDir}/not-found.${scan.typescript ? 'tsx' : 'jsx'}`, replace: false }
}

/** True for the findings whose fix is a real 404 for a section: the proxy check plus a section design. */
export const isSectionFix = (finding) => finding?.kind === 'soft-404' || finding?.kind === 'no-notfound-candidate'
