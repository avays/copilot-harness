#!/usr/bin/env node
// Stop everything the agents left running, before the job's later steps.
//
//   node harness/bin/reap.mjs              # last command of the build step
//   node harness/bin/reap.mjs --since T    # a later always() step: everything since T
//
// T is a start time in clock ticks since boot, as /proc/<pid>/stat gives it,
// recorded by a step before the agents ran (so they could not change it).
//
// Agents run code (any test they write runs), and a process they leave
// behind outlives its step. The steps after the build — uploading the
// artifacts — are started with the runner's job tokens in their
// environment, which any process of the same user can read. So the build
// step ends by killing every process of this user that started after the
// step's own shell and is not one of its ancestors. Whatever existed before
// the step — the runner, the system's own daemons — is left alone.
import { readdirSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const proc = (pid, file) => { try { return readFileSync(`/proc/${pid}/${file}`, 'utf8') } catch { return null } }

/** Fields of /proc/<pid>/stat after the command name, which may hold spaces. */
const stat = (pid) => {
  const s = proc(pid, 'stat')
  return s ? s.slice(s.lastIndexOf(')') + 2).split(' ') : null
}
// After the name: [0] state, [1] ppid, … [19] starttime (field 22).
const parentOf = (pid) => Number((stat(pid) || [])[1] || 0)
const startOf = (pid) => Number((stat(pid) || [])[19] || 0)
const userOf = (pid) => Number((/^Uid:\s+(\d+)/m.exec(proc(pid, 'status') || '') || [])[1])

/** Which pids to kill. Pure, so it can be tested without killing anything. */
export function victims({ self, me, pids, parentOf, startOf, userOf, since = null }) {
  const keep = new Set()
  for (let p = self; p > 1; p = parentOf(p)) keep.add(p)
  // Without --since, the step's shell — this process's parent — marks the start.
  since ??= startOf(parentOf(self))
  return pids.filter((p) => !keep.has(p) && userOf(p) === me && startOf(p) >= since)
}

export const ticksNow = () => startOf(process.pid)

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform !== 'linux') process.exit(0)
  if (process.argv[2] === '--mark') { console.log(ticksNow()); process.exit(0) }
  const i = process.argv.indexOf('--since')
  const since = i > 0 ? Number(process.argv[i + 1]) : null
  if (i > 0 && !(since > 0)) { console.error('reap: --since needs a tick count'); process.exit(2) }
  const pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number)
  const kill = victims({ self: process.pid, me: process.getuid(), pids, parentOf, startOf, userOf, since })
  for (const p of kill) { try { process.kill(p, 'SIGKILL') } catch {} }
  console.log(`harness: stopped ${kill.length} process${kill.length === 1 ? '' : 'es'} left behind`)
}
