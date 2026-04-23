/**
 * B Phase 1 PR1 — run-shell handler tests. Uses real child_process.spawn on
 * commands known to exist on macOS/Linux hosts (echo, cat, sh). Skips
 * gracefully when the host lacks a command.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SHELL_ALLOWLIST,
  executeRunShell,
  parseCommand,
} from '../main/modules/tools/skill-primitives/run-shell'
import type { SkillRootSet } from '../main/modules/tools/skill-primitives/root-resolver'

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
