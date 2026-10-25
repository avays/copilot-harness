// A stand-in for Copilot's workflow context, so the loops can be tested
// without a model. `answer(label, prompt, opts)` scripts what each agent
// returns; undefined means the agent died (ctx.agent resolves null).
import { resolveConfig } from '../lib/config.mjs'

export function fakeCtx(args, answer) {
  const calls = [], logs = [], phases = []
  const ctx = {
    runId: 'test-run',
    args,
    signal: new AbortController().signal,
    calls, logs, phases,
    async agent(prompt, opts = {}) {
      calls.push({ label: opts.label, prompt, opts })
      const v = await answer(opts.label || '', prompt, opts)
      return v === undefined ? null : v
    },
    async parallel(thunks) {
      return Promise.all(thunks.map(async (t) => { try { return await t() } catch { return null } }))
    },
    async pipeline(items, ...stages) {
      return Promise.all(items.map(async (item, i) => {
        let prev = item
        try { for (const s of stages) prev = await s(prev, item, i) } catch { return null }
        return prev
      }))
    },
    phase: (t) => phases.push(t),
    log: (m) => logs.push(m),
    step: async (k, p) => p(),
    pause: async () => {},
  }
  return ctx
}

export const config = (over = {}) => resolveConfig({
  commands: { gate: [{ name: 'test', run: 'true' }], testsOnly: 'true {tests}' },
  models: { light: 'm-light', standard: 'm-standard', strong: 'm-strong' },
  learn: { enabled: false },
  ...over,
})

export const SHIP_ARGS = { issue: 7, title: 'Return 404 for a retired order', body: 'Done when: GET /orders/{id} for a retired order returns 404', labels: [], branch: 'harness/7-x', base: 'main', workdir: '/tmp/work' }

export const smallFacts = { areas: ['web'], files: 1, changesApi: false, changesRule: false, changesData: false, openQuestions: 0, why: 'one controller' }
export const spec = { path: 'specs/7-x.md', summary: 'Map retired to 404; proved by OrderControllerTest.', decisions: [] }

export const blocker = (over = {}) => ({ severity: 'blocker', category: 'logic', file: 'src/main/java/Order.java', line: 40, claim: 'retired orders still return 200', evidence: 'line 40 returns ok()', fix: 'return notFound()', ...over })

export const green = (over = {}) => ({ ok: true, sha: 'abc1234def', dirty: false, steps: [{ name: 'test', ok: true, code: 0, tail: '' }], failedTests: [], tampered: [], ...over })
export const red = (over = {}) => ({ ok: false, sha: 'abc1234def', dirty: false, steps: [{ name: 'test', ok: false, code: 1, tail: 'BUILD FAILURE' }], failedTests: [{ test: 'OrderControllerTest#retired', error: 'expected 404 but was 200' }], tampered: [], ...over })

/** Deps for ship: gates in order (the last repeats), a red-check, sync and diff facts. */
export function deps({ gates = [green()], redCheck = { checked: true, failedOnBase: true, tests: ['OrderControllerTest'], reverted: ['src/main/java/Order.java'] }, syncs = [], facts = { files: 2, appLines: 20, risky: [], onlyDocs: false } } = {}) {
  let g = 0, s = 0
  return {
    gate: async () => gates[Math.min(g++, gates.length - 1)],
    redCheck: async () => redCheck,
    sync: async () => syncs[s++] || { sync: 'current', conflicts: [] },
    facts: async () => facts,
  }
}
