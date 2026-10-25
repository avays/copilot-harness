// Every GitHub read and write the harness makes, through the `gh` CLI. Only
// harness/bin/run.mjs calls these — never an agent, and never the workflow
// running inside Copilot, which holds no GitHub token.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sh } from './exec.mjs'

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// Pinned to the repository `origin` points at. Without a terminal, gh
// prefers a remote named `upstream`, so a forked clone would otherwise read
// the upstream's issues and open pull requests there.
let pinned = null
export async function repoEnv(cwd) {
  if (process.env.GH_REPO) return {}
  if (pinned === null) {
    const url = (await sh('git remote get-url origin', { cwd })).stdout.trim()
    const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)
    pinned = m ? m[1] : ''
  }
  return pinned ? { GH_REPO: pinned } : {}
}

async function gh(args, { cwd, json = false } = {}) {
  const r = await sh(`gh ${args}`, { cwd, env: await repoEnv(cwd) })
  if (r.code !== 0) throw new Error(`gh ${args.split(' ')[0]} ${args.split(' ')[1] || ''} failed: ${r.stderr.trim() || r.stdout.trim()}`)
  return json ? JSON.parse(r.stdout || 'null') : r.stdout.trim()
}

/** gh with a body in a temp file, so no body text ever goes through a shell. */
async function withBody(body, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-body-'))
  const file = join(dir, 'body.md')
  writeFileSync(file, body)
  try { return await fn(q(file)) } finally { rmSync(dir, { recursive: true, force: true }) }
}

export const issue = (n, cwd) =>
  gh(`issue view ${Number(n)} --json number,title,body,labels,state,comments`, { cwd, json: true })
    .then((i) => ({ ...i, labels: (i.labels || []).map((l) => l.name), comments: i.comments || [] }))

/**
 * The harness's last hand-back on the issue, and the comments that answer
 * it. A hand-back is the harness's own comment carrying the marker — only
 * from `harness`, its login, when that is known, so a pasted marker counts
 * for nothing. Its marker records when that run claimed the ticket, and the
 * answer is every comment since then: one posted while that run was still
 * working is an answer too.
 */
// GraphQL (gh issue view) and REST name an app differently: `github-actions`
// against `github-actions[bot]`, sometimes `app/…`. Compare them as one.
export const sameLogin = (a, b) => {
  const n = (x) => String(x || '').toLowerCase().replace(/^app\//, '').replace(/\[bot\]$/, '')
  return n(a) === n(b)
}

export function lastHandBack(comments, marker, harness) {
  // The thread: the hand-backs and declines between two pull requests — the
  // latest such run of them. A later hand-back that asks nothing (an agent
  // that crashed) must not hide the question, or the answer, before it; and
  // the pull request that answered a thread must not hide it from its own
  // review, so a thread with no hand-back after it is still the latest.
  const mine = []
  comments.forEach((c, i) => {
    const body = String(c.body || '')
    if (!body.includes(marker) || (harness && !sameLogin(c.author && c.author.login, harness))) return
    // The harness's own marker ends its comment: the last one is it.
    const tag = body.slice(body.lastIndexOf(marker))
    mine.push({ i, c, outcome: (/outcome=(\w+)/.exec(tag) || [])[1] || 'handback',
      claimed: (/claimed=([0-9T:.\-Z]+)/.exec(tag) || [])[1] || c.createdAt, text: body.slice(0, body.lastIndexOf(marker)).trim() })
  })
  const segments = [[]]
  for (const m of mine) {
    if (m.outcome === 'pr') segments.push([])
    else if (['handback', 'declined'].includes(m.outcome)) segments.at(-1).push(m)
  }
  const asked = [...segments].reverse().find((seg) => seg.length)
  if (!asked) return null
  const since = asked[0].claimed || ''
  const after = comments.filter((x) => (x.createdAt || '') > since && !String(x.body || '').includes(marker))
  return { text: asked.map((m) => m.text).join('\n\n---\n\n'), after }
}

/**
 * The answer to a hand-back: what the harness asked, then what people with
 * write access said since. It reaches the agents as part of their brief,
 * and anyone can comment on a public repository, so who may answer
 * matters: `canWrite(login)` decides, and the skipped authors are returned.
 */
export async function answerSince(comments, marker, canWrite, harness = null) {
  // A hand-back may come from this identity; from the Actions bot (only this
  // repository's workflows can post as it, and the jobs that run agents
  // can't comment at all); or from a person's laptop run, a person with
  // write access. A pasted marker from anyone else is text, even when the
  // harness's own login is unknown.
  const trusted = []
  for (const c of comments) {
    const login = c.author && c.author.login
    const fromHarness = sameLogin(login, harness) || sameLogin(login, 'github-actions[bot]')
    if (String(c.body || '').includes(marker) && !fromHarness && !(login && (await canWrite(login, c)))) continue
    trusted.push(c)
  }
  const back = lastHandBack(trusted, marker, null)
  if (!back) return { answer: '', skipped: [] }
  const kept = [], skipped = new Set()
  for (const c of back.after) {
    const login = c.author && c.author.login
    if (login && (await canWrite(login, c))) kept.push(String(c.body || '').trim())
    else skipped.add(login || '(unknown)')
  }
  if (!kept.filter(Boolean).length) return { answer: '', skipped: [...skipped] }
  // Newest last, and kept if anything must go: it is the latest word.
  const said = kept.filter(Boolean).join('\n\n---\n\n')
  const answer = `The hand-back said:\n${back.text}\n\nThe answer:\n${said.length > 4000 ? '…' + said.slice(-4000) : said}`
  return { answer, skipped: [...skipped] }
}

/**
 * Whether a person may write to the repository: the API's answer, which
 * needs a token with push access (the claim job has it). Without that
 * answer, only the repository's owner counts: MEMBER and COLLABORATOR
 * include people with read access only.
 */
export async function writer(login, comment, cwd) {
  const r = await sh(`gh api repos/{owner}/{repo}/collaborators/${q(login)}/permission --jq .permission`, { cwd, env: await repoEnv(cwd) })
  if (r.code === 0) return ['admin', 'maintain', 'write'].includes(r.stdout.trim())
  return comment.authorAssociation === 'OWNER'
}

export const pr = (n, cwd) =>
  gh(`pr view ${Number(n)} --json number,title,body,baseRefName,headRefName,isDraft,isCrossRepository,labels,url,closingIssuesReferences`, { cwd, json: true })
    .then((p) => ({ ...p, labels: (p.labels || []).map((l) => l.name) }))

// --head matches a branch name in any fork too, and harness branch names are
// predictable: only a pull request from this repository is the harness's.
export const openPrFor = async (branch, cwd) =>
  (await gh(`pr list --head ${q(branch)} --state open --json number,isDraft,url,isCrossRepository`, { cwd, json: true }))
    .find((p) => p.isCrossRepository === false) || null

/** Add and remove labels; a label that is already absent is not an error. */
export async function relabel(n, { add = [], remove = [] }, cwd) {
  for (const l of remove) await sh(`gh issue edit ${Number(n)} --remove-label ${q(l)}`, { cwd, env: await repoEnv(cwd) })
  if (add.length) await gh(`issue edit ${Number(n)} ${add.map((l) => `--add-label ${q(l)}`).join(' ')}`, { cwd })
}

export const comment = (n, body, cwd) => withBody(body, (f) => gh(`issue comment ${Number(n)} --body-file ${f}`, { cwd }))

export const createPr = ({ base, head, title, body, draft }, cwd) =>
  withBody(body, (f) => gh(`pr create --base ${q(base)} --head ${q(head)} --title ${q(title)} --body-file ${f}${draft ? ' --draft' : ''}`, { cwd }))

export const editPr = (n, body, cwd) => withBody(body, (f) => gh(`pr edit ${Number(n)} --body-file ${f}`, { cwd }))

export const markReady = (n, cwd) => gh(`pr ready ${Number(n)}`, { cwd })

export const dispatch = (workflow, inputs, cwd) =>
  gh(`workflow run ${q(workflow)} ${Object.entries(inputs).map(([k, v]) => `-f ${q(`${k}=${v}`)}`).join(' ')}`, { cwd })

// Who the token acts as. GITHUB_TOKEN cannot read /user; in Actions its
// comments are github-actions[bot].
export async function whoami(cwd) {
  const r = await sh('gh api user --jq .login', { cwd, env: await repoEnv(cwd) })
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim()
  return process.env.GITHUB_ACTIONS ? 'github-actions[bot]' : null
}

/** One comment per pull request that each review updates, found by its marker and author. */
export async function upsertComment(n, marker, body, cwd) {
  // --paginate prints one JSON array per page; --jq flattens them to one
  // object per line, which parses whatever the page count.
  // The marker and the author: anyone can paste the marker into a comment,
  // and the review must not be written into theirs.
  const me = await whoami(cwd)
  const lines = await gh(`api repos/{owner}/{repo}/issues/${Number(n)}/comments --paginate --jq '.[] | {id, body, login: .user.login}'`, { cwd })
  const mine = lines.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .find((c) => String(c.body || '').includes(marker) && (!me || c.login === me))
  if (!mine) return comment(n, body, cwd)
  return withBody(JSON.stringify({ body }), (f) => gh(`api -X PATCH repos/{owner}/{repo}/issues/comments/${mine.id} --input ${f}`, { cwd }))
}
