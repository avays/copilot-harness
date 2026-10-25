// What the harness reads from git. The script, not an agent, decides from
// these: an agent asked "is the tree clean?" can be wrong; `git status` can't.
import { git } from './exec.mjs'

export const under = (file, prefixes) => prefixes.some((p) => file === p || file.startsWith(p))

export async function head(cwd) {
  return (await git(['rev-parse', 'HEAD'], { cwd })).stdout.trim()
}

export async function dirty(cwd) {
  return (await git(['status', '--porcelain'], { cwd })).stdout.trim() !== ''
}

/** `git diff --name-status base...HEAD`, as text. */
export async function nameStatus(base, cwd) {
  return (await git(['diff', '--name-status', `${base}...HEAD`], { cwd })).stdout
}

/**
 * Bring today's base into the branch. A merge, not a rebase: the branch may
 * already be pushed, and a rebase would mean a force-push. Two runs started
 * together each open a pull request; once the first merges, the second
 * should be tested against what landed, not against the base it began on.
 */
export async function syncBase(base, cwd) {
  const remote = base.includes('/') ? base.split('/')[0] : 'origin'
  const branch = base.includes('/') ? base.split('/').slice(1).join('/') : base
  await git(['fetch', remote, branch], { cwd })
  const ref = `${remote}/${branch}`
  const m = await git(['merge', '--no-edit', ref], { cwd })
  if (m.code === 0) return { sync: /Already up to date/i.test(m.out) ? 'current' : 'merged', conflicts: [] }
  const conflicts = (await git(['diff', '--name-only', '--diff-filter=U'], { cwd })).stdout.split('\n').filter(Boolean)
  await git(['merge', '--abort'], { cwd })
  return { sync: 'conflict', conflicts: conflicts.length ? conflicts : [ref] }
}

/** The size and reach of a diff, from numstat: what escalation and review sizing read. */
export function diffFacts(numstat, config) {
  let appLines = 0
  const files = [], risky = []
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [add, del, ...rest] = line.split('\t')
    const file = rest.join('\t').replace(/^.*\{.* => (.*)\}.*$/, '$1').replace(/^.* => /, '')
    files.push(file)
    if (under(file, config.paths.risky)) risky.push(file)
    if (under(file, config.paths.source)) appLines += (Number(add) || 0) + (Number(del) || 0)
  }
  return { files: files.length, appLines, risky, onlyDocs: files.length > 0 && files.every((f) => /\.(md|txt|adoc)$/i.test(f)) }
}

export async function facts(base, cwd, config) {
  return diffFacts((await git(['diff', '--numstat', `${base}...HEAD`], { cwd })).stdout, config)
}

/**
 * Lines in the branch's test changes that could weaken a test: an assertion
 * or @Test removed, a @Disabled added. Not a failure — a ticket can change
 * behaviour — so it goes to the auditor whose job is to ask.
 */
export function tamperedFrom(patch, config) {
  const out = []
  let file = ''
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) { file = line.slice(6); continue }
    if (line.startsWith('--- ')) continue
    if (!file || !under(file, config.paths.tests)) continue
    if (line.startsWith('-') && config.tests.weakenedIfRemoved.test(line)) out.push(`${file}: removed ${line.slice(1).trim()}`)
    if (line.startsWith('+') && config.tests.weakenedIfAdded.test(line)) out.push(`${file}: added ${line.slice(1).trim()}`)
  }
  return out
}

export async function tampered(base, cwd, config) {
  return tamperedFrom((await git(['diff', '-U0', `${base}...HEAD`, '--', ...config.paths.tests], { cwd })).stdout, config)
}
