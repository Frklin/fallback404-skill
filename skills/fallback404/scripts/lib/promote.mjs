// Promotes a picked option: writes variants/<Component>.v<k> and copy.v<k> as the flow's final files with their
// imports fixed. The variants folder stays until write.mjs clean --variants (part of write.mjs apply).
import { CliError } from './cli.mjs'
import { COMPONENTS } from './flows.mjs'
import { readText, writeTextInside } from './fs.mjs'

/** Imports as the final file needs them: ./copy, ../../fallback404.css, ./flow.css. */
export function fixImports(source, k) {
  return source
    .replace(new RegExp(`(['"])\\./copy\\.v${k}\\1`, 'g'), '$1./copy$1')
    .replace(/(['"])\.\.\/\.\.\/\.\.\/fallback404\.css\1/g, '$1../../fallback404.css$1')
    .replace(/(['"])\.\.\/flow\.css\1/g, '$1./flow.css$1')
}

/** The final component and copy files written from variant `k`; their repo-relative paths. */
export async function promote(root, scan, flow, k) {
  const ext = scan.typescript ? 'tsx' : 'jsx'
  const scriptExt = scan.typescript ? 'ts' : 'js'
  const dir = `${scan.componentsDir}/flows/${flow.slug}`
  const name = COMPONENTS[flow.state]
  const moves = [
    [`${dir}/variants/${name}.v${k}.${ext}`, `${dir}/${name}.${ext}`],
    [`${dir}/variants/copy.v${k}.${scriptExt}`, `${dir}/copy.${scriptExt}`],
  ]
  const promoted = []
  for (const [from, to] of moves) {
    const source = await readText(root, from)
    if (source === null) throw new CliError('no_variant', `${from} is missing: the picked option ${k} has no file to promote.`)
    await writeTextInside(root, to, fixImports(source, k))
    promoted.push(to)
  }
  return promoted
}
