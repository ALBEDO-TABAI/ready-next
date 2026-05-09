/**
 * Stage T (PR-T2 / W7.2) — symlink rejection in read-artifact / write-artifact.
 *
 * Asserts:
 *   - read-artifact rejects when the requested path is itself a symlink, even
 *     if the symlink target lives inside the sandbox root.
 *   - write-artifact rejects when overwriting an existing in-sandbox symlink.
 *   - The thrown error carries `errorKind: 'symlink_rejected'`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { executeReadArtifact } from '../main/modules/tools/skill-primitives/read-artifact'
import { executeWriteArtifact } from '../main/modules/tools/skill-primitives/write-artifact'
import type { SkillRootSet } from '../main/modules/tools/skill-primitives/root-resolver'
import { ToolDomainError } from '../main/modules/tools/tool-errors'

function makeFixture() {
  const artifactRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'sandbox-symlink-art-')))
  const assetRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'sandbox-symlink-asset-')))
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

test('read-artifact rejects in-sandbox symlinks even when target is also in-sandbox', async () => {
  const fx = makeFixture()
  try {
    // target.txt is a real file inside artifactRoot.
    writeFileSync(join(fx.artifactRoot, 'target.txt'), 'real content', 'utf-8')
    // link.txt is a symlink to target.txt — both inside the sandbox.
    symlinkSync(join(fx.artifactRoot, 'target.txt'), join(fx.artifactRoot, 'link.txt'))

    let caught: unknown = null
    try {
      await executeReadArtifact(
        { relativePath: 'link.txt' },
        { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
      )
    } catch (err) {
      caught = err
    }
    assert.ok(caught instanceof ToolDomainError, `expected ToolDomainError, got ${caught}`)
    assert.equal((caught as ToolDomainError).errorKind, 'symlink_rejected')
  } finally {
    fx.cleanup()
  }
})

test('read-artifact still reads regular in-sandbox files (regression guard)', async () => {
  const fx = makeFixture()
  try {
    writeFileSync(join(fx.artifactRoot, 'plain.txt'), 'hello', 'utf-8')
    const out = await executeReadArtifact(
      { relativePath: 'plain.txt' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    assert.equal(out.shape, 'json')
    assert.equal((out.data as { content: string }).content, 'hello')
  } finally {
    fx.cleanup()
  }
})

test('write-artifact refuses to overwrite an existing symlink', async () => {
  const fx = makeFixture()
  try {
    writeFileSync(join(fx.artifactRoot, 'target.txt'), 'real', 'utf-8')
    symlinkSync(join(fx.artifactRoot, 'target.txt'), join(fx.artifactRoot, 'link.txt'))

    let caught: unknown = null
    try {
      await executeWriteArtifact(
        { relativePath: 'link.txt', content: 'new content' },
        { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
      )
    } catch (err) {
      caught = err
    }
    assert.ok(caught instanceof ToolDomainError, `expected ToolDomainError, got ${caught}`)
    assert.equal((caught as ToolDomainError).errorKind, 'symlink_rejected')
  } finally {
    fx.cleanup()
  }
})

test('write-artifact still writes to fresh paths and overwrites regular files', async () => {
  const fx = makeFixture()
  try {
    // Fresh path.
    await executeWriteArtifact(
      { relativePath: 'new.txt', content: 'fresh' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    // Overwrite existing regular file.
    writeFileSync(join(fx.artifactRoot, 'reg.txt'), 'old', 'utf-8')
    await executeWriteArtifact(
      { relativePath: 'reg.txt', content: 'new' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
  } finally {
    fx.cleanup()
  }
})
