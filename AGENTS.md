# Working on the Copilot harness

This repository is boilerplate. It gets copied into other projects, as [harness/ADAPTING.md](harness/ADAPTING.md)
describes. This file is for an agent changing the harness here; it is not copied along.

- **Loops are code; words are prompts.** Change what agents are told in `harness/lib/prompts.mjs`.
  Change how the loop runs in `harness/workflows/*.mjs`, and add a test in `harness/test/` for each
  behaviour you change.
- **Agents never decide facts.** Whether the build is green, the tree is clean, or new tests fail on the
  base is a command (`harness/lib/gate.mjs`, `red-check.mjs`, `git.mjs`). Don't replace one with a
  question to an agent.
- **Nothing in a workflow talks to GitHub.** It runs inside Copilot with no token. GitHub reads and writes
  belong in `harness/bin/run.mjs` and `harness/lib/github.mjs`, in its prepare and publish phases.
- **The build phase never holds a GitHub token.** In Actions it is its own job. Its read-only token is
  used only by the checkout and setup actions, and the agents run as their own unprivileged user
  (`harness-agent`), which gets only `COPILOT_GITHUB_TOKEN` and owns nothing the job's other steps
  use. Keep it that way: a step that hands the agents' user a credential, or runs as `runner` with
  files that user can write, undoes it. An agent can read the environment of any process above it, so stripping a token
  from Copilot's environment is not enough on its own. Don't give the build jobs a GitHub credential, and
  never let a job that holds one run code from the branch. The harness that runs is staged from the
  root checkout (`stageHarness` in `run.mjs`) and loaded as a user extension; the branch is only the
  workspace under `.harness/worktrees/`, where Copilot runs. The one credential a build job may
  get is a read-only package token for the gate (harness/ADAPTING.md §4).
- **Every `ctx.agent` call needs a unique label.** Copilot memoizes identical calls, so two calls with
  the same prompt and label share one agent. The tests check this.
- **Schemas use Copilot's subset:** `type`, `required`, `enum`, `const`, `properties`/`items`,
  `anyOf`/`oneOf`/`allOf`. In an agent's schema anything else is ignored, so apply limits in code; in a
  workflow's `argsSchema` anything else is rejected at registration, and every workflow then fails to load.
- **No npm dependencies.** The harness sits in projects that are not Node projects.
- **Nothing project-specific in `harness/`.** Project knowledge belongs in `harness.config.mjs`.
- Run `node --test harness/test/*.test.mjs` after every change (about ten seconds).
- Copilot's own SDK docs ship with the CLI: `~/.cache/copilot/pkg/<platform>/<version>/copilot-sdk/docs/workflows.md`.
