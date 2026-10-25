import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copilotArgv, copilotEnv, readEvents } from '../bin/run.mjs'
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
  assert.equal(env.GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS, 'true')
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
  assert.throws(() => config({ tiers: { full: { specLenses: [] } } }), /spec rounds but no specLenses/)
  assert.throws(() => config({ tiers: { small: { codeLenses: [] } } }), /no codeLenses/)
})
