// How much loop a ticket gets, from facts setup reported. One rule for every
// ticket: small is the base, each risk adds the check that catches it, and
// only a business rule, stored data or a heavy area buys the full loop. How
// long the ticket is does not count; what it risks does.

export function profileFor(facts, config, { labelledFull = false } = {}) {
  const { tiers, sizing } = config
  const areas = new Set(facts.areas || [])
  const heavy = [
    labelledFull && `labelled ${config.github.labels.full}`,
    facts.changesRule && 'changes a business rule',
    facts.changesData && 'changes the schema or stored data',
    ...sizing.heavyAreas.filter((a) => areas.has(a)).map((a) => `touches ${a}`),
  ].filter(Boolean)
  if (heavy.length) return { ...tiers.full, size: 'full', why: heavy.join(', ') }

  const p = { ...tiers.small, size: 'small' }
  const added = []
  const broad = [
    facts.changesApi && 'changes an API',
    areas.size >= sizing.broadAreas && `touches ${areas.size} areas`,
    facts.files >= sizing.broadFiles && `~${facts.files} source files`,
  ].filter(Boolean)
  if (broad.length) {
    p.codeLenses = [...new Set([...p.codeLenses.filter((k) => k !== 'combined'), 'criteria', 'rules'])]
    p.buildRounds = Math.max(p.buildRounds, 3)
    // The spec gets at least as many rounds as the build.
    p.specRounds = Math.max(p.specRounds, p.buildRounds)
    added.push(`${broad.join(', ')} → criteria and rules auditors`)
  }
  if (facts.openQuestions >= 2) {
    p.specRounds = Math.max(p.specRounds, 3)
    added.push(`${facts.openQuestions} open design questions → an extra spec round`)
  }
  return { ...p, why: [facts.why || 'a contained change', ...added].join('; ') }
}

/** A forced size (`--full`, `--small`), or the profile from facts. */
export function chooseProfile({ forced, facts, config, labelledFull }) {
  if (forced && config.tiers[forced]) return { ...config.tiers[forced], size: forced, why: 'forced' }
  if (!facts) return { ...config.tiers.full, size: 'full', why: 'setup reported no sizing facts' }
  return profileFor(facts, config, { labelledFull })
}

/**
 * Setup sized the ticket before any code existed; the diff now says what it
 * is. A small run whose diff reaches a risky path or grew past the line
 * budget gets the auditors and model a full run would have had — escalated
 * on evidence, never on a guess.
 */
export function escalate(profile, diff, config) {
  if (profile.size !== 'small' || profile.escalated || profile.why === 'forced') return null
  const reasons = [
    diff.risky.length && `the diff touches ${diff.risky.slice(0, 3).join(', ')}`,
    diff.appLines > config.sizing.escalateLines && `the diff is ${diff.appLines} source lines`,
  ].filter(Boolean)
  if (!reasons.length) return null
  return {
    profile: {
      ...profile, escalated: true, think: config.tiers.full.think,
      buildRounds: Math.max(profile.buildRounds, 3),
      codeLenses: [...new Set([...profile.codeLenses.filter((k) => k !== 'combined'), ...config.tiers.full.codeLenses])],
    },
    reasons,
  }
}

/** Review size from the diff, never from an agent's word. */
export function reviewSize(diff, config, { labelledFull = false } = {}) {
  const r = config.review
  if (r.depth === 'thorough' || labelledFull) return 'large'
  // Test lines count too: a PR that rewrites tests and no source is the one
  // most likely to weaken them.
  const lines = diff.appLines + (diff.testLines || 0)
  let size = diff.onlyDocs || lines <= r.tinyLines ? 'tiny' : lines <= r.smallLines ? 'small' : 'large'
  if (r.depth === 'fast') size = size === 'large' ? 'small' : 'tiny'
  // After the dial: a risky path is never tiny, and large past half the small budget.
  if (diff.risky.length) size = lines > r.smallLines / 2 ? 'large' : size === 'tiny' ? 'small' : size
  return size
}
