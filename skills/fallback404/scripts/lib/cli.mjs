// Shared plumbing for the Fallback404 skill scripts: argument parsing, one-line output and the error shape picker.mjs uses.
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const SKILL_VERSION = '0.1.0'

export class CliError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** `[command] [positionals…] [--flag value | --switch]`; a leading `--flag` means there is no command. */
export function parseArgs(argv) {
  const command = argv[0] !== undefined && !argv[0].startsWith('--') ? argv[0] : undefined
  const rest = command === undefined ? argv : argv.slice(1)
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

/** A string flag, or `fallback` when it is missing or used as a bare switch. */
export function stringFlag(flags, name, fallback) {
  const value = flags[name]
  return typeof value === 'string' && value !== '' ? value : fallback
}

export function requireString(flags, name, usage) {
  const value = stringFlag(flags, name, null)
  if (value === null) throw new CliError('bad_args', `Missing --${name}.\n${usage}`)
  return value
}

export function defaultIo() {
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  }
}

/** Runs `handler(parsedArgs)`, prints its result (strings as they are, anything else as one JSON line) and maps errors. */
export async function runCli(handler, argv, io = defaultIo()) {
  try {
    const result = await handler(parseArgs(argv))
    if (result !== undefined) io.stdout(typeof result === 'string' ? result : JSON.stringify(result))
    return 0
  } catch (error) {
    const payload =
      error instanceof CliError ? { code: error.code, message: error.message } : { code: 'internal', message: String(error?.message ?? error) }
    io.stderr(JSON.stringify({ error: payload }))
    return 1
  }
}

/** True when `url` is the module Node was started with; realpath handles symlinked install folders. */
export function isMain(url) {
  return Boolean(process.argv[1]) && url === pathToFileURL(realpathSync(process.argv[1])).href
}
