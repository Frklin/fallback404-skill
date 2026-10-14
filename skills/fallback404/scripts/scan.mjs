#!/usr/bin/env node
// Fallback404 scanner: finds missing 404, loading and error states in a Next.js App Router app, and soft 404s.
// Parses the code, never runs it. Usage: node scan.mjs [--preflight] [--report] [--out <file>] [--root <dir>]
import { relative, resolve } from 'node:path'
import { CliError, SKILL_VERSION, isMain, runCli, stringFlag } from './lib/cli.mjs'
import { buildFindings, isOwnRouteDir, predictRoute } from './lib/findings.mjs'
import { walk, workspacePath, writeJsonInside } from './lib/fs.mjs'
import { ensureExcluded } from './lib/git.mjs'
import { createModuleGraph } from './lib/modules.mjs'
import { readNextConfig } from './lib/next-config.mjs'
import { readOwned } from './lib/owned.mjs'
import { preflight } from './lib/project.mjs'
import { readProxy } from './lib/proxy.mjs'
import { renderReport } from './lib/report.mjs'
import { buildRoutes, nearest } from './lib/routes.mjs'
import { setPhase } from './state.mjs'

const USAGE = 'Usage: node scan.mjs [--preflight] [--report] [--out <file>] [--root <dir>]'

/** The full scan of the project at `root` (the content of .fallback404/scan.json). */
export async function scan(root) {
  const check = await preflight(root)
  if (!check.ok) throw new CliError('unsupported', check.problems.join(' '))
  const { project } = check
  const warnings = [...check.warnings]
  const config = await readNextConfig(root, project.next, warnings)
  const tree = buildRoutes(project.appDir, await walk(root, project.appDir, { warnings }), config.pageExtensions)
  const graph = createModuleGraph(root, project.paths, warnings)
  const owned = await readOwned(root, project.componentsDir)
  const proxy = await readProxy(root, project, warnings)

  const layouts = new Map()
  for (const segment of tree.segments.values()) {
    if (!segment.special.layout || isOwnRouteDir(segment.dir)) continue
    const mod = await graph.load(segment.special.layout)
    if (mod) layouts.set(segment.dir, { file: segment.special.layout, suspense: mod.suspense })
  }
  const layoutSuspense = new Map([...layouts].map(([dir, layout]) => [dir, layout.suspense.length > 0]))

  const routes = []
  for (const route of tree.routes) {
    if (isOwnRouteDir(route.dir)) continue
    const mod = await graph.load(route.page)
    const entry = {
      ...route,
      notFound: await graph.notFoundUse(route.page),
      suspense: mod?.suspense ?? [],
      awaitsData: mod?.awaitsData ?? false,
      generateStaticParams: mod?.generateStaticParams ?? false,
    }
    routes.push(predictRoute(entry, { config, segments: tree.segments, layoutSuspense, proxy }))
  }

  const findings = buildFindings({
    appDir: project.appDir,
    ext: project.typescript ? 'tsx' : 'jsx',
    componentsDir: project.componentsDir,
    typescript: project.typescript,
    config,
    segments: tree.segments,
    routes,
    owned,
    layouts,
    noRootLayout: tree.rootLayout === null,
  })
  return {
    schema: 1,
    generator: `fallback404-skill@${SKILL_VERSION}`,
    next: project.next,
    appDir: project.appDir,
    componentsDir: project.componentsDir,
    typescript: project.typescript,
    alias: project.alias,
    packageManager: project.packageManager,
    config,
    proxy,
    routes: routes.map((route) => ({
      route: route.route,
      dir: route.dir,
      page: route.page,
      dynamic: route.dynamic,
      notFound: route.notFound,
      generateStaticParams: route.generateStaticParams,
      notFoundFile: nearest(tree.segments, route.chain, 'not-found'),
      loadingFile: nearest(tree.segments, route.chain, 'loading'),
      errorFile: nearest(tree.segments, route.chain, 'error'),
      status404: route.status404,
      statusReason: route.statusReason,
    })),
    findings,
    owned: [...owned].map(([file, status]) => ({ file, status })),
    warnings,
  }
}

export async function main({ command, flags }) {
  if (command !== undefined) throw new CliError('bad_args', USAGE)
  const root = resolve(stringFlag(flags, 'root', '.'))
  if (flags.preflight) {
    const result = await preflight(root)
    if (!result.ok) throw new CliError('unsupported', result.problems.join(' '))
    const { next, appDir, typescript, packageManager } = result.project
    return { ok: true, next: next.version, appDir, typescript, packageManager, warnings: result.warnings }
  }
  const result = await scan(root)
  const out = resolve(root, stringFlag(flags, 'out', workspacePath(root, 'scan.json')))
  await writeJsonInside(root, out, result)
  await ensureExcluded(root)
  await setPhase(root, 'scan')
  if (flags.report) return renderReport(result)
  return { ok: true, out: relative(root, out), routes: result.routes.length, findings: result.findings.length, warnings: result.warnings }
}

if (isMain(import.meta.url)) process.exitCode = await runCli(main, process.argv.slice(2))
