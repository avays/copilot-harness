// Schemas the agents answer in, and the helpers that compare findings across
// lenses and rounds.
//
// Copilot honours a structural subset of JSON Schema: type, required, enum,
// const, properties/items, anyOf/oneOf/allOf. Limits such as maxItems are
// ignored, so the code applies them (MAX_FINDINGS below).

export const MAX_FINDINGS = 5

export const CATEGORIES = [
  'criterion-unmet', 'rules', 'logic', 'test-proves-nothing', 'test-weakened',
  'spec-gap', 'scope', 'gate', 'conflict', 'docs-stale', 'other',
]

export const FINDINGS = {
  type: 'object',
  required: ['findings', 'covered', 'ran'],
  properties: {
    ran: { enum: ['nothing', 'tests', 'build'], description: 'what YOU executed — reading is not running' },
    covered: { type: 'string', description: 'what you were able to judge, under 12 words: it is a table cell' },
    findings: {
      type: 'array',
      description: `at most ${MAX_FINDINGS}. Five blockers in one lens means the approach is wrong, not that it needs five fixes`,
      items: {
        type: 'object',
        required: ['severity', 'category', 'file', 'claim', 'evidence', 'fix'],
        properties: {
          severity: { enum: ['blocker', 'minor'] },
          category: { enum: CATEGORIES },
          file: { type: 'string' },
          line: { type: 'integer' },
          claim: { type: 'string', description: 'what is wrong, in one sentence' },
          evidence: { type: 'string', description: 'the quoted line, the input and wrong output, or the repro' },
          fix: { type: 'string', description: 'what would resolve it, in one sentence' },
        },
      },
    },
  },
}

export const REFUTATION = {
  type: 'object',
  required: ['refuted', 'why'],
  properties: { refuted: { type: 'boolean' }, why: { type: 'string' } },
}

export const SPEC_WRITTEN = {
  type: 'object',
  required: ['path', 'summary', 'decisions'],
  properties: {
    path: { type: 'string' },
    summary: { type: 'string', description: 'two sentences: the approach and how it will be proved' },
    decisions: { type: 'array', items: { type: 'string' }, description: 'choices the ticket left open that you made, each a yes/no question for the reviewer; empty if none' },
  },
}

export const DONE = {
  type: 'object',
  required: ['ok', 'summary'],
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    tryIt: { type: 'string', description: 'implement only: how a reviewer sees the change in a step or two' },
    keyFiles: {
      type: 'array',
      description: 'implement only: the one to three files where the change lives',
      items: { type: 'object', required: ['file', 'why'], properties: { file: { type: 'string' }, why: { type: 'string' } } },
    },
  },
}

export const LESSON = {
  type: 'object',
  required: ['lessons'],
  properties: {
    lessons: {
      type: 'array',
      items: {
        type: 'object',
        required: ['pattern', 'proposal'],
        properties: {
          pattern: { type: 'string', description: 'the class of mistake the audits caught' },
          proposal: { type: 'string', description: 'what was written, and in which file' },
        },
      },
    },
  },
}

export const REVIEW_LENS = {
  type: 'object',
  required: ['confidence', 'covered', 'findings'],
  properties: {
    confidence: { enum: ['high', 'medium', 'low'], description: 'how much of the change your lens could evaluate — coverage, not certainty' },
    covered: { type: 'string', description: 'what you judged, under 12 words' },
    findings: FINDINGS.properties.findings,
  },
}

/** What setup answers: whether to proceed, the criteria, and facts to size by. */
export function setupSchema(config) {
  const s = config.sizing
  return {
    type: 'object',
    required: ['proceed', 'reason', 'doneWhen', 'sizing'],
    properties: {
      proceed: { type: 'boolean' },
      reason: { type: 'string', description: 'why not, if proceed is false; else one line on the ticket' },
      doneWhen: { type: 'array', items: { type: 'string' }, description: 'each acceptance criterion: verbatim where the ticket lists them, else the outcomes it asks for, one per line' },
      // Facts, not a verdict. The script sizes every ticket by one rule from
      // them; a model asked "is this small?" answers in prose and the run
      // falls through to the most expensive loop.
      sizing: {
        type: 'object',
        required: ['areas', 'files', 'changesApi', 'changesRule', 'changesData', 'openQuestions', 'why'],
        properties: {
          areas: {
            type: 'array',
            items: { enum: Object.keys(s.areas) },
            description: 'every part of the repo the change will touch — ' + Object.entries(s.areas).map(([k, v]) => `${k}: ${v}`).join('; '),
          },
          files: { type: 'integer', description: 'roughly how many source files the change edits or adds — not tests, docs or the spec' },
          changesApi: { type: 'boolean', description: s.api },
          changesRule: { type: 'boolean', description: s.rule },
          changesData: { type: 'boolean', description: s.data },
          openQuestions: { type: 'integer', description: 'design decisions the ticket leaves open that the spec will have to settle' },
          why: { type: 'string', description: 'one line: what the change touches' },
        },
      },
      spec: { ...SPEC_WRITTEN, description: 'only when you were told to write the spec and proceeded: the spec you wrote' },
    },
  }
}

// ── Comparing findings ───────────────────────────────────────────────────────
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// Where a finding is, not how it is worded: a fresh auditor rewords the same
// problem every round, so a key built from the claim would never repeat.
export const key = (f) => `${f.category}|${f.file}|${f.line ? Math.floor(f.line / 10) : words(f.claim).slice(0, 60)}`

// One problem, one finding, whichever lens filed it. The exact line, not a
// window: two problems ten lines apart are two findings.
export const where = (f) => `${f.file}|${f.line ? f.line : words(f.claim)}`

// Merge, never drop: another reading of the same place joins it in `also`,
// and the skeptic may refute the place only if every reading is wrong.
// Keeping only the first let a refuted claim take a real one down with it.
//
// The loop routes on a finding's category (scope goes to a person at once),
// so a merged finding leads with its weightiest
// reading: a scope reading filed second must not hide behind a logic one.
const WEIGHT = ['scope', 'criterion-unmet', 'rules', 'logic', 'test-proves-nothing', 'test-weakened', 'gate', 'conflict', 'spec-gap', 'docs-stale', 'other']
const weight = (c) => { const i = WEIGHT.indexOf(c); return i < 0 ? WEIGHT.length : i }

export function dedupe(fs) {
  const m = new Map()
  for (const f of fs) {
    const k = where(f)
    if (!m.has(k)) { m.set(k, { ...f, also: [...(f.also || [])] }); continue }
    let g = m.get(k)
    if (weight(f.category) < weight(g.category)) {
      // The weightier reading leads; the one it displaces joins `also`.
      const { also, ...prev } = g
      g = { ...f, also: [{ category: prev.category, claim: prev.claim, evidence: prev.evidence }, ...also, ...(f.also || [])] }
      m.set(k, g)
      continue
    }
    for (const r of [f, ...(f.also || [])]) {
      if (g.claim !== r.claim && !g.also.some((a) => a.claim === r.claim)) g.also.push({ category: r.category, claim: r.claim, evidence: r.evidence })
    }
  }
  return [...m.values()]
}

export const listFindings = (fs) =>
  fs.map((f, i) => `${i + 1}. [${f.category}] ${f.file}${f.line ? ':' + f.line : ''} — ${f.claim}\n   evidence: ${f.evidence}\n   fix: ${f.fix}` +
    (f.also && f.also.length ? f.also.map((a) => `\n   also, [${a.category}]: ${a.claim} — ${a.evidence}`).join('') : '')).join('\n')

// A table cell, not a report.
export const brief = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > 90 ? t.slice(0, 87).replace(/\s\S*$/, '') + '…' : t
}

/** An agent's findings, capped and with the fields the loop needs. */
// A finding with no file is kept: "nothing satisfies criterion 2" and a
// ticket in question have no file to cite, and dropping them would read as
// a clean audit.
export const findingsOf = (report) =>
  (report && Array.isArray(report.findings) ? report.findings : []).slice(0, MAX_FINDINGS)
    .filter((f) => f && f.claim)
    .map((f) => ({ ...f, file: f.file || '(the ticket)' }))
