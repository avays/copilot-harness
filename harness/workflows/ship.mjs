// ship: one ticket → spec → spec audit → build → gate ⇄ audit → result.
//
// A deterministic script, not a prompt: the loops, the round limits and who
// judges what are code. Every agent is a fresh context that never sees the
// reasoning of the one before it — that independence is what makes an audit
// an audit. The gate and red-check are commands whose exit codes decide;
// no agent is asked whether the build is green.
//
// It runs inside `copilot workflow run harness-ship` (see
// .github/extensions/harness/extension.mjs) and touches nothing on GitHub:
// harness/bin/run.mjs claims the ticket before and publishes the result
// after. The returned object is everything publishing needs.
import { modelFor } from '../lib/config.mjs'
import {
  brief, dedupe, DONE, FINDINGS, findingsOf, key, LESSON, listFindings, REFUTATION, setupSchema, SPEC_WRITTEN, where,
} from '../lib/findings.mjs'
import { gate as runGate, gateFindings, gateLine } from '../lib/gate.mjs'
import { facts as diffFacts, syncBase } from '../lib/git.mjs'
import * as P from '../lib/prompts.mjs'
import { redCheck as runRedCheck, redCheckFinding } from '../lib/red-check.mjs'
import { chooseProfile, escalate } from '../lib/sizing.mjs'

export const meta = {
  name: 'harness-ship',
  description: 'Ticket → spec → spec audit → build → gate and independent audit until clean. ' +
    'args: { issue, title, body, labels, branch, base, workdir, notes?, size? } — run it through harness/bin/run.mjs.',
  phases: [
    { title: 'Setup', detail: 'read the ticket, size it' },
    { title: 'Spec', detail: 'write the spec' },
    { title: 'Spec Audit', detail: 'fresh auditors, revise until clean' },
    { title: 'Implement', detail: 'failing test first, then the change' },
    { title: 'Verify', detail: 'the gate and red-check, every round' },
    { title: 'Code Audit', detail: 'independent auditors, skeptic-verified, fix, repeat' },
    { title: 'Learn', detail: 'what the audits caught becomes a lesson' },
  ],
  argsSchema: {
    type: 'object',
    required: ['issue', 'title', 'branch', 'workdir'],
    properties: {
      issue: { type: 'integer' },
      title: { type: 'string' },
      body: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' } },
      branch: { type: 'string' },
      base: { type: 'string' },
      workdir: { type: 'string' },
      notes: { type: 'string' },
      size: { type: 'string' },
      continuing: { type: 'boolean' },
    },
  },
}

// The same finding confirmed this many rounds running means the fixer cannot
// fix it: hand back early instead of spending the remaining rounds.
const STUCK_AFTER = 2
// Only a spec finding that changes what gets built is worth re-planning for.
// A gap in the plan's detail goes to the builder as a note instead.
const REPLAN = new Set(['criterion-unmet', 'rules', 'logic', 'scope'])

const realDeps = { gate: runGate, redCheck: runRedCheck, sync: syncBase, facts: diffFacts }

export async function run(ctx, { config, deps = realDeps }) {
  const a = ctx.args
  const cwd = a.workdir
  const BASE = `origin/${a.base || config.base}`
  const labelledFull = (a.labels || []).includes(config.github.labels.full)
  const COMMON = P.common(config, cwd)
  // From the branch, not the title: a ticket renamed between attempts
  // continues on its old branch, and must keep its old spec.
  const specPath = `${config.paths.specs}/${a.issue}-${(/^harness\/\d+-(.+)$/.exec(a.branch) || [])[1] || slug(a.title)}.md`
  const m = (slot) => modelFor(config, slot)

  const state = { issue: a.issue, branch: a.branch, title: a.title, size: null, why: '', spec: null, built: null, specRounds: [], rounds: [], minors: [], lessons: [], notVerified: [] }
  // Everything any audit confirmed, across every loop — what Learn works from.
  const history = []
  let T = null, lastRed = null, learned = false

  // What the loop did not prove, said plainly on the PR and on a draft alike:
  // "not verified" is where a reviewer looks first.
  const notVerified = (shipped) => [
    ...(!(lastRed && lastRed.checked) ? [`no red-check ran — ${(lastRed && lastRed.reason) || 'the gate never went green'}`] : []),
    // On a pull request the skeptic refuted it; on a draft it may be the
    // very thing still open, so it must not claim a verdict nobody gave.
    ...(lastRed && lastRed.checked && !lastRed.failedOnBase
      ? [shipped ? 'the new tests also pass without the change (the skeptic refuted that as a defect)' : 'the new tests pass without the change']
      : []),
  ]

  // What the audits kept catching is context the builder did not have. It
  // goes into the docs on this branch, so reviewers see the lesson with the
  // code. A run that could not converge is the one with the most to teach.
  // Returns whether the Learn agent ran: it may have committed even if it
  // died before answering, so the caller re-gates on "ran", not on lessons.
  async function learn(outcome) {
    if (learned || !config.learn.enabled || !history.length) return false
    learned = true
    ctx.phase('Learn')
    const lesson = await ctx.agent(
      `${COMMON}\n\n${P.learnAsk(config, dedupe(history), listFindings, outcome)}`,
      { label: 'learn', schema: LESSON, model: m(T ? T.think : 'standard') },
    )
    state.lessons = (lesson && Array.isArray(lesson.lessons) ? lesson.lessons : [])
    return true
  }

  // `open` is why it stopped; `alsoOpen` is still unresolved but is not the
  // reason — the next run must settle both, so the draft lists both.
  async function handBack(phase, reason, open = [], alsoOpen = []) {
    ctx.log(`handing #${a.issue} back at ${phase}: ${reason}`)
    await learn(`the run stopped at ${phase} (${reason}); some of these are still unfixed`)
    return { outcome: 'handback', phase, reason, open, alsoOpen, ...state, notVerified: notVerified(false) }
  }

  // ── 1. Setup ───────────────────────────────────────────────────────────────
  ctx.phase('Setup')
  const forced = a.size && config.tiers[a.size] ? a.size : null
  const writeSpecInSetup = (forced || 'small') === 'small' && !labelledFull
  const setup = await ctx.agent(
    `${COMMON}\n\n${P.ticketText(a)}\n\n${P.continuing(a, specPath)}${P.setupAsk(config, a, writeSpecInSetup, specPath)}`,
    // The one judgement every later phase is sized by: the strong model.
    { label: 'setup', schema: setupSchema(config), model: m('strong') },
  )
  if (!setup) return handBack('Setup', 'the setup agent did not finish')
  if (!setup.proceed) return { outcome: 'declined', issue: a.issue, reason: setup.reason, branch: a.branch }
  if (!Array.isArray(setup.doneWhen) || !setup.doneWhen.length) return handBack('Setup', 'setup found no Done-when criteria in the ticket')

  T = chooseProfile({ forced, facts: setup.sizing, config, labelledFull })
  // A spec setup wrote for a ticket that sized full is still a spec — but a
  // full ticket gets its own spec writer on the strong model.
  if (T.size !== 'small') setup.spec = null
  state.size = T.size
  state.why = T.why
  ctx.log(`#${a.issue} sized ${T.size} — ${T.why}`)
  const ticket = `${P.ticketText(a)}\n\n${P.criteria(setup.doneWhen)}`

  // ── 2. Spec ────────────────────────────────────────────────────────────────
  ctx.phase('Spec')
  let spec = setup.spec && setup.spec.path ? setup.spec : await ctx.agent(
    `${COMMON}\n\n${ticket}\n\n${P.continuing(a, specPath)}${P.specAsk(config, specPath)}`,
    { label: 'write-spec', schema: SPEC_WRITTEN, model: m(T.think) },
  )
  if (!spec) return handBack('Spec', 'the spec writer did not finish')
  state.spec = spec

  // Run every lens; one that died runs once more, and one that dies twice
  // hands the ticket back. An audit nobody finished is not a clean audit.
  async function audit(lenses, runLens) {
    const first = await ctx.parallel(lenses.map((l) => () => runLens(l, '')))
    const again = await ctx.parallel(lenses.map((l, i) => async () => first[i] || runLens(l, '-retry')))
    return { reports: again.filter((r) => r !== null), missing: lenses.filter((l, i) => !again[i]).map((l) => l.key) }
  }

  async function confirm(findings, what, round) {
    const judged = await ctx.parallel(dedupe(findings).map((f, i) => () =>
      ctx.agent(
        `${COMMON}\n\n${ticket}\n\n${P.skepticAsk({ f, where: what, base: BASE, specPath: spec.path, list: listFindings })}`,
        { label: `skeptic:${what === 'the spec' ? 'spec' : 'code'}:${i}#${round}`, schema: REFUTATION, model: m(T.think) },
      // A skeptic that died refuted nothing: dropping its finding would let
      // a crash read as a clean audit.
      ).then((v) => (v && v.refuted ? null : f))))
    return judged.filter((f) => f !== null)
  }

  // ── 3. Spec Audit ──────────────────────────────────────────────────────────
  // The cheapest place to catch a misreading: nothing is built yet.
  const specLenses = [
    ...Object.entries(P.SPEC_LENSES).map(([k, ask]) => ({ key: k, ask })),
    ...config.lenses.spec.map((l) => ({ ...l, ask: typeof l.ask === 'function' ? l.ask(BASE) : l.ask })),
  ].filter((l) => T.specLenses.includes(l.key) || (l.tiers && l.tiers.includes(T.size)))
  let carried = []
  for (let round = 1; round <= T.specRounds; round++) {
    ctx.phase('Spec Audit')
    const res = await audit(specLenses, (l, retry) => ctx.agent(
      `${COMMON}\n\n${ticket}\n\n${P.continuing(a, spec.path)}${P.specAuditAsk({ lensAsk: l.ask, specPath: spec.path })}`,
      { label: `spec-audit:${l.key}${retry}#${round}`, schema: FINDINGS, model: m(T.think) },
    ))
    if (res.missing.length) return handBack('Spec Audit', `the ${res.missing.join(', ')} auditor could not finish`)
    const found = res.reports.flatMap(findingsOf)
    // A carried gap is still in the spec, so the next round raises it again;
    // only the same problem is skipped, not a new one on the same line.
    const blockers = found.filter((f) => f.severity === 'blocker' && !carried.some((c) => where(c) === where(f) && c.category === f.category))
    const confirmed = blockers.length ? await confirm(blockers, 'the spec', round) : []
    history.push(...confirmed)
    state.specRounds.push({ round, raised: found.length, confirmed: confirmed.length, what: confirmed.map((f) => f.claim) })
    ctx.log(`spec round ${round}: ${found.length} raised, ${confirmed.length} confirmed`)
    carried.push(...confirmed.filter((f) => !REPLAN.has(f.category)))
    const replan = confirmed.filter((f) => REPLAN.has(f.category))
    if (!replan.length) break
    // A person is needed only when the ticket itself is in question.
    if (round === T.specRounds && replan.some((f) => f.category === 'scope')) {
      return handBack('Spec Audit', `the ticket itself is in question after ${round} spec rounds`,
        replan.filter((f) => f.category === 'scope'), [...replan.filter((f) => f.category !== 'scope'), ...carried])
    }
    const revised = await ctx.agent(
      `${COMMON}\n\n${ticket}\n\nIndependent auditors confirmed these problems with ${spec.path}:\n\n${listFindings(replan)}\n\n` +
      `Revise the spec to resolve each one — or, if the ticket itself is wrong, record that under *Decisions*. ` +
      `A technical question the ticket does not settle is yours to decide: decide it and record it under ` +
      `*Decisions*. Commit ("docs(spec): …"). Return decisions as EVERY Decision now in the spec, old and new.`,
      { label: `revise-spec#${round}`, schema: SPEC_WRITTEN, model: m(T.think) },
    )
    if (!revised) return handBack('Spec Audit', 'the spec reviser did not finish', replan)
    // The revision's decisions are the ones the reviewer must answer.
    spec = state.spec = { ...spec, ...revised, path: spec.path }
    // Anything still open after the last round is the builder's to resolve,
    // and the code audit checks that it did.
    if (round === T.specRounds) { carried.push(...replan); break }
  }

  // ── 4. Implement ───────────────────────────────────────────────────────────
  ctx.phase('Implement')
  const built = await ctx.agent(
    `${COMMON}\n\n${ticket}\n\n${P.continuing(a, spec.path)}${P.implementAsk(config, spec.path, carried, listFindings)}`,
    { label: 'implement', schema: DONE, model: m(T.build) },
  )
  if (!built || !built.ok) return handBack('Implement', built ? built.summary : 'the implementer did not finish')
  state.built = built

  // ── 5+6. Verify → Code Audit → Fix, until a round is clean ─────────────────
  const lensesFor = (t) => [
    ...Object.entries(P.CODE_LENSES).map(([k, ask]) => ({ key: k, ask: ask(BASE) })),
    ...config.lenses.code.map((l) => ({ ...l, ask: typeof l.ask === 'function' ? l.ask(BASE) : l.ask })),
  // An escalated small run gets every lens a full run would have had,
  // including the config's full-tier lenses.
  ].filter((l) => t.codeLenses.includes(l.key) || (l.tiers && l.tiers.includes(t.escalated ? 'full' : t.size)))
  let lenses = lensesFor(T)
  // No lens is no audit, and an audit nobody ran is not a clean one.
  if (!lenses.length) return handBack('Code Audit', `the ${T.size} tier names no code lens that exists — check tiers.${T.size}.codeLenses`)
  const streak = new Map()
  let audited = 0, redStreak = 0, gate = null, open = [], minors = []

  for (let round = 1; ; round++) {
    ctx.phase('Verify')
    const sync = await deps.sync(BASE, cwd)
    gate = sync.sync === 'conflict' ? null : await deps.gate({ config, cwd, base: BASE, signal: ctx.signal })

    // Escalate on evidence: the diff, not setup's guess, says what this is.
    const up = escalate(T, await deps.facts(BASE, cwd, config), config)
    if (up) {
      T = up.profile; lenses = lensesFor(T)
      state.size = 'small → full'
      state.why = `${state.why}; escalated on its diff: ${up.reasons.join(', ')}`
      ctx.log(`#${a.issue} escalated: ${up.reasons.join(', ')}`)
    }
    redStreak = gate && gate.ok ? 0 : redStreak + 1
    // A gate red twice running moves the fixer up to the strong model.
    if (redStreak >= 2 && T.build !== config.tiers.full.build) { T = { ...T, build: config.tiers.full.build }; ctx.log('the gate was red twice running — the fixer moves to the strong model') }

    if (sync.sync === 'conflict') {
      // The base moved under the branch. Straight to the fixer; it spends
      // no audit round, and the same conflict twice is stuck.
      open = sync.conflicts.map((file) => ({
        severity: 'blocker', category: 'conflict', file, claim: `conflicts with ${BASE}`,
        evidence: `git merge ${BASE} conflicted in ${file}: the base has moved since this branch began`,
        fix: `git merge ${BASE}; resolve ${file} keeping both this branch's change and what landed; commit the merge`,
      }))
      state.rounds.push({ round, audited: false, gate: `not run — conflicts with ${BASE}`, raised: open.length, confirmed: open.length, covered: '' })
    } else if (!gate.ok) {
      // A red round never reached an auditor, so it does not spend the audit
      // budget — but red rounds only get two extra rounds of slack.
      open = gateFindings(gate)
      if (!open.length) return handBack('Verify', 'the gate is red but names nothing to fix')
      state.rounds.push({ round, audited: false, gate: `red — ${gateLine(gate)}`, raised: open.length, confirmed: open.length, covered: '' })
      ctx.log(`build round ${round}: gate red, ${open.length} to fix`)
    } else {
      audited++
      ctx.phase('Code Audit')
      // Would the new tests fail without the change? A command answers it.
      lastRed = await deps.redCheck({ config, cwd, base: BASE, signal: ctx.signal })
      const res = await audit(lenses, (l, retry) => ctx.agent(
        `${COMMON}\n\n${ticket}\n\n${P.auditAsk({ lensAsk: l.ask, specPath: spec.path, gateLine: gateLine(gate), sha: gate.sha, carried, tampered: gate.tampered, list: listFindings })}`,
        { label: `audit:${l.key}${retry}#${round}`, schema: FINDINGS, model: m(l.model || T.think) },
      ))
      // What the last round confirmed was fixed but never re-audited.
      // A red gate's or a conflict's findings are resolved: this round's gate is green.
      if (res.missing.length) return handBack('Code Audit', `the ${res.missing.join(', ')} auditor could not finish`, [], open.filter((f) => !['gate', 'conflict'].includes(f.category)))
      const raised = [...res.reports.flatMap(findingsOf), ...redCheckFinding(lastRed, BASE)]
      minors = raised.filter((f) => f.severity === 'minor')
      open = await confirm(raised.filter((f) => f.severity === 'blocker'), 'the change', round)
      history.push(...open)
      state.rounds.push({ round, audited: true, gate: gateLine(gate), raised: raised.length, confirmed: open.length,
        covered: res.reports.map((r) => `ran ${r.ran || 'nothing'}: ${brief(r.covered)}`).join(' · ') })
      ctx.log(`build round ${round}: green, ${raised.length} raised, ${open.length} confirmed`)
      if (!open.length) {
        // About to finish: the minors go in the pull request, so they face a
        // skeptic too — a plausible-but-wrong note is still wrong.
        state.minors = await confirm(dedupe(minors).slice(0, 3), 'the change', `${round}-minor`)
        break
      }
    }

    // Once per key per round: several findings in one ten-line window share a key.
    const roundKeys = new Set(open.map(key))
    for (const k of roundKeys) streak.set(k, (streak.get(k) || 0) + 1)
    for (const k of [...streak.keys()]) if (!roundKeys.has(k)) streak.delete(k)
    const stuck = open.filter((f) => streak.get(key(f)) > STUCK_AFTER)
    if (open.some((f) => f.category === 'scope')) {
      return handBack('Code Audit', 'the ticket itself is in question', open.filter((f) => f.category === 'scope'), open.filter((f) => f.category !== 'scope'))
    }
    if (stuck.length) return handBack('Code Audit', `the same finding survived ${STUCK_AFTER} fix attempts`, open)
    if (audited >= T.buildRounds || round >= T.buildRounds + 2) return handBack('Code Audit', `still not clean after ${round} rounds`, open)

    const fixed = await ctx.agent(
      `${COMMON}\n\n${ticket}\n\n${P.continuing(a, spec.path)}${P.fixAsk(config, spec.path, open, listFindings)}`,
      { label: `fix#${round}`, schema: DONE, model: m(T.build) },
    )
    // A fixer that says it cannot resolve them is believed: another gate and
    // audit would only confirm it.
    if (!fixed || !fixed.ok) return handBack('Code Audit', fixed ? `the fixer could not resolve them: ${fixed.summary}` : 'the fixer did not finish', open)
  }

  // ── 7. Learn ───────────────────────────────────────────────────────────────
  // Learn edits docs after the last green gate: re-run it, so the pull
  // request never carries a commit nothing checked.
  if (await learn('the change passed its audit; each of these was fixed')) {
    gate = await deps.gate({ config, cwd, base: BASE, signal: ctx.signal })
    if (!gate.ok) return handBack('Learn', `the gate went red after the lessons commit: ${gateLine(gate)}`, gateFindings(gate))
  }

  return {
    outcome: 'pr', ...state, notVerified: notVerified(true),
    gate: { line: gateLine(gate), sha: gate.sha },
    redCheck: lastRed && lastRed.checked ? { failedOnBase: lastRed.failedOnBase, tests: lastRed.tests } : null,
    doneWhen: setup.doneWhen,
  }
}

export function slug(title) {
  return String(title || 'change').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '') || 'change'
}

export default { meta, run }
