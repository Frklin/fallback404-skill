#!/usr/bin/env node
// Fallback404 dev server: starts the app's dev server in the background for the browser checks, reuses one that already
// runs in this folder, and stops only the server it started. Usage: node devserver.mjs start [--timeout 120] | stop | status [--root <dir>]
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { CliError, isMain, runCli, stringFlag } from './lib/cli.mjs'
import { prepareWrite, readJsonIfExists, workspacePath, writeJsonInside } from './lib/fs.mjs'
import { loadProject } from './lib/project.mjs'

const USAGE = 'Usage: node devserver.mjs start [--timeout 120] | stop | status [--root <dir>]'
const wait = (ms) => new Promise((done) => setTimeout(done, ms))

/** What the dev server log says so far: its Local URL, or that another dev server already runs here (and where). */
export function parseDevLog(log) {
  const plain = log.replace(/\u001b\[[0-9;]*m/g, '')
  return {
    url: /Local:\s+(https?:\/\/[^\s,]+)/i.exec(plain)?.[1] ?? null,
    reuse: /Another next dev server is already running/i.test(plain),
    existingUrl: /existing server at (https?:\/\/[^\s,]+)/i.exec(plain)?.[1] ?? null,
  }
}

/** The project's own dev script through its package manager, or `next dev` when there is no dev script. */
export function devCommand(project) {
  if (project.hasDevScript) {
    if (project.packageManager === 'yarn') return { cmd: 'yarn', args: ['dev'] }
    return { cmd: project.packageManager, args: ['run', 'dev'] }
  }
  const require = createRequire(join(project.root, 'package.json'))
  return { cmd: process.execPath, args: [require.resolve('next/dist/bin/next'), 'dev'] }
}

export function freePort() {
  return new Promise((done, fail) => {
    const server = createServer()
    server.unref()
    server.on('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Ends the process tree of `pid`: its process group on POSIX; on Windows, which has no groups, taskkill /T /F. */
export function killTree(pid, signal, { platform = process.platform, spawnSync: runSync = spawnSync } = {}) {
  if (platform === 'win32') {
    runSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    // Already gone.
  }
}

async function answers(url, fetchImpl) {
  try {
    await fetchImpl(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10000) })
    return true
  } catch {
    return false
  }
}

export async function start(root, { timeoutMs = 120000, spawnImpl = spawn, fetchImpl = fetch, sleep = wait, now = Date.now, platform = process.platform } = {}) {
  const stateFile = workspacePath(root, 'dev.json')
  const previous = await readJsonIfExists(stateFile)
  if (previous && (previous.reused || isAlive(previous.pid)) && (await answers(previous.url, fetchImpl))) return { ...previous, already: true }
  const project = await loadProject(root)
  const port = await freePort()
  await prepareWrite(root, stateFile)
  const logFile = await prepareWrite(root, workspacePath(root, 'dev.log'))
  const fd = openSync(logFile, 'w')
  const { cmd, args } = devCommand(project)
  let child
  try {
    // Windows: Node only runs npm.cmd and the like through a shell; the arguments are fixed, never user text.
    const windows = platform === 'win32' ? { shell: true, windowsHide: true } : {}
    child = spawnImpl(cmd, args, { cwd: root, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, PORT: String(port) }, ...windows })
  } finally {
    closeSync(fd)
  }
  child.unref?.()
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    const log = await readFile(logFile, 'utf8').catch(() => '')
    const seen = parseDevLog(log)
    if (seen.reuse && seen.existingUrl) {
      const state = { url: seen.existingUrl, reused: true }
      await writeJsonInside(root, stateFile, state)
      return state
    }
    if (seen.url && (await answers(seen.url, fetchImpl))) {
      const state = { url: seen.url, reused: false, pid: child.pid, port }
      await writeJsonInside(root, stateFile, state)
      return state
    }
    if (!isAlive(child.pid)) {
      throw new CliError(
        'dev_failed',
        `The dev server stopped before it was ready. Last lines of .fallback404/dev.log:\n${log.trimEnd().split('\n').slice(-20).join('\n')}\nFix the cause (often a variable missing from .env.local) and run start again; without a dev server the visual checks are skipped.`,
      )
    }
    await sleep(500)
  }
  killTree(child.pid, 'SIGTERM', { platform })
  throw new CliError('dev_timeout', `The dev server did not answer within ${Math.round(timeoutMs / 1000)} s. See .fallback404/dev.log; the visual checks can be skipped.`)
}

/**
 * Stops the process group Fallback404 started; a reused server is left running. dev.json can outlive its server
 * (a reboot, a crash) and the pid may belong to another program by then, so nothing is signalled unless the server
 * still answers at its URL.
 */
export async function stop(root, { sleep = wait, fetchImpl = fetch, platform = process.platform } = {}) {
  const stateFile = workspacePath(root, 'dev.json')
  const state = await readJsonIfExists(stateFile)
  if (!state) return { stopped: false, reason: 'Fallback404 did not start a dev server.' }
  await rm(stateFile, { force: true })
  if (state.reused) return { stopped: false, reason: `Your own dev server at ${state.url} was reused and is left running.` }
  if (!(await answers(state.url, fetchImpl))) {
    return { stopped: false, reason: `The dev server Fallback404 started at ${state.url} no longer answers, so pid ${state.pid} is left alone: it may belong to another program by now.` }
  }
  killTree(state.pid, 'SIGTERM', { platform })
  for (let i = 0; i < 20 && isAlive(state.pid); i++) await sleep(250)
  if (isAlive(state.pid)) killTree(state.pid, 'SIGKILL', { platform })
  return { stopped: true, url: state.url }
}

export async function status(root) {
  const state = await readJsonIfExists(workspacePath(root, 'dev.json'))
  return state ? { running: state.reused || isAlive(state.pid), ...state } : { running: false }
}

export async function main({ command, flags }) {
  const root = resolve(stringFlag(flags, 'root', '.'))
  if (command === 'start') return start(root, { timeoutMs: Number(stringFlag(flags, 'timeout', '120')) * 1000 })
  if (command === 'stop') return stop(root)
  if (command === 'status') return status(root)
  throw new CliError('bad_args', USAGE)
}

if (isMain(import.meta.url)) process.exitCode = await runCli(main, process.argv.slice(2))
