/**
 * B Phase 1 PR1 — write-artifact handler tests. Uses a custom lookupSkillRoots
 * to stay off the SkillsRuntimeManager singleton so this file runs under
 * `tsx --test` without needing electron boot.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  WRITE_ARTIFACT_HARD_CAP_BYTES,
  executeWriteArtifact,
} from '../main/modules/tools/skill-primitives/write-artifact'
import type { SkillRootSet } from '../main/modules/tools/skill-primitives/root-resolver'

function makeFixture() {
  // Canonicalize to match path-sandbox's realpath normalization (macOS /tmp).
  const artifactRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'skill-prim-write-')))
  const assetRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'skill-prim-asset-')))
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

test('writes utf-8 content to a path under the artifact root', async () => {
  const fx = makeFixture()
  try {
    const out = await executeWriteArtifact(
      { relativePath: 'output/result.json', content: '{"ok":true}' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    const abs = join(fx.artifactRoot, 'output', 'result.json')
    assert.ok(existsSync(abs))
    assert.equal(readFileSync(abs, 'utf-8'), '{"ok":true}')
    assert.equal(out.shape, 'json')
    assert.equal((out.data as any)?.bytesWritten, 11)
    assert.equal((out.data as any)?.absolutePath, abs)
  } finally {
    fx.cleanup()
  }
})

test('allows overwriting an existing file at the same path', async () => {
  const fx = makeFixture()
  try {
    writeFileSync(join(fx.artifactRoot, 'r.txt'), 'old', 'utf-8')
    await executeWriteArtifact(
      { relativePath: 'r.txt', content: 'new content' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    assert.equal(readFileSync(join(fx.artifactRoot, 'r.txt'), 'utf-8'), 'new content')
  } finally {
    fx.cleanup()
  }
})

test('creates intermediate directories as needed', async () => {
  const fx = makeFixture()
  try {
    await executeWriteArtifact(
      { relativePath: 'deeply/nested/tree/file.md', content: '# hi' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    const abs = join(fx.artifactRoot, 'deeply', 'nested', 'tree', 'file.md')
    assert.ok(existsSync(abs))
  } finally {
    fx.cleanup()
  }
})

test('refuses reserved filenames (SKILL.md) even inside the artifact root', async () => {
  const fx = makeFixture()
  try {
    await assert.rejects(
      executeWriteArtifact(
        { relativePath: 'subdir/SKILL.md', content: 'bad' },
        { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
      ),
      (error: unknown) => {
        const kind = (error as { errorKind?: string })?.errorKind
        return kind === 'reserved_path'
      },
    )
  } finally {
    fx.cleanup()
  }
})

test('refuses `..` escape attempts', async () => {
  const fx = makeFixture()
  try {
    await assert.rejects(
      executeWriteArtifact(
        { relativePath: '../../outside.txt', content: 'bad' },
        { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
      ),
      (error: unknown) => {
        const kind = (error as { errorKind?: string })?.errorKind
        return kind === 'path_escape'
      },
    )
  } finally {
    fx.cleanup()
  }
})

test('honors base64 encoding', async () => {
  const fx = makeFixture()
  try {
    const payload = Buffer.from([0x00, 0x01, 0x02, 0xff]).toString('base64')
    await executeWriteArtifact(
      { relativePath: 'bin.dat', content: payload, encoding: 'base64' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    const abs = join(fx.artifactRoot, 'bin.dat')
    const written = readFileSync(abs)
    assert.deepEqual([...written], [0x00, 0x01, 0x02, 0xff])
  } finally {
    fx.cleanup()
  }
})

test('rejects unknown skill with missing_skill errorKind', async () => {
  const fx = makeFixture()
  try {
    await assert.rejects(
      executeWriteArtifact(
        { relativePath: 'x.txt', content: 'hi' },
        { skillId: 'no-such-skill', lookupSkillRoots: fx.lookup },
      ),
      (error: unknown) => (error as { errorKind?: string })?.errorKind === 'missing_skill',
    )
  } finally {
    fx.cleanup()
  }
})

// Patch B4 — hard cap on write_artifact payload size. 50 MB default; any
// attempt to push more returns size_limit without touching the fs.
test('rejects size_limit when content exceeds WRITE_ARTIFACT_HARD_CAP_BYTES', async () => {
  const fx = makeFixture()
  try {
    // 'A' byte is 1-byte utf-8. Use cap+1 to exceed by a single byte.
    const tooBig = 'A'.repeat(WRITE_ARTIFACT_HARD_CAP_BYTES + 1)
    await assert.rejects(
      executeWriteArtifact(
        { relativePath: 'too-big.txt', content: tooBig },
        { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
      ),
      (error: unknown) => (error as { errorKind?: string })?.errorKind === 'size_limit',
    )
  } finally {
    fx.cleanup()
  }
})

// Patch B2 — reserved filename check is case-insensitive. A lowercase
// `skill.md` must be rejected on macOS/Windows where the real SKILL.md would
// be shadowed; on Linux it's a defense-in-depth reject.
test('refuses reserved filename in any case variant (skill.md, Skill.md)', async () => {
  const fx = makeFixture()
  try {
    for (const name of ['skill.md', 'Skill.md', 'SKILL.MD']) {
      await assert.rejects(
        executeWriteArtifact(
          { relativePath: name, content: 'bad' },
          { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
        ),
        (error: unknown) => {
          const kind = (error as { errorKind?: string })?.errorKind
          return kind === 'reserved_path'
        },
      )
    }
  } finally {
    fx.cleanup()
  }
})
