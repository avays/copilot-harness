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
import { repoEnv } from '../lib/github.mjs'
import { copilotArgv, copilotEnv, readEvents, stageHarness } from './run.mjs'

const live = process.argv.includes('--live')
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts })

const top = run('git', ['rev-parse', '--show-toplevel'])
const root = top.status === 0 ? top.stdout.trim() : process.cwd()
// gh pinned to origin, as run.mjs pins it: without a terminal gh prefers an
// `upstream` remote, and every check below would read the wrong repository.
const ghEnv = { ...process.env, ...(await repoEnv(root)) }
check('inside a git repository', top.status === 0, root)

const [major] = process.versions.node.split('.').map(Number)
check('Node 20 or newer', major >= 20, process.versions.node)

let config = null
try { config = await loadConfig(root); check('harness.config.mjs loads', true) } catch (e) { check('harness.config.mjs loads', false, e.message) }

if (config) {
  const mapOk = Boolean(config.map) && !/^TODO/.test(config.map)
  check('config.map is filled in', mapOk, mapOk ? '' : config.map ? 'still the TODO placeholder' : 'empty: every agent will re-learn the repo')
  const found = config.instructions.filter((p) => existsSync(join(root, p)))
  check('project instructions exist', found.length > 0, found.length ? found.join(', ') : `none of ${config.instructions.join(', ')}`)
  for (const g of config.commands.gate) {
    const bin = g.run.trim().split(/\s+/)[0]
    const ok = bin.startsWith('./') ? existsSync(join(root, bin)) : run('bash', ['-c', `command -v ${bin}`]).status === 0
    check(`gate command "${g.name}" can start`, ok, bin)
  }
  // Paths are prefixes from the repository root. A multi-module layout
  // (app/src/main/…) with the defaults (src/main/) matches nothing, and red-check,
  // tamper detection, escalation and review sizing all go quiet without a word.
  const tracked = run('git', ['ls-files'], { cwd: root }).stdout.split('\n')
  for (const key of ['source', 'tests']) {
    const hits = tracked.filter((f) => config.paths[key].some((p) => f.startsWith(p))).length
    check(`paths.${key} matches tracked files`, hits > 0, hits ? `${hits} files` : `nothing under ${config.paths[key].join(', ')} — paths are prefixes from the repository root (a module is app/src/main/)`)
  }
  // risky entries are prefixes too, with no globs: one that matches nothing
  // can never escalate a run, and nothing else would say so.
  const dead = config.paths.risky.filter((p) => !tracked.some((f) => f === p || f.startsWith(p)))
  check('every paths.risky entry matches a tracked file', !dead.length, dead.length ? `no file under ${dead.join(', ')} (prefixes, no globs)` : '')
  check('red-check is configured', Boolean(config.commands.testsOnly), config.commands.testsOnly ? '' : 'commands.testsOnly is null: tests that prove nothing go unnoticed')
  check('the extension is present', existsSync(join(root, '.github/extensions/harness/extension.mjs')))
  check('the spec template is present', existsSync(join(root, 'harness/templates/spec.md')))
  // Placeholders are written `TODO:`; the word on its own in a comment is not one.
  const todo = readFileSync(join(root, 'harness.config.mjs'), 'utf8').match(/TODO:/g)
  check('no TODO: placeholders left in harness.config.mjs', !todo, todo ? `${todo.length} left` : '')
}

const cop = run(config ? config.copilot.bin : 'copilot', ['--version'], { shell: process.platform === 'win32' })
check('Copilot CLI is installed', cop.status === 0, cop.status === 0 ? cop.stdout.trim().split('\n')[0] : 'npm install -g @github/copilot')
const ghAuth = run('gh', ['auth', 'status'])
check('gh is signed in', ghAuth.status === 0, ghAuth.status === 0 ? '' : 'gh auth login, or GH_TOKEN in CI')
// Presence only: whether the token may make Copilot requests is proved by
// the first agent call, which --live does not make.
check('something Copilot can sign in with', Boolean(process.env.COPILOT_GITHUB_TOKEN) || existsSync(join(process.env.HOME || '', '.copilot')) || ghAuth.status === 0,
  process.env.COPILOT_GITHUB_TOKEN ? 'COPILOT_GITHUB_TOKEN is set' : ghAuth.status === 0 ? 'a gh sign-in' : 'COPILOT_GITHUB_TOKEN in CI; `copilot login` on a laptop')

if (config) {
  const labels = run('gh', ['label', 'list', '--limit', '200', '--json', 'name', '--jq', '.[].name'], { cwd: root, env: ghEnv })
  if (labels.status === 0) {
    const have = new Set(labels.stdout.split('\n'))
    const missing = Object.values(config.github.labels).filter((l) => !have.has(l))
    check('the harness labels exist', !missing.length, missing.length ? `missing ${missing.join(', ')} — run the "Harness · setup" workflow` : '')
  }
  // Opening a pull request with GITHUB_TOKEN needs this repository setting.
  // Reading it needs admin rights, so an unreadable answer is not a failure.
  const perms = run('gh', ['api', 'repos/{owner}/{repo}/actions/permissions/workflow', '--jq', '.can_approve_pull_request_reviews'], { cwd: root, env: ghEnv })
  // A PAT opens pull requests as a person, so the setting does not apply.
  if (perms.status === 0 && !process.env.HARNESS_GH_TOKEN && process.env.HARNESS_USES_PAT !== 'true') {
    check('Actions may create pull requests', perms.stdout.trim() === 'true',
      perms.stdout.trim() === 'true' ? '' : 'Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" (or set HARNESS_GH_TOKEN)')
  }
}

if (live && config && cop.status === 0) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-ping-'))
  const argv = copilotArgv(config, 'harness-ping', join(dir, 'args.json'), join(dir, 'result.json'))
  // ping takes no arguments.
  const i = argv.indexOf('--args'); argv.splice(i, 2)
  // Staged and loaded as a user extension, exactly as run.mjs does.
  const stage = stageHarness(root)
  const r = run(config.copilot.bin, argv, { cwd: root, env: { ...copilotEnv(process.env), COPILOT_HOME: stage.home }, shell: process.platform === 'win32' })
  stage.cleanup()
  const ok = r.status === 0 && existsSync(join(dir, 'result.json'))
  const { usage } = readEvents(r.stdout || '')
  const spent = usage ? ` · ${usage.aiCredits} AI credits, ${usage.subagents} agents` : ''
  check('copilot workflow run harness-ping', ok, ok ? readFileSync(join(dir, 'result.json'), 'utf8').replace(/\s+/g, ' ').slice(0, 200) + spent
    : `exit ${r.status}: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')}`)
}

for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
const failed = results.filter((r) => !r.ok).length
console.log(failed ? `\n${failed} to fix. ADAPTING.md says how.` : '\nReady.')
process.exitCode = failed ? 1 : 0
if (!live && !failed) console.log('Next: node harness/bin/doctor.mjs --live  (runs a no-agent workflow in this working tree: Copilot loads the extension and the config; costs no credits)')
