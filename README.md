# Copilot harness

**GitHub Copilot takes a ticket to a verified pull request through deterministic audit loops.**

Label an issue `ready-for-ai`. A headless Copilot workflow writes a spec, builds the change test-first,
runs your real build, and has independent agents audit the result until a round comes back clean. Then
it opens a pull request that says what was proved and what was not. A ticket that will not converge
goes to a person as a **draft**, with everything still open written down.

This is boilerplate. It is meant to be dropped into an existing repository that already has its own
instructions and rules. **To adopt it, read [harness/ADAPTING.md](harness/ADAPTING.md).**

## How a ticket flows

```
issue labelled ready-for-ai
  │
  ├─ 1. claim job (run.mjs prepare)    read the issue, claim it, pick the branch
  │
  ├─ 2. build job: copilot workflow run harness-ship    headless; no GitHub token in the job
  │      Setup        reads the ticket and the code, reports sizing facts
  │      Spec         specs/<n>-<slug>.md, its own commit
  │      Spec audit   fresh auditors ⇄ revise (only when the ticket's risk calls for it)
  │      Implement    failing test first, committed red, then the change
  │      ┌▶ Verify    merge the base · run the gate · red-check          ← code
  │      │  Audit     fresh auditors → a skeptic on every blocker        ← agents
  │      └─ Fix       the confirmed blockers; repeat until clean, or hand back
  │      Learn        what the audits caught becomes a lesson in the docs
  │
  ├─ 3. publish job (run.mjs publish)    push the bundle, open the PR or a draft, label, comment
  │
  ├─ Harness · review    independent lenses → skeptic → one advisory comment
  │
  └─ a person merges
```

## The rules it is built on

These are why each piece exists. Keep them when you change the harness.

- **A script, not a prompt.** Loops, round limits, sizing and who judges what are JavaScript
  (`harness/workflows/ship.mjs`). A model can't skip a round or quietly raise a limit.
- **Every agent is a fresh context.** An auditor sees the ticket, the spec and the diff, never the
  builder's reasoning. That independence is what makes an audit an audit.
- **Machines decide facts.** Whether the build is green, whether the tree is clean and whether the new
  tests fail without the change are commands with exit codes (`gate.mjs`, `red-check.mjs`). No agent
  is asked.
- **Every blocker faces a skeptic** before it costs a fix round. A false positive makes the fixer
  "fix" correct code. A skeptic that dies refutes nothing.
- **Hand back rather than burn rounds.** The same finding surviving two fixes, or the round limit,
  ends the run with a draft PR and the open findings.
- **Sized by risk, not length.** Setup reports facts; one rule turns them into a loop. Small is the
  base, and a business rule, stored data or the harness itself buys the full loop. The diff can
  escalate a small run on evidence.
- **The project's rules stay the project's.** Agents are pointed at your existing instruction files.
  The harness never restates them.
- **AI never holds the GitHub token.** In Actions, ship and review are three jobs each. Claiming and
  publishing hold the GitHub token. The build job, where the agents run, holds only a Copilot token
  with no repository access, and the agents run there as a user of their own that can't sudo and
  owns nothing the job's other steps use. Every job runs the default branch's harness, and the
  branch is only the workspace the agents edit. The work crosses to publish as a git bundle, and workflow files are never
  pushed. On a laptop there is no such isolation (harness/ADAPTING.md §9).
- **Say what was not proved.** Every PR has a *Not verified* section. Review confidence means
  coverage, and a lens that never finished makes it *low*.

## Repository layout

| Path | What it is |
| --- | --- |
| `harness.config.mjs` | **The one file to edit.** Instructions, paths, build commands, sizing, models, lenses |
| `harness/workflows/ship.mjs` | The ship loop |
| `harness/workflows/review.mjs` | The review loop |
| `harness/workflows/ping.mjs` | A no-agent workflow that proves the wiring for free |
| `harness/lib/prompts.mjs` | Every word an agent is told, in one place |
| `harness/lib/gate.mjs`, `red-check.mjs`, `git.mjs` | The commands that decide facts |
| `harness/lib/sizing.mjs`, `findings.mjs` | Sizing rules; schemas and finding comparison |
| `harness/lib/github.mjs`, `publish.mjs` | GitHub reads and writes; PR and comment bodies |
| `harness/bin/run.mjs` | The entry point: prepare → `copilot workflow run` → publish, in one go or one `--phase` at a time |
| `harness/bin/doctor.mjs` | Readiness checks; `--live` runs the ping workflow |
| `harness/templates/spec.md` | The spec shape |
| `harness/test/` | Tests, run with a fake Copilot context and real git (no model, no network) |
| `.github/extensions/harness/extension.mjs` | Registers the workflows with Copilot CLI |
| `.github/workflows/harness-*.yml` | Ship on a label and review on a PR (three jobs each), plus a one-off setup |

## Running it

```bash
node harness/bin/doctor.mjs            # is this checkout ready?
node harness/bin/doctor.mjs --live     # runs harness-ping in Copilot: no agents, no AI credits
node harness/bin/run.mjs ship 42 --no-publish   # a full local run: nothing pushed, posted or labelled
node harness/bin/run.mjs ship 42                # claim, build, open the PR
node harness/bin/run.mjs review 57
node harness/bin/run.mjs ship 42 --phase prepare|build|publish  # one phase, as the Actions jobs run them
node --test harness/test/*.test.mjs   # the harness's own tests, about a second
```

On a laptop, each ticket gets a git worktree under `.harness/worktrees/`, so your own checkout is never
touched. It runs on macOS and Linux. On Windows, use WSL or Git Bash, because gate commands and `gh`
calls run through `bash`. Every run keeps a folder in `.harness/runs/` with its arguments, result and Copilot's JSONL
output. In Actions that folder is uploaded as an artifact.

Under the hood, `run.mjs` runs:

```bash
# from the workspace, with the harness staged from the root as a user extension
COPILOT_HOME=/tmp/harness-stage-…/home \
copilot --experimental --allow-tool=read --allow-tool=write --allow-tool='shell(./mvnw:*)' … \
        --deny-tool='shell(git push)' --deny-tool='shell(gh:*)' \
        workflow run harness-ship --args @args.json --result-file result.json --output-format json
```

## What it costs

Copilot reports what every run used (`workflow.run_settled` → AI credits and the number of agents), and
the harness prints it at the foot of each PR and review comment. Expect, from the loop's shape rather
than from measurement (no agent has run yet), at least three agents for a small ticket (setup,
implement, one auditor), plus a skeptic per blocker and a fixer per round; a full ticket, fifteen or
more. Measure a few of your own tickets before setting `copilot.limits`.

## Status

Built on Copilot CLI **dynamic workflows**, which are in **public preview**. The CLI is pinned to
1.0.103, and `--experimental` is required. What has been proved and what hasn't is listed in
[harness/ADAPTING.md §9](harness/ADAPTING.md#9-what-is-proved-and-what-is-not).

This is a port of the workflow half of the ORBIT '26 workshop harness, which was built for Claude Code.
Not ported (yet): browser QA, `@mention` responses on PRs, live progress comments, and per-issue
spend comments. harness/ADAPTING.md §8 says where each would go.
