#!/usr/bin/env node
// Fallback404 shoot: HTTP status checks and light/dark screenshots in a real browser. Run it through npx so Playwright
// never lands in the user's project:
//   npx --yes --no-update-notifier -p playwright@1.64.0 node shoot.mjs <plan.json> [--status-only] [--root <dir>]
// Without Playwright or a browser it reports { skipped: true } and exits 0; --status-only needs neither.
// A check may set "hydrate": false (the framework's scripts are blocked) or "javaScript": false, to see the first paint.
import { readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CliError, isMain, runCli, stringFlag } from './lib/cli.mjs'
import { prepareWrite, readJson, writeJsonInside } from './lib/fs.mjs'

export const PLAYWRIGHT_VERSION = '1.64.0'
export const SHOOT_COMMAND = `npx --yes --no-update-notifier -p playwright@${PLAYWRIGHT_VERSION} node`
const NAME = /^[a-z0-9][a-z0-9-]*$/
const THEMES = ['light', 'dark']
const USAGE = `Usage: ${SHOOT_COMMAND} shoot.mjs <plan.json> [--status-only] [--root <dir>]`

/** The playwright package npx installed: npx puts <install>/node_modules/.bin on PATH, and the package sits next to it. */
export function findPlaywright(env = process.env) {
  for (const bin of (env.PATH ?? '').split(delimiter)) {
    if (basename(bin) !== '.bin' || basename(dirname(bin)) !== 'node_modules') continue
    const dir = join(bin, '..', 'playwright')
    try {
      if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version === PLAYWRIGHT_VERSION) return dir
    } catch {
      // No playwright here; keep looking.
    }
  }
  return null
}

/** Validates a shoot plan and fills its defaults; every path is prefixed with the app's basePath. */
export function normalizePlan(plan) {
  if (!plan || typeof plan.baseUrl !== 'string' || !/^https?:\/\//.test(plan.baseUrl)) throw new CliError('bad_plan', 'The shoot plan needs an http(s) baseUrl, such as http://localhost:3000.')
  const basePath = typeof plan.basePath === 'string' ? plan.basePath.replace(/\/+$/, '') : ''
  const path = (value) => {
    if (typeof value !== 'string' || !value.startsWith('/')) throw new CliError('bad_plan', `Plan paths must start with "/": ${JSON.stringify(value)}.`)
    return `${basePath}${value}`
  }
  const shots = (plan.shots ?? []).map((shot) => {
    if (!NAME.test(shot.name ?? '')) throw new CliError('bad_plan', `Screenshot names use a-z, 0-9 and "-" only: ${JSON.stringify(shot.name)}.`)
    const themes = shot.themes ?? THEMES
    if (!themes.every((theme) => THEMES.includes(theme))) throw new CliError('bad_plan', `Screenshot themes are "light" and "dark": ${JSON.stringify(themes)}.`)
    return { path: path(shot.path), name: shot.name, themes, viewport: shot.viewport ?? { width: 1280, height: 800 }, selector: shot.selector ?? null, fullPage: shot.fullPage === true }
  })
  return {
    baseUrl: plan.baseUrl.replace(/\/+$/, ''),
    out: typeof plan.out === 'string' ? plan.out : '.fallback404/shots',
    darkMode: plan.darkMode ?? { strategy: 'media' },
    checks: (plan.checks ?? []).map((check) => ({
      path: path(check.path),
      expectStatus: check.expectStatus ?? null,
      expectText: check.expectText ?? null,
      // hydrate: false blocks the framework's scripts; javaScript: false turns JavaScript off. Both show the first paint.
      hydrate: check.hydrate !== false,
      javaScript: check.javaScript !== false,
    })),
    shots,
  }
}

/** An init script that puts the page in `theme` for class- or attribute-based dark modes; null for media-based ones. */
export function themeScript(darkMode, theme) {
  if (darkMode?.strategy !== 'class' && darkMode?.strategy !== 'attribute') return null
  return `(() => {
  const mode = ${JSON.stringify({ ...darkMode, theme })}
  try { localStorage.setItem('theme', mode.theme) } catch {}
  const apply = () => {
    const html = document.documentElement
    if (!html) return false
    if (mode.strategy === 'class') html.classList.toggle(mode.value, mode.theme === 'dark')
    else html.setAttribute(mode.attribute, mode.theme === 'dark' ? mode.value : 'light')
    return true
  }
  if (!apply()) new MutationObserver((_, observer) => { if (apply()) observer.disconnect() }).observe(document, { childList: true, subtree: true })
})()`
}

/** Console errors, minus the "Failed to load resource … 404" a not-found page logs about its own URL. */
export function consoleErrors(messages, pageUrl) {
  return messages
    .filter((message) => message.type === 'error')
    .filter((message) => !(/Failed to load resource/i.test(message.text) && /\b404\b/.test(message.text) && message.url === pageUrl))
    .map((message) => message.text)
}

export async function runStatusOnly(plan, fetchImpl = fetch) {
  const checks = []
  for (const check of plan.checks) {
    let status = null
    try {
      status = (await fetchImpl(`${plan.baseUrl}${check.path}`, { redirect: 'follow', signal: AbortSignal.timeout(60000) })).status
    } catch {
      // No answer: status stays null and the check fails.
    }
    checks.push({
      path: check.path,
      status,
      expectStatus: check.expectStatus,
      ok: check.expectStatus === null || status === check.expectStatus,
      text: check.expectText === null ? null : 'unverified',
      hydrate: check.hydrate,
      javaScript: check.javaScript,
    })
  }
  return { skipped: false, statusOnly: true, checks, shots: [] }
}

async function launch(chromium) {
  for (const options of [{}, { channel: 'chrome' }]) {
    try {
      return await chromium.launch(options)
    } catch (error) {
      if (!/Executable doesn't exist|is not found at|distribution .* is not found/i.test(String(error?.message))) throw error
    }
  }
  return null
}

async function visit(browser, plan, path, theme, viewport, { hydrate = true, javaScript = true } = {}) {
  const context = await browser.newContext({ colorScheme: theme, viewport, reducedMotion: 'no-preference', javaScriptEnabled: javaScript })
  // Without the framework's scripts, only the server HTML and its inline scripts run: what a visitor sees first.
  if (!hydrate) await context.route('**/_next/static/**/*.js', (route) => route.abort())
  const script = themeScript(plan.darkMode, theme)
  if (script) await context.addInitScript(script)
  const page = await context.newPage()
  const messages = []
  const pageErrors = []
  page.on('console', (message) => messages.push({ type: message.type(), text: message.text(), url: message.location()?.url }))
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const url = `${plan.baseUrl}${path}`
  const response = await page.goto(url, { waitUntil: 'load', timeout: 60000 })
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
  await page.evaluate(() => document.fonts?.ready).catch(() => {})
  return { context, page, status: response?.status() ?? null, errors: () => ({ consoleErrors: consoleErrors(messages, url), pageErrors }) }
}

/** Status checks, then one screenshot per shot and theme, in one browser; fresh cookie-less contexts throughout. */
export async function runShots(plan, chromium, root) {
  const browser = await launch(chromium)
  if (!browser) return { skipped: true, reason: 'no-browser', install: `npx -y playwright@${PLAYWRIGHT_VERSION} install chromium-headless-shell` }
  const report = { skipped: false, checks: [], shots: [] }
  try {
    for (const check of plan.checks) {
      const page = await visit(browser, plan, check.path, 'light', { width: 1280, height: 800 }, check)
      try {
        const body = check.expectText === null ? '' : await page.page.locator('body').first().innerText().catch(() => '')
        const text = check.expectText === null ? null : body.includes(check.expectText) ? 'found' : 'missing'
        const ok = (check.expectStatus === null || page.status === check.expectStatus) && text !== 'missing'
        report.checks.push({ path: check.path, status: page.status, expectStatus: check.expectStatus, ok, text, hydrate: check.hydrate, javaScript: check.javaScript, ...page.errors() })
      } finally {
        await page.context.close()
      }
    }
    for (const shot of plan.shots) {
      for (const theme of shot.themes) {
        const page = await visit(browser, plan, shot.path, theme, shot.viewport)
        try {
          const file = `${plan.out}/${shot.name}-${theme}.png`
          const abs = await prepareWrite(root, file)
          if (shot.selector) await page.page.locator(shot.selector).first().screenshot({ path: abs, animations: 'disabled' })
          else await page.page.screenshot({ path: abs, fullPage: shot.fullPage, animations: 'disabled' })
          const overflowX = await page.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
          report.shots.push({ name: shot.name, theme, file, bytes: (await stat(abs)).size, status: page.status, overflowX, ...page.errors() })
        } finally {
          await page.context.close()
        }
      }
    }
  } finally {
    await browser.close()
  }
  return report
}

export async function main({ command, positionals, flags }) {
  const root = resolve(stringFlag(flags, 'root', '.'))
  const planFile = command ?? positionals[0]
  if (!planFile) throw new CliError('bad_args', USAGE)
  const plan = normalizePlan(await readJson(resolve(planFile)))
  let report
  if (flags['status-only']) {
    report = await runStatusOnly(plan)
  } else {
    const dir = findPlaywright()
    if (!dir) {
      report = { skipped: true, reason: 'no-playwright', hint: `Run shoot.mjs through: ${SHOOT_COMMAND} <skill>/scripts/shoot.mjs <plan.json>` }
    } else {
      const { chromium } = await import(pathToFileURL(join(dir, 'index.mjs')).href)
      report = await runShots(plan, chromium, root)
    }
  }
  report.ok = !report.skipped && report.checks.every((check) => check.ok)
  await writeJsonInside(root, resolve(root, plan.out, 'report.json'), report)
  return report
}

if (isMain(import.meta.url)) process.exitCode = await runCli(main, process.argv.slice(2))
