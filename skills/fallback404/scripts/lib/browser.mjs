// Runs shoot.mjs the way SKILL.md does (through npx and the pinned Playwright) from other scripts, and probes for a browser.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CliError } from './cli.mjs'

export const PLAYWRIGHT_VERSION = '1.64.0'
const SHOOT = fileURLToPath(new URL('../shoot.mjs', import.meta.url))

/** The npx command that runs shoot.mjs with Playwright on PATH; `shell` on Windows, where npx is a .cmd. */
export function shootArgs(planFile, { probe = false, platform = process.platform } = {}) {
  const args = ['--yes', '--no-update-notifier', '-p', `playwright@${PLAYWRIGHT_VERSION}`, 'node', SHOOT, ...(probe ? ['--probe'] : [planFile])]
  return { cmd: 'npx', args, options: platform === 'win32' ? { shell: true, windowsHide: true } : {} }
}

/** The last line of `text` that parses as JSON: npm notices may come before the report. */
function lastJsonLine(text) {
  for (const line of text.trim().split('\n').reverse()) {
    try {
      return JSON.parse(line)
    } catch {
      // Not the report; keep looking.
    }
  }
  return null
}

function runChild(cmd, args, options, spawnImpl) {
  return new Promise((done, fail) => {
    let child
    try {
      child = spawnImpl(cmd, args, options)
    } catch (error) {
      fail(new CliError('shoot_failed', `Could not start ${cmd}: ${error.message}`))
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => (stdout += chunk))
    child.stderr?.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => fail(new CliError('shoot_failed', `Could not run ${cmd}: ${error.message}`)))
    child.on('close', (code) => done({ code, stdout, stderr }))
  })
}

async function runShootCommand(root, { cmd, args, options }, spawnImpl) {
  const { code, stdout, stderr } = await runChild(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options }, spawnImpl)
  const report = lastJsonLine(stdout)
  if (code === 0 && report) return report
  const failure = lastJsonLine(stderr)
  if (failure?.error?.code) throw new CliError(failure.error.code, failure.error.message)
  throw new CliError('shoot_failed', `shoot.mjs exited with ${code}. ${stderr.trim().split('\n').slice(-5).join('\n')}`)
}

/** Runs a shoot plan and returns its report ({ skipped, checks, shots, … }). The first run needs the network for npx to fetch Playwright. */
export async function runShoot(root, planFile, { spawnImpl = spawn } = {}) {
  return runShootCommand(root, shootArgs(planFile), spawnImpl)
}

/** { browser: true } when Playwright and a Chromium can launch here; else the reason and, when known, the install command. */
export async function probeBrowser(root, { spawnImpl = spawn } = {}) {
  const report = await runShootCommand(root, shootArgs(null, { probe: true }), spawnImpl)
  if (report.skipped === false) return { browser: true }
  return { browser: false, reason: report.reason, ...(report.install ? { install: report.install } : {}), ...(report.hint ? { hint: report.hint } : {}) }
}
