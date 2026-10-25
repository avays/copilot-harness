#!/usr/bin/env node
// Stop everything the agents left running, before the job's later steps.
//
//   node harness/bin/reap.mjs     # last command of the build step
//
// Agents run code (any test they write runs), and a process they leave
// behind outlives its step. The steps after the build — uploading the
// artifacts — are started with the runner's job tokens in their
// environment, which any process of the same user can read. So the build
// step ends by killing every process of this user that started after the
// step's own shell and is not one of its ancestors. Whatever existed before
// the step — the runner, the system's own daemons — is left alone.
import { readdirSync, readFileSync } from 'node:fs'

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
export function victims({ self, me, pids, parentOf, startOf, userOf }) {
  const keep = new Set()
  for (let p = self; p > 1; p = parentOf(p)) keep.add(p)
  // The step's shell is the parent of this process.
  const since = startOf(parentOf(self))
  return pids.filter((p) => !keep.has(p) && userOf(p) === me && startOf(p) >= since)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.platform !== 'linux') process.exit(0)
  const pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number)
  const kill = victims({ self: process.pid, me: process.getuid(), pids, parentOf, startOf, userOf })
  for (const p of kill) { try { process.kill(p, 'SIGKILL') } catch {} }
  console.log(`harness: stopped ${kill.length} process${kill.length === 1 ? '' : 'es'} left behind`)
}
