import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run } from '../workflows/ship.mjs'
import { blocker, config, deps, fakeCtx, green, red, SHIP_ARGS, smallFacts, spec } from './fake.mjs'

const clean = { ran: 'nothing', covered: 'every criterion traced to a test', findings: [] }
const done = { ok: true, summary: 'OrderControllerTest#retired proves it', tryIt: 'GET /orders/9', keyFiles: [{ file: 'src/main/java/Order.java', why: 'the mapping' }] }

/** Answers for a small ticket where everything goes right; override per test. */
function script(over = {}) {
  return (label, prompt, opts) => {
    for (const [prefix, v] of Object.entries(over)) if (label.startsWith(prefix)) return typeof v === 'function' ? v(label, prompt, opts) : v
    if (label === 'setup') return { proceed: true, reason: 'one controller', doneWhen: ['GET /orders/{id} for a retired order returns 404'], sizing: smallFacts, spec }
    if (label === 'write-spec') return spec
    if (label === 'implement' || label.startsWith('fix#')) return done
    if (label.startsWith('audit:') || label.startsWith('spec-audit:')) return clean
    if (label.startsWith('skeptic:')) return { refuted: false, why: 'the line says so' }
    if (label === 'learn') return { lessons: [] }
    if (label.startsWith('revise-spec')) return spec
  }
}

// Copilot memoizes identical agent calls: two calls with the same label and
// prompt would silently share one agent. Every call must be unique.
const uniqueLabels = (ctx) => {
  const labels = ctx.calls.map((c) => c.label)
  assert.equal(new Set(labels).size, labels.length, `duplicate labels: ${labels.join(', ')}`)
}

test('a small ticket: setup writes the spec, one clean spec audit, one clean code audit, a pull request', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script())
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.equal(r.outcome, 'pr')
  assert.equal(r.size, 'small')
  assert.deepEqual(ctx.calls.map((c) => c.label), ['setup', 'spec-audit:combined#1', 'implement', 'audit:combined#1'])
  assert.equal(r.rounds.length, 1)
  assert.equal(r.redCheck.failedOnBase, true)
  assert.deepEqual(r.notVerified, [])
  uniqueLabels(ctx)
})

test('setup sizes on the strong model; small work runs on the standard one', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script())
  await run(ctx, { config: config(), deps: deps() })
  const model = (l) => ctx.calls.find((c) => c.label === l).opts.model
  assert.equal(model('setup'), 'm-strong')
  assert.equal(model('implement'), 'm-standard')
})

test('a confirmed blocker is fixed, then the round comes back clean', async () => {
  let audits = 0
  const ctx = fakeCtx(SHIP_ARGS, script({ 'audit:': () => (++audits === 1 ? { ...clean, findings: [blocker()] } : clean) }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.equal(r.outcome, 'pr')
  assert.equal(r.rounds.length, 2)
  assert.equal(r.rounds[0].confirmed, 1)
  assert.ok(ctx.calls.some((c) => c.label === 'fix#1'))
  assert.match(ctx.calls.find((c) => c.label === 'fix#1').prompt, /retired orders still return 200/)
  uniqueLabels(ctx)
})

test('a blocker the skeptic refutes costs no fix', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script({ 'audit:': { ...clean, findings: [blocker()] }, 'skeptic:': { refuted: true, why: 'already on main' } }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.equal(r.outcome, 'pr')
  assert.ok(!ctx.calls.some((c) => c.label.startsWith('fix#')))
})

test('a skeptic that dies refutes nothing', async () => {
  let audits = 0
  const ctx = fakeCtx(SHIP_ARGS, script({ 'audit:': () => (++audits === 1 ? { ...clean, findings: [blocker()] } : clean), 'skeptic:': undefined }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.ok(ctx.calls.some((c) => c.label === 'fix#1'))
  assert.equal(r.outcome, 'pr')
})

test('the same finding surviving two fixes hands the ticket back', async () => {
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({ 'audit:': { ...clean, findings: [blocker()] } }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.equal(r.outcome, 'handback')
  assert.match(r.reason, /survived 2 fix attempts/)
  assert.equal(r.open.length, 1)
  uniqueLabels(ctx)
})

test('a small ticket stops at its round limit', async () => {
  let n = 0
  // A different finding every round, so it is never "stuck" — only unfinished.
  const ctx = fakeCtx(SHIP_ARGS, script({ 'audit:': () => ({ ...clean, findings: [blocker({ line: 100 * ++n })] }) }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.equal(r.outcome, 'handback')
  assert.match(r.reason, /still not clean after 2 rounds/)
})

test('a red gate goes to the fixer and spends no audit round', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script())
  const r = await run(ctx, { config: config(), deps: deps({ gates: [red(), green()] }) })
  assert.equal(r.outcome, 'pr')
  assert.equal(r.rounds.length, 2)
  assert.match(r.rounds[0].gate, /^red/)
  assert.match(ctx.calls.find((c) => c.label === 'fix#1').prompt, /OrderControllerTest#retired/)
  assert.equal(ctx.calls.filter((c) => c.label.startsWith('audit:')).length, 1)
})

test('a gate red twice running moves the fixer to the strong model', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script())
  await run(ctx, { config: config(), deps: deps({ gates: [red(), red(), green()] }) })
  assert.equal(ctx.calls.find((c) => c.label === 'fix#1').opts.model, 'm-standard')
  assert.equal(ctx.calls.find((c) => c.label === 'fix#2').opts.model, 'm-strong')
})

test('a red gate that names nothing hands back rather than guessing', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script())
  const r = await run(ctx, { config: config(), deps: deps({ gates: [{ ...red(), steps: [], failedTests: [] }] }) })
  assert.equal(r.outcome, 'handback')
  assert.equal(r.phase, 'Verify')
})

test('an auditor that dies twice hands back: an unfinished audit is not a clean one', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script({ 'audit:': undefined }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.equal(r.outcome, 'handback')
  assert.match(r.reason, /combined auditor could not finish/)
  assert.ok(ctx.calls.some((c) => c.label === 'audit:combined-retry#1'))
})

test('tests that pass without the change become a blocker for the skeptic', async () => {
  let rc = 0
  const d = deps()
  d.redCheck = async () => (++rc === 1 ? { checked: true, failedOnBase: false, tests: ['OrderControllerTest'], reverted: ['src/main/java/Order.java'] } : { checked: true, failedOnBase: true, tests: ['OrderControllerTest'], reverted: [] })
  const ctx = fakeCtx(SHIP_ARGS, script())
  const r = await run(ctx, { config: config(), deps: d })
  assert.match(ctx.calls.find((c) => c.label.startsWith('skeptic:')).prompt, /test-proves-nothing/)
  assert.ok(ctx.calls.some((c) => c.label === 'fix#1'))
  assert.equal(r.outcome, 'pr')
})

test('setup declining stops the run', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script({ setup: { proceed: false, reason: 'asks for two unrelated things', doneWhen: [], sizing: smallFacts } }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.equal(r.outcome, 'declined')
  assert.equal(ctx.calls.length, 1)
})

test('a business rule buys the full loop: its own spec writer and two spec auditors', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script({ setup: { proceed: true, reason: 'x', doneWhen: ['a'], sizing: { ...smallFacts, changesRule: true }, spec } }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.equal(r.size, 'full')
  const labels = ctx.calls.map((c) => c.label)
  assert.ok(labels.includes('write-spec'))
  assert.ok(labels.includes('spec-audit:criteria#1') && labels.includes('spec-audit:fit#1'))
  assert.ok(labels.includes('audit:criteria#1') && labels.includes('audit:rules#1'))
  assert.equal(ctx.calls.find((c) => c.label === 'implement').opts.model, 'm-strong')
})

test('a misread criterion is re-planned before anything is built', async () => {
  let n = 0
  const miss = blocker({ category: 'criterion-unmet', file: 'specs/7-x.md', line: 3, claim: 'the spec returns 410, the ticket says 404' })
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({ 'spec-audit:criteria': () => (++n === 1 ? { ...clean, findings: [miss] } : clean) }))
  await run(ctx, { config: config(), deps: deps() })
  const labels = ctx.calls.map((c) => c.label)
  assert.ok(labels.indexOf('revise-spec#1') < labels.indexOf('implement'))
  uniqueLabels(ctx)
})

test('a small run whose diff reaches a risky path is escalated', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script())
  const r = await run(ctx, { config: config(), deps: deps({ facts: { files: 3, appLines: 40, risky: ['pom.xml'], onlyDocs: false } }) })
  assert.equal(r.size, 'small → full')
  assert.ok(ctx.calls.some((c) => c.label === 'audit:criteria#1'))
  assert.ok(!ctx.calls.some((c) => c.label === 'audit:combined#1'))
  assert.ok(ctx.logs.some((l) => /escalated: the diff touches pom.xml/.test(l)))
})

test('a base that moved under the branch goes to the fixer as a conflict', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script())
  const r = await run(ctx, { config: config(), deps: deps({ syncs: [{ sync: 'conflict', conflicts: ['src/main/java/Order.java'] }] }) })
  assert.match(ctx.calls.find((c) => c.label === 'fix#1').prompt, /conflicts with origin\/main/)
  assert.equal(r.outcome, 'pr')
})

test('an extra lens from the config runs on the tiers it names', async () => {
  const parity = { key: 'parity', tiers: ['full'], ask: 'Compare with the legacy EJB.' }
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script())
  await run(ctx, { config: config({ lenses: { code: [parity], spec: [] } }), deps: deps() })
  assert.match(ctx.calls.find((c) => c.label === 'audit:parity#1').prompt, /legacy EJB/)
  const small = fakeCtx(SHIP_ARGS, script())
  await run(small, { config: config({ lenses: { code: [parity], spec: [] } }), deps: deps() })
  assert.ok(!small.calls.some((c) => c.label.startsWith('audit:parity')))
})

test('learn runs only when the audits caught something, and re-gates after', async () => {
  let audits = 0, gates = 0
  const d = deps(); const g = d.gate; d.gate = async (x) => { gates++; return g(x) }
  const ctx = fakeCtx(SHIP_ARGS, script({
    'audit:': () => (++audits === 1 ? { ...clean, findings: [blocker()] } : clean),
    learn: { lessons: [{ pattern: 'retired states', proposal: 'docs/harness-lessons.md: map retired to 404' }] },
  }))
  const r = await run(ctx, { config: config({ learn: { enabled: true } }), deps: d })
  assert.equal(r.lessons.length, 1)
  assert.equal(gates, 3)
})

test('every agent is told to read the project instructions and never to push', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script())
  await run(ctx, { config: config({ instructions: ['AGENTS.md', 'docs/rules/'] }), deps: deps() })
  for (const c of ctx.calls) {
    assert.match(c.prompt, /`AGENTS.md`, `docs\/rules\/`/)
    assert.match(c.prompt, /Never push/)
  }
})

test('red rounds spend no audit budget: red, then a blocker, then clean still ships a small ticket', async () => {
  let audits = 0
  const ctx = fakeCtx(SHIP_ARGS, script({ 'audit:': () => (++audits === 1 ? { ...clean, findings: [blocker()] } : clean) }))
  const r = await run(ctx, { config: config(), deps: deps({ gates: [red(), green()] }) })
  assert.equal(r.outcome, 'pr')
  assert.equal(r.rounds.length, 3)
  uniqueLabels(ctx)
})

test('a ticket in question after the last spec round hands back, keeping the technical findings too', async () => {
  const scope = blocker({ category: 'scope', file: 'specs/7-x.md', line: 1, claim: 'the ticket asks for 404 and 410' })
  const logic = blocker({ category: 'logic', file: 'specs/7-x.md', line: 20, claim: 'the plan never maps the retired state' })
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({ 'spec-audit:criteria': { ...clean, findings: [scope, logic] } }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.equal(r.outcome, 'handback')
  assert.equal(r.phase, 'Spec Audit')
  assert.deepEqual(r.open.map((f) => f.category), ['scope'])
  assert.deepEqual(r.alsoOpen.map((f) => f.category), ['logic'])
  assert.ok(!ctx.calls.some((c) => c.label === 'implement'))
})

test('the revised spec\'s decisions are the ones the pull request asks about', async () => {
  let n = 0
  const miss = blocker({ category: 'criterion-unmet', file: 'specs/7-x.md', line: 3, claim: 'wrong status' })
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({
    'spec-audit:criteria': () => (++n === 1 ? { ...clean, findings: [miss] } : clean),
    'revise-spec': { ...spec, decisions: ['404 rather than 410 — OK?'] },
  }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.deepEqual(r.spec.decisions, ['404 rather than 410 — OK?'])
})

test('an escalated run gets the config\'s full-tier lenses and more rounds', async () => {
  const parity = { key: 'parity', tiers: ['full'], ask: 'Compare with the legacy EJB.' }
  let n = 0
  const ctx = fakeCtx(SHIP_ARGS, script({ 'audit:': () => ({ ...clean, findings: [blocker({ line: 100 * ++n })] }) }))
  const r = await run(ctx, { config: config({ lenses: { code: [parity], spec: [] } }), deps: deps({ facts: { files: 9, appLines: 400, risky: [], onlyDocs: false } }) })
  assert.ok(ctx.calls.some((c) => c.label === 'audit:parity#1'))
  assert.match(r.reason, /still not clean after 3 rounds/)
})

test('a hand-back learns from what the audits confirmed, and says what was not verified', async () => {
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({
    'audit:': { ...clean, findings: [blocker()] },
    learn: { lessons: [{ pattern: 'retired states', proposal: 'docs/harness-lessons.md' }] },
  }))
  const d = deps({ redCheck: { checked: false, reason: 'commands.testsOnly is not set' } })
  const r = await run(ctx, { config: config({ learn: { enabled: true } }), deps: d })
  assert.equal(r.outcome, 'handback')
  assert.equal(r.lessons.length, 1)
  assert.deepEqual(r.notVerified, ['no red-check ran — commands.testsOnly is not set'])
})

test('a draft does not claim a skeptic refuted the red-check when it did not', async () => {
  const d = deps({ redCheck: { checked: true, failedOnBase: false, tests: ['OrderControllerTest'], reverted: ['src/main/java/Order.java'] } })
  const r = await run(fakeCtx(SHIP_ARGS, script()), { config: config(), deps: d })
  assert.equal(r.outcome, 'handback')
  assert.deepEqual(r.notVerified, ['the new tests pass without the change'])
})

test('red rounds are not counted as audits in the pull request', async () => {
  const { shipPrBody } = await import('../lib/publish.mjs')
  const r = await run(fakeCtx(SHIP_ARGS, script()), { config: config(), deps: deps({ gates: [red(), green()] }) })
  assert.match(shipPrBody(r), /independent audit: clean after 1 spec audit and 1 code audit/)
})

test('learn that dies after committing still gets the gate re-run', async () => {
  let audits = 0, gates = 0
  const d = deps(); const g = d.gate; d.gate = async (x) => { gates++; return g(x) }
  const ctx = fakeCtx(SHIP_ARGS, script({ 'audit:': () => (++audits === 1 ? { ...clean, findings: [blocker()] } : clean), learn: undefined }))
  await run(ctx, { config: config({ learn: { enabled: true } }), deps: d })
  assert.equal(gates, 3)
})

test('a red gate after the lessons commit hands back at Learn', async () => {
  let audits = 0
  const ctx = fakeCtx(SHIP_ARGS, script({
    'audit:': () => (++audits === 1 ? { ...clean, findings: [blocker()] } : clean),
    learn: { lessons: [{ pattern: 'p', proposal: 'q' }] },
  }))
  const r = await run(ctx, { config: config({ learn: { enabled: true } }), deps: deps({ gates: [green(), green(), red()] }) })
  assert.equal(r.outcome, 'handback')
  assert.equal(r.phase, 'Learn')
  uniqueLabels(ctx)
})

test('learn is told whether the findings were fixed, and sees each once', async () => {
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({ 'audit:': { ...clean, findings: [blocker()] }, learn: { lessons: [] } }))
  await run(ctx, { config: config({ learn: { enabled: true } }), deps: deps() })
  const p = ctx.calls.find((c) => c.label === 'learn').prompt
  assert.match(p, /still unfixed/)
  assert.equal(p.match(/retired orders still return 200/g).length, 1)
})

test('a scope finding in the code audit hands back with the rest still listed', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script({ 'audit:': { ...clean, findings: [blocker({ category: 'scope', line: 5 }), blocker()] } }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.equal(r.outcome, 'handback')
  assert.deepEqual(r.open.map((f) => f.category), ['scope'])
  assert.deepEqual(r.alsoOpen.map((f) => f.category), ['logic'])
})

test('every code auditor is told what scope means', async () => {
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script())
  await run(ctx, { config: config(), deps: deps() })
  for (const c of ctx.calls.filter((x) => x.label.startsWith('audit:'))) assert.match(c.prompt, /Use category scope only when the TICKET itself/)
})

test('the same conflict three rounds running is stuck', async () => {
  const conflict = { sync: 'conflict', conflicts: ['pom.xml'] }
  const r = await run(fakeCtx({ ...SHIP_ARGS, size: 'full' }, script()), { config: config(), deps: deps({ syncs: [conflict, conflict, conflict, conflict] }) })
  assert.equal(r.outcome, 'handback')
  assert.match(r.reason, /survived 2 fix attempts/)
})

test('a spec auditor dying twice, the reviser dying and the fixer dying each hand back', async () => {
  const miss = blocker({ category: 'criterion-unmet', file: 'specs/7-x.md', line: 3 })
  const a = await run(fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({ 'spec-audit:fit': undefined })), { config: config(), deps: deps() })
  assert.match(a.reason, /fit auditor could not finish/)
  const b = await run(fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({ 'spec-audit:criteria': { ...clean, findings: [miss] }, 'revise-spec': undefined })), { config: config(), deps: deps() })
  assert.match(b.reason, /spec reviser did not finish/)
  const c = await run(fakeCtx(SHIP_ARGS, script({ 'audit:': { ...clean, findings: [blocker()] }, 'fix#': undefined })), { config: config(), deps: deps() })
  assert.match(c.reason, /fixer did not finish/)
})

test('a forced small run is never escalated', async () => {
  const r = await run(fakeCtx({ ...SHIP_ARGS, size: 'small' }, script()), { config: config(), deps: deps({ facts: { files: 9, appLines: 900, risky: ['pom.xml'], onlyDocs: false } }) })
  assert.equal(r.size, 'small')
})

test('a renamed ticket keeps the spec path of the branch it continues on', async () => {
  const ctx = fakeCtx({ ...SHIP_ARGS, title: 'A completely new title', branch: 'harness/7-return-404-for-a-retired-order', size: 'full' }, script())
  await run(ctx, { config: config(), deps: deps() })
  assert.match(ctx.calls.find((c) => c.label === 'write-spec').prompt, /specs\/7-return-404-for-a-retired-order\.md/)
})

test('a blocker with no file still counts: "nothing satisfies criterion 2" has no file to cite', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script({ 'audit:': { ...clean, findings: [blocker({ file: '', line: undefined, category: 'scope', claim: 'the ticket asks for 404 and 410' })] } }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.equal(r.outcome, 'handback')
  assert.equal(r.open[0].file, '(the ticket)')
})

test('a scope reading merged under a logic one at the same place still hands back', async () => {
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({
    'audit:criteria': { ...clean, findings: [blocker()] },
    'audit:rules': { ...clean, findings: [blocker({ category: 'scope', claim: 'the ticket contradicts itself here' })] },
  }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.equal(r.outcome, 'handback')
  assert.match(r.reason, /ticket itself is in question/)
})

test('a heavy-area ticket is not asked to write a spec in setup', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script())
  await run(ctx, { config: config({ sizing: { areas: { web: 'w', persistence: 'p', harness: 'h' }, heavyAreas: ['harness', 'persistence'] } }), deps: deps() })
  assert.match(ctx.calls[0].prompt, /none of these areas — harness, persistence/)
})

test('red rounds have two rounds of slack, then the run hands back', async () => {
  let n = 0
  const reds = [1, 2, 3, 4, 5].map(() => red({ failedTests: [{ test: `T#${++n}`, error: 'x' }] }))
  const r = await run(fakeCtx(SHIP_ARGS, script()), { config: config(), deps: deps({ gates: reds }) })
  assert.equal(r.outcome, 'handback')
  assert.match(r.reason, /still not clean after 4 rounds/)
})

test('a finding that skips a round starts its streak again', async () => {
  const a = blocker(), b = blocker({ line: 200, claim: 'another' })
  // By round: a, b, a, b — never the same finding twice running, so never stuck.
  const round = (label) => Number(/#(\d+)$/.exec(label)[1])
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({ 'audit:': (label) => ({ ...clean, findings: [round(label) % 2 ? a : b] }) }))
  // Six rounds, so that without the reset `a` would reach three in a row by round five.
  const r = await run(ctx, { config: config({ tiers: { full: { buildRounds: 6, specRounds: 6 } } }), deps: deps() })
  assert.match(r.reason, /still not clean after 6 rounds/)
})

test('two red gates that are not consecutive keep the fixer on its model', async () => {
  let audits = 0
  const ctx = fakeCtx(SHIP_ARGS, script({ 'audit:': () => (++audits === 1 ? { ...clean, findings: [blocker()] } : clean) }))
  await run(ctx, { config: config(), deps: deps({ gates: [red(), green(), red(), green()] }) })
  const fixes = ctx.calls.filter((c) => c.label.startsWith('fix#'))
  assert.equal(fixes.length, 3)
  assert.ok(fixes.every((c) => c.opts.model === 'm-standard'))
})

test('the minors that go into the pull request face a skeptic too', async () => {
  const minor = blocker({ severity: 'minor', claim: 'a log line says 410' })
  const ctx = fakeCtx(SHIP_ARGS, script({ 'audit:': { ...clean, findings: [minor] }, 'skeptic:': { refuted: true, why: 'it says 404' } }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.ok(ctx.calls.some((c) => c.label.startsWith('skeptic:code:0#1-minor')))
  assert.deepEqual(r.minors, [])
})

test('a dead auditor after a fix hands back with that fix listed as not re-verified', async () => {
  let audits = 0
  const ctx = fakeCtx(SHIP_ARGS, script({ 'audit:': () => (++audits === 1 ? { ...clean, findings: [blocker()] } : undefined) }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.match(r.reason, /could not finish/)
  assert.equal(r.alsoOpen.length, 1)
})

test('an escalated run says why in its sizing line', async () => {
  const r = await run(fakeCtx(SHIP_ARGS, script()), { config: config(), deps: deps({ facts: { files: 3, appLines: 40, risky: ['pom.xml'], onlyDocs: false } }) })
  assert.match(r.why, /escalated on its diff: the diff touches pom.xml/)
})

test('an extra lens may be a function of the base ref', async () => {
  const parity = { key: 'parity', tiers: ['full'], ask: (base) => `Compare with legacy against ${base}.` }
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script())
  await run(ctx, { config: config({ lenses: { code: [parity], spec: [] } }), deps: deps() })
  assert.match(ctx.calls.find((c) => c.label === 'audit:parity#1').prompt, /against origin\/main\./)
})

test('a dead auditor after a red gate does not list the red gate as unresolved', async () => {
  const r = await run(fakeCtx(SHIP_ARGS, script({ 'audit:': undefined })), { config: config(), deps: deps({ gates: [red(), green()] }) })
  assert.deepEqual(r.alsoOpen, [])
})

test('spec findings reach Learn, and Learn runs once', async () => {
  const miss = blocker({ category: 'criterion-unmet', file: 'specs/7-x.md', line: 3, claim: 'the spec returns 410' })
  let n = 0
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({ 'spec-audit:criteria': () => (++n === 1 ? { ...clean, findings: [miss] } : clean), learn: { lessons: [] } }))
  await run(ctx, { config: config({ learn: { enabled: true } }), deps: deps() })
  const learns = ctx.calls.filter((c) => c.label === 'learn')
  assert.equal(learns.length, 1)
  assert.match(learns[0].prompt, /the spec returns 410/)
})

test('a forced-full or ship:full ticket is not asked for a spec in setup', async () => {
  const a = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script())
  await run(a, { config: config(), deps: deps() })
  assert.doesNotMatch(a.calls[0].prompt, /also write the spec/)
  const b = fakeCtx({ ...SHIP_ARGS, labels: ['ship:full'] }, script())
  await run(b, { config: config(), deps: deps() })
  assert.doesNotMatch(b.calls[0].prompt, /also write the spec/)
})

test('a lens with its own model slot runs on it', async () => {
  const parity = { key: 'parity', tiers: ['full'], ask: 'x', model: 'light' }
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script())
  await run(ctx, { config: config({ lenses: { code: [parity], spec: [] } }), deps: deps() })
  assert.equal(ctx.calls.find((c) => c.label === 'audit:parity#1').opts.model, 'm-light')
})

test('the stuck rule fires on the third confirmation, not the second', async () => {
  const r = await run(fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({ 'audit:': { ...clean, findings: [blocker()] } })), { config: config(), deps: deps() })
  assert.equal(r.rounds.length, 3)
})

test('an auditor\'s findings are capped at five', async () => {
  const many = [1, 2, 3, 4, 5, 6, 7].map((i) => blocker({ line: i * 100, claim: `problem ${i}` }))
  const ctx = fakeCtx(SHIP_ARGS, script({ 'audit:': { ...clean, findings: many }, 'skeptic:': { refuted: true, why: '' } }))
  await run(ctx, { config: config(), deps: deps() })
  assert.equal(ctx.calls.filter((c) => c.label.startsWith('skeptic:code:') && c.label.endsWith('#1')).length, 5)
})

test('a setup with no criteria hands back', async () => {
  const r = await run(fakeCtx(SHIP_ARGS, script({ setup: { proceed: true, reason: 'x', doneWhen: [], sizing: smallFacts } })), { config: config(), deps: deps() })
  assert.equal(r.outcome, 'handback')
  assert.match(r.reason, /no Done-when criteria/)
})

test('a pull request says the tests fail without the change only when they do', async () => {
  const { shipPrBody } = await import('../lib/publish.mjs')
  const d = deps({ redCheck: { checked: true, failedOnBase: false, tests: ['T'], reverted: ['x'] } })
  const r = await run(fakeCtx(SHIP_ARGS, script({ 'skeptic:': { refuted: true, why: 'a refactor' } })), { config: config(), deps: d })
  assert.equal(r.outcome, 'pr')
  assert.doesNotMatch(shipPrBody(r), /fail without the change/)
})

test('a rules finding in the spec is re-planned, and a revision cannot move the spec', async () => {
  const rule = blocker({ category: 'rules', file: 'specs/7-x.md', line: 5, claim: 'the plan puts logic in the controller' })
  let n = 0
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({
    'spec-audit:criteria': () => (++n === 1 ? { ...clean, findings: [rule] } : clean),
    'revise-spec': { path: 'somewhere/else.md', summary: 's', decisions: [] },
  }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.ok(ctx.calls.some((c) => c.label === 'revise-spec#1'))
  assert.equal(r.spec.path, 'specs/7-x.md')
})

test('the pull request carries at most three minors, the review at most five', async () => {
  const minors = [1, 2, 3, 4, 5, 6].map((i) => blocker({ severity: 'minor', line: i * 100, claim: `note ${i}` }))
  const r = await run(fakeCtx(SHIP_ARGS, script({ 'audit:': { ...clean, findings: minors } })), { config: config(), deps: deps() })
  assert.equal(r.minors.length, 3)
})

test('a run that continues an earlier attempt is told to build on it', async () => {
  const ctx = fakeCtx({ ...SHIP_ARGS, continuing: true, notes: 'Answer to the last hand-back: use 404' }, script())
  await run(ctx, { config: config(), deps: deps() })
  for (const l of ['setup', 'implement']) assert.match(ctx.calls.find((c) => c.label === l).prompt, /earlier attempt at this ticket[\s\S]*Do not start over/)
  const full = fakeCtx({ ...SHIP_ARGS, continuing: true, size: 'full' }, script({ 'audit:': (l) => (l.endsWith('#1') ? { ...clean, findings: [blocker()] } : clean) }))
  await run(full, { config: config(), deps: deps() })
  for (const l of ['write-spec', 'spec-audit:criteria#1', 'fix#1']) assert.match(full.calls.find((c) => c.label === l).prompt, /earlier attempt at this ticket/, l)
  assert.match(ctx.calls[0].prompt, /use 404/)
  const fresh = fakeCtx(SHIP_ARGS, script())
  await run(fresh, { config: config(), deps: deps() })
  assert.doesNotMatch(fresh.calls[0].prompt, /earlier attempt/)
})

test('a fixer that says it cannot resolve the findings hands back with its reason', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script({ 'audit:': { ...clean, findings: [blocker()] }, 'fix#': { ok: false, summary: 'the ticket needs a schema change' } }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.equal(r.outcome, 'handback')
  assert.match(r.reason, /could not resolve them: the ticket needs a schema change/)
  assert.equal(ctx.calls.filter((c) => c.label.startsWith('audit:')).length, 1)
})

test('a spec auditor on a continuing run is told to judge, not to build', async () => {
  const ctx = fakeCtx({ ...SHIP_ARGS, continuing: true, size: 'full' }, script())
  await run(ctx, { config: config(), deps: deps() })
  const p = ctx.calls.find((c) => c.label === 'spec-audit:criteria#1').prompt
  assert.match(p, /Judge the spec and the code as they stand now/)
  assert.match(p, /Change nothing\./)
  assert.doesNotMatch(p, /Do not start over/)
})

test('an escalated run keeps the small tier\'s extra lenses too', async () => {
  const cheap = { key: 'cheap', tiers: ['small'], ask: 'x' }
  const ctx = fakeCtx(SHIP_ARGS, script())
  await run(ctx, { config: config({ lenses: { code: [cheap], spec: [] } }), deps: deps({ facts: { files: 9, appLines: 400, risky: [], onlyDocs: false } }) })
  assert.ok(ctx.calls.some((c) => c.label === 'audit:cheap#1'))
})

test('a spec lens runs on its own model slot', async () => {
  const fit2 = { key: 'legacy', tiers: ['full'], ask: 'x', model: 'light' }
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script())
  await run(ctx, { config: config({ lenses: { code: [], spec: [fit2] } }), deps: deps() })
  assert.equal(ctx.calls.find((c) => c.label === 'spec-audit:legacy#1').opts.model, 'm-light')
})

test('every ticket gets a spec audit, on the strong model, as it gets a code audit', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script())
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.equal(r.size, 'small')
  assert.equal(ctx.calls.find((c) => c.label === 'spec-audit:combined#1').opts.model, 'm-strong')
  assert.equal(r.specRounds.length, 1)
})

test('every confirmed spec blocker is revised and audited again, a gap as much as a misreading', async () => {
  const gap = blocker({ category: 'spec-gap', file: 'specs/7-x.md', line: 12, claim: 'no test named for the empty case' })
  let n = 0
  const ctx = fakeCtx(SHIP_ARGS, script({ 'spec-audit:combined': () => (++n === 1 ? { ...clean, findings: [gap] } : clean) }))
  const r = await run(ctx, { config: config(), deps: deps() })
  const labels = ctx.calls.map((c) => c.label)
  assert.ok(labels.indexOf('revise-spec#1') < labels.indexOf('spec-audit:combined#2'))
  assert.ok(labels.indexOf('spec-audit:combined#2') < labels.indexOf('implement'))
  assert.match(ctx.calls.find((c) => c.label === 'revise-spec#1').prompt, /no test named for the empty case/)
  assert.doesNotMatch(ctx.calls.find((c) => c.label === 'implement').prompt, /no test named for the empty case/)
  assert.equal(ctx.calls.find((c) => c.label === 'revise-spec#1').opts.model, 'm-strong')
  assert.equal(r.outcome, 'pr')
  uniqueLabels(ctx)
})

test('a spec still not clean at its round limit hands back, nothing carried into a build', async () => {
  let n = 0
  const ctx = fakeCtx(SHIP_ARGS, script({ 'spec-audit:combined': () => ({ ...clean, findings: [blocker({ file: 'specs/7-x.md', line: 100 * ++n, claim: `gap ${n}` })] }) }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.equal(r.outcome, 'handback')
  assert.equal(r.phase, 'Spec Audit')
  assert.match(r.reason, /still not clean after 2 rounds/)
  assert.ok(!ctx.calls.some((c) => c.label === 'implement'))
})

test('the same spec finding surviving two revisions hands back', async () => {
  const same = blocker({ category: 'logic', file: 'specs/7-x.md', line: 20, claim: 'the plan never maps the retired state' })
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({ 'spec-audit:criteria': { ...clean, findings: [same] } }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.equal(r.outcome, 'handback')
  assert.match(r.reason, /the same finding survived 2 revisions/)
  assert.equal(ctx.calls.filter((c) => c.label.startsWith('revise-spec')).length, 2)
})

test('a ticket in question hands back from the spec audit at once', async () => {
  const scope = blocker({ category: 'scope', file: 'specs/7-x.md', line: 1, claim: '404 or 410?' })
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({ 'spec-audit:criteria': { ...clean, findings: [scope] } }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.equal(r.outcome, 'handback')
  assert.match(r.reason, /ticket itself is in question/)
  assert.ok(!ctx.calls.some((c) => c.label.startsWith('revise-spec')))
})

test('a spec blocker the skeptic refutes costs no revision; the spec skeptic runs on the spec slot', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script({ 'spec-audit:': { ...clean, findings: [blocker({ file: 'specs/7-x.md', line: 3 })] }, 'skeptic:spec': { refuted: true, why: 'the ticket says so' } }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.ok(!ctx.calls.some((c) => c.label.startsWith('revise-spec')))
  assert.equal(ctx.calls.find((c) => c.label.startsWith('skeptic:spec')).opts.model, 'm-strong')
  assert.equal(r.outcome, 'pr')
})

test('the reviser on a continuing run is told it is continuing, and that the findings justify changing the spec', async () => {
  let n = 0
  const ctx = fakeCtx({ ...SHIP_ARGS, continuing: true }, script({ 'spec-audit:': () => (++n === 1 ? { ...clean, findings: [blocker({ file: 'specs/7-x.md', line: 3 })] } : clean) }))
  await run(ctx, { config: config(), deps: deps() })
  const p = ctx.calls.find((c) => c.label === 'revise-spec#1').prompt
  assert.match(p, /earlier attempt at this ticket/)
  assert.match(p, /reason enough to change the spec/)
})

test('a spec reviser that dies hands back with what it was revising', async () => {
  const gap = blocker({ file: 'specs/7-x.md', line: 3, claim: 'no empty case' })
  const r = await run(fakeCtx(SHIP_ARGS, script({ 'spec-audit:': { ...clean, findings: [gap] }, 'revise-spec': undefined })), { config: config(), deps: deps() })
  assert.match(r.reason, /spec reviser did not finish/)
  assert.deepEqual(r.open.map((f) => f.claim), ['no empty case'])
})

test('a tier with no spec slot still gets the strong model for its spec', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script())
  await run(ctx, { config: config({ tiers: { small: { spec: null } } }), deps: deps() })
  assert.equal(ctx.calls.find((c) => c.label === 'spec-audit:combined#1').opts.model, 'm-strong')
})

test('a full ticket\'s own spec writer runs on the spec slot', async () => {
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script())
  await run(ctx, { config: config({ tiers: { full: { think: 'standard' } } }), deps: deps() })
  assert.equal(ctx.calls.find((c) => c.label === 'write-spec').opts.model, 'm-strong')
})

test('a conflict between red gates does not move the fixer to the strong model', async () => {
  const conflict = { sync: 'conflict', conflicts: ['pom.xml'] }
  const ctx = fakeCtx(SHIP_ARGS, script())
  await run(ctx, { config: config(), deps: deps({ syncs: [conflict], gates: [red(), green()] }) })
  // round 1 conflict, round 2 red: not two reds running.
  assert.equal(ctx.calls.find((c) => c.label === 'fix#2').opts.model, 'm-standard')
})

test('the same problem filed under another category is still stuck', async () => {
  const round = (l) => Number(/#(\d+)$/.exec(l)[1])
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({ 'audit:criteria': (l) => ({ ...clean, findings: [blocker({ category: round(l) % 2 ? 'logic' : 'criterion-unmet' })] }) }))
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.match(r.reason, /survived 2 fix attempts/)
})

test('a full spec writer is told to remove setup\'s draft at another path', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script({ setup: { proceed: true, reason: 'x', doneWhen: ['a'], sizing: { ...smallFacts, changesRule: true }, spec: { path: 'specs/7-other.md', summary: 's', decisions: [] } } }))
  await run(ctx, { config: config(), deps: deps() })
  assert.match(ctx.calls.find((c) => c.label === 'write-spec').prompt, /draft spec at specs\/7-other\.md: delete it/)
})
