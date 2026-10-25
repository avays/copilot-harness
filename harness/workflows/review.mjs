// review: a pull request → independent lenses → a skeptic on every blocker →
// one verdict with a confidence.
//
// Confidence means coverage, not feeling: how much of the change the lenses
// could actually judge. The weakest lens sets it, and a lens that never
// finished makes the whole review low — an unread lens is not a passed one.
// The verdict advises; it never blocks a merge. Machines gate, agents advise.
import { modelFor } from '../lib/config.mjs'
import { dedupe, findingsOf, listFindings, REFUTATION, REVIEW_LENS } from '../lib/findings.mjs'
import * as P from '../lib/prompts.mjs'

export const meta = {
  name: 'harness-review',
  description: 'Review a pull request against its ticket and the project\'s instructions; every blocker faces a skeptic. ' +
    'args: { pr, title, body, base, workdir, size, ticket? } — run it through harness/bin/run.mjs.',
  phases: [
    { title: 'Review', detail: 'independent lenses read the ticket, then the diff' },
    { title: 'Verify', detail: 'a skeptic tries to refute each blocker' },
  ],
  argsSchema: {
    type: 'object',
    required: ['pr', 'title', 'base', 'workdir', 'size'],
    properties: {
      pr: { type: 'integer' },
      title: { type: 'string' },
      body: { type: 'string' },
      base: { type: 'string' },
      workdir: { type: 'string' },
      size: { enum: ['tiny', 'small', 'large'] },
      ticket: { type: 'object', properties: { number: { type: 'integer' }, title: { type: 'string' }, body: { type: 'string' } } },
    },
  },
}

const LEVELS = ['low', 'medium', 'high']

const LENSES = {
  combined: (base) => P.CODE_LENSES.combined(base),
  criteria: (base) => P.CODE_LENSES.criteria(base),
  rules: (base) => P.CODE_LENSES.rules(base),
  tests: (base) => `Read the tests in \`git diff ${base}...HEAD\`. A blocker is a test that would pass ` +
    `without the change, asserts the implementation against itself, or an existing test weakened, disabled or ` +
    `deleted when the ticket did not ask for that behaviour to change.`,
}

export async function run(ctx, { config }) {
  const a = ctx.args
  const BASE = `origin/${a.base || config.base}`
  const COMMON = P.common(config, a.workdir)
  const m = (slot) => modelFor(config, slot)
  // Which lenses run is decided by the diff's size, never by a model.
  const plan = {
    tiny: { keys: ['combined'], model: 'light' },
    small: { keys: ['combined'], model: 'standard' },
    large: { keys: ['criteria', 'rules', 'tests'], model: 'strong' },
  }[a.size]
  const extra = config.lenses.code.filter((l) => l.tiers && l.tiers.includes(a.size === 'large' ? 'full' : 'small'))
  const lenses = [...plan.keys.map((k) => ({ key: k, ask: LENSES[k](BASE) })), ...extra]
  const ticket = a.ticket
    ? `The pull request is for ticket #${a.ticket.number}: ${a.ticket.title}\n\n${a.ticket.body || ''}`
    : `The pull request names no ticket; judge it against its own description.`

  ctx.phase('Review')
  // No lens sees another's opinion or the PR thread: a stated opinion pulls a
  // reader towards it.
  const lens = (l, retry) => ctx.agent(
    `${COMMON}\n\nReview pull request #${a.pr}: ${a.title}\n\n${a.body || ''}\n\n${ticket}\n\n` +
    `Read the ticket first, then the diff. Your lens only: ${l.ask}\n\n` +
    `A blocker must name a realistic path to harm — who reaches it and what they lose. Anything less is minor. ` +
    `Change no code. Empty is a good answer.`,
    { label: `lens:${l.key}${retry}`, schema: REVIEW_LENS, model: m(l.model || plan.model) },
  )
  const first = await ctx.parallel(lenses.map((l) => () => lens(l, '')))
  const reports = await ctx.parallel(lenses.map((l, i) => async () => first[i] || lens(l, '-retry')))
  const done = reports.filter((r) => r !== null)
  const missing = lenses.filter((l, i) => !reports[i]).map((l) => l.key)

  ctx.phase('Verify')
  // Severity first, then one finding per place: deduping first let a minor
  // filed at a place swallow a blocker another lens filed at the same place.
  const all = done.flatMap(findingsOf)
  const raised = dedupe(all.filter((f) => f.severity === 'blocker'))
  const judged = await ctx.parallel(raised.map((f, i) => () =>
    ctx.agent(
      `${COMMON}\n\n${ticket}\n\n${P.skepticAsk({ f, where: `pull request #${a.pr}`, base: BASE, specPath: 'the spec in the diff, if any', list: listFindings })}`,
      { label: `skeptic:${i}`, schema: REFUTATION, model: m(plan.model) },
    ).then((v) => (v && v.refuted ? null : f))))
  const blockers = judged.filter((f) => f !== null)
  const minors = dedupe(all.filter((f) => f.severity === 'minor'))

  const confidence = missing.length || !done.length ? 'low' : LEVELS[Math.min(...done.map((r) => Math.max(0, LEVELS.indexOf(r.confidence))))]
  return {
    verdict: blockers.length ? 'fail' : 'pass',
    confidence,
    size: a.size,
    lenses: lenses.map((l) => l.key),
    missing,
    covered: done.map((r) => r.covered).filter(Boolean).join(' · '),
    blockers,
    minors: minors.slice(0, 5),
  }
}

export default { meta, run }
