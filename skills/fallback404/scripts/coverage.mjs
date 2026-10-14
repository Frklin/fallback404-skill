#!/usr/bin/env node
// Fallback404 coverage: turns the scan into the rows of the picker's coverage step (every 404, loading and error flow,
// with a choice per row), measures what visitors see today at made-up URLs, and turns the choices into plan.json flows:
// one design step per made row. `run` does the whole coverage phase in one command: browser probe, identity (brand kit
// and shared CSS), dev server, rows, screenshots, manifest, site pack, then the picker session and the coverage step.
// Usage: node coverage.mjs run [--drop F3,F7] [--base-path <path>] [--no-browser] [--no-picker]
//      | rows [--drop F3,F7] [--base-url <url>] [--base-path <path>] | manifest | apply <decision.json> [--root <dir>]
import { randomBytes } from 'node:crypto'
import { join, posix, resolve } from 'node:path'
import { start as startDev, stop as stopDev } from './devserver.mjs'
import { main as identityMain } from './identity.mjs'
import { probeBrowser, runShoot } from './lib/browser.mjs'
import { CliError, isMain, runCli, stringFlag } from './lib/cli.mjs'
import { flowKind, stepTitle, uniqueSlugs } from './lib/flows.mjs'
import { exists, prepareWrite, readJson, readJsonIfExists, workspacePath, writeJsonInside, writeTextInside } from './lib/fs.mjs'
import { create as pickerCreate, defaultContext as pickerContext, plan as pickerPlan, propose as pickerPropose } from './picker.mjs'
import { buildSitePack } from './sitepack.mjs'
import { setPhase, update as updateState } from './state.mjs'

const USAGE =
  'Usage: node coverage.mjs run [--drop F3,F7] [--base-path <path>] [--no-browser] [--no-picker] | rows [--drop F3,F7] [--base-url <url>] [--base-path <path>] | manifest | apply <decision.json> [--root <dir>]'
export const MAX_ROWS = 40
export const STEP_DIR = '.fallback404/steps/coverage-r1'
const ROWS_FILE = 'coverage/rows.json'
const PLAN_FILE = 'coverage/shoot-plan.json'

const choice = (value, label) => ({ value, label })
const CREATE = [choice('create', 'Create'), choice('skip', 'Skip')]
const KEEP = [choice('keep', 'Keep'), choice('redesign', 'Redesign')]
const FIX = [choice('fix', 'Fix'), choice('leave', 'Leave')]
const USE_LOADER = [choice('create', 'Use new loader'), choice('leave', 'Leave')]
const FALLBACK_WORDS = { none: 'missing', null: 'empty', text: 'plain-text' }

export const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** The coverage row for one finding, or null for findings that are not rows (unsupported ones go in the prompt). */
export function rowFor(finding) {
  const row = (state, status, detail, choices, file = null) => ({
    rowId: finding.id,
    route: finding.route ?? '/',
    state,
    status,
    detail: detail === null ? null : clip(detail, 160),
    measuredStatus: null,
    choices,
    defaultChoice: choices[0]?.value ?? null,
    // Every row the person can make is one design step: its flow.
    steps: choices.length > 0 ? [flowKind(finding.id)] : [],
    file,
  })
  const target = finding.proposal?.files?.[0]
  switch (finding.kind) {
    case 'missing-root-not-found':
      return row('not-found', 'missing', `No ${target}: unknown URLs get Next.js's plain 404.`, CREATE)
    case 'missing-error':
      return row('error', 'missing', `No ${target}: a crash shows Next.js's default error screen.`, CREATE)
    case 'missing-global-error':
      return row('global-error', 'missing', `No ${target}: a crash in the root layout shows a blank page.`, CREATE)
    case 'soft-404':
      return row('not-found', 'soft', finding.reason ?? 'A missing record answers HTTP 200.', FIX)
    case 'no-notfound-candidate':
      return row('not-found', 'soft', 'Never calls notFound(): a missing record still renders this page.', FIX)
    case 'missing-loading':
      return finding.proposal?.type === 'write'
        ? row('loading', 'missing', 'No loading state while data loads.', CREATE)
        : row('loading', 'info', finding.proposal?.reason ?? null, [])
    case 'weak-suspense-fallback': {
      const word = FALLBACK_WORDS[finding.fallback] ?? 'weak'
      return row('loading', 'weak', `${finding.file}:${finding.line} has ${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word} Suspense fallback.`, USE_LOADER)
    }
    case 'existing-state':
      return row(finding.state, 'exists', finding.file, KEEP, finding.file)
    default:
      return null
  }
}

const idNumber = (row) => Number(row.rowId.replace(/^\D+/, '')) || 0

/** Rows for the coverage step: root first, then by route and finding order; at most 40, the rest listed in `overflow`. */
export function buildRows(scan, { drop = [] }) {
  const dropped = new Set(drop)
  const rows = scan.findings
    .filter((finding) => !dropped.has(finding.id))
    .map((finding) => rowFor(finding))
    .filter(Boolean)
    .sort((a, b) => (a.route === '/' ? 0 : 1) - (b.route === '/' ? 0 : 1) || (a.route < b.route ? -1 : a.route > b.route ? 1 : 0) || idNumber(a) - idNumber(b))
  return {
    rows: rows.slice(0, MAX_ROWS),
    overflow: rows.slice(MAX_ROWS).map((row) => row.rowId),
    unsupported: scan.findings.filter((finding) => finding.kind === 'unsupported' && !dropped.has(finding.id)).map((finding) => finding.reason),
  }
}

/** A URL in the route's section that no record can match: each dynamic segment becomes one made-up segment. */
export function madeUpPath(route, token) {
  if (route === '/') return `/fallback404-check-${token}`
  return `/${route
    .split('/')
    .filter(Boolean)
    .map((part) => (/^\[.+\]$/.test(part) ? `fallback404-${token}` : part))
    .join('/')}`
}

/** Rows whose current page we measure and screenshot: the root 404 and the sections that answer 200 today. */
export const isShootable = (row) => row.state === 'not-found' && (row.route === '/' || row.status === 'soft')

export const shotName = (row, token) => `row-${row.rowId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${token}`

/** A shoot.mjs plan: one status check and one light screenshot per shootable row. */
export function coverageShootPlan(rows, { baseUrl, basePath, token }) {
  const shootable = rows.filter(isShootable)
  return {
    baseUrl,
    basePath,
    out: STEP_DIR,
    darkMode: { strategy: 'media' },
    checks: shootable.map((row) => ({ path: madeUpPath(row.route, token), expectStatus: null })),
    shots: shootable.map((row) => ({ path: madeUpPath(row.route, token), name: shotName(row, token), themes: ['light'] })),
  }
}

async function readScan(root) {
  const scan = await readJsonIfExists(workspacePath(root, 'scan.json'))
  if (!scan) throw new CliError('no_scan', 'Run scan.mjs first: .fallback404/scan.json is missing.')
  return scan
}

async function rowsCommand(root, flags) {
  const scan = await readScan(root)
  const drop = stringFlag(flags, 'drop', '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  const unknown = drop.filter((id) => !scan.findings.some((finding) => finding.id === id))
  if (unknown.length > 0) throw new CliError('bad_args', `No finding ${unknown.join(', ')} in scan.json.`)
  const { rows, overflow, unsupported } = buildRows(scan, { drop })
  const token = randomBytes(4).toString('hex')
  // scan.json says "unknown" when next.config computes basePath: never put that in a URL.
  const configured = stringFlag(flags, 'base-path', null) ?? scan.config?.basePath ?? ''
  const literal = typeof configured === 'string' && (configured === '' || configured.startsWith('/'))
  const basePath = literal ? configured.replace(/\/+$/, '') : ''
  const warnings = literal
    ? []
    : ['next.config computes its basePath, so Fallback404 could not read it and the made-up URLs assume none. If the app has one, run coverage.mjs rows again with --base-path <path>.']
  await writeJsonInside(root, workspacePath(root, ROWS_FILE), { schema: 1, token, basePath, rows, overflow, unsupported })
  const baseUrl = stringFlag(flags, 'base-url', null)
  if (baseUrl) await writeJsonInside(root, workspacePath(root, PLAN_FILE), coverageShootPlan(rows, { baseUrl, basePath, token }))
  return { rows: rows.length, shootable: rows.filter(isShootable).length, overflow, shootPlan: baseUrl ? `.fallback404/${PLAN_FILE}` : null, warnings }
}

const TITLE = 'Choose what to create'
const PROMPT = 'Every 404, loading and error state Fallback404 found in your app. Choose what to create; everything else stays as it is.'
const MAKE = new Set(['create', 'redesign', 'fix'])

/** The coverage manifest picker.mjs proposes: rows with what was measured today, never local-only fields. */
export function buildManifest({ token, basePath = '', rows, unsupported = [] }, report) {
  return {
    type: 'coverage',
    kind: 'coverage',
    title: TITLE,
    prompt: clip([...unsupported, PROMPT].join(' '), 280),
    rows: rows.map((local) => {
      // `file` is local only: it lets apply list redesigned files in plan.json.
      const row = Object.fromEntries(Object.entries(local).filter(([key]) => key !== 'file'))
      if (!report || !isShootable(row)) return row
      const path = `${basePath}${madeUpPath(row.route, token)}`
      const check = report.checks.find((entry) => entry.path === path)
      // A page that crashed (5xx, or an error in the browser) may show code or a stack trace: measure it, never upload it.
      const crashed = (entry) => (check?.status ?? 0) >= 500 || (entry.status ?? 0) >= 500 || (entry.pageErrors ?? []).length > 0
      const shot = report.shots.find((entry) => entry.name === shotName(row, token) && entry.bytes > 0 && !crashed(entry))
      return { ...row, measuredStatus: check?.status ?? null, ...(shot ? { screenshot: posix.basename(shot.file) } : {}) }
    }),
  }
}

/** plan.json from the person's choices: every made row is a flow, and a fixed section brings the root 404 along. */
export function applySelection(rows, decision) {
  if (decision?.status !== 'picked' || !decision.selection?.rows) {
    throw new CliError('no_selection', 'This file holds no coverage decision. Run picker.mjs wait --step <id> --out <file> until it prints "picked".')
  }
  const chosen = decision.selection.rows
  const makes = (row) => MAKE.has(chosen[row.rowId]) && row.steps.length > 0
  const root = rows.find((row) => row.state === 'not-found' && row.route === '/')
  const sectionFixed = rows.some((row) => row.state === 'not-found' && row.route !== '/' && makes(row))
  // The router that shows section designs lives in the root not-found page, so a missing one is made too.
  const rootAdded = root !== undefined && root.status === 'missing' && !makes(root) && sectionFixed
  const made = rows.filter((row) => makes(row) || (rootAdded && row === root))
  const slugs = uniqueSlugs(made)
  return {
    plan: {
      schema: 2,
      approved: made.map((row) => row.rowId),
      flows: made.map((row, index) => ({ kind: row.steps[0], rowId: row.rowId, slug: slugs[index], route: row.route, state: row.state, status: row.status, file: row.file ?? null })),
      userFiles: [],
    },
    rootAdded,
  }
}

async function readRows(root) {
  const data = await readJsonIfExists(workspacePath(root, ROWS_FILE))
  if (!data) throw new CliError('no_rows', 'Run coverage.mjs rows first: .fallback404/coverage/rows.json is missing.')
  return data
}

/** Writes the coverage manifest from rows.json and the shoot report (given, or read from the step folder). */
async function manifestCommand(root, given) {
  const data = await readRows(root)
  const report = given === undefined ? await readJsonIfExists(resolve(root, STEP_DIR, 'report.json')) : given
  const manifest = buildManifest(data, report?.skipped === false ? report : null)
  await writeJsonInside(root, resolve(root, STEP_DIR, 'manifest.json'), manifest)
  return {
    manifest: `${STEP_DIR}/manifest.json`,
    rows: manifest.rows.length,
    measured: manifest.rows.filter((row) => row.measuredStatus !== null).length,
    screenshots: manifest.rows.filter((row) => row.screenshot).length,
  }
}

const pickerCtx = (root) => ({ ...pickerContext(), sessionFile: workspacePath(root, 'session.json') })

/** plan.json from the coverage decision, then the picker's progress chips (one per flow) when a session is open. */
export async function applyCoverage(root, decisionFile, { setPlan = (kinds) => pickerPlan(pickerCtx(root), { kinds }) } = {}) {
  const { rows } = await readRows(root)
  const { plan, rootAdded } = applySelection(rows, await readJson(decisionFile))
  const existing = await readJsonIfExists(workspacePath(root, 'plan.json'))
  if (Array.isArray(existing?.userFiles)) plan.userFiles = existing.userFiles
  await writeJsonInside(root, workspacePath(root, 'plan.json'), plan)
  const warnings = []
  let pickerPlanSet = false
  if (plan.flows.length > 0 && (await exists(root, '.fallback404/session.json'))) {
    // The chips are a courtesy: plan.json is written, so a picker blip must not hide the flows from the model.
    try {
      await setPlan(plan.flows.map((flow) => flow.kind).join(','))
      pickerPlanSet = true
    } catch (error) {
      warnings.push(`The picker's progress chips were not set (${error.message}); the steps still work.`)
    }
  }
  return {
    flows: plan.flows.map(({ kind, slug, route, state, status }) => ({ kind, slug, title: stepTitle(route, state), route, state, status })),
    approved: plan.approved,
    rootAdded,
    pickerPlan: pickerPlanSet,
    warnings,
  }
}

async function applyCommand(root, positionals) {
  if (!positionals[0]) throw new CliError('bad_args', USAGE)
  return applyCoverage(root, resolve(positionals[0]))
}

/**
 * The coverage phase in one command. `deps` lets tests run it without a browser, a dev server or the network:
 * probe(root), shoot(root, planFile), startDev(root), stopDev(root), identity(args), picker.create / picker.propose.
 */
export async function runCoverage(root, flags, deps = {}) {
  const { probe = probeBrowser, shoot = runShoot, startDev: devStart = startDev, stopDev: devStop = stopDev, identity = identityMain } = deps
  const picker = deps.picker ?? { create: pickerCreate, propose: pickerPropose }
  const warnings = []
  const noBrowser = flags['no-browser'] === true
  if (!noBrowser) {
    const found = await probe(root)
    if (!found.browser) return { needsBrowser: true, reason: found.reason, install: found.install ?? null, hint: found.hint ?? null }
  }
  const kit = await identity({ command: undefined, positionals: [], flags: { root, write: true } })
  let devServer = null
  if (!noBrowser) {
    try {
      const started = await devStart(root)
      devServer = { url: started.url, reused: started.reused === true }
    } catch (error) {
      if (!(error instanceof CliError) || !['dev_failed', 'dev_timeout'].includes(error.code)) throw error
      warnings.push(`${error.message} The coverage page opens without screenshots.`)
    }
  }
  const rows = await rowsCommand(root, { ...flags, ...(devServer ? { 'base-url': devServer.url } : {}) })
  warnings.push(...rows.warnings)
  let report = null
  if (rows.shootPlan && rows.shootable > 0) {
    await prepareWrite(root, workspacePath(root, 'steps/coverage-r1/manifest.json'))
    try {
      report = await shoot(root, join(root, rows.shootPlan))
      if (report.skipped) warnings.push(`Screenshots skipped (${report.reason}).${report.install ? ` Install: ${report.install}` : ''}`)
    } catch (error) {
      warnings.push(`Screenshots failed: ${error.message}`)
    }
  }
  const manifest = await manifestCommand(root, report)
  const pack = await buildSitePack(root)
  await writeTextInside(root, workspacePath(root, 'sitepack.md'), pack.text)
  await setPhase(root, 'coverage')
  const result = {
    rows: rows.rows,
    shootable: rows.shootable,
    screenshots: manifest.screenshots,
    overflow: rows.overflow,
    warnings,
    devServer,
    sitepack: { bytes: pack.bytes, cut: pack.sections.filter((section) => section.cut).map((section) => section.name) },
    brandKit: { adjusted: kit.adjusted ?? [] },
    manifest: manifest.manifest,
  }
  if (rows.rows === 0) {
    if (devServer && !devServer.reused) await devStop(root)
    return result
  }
  if (flags['no-picker'] === true) return result
  const identityData = await readJsonIfExists(workspacePath(root, 'identity.json'))
  const created = await picker.create(pickerCtx(root), { project: identityData?.name ?? 'Your site', plan: 'coverage', open: true })
  const proposed = await picker.propose(pickerCtx(root), [join(root, manifest.manifest)])
  await updateState(root, (state) => {
    state.steps = [...state.steps.filter((step) => step.id !== proposed.stepId), { kind: 'coverage', id: proposed.stepId, round: proposed.round ?? 1, dir: STEP_DIR }]
  })
  return { ...result, pickerUrl: created.pickerUrl, opened: created.opened === true, stepId: proposed.stepId }
}

export async function main({ command, positionals, flags }) {
  const root = resolve(stringFlag(flags, 'root', '.'))
  if (command === 'run') return runCoverage(root, flags)
  if (command === 'rows') return rowsCommand(root, flags)
  if (command === 'manifest') return manifestCommand(root)
  if (command === 'apply') return applyCommand(root, positionals)
  throw new CliError('bad_args', USAGE)
}

if (isMain(import.meta.url)) process.exitCode = await runCli(main, process.argv.slice(2))
