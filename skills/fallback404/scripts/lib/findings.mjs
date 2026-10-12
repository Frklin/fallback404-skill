// Predicts how each dynamic route's notFound() answers (spec section 3.1) and turns the scan into numbered findings.
import { matcherCovers, routeMatcher } from './proxy.mjs'
import { matchesPath, nearest, routeForDir } from './routes.mjs'

export const KIND_ORDER = [
  'unsupported',
  'missing-root-not-found',
  'missing-error',
  'missing-global-error',
  'soft-404',
  'no-notfound-candidate',
  'missing-loading',
  'weak-suspense-fallback',
  'existing-state',
]
const OWN_ROUTE = /\/fallback404-(?:preview|missing)(?:\/|$)/
const REWRITE = '/fallback404-missing'

/** True for the routes Fallback404 itself writes: the preview page and the static 404 rewrite target. */
export const isOwnRouteDir = (dir) => OWN_ROUTE.test(dir)

/** { status, reason } for a dynamic route: 'real' | 'soft' | 'none' | 'review'; null for static routes. */
export function predictStatus(route, { config, segments, layoutSuspense, proxy }) {
  if (!route.dynamic) return null
  if (route.notFound.use === 'none') return { status: 'none', reason: 'The page never calls notFound().' }
  if (route.notFound.use === 'unknown') {
    return { status: 'review', reason: 'Fallback404 could not read how this page reaches notFound() (an MDX page, or a file it could not parse).' }
  }
  if (proxy && matcherCovers(proxy.matcher, route.route)) {
    return { status: 'review', reason: `${proxy.file} already runs on this route; check whether it answers 404 for missing records.` }
  }
  if (config.cacheComponents === true) return { status: 'soft', reason: 'With Cache Components, a request-time notFound() answers HTTP 200.' }
  if (config.cacheComponents !== false) return { status: 'review', reason: 'Cache Components could not be read from the Next.js config.' }
  const loading = nearest(segments, route.chain, 'loading')
  if (loading) return { status: 'soft', reason: `${loading} streams the page first, so notFound() answers HTTP 200.` }
  if (route.suspense.length > 0 || route.chain.some((dir) => layoutSuspense.get(dir))) {
    return { status: 'review', reason: 'A <Suspense> boundary may stream this page before notFound() runs.' }
  }
  return { status: 'real', reason: 'notFound() runs before anything streams, so it answers HTTP 404.' }
}

/** The route with its prediction, plus, for a dynamic page that never calls notFound(), the status it would get once it does. */
export function predictRoute(entry, context) {
  const prediction = predictStatus(entry, context)
  const ifAdded = entry.dynamic && entry.notFound.use === 'none' ? predictStatus({ ...entry, notFound: { use: 'direct' } }, context) : null
  return { ...entry, status404: prediction?.status ?? null, statusReason: prediction?.reason ?? null, statusIfNotFound: ifAdded?.status ?? null }
}

function compare(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return 0
}

function numbered(findings) {
  const key = (finding) => [KIND_ORDER.indexOf(finding.kind), finding.route, finding.file ?? '', finding.line ?? 0]
  return findings.sort((a, b) => compare(key(a), key(b))).map((finding, index) => ({ id: `F${index + 1}`, ...finding }))
}

/** Every finding of the coverage report, each with a proposal (spec section 6.3). */
export function buildFindings({ appDir, ext, componentsDir, typescript, config, segments, routes, owned, layouts, noRootLayout }) {
  const findings = []
  const root = segments.get(appDir)?.special ?? {}
  const appFile = (name) => `${appDir}/${name}.${ext}`
  if (noRootLayout) {
    findings.push({
      kind: 'unsupported',
      route: '/',
      reason: 'There is no root layout at the top of the app directory (each route group has its own), so a root not-found page cannot render. Support for global-not-found comes later.',
      proposal: { type: 'report' },
    })
  }
  if (config.output === 'export') {
    findings.push({
      kind: 'unsupported',
      route: '/',
      reason: "output: 'export' builds a static site where no proxy runs, so 404 status fixes cannot apply; the host's 404.html handling decides the status.",
      proposal: { type: 'report' },
    })
  }
  if (!root['not-found'] && !root['global-not-found'] && !noRootLayout) findings.push({ kind: 'missing-root-not-found', route: '/', proposal: { type: 'write', files: [appFile('not-found')] } })
  if (!root.error) findings.push({ kind: 'missing-error', route: '/', proposal: { type: 'write', files: [appFile('error')] } })
  if (!root['global-error']) findings.push({ kind: 'missing-global-error', route: '/', proposal: { type: 'write', files: [appFile('global-error')] } })

  // A root loading file streams before any page, so on some versions (measured on 16.3.6) the build-time notFound()
  // route answers 200 under it. A URL no route catches stays a real 404, so the rewrite target is left unrouted then.
  const unrouted = Boolean(root.loading) && !routes.some((route) => matchesPath(route.route, REWRITE))
  const proxyProposal = (route, extra = {}) => ({
    type: 'proxy',
    matcher: routeMatcher(route.route),
    rewrite: REWRITE,
    files: [...(unrouted ? [] : [appFile('fallback404-missing/page')]), `${componentsDir}/proxy-checks.${typescript ? 'ts' : 'js'}`],
    ...extra,
  })
  const softish = (status) => (status === 'soft' || status === 'review') && config.output !== 'export'

  for (const route of routes) {
    if (softish(route.status404)) {
      findings.push({
        kind: 'soft-404',
        route: route.route,
        file: route.page,
        confidence: route.status404 === 'soft' ? 'high' : 'review',
        reason: route.statusReason,
        proposal: proxyProposal(route),
      })
    }
    if (route.dynamic && route.notFound.use === 'none') {
      // notFound() alone would answer 200 here, so the real 404 comes from the proxy check; the page diff still helps.
      const proposal = softish(route.statusIfNotFound) ? proxyProposal(route, { diff: [route.page] }) : { type: 'diff', files: [route.page] }
      findings.push({ kind: 'no-notfound-candidate', route: route.route, file: route.page, confidence: 'review', proposal })
    }
    const pending = nearest(segments, route.chain, 'loading') !== null || route.suspense.length > 0 || route.chain.some((dir) => (layouts.get(dir)?.suspense.length ?? 0) > 0)
    if (config.cacheComponents === false && route.awaitsData && !pending) {
      findings.push(
        route.status404 === 'real'
          ? {
              kind: 'missing-loading',
              route: route.route,
              file: route.page,
              proposal: { type: 'report', reason: `A loading.${ext} here would start streaming before notFound() runs, turning this route's real 404 into a soft 404 (HTTP 200).` },
            }
          : { kind: 'missing-loading', route: route.route, file: route.page, proposal: { type: 'write', files: [`${route.dir}/loading.${ext}`] } },
      )
    }
  }

  const boundaries = [
    ...routes.map((route) => ({ file: route.page, dir: route.dir, suspense: route.suspense })),
    ...[...layouts].map(([dir, layout]) => ({ file: layout.file, dir, suspense: layout.suspense })),
  ]
  for (const { file, dir, suspense } of boundaries) {
    for (const boundary of suspense) {
      if (boundary.fallback === 'element') continue
      findings.push({ kind: 'weak-suspense-fallback', route: routeForDir(appDir, dir), file, line: boundary.line, fallback: boundary.fallback, proposal: { type: 'diff', files: [file] } })
    }
  }

  for (const segment of segments.values()) {
    if (isOwnRouteDir(segment.dir)) continue
    for (const state of ['not-found', 'loading', 'error', 'global-error']) {
      const file = segment.special[state]
      if (file && !owned.has(file)) findings.push({ kind: 'existing-state', route: routeForDir(appDir, segment.dir), file, state, proposal: { type: 'replace', files: [file] } })
    }
  }
  return numbered(findings)
}
