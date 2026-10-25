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
    let stdout = '', stderr = '', settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', stop)
      resolveRun(r)
    }
    const p = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    // Killing bash leaves Maven's forked JVMs holding the pipes open, so
    // `close` would never come: once stopped, wait for the process itself,
    // not its output, and a JVM still writing to it gets EPIPE and dies.
    // An abort is handled the same way, not by spawn's own signal, which
    // settles at once and leaves the command running in its folder.
    let stopped = false
    function stop() {
      if (stopped) return
      stopped = true
      p.kill('SIGTERM')
      setTimeout(() => p.kill('SIGKILL'), 5000).unref()
    }
    const timer = timeoutMs ? setTimeout(stop, timeoutMs) : null
    if (signal) {
      if (signal.aborted) stop()
      else signal.addEventListener('abort', stop, { once: true })
    }
    // Decoded as a stream, so a character split across chunks stays whole.
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8')
    p.stdout.on('data', (d) => { stdout += d; out.push(d) })
    p.stderr.on('data', (d) => { stderr += d; out.push(d) })
    p.on('exit', (code) => {
      if (!stopped) return
      p.stdout.destroy(); p.stderr.destroy()
      finish({ code: code ?? 1, stdout, stderr, out: out.join('') })
    })
    p.on('error', (e) => finish({ code: 127, stdout, stderr: stderr + String(e.message), out: out.join('') + String(e.message) }))
    p.on('close', (code) => finish({ code: code ?? 1, stdout, stderr, out: out.join('') }))
  })
}

/** The last `n` lines of some output: enough for a fixer, small enough for a prompt. */
export const tail = (s, n = 60) => String(s || '').trimEnd().split('\n').slice(-n).join('\n')
