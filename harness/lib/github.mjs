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
async function repoEnv(cwd) {
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
  gh(`issue view ${Number(n)} --json number,title,body,labels,state`, { cwd, json: true })
    .then((i) => ({ ...i, labels: (i.labels || []).map((l) => l.name) }))

export const pr = (n, cwd) =>
  gh(`pr view ${Number(n)} --json number,title,body,baseRefName,headRefName,isDraft,labels,url,closingIssuesReferences`, { cwd, json: true })
    .then((p) => ({ ...p, labels: (p.labels || []).map((l) => l.name) }))

export const openPrFor = async (branch, cwd) =>
  (await gh(`pr list --head ${q(branch)} --state open --json number,isDraft,url`, { cwd, json: true }))[0] || null

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

/** One comment per pull request that each review updates, found by its marker. */
export async function upsertComment(n, marker, body, cwd) {
  // --paginate prints one JSON array per page; --jq flattens them to one
  // object per line, which parses whatever the page count.
  const lines = await gh(`api repos/{owner}/{repo}/issues/${Number(n)}/comments --paginate --jq '.[] | {id, body}'`, { cwd })
  const mine = lines.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((c) => String(c.body || '').includes(marker))
  if (!mine) return comment(n, body, cwd)
  return withBody(JSON.stringify({ body }), (f) => gh(`api -X PATCH repos/{owner}/{repo}/issues/comments/${mine.id} --input ${f}`, { cwd }))
}
