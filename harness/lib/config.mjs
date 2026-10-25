// Defaults for every key in harness.config.mjs, and the merge. A project's
// config only needs what differs; ADAPTING.md says what each key is for.
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
  review: { depth: 'normal', tinyLines: 30, smallLines: 300 },
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
  },
}

const plain = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp)

/** Deep merge: objects merge key by key; arrays, functions and regexes replace. */
export function merge(base, over) {
  if (!plain(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = plain(v) && plain(base?.[k]) ? merge(base[k], v) : v
  return out
}

export function resolveConfig(user = {}) {
  const c = merge(DEFAULTS, user)
  const problems = []
  if (!Array.isArray(c.commands.gate) || !c.commands.gate.length) problems.push('commands.gate needs at least one command')
  for (const g of c.commands.gate || []) if (!g || !g.name || !g.run) problems.push('every commands.gate entry needs a name and a run')
  for (const t of Object.values(c.tiers)) {
    for (const k of ['think', 'build']) if (t[k] && !(t[k] in c.models)) problems.push(`a tier names model "${t[k]}", which models does not define`)
  }
  for (const l of [...c.lenses.code, ...c.lenses.spec]) if (!l.key || !l.ask) problems.push('every extra lens needs a key and an ask')
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
