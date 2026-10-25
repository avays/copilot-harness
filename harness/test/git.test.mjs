// The gate and red-check against a real git repository, with shell scripts
// standing in for Maven: proves the worktree, revert and exit-code logic.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { gate } from '../lib/gate.mjs'
import { syncBase } from '../lib/git.mjs'
import { redCheck } from '../lib/red-check.mjs'
import { copilotEnv, workflowEdits } from '../bin/run.mjs'
import { config } from './fake.mjs'

const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

// A repo whose "app" is a shell function and whose "test" asserts its output.
// commands.testsOnly runs the named test scripts; any non-zero exit is red.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'harness-git-'))
  dirs.push(dir)
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com'); g('config', 'user.name', 't')
  mkdirSync(join(dir, 'src/main'), { recursive: true }); mkdirSync(join(dir, 'src/test'), { recursive: true })
  writeFileSync(join(dir, 'src/main/status.sh'), 'status() { echo 200; }\n')
  writeFileSync(join(dir, 'run-tests.sh'), 'set -e\nfor t in $(echo "$1" | tr , " "); do bash "src/test/$t.sh"; done\n')
  g('add', '-A'); g('commit', '-qm', 'base')
  g('update-ref', 'refs/remotes/origin/main', 'HEAD')
  g('checkout', '-qb', 'work')
  return { dir, g }
}

const cfg = config({
  paths: { source: ['src/main/'], tests: ['src/test/'] },
  commands: { gate: [{ name: 'tests', run: 'for f in src/test/*.sh; do bash "$f" || exit 1; done' }], testsOnly: 'bash run-tests.sh {tests}', reports: [] },
  tests: { isTest: (f) => /Test\.sh$/.test(f), id: (f) => f.split('/').pop().replace(/\.sh$/, '') },
})

test('a test that needs the change fails on the base: red-check passes it', async () => {
  const { dir, g } = repo()
  writeFileSync(join(dir, 'src/main/status.sh'), 'status() { echo 404; }\n')
  writeFileSync(join(dir, 'src/test/RetiredTest.sh'), '. src/main/status.sh\n[ "$(status)" = 404 ]\n')
  g('add', '-A'); g('commit', '-qm', 'change')
  const r = await redCheck({ config: cfg, cwd: dir, base: 'origin/main' })
  assert.equal(r.checked, true)
  assert.equal(r.failedOnBase, true)
  assert.deepEqual(r.tests, ['RetiredTest'])
  assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').length, 1, 'the scratch worktree is removed')
})

test('a test that passes without the change is caught', async () => {
  const { dir, g } = repo()
  writeFileSync(join(dir, 'src/main/status.sh'), 'status() { echo 404; }\n')
  writeFileSync(join(dir, 'src/test/NothingTest.sh'), 'true\n')
  g('add', '-A'); g('commit', '-qm', 'change')
  const r = await redCheck({ config: cfg, cwd: dir, base: 'origin/main' })
  assert.equal(r.failedOnBase, false)
})

test('the gate is green only when every command passes and the tree is clean', async () => {
  const { dir, g } = repo()
  writeFileSync(join(dir, 'src/test/OkTest.sh'), 'true\n')
  g('add', '-A'); g('commit', '-qm', 'ok')
  assert.equal((await gate({ config: cfg, cwd: dir, base: 'origin/main' })).ok, true)

  writeFileSync(join(dir, 'scratch.txt'), 'uncommitted')
  const dirty = await gate({ config: cfg, cwd: dir, base: 'origin/main' })
  assert.equal(dirty.ok, false)
  assert.equal(dirty.dirty, true)
  rmSync(join(dir, 'scratch.txt'))

  writeFileSync(join(dir, 'src/test/BadTest.sh'), 'echo "expected 404"; exit 1\n')
  g('add', '-A'); g('commit', '-qm', 'bad')
  const redGate = await gate({ config: cfg, cwd: dir, base: 'origin/main' })
  assert.equal(redGate.ok, false)
  assert.match(redGate.steps[0].tail, /expected 404/)
})

test('a branch that conflicts with the base reports the files and leaves no merge behind', async () => {
  const { dir, g } = repo()
  writeFileSync(join(dir, 'src/main/status.sh'), 'status() { echo 410; }\n')
  g('commit', '-qam', 'branch side')
  // Move "origin/main" on: a commit on main that touches the same line.
  g('checkout', '-q', 'main')
  writeFileSync(join(dir, 'src/main/status.sh'), 'status() { echo 451; }\n')
  g('commit', '-qam', 'base side'); g('update-ref', 'refs/remotes/origin/main', 'HEAD')
  g('checkout', '-q', 'work')
  const s = await syncBase('origin/main', dir)
  assert.equal(s.sync, 'conflict')
  assert.deepEqual(s.conflicts, ['src/main/status.sh'])
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '')
})

test('workflow files the branch changes are found, so publish can refuse to push them', async () => {
  const { dir, g } = repo()
  mkdirSync(join(dir, '.github/workflows'), { recursive: true })
  writeFileSync(join(dir, '.github/workflows/ci.yml'), 'on: push\n')
  writeFileSync(join(dir, 'src/main/status.sh'), 'status() { echo 404; }\n')
  g('add', '-A'); g('commit', '-qm', 'touch a workflow')
  assert.deepEqual(await workflowEdits('origin/main', 'HEAD', dir), ['.github/workflows/ci.yml'])
})

test('with the agents\' environment, git hands out no stored credential', () => {
  const { dir, g } = repo()
  const store = join(dir, '..', `creds-${Date.now()}`)
  writeFileSync(store, 'https://x-access-token:s3cret@github.com\n')
  g('config', 'credential.helper', `store --file=${store}`)
  // Only this repository's config: a real helper in the person's global or
  // system config must never be asked, nor its answer printed by an assert.
  const isolated = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  const fill = (env) => spawnSync('git', ['credential', 'fill'], { cwd: dir, encoding: 'utf8', env, input: 'protocol=https\nhost=github.com\n\n' })
  // Without it the stored token comes straight back: the test can see one.
  assert.ok(fill(isolated).stdout.includes('password=s3cret'), 'the store answers without the agents\' environment')
  const agent = fill(copilotEnv(isolated))
  assert.ok(!agent.stdout.includes('s3cret'), 'no credential reaches the agents')
  assert.notEqual(agent.status, 0)
  rmSync(store, { force: true })
})

test('a workflow file with a quoted name is still found', async () => {
  const { dir, g } = repo()
  mkdirSync(join(dir, '.github/workflows'), { recursive: true })
  writeFileSync(join(dir, '.github/workflows/é.yml'), 'on: push\n')
  writeFileSync(join(dir, '.github/workflows/tab\tx.yml'), 'on: push\n')
  g('add', '-A'); g('commit', '-qm', 'odd names')
  assert.deepEqual((await workflowEdits('origin/main', 'HEAD', dir)).sort(), ['.github/workflows/tab\tx.yml', '.github/workflows/é.yml'])
})
