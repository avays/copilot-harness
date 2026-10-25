#!/usr/bin/env node
// The one entry point, on a laptop and in GitHub Actions alike:
//
//   node harness/bin/run.mjs ship <issue> [--full|--small] [--notes "…"] [--no-publish] [--phase P]
//   node harness/bin/run.mjs review <pr> [--no-publish] [--phase P]
//
// Three phases, and only the middle one is AI:
//   prepare — read the ticket or PR, claim it, choose the branch   (needs a GitHub token)
//   build   — `copilot workflow run harness-ship|harness-review`   (must have NO GitHub token)
//   publish — push, open the pull request, label, comment          (needs a GitHub token)
//
// Without --phase all three run in turn (a laptop). In Actions each is its
// own job, handing off through .harness/handoff/: an agent can read the
// environment of any process above it, so the only way to keep the GitHub
// token from the agents is for no process in the build job to hold it.
import { spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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

// Tokens the agents must never see. Copilot signs in with
// COPILOT_GITHUB_TOKEN, which should carry no repository access (ADAPTING §6).
const GITHUB_TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'HARNESS_GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']

/**
 * The environment Copilot, and so every agent, starts in. In Actions the
 * build job holds no GitHub token at all; this is the second layer. On a
 * laptop it is the only one, and it is not isolation: an agent running as
 * you can still read your stored credentials (ADAPTING §9). It does turn
 * off git's credential helpers and prompts, so an ordinary `git push` fails.
 */
export function copilotEnv(env) {
  const out = { ...env, COPILOT_AUTO_UPDATE: 'false', GIT_TERMINAL_PROMPT: '0' }
  // Never load the workspace's own .github/extensions: the branch's copy of
  // the harness may have been edited by agents. The harness that runs is
  // the staged one (stageHarness), loaded as a user extension.
  // COPILOT_ALLOW_ALL=true would trust the folder too. The step's command
  // files would let an agent set env or PATH for the job's later steps.
  for (const k of [...GITHUB_TOKENS, 'SSH_AUTH_SOCK', 'GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS', 'COPILOT_ALLOW_ALL',
    'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT', 'GITHUB_STATE', 'GITHUB_STEP_SUMMARY']) delete out[k]
  // ssh would still read a passphrase-less key from ~/.ssh by itself.
  out.GIT_SSH_COMMAND = 'ssh -F /dev/null -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o BatchMode=yes'
  // An empty credential.helper resets the helper list for every git call.
  const n = Number(out.GIT_CONFIG_COUNT || 0)
  Object.assign(out, { GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'credential.helper', [`GIT_CONFIG_VALUE_${n}`]: '' })
  return out
}

function parseArgv(argv) {
  const [cmd, num, ...rest] = argv
  const opt = { cmd, n: Number(String(num || '').replace(/^#/, '')), size: null, notes: '', publish: true, phase: null }
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--full' || rest[i] === '--small') opt.size = rest[i].slice(2)
    else if (rest[i] === '--notes') opt.notes = rest[++i] || ''
    else if (rest[i] === '--no-publish') opt.publish = false
    else if (rest[i] === '--phase') opt.phase = rest[++i]
  }
  return opt
}

async function repoRoot() {
  const r = await git(['rev-parse', '--show-toplevel'], { cwd: process.cwd() })
  if (r.code !== 0) throw new Error('run this inside the repository')
  return r.stdout.trim()
}

/** .harness/ holds hand-offs, run folders and local worktrees; it ignores itself. */
function harnessDir(root, ...sub) {
  const dir = join(root, '.harness', ...sub)
  mkdirSync(dir, { recursive: true })
  const ignore = join(root, '.harness', '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  return dir
}

const runDir = (root, name) => harnessDir(root, 'runs', `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`)

// One file per phase, so the artifacts of separate jobs never overwrite
// each other when they are downloaded into one folder.
const handoffFile = (root, opt, phase) => join(harnessDir(root, 'handoff'), `${opt.cmd}-${opt.n}.${phase}.json`)
const writeHandoff = (root, opt, phase, data) => writeFileSync(handoffFile(root, opt, phase), JSON.stringify(data, null, 2))
const readHandoff = (root, opt, phase) => {
  const f = handoffFile(root, opt, phase)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
}

/** Values the next Actions job needs, as step outputs. */
function output(values) {
  if (!process.env.GITHUB_OUTPUT) return
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''))
}

async function must(args, cwd, what) {
  const r = await git(args, { cwd })
  if (r.code !== 0) throw new Error(`${what}: ${r.out.trim()}`)
  return r.stdout.trim()
}

/**
 * A copy of the root checkout's harness, as a Copilot *user* extension in a
 * Copilot home of its own. Copilot then runs in the workspace — so agents'
 * shells start in the tree they edit — while the loop, the limits and the
 * gate come from the root (in Actions, the base branch). The workspace's own
 * project extension is never loaded: headless, Copilot loads project
 * extensions only with an opt-in that copilotEnv removes.
 *
 * The person's own Copilot home is linked in, so a `copilot login` still
 * signs the run in — minus their extensions, their folder trust (config and
 * settings are trust-stripped copies, so nothing the run writes there
 * reaches them) and their session state and logs.
 */
const TRUST_FILES = new Set(['config.json', 'settings.json'])
// What a run writes. Linked, a run would put its sessions and logs in the
// person's own history; it gets its own instead.
const RUN_STATE = /^(session-state|logs|history|.*\.lock)$/

/** A Copilot config without folder trust. Unreadable JSON becomes {}: trust nothing. */
export function untrusted(text) {
  let c
  try { c = JSON.parse(text) } catch { return '{}' }
  if (!c || typeof c !== 'object') return '{}'
  for (const k of Object.keys(c)) if (/trust/i.test(k)) delete c[k]
  return JSON.stringify(c, null, 2)
}

export function stageHarness(root, own = process.env.COPILOT_HOME || join(homedir(), '.copilot')) {
  const stage = mkdtempSync(join(tmpdir(), 'harness-stage-'))
  cpSync(join(root, 'harness'), join(stage, 'harness'), { recursive: true })
  cpSync(join(root, 'harness.config.mjs'), join(stage, 'harness.config.mjs'))
  const home = join(stage, 'home')
  mkdirSync(join(home, 'extensions', 'harness'), { recursive: true })
  // extension.mjs imports ../../../harness/: from home/extensions/harness/
  // that is the stage, where the copy lives.
  cpSync(join(root, '.github', 'extensions', 'harness', 'extension.mjs'), join(home, 'extensions', 'harness', 'extension.mjs'))
  // Trusted folders are dropped: a folder the person once trusted in
  // interactive Copilot would load the workspace's own project extension.
  if (existsSync(own)) {
    for (const entry of readdirSync(own)) {
      if (entry === 'extensions' || RUN_STATE.test(entry)) continue
      if (TRUST_FILES.has(entry)) writeFileSync(join(home, entry), untrusted(readFileSync(join(own, entry), 'utf8')))
      else symlinkSync(join(own, entry), join(home, entry))
    }
  }
  return { home, cleanup: () => rmSync(stage, { recursive: true, force: true }) }
}

/** Run the workflow headless; the result file, or an error result. */
export function runCopilot(root, config, workflow, args, dir, cwd, timeoutMinutes = config.copilot.timeoutMinutes) {
  const argsFile = join(dir, 'args.json'), resultFile = join(dir, 'result.json')
  writeFileSync(argsFile, JSON.stringify(args, null, 2))
  const argv = copilotArgv(config, workflow, argsFile, resultFile)
  console.error(`harness: ${config.copilot.bin} ${argv.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ')}`)
  const stage = stageHarness(root)
  return new Promise((done) => {
    const p = spawn(config.copilot.bin, argv, {
      cwd,
      env: { ...copilotEnv(process.env), COPILOT_HOME: stage.home },
      // npm installs copilot as a .cmd shim on Windows, which needs a shell.
      shell: process.platform === 'win32',
      // Its own process group, so whatever the agents started can be
      // stopped with it, before anything reads what the run left behind.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let out = '', timedOut = false
    const killGroup = () => { if (process.platform !== 'win32') { try { process.kill(-p.pid, 'SIGKILL') } catch {} } else { try { p.kill('SIGKILL') } catch {} } }
    // Below the job's own timeout, so the step still ends by itself and the
    // reap after it runs: a job that times out runs nothing else in the step.
    const timer = setTimeout(() => { timedOut = true; killGroup() }, timeoutMinutes * 60_000)
    p.stdout.on('data', (d) => { out += d; process.stderr.write(d) })
    p.on('error', (e) => { clearTimeout(timer); stage.cleanup(); done({ outcome: 'error', reason: `could not start ${config.copilot.bin}: ${e.message}` }) })
    p.on('close', (code) => {
      clearTimeout(timer)
      killGroup()
      stage.cleanup()
      // Kept on a timeout too: that is when someone will want to read it.
      writeFileSync(join(dir, 'stdout.jsonl'), out)
      if (timedOut) return done({ outcome: 'error', reason: `the run passed its timeout (${timeoutMinutes} minutes) and was stopped` })
      const { status, usage } = readEvents(out)
      // Exit 0 is the only case where the result file is this run's; a
      // failed run leaves any earlier file untouched.
      if (code === 0 && existsSync(resultFile)) return done({ ...JSON.parse(readFileSync(resultFile, 'utf8')), usage })
      done({ outcome: 'error', usage, reason: `copilot workflow run exited ${code}${status ? ` (${status})` : ''}` + (code === 2 ? ' — workflow not found or arguments invalid: is .github/extensions/harness/ in this checkout?' : '') })
    })
  })
}

/**
 * The branch for an issue: the one an earlier attempt pushed, if any, so a
 * renamed ticket continues where it stopped instead of starting a second PR.
 * Of several, the one with an open pull request.
 */
async function branchFor(n, title, root) {
  const r = await git(['ls-remote', '--heads', 'origin', `harness/${n}-*`], { cwd: root })
  if (r.code !== 0) throw new Error(`git ls-remote: ${r.out.trim()}`)
  // ls-remote patterns match the end of a ref: keep only harness/<n>-…
  const found = r.stdout.split('\n').map((l) => l.split('\trefs/heads/')[1]).filter((b) => b && b.startsWith(`harness/${n}-`))
  for (const b of found) {
    const pr = await GH.openPrFor(b, root)
    if (pr) return { branch: b, onRemote: true, existing: pr }
  }
  return { branch: found[0] || `harness/${n}-${slug(title)}`, onRemote: found.length > 0, existing: null }
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

/**
 * Files under .github/workflows/ that a ref changes against the base. The
 * pathspec does the filtering and -z turns off git's path quoting: filtered
 * by prefix, a quoted name (non-ASCII, a tab) would slip past.
 */
export async function workflowEdits(baseRef, ref, cwd) {
  return (await must(['diff', '--name-only', '-z', `${baseRef}...${ref}`, '--', '.github/workflows/'], cwd, 'git diff'))
    .split('\0').filter(Boolean)
}

// ── ship ─────────────────────────────────────────────────────────────────────
async function shipPrepare(opt, root, config) {
  const L = config.github.labels
  const t = await GH.issue(opt.n, root)
  const skip = (reason) => { console.error(`harness: ${reason}`); writeHandoff(root, opt, 'prepare', { skip: reason }); output({ skip: 'true' }); return null }
  if (t.state !== 'OPEN') return skip(`#${opt.n} is ${t.state.toLowerCase()} — nothing to do`)
  // A run that crashes still ends in publish, which removes the label; one
  // still there means a run is in flight, and a second would race it.
  if (t.labels.includes(L.working)) return skip(`#${opt.n} is already ${L.working} — a run is in flight; remove the label if it is not`)
  const base = config.base
  // Locally, today's base; in Actions the checkout fetched every branch.
  if (!CI) await must(['fetch', 'origin', base], root, `git fetch origin ${base}`)
  const { branch, onRemote, existing } = await branchFor(opt.n, t.title, root)
  if (existing && !existing.isDraft) return skip(`#${opt.n} already has a ready pull request: ${existing.url}`)
  // Claim it: the label swap is what stops a second run starting on it. Add
  // before removing, so a failure never leaves the ticket with neither. A
  // --no-publish run writes nothing to GitHub, so it does not claim.
  if (opt.publish) {
    await GH.relabel(opt.n, { add: [L.working] }, root)
    await GH.relabel(opt.n, { remove: [L.ready, L.stuck, L.done] }, root)
  }
  const state = { issue: { number: opt.n, title: t.title, body: t.body || '', labels: t.labels }, branch, onRemote, base, existing, notes: opt.notes, size: opt.size }
  writeHandoff(root, opt, 'prepare', state)
  output({ skip: 'false', branch, ref: onRemote ? branch : base })
  return state
}

// The agents work in a workspace under .harness/worktrees/, and Copilot runs
// there; the harness that runs — its loops, limits and gate — is staged from
// the root checkout (stageHarness), never what an earlier attempt's agents
// left on the branch. In Actions the root is the base branch.
const workspace = (root, name) => join(root, '.harness', 'worktrees', name)

async function shipBuild(opt, root, config, state) {
  const { branch, onRemote, base } = state
  const workdir = workspace(root, `issue-${opt.n}`)
  if (CI) {
    // The workflow checked the branch (or the base) out here, with every
    // branch fetched: this job has no credentials to fetch with.
    if (!existsSync(workdir)) throw new Error(`no workspace at ${workdir} — the workflow's second checkout is missing`)
    await must(['checkout', '-B', branch, onRemote ? `origin/${branch}` : `origin/${base}`], workdir, 'git checkout')
  } else {
    if (onRemote) await must(['fetch', 'origin', branch], root, `git fetch origin ${branch}`)
    await worktreeFor(root, workdir, branch, onRemote, base)
  }
  if (onRemote) console.error(`continuing on ${branch}, from an earlier attempt`)
  const dir = runDir(root, `ship-${opt.n}`)
  const t = state.issue
  const result = await runCopilot(root, config, 'harness-ship', {
    issue: opt.n, title: t.title, body: t.body, labels: t.labels, branch, base, workdir,
    ...(state.notes ? { notes: state.notes } : {}), ...(state.size ? { size: state.size } : {}),
  }, dir, workdir)
  result.issue ??= opt.n
  result.branch ??= branch
  result.title ??= t.title
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2))
  // In Actions the work leaves this job as a bundle, and publish pushes it:
  // nothing in this job could.
  let bundle = null
  const ahead = Number((await git(['rev-list', '--count', `origin/${base}..HEAD`], { cwd: workdir })).stdout.trim() || 0)
  if (CI && ahead > 0) {
    bundle = `ship-${opt.n}.bundle`
    await must(['bundle', 'create', join(harnessDir(root, 'handoff'), bundle), `refs/heads/${branch}`, `^origin/${base}`], workdir, 'git bundle create')
  }
  writeHandoff(root, opt, 'build', { result, workdir, bundle })
  console.error(`harness: ${result.outcome}${result.reason ? ` — ${result.reason}` : ''} (run folder ${dir})`)
  if (!CI) console.error(`the worktree stays at ${workdir}; remove it with: git worktree remove ${workdir}`)
  return result
}

async function shipPublish(opt, root, config, state, built) {
  const L = config.github.labels, n = opt.n, base = config.base
  // The hand-off came through artifacts the build job could have touched, so
  // nothing in it decides where to push: the branch must be this ticket's
  // harness branch, and the pull request is looked up again, not trusted.
  const branch = String(state.branch || '')
  if (!new RegExp(`^harness/${n}-[a-z0-9-]+$`).test(branch) || branch === base) throw new Error(`refusing to publish to "${branch}": not a harness branch for #${n}`)
  const existing = await GH.openPrFor(branch, root)
  if (built && built.bundle && built.bundle !== `ship-${n}.bundle`) throw new Error(`refusing an unexpected bundle name "${built.bundle}"`)
  // The build job timed out, was cancelled or lost its runner: say so, so
  // the ticket never sits claimed with nobody working on it.
  const result = built && built.result ? built.result : { outcome: 'error', reason: 'the build job did not finish (a timeout, a cancellation or a lost runner) — its log says which' }
  // The build result is the build job's account, and agents' code ran in
  // that job: which issue, branch and title this is comes from the claim.
  Object.assign(result, { issue: n, branch, title: state.issue && state.issue.title })
  if (result.outcome === 'declined' || result.outcome === 'error') {
    await GH.comment(n, shipIssueComment(result), root)
    await GH.relabel(n, { add: [L.stuck], remove: [L.working] }, root)
    return result
  }
  // The work to push: the worktree's HEAD on a laptop, the bundle in Actions.
  let cwd = root, ref = null
  if (!CI) {
    cwd = built.workdir
    ref = 'HEAD'
  } else if (built.bundle) {
    ref = 'refs/harness/out'
    await must(['fetch', join(root, '.harness', 'handoff', built.bundle), `+refs/heads/${branch}:${ref}`], root, 'git fetch bundle')
  }
  const ahead = ref ? Number(await must(['rev-list', '--count', `origin/${base}..${ref}`], cwd, 'git rev-list')) : 0
  // A "pull request" with nothing in it is not one.
  if (ahead === 0 && result.outcome === 'pr') Object.assign(result, { outcome: 'handback', phase: 'PR', reason: 'the run finished with no commits to push' })
  // A pushed workflow file runs, on that branch, with this repository's
  // secrets. Agent-written workflows are never pushed; a person applies them.
  const edits = ahead > 0 ? await workflowEdits(`origin/${base}`, ref, cwd) : []
  if (edits.length) {
    Object.assign(result, { outcome: 'handback', phase: 'PR', reason: `the change edits ${edits.join(', ')}; the harness never pushes workflow files, so a person must apply it (the run's artifact holds the commits)` })
    await GH.comment(n, shipIssueComment(result), root)
    await GH.relabel(n, { add: [L.stuck], remove: [L.working] }, root)
    return result
  }
  let url = existing ? existing.url : ''
  if (ahead > 0) {
    await must(['push', '-u', 'origin', `${ref}:refs/heads/${branch}`], cwd, 'git push')
    const draft = result.outcome !== 'pr'
    const body = shipPrBody(result)
    if (existing) {
      await GH.editPr(existing.number, body, root)
      if (!draft && existing.isDraft) await GH.markReady(existing.number, root)
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
  return result
}

async function ship(opt, root, config) {
  const L = config.github.labels
  const phase = opt.phase
  try {
    let state = phase && phase !== 'prepare' ? readHandoff(root, opt, 'prepare') : null
    if (!phase || phase === 'prepare') state = await shipPrepare(opt, root, config)
    if (!state || state.skip) return
    if (!phase || phase === 'build') {
      await shipBuild(opt, root, config, state)
      if (phase === 'build' || !opt.publish) return
    }
    await shipPublish(opt, root, config, state, readHandoff(root, opt, 'build'))
  } catch (e) {
    console.error(`harness: ${e.message}`)
    process.exitCode = 1
    // The build job has no token to report with; publish reports the
    // missing result instead. Elsewhere, a ticket must never be left looking
    // claimed: the failure is said on the issue and handed to a person.
    if (phase === 'build' || !opt.publish) return
    await GH.comment(opt.n, shipIssueComment({ outcome: 'error', reason: e.message }), root).catch(() => {})
    await GH.relabel(opt.n, { add: [L.stuck], remove: [L.working] }, root).catch(() => {})
  }
}

// ── review ───────────────────────────────────────────────────────────────────
async function reviewPrepare(opt, root, config) {
  const p = await GH.pr(opt.n, root)
  const skip = (reason) => { console.error(`harness: ${reason}`); writeHandoff(root, opt, 'prepare', { skip: reason }); output({ skip: 'true' }); return null }
  if (p.isDraft) return skip(`#${opt.n} is a draft — reviewed once it is marked ready`)
  // Its extension would run with this repository's Copilot token.
  if (p.isCrossRepository) return skip(`#${opt.n} comes from a fork — the harness does not run code from forks`)
  const linked = (p.closingIssuesReferences || [])[0]
  const t = linked ? await GH.issue(linked.number, root).catch(() => null) : null
  const state = {
    pr: opt.n, title: p.title, body: p.body || '', base: p.baseRefName, labels: p.labels,
    ...(t ? { ticket: { number: t.number, title: t.title, body: t.body || '' } } : {}),
  }
  writeHandoff(root, opt, 'prepare', state)
  output({ skip: 'false', ref: `refs/pull/${opt.n}/head` })
  return state
}

async function reviewBuild(opt, root, config, state) {
  const workdir = workspace(root, `pr-${opt.n}`)
  if (CI) {
    if (!existsSync(workdir)) throw new Error(`no workspace at ${workdir} — the workflow's second checkout is missing`)
  } else {
    await must(['fetch', 'origin', state.base], root, 'git fetch base')
    // A named ref, not FETCH_HEAD: FETCH_HEAD belongs to one worktree, so a
    // second review could not see what the main checkout fetched.
    const ref = `refs/harness/pr-${opt.n}`
    await must(['fetch', '--force', 'origin', `pull/${opt.n}/head:${ref}`], root, 'git fetch pull request')
    await git(['worktree', 'prune'], { cwd: root })
    if (existsSync(workdir)) {
      // Reviewers may write scratch files; the next review must not read them.
      await must(['reset', '--hard'], workdir, 'git reset')
      await must(['clean', '-fdx'], workdir, 'git clean')
      await must(['checkout', '--detach', ref], workdir, 'git checkout')
    } else {
      await must(['worktree', 'add', '--detach', workdir, ref], root, 'git worktree add')
    }
  }
  const diff = await facts(`origin/${state.base}`, workdir, config)
  const size = reviewSize(diff, config, { labelledFull: state.labels.includes(config.github.labels.full) })
  const dir = runDir(root, `review-${opt.n}`)
  const result = await runCopilot(root, config, 'harness-review', {
    pr: opt.n, title: state.title, body: state.body, base: state.base, workdir, size,
    ...(state.ticket ? { ticket: state.ticket } : {}),
  }, dir, workdir, config.review.timeoutMinutes)
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2))
  writeHandoff(root, opt, 'build', { result })
  return result
}

async function reviewPublish(opt, root, config, built) {
  const result = built ? built.result : { outcome: 'error', reason: 'the review job did not finish' }
  const summary = (text) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n')
  if (result.outcome === 'error' || result.outcome === 'skipped') {
    // Advisory: say so in the log and the summary, but never block.
    console.error(`${CI ? '::warning::' : ''}harness review did not run to the end — ${result.reason}`)
    summary(`Harness review did not run to the end: ${result.reason}`)
    return result
  }
  const body = reviewComment(result)
  if (opt.publish) await GH.upsertComment(opt.n, REVIEW_MARKER, body, root)
  summary(body)
  console.error(`harness: review ${result.verdict} · ${result.confidence} confidence`)
  return result
}

async function review(opt, root, config) {
  const phase = opt.phase
  try {
    let state = phase && phase !== 'prepare' ? readHandoff(root, opt, 'prepare') : null
    if (!phase || phase === 'prepare') state = await reviewPrepare(opt, root, config)
    if (!state || state.skip) return
    if (!phase || phase === 'build') {
      await reviewBuild(opt, root, config, state)
      if (phase === 'build') return
    }
    await reviewPublish(opt, root, config, readHandoff(root, opt, 'build'))
  } catch (e) {
    // Advisory: a review that could not run is a warning, never a red check.
    console.error(`${CI ? '::warning::' : ''}harness review: ${e.message}`)
  }
}

async function main() {
  const opt = parseArgv(process.argv.slice(2))
  if (!['ship', 'review'].includes(opt.cmd) || !Number.isInteger(opt.n) || opt.n <= 0 || (opt.phase && !['prepare', 'build', 'publish'].includes(opt.phase))) {
    console.error('usage: node harness/bin/run.mjs ship <issue> [--full|--small] [--notes "…"] [--no-publish] [--phase prepare|build|publish]\n' +
      '       node harness/bin/run.mjs review <pr> [--no-publish] [--phase prepare|build|publish]')
    process.exit(2)
  }
  const root = await repoRoot()
  const config = await loadConfig(root)
  await (opt.cmd === 'ship' ? ship : review)(opt, root, config)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`harness: ${e.message}`); process.exit(1) })
}
