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

test('a small ticket: setup writes the spec, one clean audit, a pull request', async () => {
  const ctx = fakeCtx(SHIP_ARGS, script())
  const r = await run(ctx, { config: config(), deps: deps() })
  assert.equal(r.outcome, 'pr')
  assert.equal(r.size, 'small')
  assert.deepEqual(ctx.calls.map((c) => c.label), ['setup', 'implement', 'audit:combined#1'])
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

test('a spec gap is carried to the builder, not re-planned', async () => {
  const gap = blocker({ category: 'spec-gap', file: 'specs/7-x.md', line: 12, claim: 'no test named for the empty case' })
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({ 'spec-audit:criteria': { ...clean, findings: [gap] } }))
  await run(ctx, { config: config(), deps: deps() })
  assert.ok(!ctx.calls.some((c) => c.label.startsWith('revise-spec')))
  assert.match(ctx.calls.find((c) => c.label === 'implement').prompt, /no test named for the empty case/)
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

test('a re-plan still open after the last spec round is carried into the build', async () => {
  const miss = blocker({ category: 'logic', file: 'specs/7-x.md', line: 20, claim: 'the plan never maps the retired state' })
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({ 'spec-audit:criteria': { ...clean, findings: [miss] } }))
  await run(ctx, { config: config(), deps: deps() })
  assert.equal(ctx.calls.filter((c) => c.label.startsWith('revise-spec')).length, 3)
  assert.match(ctx.calls.find((c) => c.label === 'implement').prompt, /the plan never maps the retired state/)
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
