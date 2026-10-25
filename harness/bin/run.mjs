#!/usr/bin/env node
// The one entry point, on a laptop and in GitHub Actions alike:
//
//   node harness/bin/run.mjs ship <issue> [--full|--small] [--notes "…"] [--no-publish]
//   node harness/bin/run.mjs review <pr> [--no-publish]
//
// Three steps, and only the middle one is AI:
//   1. prepare — read the ticket, claim it, make the branch (gh + git)
//   2. run     — `copilot workflow run harness-ship|harness-review`, headless
//   3. publish — push, open the pull request, label, comment (gh + git)
// The workflow inside Copilot never holds a GitHub token and never pushes.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../lib/config.mjs'
import { git } from '../lib/exec.mjs'
import { facts } from '../lib/git.mjs'
import * as GH from '../lib/github.mjs'
import { REVIEW_MARKER, reviewComment, shipIssueComment, shipPrBody, shipTitle } from '../lib/publish.mjs'
import { reviewSize } from '../lib/sizing.mjs'
import { slug } from '../workflows/ship.mjs'

const CI = Boolean(process.env.GITHUB_ACTIONS)

/** The command line `copilot workflow run` needs. Global options come first. */
export function copilotArgv(config, workflow, argsFile, resultFile) {
  return [
    ...config.copilot.flags,
    ...config.copilot.allowTools.map((t) => `--allow-tool=${t}`),
    ...config.copilot.denyTools.map((t) => `--deny-tool=${t}`),
    'workflow', 'run', workflow,
    '--args', `@${argsFile}`,
    '--result-file', resultFile,
    '--output-format', 'json',
  ]
}

/**
 * The run's status and spend, from the JSONL `copilot workflow run` prints.
 * `workflow.run_settled` carries what the run consumed, in nano-AIU (AI
 * credits × 10⁹), counting every subagent.
 */
export function readEvents(jsonl) {
  let status = null, usage = null
  for (const line of String(jsonl).split('\n')) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'workflow.run_settled' && e.data) {
      usage = { subagents: e.data.consumedSubagents ?? null, aiCredits: e.data.consumedNanoAiu != null ? e.data.consumedNanoAiu / 1e9 : null, elapsedMs: e.data.elapsedMs ?? null }
      status = e.data.status || status
    }
    if (e.type === 'workflow.result' && e.data && e.data.run) status = e.data.run.status || status
  }
  return { status, usage }
}

function parseArgv(argv) {
  const [cmd, num, ...rest] = argv
  const opt = { cmd, n: Number(String(num || '').replace(/^#/, '')), size: null, notes: '', publish: true }
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--full' || rest[i] === '--small') opt.size = rest[i].slice(2)
    else if (rest[i] === '--notes') opt.notes = rest[++i] || ''
    else if (rest[i] === '--no-publish') opt.publish = false
  }
  return opt
}

async function repoRoot() {
  const r = await git(['rev-parse', '--show-toplevel'], { cwd: process.cwd() })
  if (r.code !== 0) throw new Error('run this inside the repository')
  return r.stdout.trim()
}

/** .harness/ holds run folders and local worktrees; it ignores itself. */
function runDir(root, name) {
  const dir = join(root, '.harness', 'runs', `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(dir, { recursive: true })
  const ignore = join(root, '.harness', '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  return dir
}

async function must(args, cwd, what) {
  const r = await git(args, { cwd })
  if (r.code !== 0) throw new Error(`${what}: ${r.out.trim()}`)
  return r.stdout.trim()
}

// Tokens the agents must never see. Copilot authenticates with
// COPILOT_GITHUB_TOKEN, which it redacts itself; a GitHub token in an agent's
// shell would let it push or write to GitHub on its own.
const GITHUB_TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'HARNESS_GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']

export function copilotEnv(env) {
  const out = { ...env, GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'true', COPILOT_AUTO_UPDATE: 'false' }
  for (const k of GITHUB_TOKENS) delete out[k]
  return out
}

/** Run the workflow headless; the result file, or an error result. */
function runCopilot(config, workflow, args, dir, cwd) {
  const argsFile = join(dir, 'args.json'), resultFile = join(dir, 'result.json')
  writeFileSync(argsFile, JSON.stringify(args, null, 2))
  const argv = copilotArgv(config, workflow, argsFile, resultFile)
  console.error(`harness: ${config.copilot.bin} ${argv.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ')}`)
  return new Promise((done) => {
    const p = spawn(config.copilot.bin, argv, {
      cwd,
      // Project extensions load headless only with the opt-in copilotEnv
      // sets. It lets the checked-out .github/extensions code run, so only on
      // trusted code.
      env: copilotEnv(process.env),
      // npm installs copilot as a .cmd shim on Windows, which needs a shell.
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let out = ''
    p.stdout.on('data', (d) => { out += d; process.stderr.write(d) })
    p.on('error', (e) => done({ outcome: 'error', reason: `could not start ${config.copilot.bin}: ${e.message}` }))
    p.on('close', (code) => {
      writeFileSync(join(dir, 'stdout.jsonl'), out)
      const { status, usage } = readEvents(out)
      // Exit 0 is the only case where the result file is this run's; a
      // failed run leaves any earlier file untouched.
      if (code === 0 && existsSync(resultFile)) return done({ ...JSON.parse(readFileSync(resultFile, 'utf8')), usage })
      done({ outcome: 'error', usage, reason: `copilot workflow run exited ${code}${status ? ` (${status})` : ''}` + (code === 2 ? ' — workflow not found or arguments invalid: is .github/extensions/harness/ on this branch?' : '') })
    })
  })
}

/**
 * Push what the run built. In Actions the checkout keeps no credentials
 * (persist-credentials: false) and git authenticates through `gh auth
 * setup-git`, which needs GH_TOKEN — present here, stripped from the agents'
 * environment. So this can push, and nothing an agent runs can.
 */
async function push(workdir, branch) {
  const r = await git(['push', '-u', 'origin', `HEAD:refs/heads/${branch}`], { cwd: workdir })
  if (r.code === 0) return
  const why = /refusing to allow .* workflow/i.test(r.out)
    ? 'the change edits .github/workflows/, which GITHUB_TOKEN may not push — set a HARNESS_GH_TOKEN with the workflow scope (ADAPTING.md §6)'
    : r.out.trim().split('\n').slice(-3).join(' ')
  throw new Error(`git push: ${why}`)
}

/**
 * The branch for an issue: the one an earlier attempt pushed, if any, so a
 * renamed ticket continues where it stopped instead of starting a second PR.
 */
async function branchFor(n, title, root) {
  const heads = (await git(['ls-remote', '--heads', 'origin', `harness/${n}-*`], { cwd: root })).stdout
  const found = heads.split('\n').map((l) => l.split('\trefs/heads/')[1]).filter(Boolean)
  return { branch: found[0] || `harness/${n}-${slug(title)}`, onRemote: found.length > 0 }
}

/** The laptop workspace: a worktree per issue, reused only if it is the right one. */
async function worktreeFor(root, workdir, branch, onRemote, base) {
  await git(['worktree', 'prune'], { cwd: root })
  if (existsSync(workdir)) {
    const on = await must(['rev-parse', '--abbrev-ref', 'HEAD'], workdir, 'git rev-parse')
    if (on !== branch) throw new Error(`${workdir} holds ${on}, not ${branch} — remove it (git worktree remove ${workdir}) and run again`)
    if ((await git(['status', '--porcelain'], { cwd: workdir })).stdout.trim()) throw new Error(`${workdir} has uncommitted changes — commit or discard them first`)
  } else {
    const local = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root })).code === 0
    // A local branch from an earlier --no-publish run keeps its commits.
    if (local) await must(['worktree', 'add', workdir, branch], root, 'git worktree add')
    else await must(['worktree', 'add', '-b', branch, workdir, onRemote ? `origin/${branch}` : `origin/${base}`], root, 'git worktree add')
  }
  // Pick up what a CI attempt pushed since; refuse to rewrite diverged work.
  if (onRemote) await must(['merge', '--ff-only', `origin/${branch}`], workdir, `git merge --ff-only origin/${branch} (the local branch has diverged from the pushed one)`)
}

// ── ship ─────────────────────────────────────────────────────────────────────
async function ship(opt, root, config) {
  const L = config.github.labels
  const t = await GH.issue(opt.n, root)
  if (t.state !== 'OPEN') return console.error(`#${opt.n} is ${t.state.toLowerCase()} — nothing to do`)
  const base = config.base
  await must(['fetch', 'origin', base], root, `git fetch origin ${base}`)
  const { branch, onRemote } = await branchFor(opt.n, t.title, root)
  const existing = await GH.openPrFor(branch, root)
  if (existing && !existing.isDraft) return console.error(`#${opt.n} already has a ready pull request: ${existing.url}`)
  // Claim it: the label swap is what stops a second run starting on it. A
  // --no-publish run writes nothing to GitHub, so it does not claim.
  if (opt.publish) await GH.relabel(opt.n, { add: [L.working], remove: [L.ready, L.stuck, L.done] }, root)

  // From here on, whatever goes wrong, the ticket must not be left looking
  // claimed: a failure is said on the issue and handed to a person.
  const fail = async (reason) => {
    console.error(`harness: ${reason}`)
    process.exitCode = 1
    if (!opt.publish) return
    await GH.comment(opt.n, shipIssueComment({ outcome: 'error', reason }), root).catch(() => {})
    await GH.relabel(opt.n, { add: [L.stuck], remove: [L.working] }, root).catch(() => {})
  }

  let workdir = root, result
  try {
    if (onRemote) await must(['fetch', 'origin', branch], root, `git fetch origin ${branch}`)
    // In Actions the runner is the isolation; on a laptop a worktree keeps
    // the person's own checkout untouched.
    if (CI) await must(['checkout', '-B', branch, onRemote ? `origin/${branch}` : `origin/${base}`], root, 'git checkout')
    else await worktreeFor(root, workdir = join(root, '.harness', 'worktrees', `issue-${opt.n}`), branch, onRemote, base)
    if (onRemote) console.error(`continuing on ${branch}, from an earlier attempt`)

    const dir = runDir(root, `ship-${opt.n}`)
    result = await runCopilot(config, 'harness-ship', {
      issue: opt.n, title: t.title, body: t.body || '', labels: t.labels, branch, base, workdir,
      ...(opt.notes ? { notes: opt.notes } : {}), ...(opt.size ? { size: opt.size } : {}),
    }, dir, workdir)
    result.issue ??= opt.n
    result.branch ??= branch
    result.title ??= t.title
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2))
    console.error(`harness: ${result.outcome}${result.reason ? ` — ${result.reason}` : ''} (run folder ${dir})`)
    if (!CI) console.error(`the worktree stays at ${workdir}; remove it with: git worktree remove ${workdir}`)
    if (!opt.publish) return result
    await publishShip(result, { root, workdir, base, branch, existing, config })
    return result
  } catch (e) {
    await fail(e.message)
    return result
  }
}

async function publishShip(result, { root, workdir, base, branch, existing, config }) {
  const L = config.github.labels, n = result.issue
  if (result.outcome === 'declined' || result.outcome === 'error') {
    await GH.comment(n, shipIssueComment(result), root)
    await GH.relabel(n, { add: [L.stuck], remove: [L.working] }, root)
    return
  }
  // pr or handback: push what was built, and put it in front of a person.
  const ahead = Number(await must(['rev-list', '--count', `origin/${base}..HEAD`], workdir, 'git rev-list'))
  // A "pull request" with nothing in it is not one.
  if (ahead === 0 && result.outcome === 'pr') Object.assign(result, { outcome: 'handback', phase: 'PR', reason: 'the run finished with no commits to push' })
  let url = existing ? existing.url : ''
  if (ahead > 0) {
    await push(workdir, branch)
    const draft = result.outcome !== 'pr'
    const body = shipPrBody(result)
    if (existing) {
      await GH.editPr(Number(existing.url.split('/').pop()), body, root)
      if (!draft && existing.isDraft) await GH.markReady(Number(existing.url.split('/').pop()), root)
    } else {
      url = await GH.createPr({ base, head: branch, title: shipTitle(result), body, draft }, root)
    }
    const prNumber = Number(url.trim().split('/').pop())
    await GH.relabel(prNumber, {
      add: [draft ? L.stuck : L.done, ...(String(result.size).includes('full') ? [L.full] : [])],
      remove: [draft ? L.done : L.stuck],
    }, root)
    // A pull request opened with GITHUB_TOKEN starts no workflow by itself;
    // workflow_dispatch is the documented exception. With a PAT the PR's own
    // event starts the review, and a dispatch would start a second one.
    if (!draft && CI && config.github.reviewWorkflow && process.env.HARNESS_USES_PAT !== 'true') {
      await GH.dispatch(config.github.reviewWorkflow, { pr: prNumber }, root).catch((e) => console.error(`could not start the review: ${e.message}`))
    }
  }
  await GH.comment(n, shipIssueComment(result, url), root)
  await GH.relabel(n, { add: [result.outcome === 'pr' ? L.done : L.stuck], remove: [L.working] }, root)
}

// ── review ───────────────────────────────────────────────────────────────────
async function review(opt, root, config) {
  const p = await GH.pr(opt.n, root)
  if (p.isDraft) return console.error(`#${opt.n} is a draft — reviewed once it is marked ready`)
  await must(['fetch', 'origin', p.baseRefName], root, 'git fetch base')
  let workdir = root
  if (!CI) {
    workdir = join(root, '.harness', 'worktrees', `pr-${opt.n}`)
    // A named ref, not FETCH_HEAD: FETCH_HEAD belongs to one worktree, so a
    // second review could not see what the main checkout fetched.
    const ref = `refs/harness/pr-${opt.n}`
    await must(['fetch', '--force', 'origin', `pull/${opt.n}/head:${ref}`], root, 'git fetch pull request')
    await git(['worktree', 'prune'], { cwd: root })
    if (existsSync(workdir)) await must(['checkout', '--detach', ref], workdir, 'git checkout')
    else await must(['worktree', 'add', '--detach', workdir, ref], root, 'git worktree add')
  }
  // A branch from before the harness was adopted has nothing to run. The
  // review is advisory, so that is a notice, not a red check.
  if (!existsSync(join(workdir, '.github', 'extensions', 'harness', 'extension.mjs'))) {
    return console.error(`harness: #${opt.n}'s branch does not carry the harness — skipped (merge ${p.baseRefName} into it to review)`)
  }
  const diff = await facts(`origin/${p.baseRefName}`, workdir, config)
  const size = reviewSize(diff, config, { labelledFull: p.labels.includes(config.github.labels.full) })
  const linked = (p.closingIssuesReferences || [])[0]
  const t = linked ? await GH.issue(linked.number, root).catch(() => null) : null

  const dir = runDir(root, `review-${opt.n}`)
  const result = await runCopilot(config, 'harness-review', {
    pr: opt.n, title: p.title, body: p.body || '', base: p.baseRefName, workdir, size,
    ...(t ? { ticket: { number: t.number, title: t.title, body: t.body || '' } } : {}),
  }, dir, workdir)
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2))
  if (result.outcome === 'error') {
    // Advisory: say so loudly in the log and the summary, but never block.
    console.error(`::warning::harness review did not finish — ${result.reason}`)
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `Harness review did not finish: ${result.reason}\n`, { flag: 'a' })
    return result
  }
  const body = reviewComment(result)
  if (opt.publish) await GH.upsertComment(opt.n, REVIEW_MARKER, body, root)
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, body + '\n', { flag: 'a' })
  console.error(`harness: review ${result.verdict} · ${result.confidence} confidence`)
  return result
}

async function main() {
  const opt = parseArgv(process.argv.slice(2))
  if (!['ship', 'review'].includes(opt.cmd) || !Number.isInteger(opt.n) || opt.n <= 0) {
    console.error('usage: node harness/bin/run.mjs ship <issue> [--full|--small] [--notes "…"] [--no-publish]\n       node harness/bin/run.mjs review <pr> [--no-publish]')
    process.exit(2)
  }
  const root = await repoRoot()
  const config = await loadConfig(root)
  await (opt.cmd === 'ship' ? ship : review)(opt, root, config)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`harness: ${e.message}`); process.exit(1) })
}
