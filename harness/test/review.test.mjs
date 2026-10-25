import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reviewComment } from '../lib/publish.mjs'
import { run } from '../workflows/review.mjs'
import { blocker, config, fakeCtx } from './fake.mjs'

const ARGS = { pr: 12, title: 'Return 404 for retired orders', body: 'Closes #7', base: 'main', workdir: '/tmp/w', size: 'small', ticket: { number: 7, title: 'Retired orders', body: 'Done when: 404' } }
const lensReport = (over = {}) => ({ confidence: 'high', covered: 'the controller and its test', findings: [], ...over })

test('a clean small review passes at the lens confidence', async () => {
  const ctx = fakeCtx(ARGS, (l) => (l.startsWith('lens:') ? lensReport() : undefined))
  const r = await run(ctx, { config: config() })
  assert.equal(r.verdict, 'pass')
  assert.equal(r.confidence, 'high')
  assert.deepEqual(r.lenses, ['combined'])
  assert.match(ctx.calls[0].prompt, /ticket #7/)
})

test('the weakest lens sets the confidence', async () => {
  const ctx = fakeCtx({ ...ARGS, size: 'large' }, (l) => (l.startsWith('lens:') ? lensReport({ confidence: l.includes('tests') ? 'medium' : 'high' }) : undefined))
  const r = await run(ctx, { config: config() })
  assert.deepEqual(r.lenses, ['criteria', 'rules', 'tests'])
  assert.equal(r.confidence, 'medium')
})

test('a lens that never finished makes the review low: an unread lens is not a passed one', async () => {
  const ctx = fakeCtx({ ...ARGS, size: 'large' }, (l) => (l.startsWith('lens:rules') ? undefined : l.startsWith('lens:') ? lensReport() : undefined))
  const r = await run(ctx, { config: config() })
  assert.equal(r.verdict, 'pass')
  assert.equal(r.confidence, 'low')
  assert.deepEqual(r.missing, ['rules'])
  assert.match(reviewComment(r), /unproven/)
})

test('a blocker that survives the skeptic fails the review; a refuted one does not', async () => {
  const kept = fakeCtx(ARGS, (l) => (l.startsWith('lens:') ? lensReport({ findings: [blocker()] }) : l.startsWith('skeptic:') ? { refuted: false, why: '' } : undefined))
  assert.equal((await run(kept, { config: config() })).verdict, 'fail')
  const gone = fakeCtx(ARGS, (l) => (l.startsWith('lens:') ? lensReport({ findings: [blocker()] }) : l.startsWith('skeptic:') ? { refuted: true, why: 'on main' } : undefined))
  assert.equal((await run(gone, { config: config() })).verdict, 'pass')
})

test('a tiny review runs on the light model', async () => {
  const ctx = fakeCtx({ ...ARGS, size: 'tiny' }, (l) => (l.startsWith('lens:') ? lensReport() : undefined))
  await run(ctx, { config: config() })
  assert.equal(ctx.calls[0].opts.model, 'm-light')
})

test('a blocker is not swallowed by a minor another lens filed at the same place', async () => {
  const ctx = fakeCtx({ ...ARGS, size: 'large' }, (l) => {
    if (l.startsWith('lens:criteria')) return lensReport({ findings: [blocker({ severity: 'minor', claim: 'naming' })] })
    if (l.startsWith('lens:rules')) return lensReport({ findings: [blocker()] })
    if (l.startsWith('lens:')) return lensReport()
    if (l.startsWith('skeptic:')) return { refuted: false, why: '' }
  })
  const r = await run(ctx, { config: config() })
  assert.equal(r.verdict, 'fail')
  assert.equal(r.blockers.length, 1)
})

test('a review blocker with no file still fails the review', async () => {
  const ctx = fakeCtx(ARGS, (l) => (l.startsWith('lens:') ? lensReport({ findings: [blocker({ file: '', line: undefined, category: 'criterion-unmet', claim: 'nothing satisfies criterion 2' })] }) : l.startsWith('skeptic:') ? { refuted: false, why: '' } : undefined))
  assert.equal((await run(ctx, { config: config() })).verdict, 'fail')
})

test('a review skeptic that dies refutes nothing', async () => {
  const ctx = fakeCtx(ARGS, (l) => (l.startsWith('lens:') ? lensReport({ findings: [blocker()] }) : undefined))
  assert.equal((await run(ctx, { config: config() })).verdict, 'fail')
})

test('a review runs an extra lens its tier lists by key', async () => {
  const parity = { key: 'parity', ask: 'Compare with legacy.' }
  const c = config({ lenses: { code: [parity], spec: [] }, tiers: { full: { codeLenses: ['criteria', 'rules', 'parity'] } } })
  const ctx = fakeCtx({ ...ARGS, size: 'large' }, (l) => (l.startsWith('lens:') ? lensReport() : undefined))
  const r = await run(ctx, { config: c })
  assert.ok(r.lenses.includes('parity'))
})

test('a review runs an extra lens that names its tier', async () => {
  const parity = { key: 'parity', tiers: ['full'], ask: 'Compare with legacy.' }
  const ctx = fakeCtx({ ...ARGS, size: 'large' }, (l) => (l.startsWith('lens:') ? lensReport() : undefined))
  assert.ok((await run(ctx, { config: config({ lenses: { code: [parity], spec: [] } }) })).lenses.includes('parity'))
})
