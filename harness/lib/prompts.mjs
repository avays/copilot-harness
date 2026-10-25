// The words every agent is given. Kept in one place so a team adapting the
// harness can see — and change — exactly what agents are told.
//
// The project's own rules are never restated here: agents are pointed at the
// files config.instructions names. That is what lets the harness sit on top
// of a project that already has instructions of its own.

export function common(config, workdir) {
  return [
    `You are working in ${workdir}. Every command runs there.`,
    `Read the project's instructions before anything else: ${config.instructions.map((p) => `\`${p}\``).join(', ')} ` +
      `(whichever exist; a folder means every file in it). They decide how code is written here; where they ` +
      `and this prompt disagree about the code, they win.`,
    config.map ? `Where things live: ${config.map}` : '',
    // Every turn re-reads the agent's whole context. Batched reads are the
    // cheapest saving there is.
    `Each turn re-reads your whole context, so batch: when you know you need several reads, do them in one ` +
      `command. Open source only for the lines you will change or must verify.`,
    `Never push and never use \`gh\` — the harness does both once the work is done.`,
  ].filter(Boolean).join('\n')
}

export const ticketText = (a) =>
  `Ticket #${a.issue}: ${a.title}\n\n${a.body || '(no description)'}` +
  (a.notes ? `\n\nThe person who asked for this run wrote: "${a.notes}". Where it changes what to build, it amends the ticket; where it is about process, it is context.` : '')

// A run on a branch an earlier attempt pushed: build on it, don't redo it.
export const continuing = (a, specPath) => a.continuing
  ? `This branch carries an earlier attempt at this ticket, which a person handed back (their answer, if any, is ` +
    `in the notes above). Build on it: keep ${specPath} and change it only where the ticket or the answer ` +
    `requires, recording why under *Decisions*; tests already committed may pass already, and that is fine — ` +
    `"a test that fails" means one that fails on the base, not on this branch; where the answer changes the ` +
    `behaviour, the earlier attempt's own tests may change with it. Do not start over.\n\n`
  : ''

// The same, for a reader: an auditor judges the earlier attempt, it does not build on it.
export const continuingAudit = (a) => a.continuing
  ? `This branch carries an earlier attempt at this ticket, which a person handed back (their answer, if any, is ` +
    `in the notes above). Judge the spec and the code as they stand now; "a test that fails" means one that ` +
    `fails on the base, not on this branch.\n\n`
  : ''

export const criteria = (doneWhen) => `Done when:\n${doneWhen.map((c) => `- ${c}`).join('\n')}`

export function specAsk(config, path) {
  return `Write the spec at ${path}, following the shape of harness/templates/spec.md. Its *Where* names the ` +
    `files, the functions and the test file, so the builder searches for nothing. Its *How it will be proved* ` +
    `maps every Done-when criterion to a test that fails today and passes once built. Record each choice the ` +
    `ticket left open under *Decisions*. Commit it on its own as "docs(spec): …" and write no code. Return each ` +
    `Decision as a yes/no question for the reviewer.`
}

export function setupAsk(config, a, writeSpec, specPath) {
  return `Read the ticket and the code it would change, then decide whether it can be built. Stop ` +
    `(proceed=false) if it states no outcome a test could be written against, or asks for two unrelated ` +
    `things. Write no code.\n\n` +
    `Report the sizing facts about the change the ticket needs — what it touches and what it risks, not how ` +
    `long the ticket is. Open the files the change would land in before you answer: a guessed fact sizes the ` +
    `whole run wrong. Most tickets are small.` +
    // The same rule sizing.mjs applies: a ticket that buys the full loop gets
    // its own spec writer, so setup must not write one it would throw away.
    (writeSpec ? `\n\nIf you proceed and the change touches no business rule, no stored data and none of these areas — ` +
      `${config.sizing.heavyAreas.join(', ')} — also write the spec: ${specAsk(config, specPath)} Return it as spec.` : '')
}

export function implementAsk(config, specPath, carried, list) {
  return `Implement ${specPath}. Its *Where* is your map: open those files directly. Write the test first and ` +
    `confirm it fails for the reason you expect, then commit it on its own, red, as "test(…)" — that commit is ` +
    `the evidence the test proves something. Then make the change` +
    (config.commands.quick ? `, running \`${config.commands.quick}\` after each edit` : '') + `. ` +
    `Every state the change adds gets its own assertion: each branch, the empty case, the error path. Commit in ` +
    `the project's commit convention and leave \`git status\` clean. Do not run the full gate — the harness ` +
    `runs it next. Return ok=false only if you hit something you cannot resolve; the summary names the proving ` +
    `test and the files changed. Return tryIt (how a reviewer sees the change) and keyFiles (the one to three ` +
    `files where it lives).` +
    (carried.length ? `\n\nThe spec audit left these open; resolve each in the build, and say how in the summary:\n${list(carried)}` : '')
}

export function fixAsk(config, specPath, open, list) {
  return `The spec is ${specPath}. These were independently confirmed against your branch:\n\n${list(open)}\n\n` +
    `Fix each at its cause. Never edit an existing test to make it pass, and never disable or delete one. If a ` +
    `finding shows the spec was wrong, fix the spec too and say so in the summary.` +
    (config.commands.quick ? ` Run \`${config.commands.quick}\` after each edit;` : '') +
    ` do not run the full gate. Commit, and leave \`git status\` clean.`
}

export const SPEC_LENSES = {
  combined: `Does every Done-when criterion map to a test that would fail today and pass once built — and does ` +
    `the plan contradict anything the project's instructions decide, or name files that do not exist or do ` +
    `not own what it says?`,
  criteria: `Does every Done-when criterion map to a test that would fail today and pass once built? Is ` +
    `anything in the spec not asked for by the ticket?`,
  fit: `Does the plan contradict anything the project's instructions decide? Do the files it names exist and ` +
    `own what it says they own?`,
}

export const CODE_LENSES = {
  combined: (base) => `Read the ticket first, then the spec — on a small ticket nobody else has checked that ` +
    `it reads the ticket right: a misreading is criterion-unmet, a ticket that contradicts itself is scope. Then ` +
    `\`git diff ${base}...HEAD\`. For each Done-when criterion, find what satisfies it and the test that ` +
    `proves it: one with nothing satisfying it is a blocker, and so is a test that would pass before the change, ` +
    `or an existing test weakened when the ticket did not ask for that (test-weakened). Then the diff against ` +
    `the project's instructions: a rule it breaks (quote the rule and the line) is category rules; a logic ` +
    `error needs an input and the wrong output it produces.`,
  criteria: (base) => `Read the ticket first, then the spec, then \`git diff ${base}...HEAD\`. For each ` +
    `Done-when criterion, find what satisfies it and the test that proves it. A criterion with nothing ` +
    `satisfying it is a blocker. So is a test that would pass before the change, or asserts the implementation ` +
    `against itself, or an existing test weakened (test-weakened) when the ticket did not ask for it.`,
  rules: (base) => `Read \`git diff ${base}...HEAD\` against the project's instructions. A blocker is a rule ` +
    `they record being broken — quote the rule and the line. Also: a logic error, with an input and the wrong ` +
    `output it produces.`,
}

export function auditAsk({ lensAsk, specPath, gateLine, sha, carried, tampered, list }) {
  return `You are auditing a change you did not write. The spec is ${specPath}. ${lensAsk}\n\n` +
    `The gate has just run green at ${sha.slice(0, 7)}: ${gateLine}. Do not re-run it — read the tests instead; ` +
    `run a command only to prove one specific claim.\n\n` +
    (carried.length ? `The spec audit left these for the build to resolve — a blocker if any is still unresolved:\n${list(carried)}\n\n` : '') +
    (tampered.length ? `The gate flagged these test lines as removed assertions or added skips:\n${tampered.join('\n')}\n\n` : '') +
    `Blockers only for something that would change a merge decision; everything else is minor. Use ` +
    `category scope only when the TICKET itself contradicts itself or cannot be built as written — that goes ` +
    `to a person. Work the ticket did not ask for is a fixable defect: file it as criterion-unmet or rules, ` +
    `not scope. Change no code. Empty is a good answer.`
}

export function specAuditAsk({ lensAsk, specPath }) {
  return `You are auditing a spec you did not write: ${specPath}. ${lensAsk}\n\nYou are judging the plan, not ` +
    `building it: open source only for a line the spec cites, and do not run the build — the gate proves ` +
    `whether it works. Blockers only for something that would make the change wrong or unprovable; everything ` +
    `else is minor. Use category scope only when the TICKET itself is contradictory, unclear about what to ` +
    `build, or impossible as written — that goes to a person; a flaw in the plan is spec-gap or logic, and ` +
    `work in the spec the ticket did not ask for is criterion-unmet, not scope. Cite ` +
    `file and line. Change nothing. Empty is a good answer.`
}

// Every blocker faces a skeptic before it costs a fix round. A false positive
// is worse here than on a review comment: the fixer will obediently "fix"
// correct code, and the next audit will flag the damage.
export function skepticAsk({ f, where, base, specPath, list }) {
  // A finding about the spec is about what the spec says, so "the spec shows
  // it was deliberate" would refute every one of them.
  // "Already on the base" refutes a defect the change did not introduce; it
  // can never refute a missing criterion, whose absence is on the base by
  // definition, and means nothing for a finding about the spec.
  const already = where === 'the spec' ? '' : `if the defect already exists on ${base} and the ticket did not ask to ` +
    `change it (a missing Done-when criterion is never "already on the base"), `
  const deliberate = where === 'the spec'
    ? `or if the project's instructions show it was deliberate.`
    : `or if the instructions or the spec (${specPath}) *as first committed* show it was deliberate. A later ` +
      `edit to the spec does not make a missed criterion deliberate.`
  return `An auditor claims this ${f.severity === 'minor' ? 'minor problem' : 'blocker'} in ${where}. Try to ` +
    `REFUTE it. Open the cited file and line yourself. Refute if the line does not say what is claimed, ` +
    `${already}if it is style rather than a defect, if its fix would contradict the project's instructions, ` +
    `${deliberate} If you cannot tell, it is NOT refuted.` +
    (f.also && f.also.length ? ` Several auditors read this place differently ("also" below): refute only if EVERY reading is wrong.` : '') +
    `\n\n${list([f])}`
}

export function learnAsk(config, history, list, outcome) {
  return `Independent audits of this branch confirmed these problems — ${outcome}:\n\n${list(history)}\n\n` +
    `Which of them is a class of mistake the next ticket could repeat — something the project's instructions ` +
    `did not tell the builder? For each, add one or two plain sentences to ${config.paths.lessons} (create it if ` +
    `needed): the rule, and why, in the voice of the project's docs. Skip one-off slips. Commit as ` +
    `"docs(lessons): …". Return what you wrote; an empty list is a good answer.`
}
