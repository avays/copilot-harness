// Commands the harness itself runs: the gate, red-check, git. Async on
// purpose: the extension talks to Copilot over stdio, and a synchronous
// ten-minute Maven build would stall that connection for its whole length.
import { spawn } from 'node:child_process'

/** Run a shell command. Never throws on a non-zero exit; `code` says. */
export function sh(cmd, { cwd, env, signal, timeoutMs } = {}) {
  return run('bash', ['-c', cmd], { cwd, env, signal, timeoutMs })
}

/** Run git with arguments (no shell). */
export function git(args, { cwd, signal } = {}) {
  return run('git', args, { cwd, signal })
}

function run(bin, args, { cwd, env, signal, timeoutMs }) {
  return new Promise((resolveRun) => {
    const out = []
    const p = spawn(bin, args, { cwd, env: { ...process.env, ...env }, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = timeoutMs ? setTimeout(() => p.kill('SIGTERM'), timeoutMs) : null
    let stdout = '', stderr = ''
    p.stdout.on('data', (d) => { stdout += d; out.push(d) })
    p.stderr.on('data', (d) => { stderr += d; out.push(d) })
    p.on('error', (e) => { if (timer) clearTimeout(timer); resolveRun({ code: 127, stdout, stderr: stderr + String(e.message), out: out.join('') + String(e.message) }) })
    p.on('close', (code) => { if (timer) clearTimeout(timer); resolveRun({ code: code ?? 1, stdout, stderr, out: out.join('') }) })
  })
}

/** The last `n` lines of some output: enough for a fixer, small enough for a prompt. */
export const tail = (s, n = 60) => String(s || '').trimEnd().split('\n').slice(-n).join('\n')
