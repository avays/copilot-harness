// ping: proves the wiring without spending anything. A workflow that starts
// no agent costs no AI credits, so `doctor --live` can check that Copilot
// loads the extension, reads the config and returns a result — on a laptop
// or a runner — before a real ticket is trusted to it.
import { sh } from '../lib/exec.mjs'

export const meta = {
  name: 'harness-ping',
  description: 'Check the harness is wired up: loads the config and runs `git --version` with no agents. args: none.',
  phases: [{ title: 'Ping' }],
}

export async function run(ctx, { config }) {
  ctx.phase('Ping')
  const g = await sh('git --version', { cwd: process.cwd() })
  return {
    ok: g.code === 0,
    cwd: process.cwd(),
    git: g.stdout.trim(),
    base: config.base,
    gate: config.commands.gate.map((c) => c.name),
    instructions: config.instructions,
  }
}

export default { meta, run }
