// The one file to edit when you adopt the harness. harness/ADAPTING.md walks through
// every key; anything left out falls back to harness/lib/config.mjs.
//
// The values below are a starting point for a Maven / Spring Boot project.
// Every `TODO` is something only the adopting team can answer.

export default {
  // The branch work starts from and pull requests target.
  base: 'main',

  // The project's own rules. The harness never restates them: every agent is
  // told to read these first, and the rules auditor judges each diff against
  // them. Point at what the project already has — files or folders, missing
  // ones are skipped.
  instructions: [
    'AGENTS.md',
    '.github/copilot-instructions.md',
    '.github/instructions/',
  ],

  // One paragraph a fresh agent reads instead of re-learning the repo from
  // the source. Every agent starts with an empty context, and re-reading the
  // code is most of what a run costs, so this is the cheapest cut there is.
  map:
    'TODO: where things live, in two or three sentences. For example: "The legacy JBoss modules are under ' +
    'legacy/; the Spring Boot application is under app/. docs/migration/status.md lists what has moved and ' +
    'what each legacy EJB became."',

  paths: {
    // App code: what tests must prove. Red-check reverts these to the base.
    source: ['src/main/'],
    tests: ['src/test/'],
    // A small run whose diff reaches one of these is escalated to the full
    // loop. Put what is expensive to get wrong here.
    risky: [
      'pom.xml',
      'src/main/resources/db/',
      'src/main/resources/application',
      '.github/',
      'harness/',
      'harness.config.mjs',
    ],
    specs: 'specs',
    // Where Learn writes what the audits kept catching. Add it to
    // `instructions` above so the next run reads it.
    lessons: 'docs/harness-lessons.md',
  },

  commands: {
    // The gate: every command must exit 0. Run in order; the first red stops it.
    gate: [{ name: 'build and test', run: './mvnw -B -ntp verify' }],
    // What agents run after each edit: fast, not the whole gate.
    quick: './mvnw -B -ntp -q test',
    // Runs only the named tests; {tests} becomes a comma-separated list of
    // tests.id() values. Used by red-check; null turns red-check off.
    testsOnly: './mvnw -B -ntp -q test -Dtest={tests} -Dsurefire.failIfNoSpecifiedTests=false',
    // JUnit XML report folders, read after the gate to name failing tests.
    reports: ['target/surefire-reports', 'target/failsafe-reports'],
  },

  tests: {
    isTest: (file) => /(Test|Tests|IT)\.(java|kt|groovy)$/.test(file),
    // A test file → what commands.testsOnly takes. Java: the class name.
    id: (file) => file.split('/').pop().replace(/\.(java|kt|groovy)$/, ''),
    // A removed line matching this, or an added line matching the next, is
    // flagged to the auditor as a possibly weakened test. It does not fail
    // the gate: a ticket can legitimately change behaviour.
    weakenedIfRemoved: /@Test\b|assert[A-Z]\w*\(|assertThat\(|verify\(/,
    weakenedIfAdded: /@Disabled\b|@Ignore\b|assumeTrue\(|assumeFalse\(/,
  },

  // What setup reports about a ticket, in this project's words. The script
  // sizes the run from these facts by one rule (harness/lib/sizing.mjs).
  sizing: {
    areas: {
      web: 'controllers, REST resources, filters, views',
      service: 'services, business logic, former EJBs',
      persistence: 'entities, repositories, DAOs, queries',
      config: 'Spring configuration, properties, security config',
      build: 'pom.xml, Maven or Gradle build files',
      harness: '.github/, harness/, harness.config.mjs',
    },
    // Touching one of these areas buys the full loop.
    heavyAreas: ['harness'],
    rule: 'a business rule changes — TODO: name this project\'s, e.g. pricing, permissions, a state transition, a transaction boundary',
    data: 'the schema, a migration, or how stored data is read or written changes',
    api: 'an HTTP endpoint, a message contract or an interface another module calls changes',
    broadAreas: 3,
    broadFiles: 7,
    escalateLines: 300,
  },

  // Copilot model ids, or null for Copilot's default. List them in an
  // interactive `copilot` session with /model.
  models: {
    light: null,
    standard: null,
    strong: null,
  },

  // Extra audit lenses, beside the built-in ones. `tiers` says which runs
  // get it. For a migration, a parity lens is worth having — an example:
  lenses: {
    code: [
      // {
      //   key: 'parity',
      //   tiers: ['full'],
      //   ask: 'Compare the migrated code with the legacy implementation it replaces (legacy/<module>/). ' +
      //     'A blocker is behaviour the legacy code had that the new code drops or changes without the ' +
      //     'ticket asking: a transaction boundary, an exception mapped differently, a default, a null ' +
      //     'handled differently. Quote both sides.',
      // },
    ],
    spec: [],
  },

  review: {
    // 'fast' sizes reviews one step down, 'thorough' always large.
    depth: 'normal',
    tinyLines: 30,
    smallLines: 300,
  },

  github: {
    labels: {
      ready: 'ready-for-ai',
      working: 'ai-working',
      done: 'ready-for-human',
      stuck: 'needs-human',
      full: 'ship:full',
    },
    // The review workflow to start once ship opens a pull request. A pull
    // request opened with GITHUB_TOKEN starts no other workflow by itself.
    reviewWorkflow: 'harness-review.yml',
  },

  copilot: {
    // Options before `workflow run`. --experimental is required while
    // dynamic workflows are in preview.
    flags: ['--experimental'],
    // What subagents may do. Headless runs never prompt: anything not
    // allowed here is denied.
    allowTools: [
      'read',
      'write',
      'shell(./mvnw:*)',
      'shell(mvn:*)',
      'shell(git:*)',
      'shell(ls:*)',
      'shell(cat:*)',
      'shell(grep:*)',
      'shell(find:*)',
      'shell(sed:*)',
      'shell(head:*)',
      'shell(tail:*)',
      'shell(wc:*)',
    ],
    // Agents commit; only harness/bin/run.mjs pushes and talks to GitHub.
    denyTools: ['shell(git push)', 'shell(gh:*)'],
    // Variables the gate needs that Copilot strips from the extension
    // process. In a probe on CLI 1.0.103 ordinary ones (MAVEN_TOKEN) were not
    // stripped; a refused request stops the extension loading. Leave empty
    // unless the gate cannot authenticate (ADAPTING §9).
    extensionEnv: [],
    // Workflow ceilings ({ maxAiCredits, timeoutSeconds, maxTotalSubagents }).
    // Set one only from a cost you have measured: a guessed ceiling stops a
    // healthy run after it has already spent the credits.
    limits: null,
  },
}
