#!/usr/bin/env node
// Mask the Copilot token in every file under a folder.
//
//   node harness/bin/mask.mjs <folder>     # COPILOT_GITHUB_TOKEN from the env
//
// The job log masks secrets; an uploaded artifact does not. The build job
// runs this on its copy of the agents' outputs, as the runner, after every
// agent process is dead, so what is uploaded never carries the token.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function mask(dir, secret) {
  let changed = 0
  if (!secret) return changed
  for (const name of readdirSync(dir, { recursive: true })) {
    const p = join(dir, String(name))
    if (!statSync(p).isFile()) continue
    const text = readFileSync(p, 'latin1')
    if (text.includes(secret)) { writeFileSync(p, text.split(secret).join('***'), 'latin1'); changed++ }
  }
  return changed
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const n = mask(process.argv[2], process.env.COPILOT_GITHUB_TOKEN)
  console.log(`harness: masked the Copilot token in ${n} file${n === 1 ? '' : 's'}`)
}
