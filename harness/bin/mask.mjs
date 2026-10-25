#!/usr/bin/env node
// Mask secrets in every file under a folder.
//
//   node harness/bin/mask.mjs <folder>     # COPILOT_GITHUB_TOKEN, plus the
//                                          # variables HARNESS_MASK names
//
// The job log masks secrets; an uploaded artifact does not. The build job
// runs this on its copy of the agents' outputs, as the runner, after every
// agent process is dead, so what is uploaded never carries the token.
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function mask(dir, secrets) {
  let changed = 0
  const list = [].concat(secrets).filter((s) => s && s.length >= 4)
  if (!list.length) return changed
  // Walked by hand, so one odd entry can't stop it. A file that can't be
  // read to check is removed: nothing unchecked is uploaded.
  // Paths as bytes throughout, so a name that isn't valid UTF-8 still
  // resolves to the file it names.
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true, encoding: 'buffer' })) {
      const p = Buffer.concat([d, Buffer.from('/'), e.name])
      // A name is uploaded too: one that carries a secret goes, contents and all.
      if (list.some((s) => e.name.toString('latin1').includes(s))) { rmSync(p, { recursive: true, force: true }); changed++; continue }
      if (e.isDirectory()) { walk(p); continue }
      if (!e.isFile()) continue
      // A git bundle is compressed: a token in it is not text to replace.
      if (e.name.toString().endsWith('.bundle')) continue
      try {
        const text = readFileSync(p, 'latin1')
        const masked = list.reduce((t, s) => t.split(s).join('***'), text)
        if (masked !== text) { writeFileSync(p, masked, 'latin1'); changed++ }
      } catch { rmSync(p, { force: true }) }
    }
  }
  walk(Buffer.from(dir))
  return changed
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const names = ['COPILOT_GITHUB_TOKEN', ...String(process.env.HARNESS_MASK || '').split(',').map((s) => s.trim()).filter(Boolean)]
  const n = mask(process.argv[2], names.map((k) => process.env[k]))
  console.log(`harness: masked ${names.join(', ')} in ${n} file${n === 1 ? '' : 's'}`)
}
