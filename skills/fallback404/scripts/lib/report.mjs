// The coverage report Claude shows in phase 2, rendered from scan.json as Markdown.

const STATE = {
  'missing-root-not-found': 'not-found',
  'missing-error': 'error',
  'missing-global-error': 'global-error',
  'soft-404': '404 status',
  'no-notfound-candidate': 'not-found',
  'missing-loading': 'loading',
  'weak-suspense-fallback': 'loading',
}
const FALLBACK = { none: 'no', null: 'empty (null)', text: 'plain-text' }

const code = (text) => `\`${text}\``
const cell = (text) => String(text).replace(/\|/g, '\\|')

function routeCell(finding) {
  if (finding.kind === 'missing-root-not-found') return 'every unknown URL'
  if (finding.kind === 'missing-error' || finding.kind === 'missing-global-error') return 'whole app'
  return code(finding.route)
}

function nowCell(finding) {
  switch (finding.kind) {
    case 'soft-404':
      return finding.confidence === 'high' ? `soft: answers 200 + noindex. ${finding.reason}` : `needs review: ${finding.reason}`
    case 'no-notfound-candidate':
      return 'never calls notFound(), so a missing record may render an empty page (needs review)'
    case 'missing-loading':
      return 'no loading state while data loads'
    case 'weak-suspense-fallback':
      return `${FALLBACK[finding.fallback]} fallback at ${code(`${finding.file}:${finding.line}`)}`
    default:
      return 'missing'
  }
}

function proposalCell(finding) {
  const { proposal } = finding
  if (proposal.type === 'write') return `write ${proposal.files.map(code).join(', ')}`
  if (proposal.type === 'proxy') {
    const check = `existence check in proxy → ${code(proposal.rewrite)} (real 404)`
    return proposal.diff ? `${check}, and add ${code('notFound()')} in ${code(finding.file)} (diff shown first)` : check
  }
  if (finding.kind === 'weak-suspense-fallback') return `use ${code('<Loader inline />')} in ${code(finding.file)} (diff shown first)`
  return `add ${code('notFound()')} in ${code(finding.file)} (diff shown first)`
}

// What Claude does with each finding kind before the coverage page, listed only for the kinds the report shows.
const LEGEND = {
  'soft-404': 'soft-404: read the page and its data helper (`notFound.via` in scan.json): how can a proxy test cheaply that the record exists? For a "needs review" one, decide whether it is really soft; drop it with `--drop` if not.',
  'no-notfound-candidate': 'no-notfound-candidate: read the page: does a missing record render an empty page or crash? Drop it with `--drop` if the page handles it.',
  'missing-loading': 'missing-loading: nothing to read; the coverage page offers it.',
  'weak-suspense-fallback': 'weak-suspense-fallback: nothing to read; a yes at the review lists the page diff that sets `fallback={<Loader inline />}`.',
  'existing-state': 'existing-state: covered today; a redesign replaces the file with a wrapper after the pick.',
  unsupported: 'unsupported: tell the user; nothing else to do.',
}

export function renderReport(scan) {
  const cc = scan.config.cacheComponents === true ? 'on' : scan.config.cacheComponents === false ? 'off' : 'unknown'
  const lines = ['## Fallback404 coverage', '', `Next.js ${scan.next.version} · App Router in ${code(`${scan.appDir}/`)} · Cache Components ${cc}`, '']
  const actionable = scan.findings.filter((finding) => ['write', 'proxy', 'diff'].includes(finding.proposal.type))
  if (actionable.length > 0) {
    lines.push('| Id | Route | State | Now | Proposal |', '| --- | --- | --- | --- | --- |')
    for (const finding of actionable) {
      lines.push(`| ${finding.id} | ${cell(routeCell(finding))} | ${STATE[finding.kind]} | ${cell(nowCell(finding))} | ${cell(proposalCell(finding))} |`)
    }
  } else {
    lines.push('Nothing to add: every state Fallback404 checks is already covered.')
  }
  const yours = scan.findings.filter((finding) => finding.kind === 'existing-state')
  if (yours.length > 0) lines.push('', 'Already yours (kept unless you ask to replace them):', ...yours.map((finding) => `- ${finding.id} ${code(finding.file)} (${finding.state})`))
  const reportOnly = scan.findings.filter((finding) => finding.proposal.type === 'report')
  if (reportOnly.length > 0) {
    lines.push('', 'Report only:', ...reportOnly.map((finding) => `- ${finding.id} ${finding.kind === 'unsupported' ? '' : `${code(finding.route)}: `}${finding.reason ?? finding.proposal.reason}`))
  }
  const edited = scan.owned.filter((item) => item.status === 'edited')
  if (edited.length > 0) lines.push('', 'Changed by you since the last Fallback404 run (left alone):', ...edited.map((item) => `- ${code(item.file)}`))
  if (scan.warnings.length > 0) lines.push('', 'Warnings:', ...scan.warnings.map((warning) => `- ${warning}`))
  const kinds = [...new Set(scan.findings.map((finding) => finding.kind))].filter((kind) => LEGEND[kind])
  if (kinds.length > 0) lines.push('', '## What to do', '', ...kinds.map((kind) => `- ${LEGEND[kind]}`))
  return lines.join('\n')
}
