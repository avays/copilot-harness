// Registers the harness workflows with Copilot CLI. Copilot loads this file
// from .github/extensions/ and resolves @github/copilot-sdk for it; nothing
// to install. All the logic is in harness/ — this file only wires it up.
//
//   copilot --experimental workflow run harness-ship --args @args.json
//
// Run it through harness/bin/run.mjs, which prepares the arguments, passes
// the permissions and publishes the result.
import { defineWorkflow, joinSession } from '@github/copilot-sdk/extension'
import { loadConfig, ROOT } from '../../../harness/lib/config.mjs'
import ping from '../../../harness/workflows/ping.mjs'
import review from '../../../harness/workflows/review.mjs'
import ship from '../../../harness/workflows/ship.mjs'

const config = await loadConfig(ROOT)

const register = (w) => defineWorkflow({
  meta: { ...w.meta, ...(config.copilot.limits ? { limits: config.copilot.limits } : {}) },
  run: (ctx) => w.run(ctx, { config }),
})

await joinSession({
  workflows: [register(ship), register(review), register(ping)],
  ...(config.copilot.extensionEnv.length ? { requestedEnvironmentVariables: config.copilot.extensionEnv } : {}),
})
