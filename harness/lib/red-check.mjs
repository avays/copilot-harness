// Would the branch's tests fail without the branch's code?
//
// A test that passes with or without the change proves nothing, and it is the
// easiest kind for an agent to write — one that exercises a helper the change
// never touched. An auditor asked "did you check?" says yes. This makes the
// check a command: in a scratch worktree of HEAD, put back the base's version
// of every source file the branch changed (removing the ones it added), keep
// the branch's tests, and run only the tests the branch added or changed. At
// least one should fail. The result goes to the skeptic, not straight to a
// verdict: a refactor's tests are meant to pass either way.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, sh, tail } from './exec.mjs'
import { nameStatus, under } from './git.mjs'

/** From `git diff --name-status`, what to revert and which tests to run. */
export function plan(text, config) {
  const code = [], added = [], renamed = [], tests = []
  for (const line of text.split('\n').filter(Boolean)) {
    const [status, ...paths] = line.split('\t')
    const file = paths.at(-1)
    if (status.startsWith('D')) continue
    const isSource = (f) => under(f, config.paths.source)
    if (status.startsWith('R') && isSource(paths[0]) && isSource(file)) { renamed.push({ from: paths[0], to: file }); continue }
    if (under(file, config.paths.tests) && config.tests.isTest(file)) tests.push(config.tests.id(file))
    else if (isSource(file)) (/^[ACR]/.test(status) ? added : code).push(file)
  }
  const applies = Boolean(config.commands.testsOnly) && code.length + added.length + renamed.length > 0 && tests.length > 0
  return { applies, code, added, renamed, tests: [...new Set(tests)] }
}

export async function redCheck({ config, cwd, base, signal }) {
  const p = plan(await nameStatus(base, cwd), config)
  if (!p.applies) {
    return { checked: false, reason: !config.commands.testsOnly ? 'commands.testsOnly is not set' : 'the branch changes no source with a test beside it' }
  }
  const dir = mkdtempSync(join(tmpdir(), 'red-check-'))
  try {
    const add = await git(['worktree', 'add', '--detach', dir, 'HEAD'], { cwd })
    if (add.code !== 0) return { checked: false, reason: `could not make a worktree: ${tail(add.out, 3)}` }
    if (p.code.length) await git(['checkout', base, '--', ...p.code], { cwd: dir })
    for (const f of p.added) rmSync(join(dir, f), { force: true })
    for (const r of p.renamed) { rmSync(join(dir, r.to), { force: true }); await git(['checkout', base, '--', r.from], { cwd: dir }) }
    const cmd = config.commands.testsOnly.replace('{tests}', p.tests.join(','))
    const r = await sh(cmd, { cwd: dir, signal })
    // A compile failure counts as failing on the base: a test that needs the
    // new code to compile cannot pass without it.
    return { checked: true, failedOnBase: r.code !== 0, tests: p.tests, reverted: [...p.code, ...p.added, ...p.renamed.map((x) => x.to)], output: tail(r.out, 20) }
  } finally {
    await git(['worktree', 'remove', '--force', dir], { cwd })
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A red-check that passed on the base → a blocker for the skeptic to judge. */
export function redCheckFinding(r, base) {
  if (!r || !r.checked || r.failedOnBase) return []
  return [{
    severity: 'blocker', category: 'test-proves-nothing', file: r.tests[0] || 'tests',
    claim: 'the tests this branch added or changed pass with its source changes reverted',
    evidence: `red-check reverted ${r.reverted.join(', ')} to ${base} and ran ${r.tests.join(', ')}: none failed`,
    fix: 'add a test that exercises the changed code and fails on the base branch',
  }]
}
