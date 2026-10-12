#!/usr/bin/env node
// Fallback404 picker client, run by the Fallback404 Skill to show options on the picker page and read picks back.
// Node >= 18, no dependencies. Prints one JSON line on stdout; errors go to stderr as {"error":{code,message}}.
// Exit codes: 0 done, 1 error, 3 `wait` timed out (run it again).

import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const CLIENT_VERSION = 1
export const DEFAULT_API_URL = 'https://fallback404-beta.vercel.app'
export const DEFAULT_SESSION_FILE = '.fallback404/session.json'

const RETRY_DELAYS_MS = [1000, 2000, 4000]
const THEMES = ['light', 'dark', 'any']
const MIME_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png' }

const USAGE = [
  'Usage: node picker.mjs <command> [options]',
  '  create --project <name> [--options 3] [--plan logo,mascot,motion,page] [--open]',
  '  propose <manifest.json>',
  '  wait --step <id> [--timeout 540] [--interval 2] [--out <file>]',
  '  plan --kinds mascot,motion,page',
  '  complete [--summary <text>]',
  'Every command accepts --session-file <path> (default .fallback404/session.json).',
].join('\n')

export class CliError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function parseArgs(argv) {
  const [command, ...rest] = argv
  const flags = {}
  const positionals = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const next = rest[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[arg.slice(2)] = true
    } else {
      flags[arg.slice(2)] = next
      i++
    }
  }
  return { command, flags, positionals }
}

/** The command that opens a URL in the default browser. */
export function openCommand(platform, url) {
  if (platform === 'darwin') return { cmd: 'open', args: [url] }
  // `start` takes the first quoted argument as a window title, hence the empty one.
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] }
  return { cmd: 'xdg-open', args: [url] }
}

/** True for a plain http(s) URL made only of characters no opener or shell reads as anything but a URL. */
export function safeToOpen(url) {
  if (typeof url !== 'string' || !/^https?:\/\/[A-Za-z0-9.:/_~-]+$/.test(url)) return false
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

function spawnDetached(cmd, args) {
  return new Promise((done) => {
    let child
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    } catch {
      done(false)
      return
    }
    child.once('error', () => done(false))
    child.once('spawn', () => {
      child.unref()
      done(true)
    })
  })
}

export function defaultContext() {
  return {
    fetch: globalThis.fetch,
    readFile,
    writeFile,
    mkdir,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
    env: process.env,
    platform: process.platform,
    spawnDetached,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  }
}

/** Calls the picker API. Retries network errors and 5xx (1 s, 2 s, 4 s); never retries 4xx. */
export async function request(ctx, apiUrl, method, path, { token, json, form } = {}) {
  const headers = { 'X-Fallback404-Client': `picker.mjs/${CLIENT_VERSION}` }
  if (token) headers.Authorization = `Bearer ${token}`
  let body
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(json)
  } else if (form !== undefined) {
    body = form
  }
  const url = `${apiUrl.replace(/\/+$/, '')}${path}`

  for (let attempt = 0; ; attempt++) {
    let response
    try {
      response = await ctx.fetch(url, { method, headers, body })
    } catch (error) {
      if (attempt < RETRY_DELAYS_MS.length) {
        await ctx.sleep(RETRY_DELAYS_MS[attempt])
        continue
      }
      throw new CliError('network', `Could not reach the picker API at ${apiUrl}: ${error.message}`)
    }
    if (response.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
      await ctx.sleep(RETRY_DELAYS_MS[attempt])
      continue
    }
    const text = await response.text()
    let data = {}
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = {}
    }
    if (!response.ok) {
      const error = data.error ?? { code: `http_${response.status}`, message: text.slice(0, 200) || `HTTP ${response.status}` }
      throw new CliError(error.code, error.message)
    }
    return data
  }
}

async function loadSession(ctx) {
  let text
  try {
    text = await ctx.readFile(ctx.sessionFile, 'utf8')
  } catch {
    throw new CliError('no_session', `No picker session at ${ctx.sessionFile}. Run \`create\` first.`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new CliError('no_session', `The picker session file ${ctx.sessionFile} is damaged. Run \`create\` again.`)
  }
}

/** The session file holds the write token: never write it through a symlink a cloned repo could plant. */
async function assertNotLinked(path) {
  for (const target of [dirname(path), path]) {
    let info
    try {
      info = await lstat(target)
    } catch {
      continue
    }
    if (info.isSymbolicLink()) throw new CliError('unsafe_path', `${target} is a symlink; the picker session is never written through links.`)
  }
}

async function saveSession(ctx, session) {
  await assertNotLinked(ctx.sessionFile)
  await ctx.mkdir(dirname(ctx.sessionFile), { recursive: true })
  await ctx.writeFile(ctx.sessionFile, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
}

function apiUrlFor(ctx, session) {
  return ctx.env.FALLBACK404_API_URL ?? session?.apiUrl ?? DEFAULT_API_URL
}

function requireFlag(flags, name) {
  const value = flags[name]
  if (typeof value !== 'string' || value === '') throw new CliError('bad_args', `Missing --${name}.\n${USAGE}`)
  return value
}

export async function create(ctx, flags) {
  const projectName = requireFlag(flags, 'project')
  const optionsPerStep = flags.options === undefined ? 3 : Number(flags.options)
  const plan = typeof flags.plan === 'string' ? flags.plan.split(',').map((kind) => kind.trim()).filter(Boolean) : []
  const apiUrl = apiUrlFor(ctx, null)
  await assertNotLinked(ctx.sessionFile)
  const created = await request(ctx, apiUrl, 'POST', '/api/v1/sessions', { json: { projectName, optionsPerStep, plan } })
  await saveSession(ctx, { apiUrl, sessionId: created.sessionId, token: created.token, pickerUrl: created.pickerUrl })
  const result = { sessionId: created.sessionId, pickerUrl: created.pickerUrl, expiresAt: created.expiresAt }
  if (flags.open === true) {
    // The link comes from the API (or FALLBACK404_API_URL): open only what can be nothing but a web page.
    const { cmd, args } = openCommand(ctx.platform, created.pickerUrl)
    result.opened = safeToOpen(created.pickerUrl) ? await ctx.spawnDetached(cmd, args) : false
  }
  return result
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const isPng = (bytes) => bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
const isSvg = (bytes) => /<svg[\s>/]/i.test(Buffer.from(bytes.subarray(0, 4096)).toString('utf8'))

/** The picker workspace: the folder that holds the session file (.fallback404/ by default). Assets never leave it. */
async function workspaceRoot(ctx) {
  try {
    return await realpath(dirname(resolve(ctx.sessionFile)))
  } catch {
    throw new CliError('no_session', `No picker session at ${ctx.sessionFile}. Run \`create\` first.`)
  }
}

/**
 * Reads one manifest asset. Claude writes manifests, and text in a repo is never trusted, so an asset must be a real
 * file inside the picker workspace (links resolved first, whatever folder the manifest sits in) and the image type its
 * extension says: a planted path can never upload another file, such as .env, to the picker.
 */
async function readAsset(ctx, root, folder, file) {
  if (typeof file !== 'string' || file === '' || isAbsolute(file)) {
    throw new CliError('bad_manifest', `Asset paths are relative to the manifest's folder: ${JSON.stringify(file)}.`)
  }
  const path = resolve(folder, file)
  let real
  try {
    real = await realpath(path)
  } catch (error) {
    throw new CliError('bad_manifest', `Could not read ${path}: ${error.message}`)
  }
  const inside = relative(root, real)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside) || !(await stat(real)).isFile()) {
    throw new CliError('bad_manifest', `${file} is not a file inside the picker workspace ${root} (links are followed before this check).`)
  }
  const ext = extname(path).toLowerCase()
  if (!(ext in MIME_TYPES)) throw new CliError('bad_manifest', `Assets are .svg or .png files: ${file}.`)
  let bytes
  try {
    bytes = await ctx.readFile(real)
  } catch (error) {
    throw new CliError('bad_manifest', `Could not read ${path}: ${error.message}`)
  }
  if (ext === '.png' ? !isPng(bytes) : !isSvg(bytes)) throw new CliError('bad_manifest', `${file} is not a ${ext === '.png' ? 'PNG' : 'SVG'} file.`)
  return { path, bytes }
}

async function proposeCoverage(ctx, manifestPath, manifest) {
  if (!Array.isArray(manifest.rows) || manifest.rows.length === 0) {
    throw new CliError('bad_manifest', 'A coverage manifest needs a non-empty "rows" list.')
  }
  const folder = dirname(resolve(manifestPath))
  const root = await workspaceRoot(ctx)
  // Every file is read and checked before the first request, so a bad manifest sends nothing.
  const shots = []
  for (const row of manifest.rows) {
    if (!row.screenshot) continue
    if (extname(row.screenshot).toLowerCase() !== '.png') throw new CliError('bad_manifest', `Row screenshots are PNG files: ${row.screenshot}.`)
    shots.push({ rowId: row.rowId, ...(await readAsset(ctx, root, folder, row.screenshot)) })
  }
  const session = await loadSession(ctx)
  const apiUrl = apiUrlFor(ctx, session)
  const auth = { token: session.token }
  const base = `/api/v1/sessions/${session.sessionId}`
  // The screenshot is a local path: it is uploaded below, never sent with the row.
  const rows = manifest.rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'screenshot')))
  const step = await request(ctx, apiUrl, 'POST', `${base}/steps`, {
    ...auth,
    json: { type: 'coverage', kind: manifest.kind ?? 'coverage', title: manifest.title, prompt: manifest.prompt, rows },
  })
  for (const { rowId, path, bytes } of shots) {
    const form = new FormData()
    form.set('any', new Blob([bytes], { type: 'image/png' }), basename(path))
    await request(ctx, apiUrl, 'PUT', `${base}/steps/${step.stepId}/rows/${encodeURIComponent(rowId)}/screenshot`, { ...auth, form })
  }
  const published = await request(ctx, apiUrl, 'POST', `${base}/steps/${step.stepId}/publish`, auth)
  return { stepId: step.stepId, round: published.round ?? step.round, pickerUrl: session.pickerUrl, rows: manifest.rows.length }
}

export async function propose(ctx, positionals) {
  const manifestPath = positionals[0]
  if (!manifestPath) throw new CliError('bad_args', `Missing manifest path.\n${USAGE}`)
  let manifest
  try {
    manifest = JSON.parse(await ctx.readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new CliError('bad_manifest', `Could not read ${manifestPath}: ${error.message}`)
  }
  if (manifest.type === 'coverage') return proposeCoverage(ctx, manifestPath, manifest)
  if (!Array.isArray(manifest.options) || manifest.options.length === 0) {
    throw new CliError('bad_manifest', 'The manifest needs a non-empty "options" list.')
  }

  // Every file is read and checked before the first request, so a bad manifest sends nothing.
  const folder = dirname(resolve(manifestPath))
  const root = await workspaceRoot(ctx)
  const options = []
  for (const option of manifest.options) {
    const files = []
    for (const theme of THEMES) {
      const file = option.assets?.[theme]
      if (file) files.push({ theme, ...(await readAsset(ctx, root, folder, file)) })
    }
    options.push({ option, files })
  }

  const session = await loadSession(ctx)
  const apiUrl = apiUrlFor(ctx, session)
  const auth = { token: session.token }
  const base = `/api/v1/sessions/${session.sessionId}`
  const step = await request(ctx, apiUrl, 'POST', `${base}/steps`, {
    ...auth,
    json: { kind: manifest.kind, title: manifest.title, prompt: manifest.prompt },
  })

  for (const [index, { option, files }] of options.entries()) {
    const form = new FormData()
    form.set('title', option.title ?? '')
    if (option.description) form.set('description', option.description)
    for (const { theme, path, bytes } of files) {
      form.set(theme, new Blob([bytes], { type: MIME_TYPES[extname(path).toLowerCase()] }), basename(path))
    }
    await request(ctx, apiUrl, 'PUT', `${base}/steps/${step.stepId}/options/${index + 1}`, { ...auth, form })
  }

  const published = await request(ctx, apiUrl, 'POST', `${base}/steps/${step.stepId}/publish`, auth)
  return { stepId: step.stepId, round: published.round ?? step.round, pickerUrl: session.pickerUrl }
}

export async function wait(ctx, flags) {
  const stepId = requireFlag(flags, 'step')
  const timeoutMs = Number(flags.timeout ?? 540) * 1000
  const intervalMs = Number(flags.interval ?? 2) * 1000
  const out = typeof flags.out === 'string' ? flags.out : null
  const session = await loadSession(ctx)
  const apiUrl = apiUrlFor(ctx, session)
  const deadline = ctx.now() + timeoutMs
  let answered = false
  const finish = async (result) => {
    if (out) {
      await assertNotLinked(out)
      await ctx.mkdir(dirname(out), { recursive: true })
      await ctx.writeFile(out, `${JSON.stringify(result)}\n`)
    }
    return result
  }
  for (;;) {
    let step = null
    try {
      step = await request(ctx, apiUrl, 'GET', `/api/v1/sessions/${session.sessionId}/steps/${stepId}`, {
        token: session.token,
      })
      answered = true
    } catch (error) {
      // Once the API has answered, a blip (Wi-Fi roam, laptop sleep, brief 5xx) must not end the wait:
      // keep polling until the deadline. Before that, fail fast: the URL or the network is probably wrong.
      if (!answered || !isTransient(error)) throw error
    }
    if (step?.status === 'picked') {
      return finish({ status: 'picked', position: step.pickedPosition, note: step.note, ...(step.selection ? { selection: step.selection } : {}) })
    }
    if (step?.status === 'rejected') return finish({ status: 'rejected', note: step.note })
    if (step?.status === 'draft') throw new CliError('not_published', 'This step is still a draft. Run `propose` to publish it.')
    if (ctx.now() + intervalMs > deadline) return { status: 'waiting' }
    await ctx.sleep(intervalMs)
  }
}

function isTransient(error) {
  return error instanceof CliError && (error.code === 'network' || error.code === 'internal' || /^http_5\d\d$/.test(error.code))
}

export async function plan(ctx, flags) {
  const kinds = requireFlag(flags, 'kinds')
    .split(',')
    .map((kind) => kind.trim())
    .filter(Boolean)
  const session = await loadSession(ctx)
  return request(ctx, apiUrlFor(ctx, session), 'PATCH', `/api/v1/sessions/${session.sessionId}`, { token: session.token, json: { plan: kinds } })
}

export async function complete(ctx, flags) {
  const session = await loadSession(ctx)
  const summary = typeof flags.summary === 'string' ? flags.summary : undefined
  return request(ctx, apiUrlFor(ctx, session), 'POST', `/api/v1/sessions/${session.sessionId}/complete`, {
    token: session.token,
    json: summary === undefined ? {} : { summary },
  })
}

export async function main(argv, ctx = defaultContext()) {
  const { command, flags, positionals } = parseArgs(argv)
  const sessionFile = typeof flags['session-file'] === 'string' ? flags['session-file'] : DEFAULT_SESSION_FILE
  const context = { ...ctx, sessionFile }
  try {
    let result
    if (command === 'create') result = await create(context, flags)
    else if (command === 'propose') result = await propose(context, positionals)
    else if (command === 'wait') result = await wait(context, flags)
    else if (command === 'plan') result = await plan(context, flags)
    else if (command === 'complete') result = await complete(context, flags)
    else throw new CliError('bad_args', USAGE)
    context.stdout(JSON.stringify(result))
    return result.status === 'waiting' ? 3 : 0
  } catch (error) {
    const payload =
      error instanceof CliError ? { code: error.code, message: error.message } : { code: 'internal', message: String(error?.message ?? error) }
    context.stderr(JSON.stringify({ error: payload }))
    return 1
  }
}

// Run only when executed directly (not when imported by tests). realpath handles symlinked install folders.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2))
}
