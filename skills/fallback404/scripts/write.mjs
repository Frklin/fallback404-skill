#!/usr/bin/env node
// Fallback404 writer: the deterministic files (thin route wrappers for the picked flows, the root not-found router,
// the static 404 route the proxy checks rewrite to, the dev-only preview page), written only for flows with a final
// component and never over files it does not own. Every command holds .fallback404/write.lock, so parallel designer
// agents never interleave. `apply` is phase 5 in one command: clean --variants, wrappers, preview, manifest.
// Usage: node write.mjs wrappers [--dry-run] | preview | apply | clean --variants | clean --drafts [--root <dir>]
import { lstat, readdir, rm, writeFile } from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'
import { CliError, isMain, runCli, stringFlag } from './lib/cli.mjs'
import { firstLink, prepareWrite, readJsonIfExists, workspacePath, writeJsonInside } from './lib/fs.mjs'
import { COMPONENTS, ROOT_NOT_FOUND, rootNotFoundTarget, wrapperTarget } from './lib/flows.mjs'
import { git, isGitRepo } from './lib/git.mjs'
import { withLock } from './lib/lock.mjs'
import { readOwned } from './lib/owned.mjs'
import { atLeast } from './lib/project.mjs'
import { renderGate, renderRouter } from './lib/router.mjs'
import { writeManifest } from './manifest.mjs'
import { setPhase } from './state.mjs'

const USAGE = 'Usage: node write.mjs wrappers [--dry-run] | preview | apply | clean --variants | clean --drafts [--root <dir>]'

/** Import specifier for a file in the components folder, seen from `fromFile`: the alias when there is one, else relative. */
export function importSpecifier(scan, fromFile, rel) {
  const target = `${scan.componentsDir}/${rel}`
  if (scan.alias) return `${scan.alias}${scan.componentsDir.startsWith('src/') ? target.slice('src/'.length) : target}`
  const spec = posix.relative(posix.dirname(fromFile), target)
  return spec.startsWith('.') ? spec : `./${spec}`
}

/** The error prop Next.js passes to error.js and global-error.js: `retry` from 16.3, `reset` before. */
export const errorProp = (scan) => (atLeast(scan.next, 16, 3) ? 'retry' : 'reset')

function errorSignature(scan) {
  const prop = errorProp(scan)
  return scan.typescript ? `{ error, ${prop} }: { error: Error & { digest?: string }; ${prop}: () => void }` : `{ error, ${prop} }`
}

/** Source of one deterministic route file: router | not-found | loading | error | global-error | missing. */
export function renderWrapper(kind, file, scan, { slug = null, identity = null } = {}) {
  const spec = (rel) => importSpecifier(scan, file, rel)
  const flow = (name) => spec(`flows/${slug}/${name}`)
  const prop = errorProp(scan)
  switch (kind) {
    case 'router':
      return [`import { NotFoundRouter } from '${spec('NotFoundRouter')}'`, '', 'export default NotFoundRouter', ''].join('\n')
    case 'not-found':
      return [`import { NotFound } from '${flow('NotFound')}'`, '', 'export default NotFound', ''].join('\n')
    case 'loading':
      return [`import { Loader } from '${flow('Loader')}'`, '', 'export default function Loading() {', '  return <Loader />', '}', ''].join('\n')
    case 'error':
      return [
        `'use client'`,
        '',
        `import { ErrorState } from '${flow('ErrorState')}'`,
        '',
        `export default function Error(${errorSignature(scan)}) {`,
        `  return <ErrorState error={error} retry={${prop}} />`,
        '}',
        '',
      ].join('\n')
    case 'global-error': {
      const css = (identity?.css ?? []).map((cssFile) => {
        const rel = posix.relative(posix.dirname(file), cssFile)
        return `import '${rel.startsWith('.') ? rel : `./${rel}`}'`
      })
      const lang = typeof identity?.lang === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(identity.lang) ? identity.lang : 'en'
      return [
        `'use client'`,
        '',
        ...css,
        `import { GlobalErrorState } from '${flow('GlobalErrorState')}'`,
        '',
        `export default function GlobalError(${errorSignature(scan)}) {`,
        '  return (',
        `    <html lang="${lang}">`,
        '      <body>',
        `        <GlobalErrorState error={error} retry={${prop}} />`,
        '      </body>',
        '    </html>',
        '  )',
        '}',
        '',
      ].join('\n')
    }
    case 'missing': {
      const instant = scan.config.cacheComponents === true && atLeast(scan.next, 16, 3)
      return [
        `import { notFound } from 'next/navigation'`,
        '',
        '// Rewrite target of the Fallback404 proxy checks. notFound() runs at build time, so Next.js serves',
        `// this route as a static HTTP 404 (see ${scan.componentsDir}/manifest.json).`,
        ...(instant ? ['export const instant = false', ''] : []),
        'export default function Fallback404Missing() {',
        '  notFound()',
        '}',
        '',
      ].join('\n')
    }
    default:
      throw new CliError('internal', `Unknown file kind ${kind}.`)
  }
}

/** Flow folders that hold a final component (a picked option, promoted), by slug. */
export async function presentFlows(root, scan) {
  const ext = scan.typescript ? 'tsx' : 'jsx'
  const dir = join(root, scan.componentsDir, 'flows')
  const present = new Set()
  for (const slug of await readdir(dir).catch(() => [])) {
    for (const name of Object.values(COMPONENTS)) if (await existsAny(join(dir, slug, `${name}.${ext}`))) present.add(slug)
  }
  return present
}

/**
 * The deterministic route files, once each, sorted: a wrapper for every planned flow whose folder holds a final
 * component (a flow that kept the current page has none, so the site's file stays), the root router when the root
 * design exists, and the rewrite target of every approved proxy fix.
 */
export function plannedWrites(scan, plan, present) {
  const findings = new Map((scan.findings ?? []).map((finding) => [finding.id, finding]))
  const approved = new Set(plan.approved ?? [])
  const writes = []
  for (const flow of plan.flows ?? []) {
    if (!present.has(flow.slug)) continue
    const target = wrapperTarget(findings.get(flow.rowId))
    if (target && target.kind !== 'router') writes.push({ file: target.file, kind: target.kind, slug: flow.slug, ...(target.replace ? { replace: true } : {}) })
  }
  if (present.has(ROOT_NOT_FOUND)) {
    const rootFlow = (plan.flows ?? []).find((flow) => flow.slug === ROOT_NOT_FOUND)
    // A root design without a root flow was moved from the site's own page (approved in changes.md): replace that page.
    const target = (rootFlow && wrapperTarget(findings.get(rootFlow.rowId))) || rootNotFoundTarget(scan)
    writes.push({ file: target.file, kind: 'router', ...(target.replace ? { replace: true } : {}) })
  }
  for (const finding of scan.findings ?? []) {
    if (!approved.has(finding.id) || finding.proposal?.type !== 'proxy') continue
    const missing = finding.proposal.files?.find((file) => file.startsWith(`${scan.appDir}/fallback404-missing/`))
    if (missing) writes.push({ file: missing, kind: 'missing' })
  }
  return [...new Map(writes.map((write) => [write.file, write])).values()].sort((a, b) => (a.file < b.file ? -1 : 1))
}

/** What the route files cannot show: section designs without a root design, so no router. */
function flowWarnings(plan, present) {
  const sections = (plan.flows ?? []).filter((flow) => flow.state === 'not-found' && flow.route !== '/' && present.has(flow.slug)).map((flow) => flow.slug)
  if (sections.length === 0 || present.has(ROOT_NOT_FOUND)) return []
  return [
    `The section designs ${sections.join(', ')} are not shown: the root not-found page is the site's own, so no router is written. Propose moving it into flows/${ROOT_NOT_FOUND}/ in changes.md, or tell the user these sections show the site's root 404.`,
  ]
}

async function existsAny(path) {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function ownedFiles(root, scan) {
  const listed = (await readJsonIfExists(workspacePath(root, 'owned.json')))?.files ?? []
  const fromManifest = [...(await readOwned(root, scan.componentsDir))].filter(([, status]) => status === 'unchanged').map(([file]) => file)
  return new Set([...listed, ...fromManifest])
}

/** Writes new files, Fallback404's own earlier files and approved replacements; never through symlinks. Records owned.json. */
export async function writeOwned(root, scan, writes) {
  const ownedFile = workspacePath(root, 'owned.json')
  await prepareWrite(root, ownedFile)
  const owned = await ownedFiles(root, scan)
  const written = []
  const skipped = []
  for (const { file, content, replace = false } of writes) {
    const info = await lstat(join(root, file)).catch(() => null)
    if (info && !info.isSymbolicLink() && !owned.has(file) && !replace) {
      skipped.push({ file, reason: 'exists and is not a Fallback404 file; list it in "replace" in .fallback404/plan.json once the user approves replacing it' })
      continue
    }
    let target
    try {
      target = await prepareWrite(root, file)
    } catch (error) {
      if (error.code !== 'unsafe_path') throw error
      skipped.push({ file, reason: error.message })
      continue
    }
    await writeFile(target, content)
    written.push(file)
  }
  const listed = (await readJsonIfExists(ownedFile))?.files ?? []
  await writeJsonInside(root, ownedFile, { files: [...new Set([...listed, ...written])].sort() })
  return { written, skipped }
}

/** An import path from one route file to another file of the app, without its extension. */
function relativeImport(fromFile, toFile) {
  const spec = posix.relative(posix.dirname(fromFile), toFile).replace(/\.[jt]sx?$/, '')
  return spec.startsWith('.') ? spec : `./${spec}`
}

/**
 * What the preview gallery shows: each flow folder's final component and numbered variants, then the site's own file
 * of every planned flow that exists today (the "current" option), unless Fallback404 owns that file by now.
 */
export async function previewEntries(root, scan, plan = {}, owned = new Set()) {
  const ext = scan.typescript ? 'tsx' : 'jsx'
  const flowsDir = join(root, scan.componentsDir, 'flows')
  const entries = []
  for (const slug of (await readdir(flowsDir).catch(() => [])).sort()) {
    const variantFiles = await readdir(join(flowsDir, slug, 'variants')).catch(() => [])
    for (const [state, name] of Object.entries(COMPONENTS)) {
      if (await existsAny(join(flowsDir, slug, `${name}.${ext}`))) entries.push({ flow: slug, state, variant: null, rel: `flows/${slug}/${name}` })
      const pattern = new RegExp(`^${name}\\.v(\\d+)\\.${ext}$`)
      const numbers = variantFiles.map((file) => pattern.exec(file)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b)
      for (const k of numbers) entries.push({ flow: slug, state, variant: String(k), rel: `flows/${slug}/variants/${name}.v${k}` })
    }
  }
  for (const flow of plan.flows ?? []) {
    // global-error renders its own <html>, so it cannot sit inside the gallery page.
    if (flow.status !== 'exists' || flow.state === 'global-error' || !flow.file || owned.has(flow.file)) continue
    if (await existsAny(join(root, flow.file))) entries.push({ flow: flow.slug, state: flow.state, variant: 'current', file: flow.file })
  }
  return entries
}

const isClientState = (entry) => entry.state === 'error' || entry.state === 'global-error'

/** The dev-only gallery: one entry per flow component, variant and current page. A static 404 in production. */
export function renderPreview(scan, file, entries) {
  const ts = scan.typescript
  const spec = (rel) => importSpecifier(scan, file, rel)
  const imports = [`import { notFound } from 'next/navigation'`, `import { Suspense } from 'react'`, ...(ts ? [`import type { ReactNode } from 'react'`] : [])]
  const items = []
  const clients = []
  entries.forEach((entry, index) => {
    const name = `Entry${index}`
    const key = `flow: '${entry.flow}', variant: ${entry.variant === null ? 'null' : `'${entry.variant}'`}`
    if (isClientState(entry)) {
      clients.push(name)
    } else if (entry.file) {
      imports.push(`import ${name} from '${relativeImport(file, entry.file)}'`)
    } else {
      imports.push(`import { ${COMPONENTS[entry.state]} as ${name} } from '${spec(entry.rel)}'`)
    }
    items.push(`  { ${key}, inline: false, render: () => <${name} /> },`)
    if (entry.state === 'loading' && !entry.file) items.push(`  { ${key}, inline: true, render: () => <${name} inline /> },`)
  })
  if (clients.length > 0) imports.push(`import { ${clients.join(', ')} } from './client'`)
  const props = ts ? ': { searchParams: SearchParams }' : ''
  return [
    ...imports,
    '',
    '// Dev-only gallery, screenshotted by the Skill. Generated by write.mjs; do not edit. /fallback404-preview holds the',
    '// final design of every flow (?flow=<slug>&solo=1); /fallback404-preview/<slug> holds one flow with its drafts:',
    '// ?variant=<k>&solo=1 a variant, ?variant=current&solo=1 the site\'s own page, &inline=1 the inline loader.',
    '// In production notFound() runs at build time, so every page here is a static HTTP 404.',
    ...(ts ? ['type SearchParams = Promise<Record<string, string | string[] | undefined>>', 'type Entry = { flow: string; variant: string | null; inline: boolean; render: () => ReactNode }'] : []),
    '',
    `const ENTRIES${ts ? ': Entry[]' : ''} = [`,
    ...items,
    ']',
    '',
    `export default function Fallback404Preview({ searchParams }${props}) {`,
    "  if (process.env.NODE_ENV === 'production') notFound()",
    '  return (',
    '    <Suspense fallback={null}>',
    '      <Gallery searchParams={searchParams} />',
    '    </Suspense>',
    '  )',
    '}',
    '',
    `async function Gallery({ searchParams }${props}) {`,
    '  const query = await searchParams',
    `  const pick = (name${ts ? ': string' : ''}) => (typeof query[name] === 'string' ? query[name] : null)`,
    "  const flow = pick('flow')",
    "  const variant = pick('variant')",
    "  const inline = pick('inline') === '1'",
    '  const inFlow = ENTRIES.filter((entry) => flow === null || entry.flow === flow)',
    "  if (query.solo === '1') {",
    '    const solo = inFlow.find((entry) => entry.variant === variant && entry.inline === inline)',
    '    if (solo) return <div data-fallback404-flow={solo.flow}>{solo.render()}</div>',
    '  }',
    '  const shown = inFlow',
    '  return (',
    "    <div style={{ display: 'grid', gap: '3rem', padding: '2rem 0' }}>",
    '      {shown.map((entry) => (',
    "        <section key={`${entry.flow}-${entry.variant ?? 'final'}-${entry.inline}`} data-fallback404-flow={entry.flow}>",
    "          <p style={{ margin: '0 1.5rem', font: '600 0.75rem/1.5 system-ui, sans-serif', letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.6 }}>",
    "            {[entry.flow, entry.variant === 'current' ? 'current page' : entry.variant ? `variant ${entry.variant}` : null, entry.inline ? 'inline' : null].filter(Boolean).join(' · ')}",
    '          </p>',
    '          {entry.render()}',
    '        </section>',
    '      ))}',
    '    </div>',
    '  )',
    '}',
    '',
  ].join('\n')
}

/** Client wrappers, so the gallery can render error states (Fallback404's and the site's own) with a sample error. */
export function renderPreviewClient(scan, file, entries) {
  const spec = (rel) => importSpecifier(scan, file, rel)
  const prop = errorProp(scan)
  const imports = []
  const bodies = []
  entries.forEach((entry, index) => {
    if (!isClientState(entry)) return
    if (entry.file) {
      imports.push(`import Site${index} from '${relativeImport(file, entry.file)}'`)
      bodies.push('', `export function Entry${index}() {`, `  return <Site${index} error={previewError} ${prop}={() => {}} />`, '}')
    } else {
      imports.push(`import { ${COMPONENTS[entry.state]} as Flow${index} } from '${spec(entry.rel)}'`)
      bodies.push('', `export function Entry${index}() {`, `  return <Flow${index} error={previewError} retry={() => {}} />`, '}')
    }
  })
  return [
    `'use client'`,
    '',
    ...imports,
    '',
    '// Client wrappers so the preview page can render error states with a sample error. Generated by write.mjs.',
    "const previewError = Object.assign(new Error('Fallback404 preview'), { digest: 'fallback404-preview' })",
    ...bodies,
    '',
  ].join('\n')
}

/** A gallery page and, when it shows error states, its client wrappers. */
function galleryWrites(scan, dir, entries) {
  const ext = scan.typescript ? 'tsx' : 'jsx'
  const page = `${dir}/page.${ext}`
  const client = `${dir}/client.${ext}`
  const writes = [{ file: page, content: renderPreview(scan, page, entries) }]
  if (entries.some(isClientState)) writes.push({ file: client, content: renderPreviewClient(scan, client, entries) })
  return writes
}

/**
 * The index (every flow's final design) and one page per flow with its drafts. Next.js compiles a page when it is
 * visited, so a draft that does not compile breaks only its own flow's page, never another designer's screenshots.
 */
async function previewCommand(root, scan) {
  const dir = `${scan.appDir}/fallback404-preview`
  const plan = (await readJsonIfExists(workspacePath(root, 'plan.json'))) ?? {}
  const owned = await ownedFiles(root, scan)
  const entries = await previewEntries(root, scan, plan, owned)
  const flows = [...new Set(entries.map((entry) => entry.flow))].sort()
  const writes = [
    ...galleryWrites(scan, dir, entries.filter((entry) => entry.variant === null)),
    ...flows.flatMap((flow) => galleryWrites(scan, `${dir}/${flow}`, entries.filter((entry) => entry.flow === flow))),
  ]
  const result = await writeOwned(root, scan, writes)
  // A flow whose folder is gone leaves a page that imports nothing: remove the pages Fallback404 wrote for it.
  const stale = (await readdir(join(root, dir), { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && !flows.includes(entry.name))
    .map((entry) => `${dir}/${entry.name}`)
    .filter((sub) => [...owned].some((file) => file.startsWith(`${sub}/`)))
  for (const sub of stale) await removeDir(root, sub)
  if (stale.length > 0) {
    const ownedFile = workspacePath(root, 'owned.json')
    const listed = (await readJsonIfExists(ownedFile))?.files ?? []
    await writeJsonInside(root, ownedFile, { files: listed.filter((file) => !stale.some((sub) => file.startsWith(`${sub}/`))) })
  }
  return { ...result, entries: entries.map(({ flow, state, variant }) => ({ flow, state, variant })) }
}

/** config.basePath when it is a literal path; scan.json says "unknown" when next.config computes it. */
const literalBasePath = (scan) => (typeof scan.config?.basePath === 'string' && scan.config.basePath.startsWith('/') ? scan.config.basePath : '')

/**
 * The app's basePath: config.basePath when the scan could read it, else the one coverage.mjs was given (--base-path,
 * when next.config computes it), which coverage/rows.json keeps.
 */
export async function appBasePath(root, scan) {
  const literal = literalBasePath(scan)
  if (literal !== '') return literal
  const rows = await readJsonIfExists(workspacePath(root, 'coverage/rows.json'))
  return typeof rows?.basePath === 'string' && rows.basePath.startsWith('/') ? rows.basePath : ''
}

/** The router and its gate, when the root design exists: every section with a design is listed. */
function routerWrites(scan, plan, present, basePath) {
  if (!present.has(ROOT_NOT_FOUND)) return []
  const ext = scan.typescript ? 'tsx' : 'jsx'
  const routerFile = `${scan.componentsDir}/NotFoundRouter.${ext}`
  const gateFile = `${scan.componentsDir}/NotFoundGate.${ext}`
  const sections = (plan.flows ?? []).filter((flow) => flow.state === 'not-found' && flow.route !== '/' && present.has(flow.slug)).map(({ slug, route }) => ({ slug, route }))
  return [
    { file: gateFile, kind: 'generated', content: renderGate({ typescript: scan.typescript, basePath }) },
    { file: routerFile, kind: 'generated', content: renderRouter({ typescript: scan.typescript, root: ROOT_NOT_FOUND, sections, basePath, spec: (rel) => importSpecifier(scan, routerFile, rel) }) },
  ]
}

async function wrappersCommand(root, scan, flags) {
  const plan = await readJsonIfExists(workspacePath(root, 'plan.json'))
  if (!plan) throw new CliError('no_plan', 'Run coverage.mjs apply first: .fallback404/plan.json is missing.')
  const identity = await readJsonIfExists(workspacePath(root, 'identity.json'))
  const present = await presentFlows(root, scan)
  const planned = plannedWrites(scan, plan, present)
  const generated = routerWrites(scan, plan, present, await appBasePath(root, scan))
  const warnings = flowWarnings(plan, present)
  if (flags['dry-run']) {
    const owned = await ownedFiles(root, scan)
    const listed = []
    for (const write of planned) {
      const replace = write.replace === true
      // blocked: the site has this file and nobody approved replacing it; writing would skip it.
      listed.push({ file: write.file, kind: write.kind, replace, blocked: !replace && !owned.has(write.file) && (await existsAny(join(root, write.file))) })
    }
    for (const { file } of generated) listed.push({ file, kind: 'generated', replace: false, blocked: false })
    await setPhase(root, 'review')
    return { planned: listed, warnings }
  }
  const writes = planned.map((write) => ({ ...write, content: renderWrapper(write.kind, write.file, scan, { slug: write.slug, identity }) }))
  return { ...(await writeOwned(root, scan, [...writes, ...generated])), warnings }
}

/** Removes a folder Fallback404 drafted, never through a link. True when it was there. */
async function removeDir(root, rel) {
  if ((await firstLink(root, rel)) !== null) return false
  const info = await lstat(join(root, rel)).catch(() => null)
  if (!info?.isDirectory()) return false
  await rm(join(root, rel), { recursive: true })
  return true
}

const isTracked = async (root, rel) => (await isGitRepo(root)) && (await git(root, ['ls-files', '--', rel])).trim() !== ''

async function cleanCommand(root, scan, flags) {
  const removed = []
  const flowsDir = `${scan.componentsDir}/flows`
  if (flags.variants) {
    for (const slug of (await readdir(join(root, flowsDir)).catch(() => [])).sort()) {
      if (await removeDir(root, `${flowsDir}/${slug}/variants`)) removed.push(`${flowsDir}/${slug}/variants`)
    }
    return { removed }
  }
  if (flags.drafts) {
    // The person said no at the review: remove what this run drafted; anything git already tracks stays.
    const plan = (await readJsonIfExists(workspacePath(root, 'plan.json'))) ?? {}
    for (const flow of plan.flows ?? []) {
      const rel = `${flowsDir}/${flow.slug}`
      if (!(await isTracked(root, rel))) {
        if (await removeDir(root, rel)) removed.push(rel)
      } else if (await removeDir(root, `${rel}/variants`)) removed.push(`${rel}/variants`)
    }
    const preview = `${scan.appDir}/fallback404-preview`
    if (!(await isTracked(root, preview)) && (await removeDir(root, preview))) {
      removed.push(preview)
      const ownedFile = workspacePath(root, 'owned.json')
      await prepareWrite(root, ownedFile)
      const listed = (await readJsonIfExists(ownedFile))?.files ?? []
      await writeJsonInside(root, ownedFile, { files: listed.filter((file) => !file.startsWith(`${preview}/`)) })
    }
    return { removed: removed.sort() }
  }
  throw new CliError('bad_args', USAGE)
}

/** Phase 5: the picked flows become route files, the gallery is rebuilt, the manifest records what this run owns. */
async function applyCommand(root, scan) {
  const { removed } = await cleanCommand(root, scan, { variants: true })
  const wrappers = await wrappersCommand(root, scan, {})
  const preview = await previewCommand(root, scan)
  const manifest = await writeManifest(root)
  await setPhase(root, 'write')
  return { removed, written: [...wrappers.written, ...preview.written], skipped: [...wrappers.skipped, ...preview.skipped], warnings: wrappers.warnings, entries: preview.entries, manifest: manifest.written }
}

export async function main({ command, flags }) {
  const root = resolve(stringFlag(flags, 'root', '.'))
  const scan = await readJsonIfExists(workspacePath(root, 'scan.json'))
  if (!scan) throw new CliError('no_scan', 'Run scan.mjs first: .fallback404/scan.json is missing.')
  if (!['wrappers', 'preview', 'apply', 'clean'].includes(command)) throw new CliError('bad_args', USAGE)
  return withLock(root, 'write', async () => {
    if (command === 'wrappers') return wrappersCommand(root, scan, flags)
    if (command === 'apply') return applyCommand(root, scan)
    if (command === 'clean') return cleanCommand(root, scan, flags)
    return previewCommand(root, scan)
  })
}

if (isMain(import.meta.url)) process.exitCode = await runCli(main, process.argv.slice(2))
