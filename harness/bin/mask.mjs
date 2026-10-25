#!/usr/bin/env node
// Mask secrets in every file under a folder.
//
//   node harness/bin/mask.mjs <folder>     # COPILOT_GITHUB_TOKEN, plus the
//                                          # variables HARNESS_MASK names
//
// The job log masks secrets; an uploaded artifact does not. The build job
// runs this on its copy of the agents' outputs, as the runner, after every
// agent process is dead, so what is uploaded never carries the token.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function mask(dir, secrets) {
  let changed = 0
  const list = [].concat(secrets).filter((s) => s && s.length >= 4)
  if (!list.length) return changed
  for (const name of readdirSync(dir, { recursive: true })) {
    const p = join(dir, String(name))
    if (!statSync(p).isFile()) continue
    const text = readFileSync(p, 'latin1')
    const masked = list.reduce((t, s) => t.split(s).join('***'), text)
    if (masked !== text) { writeFileSync(p, masked, 'latin1'); changed++ }
  }
  return changed
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const names = ['COPILOT_GITHUB_TOKEN', ...String(process.env.HARNESS_MASK || '').split(',').map((s) => s.trim()).filter(Boolean)]
  const n = mask(process.argv[2], names.map((k) => process.env[k]))
  console.log(`harness: masked ${names.join(', ')} in ${n} file${n === 1 ? '' : 's'}`)
}
