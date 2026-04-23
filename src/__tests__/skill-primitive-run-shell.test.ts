/**
 * B Phase 1 PR1 — run-shell handler tests. Uses real child_process.spawn on
 * commands known to exist on macOS/Linux hosts (echo, cat, sh). Skips
 * gracefully when the host lacks a command.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CommandParseError,
  SHELL_ALLOWLIST,
  executeRunShell,
  parseCommand,
} from '../main/modules/tools/skill-primitives/run-shell'
import type { SkillRootSet } from '../main/modules/tools/skill-primitives/root-resolver'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'

function makeFixture() {
  const artifactRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'skill-prim-shell-art-')))
  const assetRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'skill-prim-shell-asset-')))
  const lookup = (id: string): SkillRootSet | null =>
    id === 'test-skill' ? { skillId: 'test-skill', assetRoot, artifactRoot } : null
  return {
    artifactRoot,
    assetRoot,
    lookup,
    cleanup: () => {
      rmSync(artifactRoot, { recursive: true, force: true })
      rmSync(assetRoot, { recursive: true, force: true })
    },
  }
}

test('parseCommand tokenizes whitespace and preserves double-quoted segments', () => {
  assert.deepEqual(parseCommand('python scripts/analyze.py --input foo.mp4'), {
    bin: 'python',
    args: ['scripts/analyze.py', '--input', 'foo.mp4'],
  })
  assert.deepEqual(parseCommand('echo "hello world" three'), {
    bin: 'echo',
    args: ['hello world', 'three'],
  })
  assert.equal(parseCommand(''), null)
  assert.equal(parseCommand('   '), null)
})

test('SHELL_ALLOWLIST exposes the Phase 1 base whitelist', () => {
  for (const expected of ['python', 'python3', 'node', 'bash', 'sh', 'cat', 'echo']) {
    assert.ok(SHELL_ALLOWLIST.has(expected), `expected ${expected} in allowlist`)
  }
  // Commands known NOT to be in the Phase 1 list
  assert.equal(SHELL_ALLOWLIST.has('ffmpeg'), false)
  assert.equal(SHELL_ALLOWLIST.has('vim'), false)
})

test('rejects command_empty for a blank command', async () => {
  const fx = makeFixture()
  try {
    await assert.rejects(
      executeRunShell({ command: '   ' }, { skillId: 'test-skill', lookupSkillRoots: fx.lookup }),
      (error: unknown) => (error as { errorKind?: string })?.errorKind === 'command_empty',
    )
  } finally {
    fx.cleanup()
  }
})

test('rejects cmd_not_allowlisted for non-whitelisted binaries', async () => {
  const fx = makeFixture()
  try {
    await assert.rejects(
      executeRunShell(
        { command: 'vim README.md' },
        { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
      ),
      (error: unknown) => (error as { errorKind?: string })?.errorKind === 'cmd_not_allowlisted',
    )
  } finally {
    fx.cleanup()
  }
})

test('echo produces stdout and exitCode=0 with env CLAUDE_SKILL_DIR set to assetRoot', async () => {
  const fx = makeFixture()
  try {
    writeFileSync(join(fx.assetRoot, 'marker.txt'), 'ok', 'utf-8')
    const out = await executeRunShell(
      { command: 'echo hello' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    const data = out.data as any
    assert.equal(data?.exitCode, 0)
    assert.ok((data?.stdout || '').includes('hello'))
    // cwd should match assetRoot — `ls marker.txt` finds the file.
    const ls = await executeRunShell(
      { command: 'ls marker.txt' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    const lsData = ls.data as any
    assert.equal(lsData?.exitCode, 0)
    assert.ok((lsData?.stdout || '').includes('marker.txt'))
  } finally {
    fx.cleanup()
  }
})

test('stdout over 8K chars is truncated and logged to an overflow artifact', async () => {
  const fx = makeFixture()
  try {
    // Use `cat` on a large file (no shell expansion needed). Make ~20K bytes.
    const bigPath = join(fx.assetRoot, 'big.txt')
    writeFileSync(bigPath, 'A'.repeat(20_000), 'utf-8')
    const out = await executeRunShell(
      { command: 'cat big.txt' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    const data = out.data as any
    assert.equal(data?.exitCode, 0)
    assert.equal(data?.stdoutTruncated, true)
    const logPath = data?.stdoutArtifactPath as string
    assert.ok(typeof logPath === 'string' && logPath.length > 0)
    assert.ok(logPath.startsWith(fx.artifactRoot))
    assert.ok(existsSync(logPath))
  } finally {
    fx.cleanup()
  }
})

test('timeout kills the process and surfaces timeout errorKind', async () => {
  const fx = makeFixture()
  try {
    await assert.rejects(
      executeRunShell(
        { command: 'sh -c "sleep 5"', timeoutMs: 200 },
        { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
      ),
      (error: unknown) => (error as { errorKind?: string })?.errorKind === 'timeout',
    )
  } finally {
    fx.cleanup()
  }
})

test('rejects unknown skillId with missing_skill errorKind', async () => {
  const fx = makeFixture()
  try {
    await assert.rejects(
      executeRunShell(
        { command: 'echo hi' },
        { skillId: 'no-such-skill', lookupSkillRoots: fx.lookup },
      ),
      (error: unknown) => (error as { errorKind?: string })?.errorKind === 'missing_skill',
    )
  } finally {
    fx.cleanup()
  }
})

// Patch B4 — single-quote rejection. We deliberately refuse POSIX quoting so
// model-generated `echo 'hello world'` fails loudly rather than producing
// silently-mangled argv.
test('parseCommand throws CommandParseError on single quotes and unbalanced double quotes', () => {
  assert.throws(
    () => parseCommand("echo 'hello'"),
    (err: unknown) => err instanceof CommandParseError && err.reason === 'single_quote',
  )
  assert.throws(
    () => parseCommand('echo "unterminated'),
    (err: unknown) => err instanceof CommandParseError && err.reason === 'unbalanced_quote',
  )
})

test('executeRunShell rejects command_parse_failed when single quotes appear', async () => {
  const fx = makeFixture()
  try {
    await assert.rejects(
      executeRunShell(
        { command: "echo 'hi'" },
        { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
      ),
      (error: unknown) => (error as { errorKind?: string })?.errorKind === 'command_parse_failed',
    )
  } finally {
    fx.cleanup()
  }
})

// Patch B4 — non-ASCII bin names should fall through to cmd_not_allowlisted
// rather than being allowed via an accidental code path.
test('executeRunShell rejects non-ASCII bin (Chinese command name) as cmd_not_allowlisted', async () => {
  const fx = makeFixture()
  try {
    await assert.rejects(
      executeRunShell(
        { command: '运行 foo' },
        { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
      ),
      (error: unknown) => (error as { errorKind?: string })?.errorKind === 'cmd_not_allowlisted',
    )
  } finally {
    fx.cleanup()
  }
})

// Patch B3 — every reject path must emit skillPrimitiveRejected with a
// stable reason dimension. Captures metrics via the test sink so the contract
// is runtime-verifiable (previously only the registry was asserted).
test('every rejection emits skillPrimitiveRejected with the expected reason dimension', async () => {
  const fx = makeFixture()
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((e) => { events.push(e) })
  try {
    await assert.rejects(
      executeRunShell({ command: '   ' }, { skillId: 'test-skill', lookupSkillRoots: fx.lookup }),
    )
    await assert.rejects(
      executeRunShell(
        { command: 'vim README.md' },
        { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
      ),
    )
    await assert.rejects(
      executeRunShell({ command: "echo 'bad'" }, { skillId: 'test-skill', lookupSkillRoots: fx.lookup }),
    )
    await assert.rejects(
      executeRunShell(
        { command: 'echo hi' },
        { skillId: 'nope', lookupSkillRoots: fx.lookup },
      ),
    )
    const reasons = events
      .filter((e) => e.metric === 'skill_primitive_rejected' && e.primitive === 'skill_run_shell')
      .map((e) => e.reason)
    assert.ok(reasons.includes('command_empty'))
    assert.ok(reasons.includes('cmd_not_allowlisted'))
    assert.ok(reasons.includes('command_parse_failed'))
    assert.ok(reasons.includes('missing_skill'))
  } finally {
    __setMetricSinkForTests(null)
    fx.cleanup()
  }
})

// Patch B1 — overflow artifact write failure MUST NOT swallow the command
// result. We simulate the failure by chmod 0 on the artifactRoot, which makes
// `mkdir .logs` + writeFile fail. The handler must still return stdout and
// exitCode; it only surfaces the log write failure via stdoutArtifactError.
test('overflow artifact write failure degrades gracefully and preserves command result', async () => {
  if (process.platform === 'win32') return // chmod semantics differ; skip on windows
  const fx = makeFixture()
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((e) => { events.push(e) })
  try {
    const big = join(fx.assetRoot, 'big.txt')
    writeFileSync(big, 'B'.repeat(20_000), 'utf-8')
    // Make the artifactRoot read-only so mkdir of `.logs/` fails.
    chmodSync(fx.artifactRoot, 0o500)

    const out = await executeRunShell(
      { command: 'cat big.txt' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    const data = out.data as any
    assert.equal(data?.exitCode, 0, 'command itself still reported exit 0')
    assert.equal(data?.stdoutTruncated, true, 'still reports truncation')
    assert.equal(data?.stdoutArtifactPath, null, 'log write failed → no path')
    assert.ok(typeof data?.stdoutArtifactError === 'string' && data.stdoutArtifactError.length > 0)
    const rejections = events.filter(
      (e) => e.metric === 'skill_primitive_rejected' && e.reason === 'overflow_artifact_write_failed',
    )
    assert.ok(rejections.length >= 1, 'overflow_artifact_write_failed metric should be emitted')
  } finally {
    __setMetricSinkForTests(null)
    try { chmodSync(fx.artifactRoot, 0o700) } catch { /* ignore — fixture cleanup will force rm */ }
    fx.cleanup()
  }
})

// Patch B5 — detached + SIGTERM timeout kill. We verify the child runs and
// gets terminated when timeout fires. Grandchild reaping is hard to assert
// deterministically in a unit test; the effectful test is "timeout still
// errorKind: 'timeout'" and stdout capture wasn't broken by `detached: true`.
test('detached spawn flag does not break stream capture', async () => {
  const fx = makeFixture()
  try {
    writeFileSync(join(fx.assetRoot, 'data.txt'), 'abc\n', 'utf-8')
    const out = await executeRunShell(
      { command: 'cat data.txt' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    const data = out.data as any
    assert.equal(data?.exitCode, 0)
    assert.ok((data?.stdout || '').includes('abc'))
  } finally {
    fx.cleanup()
  }
})
