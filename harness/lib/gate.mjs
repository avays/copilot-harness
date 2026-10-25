// The gate, as code rather than a report. An agent asked whether the build
// is green is an agent marking its own homework; this runs the commands and
// the exit codes decide.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sh, tail } from './exec.mjs'
import { dirty, head, tampered } from './git.mjs'

/**
 * Failing tests from JUnit XML (Surefire, Failsafe, Gradle, most others).
 * Only reports written after `since`, so a stale report from an earlier
 * build cannot name a failure this one did not have.
 */
export function failedTestsIn(xml) {
  const failed = []
  // What the tests printed is not the verdict: a passing test may log
  // `<error code=…>` or even JUnit XML, and Surefire writes system-out for
  // passing tests, Gradle for whole suites. Dropped from the whole report.
  // CDATA first: text inside it may itself mention <system-out>.
  xml = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<(system-out|system-err)\b(?:[^>]*\/>|[\s\S]*?(?:<\/\1>|$))/g, '')
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = m[2] || ''
    const f = /<(failure|error)(?=[\s>\/])([^>]*)>?([\s\S]*?)(?:<\/\1>|$)/.exec(body)
    if (!f) continue
    const attr = (name) => (new RegExp(`\\b${name}="([^"]*)"`).exec(m[1]) || [])[1] || ''
    const message = (/\bmessage="([^"]*)"/.exec(f[2]) || [])[1] || ''
    const detail = (message || f[3] || '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    failed.push({ test: `${attr('classname')}#${attr('name')}`, error: detail.trim().split('\n').slice(0, 6).join('\n') })
  }
  return failed
}

function reportFiles(dir, since) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir, { recursive: true })) {
    const p = join(dir, String(name))
    // A second's slack: file times can trail the clock, and a fresh report
    // stamped a moment before `since` must not be missed.
    if (p.endsWith('.xml') && statSync(p).mtimeMs >= since - 1000) out.push(p)
  }
  return out
}

/** Report folders, including each module's in a multi-module build. */
function reportDirs(cwd, configured) {
  const dirs = []
  for (const d of configured) {
    dirs.push(join(cwd, d))
    // Multi-module Maven: <module>/target/surefire-reports. One level is
    // enough for most builds; list deeper ones in commands.reports.
    for (const entry of existsSync(cwd) ? readdirSync(cwd, { withFileTypes: true }) : []) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) dirs.push(join(cwd, entry.name, d))
    }
  }
  return [...new Set(dirs)]
}

/** Failing tests in the reports written under `cwd` since `since`. */
export const failedSince = (cwd, config, since) => reportDirs(cwd, config.commands.reports)
  .flatMap((d) => reportFiles(d, since))
  .flatMap((f) => failedTestsIn(readFileSync(f, 'utf8')))

/**
 * Run every gate command in order. Green only if every one exits 0, no report
 * written during the run records a failing test, and the tree is clean
 * afterwards: green on uncommitted changes is green on code the pull request
 * will not contain.
 */

export async function gate({ config, cwd, base, signal }) {
  const started = Date.now()
  const steps = []
  for (const g of config.commands.gate) {
    const r = await sh(g.run, { cwd, signal })
    steps.push({ name: g.name, ok: r.code === 0, code: r.code, tail: r.code === 0 ? '' : tail(r.out) })
    if (r.code !== 0) break
  }
  const failedTests = failedSince(cwd, config, started)
  const isDirty = await dirty(cwd)
  return {
    // A failing test in a report is red even when the command exited 0
    // (maven.test.failure.ignore, a lenient Gradle task).
    ok: steps.every((s) => s.ok) && !failedTests.length && !isDirty,
    sha: await head(cwd),
    dirty: isDirty,
    steps,
    failedTests,
    tampered: await tampered(base, cwd, config),
  }
}

export const gateLine = (g) =>
  g.steps.map((s) => `${s.name} ${s.ok ? 'passed' : `failed (exit ${s.code})`}`).join(' · ') +
  (g.failedTests.length ? ` · ${g.failedTests.length} failing test${g.failedTests.length === 1 ? '' : 's'}` : '') +
  (g.dirty ? ' · uncommitted changes' : '')

/** A red gate → findings a fixer can aim at. None means nothing to aim at. */
export function gateFindings(g) {
  const fix = 'make the gate green without editing, disabling or deleting a test that exists on the base'
  if (g.failedTests.length) {
    return g.failedTests.slice(0, 10).map((t) => ({
      severity: 'blocker', category: 'gate', file: t.test, claim: `gate red: ${t.test}`, evidence: t.error, fix,
    }))
  }
  const red = g.steps.find((s) => !s.ok)
  if (red) return [{ severity: 'blocker', category: 'gate', file: red.name, claim: `gate red: ${red.name} exited ${red.code}`, evidence: red.tail, fix }]
  if (g.dirty) return [{ severity: 'blocker', category: 'gate', file: 'git status', claim: 'the gate ran on uncommitted changes', evidence: 'git status --porcelain is not empty', fix: 'commit the changes that belong to the ticket and discard the rest' }]
  return []
}
