# Copilot harness

**GitHub Copilot takes a ticket to a verified pull request through deterministic audit loops.**

Label an issue `ready-for-ai`. A headless Copilot workflow writes a spec and has independent agents
audit it until a round comes back clean. Then it builds the change test-first, runs your real build, and
audits the code the same way. Then it opens a pull request that says what was proved and what was not.
A ticket that won't converge goes to a person as a **draft**, with everything still open written down.
Answer it in a comment, label it again, and the next run continues where that one stopped.

This repository is **boilerplate**. It is meant to be copied into an existing repository that already
has its own build, conventions and AI instructions, and adapted there. It was written with a
**JBoss → Spring Boot migration** in mind, so its defaults are Maven and Java, but nothing in the loop
is specific to either.

| If you want to… | Read |
| --- | --- |
| Understand what this is and whether it fits | [What it does](#what-it-does) and [How a ticket flows](#how-a-ticket-flows) |
| Merge it into the team's repository | [Merging it into the team's existing work](#merging-it-into-the-teams-existing-work) |
| Set every config key, step by step | [harness/ADAPTING.md](harness/ADAPTING.md), the detailed adoption guide |
| Know what is proven and what isn't | [Status](#status) and [ADAPTING §9](harness/ADAPTING.md#9-what-is-proved-and-what-is-not) |
| Change the harness itself | [Developing the harness](#developing-the-harness) and [AGENTS.md](AGENTS.md) |

---

## Contents

- [What it does](#what-it-does)
- [How a ticket flows](#how-a-ticket-flows)
- [The rules it is built on](#the-rules-it-is-built-on)
- [How much loop a ticket gets](#how-much-loop-a-ticket-gets)
- [The security model](#the-security-model)
- [Merging it into the team's existing work](#merging-it-into-the-teams-existing-work)
- [Running it](#running-it)
- [Configuration at a glance](#configuration-at-a-glance)
- [What it costs](#what-it-costs)
- [Troubleshooting](#troubleshooting)
- [Status](#status)
- [Repository layout](#repository-layout)
- [Developing the harness](#developing-the-harness)

---

## What it does

Three workflows, all triggered from GitHub:

| Workflow | Starts when | What it produces |
| --- | --- | --- |
| **Harness · ship** | an issue is labelled `ready-for-ai` (or dispatched by hand) | a pull request labelled `ready-for-human`, or a **draft** labelled `needs-human` with the reason and every open finding |
| **Harness · review** | a pull request is opened, marked ready or reopened (and after every ship) | one advisory comment: a verdict, a *confidence* that means coverage, the confirmed blockers and notes |
| **Harness · setup** | dispatched once, by hand | the labels, plus a no-cost check that Copilot can load the harness |

What ends up on a harness pull request:

- **The spec**, `specs/<issue>-<slug>.md`, committed first and audited clean before any code was
  written, with the reviewer's open *Decisions* as checkboxes.
- **The change**, built test-first: the failing test is committed red before the code that makes it
  pass.
- **Checks**: the gate's result, whether the new tests fail without the change (red-check), and how many
  problems the independent audits found and fixed.
- **Not verified**: everything the run did not prove, said plainly.
- **Every audit round**, spec and code, in a collapsible table, and what the run cost in AI credits.

What it deliberately does **not** do: merge anything, mark anything as a required check, or replace the
project's own CI. Machines gate, agents advise, and a person merges.

---

## How a ticket flows

```
issue labelled ready-for-ai
  │
  ├─ 1. claim job        reads the issue, claims it (ai-working), picks the branch     — GitHub token
  │
  ├─ 2. build job        copilot workflow run harness-ship, headless                   — no GitHub token;
  │      Setup           reads the ticket and the code, reports sizing facts             agents run as their
  │      Spec            specs/<n>-<slug>.md, its own commit                             own unprivileged user
  │      ┌▶ Spec audit   fresh auditors → a skeptic on every blocker        ← agents judge
  │      └─ Revise       every confirmed blocker; repeat until clean, or hand back
  │      Implement       failing test first, committed red, then the change
  │      ┌▶ Verify       merge the base · run the gate · red-check          ← code decides
  │      │  Code audit   fresh auditors → a skeptic on every blocker        ← agents judge
  │      └─ Fix          every confirmed blocker; repeat until clean, or hand back
  │      Learn           what the audits caught becomes a lesson in the docs
  │
  ├─ 3. publish job      pushes the work (a git bundle), opens the PR or a draft,      — GitHub token;
  │                      labels, comments                                                runs the default
  │                                                                                      branch's code only
  ├─ Harness · review    independent lenses → skeptic → one advisory comment
  │
  └─ a person merges
```

**The two audit loops are the same loop.** The spec audit runs first on every ticket, because the spec
decides what gets built: a misreading caught there costs one revision, not a build. Both loops follow
the same steps:
- **Fresh auditors** read the work, independently of whoever wrote it.
- **A skeptic tries to refute every blocker** before it costs a revision or a fix.
- **Every confirmed blocker is fixed,** and the work is audited again by fresh auditors, until a round
  comes back clean.
- **A loop hands back** when a ticket contradicts itself (at once), when the same finding survives two
  attempts, or at its round limit.

The spec loop runs on the strong model on every tier, with at least as many rounds as the build.

**When it hands back.** The same finding surviving two attempts, a round limit, a ticket that
contradicts itself, or an agent that can't finish ends the run with a draft (if anything was built) and
a comment on the issue saying why. A collaborator answers in a comment, or edits the ticket, and labels
it `ready-for-ai` again. The next run gets the hand-back and the answer as part of its brief, and
continues on the same branch.

---

## The rules it is built on

These are why each piece exists. Keep them when you change the harness.

- **A script, not a prompt.** Loops, round limits, sizing and who judges what are JavaScript
  (`harness/workflows/ship.mjs`). A model can't skip a round or quietly raise a limit.
- **Every agent is a fresh context.** An auditor sees the ticket, the spec and the diff, never the
  writer's or builder's reasoning. That independence is what makes an audit an audit.
- **The spec is audited like the code.** Same loop, same skeptic, same stopping rules, run first and on
  the strong model.
- **Machines decide facts.** Whether the build is green, whether the tree is clean and whether the new
  tests fail without the change are commands with exit codes (`gate.mjs`, `red-check.mjs`). No agent
  is asked.
- **Every blocker faces a skeptic** before it costs a revision or a fix. A false positive would make the
  fixer "fix" correct work. A skeptic that dies refutes nothing.
- **Hand back rather than burn rounds.** A finding that survives two attempts, or the round limit, ends
  the run with the open findings written down.
- **Sized by risk, not length.** Setup reports facts, and one rule turns them into a loop. The diff can
  escalate a small run on evidence.
- **The project's rules stay the project's.** Agents are pointed at your existing instruction files.
  The harness never restates or replaces them.
- **AI never holds the GitHub token.** See [The security model](#the-security-model).
- **Say what was not proved.** Every PR has a *Not verified* section. Review confidence means
  coverage, and a lens that never finished makes it *low*.

---

## How much loop a ticket gets

Setup reads the ticket and the code it would change, then reports **facts**: the areas it touches,
roughly how many source files, and whether it changes an API, a business rule or stored data. One rule
in `harness/lib/sizing.mjs` turns those facts into a loop. Every ticket gets both audit loops; size
decides how many auditors, how many rounds and which models.

| The ticket… | Spec audit | Code audit |
| --- | --- | --- |
| touches nothing risky (**small**) | setup writes the spec; one combined auditor, strong model, 2 rounds | one combined auditor, standard model, 2 rounds |
| changes an API, or is broad (3+ areas, ~7+ files) | as small | criteria and rules auditors, 3 rounds |
| leaves 2+ design questions open | an extra spec round (3) | as its size |
| changes a business rule, stored data or the harness, or is labelled `ship:full` (**full**) | its own spec writer; criteria and fit auditors, strong model, up to 4 rounds | criteria and rules auditors, strong model, up to 4 rounds |

**The diff can escalate a small run.** Once the gate is green, a diff that reaches a risky path
(`paths.risky`: `pom.xml`, `mvnw`, `.mvn/`, migrations, application config, `.github/`, the harness) or
grows past 300 source lines gets the full loop's code auditors and thinking model. A gate red twice in a
row moves the fixer to the strong model.

Extra **lenses** are where project knowledge goes. For a migration, the one most worth adding is a
**parity lens** that compares the migrated code with the legacy JBoss code it replaces (an example is in
`harness.config.mjs`). Spec lenses and code lenses are configured separately.

---

## The security model

The agents write code, and that code runs (every test they write runs). So the harness assumes an agent
might go wrong, through a bad model or a prompt-injected ticket, and limits what it can reach.

| | In GitHub Actions | On a laptop |
| --- | --- | --- |
| Where agents run | a separate unprivileged `harness-agent` user, in a job of its own | as you |
| GitHub token | none in the agents' reach; claim and publish are separate jobs | removed from their environment, but your stored credentials are readable |
| sudo, Docker | removed and verified before agents start (fails closed) | whatever you have |
| The harness that runs | the default branch's, never the branch's | the checkout you run from |
| Pushing | publish pushes a bundle; never workflow files or local actions | `run.mjs` pushes; agents' git has no credential helper |
| Agent text on GitHub | made inert: no closing keywords, no @mentions | the same |

**What an agent that went wrong can still do in Actions:**
- read the Copilot token and send it out, since its code has the network;
- read any read-only package token the build is given;
- write commits a person will review;
- write the build's report (the PR's *Checks* and audit table).

So give `COPILOT_GITHUB_TOKEN` a short expiry, keep it on a dedicated account with no repository access,
and make the project's own CI a required check on harness pull requests. **On a laptop there is no
isolation**; run real tickets in Actions. All of this is set out in
[ADAPTING §9](harness/ADAPTING.md#9-what-is-proved-and-what-is-not).

---

## Merging it into the team's existing work

This section is the plan for bringing the harness into a repository the team already works in. It
assumes that repository already has a Maven build, its own conventions, and probably its own AI
instructions. The detailed, key-by-key guide is [harness/ADAPTING.md](harness/ADAPTING.md). This
section tells you what to do, in what order, and what to agree as a team.

### At a glance

1. **Agree** the decisions in [What to decide as a team](#what-to-decide-as-a-team), which takes about
   30 minutes.
2. **Check** the [prerequisites](#1-prerequisites): Copilot plan, policy, a headless build.
3. **Add** the files on a branch, with no changes to existing ones except `.gitignore`.
4. **Point** the config at the team's existing instructions, and write down the migration decisions.
5. **Configure** the gate, the paths and the workflow files for this build.
6. **Set** two secrets and one repository setting.
7. **Prove** it, cheapest first, then merge the adoption branch.
8. **Roll out**: one small ticket, then a handful, then the team's normal flow.

### What you're adding

Everything the harness needs lives in a few new paths. Nothing existing is replaced.

| Add | Where | Notes |
| --- | --- | --- |
| `harness/` | repository root | the harness code, its tests and `harness/ADAPTING.md` |
| `harness.config.mjs` | repository root | **the one file the team edits** |
| `.github/extensions/harness/` | as is | Copilot discovers the extension here; the folder name must stay `harness` |
| `.github/workflows/harness-ship.yml`, `harness-review.yml`, `harness-setup.yml` | as is | prefixed, so they don't collide with existing workflows |
| `.harness/` | in `.gitignore` | the harness's local run folders and worktrees |

**Don't copy** this repository's root `README.md`, `AGENTS.md` or `package.json`. They describe the
boilerplate. The team's own `AGENTS.md` must stay its own, and the harness needs no `package.json`
because everything is `.mjs` with no dependencies.

### Where it meets what the team already has

| The team already has… | What happens | What to do |
| --- | --- | --- |
| `AGENTS.md`, `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` | Kept as they are. Every agent is told to read them first, and the rules auditors judge each spec and diff against them | List them in `instructions` (§3). Don't move or rewrite them for the harness |
| Rules in a wiki, Confluence or people's heads | Agents can't see them, and the audits can't enforce them | Write the ones that matter into a file in the repo and list it |
| A Maven build (`./mvnw verify`), maybe multi-module | Becomes the **gate**: the definition of green, run every round | Set `commands.gate`. Gate only the Spring Boot module if the legacy build is slow or needs a server (§4) |
| Arquillian or tests that need a running JBoss/WildFly | The gate runs on a clean Ubuntu runner, as an unprivileged user | Gate the tests that don't need a server, or start one before isolation. A gate that can't run means every ticket hands back on its first code round |
| Testcontainers / Docker in tests | Docker is **off** in the agents' job, because Docker access is root | Make three edits to re-enable it (ADAPTING §2), and accept that the isolation boundary is gone for those jobs |
| A private Maven repository | The build job needs its credential, and **the agents can read it** | Use a read-only package token; add it to the build step's env, `--preserve-env` and the artifact masking (ADAPTING §4) |
| Existing CI workflows | Untouched. But pull requests opened with the default `GITHUB_TOKEN` **don't trigger other workflows**, so the team's CI won't run on harness PRs by itself | Either add a `HARNESS_GH_TOKEN` PAT (CI then runs agent-written code with the CI's secrets), or have a person push or re-run CI on each harness PR. Decide this up front |
| Branch protection with required checks | Harness PRs need those checks too, and they only report if CI runs (row above) | Make the project's CI the required check; never make the harness review required |
| Required signed commits | Harness commits are **unsigned** (`harness[bot]`), so its PRs can't merge | Exempt `harness/*` branches, or have a person squash-merge with a signed commit |
| A commit message convention | Agents follow the project's instructions for commit messages | Make sure the convention is written in the instruction files |
| A PR title or branch naming rule | Harness branches are `harness/<issue>-<slug>`; PR titles are `<issue title> (#<n>)` | Allow these, or change `shipTitle` in `harness/lib/publish.mjs` |
| An existing `specs/` or ADR folder | Specs go to `paths.specs` (default `specs`) | Point it at the team's folder, or keep `specs/` for harness specs only |
| CODEOWNERS | Requests reviewers on harness PRs like any other | Nothing; that is the intended human review |
| Labels named `ready-for-ai`, `ai-working`, `ready-for-human`, `needs-human`, `ship:full` | The harness uses these exact names | Rename them in three places if they clash (ADAPTING §2) |
| GitHub's Copilot coding agent, other bots | Independent; no conflict | Keep issues for one or the other, so two agents don't pick up the same ticket |
| A folder already named `harness/` | Collides | Rename the team's folder; the harness path isn't configurable |

### What to decide as a team

Agree these before the first ticket. Each one is a setting or a sentence in the instructions.

| Decision | Options | Where it goes |
| --- | --- | --- |
| Who may label `ready-for-ai`? | anyone with triage access (default) / a smaller group | GitHub roles; ticket bodies are the agents' brief, so keep this to people who'd review the result |
| Does the harness review **every** PR, or only its own? | every ready PR (default) / harness branches only / a label | `on:` in `harness-review.yml`. Every review costs credits |
| How do harness PRs get CI? | `HARNESS_GH_TOKEN` PAT / a person re-runs CI | §6 secrets, and the CI row above |
| Which rules are *business rules* and which data is *stored data*? | name them | `sizing.rule`, `sizing.data` in `harness.config.mjs` |
| What is expensive to get wrong? | migrations, security config, `persistence.xml`, shared legacy code | `paths.risky` |
| Which migration decisions are fixed? | EJB → `@Service`, transaction semantics, JNDI → config, JAX-RS vs Spring MVC, security domains | a file listed in `instructions` |
| Is the parity lens on, and for specs, code or both? | full tickets only / every ticket / off | `lenses.code`, `lenses.spec` |
| Which models? | Copilot's default / chosen ids per slot | `models` (`light`, `standard`, `strong`); the spec audit uses `strong` |
| Who owns the Copilot token, and its spend? | a dedicated account with its own seat (recommended) | `COPILOT_GITHUB_TOKEN` |

### 1. Prerequisites

- **A Copilot plan with token-based billing.** Dynamic workflows refuse to run on legacy request-based
  plans.
- **The organisation's policy allows Copilot CLI.**
- **The build runs headless on a clean Ubuntu runner**: `./mvnw -B -ntp verify` in a fresh clone,
  without a local server, an IDE or a developer's `~/.m2`.
- **Actions enabled** on the repository, and Node 20+ available on runners (`setup-node` does it).

### 2. Add the files on a branch

From the team's repository root:

```bash
git switch -c chore/adopt-copilot-harness
git clone --depth 1 https://github.com/avays/copilot-harness /tmp/copilot-harness

cp -r /tmp/copilot-harness/harness ./harness
cp /tmp/copilot-harness/harness.config.mjs ./harness.config.mjs
mkdir -p .github/extensions .github/workflows
cp -r /tmp/copilot-harness/.github/extensions/harness .github/extensions/
cp /tmp/copilot-harness/.github/workflows/harness-*.yml .github/workflows/
grep -qxF '.harness/' .gitignore 2>/dev/null || echo '.harness/' >> .gitignore

node harness/bin/doctor.mjs     # lists what is still to do
```

Commit that as one commit with nothing changed yet. The team's own adaptations then show up as a
reviewable diff on top of it.

### 3. Point it at the team's instructions

In `harness.config.mjs`:

- **`instructions`**: every file that holds the team's rules, plus `paths.lessons` (where the harness
  writes what its audits keep catching) so the next run reads it.
- **`map`**: two or three sentences saying where things live: the legacy modules, the Spring Boot app,
  and where the migration status is recorded. It is the cheapest saving there is: without it, every
  agent re-reads the source to find its way.

Then, for the migration, write down what an auditor needs to hold the line on, and put it in one of the
instruction files:
- what an EJB becomes;
- how `@TransactionAttribute` maps onto `@Transactional`;
- JNDI lookups versus Spring config;
- how exceptions map to HTTP status;
- security domains;
- which module is the source of truth while both run.

The spec auditors read these, so they catch a plan that breaks one before any code exists. Details:
[ADAPTING §3](harness/ADAPTING.md#3-point-the-harness-at-the-projects-own-instructions).

### 4. Configure the build

- **`commands.gate`**: what green means. Tests, static checks, the formatter in check mode.
- **`commands.quick`**: what agents run after each edit; fast.
- **`commands.testsOnly`**: what red-check uses to run only the new tests (`-Dtest={tests}`).
- **`paths.source` / `tests` / `risky`**: prefixes from the repository root. In a multi-module build,
  write the module in (`app/src/main/`).
- **The workflow files**, where they say `ADAPT`:
  - the JDK (`setup-java`, default Temurin 21);
  - gate prerequisites, installed before *Isolate the agents*;
  - the Docker decision;
  - the private-repository token.

Details: [ADAPTING §4](harness/ADAPTING.md#4-the-gate-the-paths-and-the-tests) and
[§2](harness/ADAPTING.md#2-copy-the-files-in).

### 5. Set the secrets and settings

| Secret / setting | What | Required |
| --- | --- | --- |
| `COPILOT_GITHUB_TOKEN` (secret) | A fine-grained PAT owned by a person (ideally a dedicated account): *Public repositories* access with no repository permissions, plus the **Copilot Requests** account permission. Short expiry | yes |
| `HARNESS_GH_TOKEN` (secret) | A PAT for claim and publish, so harness PRs trigger the team's CI | the team's call (see above) |
| *Allow GitHub Actions to create and approve pull requests* | Settings → Actions → General. Needed without a PAT | yes, without a PAT |
| `COPILOT_CLI_VERSION` (variable) | Pins the Copilot CLI (default 1.0.103) | no |

Details: [ADAPTING §6](harness/ADAPTING.md#6-tokens-and-repository-settings).

### 6. Prove it, cheapest first

| Step | Command | Proves | Costs |
| --- | --- | --- | --- |
| 1 | `node --test harness/test/*.test.mjs` | the harness's own logic, after your config changes | nothing |
| 2 | `node harness/bin/doctor.mjs` | config, paths, gate command, labels, settings | nothing |
| 3 | `node harness/bin/doctor.mjs --live` | Copilot loads the staged harness and runs a workflow | 0 credits |
| 4 | merge the adoption branch to the default branch | the workflows can trigger (GitHub only runs them from there) | nothing |
| 5 | *Actions → Harness · setup → Run workflow* | labels, and step 3 on a runner | 0 credits |
| 6 | `node harness/bin/run.mjs ship <n> --no-publish` on one tiny real ticket | a real run with agents, locally; nothing pushed or posted | a few credits |
| 7 | label that ticket `ready-for-ai` | the three-job workflow, isolation and publishing on a real runner | a few credits |

Step 7 is the first real test of the *Isolate the agents* step. It **fails closed**: if the runner image
differs from what it expects, the job stops and the issue says so, rather than running agents
unprotected. Adapt that step if it fails; don't delete it.

### 7. Roll out to the team

1. **One small ticket** end to end (step 7). Read its PR, the run artifact (`harness-ship-runs`) and
   the credits.
2. **A handful of real tickets**, including one that should size `full` (a business rule) and one
   expected to hand back. Tune `instructions`, `map`, `sizing` and the lenses from what the audits
   catch. The lessons file collects what agents keep getting wrong.
3. **Write a ticket template** with an explicit *Done when* list. The harness builds what a ticket's
   acceptance criteria say, and the spec audit hands a vague ticket straight back.
4. **Then the team's normal flow**: label what's ready, review what comes back, merge as usual.

### Merge checklist

- [ ] Team decisions above agreed and recorded
- [ ] Files added in one commit; `.harness/` ignored
- [ ] `instructions` lists the team's own rule files, `paths.lessons` included
- [ ] Migration decisions written into an instruction file
- [ ] `map` filled in; no `TODO:` left in `harness.config.mjs`
- [ ] `commands.gate` green in a clean clone; `quick` fast; `testsOnly` works
- [ ] `paths` prefixes match the layout (doctor finds files under them)
- [ ] `sizing` names the team's business rules and stored data; parity lens decided
- [ ] Workflow `ADAPT` points done: JDK, gate prerequisites, Docker, private repository, review scope
- [ ] `COPILOT_GITHUB_TOKEN` set (Copilot Requests only, short expiry); PAT decision made
- [ ] CI on harness PRs decided; the team's CI is the required check, the harness review is not
- [ ] Signed-commit, branch-name and PR-title rules allow harness PRs
- [ ] `doctor` and `doctor --live` green; adoption branch merged; *Harness · setup* green
- [ ] One ticket shipped locally (`--no-publish`), then in Actions

### Things that will look wrong at first

- **Harness PRs show no CI.** That's the `GITHUB_TOKEN` rule above, not a failure.
- **The harness review comments on people's PRs too.** That's the default; narrow `on:` if unwanted.
- **A ticket hands back from the spec audit without any code.** By design: the ticket is ambiguous, or
  its spec couldn't be made to satisfy the auditors. The issue comment lists what is open; answer it
  and relabel.
- **A ticket hands back on its first code round with a red gate.** The gate couldn't run on the runner:
  a JDK mismatch, a missing prerequisite, Docker, or a private repository. The run artifact has the
  output.
- **"could not isolate the agents"** on the issue. The *Isolate the agents* step found something it
  couldn't lock down on that runner image, and stopped. Its log names the check.
- **A change that edits `.github/workflows/` is handed back, not pushed.** By design: a pushed workflow
  runs with the repository's secrets. A person applies those changes.

---

## Running it

```bash
node harness/bin/doctor.mjs            # is this checkout ready?
node harness/bin/doctor.mjs --live     # runs harness-ping in Copilot: no agents, no AI credits
node harness/bin/run.mjs ship 42 --no-publish   # a full local run: nothing pushed, posted or labelled
node harness/bin/run.mjs ship 42                # claim, build, open the PR
node harness/bin/run.mjs ship 42 --full         # force the full loop (or --small; turns off escalation)
node harness/bin/run.mjs review 57
node harness/bin/run.mjs ship 42 --phase prepare|build|publish  # one phase, as the Actions jobs run them
node --test harness/test/*.test.mjs   # the harness's own tests, about ten seconds
```

On a laptop, each ticket gets a git worktree under `.harness/worktrees/`, so your own checkout is never
touched. It runs on macOS and Linux. On Windows, use WSL or Git Bash, because gate commands and `gh`
calls run through `bash`. Every run keeps a folder in `.harness/runs/` with its arguments, result and
Copilot's JSONL output. In Actions that folder is uploaded as an artifact, with the Copilot token
masked.

Under the hood, `run.mjs` runs Copilot in the workspace, with the harness staged from the root checkout
as a user extension:

```bash
COPILOT_HOME=/tmp/harness-stage-…/home \
copilot --experimental --allow-tool=read --allow-tool=write --allow-tool='shell(./mvnw:*)' … \
        --deny-tool='shell(git push)' --deny-tool='shell(gh:*)' \
        workflow run harness-ship --args @args.json --result-file result.json --output-format json
```

---

## Configuration at a glance

Everything is in `harness.config.mjs`. Anything left out falls back to `harness/lib/config.mjs`. The
config is validated on load, so a typo fails at once rather than mid-run.

| Key | What it is | Guide |
| --- | --- | --- |
| `base` | the branch work starts from and PRs target | §1 |
| `instructions` | the team's own rule files, read by every agent | §3 |
| `map` | where things live, in two or three sentences | §3 |
| `paths.source`, `tests`, `risky`, `specs`, `lessons` | prefixes from the repository root | §4 |
| `commands.gate`, `quick`, `testsOnly`, `reports` | the build | §4 |
| `tests.isTest`, `id`, `weakenedIfRemoved`, `weakenedIfAdded` | how test files are recognised and named | §4 |
| `sizing` | the team's areas, rules, data and contracts, in its own words | §5 |
| `lenses.code`, `lenses.spec` | extra auditors (the parity lens) | §5 |
| `models`, `tiers` | model ids per slot; per size, the rounds, lenses and slots for `spec`, `think` and `build` | §5 |
| `review` | review depth, size thresholds, timeout | §5 |
| `github.labels`, `reviewWorkflow` | label names; the review to dispatch | §2 |
| `copilot.allowTools`, `denyTools`, `timeoutMinutes`, `limits`, `extensionEnv` | what agents may run, and for how long | §4, §9 |

---

## What it costs

Copilot reports what every run used (AI credits and the number of agents), and the harness prints it at
the foot of each PR and review comment. These figures come from the loop's shape, not from
measurement: no agent has run yet.

- **A small ticket:** at least four agents (setup, one spec auditor, implement, one code auditor).
- **Then, as needed:**
  - a skeptic per blocker;
  - a reviser per spec round and a fixer per code round;
  - up to three skeptics for the minors on the final round.
- **A full ticket:** twenty or more.
- **Reviews:** one to four lenses each.

The spec audit runs on the strong model on every tier, so it is the most expensive part of a small
ticket, by design. Measure a few of your own tickets before setting `copilot.limits`. A guessed ceiling
stops a healthy run after it has already spent the credits.

---

## Troubleshooting

| You see | It means | Do this |
| --- | --- | --- |
| `copilot workflow run exited 2` | Copilot didn't find the workflow, or its arguments were invalid | `doctor --live`; check `.github/extensions/harness/` is on the default branch |
| JSON-RPC `-32601`, `dynamic_workflows_unavailable` | the token's Copilot plan has no dynamic workflows | a plan with token-based billing, or a different token owner |
| Hand-back: *… did not finish — Copilot reported: quota_exceeded* | the token owner's Copilot allowance is spent (HTTP 402) | wait for the reset, raise the budget, or use another token owner's seat |
| Doctor: `paths.source matches tracked files` ✗ | the prefixes don't match the layout | write the module in: `app/src/main/` |
| Issue: hand-back at *Spec Audit* | the spec couldn't be made clean, or the ticket contradicts itself | read the open findings on the issue; answer or edit the ticket, relabel |
| Issue: *could not isolate the agents* | *Isolate the agents* failed closed on that runner image | read that step's log; adapt the step, don't delete it |
| Issue: *the build job did not finish* | a setup step failed, a timeout, a cancellation or a lost runner | the build job's log |
| Red gate on the first code round, every ticket | the gate can't run on the runner | JDK, prerequisites, Docker, private repository (§2, §4) |
| `refusing to allow a GitHub App to create or update workflow` | a continued branch carries base workflow changes | delete the old harness branch, or merge the base into it, then relabel |
| A hand-back answer was ignored | the commenter lacks write access, or the token can't check | the claim job's log names who was skipped |
| No CI on a harness PR | PRs opened with `GITHUB_TOKEN` don't trigger workflows | a PAT, or re-run CI by hand (see [above](#where-it-meets-what-the-team-already-has)) |
| Review shows *unproven* | a lens didn't finish; confidence is coverage | the review artifact; re-run the review |

---

## Status

Built on Copilot CLI **dynamic workflows**, which are in **public preview**. The CLI is pinned to
1.0.103, and `--experimental` is required.

**Proven:**
- **The loop logic:** 142 tests against a fake Copilot context and real git repositories.
- **Loading and running headless:** Copilot CLI loads the staged harness headless and runs a workflow
  (`doctor --live`).
- **The workflow files** pass actionlint.
- **The code** went through ten rounds of independent audit (loop logic, runtime and security, docs
  against code), with each finding verified before it was fixed.

**Not yet proven:** a real `ship` or `review` with agents, and the *Isolate the agents* step on a hosted
runner. Steps 6 and 7 of [Prove it](#6-prove-it-cheapest-first) are their first test. The full list is
in [ADAPTING §9](harness/ADAPTING.md#9-what-is-proved-and-what-is-not).

Not ported from the original harness (yet): browser QA, `@mention` responses on PRs, live progress
comments, and per-issue spend comments. [ADAPTING §8](harness/ADAPTING.md#8-extending-it) says where each
would go.

---

## Repository layout

| Path | What it is |
| --- | --- |
| `harness.config.mjs` | **The one file to edit.** Instructions, paths, build commands, sizing, models, lenses |
| `harness/ADAPTING.md` | The detailed adoption guide, key by key |
| `harness/workflows/ship.mjs` | The ship loop: spec audit, build, code audit |
| `harness/workflows/review.mjs` | The review loop |
| `harness/workflows/ping.mjs` | A no-agent workflow that proves the wiring for free |
| `harness/lib/prompts.mjs` | Every word an agent is told, in one place |
| `harness/lib/gate.mjs`, `red-check.mjs`, `git.mjs` | The commands that decide facts |
| `harness/lib/sizing.mjs`, `findings.mjs` | Sizing rules; schemas and finding comparison |
| `harness/lib/github.mjs`, `publish.mjs` | GitHub reads and writes; PR and comment bodies |
| `harness/lib/config.mjs` | Defaults and validation |
| `harness/bin/run.mjs` | The entry point: prepare → `copilot workflow run` → publish, in one go or one `--phase` at a time |
| `harness/bin/doctor.mjs` | Readiness checks; `--live` runs the ping workflow |
| `harness/bin/mask.mjs` | Masks secrets in the build's outputs before they are uploaded |
| `harness/templates/spec.md` | The spec shape |
| `harness/test/` | Tests, with a fake Copilot context and real git (no model, no network) |
| `.github/extensions/harness/extension.mjs` | Registers the workflows with Copilot CLI |
| `.github/workflows/harness-*.yml` | Ship on a label and review on a PR (three jobs each), plus a one-off setup |

---

## Developing the harness

- **Loops are code, words are prompts.** Change what agents are told in `harness/lib/prompts.mjs`.
  Change how the loop runs in `harness/workflows/*.mjs`, with a test in `harness/test/` for each
  behaviour you change. Both audit loops share one set of stopping rules (`settle` and `streaks` in
  `ship.mjs`), so change them there, for both.
- **Run `node --test harness/test/*.test.mjs` after every change** (about ten seconds, no network).
- **Keep the boundaries:** no GitHub calls inside a workflow; no GitHub credential in the build job; no
  project knowledge in `harness/`; no npm dependencies.

[AGENTS.md](AGENTS.md) has the rest, written for an agent working on the harness.

This is a port of the workflow half of the ORBIT '26 workshop harness, which was built for Claude Code,
onto GitHub Copilot's dynamic workflows.
