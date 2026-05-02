/**
 * C6 — Skill direct-action output overflow-to-disk.
 *
 * Background: long-running video / audio skills (ffmpeg progress, scenedetect
 * noise) routinely produce tens of MiB of stderr. The previous implementation
 * buffered everything in memory up to MAX_COMMAND_BUFFER (24 MiB) before
 * killing the process, which both lost the overflow tail AND occasionally
 * OOMed the main process when multiple long actions ran back-to-back.
 *
 * The fix splits buffering into two tiers:
 *   1. First DIRECT_ACTION_INMEMORY_CAP bytes (= 1 MiB) per stream stay in
 *      memory and are returned in the result envelope (so the LLM sees a
 *      meaningful preview).
 *   2. Bytes beyond 1 MiB are appended to a per-action artifact under
 *      `<runtimeRoot>/outputs/<skillId>/.logs/skill-action-<id>-<stream>.txt`.
 *   3. The truncated in-memory portion gets a clear marker pointing at the
 *      full log path.
 *   4. Disk-write failures (mkdir / append) NEVER take the command down — the
 *      result still returns; only `*ArtifactError` is populated instead of
 *      `*ArtifactPath`.
 *
 * The plumbing lives in `spawn-with-tree-kill.ts` (per-stream caps + sinks)
 * and `runtime-manager.ts::executeProcessWithStructuredResult` (the .logs/
 * directory layout + truncation marker rendering). Tests cover both: direct
 * sink-level behavior on the helper, plus an end-to-end smoke that drives a
 * real subprocess through the runtime-manager and inspects the on-disk
 * artifact.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { spawnWithTreeKill, type OverflowSink, type SpawnWithTreeKillError } from '../main/modules/process-cleanup/spawn-with-tree-kill'
import { SkillsRuntimeManager } from '../main/modules/skills-runtime/runtime-manager'

const isWindows = process.platform === 'win32'

// ---------------------------------------------------------------------------
// 1. Helper-level: stdout under cap stays fully in memory, no sink invoked.
// ---------------------------------------------------------------------------

test('spawnWithTreeKill: 500KB stdout stays fully in memory, sink is never called', async () => {
  // 500 KB = well under the 1 MiB per-stream cap.
  const payload = 'A'.repeat(500 * 1024)
  // Use `node -e` so we don't depend on a writable fixture file.
  const script = `process.stdout.write(${JSON.stringify(payload)})`
  const sinkChunks: string[] = []
  const sink: OverflowSink = (chunk) => { sinkChunks.push(chunk) }

  const result = await spawnWithTreeKill('node', ['-e', script], {
    inMemoryStdoutCap: 1024 * 1024,
    inMemoryStderrCap: 1024 * 1024,
    stdoutOverflowSink: sink,
    stderrOverflowSink: sink,
  })

  assert.equal(result.exitCode, 0)
  assert.equal(result.stdoutOverflowed, false, 'overflowed flag should stay false')
  assert.equal(result.stderrOverflowed, false)
  assert.equal(result.stdoutOverflowError, null)
  assert.equal(result.stderrOverflowError, null)
  assert.equal(sinkChunks.length, 0, 'sink should never be invoked under the cap')
  assert.equal(result.stdout.length, payload.length, 'all bytes captured in memory')
  assert.equal(result.stdout, payload)
})

// ---------------------------------------------------------------------------
// 2. Helper-level: 5 MiB stdout → first 1 MiB in memory, rest spilled to sink.
// ---------------------------------------------------------------------------

test('spawnWithTreeKill: 5 MiB stdout caps in-memory at 1 MiB and routes overflow to sink', async () => {
  // 5 MiB total. Write in 256 KB chunks so the data event fires multiple
  // times — exercises both the "chunk fully fits" and "chunk straddles the
  // boundary" branches in the data handler.
  const chunkSize = 256 * 1024
  const totalChunks = 20 // 20 * 256 KB = 5 MiB
  const script = [
    `const buf = 'X'.repeat(${chunkSize});`,
    `for (let i = 0; i < ${totalChunks}; i++) process.stdout.write(buf);`,
  ].join(' ')

  let spilled = ''
  const sink: OverflowSink = (chunk) => { spilled += chunk }

  const result = await spawnWithTreeKill('node', ['-e', script], {
    inMemoryStdoutCap: 1024 * 1024, // 1 MiB
    inMemoryStderrCap: 1024 * 1024,
    stdoutOverflowSink: sink,
    stderrOverflowSink: () => {},
  })

  assert.equal(result.exitCode, 0)
  assert.equal(result.stdoutOverflowed, true, 'overflow flag should be set')
  assert.equal(result.stderrOverflowed, false, 'stderr untouched')
  assert.equal(result.stdoutOverflowError, null)
  // In-memory portion is exactly the cap.
  assert.equal(Buffer.byteLength(result.stdout, 'utf-8'), 1024 * 1024, 'in-memory stdout matches cap')
  // Spill catches the rest.
  assert.equal(Buffer.byteLength(spilled, 'utf-8'), 4 * 1024 * 1024, 'sink received the remaining 4 MiB')
})

// ---------------------------------------------------------------------------
// 3. Helper-level: both stdout AND stderr beyond cap → 2 sinks both called.
// ---------------------------------------------------------------------------

test('spawnWithTreeKill: simultaneous overflow on stdout AND stderr each call their own sink', async () => {
  // Write 2 MiB to stdout and 2 MiB to stderr; cap each at 256 KiB so both
  // overflow channels fire.
  const cap = 256 * 1024
  const write = 2 * 1024 * 1024
  const script = [
    `const out = 'O'.repeat(${write});`,
    `const err = 'E'.repeat(${write});`,
    `process.stdout.write(out); process.stderr.write(err);`,
  ].join(' ')

  let stdoutSpill = ''
  let stderrSpill = ''
  const result = await spawnWithTreeKill('node', ['-e', script], {
    inMemoryStdoutCap: cap,
    inMemoryStderrCap: cap,
    stdoutOverflowSink: (chunk) => { stdoutSpill += chunk },
    stderrOverflowSink: (chunk) => { stderrSpill += chunk },
  })

  assert.equal(result.exitCode, 0)
  assert.equal(result.stdoutOverflowed, true)
  assert.equal(result.stderrOverflowed, true)
  assert.equal(Buffer.byteLength(result.stdout, 'utf-8'), cap, 'stdout in-memory matches cap')
  assert.equal(Buffer.byteLength(result.stderr, 'utf-8'), cap, 'stderr in-memory matches cap')
  assert.equal(Buffer.byteLength(stdoutSpill, 'utf-8'), write - cap, 'stdout sink got the remainder')
  assert.equal(Buffer.byteLength(stderrSpill, 'utf-8'), write - cap, 'stderr sink got the remainder')
})

// ---------------------------------------------------------------------------
// 4. Helper-level: sink that throws — error captured, command still returns.
// ---------------------------------------------------------------------------

test('spawnWithTreeKill: sink that throws on overflow records the error but does not break the run', async () => {
  const script = [
    `const buf = 'X'.repeat(${256 * 1024});`,
    `for (let i = 0; i < 4; i++) process.stdout.write(buf);`, // 1 MiB total
  ].join(' ')

  const result = await spawnWithTreeKill('node', ['-e', script], {
    inMemoryStdoutCap: 256 * 1024,
    inMemoryStderrCap: 256 * 1024,
    stdoutOverflowSink: () => { throw new Error('disk is full (synthetic)') },
    stderrOverflowSink: () => {},
  })

  assert.equal(result.exitCode, 0)
  assert.equal(result.stdoutOverflowed, true)
  assert.ok(result.stdoutOverflowError, 'error should be recorded')
  assert.match(result.stdoutOverflowError ?? '', /disk is full/)
  // In-memory portion is still exactly the cap.
  assert.equal(Buffer.byteLength(result.stdout, 'utf-8'), 256 * 1024)
})

// ---------------------------------------------------------------------------
// 5. Integration: end-to-end through SkillsRuntimeManager.runSkill — overflow
//    artifact lands under <outputsRoot>/<skillId>/.logs/.
// ---------------------------------------------------------------------------

interface OverflowFixture {
  runtimeRoot: string
  embeddedSkillsRoot: string
  skillId: string
  cleanup: () => void
}

function makeNodeOverflowFixture(stdoutBytes: number, stderrBytes: number): OverflowFixture {
  const tempRoot = mkdtempSync(join(tmpdir(), 'skill-overflow-fx-'))
  const runtimeRoot = join(tempRoot, 'runtime')
  const embeddedSkillsRoot = join(tempRoot, 'embedded-skills')
  const skillId = `overflow-fx-${Date.now()}`
  const customSkillsRoot = join(runtimeRoot, 'custom-skills')
  const managedPath = join(customSkillsRoot, skillId)
  mkdirSync(embeddedSkillsRoot, { recursive: true })
  mkdirSync(managedPath, { recursive: true })

  // A tiny node script that writes the requested number of bytes to each
  // stream. We use `node` runtime so the test doesn't need Python/venv
  // setup — node is required to run the test suite anyway.
  const entryFilename = 'main.js'
  const entry = [
    `const stdoutBytes = ${stdoutBytes};`,
    `const stderrBytes = ${stderrBytes};`,
    `if (stdoutBytes > 0) process.stdout.write('O'.repeat(stdoutBytes));`,
    `if (stderrBytes > 0) process.stderr.write('E'.repeat(stderrBytes));`,
  ].join('\n')
  writeFileSync(join(managedPath, entryFilename), entry, 'utf-8')

  const manifest = {
    id: skillId,
    name: 'Overflow Fixture',
    description: 'Writes synthetic bytes to stdout/stderr to exercise overflow-to-disk.',
    version: '1.0.0',
    source: 'custom',
    runtime: 'node',
    defaultAction: 'run',
    sourcePath: managedPath,
    importedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    actions: [
      {
        name: 'run',
        runtime: 'node',
        entry: entryFilename,
        visibility: 'public',
        params: [],
      },
    ],
    execution: { mode: 'subprocess' },
  }
  writeFileSync(join(managedPath, 'ready-skill.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  writeFileSync(join(managedPath, 'SKILL.md'), '# overflow fixture\n', 'utf-8')

  return {
    runtimeRoot,
    embeddedSkillsRoot,
    skillId,
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  }
}

test('runSkill end-to-end: 5 MiB stdout spills to <outputsRoot>/<skillId>/.logs/skill-action-<id>-stdout.txt', async () => {
  const fx = makeNodeOverflowFixture(5 * 1024 * 1024, 0)
  try {
    const manager = new SkillsRuntimeManager({
      runtimeRoot: fx.runtimeRoot,
      embeddedSkillsRoot: fx.embeddedSkillsRoot,
      startBackgroundTasks: false,
    })

    const result = await manager.runSkill({
      skillId: fx.skillId,
      action: 'run',
      params: {},
    })

    assert.equal(result.success, true, `expected success, got error="${result.error}"`)
    // Truncation marker present in the in-memory portion.
    assert.match(result.stdout, /output truncated; full log at:/)
    // Artifact path populated and points under <outputsRoot>/<skillId>/.logs/.
    const artifactPath = result.stdoutArtifactPath
    assert.ok(typeof artifactPath === 'string' && artifactPath.length > 0, 'artifact path should be set')
    const expectedDir = join(fx.runtimeRoot, 'outputs', fx.skillId, '.logs')
    assert.ok(artifactPath!.startsWith(expectedDir), `artifact under expected dir; got: ${artifactPath}`)
    assert.ok(/skill-action-.*-stdout\.txt$/.test(artifactPath!), `filename matches contract; got: ${artifactPath}`)
    assert.ok(existsSync(artifactPath!), 'artifact file exists on disk')
    // Roughly 4 MiB on disk (5 MiB total minus ~1 MiB that stayed in memory).
    const sz = statSync(artifactPath!).size
    assert.ok(sz >= 3.5 * 1024 * 1024 && sz <= 4.5 * 1024 * 1024,
      `expected ~4 MiB on disk (5 MiB - 1 MiB cap); got ${sz}`)
    // No stderr overflow → no stderr artifact.
    assert.equal(result.stderrArtifactPath, undefined)
    assert.equal(result.stdoutArtifactError, undefined)
  } finally {
    fx.cleanup()
  }
})

test('runSkill end-to-end: simultaneous stdout + stderr overflow → 2 separate artifact files', async () => {
  const fx = makeNodeOverflowFixture(2 * 1024 * 1024, 2 * 1024 * 1024)
  try {
    const manager = new SkillsRuntimeManager({
      runtimeRoot: fx.runtimeRoot,
      embeddedSkillsRoot: fx.embeddedSkillsRoot,
      startBackgroundTasks: false,
    })

    const result = await manager.runSkill({
      skillId: fx.skillId,
      action: 'run',
      params: {},
    })

    assert.equal(result.success, true)
    assert.ok(result.stdoutArtifactPath, 'stdout artifact path set')
    assert.ok(result.stderrArtifactPath, 'stderr artifact path set')
    assert.notEqual(result.stdoutArtifactPath, result.stderrArtifactPath, 'separate files per stream')
    assert.ok(existsSync(result.stdoutArtifactPath!))
    assert.ok(existsSync(result.stderrArtifactPath!))
    // Both files are roughly 1 MiB (2 MiB written - 1 MiB cap).
    const stdoutSz = statSync(result.stdoutArtifactPath!).size
    const stderrSz = statSync(result.stderrArtifactPath!).size
    assert.ok(stdoutSz >= 0.8 * 1024 * 1024, `stdout artifact >= ~0.8 MiB; got ${stdoutSz}`)
    assert.ok(stderrSz >= 0.8 * 1024 * 1024, `stderr artifact >= ~0.8 MiB; got ${stderrSz}`)
  } finally {
    fx.cleanup()
  }
})

test('runSkill end-to-end: 500KB stdout never touches disk (no overflow)', async () => {
  const fx = makeNodeOverflowFixture(500 * 1024, 0)
  try {
    const manager = new SkillsRuntimeManager({
      runtimeRoot: fx.runtimeRoot,
      embeddedSkillsRoot: fx.embeddedSkillsRoot,
      startBackgroundTasks: false,
    })

    const result = await manager.runSkill({
      skillId: fx.skillId,
      action: 'run',
      params: {},
    })

    assert.equal(result.success, true)
    assert.equal(result.stdoutArtifactPath, undefined, 'no artifact when under cap')
    assert.equal(result.stderrArtifactPath, undefined)
    assert.equal(result.stdoutArtifactError, undefined)
    // No truncation marker in the in-memory portion.
    assert.doesNotMatch(result.stdout, /output truncated/)
    // The .logs dir should NEVER have been created.
    const logsDir = join(fx.runtimeRoot, 'outputs', fx.skillId, '.logs')
    assert.equal(existsSync(logsDir), false, 'lazy: .logs dir created only on overflow')
  } finally {
    fx.cleanup()
  }
})

test('runSkill end-to-end: mkdir failure on .logs is reported via stdoutArtifactError but does not fail the action', async () => {
  if (isWindows) return // chmod-based mkdir blocking is unix-only
  const fx = makeNodeOverflowFixture(2 * 1024 * 1024, 0)
  try {
    // Pre-create the outputs/<skillId>/ dir as read-only so that mkdir of
    // `.logs/` underneath fails with EACCES. The skill itself doesn't need
    // outputs/ to run (the test fixture is a minimal `node` script that
    // writes to stdout).
    const skillOutputsDir = join(fx.runtimeRoot, 'outputs', fx.skillId)
    mkdirSync(skillOutputsDir, { recursive: true })
    chmodSync(skillOutputsDir, 0o500) // r-x — blocks mkdir of subfolders

    const manager = new SkillsRuntimeManager({
      runtimeRoot: fx.runtimeRoot,
      embeddedSkillsRoot: fx.embeddedSkillsRoot,
      startBackgroundTasks: false,
    })

    const result = await manager.runSkill({
      skillId: fx.skillId,
      action: 'run',
      params: {},
    })

    assert.equal(result.success, true, 'command itself should still succeed')
    // No path because the disk write never happened.
    assert.equal(result.stdoutArtifactPath, undefined)
    // Error captured.
    assert.ok(result.stdoutArtifactError, `expected stdoutArtifactError to be set, got: ${JSON.stringify(result)}`)
    // In-memory portion still has the truncation marker (just without a path).
    assert.match(result.stdout, /output truncated/)
  } finally {
    // Restore perms so cleanup can rm the tree.
    try {
      const skillOutputsDir = join(fx.runtimeRoot, 'outputs', fx.skillId)
      chmodSync(skillOutputsDir, 0o700)
    } catch { /* ignore */ }
    fx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Backward compat: when overflow caps are NOT supplied, the helper preserves
// the legacy combined-buffer behavior so the existing tree-kill regression
// tests stay green. We assert the combined cap still throws on overflow, and
// that no spurious overflow flags surface on a normal run.
// ---------------------------------------------------------------------------

test('spawnWithTreeKill: no caps supplied → legacy behavior, overflow flags stay false on a normal run', async () => {
  const result = await spawnWithTreeKill('node', ['-e', "process.stdout.write('hi')"], {
    timeoutMs: 5_000,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'hi')
  assert.equal(result.stdoutOverflowed, false)
  assert.equal(result.stderrOverflowed, false)
  assert.equal(result.stdoutOverflowError, null)
  assert.equal(result.stderrOverflowError, null)
})

test('spawnWithTreeKill: no caps supplied → legacy combined-maxBuffer still throws on overflow', async () => {
  // Generate the bytes from inside the script — passing them as argv hits the
  // host's E2BIG limit (~256 KB on macOS) before spawn even runs, which is a
  // different failure than the buffer overflow we're trying to exercise.
  const script = "process.stdout.write('A'.repeat(2 * 1024 * 1024))"
  await assert.rejects(
    spawnWithTreeKill('node', ['-e', script], {
      maxBuffer: 1024, // 1 KB — guaranteed overflow
    }),
    (err: unknown) => {
      const e = err as SpawnWithTreeKillError
      return e instanceof Error && /exceeded maxBuffer/.test(e.message)
    },
  )
})
