/**
 * Skill direct-action tree-kill regression test.
 *
 * Regression: when a skill direct action exceeds its timeout, the previous
 * implementation (`execFileAsync({ timeout })`) only sent SIGTERM to the
 * immediate child. Real skill scripts spawn ffmpeg / yt-dlp / browser
 * grandchildren via bash/python wrappers, and those grandchildren were left
 * orphaned — eating CPU and (worse) holding GPU/audio resources that caused
 * downstream flicker / playback failures.
 *
 * The fix routes the spawn through `spawnWithTreeKill`, which spawns the
 * wrapper with `detached:true` so it becomes its own process-group leader,
 * then on timeout/abort sends SIGTERM/SIGKILL to `-pid` (the negative-pid
 * syntax targets the whole process group — grandchildren included).
 *
 * Both tests exec real shell commands and inspect actual host processes
 * via `kill -0 <pid>`. They are gated to non-Windows hosts because process
 * groups don't exist on Windows; the helper falls back to `child.kill` there
 * and the regression doesn't apply the same way.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn as realSpawn, type ChildProcess } from 'node:child_process'

import { spawnWithTreeKill } from '../main/modules/process-cleanup/spawn-with-tree-kill'

const isWindows = process.platform === 'win32'

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    // ESRCH = no such process. EPERM = process exists but we can't signal it
    // (still alive from our point of view).
    if (code === 'ESRCH') return false
    return true
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, pollMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return predicate()
}

test('spawnWithTreeKill SIGTERMs the entire process group on timeout (no orphan grandchildren)', async (t) => {
  if (isWindows) {
    t.skip('process groups are unix-only')
    return
  }

  // We pipe a "marker" line containing the PIDs of two background `sleep`
  // grandchildren before sleeping ourselves. Once we observe the marker we
  // know both grandchildren are running, so any failure to reap them after
  // the timeout is a real orphan, not a startup race.
  //
  // Using `exec` so the sleeps replace the bash wrapper would defeat the
  // test (we want bash to fork-exec sleep grandchildren). The two `sleep`s
  // are backgrounded with `&` and we `wait` so bash doesn't exit early.
  // Important: `&` already terminates a statement; using `; ` after `&`
  // would be a bash syntax error. Newlines are the safe separator.
  const script = [
    'sleep 30 &',
    'PID1=$!',
    'sleep 30 &',
    'PID2=$!',
    'echo "MARKER pid1=$PID1 pid2=$PID2"',
    'wait',
  ].join('\n')

  let observedStdout = ''
  const promise = spawnWithTreeKill('bash', ['-c', script], {
    timeoutMs: 1_000,
    sigkillGraceMs: 500,
  }).catch((err: Error & { stdout?: string; reason?: string }) => {
    observedStdout = err.stdout || ''
    return err
  })

  // Poll the helper's promise/error to grab the marker. spawnWithTreeKill
  // resolves the close promise after the timeout fires; we just await it.
  const result = await promise
  assert.ok(
    (result as Error & { reason?: string })?.reason === 'timeout',
    `expected timeout reason, got ${(result as Error & { reason?: string })?.reason}`,
  )

  const match = observedStdout.match(/MARKER pid1=(\d+) pid2=(\d+)/)
  assert.ok(match, `expected marker line in stdout, got: ${JSON.stringify(observedStdout)}`)
  const pid1 = Number(match![1])
  const pid2 = Number(match![2])
  assert.ok(Number.isFinite(pid1) && pid1 > 0, `pid1 invalid: ${match![1]}`)
  assert.ok(Number.isFinite(pid2) && pid2 > 0, `pid2 invalid: ${match![2]}`)

  // Give the OS a beat to settle SIGTERM. spawnWithTreeKill's sigkillGraceMs
  // is 500ms in this test; allow up to 4s total for both to disappear.
  const pid1Gone = await waitFor(() => !pidAlive(pid1), 4_000)
  const pid2Gone = await waitFor(() => !pidAlive(pid2), 4_000)
  assert.equal(pid1Gone, true, `grandchild pid1=${pid1} was not reaped after timeout`)
  assert.equal(pid2Gone, true, `grandchild pid2=${pid2} was not reaped after timeout`)
})

test('spawnWithTreeKill escalates to SIGKILL when SIGTERM is ignored', async (t) => {
  if (isWindows) {
    t.skip('process groups are unix-only')
    return
  }

  // Trap SIGTERM so the wrapper ignores it; spawnWithTreeKill should
  // escalate to SIGKILL after sigkillGraceMs and reap the wrapper.
  const script = "trap '' SIGTERM; sleep 30"

  const started = Date.now()
  let wrapperChild: ChildProcess | undefined
  const promise = spawnWithTreeKill('bash', ['-c', script], {
    timeoutMs: 500,
    sigkillGraceMs: 1_000,
    spawnFn: ((bin: string, args: ReadonlyArray<string>, opts: unknown) => {
      // Tee through real spawn, but capture the child for the post-mortem
      // existence check.
      const child = realSpawn(bin, args as string[], opts as Parameters<typeof realSpawn>[2])
      wrapperChild = child
      return child
    }) as typeof realSpawn,
  }).catch((err: Error & { reason?: string; signal?: NodeJS.Signals }) => err)

  const result = await promise
  const elapsed = Date.now() - started

  assert.ok(
    (result as Error & { reason?: string })?.reason === 'timeout',
    `expected timeout reason, got ${(result as Error & { reason?: string })?.reason}`,
  )
  // SIGKILL should land within ~1.5s of timeout firing. Bound the upper
  // limit at 7s (1s buffer above the 500ms timeout + 1s SIGKILL grace + ~5s
  // OS slop allowance) so the test fails loudly if escalation regresses.
  assert.ok(
    elapsed < 7_000,
    `wrapper should have been SIGKILLed, but spawnWithTreeKill took ${elapsed}ms to settle`,
  )

  const wrapperPid = wrapperChild?.pid
  if (typeof wrapperPid === 'number') {
    const gone = await waitFor(() => !pidAlive(wrapperPid), 2_000)
    assert.equal(gone, true, `wrapper pid=${wrapperPid} survived SIGKILL escalation`)
  }
})
