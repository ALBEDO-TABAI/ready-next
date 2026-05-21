/**
 * Unit tests for `rsshub-process-cleanup` — the pure helpers that ensure the
 * embedded RSSHub worker is reaped *together with* its Chromium grandchildren.
 *
 * Background: RSSHub's internal browser automation fork-execs Chromium
 * subprocesses inside the worker. The pre-fix code did
 * `child.kill('SIGKILL')` which only signalled the immediate Node child, so
 * Chromium was orphaned to PID 1. After Phase C3-followup we (a) spawn the
 * worker as its own process-group leader (`detached: true` on Unix), and
 * (b) cleanup sends SIGTERM/SIGKILL to `-pid` (the negative pid syntax that
 * targets the entire group, including grandchildren).
 *
 * These tests pin the two invariants:
 *   1. `buildWorkerForkOptions` produces `detached: true` + `'ipc'` on Unix.
 *   2. `killWorkerProcessTree` calls `killFn` with the negative pid AND
 *      escalates from SIGTERM to SIGKILL.
 *
 * No actual processes are spawned — `killFn` and `sleep` are injected seams,
 * keeping the suite deterministic and electron-free (so it runs under the
 * standard `node:test` harness like `boot-reaper.test.ts`).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildWorkerForkOptions,
  killWorkerProcessTree,
  type KillFn,
} from '../main/modules/rss-engine/rsshub-process-cleanup'

const FAKE_ENV: NodeJS.ProcessEnv = { RSSHUB_PORT: '1200' }
const FAKE_CWD = '/tmp/ready-rsshub-runtime'

// --- buildWorkerForkOptions --------------------------------------------------

test('buildWorkerForkOptions: darwin sets detached: true and IPC stdio', () => {
  const opts = buildWorkerForkOptions({ env: FAKE_ENV, cwd: FAKE_CWD, platform: 'darwin' })
  assert.equal(opts.detached, true, 'detached must be true so the worker leads its own group')
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe', 'ipc'], 'IPC channel must be preserved')
  assert.equal(opts.env, FAKE_ENV)
  assert.equal(opts.cwd, FAKE_CWD)
})

test('buildWorkerForkOptions: linux sets detached: true', () => {
  const opts = buildWorkerForkOptions({ env: FAKE_ENV, cwd: FAKE_CWD, platform: 'linux' })
  assert.equal(opts.detached, true)
})

test('buildWorkerForkOptions: win32 omits detached (no process groups on Windows)', () => {
  const opts = buildWorkerForkOptions({ env: FAKE_ENV, cwd: FAKE_CWD, platform: 'win32' })
  // On Windows there is no equivalent of process groups, so the negative-pid
  // kill cannot target a group anyway. Keep behavior identical to pre-fix.
  assert.equal(opts.detached, false)
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe', 'ipc'])
})

// --- killWorkerProcessTree ---------------------------------------------------

interface KillCall { pid: number; signal: NodeJS.Signals | 0 }

function makeKillFn(plan: { onSigterm?: 'success' | 'esrch' | { error: Error }; onSigkill?: 'success' | 'esrch' | { error: Error } }) {
  const calls: KillCall[] = []
  const fn: KillFn = (pid, signal) => {
    calls.push({ pid, signal })
    const planEntry = signal === 'SIGTERM' ? plan.onSigterm : plan.onSigkill
    const outcome = planEntry ?? 'success'
    if (outcome === 'success') return true
    if (outcome === 'esrch') {
      const err = new Error('kill ESRCH') as Error & { code?: string }
      err.code = 'ESRCH'
      throw err
    }
    throw outcome.error
  }
  return { fn, calls }
}

const noSleep = async (_ms: number): Promise<void> => {
  // resolve synchronously so tests don't actually wait the grace window
}

test('killWorkerProcessTree: sends SIGTERM then SIGKILL to NEGATIVE pid (group kill)', async () => {
  const { fn, calls } = makeKillFn({ onSigterm: 'success', onSigkill: 'success' })
  const result = await killWorkerProcessTree({
    pid: 12345,
    hasProcessGroup: true,
    killFn: fn,
    sleep: noSleep,
    sigkillGraceMs: 1, // immaterial because sleep is a no-op
  })
  assert.equal(result.groupKillAttempted, true, 'group kill path must be flagged')
  assert.equal(result.signalled, 2, 'both SIGTERM and SIGKILL must dispatch')
  assert.equal(result.sigkillEscalated, true, 'SIGKILL must always escalate after grace')
  assert.deepEqual(result.errors, [])
  // The CRITICAL assertion: pid is negative (group kill). If this regresses,
  // Chromium grandchildren will leak again.
  assert.deepEqual(calls, [
    { pid: -12345, signal: 'SIGTERM' },
    { pid: -12345, signal: 'SIGKILL' },
  ])
})

test('killWorkerProcessTree: hasProcessGroup=false (Windows) targets bare pid', async () => {
  const { fn, calls } = makeKillFn({ onSigterm: 'success', onSigkill: 'success' })
  const result = await killWorkerProcessTree({
    pid: 9876,
    hasProcessGroup: false,
    killFn: fn,
    sleep: noSleep,
  })
  assert.equal(result.groupKillAttempted, false)
  assert.deepEqual(calls, [
    { pid: 9876, signal: 'SIGTERM' },
    { pid: 9876, signal: 'SIGKILL' },
  ])
})

test('killWorkerProcessTree: ESRCH on SIGKILL is silently swallowed (process already exited)', async () => {
  // Common case: SIGTERM cleanly reaps the worker, then the SIGKILL escalation
  // races with the process being gone. We must not surface that as an error.
  const { fn, calls } = makeKillFn({ onSigterm: 'success', onSigkill: 'esrch' })
  const result = await killWorkerProcessTree({
    pid: 100,
    hasProcessGroup: true,
    killFn: fn,
    sleep: noSleep,
  })
  assert.deepEqual(result.errors, [], 'ESRCH on escalation is expected, not an error')
  assert.equal(result.signalled, 1, 'SIGTERM signalled; SIGKILL threw ESRCH so did not count')
  assert.equal(calls.length, 2, 'both syscalls still attempted')
})

test('killWorkerProcessTree: unexpected kill error (EPERM) is recorded but does not throw', async () => {
  const eperm = new Error('kill EPERM') as Error & { code?: string }
  eperm.code = 'EPERM'
  const { fn } = makeKillFn({ onSigterm: { error: eperm }, onSigkill: 'esrch' })
  const result = await killWorkerProcessTree({
    pid: 200,
    hasProcessGroup: true,
    killFn: fn,
    sleep: noSleep,
  })
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /SIGTERM -200: kill EPERM/)
  // Helper continues after non-ESRCH error, still attempts SIGKILL escalation.
  assert.equal(result.sigkillEscalated, false, 'SIGKILL also threw, so escalation flag is false')
})

test('killWorkerProcessTree: invalid pid is a no-op', async () => {
  const { fn, calls } = makeKillFn({})
  // null pid (worker never started)
  const result1 = await killWorkerProcessTree({
    pid: null,
    hasProcessGroup: true,
    killFn: fn,
    sleep: noSleep,
  })
  // negative pid (already a group target — caller passed wrong shape)
  const result2 = await killWorkerProcessTree({
    pid: -1,
    hasProcessGroup: true,
    killFn: fn,
    sleep: noSleep,
  })
  // NaN
  const result3 = await killWorkerProcessTree({
    pid: Number.NaN,
    hasProcessGroup: true,
    killFn: fn,
    sleep: noSleep,
  })
  assert.equal(calls.length, 0, 'no kill calls dispatched for invalid pids')
  assert.equal(result1.signalled, 0)
  assert.equal(result2.signalled, 0)
  assert.equal(result3.signalled, 0)
})

test('killWorkerProcessTree: sleep is awaited between SIGTERM and SIGKILL', async () => {
  // Verify the escalation actually waits, so well-behaved processes get a
  // chance to flush state before the kill -9. We assert ordering by recording
  // the sequence of events.
  const events: string[] = []
  const { fn } = makeKillFn({ onSigterm: 'success', onSigkill: 'success' })
  const orderingKillFn: KillFn = (pid, signal) => {
    events.push(`kill ${pid} ${String(signal)}`)
    return fn(pid, signal)
  }
  const orderingSleep = async (ms: number): Promise<void> => {
    events.push(`sleep ${ms}`)
  }
  await killWorkerProcessTree({
    pid: 555,
    hasProcessGroup: true,
    killFn: orderingKillFn,
    sleep: orderingSleep,
    sigkillGraceMs: 2_000,
  })
  assert.deepEqual(events, [
    'kill -555 SIGTERM',
    'sleep 2000',
    'kill -555 SIGKILL',
  ], 'must SIGTERM, sleep grace, then SIGKILL')
})
