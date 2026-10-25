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
  // git refuses to merge over uncommitted changes, and that refusal is not a
  // conflict: leave the tree alone and let the gate report it as dirty.
  if (await dirty(cwd)) return { sync: 'dirty', conflicts: [] }
  const remote = base.includes('/') ? base.split('/')[0] : 'origin'
  const branch = base.includes('/') ? base.split('/').slice(1).join('/') : base
  // Inside a CI run the agents' side has no credentials, so on a private
  // repository this fetch fails and the merge uses the base as run.mjs
  // fetched it at the start. That is still today's base, give or take a run.
  await git(['fetch', remote, branch], { cwd })
  const ref = `${remote}/${branch}`
  const m = await git(['merge', '--no-edit', ref], { cwd })
  if (m.code === 0) return { sync: /Already up to date/i.test(m.out) ? 'current' : 'merged', conflicts: [] }
  const conflicts = (await git(['diff', '--name-only', '--diff-filter=U'], { cwd })).stdout.split('\n').filter(Boolean)
  await git(['merge', '--abort'], { cwd })
  return { sync: 'conflict', conflicts: conflicts.length ? conflicts : [ref] }
}

/**
 * `git diff --numstat -z`: "add\tdel\tpath\0", or for a rename
 * "add\tdel\t\0old\0new\0". -z, so no path is quoted (a quoted path would
 * match no prefix); both sides of a rename, so moving a file out of a
 * risky folder counts as touching it.
 */
export function numstatEntries(z) {
  const parts = z.split('\0'), out = []
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue
    const [add, del, path] = parts[i].split('\t')
    if (path) out.push({ add, del, paths: [path] })
    else { out.push({ add, del, paths: [parts[i + 1], parts[i + 2]] }); i += 2 }
  }
  return out
}

/** The size and reach of a diff, from numstat -z: what escalation and review sizing read. */
export function diffFacts(numstatZ, config) {
  let appLines = 0, testLines = 0
  const files = [], risky = []
  for (const { add, del, paths } of numstatEntries(numstatZ)) {
    const file = paths.at(-1)
    files.push(file)
    const hit = paths.find((p) => under(p, config.paths.risky))
    if (hit) risky.push(hit)
    if (under(file, config.paths.source)) appLines += (Number(add) || 0) + (Number(del) || 0)
    else if (under(file, config.paths.tests)) testLines += (Number(add) || 0) + (Number(del) || 0)
  }
  return { files: files.length, appLines, testLines, risky, onlyDocs: files.length > 0 && files.every((f) => /\.(md|txt|adoc)$/i.test(f)) }
}

export async function facts(base, cwd, config) {
  return diffFacts((await git(['diff', '--numstat', '-z', `${base}...HEAD`], { cwd })).stdout, config)
}

/**
 * Lines in the branch's test changes that could weaken a test: an assertion
 * or @Test removed, a @Disabled added. Not a failure — a ticket can change
 * behaviour — so it goes to the auditor whose job is to ask.
 */
export function tamperedFrom(patch, config) {
  const out = []
  let file = ''
  let from = ''
  for (const line of patch.split('\n')) {
    // A deleted file's new side is /dev/null: it is still that test file.
    if (line.startsWith('--- ')) { from = line.slice(6); continue }
    if (line.startsWith('+++ ')) { file = line === '+++ /dev/null' ? from : line.slice(6); continue }
    if (!file || !under(file, config.paths.tests)) continue
    if (line.startsWith('-') && config.tests.weakenedIfRemoved.test(line)) out.push(`${file}: removed ${line.slice(1).trim()}`)
    if (line.startsWith('+') && config.tests.weakenedIfAdded.test(line)) out.push(`${file}: added ${line.slice(1).trim()}`)
  }
  return out
}

export async function tampered(base, cwd, config) {
  return tamperedFrom((await git(['-c', 'core.quotePath=false', 'diff', '-U0', `${base}...HEAD`, '--', ...config.paths.tests], { cwd })).stdout, config)
}
