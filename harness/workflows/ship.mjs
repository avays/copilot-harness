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
  brief, dedupe, DONE, FINDINGS, findingsOf, key, LESSON, listFindings, REFUTATION, setupSchema, SPEC_WRITTEN,
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
    ...(!(lastRed && lastRed.checked) ? [`no red-check ran — ${(lastRed && lastRed.reason) || (state.built ? 'the gate never went green' : 'nothing was built')}`] : []),
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
  // The spec's model: writing, auditing, refuting and revising it. A tier that
  // names no spec slot still gets the strong model.
  const specSlot = () => T.spec || 'strong'
  // A spec setup wrote for a ticket that sized full is still a spec — but a
  // full ticket gets its own spec writer on the strong model, which must
  // not leave setup's draft behind under another name.
  const draft = T.size !== 'small' && setup.spec && setup.spec.path && setup.spec.path !== specPath ? setup.spec.path : null
  if (T.size !== 'small') setup.spec = null
  state.size = T.size
  state.why = T.why
  ctx.log(`#${a.issue} sized ${T.size} — ${T.why}`)
  const ticket = `${P.ticketText(a)}\n\n${P.criteria(setup.doneWhen)}`

  // ── 2. Spec ────────────────────────────────────────────────────────────────
  ctx.phase('Spec')
  let spec = setup.spec && setup.spec.path ? setup.spec : await ctx.agent(
    `${COMMON}\n\n${ticket}\n\n${P.continuing(a, specPath)}${P.specAsk(config, specPath)}` +
      (draft ? ` Setup left a draft spec at ${draft}: delete it in the same commit, so the branch holds one spec.` : ''),
    { label: 'write-spec', schema: SPEC_WRITTEN, model: m(specSlot()) },
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
        // The spec loop's skeptic runs on the spec slot, like the rest of that loop.
        { label: `skeptic:${what === 'the spec' ? 'spec' : 'code'}:${i}#${round}`, schema: REFUTATION, model: m(what === 'the spec' ? specSlot() : T.think) },
      // A skeptic that died refuted nothing: dropping its finding would let
      // a crash read as a clean audit.
      // A skeptic that throws refuted nothing either.
      ).then((v) => (v && v.refuted ? null : f), () => f)))
    return judged.filter((f) => f !== null)
  }

  // Both audit loops stop by the same rules: a ticket in question goes to a
  // person at once; the same finding confirmed more than STUCK_AFTER rounds
  // running is stuck; and a loop that reaches its round limit hands back
  // with everything still open. `streaks()` keeps one loop's count.
  function streaks() {
    const streak = new Map()
    // Once per key per round: several findings in one ten-line window share a key.
    return (open) => {
      const keys = new Set(open.map(key))
      for (const k of keys) streak.set(k, (streak.get(k) || 0) + 1)
      for (const k of [...streak.keys()]) if (!keys.has(k)) streak.delete(k)
      return open.filter((f) => streak.get(key(f)) > STUCK_AFTER)
    }
  }
  // `also`: findings fixed but never audited again (the last audit's, when
  // this round only ran the gate), listed on the draft beside what stopped it.
  function settle(phase, open, stuck, { limit, rounds, fixes, also = [] }) {
    if (open.some((f) => f.category === 'scope')) {
      return handBack(phase, 'the ticket itself is in question', open.filter((f) => f.category === 'scope'), open.filter((f) => f.category !== 'scope'))
    }
    if (stuck.length) return handBack(phase, `the same finding survived ${STUCK_AFTER} ${fixes}`, open, also)
    if (limit) return handBack(phase, `still not clean after ${rounds} rounds`, open, also)
    return null
  }

  // ── 3. Spec Audit → Revise, until a round is clean ────────────────────────
  // The same loop as the code audit, run first: the spec decides what gets
  // built, so a misreading caught here costs one revision, not a build. Every
  // confirmed blocker is revised and the revision audited again by fresh
  // auditors; nothing is carried past it to the builder.
  const specLenses = [
    ...Object.entries(P.SPEC_LENSES).map(([k, ask]) => ({ key: k, ask })),
    ...config.lenses.spec.map((l) => ({ ...l, ask: typeof l.ask === 'function' ? l.ask(BASE) : l.ask })),
  ].filter((l) => T.specLenses.includes(l.key) || (l.tiers && l.tiers.includes(T.size)))
  if (!specLenses.length) return handBack('Spec Audit', `the ${T.size} tier names no spec lens that exists — check tiers.${T.size}.specLenses`)
  const specStuck = streaks()
  let lastSpecOpen = []
  for (let round = 1; ; round++) {
    ctx.phase('Spec Audit')
    const res = await audit(specLenses, (l, retry) => ctx.agent(
      `${COMMON}\n\n${ticket}\n\n${P.continuingAudit(a)}${P.specAuditAsk({ lensAsk: l.ask, specPath: spec.path })}`,
      { label: `spec-audit:${l.key}${retry}#${round}`, schema: FINDINGS, model: m(l.model || specSlot()) },
    ))
    // What the last round confirmed was revised but never audited again.
    if (res.missing.length) return handBack('Spec Audit', `the ${res.missing.join(', ')} auditor could not finish`, [], lastSpecOpen)
    const found = res.reports.flatMap(findingsOf)
    const open = await confirm(found.filter((f) => f.severity === 'blocker'), 'the spec', round)
    history.push(...open)
    state.specRounds.push({ round, raised: found.length, confirmed: open.length, what: open.map((f) => f.claim) })
    ctx.log(`spec round ${round}: ${found.length} raised, ${open.length} confirmed`)
    if (!open.length) break
    const stop = settle('Spec Audit', open, specStuck(open), { limit: round >= T.specRounds, rounds: round, fixes: 'revisions' })
    if (stop) return stop
    const revised = await ctx.agent(
      `${COMMON}\n\n${ticket}\n\n${P.continuing(a, spec.path)}${P.reviseAsk(spec.path, open, listFindings)}`,
      { label: `revise-spec#${round}`, schema: SPEC_WRITTEN, model: m(specSlot()) },
    )
    if (!revised) return handBack('Spec Audit', 'the spec reviser did not finish', open)
    lastSpecOpen = open
    // The revision's decisions are the ones the reviewer must answer.
    spec = state.spec = { ...spec, ...revised, path: spec.path }
  }

  // ── 4. Implement ───────────────────────────────────────────────────────────
  ctx.phase('Implement')
  const built = await ctx.agent(
    `${COMMON}\n\n${ticket}\n\n${P.continuing(a, spec.path)}${P.implementAsk(config, spec.path)}`,
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
  ].filter((l) => t.codeLenses.includes(l.key) || (l.tiers && (l.tiers.includes(t.size) || (t.escalated && l.tiers.includes('full')))))
  let lenses = lensesFor(T)
  // No lens is no audit, and an audit nobody ran is not a clean one.
  if (!lenses.length) return handBack('Code Audit', `the ${T.size} tier names no code lens that exists — check tiers.${T.size}.codeLenses`)
  const codeStuck = streaks()
  let lastAudit = []
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
    // A conflict is not a red gate: it leaves the count where it was.
    if (gate) redStreak = gate.ok ? 0 : redStreak + 1
    // A gate red twice running moves the fixer up to the strong model.
    if (redStreak >= 2 && T.build !== config.tiers.full.build) { T = { ...T, build: config.tiers.full.build }; ctx.log('the gate was red twice running — the fixer moves to the strong model') }

    if (sync.sync === 'conflict') {
      // The base moved under the branch. Straight to the fixer; it spends
      // no audit round, and the same conflict three rounds running is stuck.
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
        `${COMMON}\n\n${ticket}\n\n${P.auditAsk({ lensAsk: l.ask, specPath: spec.path, gateLine: gateLine(gate), sha: gate.sha, tampered: gate.tampered, list: listFindings })}`,
        { label: `audit:${l.key}${retry}#${round}`, schema: FINDINGS, model: m(l.model || T.think) },
      ))
      // What the last round confirmed was fixed but never re-audited.
      // A red gate's or a conflict's findings are resolved: this round's gate is green.
      // What the last audit confirmed was fixed but never audited again.
      if (res.missing.length) return handBack('Code Audit', `the ${res.missing.join(', ')} auditor could not finish`, [], lastAudit)
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

    const auditedRound = state.rounds.at(-1) && state.rounds.at(-1).audited
    if (auditedRound) lastAudit = open
    const stop = settle('Code Audit', open, codeStuck(open), { limit: audited >= T.buildRounds || round >= T.buildRounds + 2, rounds: round, fixes: 'fix attempts', also: auditedRound ? [] : lastAudit })
    if (stop) return stop

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
