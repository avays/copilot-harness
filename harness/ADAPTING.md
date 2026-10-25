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
| `harness/` | All of it: `harness/test/` lets you check your changes to the harness, and this guide (`harness/ADAPTING.md`) is what the copied files' comments point to |
| `harness.config.mjs` | To the repository root |
| `.github/extensions/harness/` | Copilot discovers the extension here. The folder name must stay `harness` |
| `.github/workflows/harness-ship.yml`, `harness-review.yml`, `harness-setup.yml` | The names are prefixed, so they won't collide with the project's own |

**Don't copy** the root `README.md`, `AGENTS.md` or `package.json`. They describe this boilerplate, and
the project's `AGENTS.md` must stay its own.

Add `.harness/` to the project's `.gitignore`. The harness writes its own ignore file there too, so this is
belt and braces.

Then edit the three workflow files where they say `ADAPT`:

- **The JDK.** `actions/setup-java` defaults to Temurin 21 in `harness-ship.yml` and `harness-review.yml`.
  A project still on 8, 11 or 17 would get a red gate on round one, and every ticket would be handed back.
- **The label names**, if you change them. They live in three places that must agree:
  `github.labels` in `harness.config.mjs`, the `if:` in `harness-ship.yml`, and the `gh label create`
  lines in `harness-setup.yml`.
- **Anything else the gate needs on the runner,** installed in the build job *before* the step that turns
  sudo off: system packages, a database, browsers.
- **Docker.** The build and review jobs switch Docker off before the agents start, because access to
  Docker is root by another name. If the gate needs it (Testcontainers is common in Spring Boot), delete
  the Docker lines in that step, and read §9 *Isolation* first: the boundary inside the job is then gone.
  `./mvnw verify` passing on a laptop with Docker running proves nothing about this.

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
  to `null`: the harness says so in every PR's *Not verified* section, and doctor shows it as a ⚠
  warning rather than a failure.
- **Private Maven repositories:** the gate has to download dependencies, so the build job needs the
  repository's credential, and **the agents will be able to read it**. Use a **read-only package token**
  that can do nothing but download artifacts. Wire it like this in `harness-ship.yml` (and in
  `harness-review.yml` if reviewers build):

  ```yaml
  - uses: actions/setup-java@v4
    with:
      distribution: temurin
      java-version: "21"
      server-id: company-maven            # the <id> in your pom's <repository>
      server-username: MAVEN_USER         # names of env vars, not values
      server-password: MAVEN_TOKEN
  # …
  - name: Build
    env:
      COPILOT_GITHUB_TOKEN: ${{ secrets.COPILOT_GITHUB_TOKEN }}
      MAVEN_USER: ${{ secrets.MAVEN_USER }}
      MAVEN_TOKEN: ${{ secrets.MAVEN_READ_TOKEN }}
  ```

  In a probe on CLI 1.0.103 such variables reached the extension (which runs the gate) without further
  setup. Only if the gate can't authenticate, list the names in `copilot.extensionEnv` (§9).

### `paths`

Every path is a **prefix from the repository root**. In a multi-module build, write the module in:
`app/src/main/`, not `src/main/`. With the wrong prefix nothing matches, and red-check, test-tampering
detection, escalation and review sizing all go quiet without an error. Doctor fails when `source` or
`tests` matches no tracked file.

- **`source`**: app code; red-check reverts it. Leave out legacy code that tickets don't change.
- **`tests`**: where tests live. Only test files under these paths count as the branch's tests.
- **`risky`**: a small run whose diff touches one of these is escalated to the full loop. They are
  prefixes too, **with no globs**. For a migration, consider `src/main/resources/META-INF/persistence.xml`,
  `src/main/resources/application` (which covers `application.yml` and `application-prod.yml`), the
  Flyway or Liquibase folder, security configuration, every module's `pom.xml` (`pom.xml`, `app/pom.xml`),
  and anything shared by the legacy and new code. Doctor warns (⚠, not a failure) about an entry that
  matches no file yet, such as a migrations folder still to come.
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
Write it like a brief for a reviewer who has never seen the project. It may be a string, or a function
of the base ref (`(base) => \`… git diff ${base}...HEAD …\``). A lens needs `tiers` (`small`, `full`), or a
tier's `codeLenses` / `specLenses` must list its key. Its key can't be one of the built-in lenses'
(`combined`, `criteria`, `rules`, `tests`, `fit`). Its optional `model` is a slot (`light`, `standard`,
`strong`). The config refuses anything else, because a lens that never runs would read as a clean
audit.

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
| `COPILOT_GITHUB_TOKEN` (secret) | Copilot's model calls. A **fine-grained PAT owned by a person** (not an organisation). Under *Repository access* choose **Public repositories** and grant no repository permissions; under *Account permissions* grant **Copilot Requests** only. The agents' job holds this token and an agent can read it, so it must be good for nothing but Copilot. Classic `ghp_` tokens are not supported | Yes |
| `HARNESS_GH_TOKEN` (secret) | A PAT for the claim and publish jobs instead of `GITHUB_TOKEN` (contents, issues and pull requests: read and write). Pull requests and pushes made with `GITHUB_TOKEN` start no other workflows, so the project's CI won't run on them; the harness works around this only for its own review, by dispatching it. With a PAT, the project's CI does run on harness branches, and that CI runs code the agents wrote, with whatever secrets the project gives same-repository branches. Decide whether that is acceptable before you add one | No |
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
- **Put Copilot's token in `COPILOT_GITHUB_TOKEN`, never in `GH_TOKEN` or `GITHUB_TOKEN`.** The build job,
  where the agents run, is given no GitHub token at all, and `run.mjs` also removes any it finds from the
  environment it starts Copilot in. A Copilot login carried by `GH_TOKEN` would be removed too.
- **The harness never pushes workflow files.** A change that touches `.github/workflows/` is handed back
  for a person to apply, because a pushed workflow runs on its branch with the repository's secrets. The
  commits are in the run's `handoff-build` artifact as a git bundle.

## 7. Prove it, cheapest first

1. `node --test harness/test/*.test.mjs` — the harness's own tests, no network.
2. `node harness/bin/doctor.mjs` — local readiness. Fix every ✗.
3. `node harness/bin/doctor.mjs --live` — Copilot loads the harness staged from **this working tree** and runs
   `harness-ping`, a workflow that starts **no agents and costs no credits**. That proves the CLI starts,
   signs in, finds the extension and reads the config. It makes no model call, so it does **not** prove
   the token may make Copilot requests. Step 5 does.
4. **Commit the harness and merge it into the default branch** (and into `base`, if that's different).
   The Actions jobs check out the default branch, and it is that copy of the harness and its config that
   runs. GitHub also only runs the setup workflow, and only fires the `labeled` trigger, from the default
   branch. Locally, the harness that runs is the one in the checkout you run `run.mjs` from.
5. **Actions → Harness · setup → Run workflow** — creates the labels and runs step 3 on a runner.
6. **One tiny ticket, locally, without publishing:** `node harness/bin/run.mjs ship <n> --no-publish`.
   Pick a real but small change, and let it size itself. A forced size (`--small`, `--full`) also turns
   off escalation, so it would not show you that. Nothing is pushed, posted or labelled. Read its run folder
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
| **Browser or API QA** (drive the running app, try to break it) | A lens with a `tiers` entry whose `ask` starts the app (`./mvnw spring-boot:run` in the background on a free port), probes it with `curl` or Playwright, and stops it. Every lens of a round runs at once, so it must pick a port no other lens or test uses. Then add the tools it needs to `copilot.allowTools` |
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
  conflicts, extra lenses, hand-backs and Learn. `node --test harness/test/*.test.mjs` runs 115 tests
  against a fake Copilot context and real git repositories. While building it, about sixty mutations
  of the loop were tried by hand; each behaviour a surviving mutation exposed got a test.
- The gate, red-check and base-sync, against a real git repository, by the same tests. So is the agents'
  environment: with it, git hands out no stored credential, and workflow-file edits are detected.
- **Copilot CLI loads the staged harness and runs a workflow headless**, with the command line,
  environment and staging `run.mjs` uses. `doctor --live` runs `harness-ping` and prints the credits it
  used (0 on CLI 1.0.103).
- Staging (no folder trust carried over), the agents' environment, and the timeout that stops Copilot
  and everything it started, by the same tests, live.

**Checked by hand while building it:** the Copilot SDK's `defineWorkflow` accepts all three workflow
definitions (`doctor --live` fails if registration does), and the workflow files pass
[actionlint](https://github.com/rhysd/actionlint) (`actionlint .github/workflows/harness-*.yml`).

**Not yet proved — check these in §7:**

- **A real `ship` or `review` run with agents.** No agent has run yet. Expect to tune prompts after the
  first few tickets.
- **`run.mjs`'s prepare and publish phases, and the Actions jobs end to end** — claiming, the bundle hand-off,
  pushing, opening and readying pull requests, relabelling, dispatching the review and updating its
  comment. No test covers them, because they talk to GitHub. §7 steps 6–8 do.
- **The token's Copilot Requests permission.** `--live` makes no model call; the first ticket does.
- **Structured output from the models you choose.** Copilot validates each agent's answer against the
  schema and re-asks once. A model that keeps failing makes that agent return null, which the harness
  treats as "did not finish".
- **Permission patterns.** Deny rules always beat allow rules (`copilot help permissions`), but shell
  rules match on the first subcommand, so a git alias might get round `shell(git push)`. The harness
  doesn't rely on the deny list (see *Isolation* below). Check that an agent *can* run `./mvnw` and
  `git commit` in the workspace, and that nothing it needs is denied.
- **Repository hooks in the workspace** (`.github/hooks/*.json`). Copilot gates them on folder trust as it
  does extensions, and the staged home trusts no folder, but whether one fires in a headless agent
  session hasn't been observed: `ping` starts no agent. The first real run will show it.
- **The *Isolate the agents* step on a hosted runner.** It creates the agents' user, copies the
  checkout, rewrites sudoers and checks the result, and runs the build through `sudo -u harness-agent`
  with `PATH`, `JAVA_HOME` and the Copilot token passed through. None of this can run on a laptop, so
  the first *Harness · ship* run is its test. The step fails closed, so a runner image that differs
  (sudoers layout, tool-cache permissions) stops the job rather than running the agents unisolated.
  Adapt it rather than delete it.
- **`copilot.extensionEnv` headless.** In a probe on CLI 1.0.103, ordinary variables such as
  `MAVEN_TOKEN` reached the extension without being asked for, and listing one still loaded headless. The
  SDK documents `GITHUB_TOKEN` as stripped, and says a refused request stops the extension loading, so
  every workflow would fail with exit code 2. Leave the list empty unless the gate can't authenticate,
  and run `doctor --live` after changing it.

**Isolation — what the agents can and cannot reach:**

- **Where the harness comes from.** `run.mjs` copies the harness from the checkout it runs in (in Actions,
  the default branch) into a temporary Copilot home and loads it as a *user* extension. Copilot then runs
  in the workspace — the branch, or the pull request, checked out under `.harness/worktrees/` — so the
  agents' shells start in the tree they edit. Copilot never loads the workspace's own copy. Headless, it
  loads project extensions only for a trusted folder, or with an opt-in, and the harness removes both:
  the opt-in variables are stripped, and the staged Copilot home gets a copy of your config with every
  trusted folder removed. A folder you once trusted interactively therefore stays untrusted here (shown
  live on CLI 1.0.103: with your trust linked in, the workspace's extension loaded; staged, it did not).
  So agents' edits to `harness/` or `harness.config.mjs` on a branch can't change the loop, the limits
  or the gate of a later run. The staged home also keeps the run's own sessions, logs and settings, so a run
  leaves nothing in your `~/.copilot` (it used to switch experimental mode on there).
- **In Actions, the agents run as a user of their own.** The build job creates an unprivileged
  `harness-agent` user, copies the trusted checkout to `/srv/harness/root` (owned by root and read-only
  to that user, except its `.harness/`, which holds the workspace and the run's outputs), and runs
  `run.mjs`, and so Copilot and every agent, as `harness-agent`. Then it replaces sudo with one rule:
  the job's own user may run commands as `harness-agent`, and nothing as root. The step fails closed if
  root sudo, the agents' sudo, their Docker access or their write access to the job's checkout survives.
  So the agents' code can't write anything a later step runs (the checkout's `.git/config`, the
  downloaded actions, the step's command files), can't read those steps' environment or the runner's
  memory, and can't become root. When the build ends, every process of that user is killed at once
  (`kill -9 -1` as that user), and again in an `always()` step.
- **No GitHub credential in the agents' reach.** The build job's read-only token is used only by the
  checkout and setup actions, and only `COPILOT_GITHUB_TOKEN` is passed to the agents' user. Every
  job's trusted checkout is pinned to the default branch, so a run started by hand from another branch
  still runs the default branch's harness. The job saves no cache. Claiming and publishing are separate
  jobs that never run branch code. The work crosses to publish as a git bundle. Publish takes the issue,
  branch and title from the claim (never from the build), checks where it is pushing, never pushes a
  workflow file, and makes agent-written text in the PR body inert (no closing keywords, no
  @mentions).
- **What an agent that went wrong can still do,** with `COPILOT_GITHUB_TOKEN` scoped to Copilot alone:
  spend Copilot credits (up to `copilot.timeoutMinutes`, and any `copilot.limits`); read anything the
  build job gives it (a read-only package token, if you add one); write commits a person will review;
  and **write the build job's report**, that is the PR body's *Checks* and audit table, since the
  hand-off is written by the agents' user. The project's own CI on the pull request is the independent
  check, so make it a required status check. If the gate needs Docker (Testcontainers), the agents'
  user needs Docker access, and that is root: the boundary inside the job is then gone. Run that build
  in a container or VM of its own, or accept it for tickets from people you trust.
- **Who can start a run.** Anyone who can label an issue (triage access) can ship it, and its body is the
  agents' brief, so prompt injection arrives that way. Keep `ready-for-ai` to people who would review the
  result.
- **On a laptop there is no isolation.** Agents run as you. `run.mjs` removes GitHub tokens and the ssh
  agent from their environment, turns off git's credential helpers and points ssh at no key, so an
  ordinary `git push` fails over https and ssh alike. But code an agent writes can still read your stored
  credentials (`~/.config/gh/hosts.yml`, keychains, `~/.ssh`). Run real tickets in Actions. Locally, use
  a devcontainer, or a machine account with no push rights, if the tickets are not ones you would run
  yourself. Locally, the harness that runs is the one in the checkout you run `run.mjs` from.

**Known limits:**

- **Dynamic workflows are in preview.** The API is marked experimental and the flag is required. Pin the
  CLI and re-run §7 whenever you change it.
- **Pull requests from forks are never reviewed,** dispatched or not: their tree would be read by agents
  holding this repository's Copilot token. Branches older than the harness are reviewed like any other,
  because the harness comes from the base.
- **No resume in CI.** A run that stops before publishing (a Copilot limit, the job timeout, a lost
  runner) leaves nothing pushed, so relabelling starts over. The publish job still runs, says so on the
  issue and labels it `needs-human`. A run that published a draft continues on its branch, so that work
  is kept.
- **Inside a CI run, the base is fetched once.** The build job has no credentials, so the per-round merge
  of the base uses the copy the checkout fetched at the start of the job.
- **One ticket per run.** Several tickets run as several jobs. GitHub runs them in parallel, and each
  has its own runner.
- **Windows:** use WSL or Git Bash. Gate commands and `gh` calls run through `bash`.

## Checklist

- [ ] Files copied (§2); `.harness/` ignored; the workflows' JDK, label names, gate prerequisites and
      Docker decision made (§2)
- [ ] `instructions` lists the project's own rule files, and the migration decisions are written down (§3)
- [ ] `map` filled in (§3)
- [ ] `commands.gate` runs green in a clean clone; `quick` is fast; `testsOnly` works (§4)
- [ ] `paths.risky` names what is expensive to get wrong here (§4)
- [ ] `paths.lessons` is listed in `instructions` (§4)
- [ ] `sizing` describes this project's rules, data and contracts (§5)
- [ ] A parity lens, if this is a migration (§5)
- [ ] `COPILOT_GITHUB_TOKEN` secret, with Copilot Requests and no repository access (§6)
- [ ] `paths` are prefixes from the repository root, and doctor finds files under them (§4)
- [ ] Without a `HARNESS_GH_TOKEN`: Actions may create pull requests (§6)
- [ ] `doctor` and `doctor --live` green; the harness merged into `base`; *Harness · setup* green (§7)
- [ ] One small ticket shipped locally with `--no-publish`, then in CI (§7)
