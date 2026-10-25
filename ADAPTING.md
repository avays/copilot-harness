# Adapting the harness to an existing project

This guide is for the developer fitting the harness into a project that already exists: one with
its own instructions, rules and build. It was written with a **JBoss → Spring Boot migration** in mind,
so the examples are Maven and Java, but nothing in the harness is specific to either.

Work through it in order. Each section ends with a check, and the checks get more expensive as you go:
the first ones cost nothing, and only §7 spends AI credits.

**What you are adopting:** the *workflow* — the loops, the gate, the audits and the publishing.
**What stays the project's:** its instructions, its conventions, its build and its tests. The harness
reads them; it never replaces or restates them.

---

## 1. Before you start

| You need | Why | How to check |
| --- | --- | --- |
| A Copilot plan with **token-based billing** | Dynamic workflows refuse to run on the legacy request-based plans (JSON-RPC `-32601`, `dynamic_workflows_unavailable`) | §7's ping fails with that code |
| The org policy allowing **Copilot CLI** | Headless runs are Copilot CLI | `copilot --version`, then §7 |
| A build that runs **headless on a clean Ubuntu runner** | The gate runs it every round | `./mvnw -B -ntp verify` in a fresh clone |
| Node 20+ on the runner | The harness is plain Node, with no npm dependencies | `node --version` |
| Somewhere for **tickets** | The harness reads GitHub Issues | `gh issue list` |

If the build needs a running JBoss or WildFly (Arquillian, for example), sort that out first. Either the
gate runs the tests that don't need a server, or the job starts one. A gate that can't run is a ticket
handed back on its first round.

## 2. Copy the files in

From this repository into the project's:

| Copy | Notes |
| --- | --- |
| `harness/` | All of it, `harness/test/` included: the tests let you check your changes to the harness |
| `harness.config.mjs` | To the repository root |
| `.github/extensions/harness/` | Copilot discovers the extension here. The folder name must stay `harness` |
| `.github/workflows/harness-ship.yml`, `harness-review.yml`, `harness-setup.yml` | The names are prefixed, so they won't collide with the project's own |

**Don't copy** `README.md`, `ADAPTING.md`, `AGENTS.md` or `package.json`. They describe this boilerplate,
and the project's `AGENTS.md` must stay its own. Link to this repository from the project's docs instead.

Add `.harness/` to the project's `.gitignore`. The harness writes its own ignore file there too, so this is
belt and braces.

Then edit the three workflow files where they say `ADAPT`:

- **The JDK.** `actions/setup-java` defaults to Temurin 21 in `harness-ship.yml` and `harness-review.yml`.
  A project still on 8, 11 or 17 would get a red gate on round one, and every ticket would be handed back.
- **The label names**, if you change them. They live in three places that must agree:
  `github.labels` in `harness.config.mjs`, the `if:` in `harness-ship.yml`, and the `gh label create`
  lines in `harness-setup.yml`.

**Check:** `node harness/bin/doctor.mjs` runs. It will list what is still to do.

## 3. Point the harness at the project's own instructions

This is the most important step, and the one most specific to your project.

**`instructions`** lists the files every agent reads first, and the files the *rules* auditor judges
every diff against. List what the project already has:

```js
instructions: [
  'AGENTS.md',                         // if the project has one
  '.github/copilot-instructions.md',   // Copilot's repository instructions
  '.github/instructions/',             // path-scoped *.instructions.md files: list the folder
  'docs/migration/decisions.md',       // ADAPT: wherever the migration's decisions live
],
```

- **Don't move or rewrite the project's rules to suit the harness.** If they live in several files, list
  them all. Missing paths are skipped.
- **Rules that only live in people's heads or a wiki** never reach an agent. The harness can't enforce
  what isn't written down, so this is the moment to put them in a file in the repository.
- **For the migration specifically**, an auditor can only hold the line on decisions that are written
  down. Check that they are. Typical ones:
  - what an EJB becomes (`@Service`? `@Component`? Which scope?)
  - how `@TransactionAttribute` semantics map onto `@Transactional` (propagation, rollback rules)
  - JNDI lookups → Spring configuration and `application.yml`
  - JAX-RS resources kept or rewritten to Spring MVC, and how exceptions map to HTTP status
  - security domains → Spring Security
  - which legacy module is the source of truth while both run

**`map`** is one paragraph that tells a fresh agent where things live. Every agent starts with an empty
context, and a missing map means each one re-reads the source to orient itself. That is most of what a
run costs. For example:

```js
map: 'The legacy JBoss EAR is under legacy/ (orders-ejb, orders-web). The Spring Boot application is ' +
  'under app/; each migrated bounded context is a package under app/src/main/java/com/acme/. ' +
  'docs/migration/status.md lists what has moved and what each legacy EJB became.',
```

**Check:** doctor shows `✓ project instructions exist` and `✓ config.map is filled in`.

## 4. The gate, the paths and the tests

### `commands`

```js
commands: {
  gate: [{ name: 'build and test', run: './mvnw -B -ntp verify' }],
  quick: './mvnw -B -ntp -q test',
  testsOnly: './mvnw -B -ntp -q test -Dtest={tests} -Dsurefire.failIfNoSpecifiedTests=false',
  reports: ['target/surefire-reports', 'target/failsafe-reports'],
},
```

- **`gate`** is the definition of green. Every command must exit 0. Put everything a reviewer would ask
  for here: tests, static checks, the formatter in check mode. It runs every round, so it has to fit
  comfortably inside the job's `timeout-minutes` (120 by default) several times over.
- **Multi-module builds:** the report folders are searched one module level deep. For a migration where
  the Spring Boot app is a module of the legacy build, consider gating only that module
  (`./mvnw -B -ntp -pl app -am verify`) if the legacy modules are slow or need a server.
- **`quick`** is what agents run after each edit. Make it fast; the gate is the thorough one.
- **`testsOnly`** is what red-check uses. `{tests}` becomes a comma-separated list of
  `tests.id(file)` values. For Surefire that's class names. If red-check can't be made to work, set it
  to `null`: the harness says so in every PR's *Not verified* section.
- **Private Maven repositories:** use `actions/setup-java`'s `server-id` and `settings-path` inputs in
  the workflow files. If the extension's own build commands need the token as an environment variable, list it in
  `copilot.extensionEnv`, because Copilot strips secrets from extension processes unless they are asked for
  by name. *This hasn't been verified headless (§9).*

### `paths`

Every path is a **prefix from the repository root**. In a multi-module build, write the module in:
`app/src/main/`, not `src/main/`. With the wrong prefix nothing matches, and red-check, test-tampering
detection, escalation and review sizing all go quiet without an error. Doctor warns when `source` or
`tests` matches no tracked file.

- **`source`**: app code; red-check reverts it. Leave out legacy code that tickets don't change.
- **`tests`**: where tests live. Only test files under these paths count as the branch's tests.
- **`risky`**: a small run whose diff touches one of these is escalated to the full loop. For a
  migration, consider `persistence.xml`, `src/main/resources/application*.yml`, Flyway or Liquibase
  folders, security configuration, `pom.xml`, and anything shared by the legacy and new code.
- **`lessons`**: where Learn writes. **Add this file to `instructions`**, or the lessons are never read.

### `tests`

`isTest`, `id`, `weakenedIfRemoved` and `weakenedIfAdded` are already set for JUnit. Change them for
Spock (`*Spec.groovy`), Cucumber or Kotest.

**Check:** run the gate command yourself in a clean clone, then run red-check on a branch with a real
change and its test (`node -e "import('./harness/lib/red-check.mjs').then(async m => console.log(await m.redCheck({ config: await (await import('./harness/lib/config.mjs')).loadConfig(), cwd: process.cwd(), base: 'origin/main' })))"`).
It should print `failedOnBase: true`.

## 5. Sizing, lenses and models

### `sizing`

Setup reports facts about each ticket, and `harness/lib/sizing.mjs` turns them into a loop by one
rule. You describe the facts in the project's own words, and the descriptions go to the setup agent
verbatim:

- **`areas`**: the parts of this codebase, so "touches 3+ areas" means something. For a migration you
  might use `legacy`, `web`, `service`, `persistence`, `config`, `build`, `harness`.
- **`heavyAreas`**: touching one of these buys the full loop. `harness` should stay in the list.
- **`rule`**: name the business rules a mistake is expensive in: pricing, entitlements, a state
  machine, transaction boundaries.
- **`data`** and **`api`**: what counts as changing stored data or a contract here. Contracts other
  teams consume deserve care during a migration.

### `lenses`

The built-in audit lenses are `combined` (small tickets), `criteria` and `rules` (full tickets). Add
your own for a concern this project has. **For a migration, a parity lens is the one most worth
adding.** It is the check that "the new code behaves like the old" that no generic reviewer makes:

```js
lenses: {
  code: [{
    key: 'parity',
    tiers: ['full'],          // or ['small', 'full'] for every ticket
    ask: 'Compare the migrated code with the legacy implementation it replaces (legacy/<module>/). ' +
      'A blocker is behaviour the legacy code had that the new code drops or changes without the ticket ' +
      'asking: a transaction boundary, an exception mapped to a different status, a default, null ' +
      'handling. Quote both sides.',
  }],
  spec: [],
},
```

A lens's `ask` is all its auditor is told about its job, on top of the ticket, the spec and the diff.
Write it like a brief for a reviewer who has never seen the project.

### `models` and `tiers`

`tiers` map each step to a model **slot** (`light`, `standard`, `strong`), and `models` maps each slot to a
Copilot model id. `null` uses Copilot's default. Start with all three set to `null` so a run works
whatever the plan offers. Then set them: run `copilot` interactively and use `/model` to list the ids and
their relative costs. Setup always uses `strong`, because every later step is sized by its call.

**Check:** `node --test harness/test/*.test.mjs` still passes after your config changes. The tests use
their own config, so a failure here means you've changed the harness itself.

## 6. Tokens and repository settings

| Secret or variable | What for | Required |
| --- | --- | --- |
| `COPILOT_GITHUB_TOKEN` (secret) | Copilot's model calls. A **fine-grained PAT owned by a person** (not an organisation) with the **Copilot Requests** account permission. Classic `ghp_` tokens are not supported | Yes |
| `HARNESS_GH_TOKEN` (secret) | A PAT used for pushes, pull requests and labels instead of `GITHUB_TOKEN`. Pull requests and pushes made with `GITHUB_TOKEN` start no other workflows, so the project's CI won't run on them; the harness works around this only for its own review, by dispatching it. A PAT is also the only way a ticket can change `.github/workflows/`, since `GITHUB_TOKEN` may not push those files (the PAT needs the `workflow` scope) | No |
| `COPILOT_CLI_VERSION` (variable) | Pins the Copilot CLI (default 1.0.103). Change it deliberately, then re-run §7's checks | No |

- Spend comes from the token owner's Copilot allowance. A dedicated account with its own seat
  keeps the harness's spend apart from a person's.
- Some write-ups describe running on the built-in `GITHUB_TOKEN` with a `copilot-requests: write`
  permission when the org enables "Copilot CLI billed to the organization". This hasn't been tried
  here. Test it on a branch before you rely on it.
- Without a `HARNESS_GH_TOKEN`, go to *Settings → Actions → General* and turn on **Allow GitHub Actions to
  create and approve pull requests**. Many organisations have it off by default, and without it the run
  fails at the very end, after the credits are spent. Doctor checks it when it can read the setting
  (admin rights).
- **Put Copilot's token in `COPILOT_GITHUB_TOKEN`, never in `GH_TOKEN` or `GITHUB_TOKEN`.** The harness
  removes every GitHub token from the environment it starts Copilot in, so that agents can't push or write
  to GitHub. A Copilot login carried only by `GH_TOKEN` would be removed too.

## 7. Prove it, cheapest first

1. `node --test harness/test/*.test.mjs` — the harness's own tests, no network.
2. `node harness/bin/doctor.mjs` — local readiness. Fix every ✗.
3. `node harness/bin/doctor.mjs --live` — Copilot loads the extension from **this working tree** and runs
   `harness-ping`, a workflow that starts **no agents and costs no credits**. That proves the CLI starts,
   signs in, finds the extension and reads the config. It makes no model call, so it does **not** prove
   the token may make Copilot requests. Step 5 does.
4. **Commit the harness and merge it into `base`**, and into the default branch if that's different.
   Every run works in a branch made from `origin/<base>`, so a harness that only exists in your working
   tree gives exit code 2 ("workflow not found"). GitHub only runs the setup workflow, and only fires the
   `labeled` trigger, from the copy on the default branch.
5. **Actions → Harness · setup → Run workflow** — creates the labels and runs step 3 on a runner.
6. **One tiny ticket, locally, without publishing:** `node harness/bin/run.mjs ship <n> --small --no-publish`.
   Pick a real but small change. Nothing is pushed, posted or labelled. Read its run folder
   (`.harness/runs/…/result.json`) and its worktree (`.harness/worktrees/issue-<n>`): the spec, the
   commits, the rounds, the credits.
7. **The same ticket in CI:** label it `ready-for-ai`. You get a pull request, or a draft with the
   reason. The run continues on the branch the local run made only if that branch was pushed;
   otherwise it starts fresh.
8. A ticket that should go to the full loop: one labelled `ship:full`, or one that changes a business
   rule.

## 8. Extending it

The workshop harness this was ported from had more than the workflow half. Here's where each piece
would go if you want it:

| Piece | Where it goes |
| --- | --- |
| **Browser or API QA** (drive the running app, try to break it) | A lens with a `tiers` entry whose `ask` starts the app (`./mvnw spring-boot:run` in the background on a free port), probes it with `curl` or Playwright, and stops it. Run it after the readers, because it needs ports. Then add the tools it needs to `copilot.allowTools` |
| **Legacy-vs-new parity probes** | The same idea, against both deployments: call the JBoss endpoint and the Spring Boot one with the same input and compare. For a migration this is the strongest evidence there is |
| **`@mention` on a PR to request a change** | A workflow on `issue_comment` that runs a third workflow: the fix step from `ship.mjs` with the comment as the finding, then the gate |
| **Live progress on the issue** | `run.mjs` reads Copilot's JSONL as it streams (`session.info` with `infoType: workflow_phase`); edit one comment as phases change |
| **Spend per issue** | `result.usage` is already in every result. Append it to one comment per issue |
| **A ticket-writing front end** | Out of scope here. The harness starts at a well-written issue with *Done when* criteria |

All prompt wording lives in `harness/lib/prompts.mjs`. All loop structure lives in `harness/workflows/`.
Change prompts freely. Change loops carefully, and add a test in `harness/test/ship.test.mjs` for each
behaviour you change.

## 9. What is proved and what is not

**Proved, and re-proved by a command you can run:**

- The ship and review loops: sizing, escalation, the skeptic, stuck detection, round limits, red rounds,
  conflicts, extra lenses, hand-backs and Learn. `node --test harness/test/*.test.mjs` runs 54 tests
  against a fake Copilot context.
- The gate, red-check and base-sync, against a real git repository, by the same tests.
- **Copilot CLI loads the extension and runs a harness workflow headless**, with the command line and
  token-stripped environment `run.mjs` uses. `doctor --live` runs `harness-ping`; on CLI 1.0.103 it
  completed with 0 credits.

**Checked once by hand while building it:** the Copilot SDK's `defineWorkflow` accepts all three workflow
definitions. Nothing re-runs that check, but `doctor --live` fails if registration does.

**Not yet proved — check these in §7:**

- **A real `ship` or `review` run with agents.** No agent has run yet. Expect to tune prompts after the
  first few tickets.
- **The token's Copilot Requests permission.** `--live` makes no model call; the first ticket does.
- **Structured output from the models you choose.** Copilot validates each agent's answer against the
  schema and re-asks twice. A model that keeps failing makes that agent return null, which the harness
  treats as "did not finish".
- **Permission patterns.** Whether `--deny-tool` takes precedence over a broader `--allow-tool` isn't
  documented, and shell rules match on the first subcommand, so a git alias might get round
  `shell(git push)`. The harness doesn't rely on the deny list. Every GitHub token is removed from the
  environment Copilot runs in, and in Actions the checkout keeps no credentials, so an agent's push has
  nothing to authenticate with. Check that an agent *can* run `./mvnw` and `git commit`, and that
  nothing it needs is denied.
- **`copilot.extensionEnv` headless.** Copilot asks the user before granting secrets to an extension. With
  no one there to ask, it may deny them.

**Known limits:**

- **Dynamic workflows are in preview.** The API is marked experimental and the flag is required. Pin the
  CLI and re-run §7 whenever you change it.
- **The review runs the extension from the PR branch.** A PR that changes `harness/` runs its own
  version of the harness with the repository's Copilot token. Fork PRs are skipped for that reason.
  Same-repo PRs are trusted, as any CI is. A branch older than the harness is skipped with a notice.
- **No resume in CI.** A run that stops before publishing (a Copilot limit, the job timeout, a lost
  runner) leaves nothing pushed, so relabelling starts over. The job-timeout and lost-runner cases also
  leave `ai-working` on the issue; remove it by hand. Any other failure is reported on the issue, which
  is labelled `needs-human`. A run that published a draft continues on its branch, so that work is kept.
- **Inside a CI run, the base is fetched once.** The agents' side has no credentials, so on a private
  repository the per-round merge of the base uses the copy `run.mjs` fetched at the start.
- **One ticket per run.** Several tickets run as several jobs. GitHub runs them in parallel, and each
  has its own runner.
- **Windows:** use WSL or Git Bash. Gate commands and `gh` calls run through `bash`.

## Checklist

- [ ] Files copied (§2); `.harness/` ignored; the workflows' JDK and label names match (§2)
- [ ] `instructions` lists the project's own rule files, and the migration decisions are written down (§3)
- [ ] `map` filled in (§3)
- [ ] `commands.gate` runs green in a clean clone; `quick` is fast; `testsOnly` works (§4)
- [ ] `paths.risky` names what is expensive to get wrong here (§4)
- [ ] `paths.lessons` is listed in `instructions` (§4)
- [ ] `sizing` describes this project's rules, data and contracts (§5)
- [ ] A parity lens, if this is a migration (§5)
- [ ] `COPILOT_GITHUB_TOKEN` secret; Actions may create PRs (§6)
- [ ] `paths` are prefixes from the repository root, and doctor finds files under them (§4)
- [ ] Without a `HARNESS_GH_TOKEN`: Actions may create pull requests (§6)
- [ ] `doctor` and `doctor --live` green; the harness merged into `base`; *Harness · setup* green (§7)
- [ ] One small ticket shipped locally with `--no-publish`, then in CI (§7)
