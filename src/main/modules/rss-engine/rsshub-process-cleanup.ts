/**
 * Pure helpers for spawning + reaping the embedded RSSHub worker.
 *
 * Background: RSSHub internally uses `rebrowser-puppeteer` which fork-execs
 * Chromium grandchildren. When the embedded worker is killed via the default
 * `child.kill('SIGKILL')`, only the immediate Node child is signalled — the
 * Chromium subprocesses are reparented to PID 1 and keep consuming CPU /
 * memory / file handles. Users have observed 14+ leaked Chrome processes
 * after a single Ready quit cycle.
 *
 * Fix shape (Phase C3-followup, perf-rescue):
 *   1. Spawn the worker with `detached: true` on Unix so the worker becomes
 *      the leader of its own process group (`pgid === pid`). Chromium
 *      grandchildren inherit that group.
 *   2. On cleanup / stop, send SIGTERM to `-pid` (negative pid syntax targets
 *      the entire group). After a short grace window, escalate to SIGKILL
 *      on `-pid`.
 *
 * Windows has no equivalent of process groups, so we fall back to
 * `child.kill(signal)` and accept the gap (the boot-reaper next-launch sweep
 * still cleans whatever leaked).
 *
 * This module is intentionally electron-free + side-effect-free so it can be
 * unit-tested via `boot-reaper-core`-style injectable seams. The thin wrapper
 * lives in `rsshub-process.ts`.
 */

import type { ForkOptions } from 'child_process'

export type KillSignal = NodeJS.Signals | 0

/**
 * Injectable kill seam. Production callers wire this to either
 * `process.kill(pid, signal)` (group kill via negative pid) or
 * `child.kill(signal)` (Windows fallback / single-pid kill).
 *
 * Returns `true` on success, `false` when the target is already gone (ESRCH /
 * killed children). Throws for unexpected failures (EPERM, etc.) so the
 * cleanup orchestrator can record them.
 */
export type KillFn = (pid: number, signal: KillSignal) => boolean

export interface BuildForkOptionsInput {
  env: NodeJS.ProcessEnv
  cwd: string
  platform: NodeJS.Platform
}

/**
 * Returns the `ForkOptions` we want to pass to `child_process.fork()` for the
 * embedded RSSHub worker. On Unix we set `detached: true` so the worker
 * becomes the leader of its own process group, which lets us reap Chromium
 * grandchildren via `process.kill(-pid, ...)`. We keep the IPC channel
 * (`'ipc'`) so the worker can still emit ready/error messages and accept the
 * `'shutdown'` message used by the graceful-stop path.
 *
 * Windows does not have process groups; `detached: true` would still spawn
 * the child but our negative-pid kill cannot target a group, so the flag
 * yields no benefit there. We omit it to keep behavior identical to the
 * pre-fix code on win32.
 */
export function buildWorkerForkOptions(input: BuildForkOptionsInput): ForkOptions {
  const detached = input.platform !== 'win32'
  return {
    env: input.env,
    cwd: input.cwd,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    detached,
  }
}

export interface KillWorkerProcessTreeInput {
  pid: number | null | undefined
  /** `true` when the worker was spawned with `detached: true` — i.e. it leads its own group. */
  hasProcessGroup: boolean
  /** Test seam. Production callers pass `process.kill`. */
  killFn: KillFn
  /**
   * Sleep used between SIGTERM and SIGKILL escalation. Production callers can
   * leave this default; tests inject a synchronous resolver.
   */
  sleep?: (ms: number) => Promise<void>
  /** Override the SIGKILL escalation grace window. Default 2_000 ms. */
  sigkillGraceMs?: number
  /** Optional logger override (defaults to no-op for tests / silent prod). */
  logger?: (message: string) => void
}

export interface KillWorkerProcessTreeResult {
  /** Number of kill calls that successfully signalled the target. */
  signalled: number
  /** Errors thrown by `killFn` that were not "process already gone". */
  errors: string[]
  /** True when at least one negative-pid kill was attempted (i.e. group kill path). */
  groupKillAttempted: boolean
  /** True when the SIGKILL escalation actually fired (initial SIGTERM didn't reap fast enough). */
  sigkillEscalated: boolean
}

const DEFAULT_SIGKILL_GRACE_MS = 2_000

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Send SIGTERM to the worker's process group, wait `sigkillGraceMs`, then
 * escalate to SIGKILL on the same group. The escalation is unconditional —
 * we don't poll `kill(pid, 0)` between the two because the cleanup paths
 * that call this (app.before-quit, manual stop) are race-sensitive: if the
 * worker has already exited after SIGTERM, the SIGKILL call will throw
 * ESRCH, which we silently swallow.
 *
 * Returns a result describing what happened so the caller (and tests) can
 * verify the negative-pid path was used.
 */
export async function killWorkerProcessTree(
  input: KillWorkerProcessTreeInput,
): Promise<KillWorkerProcessTreeResult> {
  const result: KillWorkerProcessTreeResult = {
    signalled: 0,
    errors: [],
    groupKillAttempted: false,
    sigkillEscalated: false,
  }

  const pid = input.pid
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    return result
  }

  const target = input.hasProcessGroup ? -pid : pid
  if (input.hasProcessGroup) result.groupKillAttempted = true
  const sleep = input.sleep ?? defaultSleep
  const grace = input.sigkillGraceMs && input.sigkillGraceMs > 0
    ? input.sigkillGraceMs
    : DEFAULT_SIGKILL_GRACE_MS
  const log = input.logger ?? (() => {})

  // 1) Send SIGTERM to the group (or single pid on Windows).
  try {
    const ok = input.killFn(target, 'SIGTERM')
    if (ok) {
      result.signalled += 1
      log(`[rsshub-cleanup] SIGTERM ${target}`)
    }
  } catch (err) {
    if (!isProcessGone(err)) {
      const message = err instanceof Error ? err.message : String(err)
      result.errors.push(`SIGTERM ${target}: ${message}`)
      log(`[rsshub-cleanup] SIGTERM ${target} failed: ${message}`)
    }
  }

  // 2) Wait the grace window so well-behaved processes can flush state.
  await sleep(grace)

  // 3) Escalate to SIGKILL on the same target. ESRCH ("no such process") is
  //    expected when SIGTERM already did the job — swallow it.
  try {
    const ok = input.killFn(target, 'SIGKILL')
    if (ok) {
      result.signalled += 1
      result.sigkillEscalated = true
      log(`[rsshub-cleanup] SIGKILL ${target}`)
    }
  } catch (err) {
    if (!isProcessGone(err)) {
      const message = err instanceof Error ? err.message : String(err)
      result.errors.push(`SIGKILL ${target}: ${message}`)
      log(`[rsshub-cleanup] SIGKILL ${target} failed: ${message}`)
    }
  }

  return result
}

function isProcessGone(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: string }).code
  return code === 'ESRCH'
}
