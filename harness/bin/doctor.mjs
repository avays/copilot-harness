#!/usr/bin/env node
// Is this checkout ready for the harness? Read-only, and safe to re-run.
//
//   node harness/bin/doctor.mjs          # local checks, no network beyond gh auth status
//   node harness/bin/doctor.mjs --live   # also runs the harness-ping workflow (no agents, no AI credits)
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { loadConfig } from '../lib/config.mjs'
import { copilotArgv } from './run.mjs'

const live = process.argv.includes('--live')
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts })

const top = run('git', ['rev-parse', '--show-toplevel'])
const root = top.status === 0 ? top.stdout.trim() : process.cwd()
check('inside a git repository', top.status === 0, root)

const [major] = process.versions.node.split('.').map(Number)
check('Node 20 or newer', major >= 20, process.versions.node)

let config = null
try { config = await loadConfig(root); check('harness.config.mjs loads', true) } catch (e) { check('harness.config.mjs loads', false, e.message) }

if (config) {
  check('config.map is filled in', Boolean(config.map) && !/^TODO/.test(config.map), config.map ? 'still the TODO placeholder' : 'empty: every agent will re-learn the repo')
  const found = config.instructions.filter((p) => existsSync(join(root, p)))
  check('project instructions exist', found.length > 0, found.length ? found.join(', ') : `none of ${config.instructions.join(', ')}`)
  for (const g of config.commands.gate) {
    const bin = g.run.trim().split(/\s+/)[0]
    const ok = bin.startsWith('./') ? existsSync(join(root, bin)) : run('bash', ['-c', `command -v ${bin}`]).status === 0
    check(`gate command "${g.name}" can start`, ok, bin)
  }
  check('red-check is configured', Boolean(config.commands.testsOnly), config.commands.testsOnly ? '' : 'commands.testsOnly is null: tests that prove nothing go unnoticed')
  check('the extension is present', existsSync(join(root, '.github/extensions/harness/extension.mjs')))
  check('the spec template is present', existsSync(join(root, 'harness/templates/spec.md')))
  const todo = readFileSync(join(root, 'harness.config.mjs'), 'utf8').match(/TODO/g)
  check('no TODOs left in harness.config.mjs', !todo, todo ? `${todo.length} left` : '')
}

const cop = run(config ? config.copilot.bin : 'copilot', ['--version'])
check('Copilot CLI is installed', cop.status === 0, cop.status === 0 ? cop.stdout.trim().split('\n')[0] : 'npm install -g @github/copilot')
const ghAuth = run('gh', ['auth', 'status'])
check('gh is signed in', ghAuth.status === 0, ghAuth.status === 0 ? '' : 'gh auth login, or GH_TOKEN in CI')
check('a Copilot token is available', Boolean(process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN) || existsSync(join(process.env.HOME || '', '.copilot')),
  'COPILOT_GITHUB_TOKEN in CI; `copilot login` on a laptop')

if (config) {
  const labels = run('gh', ['label', 'list', '--limit', '200', '--json', 'name', '--jq', '.[].name'], { cwd: root })
  if (labels.status === 0) {
    const have = new Set(labels.stdout.split('\n'))
    const missing = Object.values(config.github.labels).filter((l) => !have.has(l))
    check('the harness labels exist', !missing.length, missing.length ? `missing ${missing.join(', ')} — run the "Harness · setup" workflow` : '')
  }
}

if (live && config && cop.status === 0) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-ping-'))
  const argv = copilotArgv(config, 'harness-ping', join(dir, 'args.json'), join(dir, 'result.json'))
  // ping takes no arguments.
  const i = argv.indexOf('--args'); argv.splice(i, 2)
  const r = run(config.copilot.bin, argv, { cwd: root, env: { ...process.env, GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'true', COPILOT_AUTO_UPDATE: 'false' } })
  const ok = r.status === 0 && existsSync(join(dir, 'result.json'))
  check('copilot workflow run harness-ping', ok, ok ? readFileSync(join(dir, 'result.json'), 'utf8').replace(/\s+/g, ' ').slice(0, 200)
    : `exit ${r.status}: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')}`)
}

for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
const failed = results.filter((r) => !r.ok).length
console.log(failed ? `\n${failed} to fix. ADAPTING.md says how.` : '\nReady.')
process.exitCode = failed ? 1 : 0
if (!live && !failed) console.log('Next: node harness/bin/doctor.mjs --live  (runs a no-agent workflow: proves auth and the extension, costs no credits)')
