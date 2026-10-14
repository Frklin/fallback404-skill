#!/usr/bin/env node
// Fallback404 run state in .fallback404/state.json: the phase reached, picker steps and picks, so a run can resume.
// Usage: node state.mjs get | phase <name> | step <kind> --id <stepId> --round <n> --dir <path>
//                      | pick <kind> --title <title> [--position <n>] [--current] [--root <dir>]
import { resolve } from 'node:path'
import { CliError, isMain, requireString, runCli, stringFlag } from './lib/cli.mjs'
import { prepareWrite, readJsonIfExists, workspacePath, writeJsonInside } from './lib/fs.mjs'

export const PHASES = ['preflight', 'scan', 'coverage', 'understand', 'branch', 'design', 'review', 'write', 'check', 'finish']
const FLOW_KIND = /^flow-[a-z0-9-]{1,19}$/
/** The coverage step, or one flow step (`flow-<row id>`, from plan.json). */
export const isKind = (kind) => kind === 'coverage' || FLOW_KIND.test(kind ?? '')
const USAGE =
  'Usage: node state.mjs get | phase <name> | step <kind> --id <stepId> --round <n> --dir <path> | pick <kind> --title <title> [--position <n>] [--current] [--root <dir>]'

export async function readState(root) {
  return (await readJsonIfExists(workspacePath(root, 'state.json'))) ?? { schema: 1, phase: null, steps: [], picks: {} }
}

export async function update(root, change, now = () => new Date()) {
  const file = workspacePath(root, 'state.json')
  await prepareWrite(root, file)
  const state = await readState(root)
  change(state)
  state.updatedAt = now().toISOString()
  await writeJsonInside(root, file, state)
  return state
}

export async function main({ command, positionals, flags }) {
  const root = resolve(stringFlag(flags, 'root', '.'))
  if (command === 'get') return readState(root)
  if (command === 'phase') {
    const phase = positionals[0]
    if (!PHASES.includes(phase)) throw new CliError('bad_args', `Unknown phase "${phase}". Phases: ${PHASES.join(', ')}.`)
    return update(root, (state) => {
      state.phase = phase
    })
  }
  if (command === 'step' || command === 'pick') {
    const kind = positionals[0]
    if (!isKind(kind)) throw new CliError('bad_args', `Unknown step kind "${kind}". Kinds: coverage, or a flow kind from plan.json (flow-<row id>).`)
    if (command === 'step') {
      const id = requireString(flags, 'id', USAGE)
      const round = Number(requireString(flags, 'round', USAGE))
      const dir = requireString(flags, 'dir', USAGE)
      return update(root, (state) => {
        state.steps = [...state.steps.filter((step) => step.id !== id), { kind, id, round, dir }]
      })
    }
    const title = requireString(flags, 'title', USAGE)
    const position = flags.position === undefined ? null : Number(flags.position)
    return update(root, (state) => {
      // current: the person kept the site's own page for this flow.
      state.picks = { ...state.picks, [kind]: { title, position, ...(flags.current === true ? { current: true } : {}) } }
    })
  }
  throw new CliError('bad_args', USAGE)
}

if (isMain(import.meta.url)) process.exitCode = await runCli(main, process.argv.slice(2))
