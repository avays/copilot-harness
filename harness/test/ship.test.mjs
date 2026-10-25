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

test('a draft does not claim a skeptic refuted the red-check when it did not', async () => {
  const d = deps({ redCheck: { checked: true, failedOnBase: false, tests: ['OrderControllerTest'], reverted: ['src/main/java/Order.java'] } })
  const r = await run(fakeCtx(SHIP_ARGS, script()), { config: config(), deps: d })
  assert.equal(r.outcome, 'handback')
  assert.deepEqual(r.notVerified, ['the new tests pass without the change'])
})

test('red rounds are not counted as audits in the pull request', async () => {
  const { shipPrBody } = await import('../lib/publish.mjs')
  const r = await run(fakeCtx(SHIP_ARGS, script()), { config: config(), deps: deps({ gates: [red(), green()] }) })
  assert.match(shipPrBody(r), /independent audit: clean after 1 audit\b/)
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

test('a spec blocker at a place already carried is not judged again', async () => {
  const gap = blocker({ category: 'spec-gap', file: 'specs/7-x.md', line: 12, claim: 'no test named for the empty case' })
  const miss = blocker({ category: 'criterion-unmet', file: 'specs/7-x.md', line: 30, claim: 'wrong status' })
  let n = 0
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({ 'spec-audit:criteria': () => (++n === 1 ? { ...clean, findings: [gap, miss] } : { ...clean, findings: [gap] }) }))
  await run(ctx, { config: config(), deps: deps() })
  assert.equal(ctx.calls.filter((c) => c.label.startsWith('skeptic:spec')).length, 2)
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
  const r = await run(ctx, { config: config({ tiers: { full: { buildRounds: 6 } } }), deps: deps() })
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

test('a new blocker on the line of a carried gap is still judged', async () => {
  const gap = blocker({ category: 'spec-gap', file: 'specs/7-x.md', line: 12, claim: 'no empty case' })
  const replan = blocker({ category: 'logic', file: 'specs/7-x.md', line: 30, claim: 'wrong status' })
  const logic = blocker({ category: 'logic', file: 'specs/7-x.md', line: 12, claim: 'the plan maps retired to 200' })
  let n = 0
  // Round 1 carries the gap and re-plans; round 2 raises a new problem on the gap's line.
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script({ 'spec-audit:criteria': () => (++n === 1 ? { ...clean, findings: [gap, replan] } : { ...clean, findings: [gap, logic] }) }))
  await run(ctx, { config: config(), deps: deps() })
  assert.ok(ctx.calls.some((c) => c.label.startsWith('skeptic:spec') && /maps retired to 200/.test(c.prompt)))
})

test('an extra lens may be a function of the base ref', async () => {
  const parity = { key: 'parity', tiers: ['full'], ask: (base) => `Compare with legacy against ${base}.` }
  const ctx = fakeCtx({ ...SHIP_ARGS, size: 'full' }, script())
  await run(ctx, { config: config({ lenses: { code: [parity], spec: [] } }), deps: deps() })
  assert.match(ctx.calls.find((c) => c.label === 'audit:parity#1').prompt, /against origin\/main\./)
})
