/**
 * `spawnWithTreeKill` — execFile/execFileAsync replacement that kills the
 * entire child process group on timeout / abort.
 *
 * Background: `child_process.execFile`'s built-in `timeout` option only sends
 * the kill signal to the immediate child. When that child is `bash -c
 * "python foo.py | ffmpeg ..."` (or any wrapper that fork-execs grandchildren),
 * the real workload (ffmpeg, yt-dlp, headless chrome) is left orphaned and
 * keeps consuming CPU / file handles after the wrapper dies. We hit this in
 * skill direct-action execution (`runtime-manager.executeProcessWithStructuredResult`)
 * and in the run-shell primitive — `run-shell.ts` already does the right thing
 * inline, so the algorithm here is the same:
 *
 *   1. spawn with `detached:true` on Unix so the child becomes the leader of a
 *      new process group (pgid === pid).
 *   2. on timeout/abort, send SIGTERM to `-pid` (the negative pid syntax targets
 *      the whole group, so grandchildren get the signal too).
 *   3. if the child is still alive after `sigkillEscalationMs`, escalate to
 *      SIGKILL on `-pid`.
 *
 * On Windows there is no equivalent of process groups, so we fall back to
 * `child.kill(signal)`. (A future enhancement could shell out to `taskkill /T
 * /F /PID <pid>` for true tree-kill on Windows; for now the shell primitive
 * already accepts this gap and so do we.)
 *
 * The helper deliberately stays close to `execFileAsync`'s shape — it returns
 * `{ stdout, stderr, exitCode, signal }` and throws an Error decorated with
 * `code` / `signal` / `killed` / `stdout` / `stderr` on non-zero exit, timeout,
 * abort, or spawn error. That keeps existing callers' try/catch flow intact
 * while plugging in the tree-kill behavior.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

const DEFAULT_MAX_BUFFER = 1024 * 1024
const DEFAULT_SIGKILL_GRACE_MS = 5_000

/**
 * Per-stream overflow sink. Invoked synchronously with each chunk that exceeds
 * the in-memory cap for a given stream. Implementations are expected to append
 * the chunk to a backing artifact (file, stream, etc). Errors thrown from the
 * sink are caught + recorded on the result via `stdoutOverflowError` /
 * `stderrOverflowError` — they never break the underlying process execution.
 */
export type OverflowSink = (chunk: string) => void

export interface SpawnWithTreeKillOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Hard wall-clock timeout. <= 0 disables the timeout. */
  timeoutMs?: number
  /** External cancellation. When aborted, the same tree-kill flow runs. */
  signal?: AbortSignal
  /** Combined stdout+stderr cap in bytes. Defaults to 1 MiB. */
  maxBuffer?: number
  /** stdin payload to write before closing the child's stdin. */
  stdin?: string | Buffer
  /** Grace period between SIGTERM and SIGKILL. Defaults to 5_000 ms. */
  sigkillGraceMs?: number
  /** Test-only spawn override. */
  spawnFn?: typeof spawn
  /**
   * C6 — per-stream in-memory cap (bytes). Bytes beyond this are routed to the
   * overflow sink instead of being buffered. When omitted, the legacy combined
   * `maxBuffer` behavior applies (single in-memory buffer that throws on
   * overflow). Setting this WITHOUT a sink still routes excess bytes nowhere
   * (effectively truncates), but the helper does not throw.
   */
  inMemoryStdoutCap?: number
  inMemoryStderrCap?: number
  /** C6 — sink callbacks for the overflow bytes. See `OverflowSink`. */
  stdoutOverflowSink?: OverflowSink
  stderrOverflowSink?: OverflowSink
}

export type SpawnExitReason = 'exit' | 'timeout' | 'aborted' | 'spawn_error'

export interface SpawnWithTreeKillResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  durationMs: number
  /** C6 — true when stdout exceeded inMemoryStdoutCap and bytes were routed to the sink. */
  stdoutOverflowed: boolean
  /** C6 — true when stderr exceeded inMemoryStderrCap and bytes were routed to the sink. */
  stderrOverflowed: boolean
  /** C6 — first error thrown by the stdout sink (if any). The process still runs. */
  stdoutOverflowError: string | null
  /** C6 — first error thrown by the stderr sink (if any). The process still runs. */
  stderrOverflowError: string | null
}

export interface SpawnWithTreeKillError extends Error {
  code: number | null
  signal: NodeJS.Signals | null
  killed: boolean
  stdout: string
  stderr: string
  reason: SpawnExitReason
  timedOut: boolean
  aborted: boolean
  /** C6 — same semantics as on the success result. Default false / null when overflow opts are absent. */
  stdoutOverflowed: boolean
  stderrOverflowed: boolean
  stdoutOverflowError: string | null
  stderrOverflowError: string | null
}

function makeError(
  message: string,
  partial: Pick<
    SpawnWithTreeKillError,
    | 'code' | 'signal' | 'killed' | 'stdout' | 'stderr' | 'reason' | 'timedOut' | 'aborted'
    | 'stdoutOverflowed' | 'stderrOverflowed' | 'stdoutOverflowError' | 'stderrOverflowError'
  >,
): SpawnWithTreeKillError {
  const err = new Error(message) as SpawnWithTreeKillError
  err.code = partial.code
  err.signal = partial.signal
  err.killed = partial.killed
  err.stdout = partial.stdout
  err.stderr = partial.stderr
  err.reason = partial.reason
  err.timedOut = partial.timedOut
  err.aborted = partial.aborted
  err.stdoutOverflowed = partial.stdoutOverflowed
  err.stderrOverflowed = partial.stderrOverflowed
  err.stdoutOverflowError = partial.stdoutOverflowError
  err.stderrOverflowError = partial.stderrOverflowError
  return err
}

export async function spawnWithTreeKill(
  bin: string,
  args: ReadonlyArray<string>,
  options: SpawnWithTreeKillOptions = {},
): Promise<SpawnWithTreeKillResult> {
  const useProcessGroup = process.platform !== 'win32'
  const spawnFn = options.spawnFn || spawn
  const maxBuffer = options.maxBuffer && options.maxBuffer > 0 ? options.maxBuffer : DEFAULT_MAX_BUFFER
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 0
  const sigkillGraceMs = options.sigkillGraceMs && options.sigkillGraceMs > 0
    ? options.sigkillGraceMs
    : DEFAULT_SIGKILL_GRACE_MS
  const started = Date.now()

  const spawnOpts: SpawnOptions = {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: useProcessGroup,
    windowsHide: true,
  }

  // C6 — when a per-stream cap is set, the helper switches from "kill on
  // combined overflow" to "spill excess to sink, keep running". Either both
  // streams provide a cap, or neither does. The legacy combined-`maxBuffer`
  // path is preserved verbatim when caps are absent so existing callers and
  // the tree-kill regression tests remain green.
  const overflowMode =
    typeof options.inMemoryStdoutCap === 'number' && options.inMemoryStdoutCap > 0
      || typeof options.inMemoryStderrCap === 'number' && options.inMemoryStderrCap > 0
  const stdoutCap = options.inMemoryStdoutCap && options.inMemoryStdoutCap > 0
    ? options.inMemoryStdoutCap
    : Number.POSITIVE_INFINITY
  const stderrCap = options.inMemoryStderrCap && options.inMemoryStderrCap > 0
    ? options.inMemoryStderrCap
    : Number.POSITIVE_INFINITY
  const stdoutSink = options.stdoutOverflowSink || null
  const stderrSink = options.stderrOverflowSink || null

  let child: ChildProcess
  try {
    child = spawnFn(bin, args as string[], spawnOpts)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw makeError(`spawn ${bin} failed: ${message}`, {
      code: null,
      signal: null,
      killed: false,
      stdout: '',
      stderr: '',
      reason: 'spawn_error',
      timedOut: false,
      aborted: false,
      stdoutOverflowed: false,
      stderrOverflowed: false,
      stdoutOverflowError: null,
      stderrOverflowError: null,
    })
  }

  let stdout = ''
  let stderr = ''
  let stdoutBytes = 0
  let stderrBytes = 0
  let bufferOverflow = false
  let stdoutOverflowed = false
  let stderrOverflowed = false
  let stdoutOverflowError: string | null = null
  let stderrOverflowError: string | null = null
  let timedOut = false
  let aborted = false
  // Hoisted across the async close-promise; cast keeps TS's control-flow
  // analysis from narrowing it to `null` (the assignment happens inside an
  // event-emitter callback that TS can't prove will run).
  const spawnFailureRef: { current: Error | null } = { current: null }

  if (options.stdin != null && child.stdin) {
    try {
      child.stdin.write(options.stdin)
    } catch {
      /* stdin closed — ignore */
    }
    child.stdin.end()
  } else if (child.stdin) {
    child.stdin.end()
  }

  child.stdout?.setEncoding('utf-8')
  child.stderr?.setEncoding('utf-8')

  if (overflowMode) {
    // C6 — per-stream spill: cap the in-memory buffer, route surplus bytes to
    // the sink. The process keeps running because the long-output case (a
    // skill emitting tens of MB of ffmpeg progress) is normal, not a failure
    // signal. Sink errors are recorded but not fatal — the command result is
    // more important than perfect log capture.
    child.stdout?.on('data', (chunk: string) => {
      const bytes = Buffer.byteLength(chunk, 'utf-8')
      const remaining = stdoutCap - stdoutBytes
      if (remaining > 0) {
        if (bytes <= remaining) {
          stdout += chunk
          stdoutBytes += bytes
          return
        }
        // Partial chunk fits in memory; rest spills.
        const split = chunk.slice(0, remaining)
        stdout += split
        stdoutBytes += Buffer.byteLength(split, 'utf-8')
        const overflow = chunk.slice(remaining)
        stdoutOverflowed = true
        if (stdoutSink) {
          try { stdoutSink(overflow) } catch (err) {
            if (!stdoutOverflowError) stdoutOverflowError = err instanceof Error ? err.message : String(err)
          }
        }
        return
      }
      stdoutOverflowed = true
      if (stdoutSink) {
        try { stdoutSink(chunk) } catch (err) {
          if (!stdoutOverflowError) stdoutOverflowError = err instanceof Error ? err.message : String(err)
        }
      }
    })
    child.stderr?.on('data', (chunk: string) => {
      const bytes = Buffer.byteLength(chunk, 'utf-8')
      const remaining = stderrCap - stderrBytes
      if (remaining > 0) {
        if (bytes <= remaining) {
          stderr += chunk
          stderrBytes += bytes
          return
        }
        const split = chunk.slice(0, remaining)
        stderr += split
        stderrBytes += Buffer.byteLength(split, 'utf-8')
        const overflow = chunk.slice(remaining)
        stderrOverflowed = true
        if (stderrSink) {
          try { stderrSink(overflow) } catch (err) {
            if (!stderrOverflowError) stderrOverflowError = err instanceof Error ? err.message : String(err)
          }
        }
        return
      }
      stderrOverflowed = true
      if (stderrSink) {
        try { stderrSink(chunk) } catch (err) {
          if (!stderrOverflowError) stderrOverflowError = err instanceof Error ? err.message : String(err)
        }
      }
    })
  } else {
    // Legacy combined-buffer behavior — kept verbatim so the existing
    // tree-kill regression tests (which never opt into overflow mode) still
    // exercise the original kill-on-overflow flow.
    child.stdout?.on('data', (chunk: string) => {
      if (bufferOverflow) return
      stdoutBytes += Buffer.byteLength(chunk, 'utf-8')
      if (stdoutBytes + stderrBytes > maxBuffer) {
        bufferOverflow = true
        terminateGroup('SIGTERM')
        scheduleSigkillEscalation()
        return
      }
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      if (bufferOverflow) return
      stderrBytes += Buffer.byteLength(chunk, 'utf-8')
      if (stdoutBytes + stderrBytes > maxBuffer) {
        bufferOverflow = true
        terminateGroup('SIGTERM')
        scheduleSigkillEscalation()
        return
      }
      stderr += chunk
    })
  }

  let sigkillTimer: NodeJS.Timeout | null = null
  const terminateGroup = (signal: NodeJS.Signals): void => {
    if (child.killed) return
    try {
      if (useProcessGroup && typeof child.pid === 'number') {
        process.kill(-child.pid, signal)
      } else {
        child.kill(signal)
      }
    } catch {
      /* child already exited or pgid missing — fall through */
    }
  }
  const scheduleSigkillEscalation = (): void => {
    if (sigkillTimer) return
    sigkillTimer = setTimeout(() => {
      if (!child.killed) terminateGroup('SIGKILL')
    }, sigkillGraceMs)
    // Don't keep the event loop alive just for the SIGKILL escalation.
    if (typeof sigkillTimer.unref === 'function') sigkillTimer.unref()
  }

  let timer: NodeJS.Timeout | null = null
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      terminateGroup('SIGTERM')
      scheduleSigkillEscalation()
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const onAbort = (): void => {
    aborted = true
    terminateGroup('SIGTERM')
    scheduleSigkillEscalation()
  }
  if (options.signal) {
    if (options.signal.aborted) onAbort()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }

  const closeResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false
    child.once('error', (err) => {
      if (settled) return
      settled = true
      spawnFailureRef.current = err
      resolve({ code: null, signal: null })
    })
    child.once('close', (code, sig) => {
      if (settled) return
      settled = true
      resolve({ code, signal: sig })
    })
  }).finally(() => {
    if (timer) clearTimeout(timer)
    if (sigkillTimer) clearTimeout(sigkillTimer)
    if (options.signal) options.signal.removeEventListener('abort', onAbort)
  })

  const durationMs = Date.now() - started

  // C6 — bundle overflow signals so every error / success path carries them.
  const overflowFields = {
    stdoutOverflowed,
    stderrOverflowed,
    stdoutOverflowError,
    stderrOverflowError,
  }

  if (spawnFailureRef.current) {
    const message = spawnFailureRef.current.message
    throw makeError(`${bin} failed to start: ${message}`, {
      code: null,
      signal: null,
      killed: false,
      stdout,
      stderr,
      reason: 'spawn_error',
      timedOut,
      aborted,
      ...overflowFields,
    })
  }

  if (aborted) {
    throw makeError(`${bin} aborted after ${durationMs}ms`, {
      code: closeResult.code,
      signal: closeResult.signal,
      killed: true,
      stdout,
      stderr,
      reason: 'aborted',
      timedOut: false,
      aborted: true,
      ...overflowFields,
    })
  }

  if (timedOut) {
    throw makeError(`${bin} timed out after ${timeoutMs}ms`, {
      code: closeResult.code,
      signal: closeResult.signal,
      killed: true,
      stdout,
      stderr,
      reason: 'timeout',
      timedOut: true,
      aborted: false,
      ...overflowFields,
    })
  }

  if (bufferOverflow) {
    throw makeError(`${bin} exceeded maxBuffer (${maxBuffer} bytes)`, {
      code: closeResult.code,
      signal: closeResult.signal,
      killed: true,
      stdout,
      stderr,
      reason: 'spawn_error',
      timedOut: false,
      aborted: false,
      ...overflowFields,
    })
  }

  if (closeResult.code != null && closeResult.code !== 0) {
    throw makeError(`${bin} exited with code ${closeResult.code}`, {
      code: closeResult.code,
      signal: closeResult.signal,
      killed: false,
      stdout,
      stderr,
      reason: 'exit',
      timedOut: false,
      aborted: false,
      ...overflowFields,
    })
  }

  if (closeResult.signal) {
    throw makeError(`${bin} killed by signal ${closeResult.signal}`, {
      code: null,
      signal: closeResult.signal,
      killed: true,
      stdout,
      stderr,
      reason: 'exit',
      timedOut: false,
      aborted: false,
      ...overflowFields,
    })
  }

  return {
    stdout,
    stderr,
    exitCode: closeResult.code,
    signal: closeResult.signal,
    durationMs,
    ...overflowFields,
  }
}
