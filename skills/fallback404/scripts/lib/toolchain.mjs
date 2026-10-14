// Files the app's own tools rewrite while the skill runs them (next dev, next build, tsc), so neither the branch step
// nor the write-scope rule mistakes them for the user's changes.
import { git } from './git.mjs'
import { readText } from './fs.mjs'

// Next.js 16.3+ `next dev` upserts these managed blocks into AGENTS.md (or a CLAUDE.md alone) unless next.config sets agentRules: false.
const NEXT_AGENT_BLOCKS = [
  ['<!-- BEGIN:nextjs-agent-rules -->', '<!-- END:nextjs-agent-rules -->'],
  ['<!-- BEGIN:nextjs-agent-feedback -->', '<!-- END:nextjs-agent-feedback -->'],
  ['<!-- NEXT-AGENTS-MD-START -->', '<!-- NEXT-AGENTS-MD-END -->'],
]

export function withoutNextBlocks(text) {
  let rest = text
  for (const [start, end] of NEXT_AGENT_BLOCKS) {
    for (let from = rest.indexOf(start); from !== -1; from = rest.indexOf(start)) {
      const to = rest.indexOf(end, from)
      if (to === -1) break
      rest = rest.slice(0, from) + rest.slice(to + end.length)
    }
  }
  return rest.replace(/\s+/g, ' ').trim()
}

/** True for a changed path the toolchain wrote: next-env.d.ts, *.tsbuildinfo, or AGENTS.md / CLAUDE.md changed only by Next's blocks. */
export async function toolchainWrote(root, path) {
  if (path === 'next-env.d.ts' || path.endsWith('.tsbuildinfo')) return true
  if (path !== 'AGENTS.md' && path !== 'CLAUDE.md') return false
  const now = await readText(root, path)
  if (now === null) return false
  const before = await git(root, ['show', `HEAD:./${path}`]).catch(() => '')
  // Next.js 16.3's next dev scaffolds CLAUDE.md as a pointer to AGENTS.md when neither file exists.
  if (path === 'CLAUDE.md' && before === '' && now === '@AGENTS.md\n') return true
  return withoutNextBlocks(now) === withoutNextBlocks(before)
}
