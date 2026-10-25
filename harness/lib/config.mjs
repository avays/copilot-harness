// Defaults for every key in harness.config.mjs, and the merge. A project's
// config only needs what differs; harness/ADAPTING.md says what each key is for.
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const DEFAULTS = {
  base: 'main',
  instructions: ['AGENTS.md', '.github/copilot-instructions.md', '.github/instructions/'],
  map: '',
  paths: {
    source: ['src/main/'],
    tests: ['src/test/'],
    risky: ['.github/', 'harness/', 'harness.config.mjs'],
    specs: 'specs',
    lessons: 'docs/harness-lessons.md',
  },
  commands: {
    gate: [],
    quick: null,
    testsOnly: null,
    reports: [],
  },
  tests: {
    isTest: (file) => /(Test|Tests|IT)\.\w+$/.test(file),
    id: (file) => file.split('/').pop().replace(/\.\w+$/, ''),
    weakenedIfRemoved: /@Test\b|assert\w*\(/,
    weakenedIfAdded: /@Disabled\b|@Ignore\b/,
  },
  sizing: {
    areas: { app: 'application code', harness: '.github/, harness/, harness.config.mjs' },
    heavyAreas: ['harness'],
    rule: 'a business rule changes',
    data: 'the schema, a migration, or stored data changes',
    api: 'a public endpoint or interface changes',
    broadAreas: 3,
    broadFiles: 7,
    escalateLines: 300,
  },
  models: { light: null, standard: null, strong: null },
  // How much loop a ticket gets. Setup reports facts, sizing.mjs composes the
  // run from them: small is the base, and each risk adds the check that
  // catches it. Small keeps what makes the loop trustworthy — the gate, an
  // independent audit, a skeptic on every blocker — and drops redundancy.
  tiers: {
    small: {
      specRounds: 0, buildRounds: 2,
      specLenses: ['combined'], codeLenses: ['combined'],
      think: 'standard', build: 'standard',
    },
    full: {
      specRounds: 3, buildRounds: 4,
      specLenses: ['criteria', 'fit'], codeLenses: ['criteria', 'rules'],
      think: 'strong', build: 'strong',
    },
  },
  lenses: { code: [], spec: [] },
  // timeoutMinutes: the review's Copilot run, below the review job's 45.
  review: { depth: 'normal', tinyLines: 30, smallLines: 300, timeoutMinutes: 35 },
  learn: { enabled: true },
  github: {
    labels: { ready: 'ready-for-ai', working: 'ai-working', done: 'ready-for-human', stuck: 'needs-human', full: 'ship:full' },
    reviewWorkflow: 'harness-review.yml',
  },
  copilot: {
    bin: 'copilot',
    flags: ['--experimental'],
    allowTools: ['read', 'write', 'shell(git:*)'],
    denyTools: ['shell(git push)', 'shell(gh:*)'],
    extensionEnv: [],
    limits: null,
    // The whole Copilot run, below the workflow job's timeout-minutes (120).
    timeoutMinutes: 100,
  },
}

// The lenses harness/lib/prompts.mjs defines; extra ones come from config.lenses.
const BUILT_IN_LENSES = { code: ['combined', 'criteria', 'rules'], spec: ['combined', 'criteria', 'fit'] }
// Review also has a built-in `tests` lens; an extra lens may not reuse any of these keys.
const RESERVED = { code: new Set([...BUILT_IN_LENSES.code, 'tests']), spec: new Set(BUILT_IN_LENSES.spec) }

const plain = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp)

// Objects that describe the project as a whole are replaced, not merged: a
// default `app` area beside the project's own would inflate every ticket's
// area count.
const REPLACE = new Set(['areas'])

/** Deep merge: objects merge key by key; arrays, functions, regexes and REPLACE keys replace. */
export function merge(base, over) {
  if (!plain(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = plain(v) && plain(base?.[k]) && !REPLACE.has(k) ? merge(base[k], v) : v
  return out
}

export function resolveConfig(user = {}) {
  const c = merge(DEFAULTS, user)
  const problems = []
  if (!Array.isArray(c.commands.gate) || !c.commands.gate.length) problems.push('commands.gate needs at least one command, as a list of { name, run }')
  else if (c.commands.gate.some((g) => !g || !g.name || !g.run)) problems.push('every commands.gate entry needs a name and a run')
  // These are called mid-run: a wrong type would crash after credits are spent.
  for (const k of ['isTest', 'id']) if (typeof c.tests[k] !== 'function') problems.push(`tests.${k} must be a function of a file path`)
  for (const k of ['weakenedIfRemoved', 'weakenedIfAdded']) if (!(c.tests[k] instanceof RegExp)) problems.push(`tests.${k} must be a regular expression`)
  for (const k of ['code', 'spec']) if (!Array.isArray(c.lenses[k])) problems.push(`lenses.${k} must be a list of lenses`)
  if (problems.length) throw new Error(`harness.config.mjs: ${problems.join('; ')}`)
  for (const t of Object.values(c.tiers)) {
    for (const k of ['think', 'build']) if (t[k] && !(t[k] in c.models)) problems.push(`a tier names model "${t[k]}", which models does not define`)
  }
  for (const [kind, ls] of [['code', c.lenses.code], ['spec', c.lenses.spec]]) {
    const seen = new Set()
    for (const l of ls) {
      if (!l.key || !['string', 'function'].includes(typeof l.ask)) problems.push('every extra lens needs a key and an ask (a string, or a function of the base ref)')
      // Two lenses with one key share a label, and a dead one can't be named.
      if (RESERVED[kind].has(l.key) || seen.has(l.key)) problems.push(`lens key "${l.key}" is taken — every ${kind} lens needs its own key`)
      seen.add(l.key)
      if (l.model && !(l.model in c.models)) problems.push(`lens "${l.key}" names model "${l.model}", which models does not define (a slot: ${Object.keys(c.models).join(', ')})`)
      // A lens no tier selects never runs, and the run reads as audited without it.
      for (const t of l.tiers || []) if (!(t in c.tiers)) problems.push(`lens "${l.key}" names tier "${t}", which tiers does not define`)
      const named = Object.values(c.tiers).some((t) => (t[kind === 'code' ? 'codeLenses' : 'specLenses'] || []).includes(l.key))
      if (!(l.tiers || []).length && !named) problems.push(`lens "${l.key}" has no tiers and no tier lists it, so it would never run`)
    }
  }
  // A heavy area that is not an area can never be reported, so its rule
  // would never fire.
  for (const h of c.sizing.heavyAreas) if (!(h in c.sizing.areas)) problems.push(`sizing.heavyAreas names "${h}", which sizing.areas does not define`)
  // A mistyped lens key would mean no auditor at all, and a run that reads
  // as audited clean.
  const known = { code: new Set([...BUILT_IN_LENSES.code, ...c.lenses.code.map((l) => l.key)]), spec: new Set([...BUILT_IN_LENSES.spec, ...c.lenses.spec.map((l) => l.key)]) }
  // A cap is checked before the fixer runs, so one round would hand back
  // every confirmed blocker without trying to fix it.
  for (const [name, t] of Object.entries(c.tiers)) {
    if (!Number.isInteger(t.buildRounds) || t.buildRounds < 2) problems.push(`tiers.${name}.buildRounds must be a whole number of at least 2`)
    if (!Number.isInteger(t.specRounds) || t.specRounds < 0) problems.push(`tiers.${name}.specRounds must be a whole number, 0 or more`)
  }
  for (const k of ['source', 'tests', 'risky']) if (!Array.isArray(c.paths[k])) problems.push(`paths.${k} must be a list of path prefixes`)
  for (const [name, t] of Object.entries(c.tiers)) {
    for (const k of t.codeLenses || []) if (!known.code.has(k)) problems.push(`tiers.${name}.codeLenses names "${k}", which is no lens`)
    for (const k of t.specLenses || []) if (!known.spec.has(k)) problems.push(`tiers.${name}.specLenses names "${k}", which is no lens`)
    // A round with no lens records an audit that never happened — and
    // sizing can add a spec round to any tier.
    if (!(t.specLenses || []).length) problems.push(`tiers.${name} has no specLenses`)
    if (!(t.codeLenses || []).length) problems.push(`tiers.${name} has no codeLenses`)
  }
  if (problems.length) throw new Error(`harness.config.mjs: ${problems.join('; ')}`)
  return c
}

/** The config of the checkout at `root` (default: this harness's own). */
export async function loadConfig(root = ROOT) {
  const file = join(root, 'harness.config.mjs')
  if (!existsSync(file)) throw new Error(`no harness.config.mjs in ${root}`)
  return resolveConfig((await import(pathToFileURL(file).href)).default)
}

/** A tier's model slot → the id to pass, or undefined for Copilot's default. */
export const modelFor = (config, slot) => (slot && config.models[slot]) || undefined
