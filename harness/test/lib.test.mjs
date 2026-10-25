import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copilotArgv, copilotEnv, readEvents, stageHarness } from '../bin/run.mjs'
import { resolveConfig } from '../lib/config.mjs'
import { dedupe, key } from '../lib/findings.mjs'
import { failedTestsIn, gateFindings } from '../lib/gate.mjs'
import { diffFacts, tamperedFrom } from '../lib/git.mjs'
import { shipPrBody } from '../lib/publish.mjs'
import { plan } from '../lib/red-check.mjs'
import { escalate, profileFor, reviewSize } from '../lib/sizing.mjs'
import { slug } from '../workflows/ship.mjs'
import { blocker, config, red, smallFacts, spec } from './fake.mjs'

test('the config refuses a gate with no commands, and an unknown model slot', () => {
  assert.throws(() => resolveConfig({}), /commands.gate/)
  assert.throws(() => resolveConfig({ commands: { gate: [{ name: 'x', run: 'true' }] }, tiers: { small: { think: 'huge' } } }), /model "huge"/)
})

test('a user config merges over the defaults without losing what it leaves out', () => {
  const c = config({ paths: { source: ['app/src/'] } })
  assert.deepEqual(c.paths.source, ['app/src/'])
  assert.equal(c.paths.specs, 'specs')
  assert.equal(c.tiers.small.buildRounds, 2)
})

test('the same place reworded is one finding; two lines apart are two', () => {
  const a = blocker(), b = blocker({ claim: 'returns ok for retired', category: 'criterion-unmet' })
  const merged = dedupe([a, b])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].also.length, 1)
  assert.equal(dedupe([a, blocker({ line: 50 })]).length, 2)
  assert.equal(key(a), key({ ...a, claim: 'something else' }))
})

test('sizing: small is the base, each risk adds its check', () => {
  const c = config()
  assert.equal(profileFor(smallFacts, c).size, 'small')
  assert.equal(profileFor({ ...smallFacts, changesData: true }, c).size, 'full')
  assert.equal(profileFor(smallFacts, c, { labelledFull: true }).size, 'full')
  assert.equal(profileFor({ ...smallFacts, areas: ['harness'] }, c).size, 'full')
  const api = profileFor({ ...smallFacts, changesApi: true }, c)
  assert.equal(api.size, 'small')
  assert.deepEqual(api.codeLenses, ['criteria', 'rules'])
  assert.equal(profileFor({ ...smallFacts, openQuestions: 2 }, c).specRounds, 1)
})

test('escalation reads the diff, and only once', () => {
  const c = config()
  const p = profileFor(smallFacts, c)
  assert.equal(escalate(p, { risky: [], appLines: 50 }, c), null)
  const up = escalate(p, { risky: [], appLines: 400 }, c)
  assert.equal(up.profile.think, 'strong')
  assert.equal(escalate(up.profile, { risky: ['pom.xml'], appLines: 400 }, c), null)
})

test('review size comes from the diff and the depth dial', () => {
  const c = config()
  assert.equal(reviewSize({ appLines: 10, risky: [], onlyDocs: false }, c), 'tiny')
  assert.equal(reviewSize({ appLines: 10, risky: ['pom.xml'], onlyDocs: false }, c), 'small')
  assert.equal(reviewSize({ appLines: 200, risky: ['pom.xml'], onlyDocs: false }, c), 'large')
  assert.equal(reviewSize({ appLines: 400, risky: [], onlyDocs: false }, config({ review: { depth: 'fast' } })), 'small')
  assert.equal(reviewSize({ appLines: 5, risky: [], onlyDocs: true }, config({ review: { depth: 'thorough' } })), 'large')
})

test('red-check plans from name-status: source to revert, tests to run', () => {
  const c = config()
  const p = plan(['M\tsrc/main/java/a/Order.java', 'A\tsrc/main/java/a/Retired.java', 'A\tsrc/test/java/a/OrderTest.java', 'M\tREADME.md', 'D\tsrc/test/java/a/OldTest.java'].join('\n'), c)
  assert.equal(p.applies, true)
  assert.deepEqual(p.code, ['src/main/java/a/Order.java'])
  assert.deepEqual(p.added, ['src/main/java/a/Retired.java'])
  assert.deepEqual(p.tests, ['OrderTest'])
  assert.equal(plan('M\tsrc/main/java/a/Order.java', c).applies, false)
  assert.equal(plan('M\tsrc/main/java/a/Order.java\nA\tsrc/test/java/a/OrderTest.java', config({ commands: { gate: [{ name: 't', run: 'true' }], testsOnly: null } })).applies, false)
})

test('failing tests are read from JUnit XML', () => {
  const xml = `<testsuite><testcase classname="a.OrderTest" name="ok" time="0.1"/>
    <testcase classname="a.OrderTest" name="retired" time="0.2"><failure message="expected: &lt;404&gt; but was: &lt;200&gt;" type="AssertionFailedError">stack</failure></testcase>
    <testcase classname="a.OrderTest" name="boom"><error message="NPE">trace</error></testcase></testsuite>`
  assert.deepEqual(failedTestsIn(xml), [
    { test: 'a.OrderTest#retired', error: 'expected: <404> but was: <200>' },
    { test: 'a.OrderTest#boom', error: 'NPE' },
  ])
})

test('a red gate becomes findings: named tests first, else the failing step', () => {
  assert.equal(gateFindings(red())[0].file, 'OrderControllerTest#retired')
  assert.match(gateFindings({ ...red(), failedTests: [] })[0].claim, /test exited 1/)
})

test('tampered test lines are found in the diff of the test folders only', () => {
  const patch = ['+++ b/src/test/java/a/OrderTest.java', '-    @Test', '+    @Disabled("flaky")', '+++ b/src/main/java/a/Order.java', '-    assertThat(x)'].join('\n')
  assert.deepEqual(tamperedFrom(patch, config()), [
    'src/test/java/a/OrderTest.java: removed @Test',
    'src/test/java/a/OrderTest.java: added @Disabled("flaky")',
  ])
})

test('diff facts count source lines and name risky files', () => {
  const f = diffFacts(['10\t2\tsrc/main/java/a/Order.java', '5\t0\tsrc/test/java/a/OrderTest.java', '1\t1\tpom.xml'].join('\n'), config({ paths: { risky: ['pom.xml'] } }))
  assert.deepEqual(f, { files: 3, appLines: 12, risky: ['pom.xml'], onlyDocs: false })
})

test('copilot options come before the workflow subcommand', () => {
  const argv = copilotArgv(config(), 'harness-ship', '/r/args.json', '/r/result.json')
  const w = argv.indexOf('workflow')
  assert.ok(argv.indexOf('--experimental') < w)
  assert.ok(argv.findIndex((a) => a.startsWith('--allow-tool=')) < w)
  assert.ok(argv.findIndex((a) => a.startsWith('--deny-tool=')) < w)
  assert.deepEqual(argv.slice(w), ['workflow', 'run', 'harness-ship', '--args', '@/r/args.json', '--result-file', '/r/result.json', '--output-format', 'json'])
})

test('the pull request body says what was proved and what was not', () => {
  const body = shipPrBody({
    outcome: 'pr', issue: 7, title: 't', branch: 'harness/7-t', size: 'small', why: 'one controller', spec,
    built: { tryIt: 'GET /orders/9', keyFiles: [{ file: 'Order.java', why: 'mapping' }] },
    gate: { line: 'test passed' }, redCheck: { failedOnBase: true }, rounds: [{ round: 1, gate: 'test passed', raised: 0, confirmed: 0, covered: 'all' }],
    specRounds: [], minors: [], notVerified: ['no red-check ran'], lessons: [],
  })
  assert.match(body, /^Closes #7\./)
  assert.match(body, /the new tests fail without the change/)
  assert.match(body, /## Not verified\n\n- no red-check ran/)
  const back = shipPrBody({ outcome: 'handback', issue: 7, reason: 'stuck', phase: 'Code Audit', open: [blocker()], rounds: [], specRounds: [] })
  assert.match(back, /^Part of #7\. \*\*Handed back: stuck\*\*/)
  assert.match(back, /## Still open/)
})

test('slugs are short, lower case and safe for a branch name', () => {
  assert.equal(slug('Return 404 for a RETIRED order!'), 'return-404-for-a-retired-order')
  assert.ok(slug('x'.repeat(80)).length <= 40)
  assert.equal(slug(''), 'change')
})

// Two lines as Copilot CLI 1.0.103 printed them for a real harness-ping run.
test('status and spend are read from the run\'s JSONL', () => {
  const out = [
    '{"type":"workflow.run_settled","data":{"runId":"d4","status":"completed","consumedSubagents":3,"consumedNanoAiu":1250000000,"elapsedMs":95000},"ephemeral":true}',
    'not json',
    '{"type":"workflow.result","data":{"name":"harness-ping","run":{"runId":"d4","attempt":1,"status":"completed"},"resultFile":"/tmp/r.json"}}',
  ].join('\n')
  assert.deepEqual(readEvents(out), { status: 'completed', usage: { subagents: 3, aiCredits: 1.25, elapsedMs: 95000 } })
  assert.deepEqual(readEvents(''), { status: null, usage: null })
})

test('the agents\' environment carries no GitHub token, only Copilot\'s own', () => {
  const env = copilotEnv({ PATH: '/bin', GH_TOKEN: 'a', GITHUB_TOKEN: 'b', HARNESS_GH_TOKEN: 'c', COPILOT_GITHUB_TOKEN: 'd' })
  assert.equal(env.GH_TOKEN, undefined)
  assert.equal(env.GITHUB_TOKEN, undefined)
  assert.equal(env.HARNESS_GH_TOKEN, undefined)
  assert.equal(env.COPILOT_GITHUB_TOKEN, 'd')
  // The workspace's own project extension must never load.
  assert.equal(copilotEnv({ GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'true' }).GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS, undefined)
  assert.equal(env.PATH, '/bin')
})

test('the agents\' environment turns off git credential helpers, prompts and the ssh agent', () => {
  const env = copilotEnv({ SSH_AUTH_SOCK: '/tmp/agent', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.editor', GIT_CONFIG_VALUE_0: 'vi' })
  assert.equal(env.SSH_AUTH_SOCK, undefined)
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GIT_CONFIG_COUNT, '2')
  assert.equal(env.GIT_CONFIG_KEY_0, 'core.editor')
  assert.equal(env.GIT_CONFIG_KEY_1, 'credential.helper')
  assert.equal(env.GIT_CONFIG_VALUE_1, '')
  assert.match(env.GIT_SSH_COMMAND, /IdentityFile=\/dev\/null/)
})

test('a draft lists why it stopped and what else is unresolved', () => {
  const body = shipPrBody({ outcome: 'handback', issue: 7, reason: 'the ticket itself is in question', phase: 'Code Audit',
    open: [blocker({ category: 'scope' })], alsoOpen: [blocker({ claim: 'off by one' })], rounds: [], specRounds: [] })
  assert.match(body, /## Still open[\s\S]*scope/)
  assert.match(body, /## Also unresolved[\s\S]*off by one/)
})

test('the config refuses a tier lens that does not exist', () => {
  assert.throws(() => config({ tiers: { small: { codeLenses: ['combind'] } } }), /codeLenses names "combind"/)
  assert.doesNotThrow(() => config({ tiers: { full: { codeLenses: ['criteria', 'parity'] } }, lenses: { code: [{ key: 'parity', ask: 'x' }], spec: [] } }))
})

test('every pull request has a Not verified section', () => {
  const body = shipPrBody({ outcome: 'pr', issue: 7, title: 't', branch: 'b', gate: { line: 'ok' }, rounds: [], specRounds: [], notVerified: [] })
  assert.match(body, /## Not verified\n\n- Nothing beyond/)
})

test('the project\'s own areas replace the defaults instead of joining them', () => {
  const c = config({ sizing: { areas: { web: 'controllers', harness: 'harness/' } } })
  assert.deepEqual(Object.keys(c.sizing.areas), ['web', 'harness'])
})

test('the config refuses a tier that would audit nothing', () => {
  assert.throws(() => config({ tiers: { full: { specLenses: [] } } }), /no specLenses/)
  assert.throws(() => config({ tiers: { small: { codeLenses: [] } } }), /no codeLenses/)
})

test('the staged harness is the root\'s, as a user extension, with the person\'s Copilot home linked in, minus trust', async () => {
  const { existsSync, lstatSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import('node:fs')
  const { join, resolve } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const own = mkdtempSync(join(tmpdir(), 'own-home-'))
  writeFileSync(join(own, 'config.json'), '{}')
  writeFileSync(join(own, 'session-store.db'), '')
  mkdirSync(join(own, 'extensions', 'something-else'), { recursive: true })
  mkdirSync(join(own, 'session-state'), { recursive: true }); mkdirSync(join(own, 'logs'), { recursive: true })
  writeFileSync(join(own, 'settings.json.lock'), '')
  const root = resolve(import.meta.dirname, '../..')
  const { home, cleanup } = stageHarness(root, own)
  try {
    const ext = join(home, 'extensions', 'harness', 'extension.mjs')
    assert.ok(existsSync(ext))
    // extension.mjs imports ../../../harness/ — that must be the staged copy.
    assert.ok(existsSync(resolve(join(home, 'extensions', 'harness'), '../../../harness/lib/config.mjs')))
    assert.ok(existsSync(resolve(join(home, 'extensions', 'harness'), '../../../harness.config.mjs')))
    // Everything but the trust-bearing config is linked, so a login carries over.
    assert.ok(lstatSync(join(home, 'session-store.db')).isSymbolicLink())
    assert.ok(!lstatSync(join(home, 'config.json')).isSymbolicLink())
    assert.ok(!existsSync(join(home, 'extensions', 'something-else')), 'the person\'s own extensions are not loaded')
    for (const own of ['session-state', 'logs', 'settings.json.lock']) assert.ok(!existsSync(join(home, own)), `${own} is the run's own, not linked`)
    assert.equal(readFileSync(ext, 'utf8'), readFileSync(join(root, '.github/extensions/harness/extension.mjs'), 'utf8'))
  } finally { cleanup() }
  assert.ok(!existsSync(home))
})

test('reap kills what the step started, never its ancestors or what was running before it', async () => {
  const { victims } = await import('../bin/reap.mjs')
  // 1 init ← 10 runner (old) ← 20 step shell ← 30 reap; 40 daemon from before the step;
  // 50 left behind by an agent (setsid, so its parent is 1); 60 another user's.
  const parent = { 10: 1, 20: 10, 30: 20, 40: 1, 50: 1, 60: 1 }
  const start = { 10: 100, 20: 500, 30: 900, 40: 50, 50: 700, 60: 800 }
  const user = { 10: 1001, 20: 1001, 30: 1001, 40: 1001, 50: 1001, 60: 0 }
  const kill = victims({ self: 30, me: 1001, pids: [10, 20, 30, 40, 50, 60], parentOf: (p) => parent[p] || 0, startOf: (p) => start[p], userOf: (p) => user[p] })
  assert.deepEqual(kill, [50])
})

test('the config refuses a heavy area that is no area, and an ask that is neither text nor a function', () => {
  assert.throws(() => config({ sizing: { areas: { web: 'w' }, heavyAreas: ['persistence'] } }), /heavyAreas names "persistence"/)
  assert.throws(() => config({ lenses: { code: [{ key: 'parity', ask: 42 }], spec: [] } }), /needs a key and an ask/)
})

test('the staged Copilot home trusts no folder, whatever the person trusted', async () => {
  const { untrusted } = await import('../bin/run.mjs')
  const out = JSON.parse(untrusted(JSON.stringify({ trustedFolders: ['/home/me/repo'], trusted_folders: ['/x'], model: 'm', theme: 'dark' })))
  assert.deepEqual(out, { model: 'm', theme: 'dark' })
  assert.equal(untrusted('not json'), '{}')
  const { mkdtempSync, writeFileSync, readFileSync, lstatSync } = await import('node:fs')
  const { join, resolve } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const own = mkdtempSync(join(tmpdir(), 'own-home-'))
  writeFileSync(join(own, 'config.json'), JSON.stringify({ trustedFolders: ['/'], model: 'm' }))
  const { home, cleanup } = stageHarness(resolve(import.meta.dirname, '../..'), own)
  try {
    assert.ok(!lstatSync(join(home, 'config.json')).isSymbolicLink(), 'a copy, so the person\'s trust never reaches the run')
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')), { model: 'm' })
  } finally { cleanup() }
})

test('the agents\' environment drops folder trust and the step\'s command files', () => {
  const env = copilotEnv({ COPILOT_ALLOW_ALL: 'true', GITHUB_ENV: '/r/env', GITHUB_PATH: '/r/path', GITHUB_OUTPUT: '/r/out', GITHUB_STEP_SUMMARY: '/r/s', GITHUB_STATE: '/r/st' })
  for (const k of ['COPILOT_ALLOW_ALL', 'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', 'GITHUB_STATE']) assert.equal(env[k], undefined, k)
})

test('a Copilot run past its timeout is stopped, with everything it started', async () => {
  const { runCopilot } = await import('../bin/run.mjs')
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs')
  const { join, resolve } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'harness-timeout-'))
  const bin = join(dir, 'fake-copilot')
  const pidFile = join(dir, 'child.pid')
  // Starts a child that would outlive it, then hangs.
  writeFileSync(bin, `#!/bin/bash\nsleep 300 &\necho $! > ${pidFile}\nwait\n`)
  chmodSync(bin, 0o755)
  const c = config({ copilot: { bin, timeoutMinutes: 0.01 } })
  const r = await runCopilot(resolve(import.meta.dirname, '../..'), c, 'harness-ping', {}, dir, dir)
  assert.match(r.reason, /passed its timeout/)
  const child = (await import('node:fs')).readFileSync(pidFile, 'utf8').trim()
  assert.notEqual(spawnSync('kill', ['-0', child]).status, 0, 'the child it started is gone too')
})

test('the reap stops a process that left its group, and nothing older than its mark', async () => {
  const { spawnSync } = await import('node:child_process')
  const { resolve } = await import('node:path')
  const reap = resolve(import.meta.dirname, '../bin/reap.mjs')
  // A step shell: mark, start an escaping sleeper, reap since the mark.
  const r = spawnSync('bash', ['-c', `since=$(node "${reap}" --mark); setsid sleep 300 & S=$!; disown; sleep 0.3; node "${reap}" --since "$since" >/dev/null; sleep 0.2; kill -0 $S 2>/dev/null && echo alive || echo gone; echo shell-ok`], { encoding: 'utf8' })
  assert.match(r.stdout, /gone/)
  assert.match(r.stdout, /shell-ok/)
})

test('the config refuses lens keys that collide, unknown lens tiers and unknown model slots', () => {
  const lens = (over) => config({ lenses: { code: [{ key: 'parity', ask: 'x', tiers: ['full'], ...over }], spec: [] } })
  assert.throws(() => lens({ key: 'tests' }), /lens key "tests" is taken/)
  assert.throws(() => lens({ key: 'rules' }), /lens key "rules" is taken/)
  assert.throws(() => config({ lenses: { code: [{ key: 'p', ask: 'x', tiers: ['full'] }, { key: 'p', ask: 'y', tiers: ['full'] }], spec: [] } }), /"p" is taken/)
  assert.throws(() => lens({ tiers: ['ful'] }), /names tier "ful"/)
  assert.throws(() => lens({ tiers: [] }), /would never run/)
  assert.throws(() => lens({ model: 'gpt-4.1' }), /names model "gpt-4.1"/)
  assert.doesNotThrow(() => lens({ model: 'strong' }))
})

test('sizing: many source files bring in the criteria and rules auditors', () => {
  const p = profileFor({ ...smallFacts, files: 9 }, config())
  assert.deepEqual(p.codeLenses, ['criteria', 'rules'])
})

test('two findings eight lines apart in one ten-line window share a stuck key', () => {
  assert.equal(key(blocker({ line: 41 })), key(blocker({ line: 48, claim: 'reworded' })))
  assert.notEqual(key(blocker({ line: 41 })), key(blocker({ line: 51 })))
})

test('the reap stops a process that keeps forking, children and all', async () => {
  const { spawnSync } = await import('node:child_process')
  const { resolve } = await import('node:path')
  const reap = resolve(import.meta.dirname, '../bin/reap.mjs')
  // A setsid'd loop that forks a new sleeper every few milliseconds.
  const script = `since=$(node "${reap}" --mark)
setsid bash -c 'while true; do sleep 30 & sleep 0.005; done' & L=$!; disown
sleep 0.4
node "${reap}" --since "$since" >/dev/null
sleep 0.3
left=$(pgrep -u "$(id -u)" -f "^sleep 30$" | wc -l)
kill -0 $L 2>/dev/null && echo "loop alive" || echo "loop gone"
echo "sleepers left: $left"`
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  assert.match(r.stdout, /loop gone/)
  assert.match(r.stdout, /sleepers left: 0/)
})
