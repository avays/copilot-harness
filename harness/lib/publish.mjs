// What a finished run says on GitHub, composed from the workflow's result.
// Pure functions: the script already holds the gate, the rounds, the spec and
// the criteria, so no agent is spent writing a pull request body.
import { brief } from './findings.mjs'

// Agent-written text, made inert: a closing keyword ("fixes #12") would
// close an unrelated issue when the PR merges, and an @mention would page
// someone. A zero-width joiner keeps it readable and stops GitHub reading it.
const ZWJ = '\u200d'
export const tame = (t) => String(t ?? '')
  .replace(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s+)(?=[\w.-]*\/?[\w.-]*#\d)/gi, `$1${ZWJ}$2`)
  .replace(/@(?=[\w-])/g, `@${ZWJ}`)

const list = (fs) => fs.map((f) => `- **${f.category}** \`${tame(f.file)}${f.line ? ':' + f.line : ''}\` — ${tame(f.claim)}${f.fix ? `\n  *Fix:* ${tame(f.fix)}` : ''}`).join('\n')

function auditTable(r) {
  const rows = [
    ...(r.specRounds || []).map((s) => `| spec ${s.round} | — | ${s.raised} raised · ${s.confirmed} confirmed | ${(s.what || []).map((w) => tame(brief(w))).join('; ') || '—'} |`),
    ...(r.rounds || []).map((b) => `| build ${b.round} | ${b.gate} | ${b.raised} raised · ${b.confirmed} confirmed | ${tame(b.covered) || '—'} |`),
  ]
  return rows.length ? `| Round | Gate | Audit | Covered |\n| --- | --- | --- | --- |\n${rows.join('\n')}` : ''
}

// What the run cost, as Copilot reported it. Every run says, so a team can
// see what a ticket costs before it decides how many to give the harness.
const spend = (u) => (u && u.aiCredits != null
  ? ` ${u.aiCredits.toFixed(2)} AI credits across ${u.subagents} agent${u.subagents === 1 ? '' : 's'}, ${Math.round((u.elapsedMs || 0) / 60000)} min.`
  : '')

export function shipTitle(r) {
  return `${r.title} (#${r.issue})`
}

export function shipPrBody(r) {
  const s = []
  s.push(r.outcome === 'pr'
    ? `Closes #${r.issue}.`
    : `Part of #${r.issue}. **Handed back: ${tame(r.reason)}** (in ${r.phase}). This draft holds what was built; what is still open is listed below.`)
  if (r.spec) {
    s.push(`## Spec\n\n[\`${tame(r.spec.path)}\`](../blob/${r.branch}/${encodeURI(r.spec.path)}) — ${tame(r.spec.summary)}`)
    if (r.spec.decisions && r.spec.decisions.length) s.push(`**Decisions for the reviewer:**\n${r.spec.decisions.map((d) => `- [ ] ${tame(d)}`).join('\n')}`)
  }
  if (r.built) {
    if (r.built.tryIt) s.push(`## Try it\n\n${tame(r.built.tryIt)}`)
    if (r.built.keyFiles && r.built.keyFiles.length) s.push(`## Start here\n\n${r.built.keyFiles.map((k) => `- \`${tame(k.file)}\` — ${tame(k.why)}`).join('\n')}`)
  }
  if (r.outcome === 'pr') {
    // Only audited rounds count as audit: a red gate or a conflict is the
    // machine's catch, not the auditors'.
    const audits = (r.rounds || []).filter((x) => x.audited)
    const fixed = [...audits, ...(r.specRounds || [])].reduce((n, x) => n + (x.confirmed || 0), 0)
    s.push(`## Checks\n\n` + [
      `Gate green: ${r.gate.line}`,
      r.redCheck && r.redCheck.failedOnBase ? 'the new tests fail without the change' : null,
      `independent audit: ${fixed ? `${fixed} problem${fixed === 1 ? '' : 's'} found and fixed, ` : ''}clean after ${audits.length} audit${audits.length === 1 ? '' : 's'}`,
    ].filter(Boolean).map((x) => `- ${x}`).join('\n'))
  }
  if (r.open && r.open.length) s.push(`## Still open\n\n${list(r.open)}`)
  if (r.alsoOpen && r.alsoOpen.length) s.push(`## Also unresolved\n\nNot why it stopped, but the next run must settle these too:\n\n${list(r.alsoOpen)}`)
  if (r.minors && r.minors.length) s.push(`## Notes (minor, confirmed)\n\n${list(r.minors)}`)
  // Always present, so its absence never reads as "nothing to say".
  s.push(`## Not verified\n\n${r.notVerified && r.notVerified.length ? r.notVerified.map((x) => `- ${tame(x)}`).join('\n') : '- Nothing beyond what the checks above cover. The gate, red-check and audits are all a run can prove; a person still judges the change.'}`)
  if (r.lessons && r.lessons.length) s.push(`## Lessons recorded\n\n${r.lessons.map((l) => `- ${tame(l.pattern)} → ${tame(l.proposal)}`).join('\n')}`)
  const table = auditTable(r)
  if (table) s.push(`<details><summary>Every audit round</summary>\n\n${table}\n\n</details>`)
  s.push(`<sub>Sized **${r.size || '?'}** — ${r.why || ''}.${spend(r.usage)} Built by the Copilot harness (harness/workflows/ship.mjs).</sub>`)
  return s.join('\n\n')
}

export function shipIssueComment(r, url) {
  if (r.outcome === 'declined') return `The harness did not start this ticket: ${tame(r.reason)}\n\nEdit the ticket and label it again to retry.`
  if (r.outcome === 'error') return `The harness run failed before it finished: ${tame(r.reason)}\n\nThe job's log has the details. Label the ticket again to retry.`
  if (r.outcome === 'pr') return `Pull request ready for review: ${url}`
  return `Handed back to a person: **${tame(r.reason)}**${url ? ` — draft: ${url}` : ''}.` +
    (r.open && r.open.length ? `\n\nStill open:\n${list(r.open)}` : '') +
    (r.alsoOpen && r.alsoOpen.length ? `\n\nAlso unresolved:\n${list(r.alsoOpen)}` : '') +
    `\n\nAnswer here or fix the ticket, then label it again to continue on the same branch.`
}

export const REVIEW_MARKER = '<!-- harness-review -->'

export function reviewComment(r) {
  const head = r.verdict === 'fail'
    ? `> [!CAUTION]\n> ### Harness review · ${r.blockers.length} blocker${r.blockers.length === 1 ? '' : 's'}`
    : r.confidence === 'low'
      ? `> [!WARNING]\n> ### Harness review · no blockers, **unproven** (low confidence)`
      : `> [!NOTE]\n> ### Harness review · no blockers · ${r.confidence} confidence`
  return [
    head,
    `Judged: ${tame(r.covered) || '—'}`,
    r.missing && r.missing.length ? `**Did not finish:** ${r.missing.join(', ')} — confidence is low because an unread lens is not a passed one.` : '',
    r.blockers.length ? `## Blockers\n\n${list(r.blockers)}` : '',
    r.minors.length ? `## Notes\n\n${list(r.minors)}` : '',
    `<sub>Size ${r.size} · lenses ${r.lenses.join(', ')}.${spend(r.usage)} Advisory: it does not block a merge.</sub>`,
    REVIEW_MARKER,
  ].filter(Boolean).join('\n\n')
}
