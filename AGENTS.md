# Working on the Copilot harness

This repository is boilerplate. It gets copied into other projects, as [ADAPTING.md](ADAPTING.md)
describes. This file is for an agent changing the harness here; it is not copied along.

- **Loops are code; words are prompts.** Change what agents are told in `harness/lib/prompts.mjs`.
  Change how the loop runs in `harness/workflows/*.mjs`, and add a test in `harness/test/` for each
  behaviour you change.
- **Agents never decide facts.** Whether the build is green, the tree is clean, or new tests fail on the
  base is a command (`harness/lib/gate.mjs`, `red-check.mjs`, `git.mjs`). Don't replace one with a
  question to an agent.
- **Nothing in a workflow talks to GitHub.** It runs inside Copilot with no token. GitHub reads and writes
  belong in `harness/bin/run.mjs` and `harness/lib/github.mjs`, in its prepare and publish phases.
- **The build phase never holds a GitHub token.** In Actions it is its own job, given only
  `COPILOT_GITHUB_TOKEN`. An agent can read the environment of any process above it, so stripping a token
  from Copilot's environment is not enough on its own. Don't give the build jobs a GitHub credential, and
  never let a job that holds one run code from the branch: every job runs the base checkout's harness,
  and the branch is only the workspace under `.harness/worktrees/`. The one credential a build job may
  get is a read-only package token for the gate (ADAPTING.md §4).
- **Every `ctx.agent` call needs a unique label.** Copilot memoizes identical calls, so two calls with
  the same prompt and label share one agent. The tests check this.
- **Schemas use Copilot's subset:** `type`, `required`, `enum`, `const`, `properties`/`items`,
  `anyOf`/`oneOf`/`allOf`. Anything else is ignored, so apply limits in code.
- **No npm dependencies.** The harness sits in projects that are not Node projects.
- **Nothing project-specific in `harness/`.** Project knowledge belongs in `harness.config.mjs`.
- Run `node --test harness/test/*.test.mjs` after every change (under ten seconds).
- Copilot's own SDK docs ship with the CLI: `~/.cache/copilot/pkg/<platform>/<version>/copilot-sdk/docs/workflows.md`.
