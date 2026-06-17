/**
 * B Phase 1 PR1 — read-artifact handler tests.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { executeReadArtifact } from '../main/modules/tools/skill-primitives/read-artifact'
import type { SkillRootSet } from '../main/modules/tools/skill-primitives/root-resolver'

function makeFixture() {
  const artifactRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'skill-prim-read-')))
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

test('reads a plain text artifact under the sandbox root', async () => {
  const fx = makeFixture()
  try {
    writeFileSync(join(fx.artifactRoot, 'report.md'), '# report\nbody', 'utf-8')
    const out = await executeReadArtifact(
      { relativePath: 'report.md' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    assert.equal(out.text, '# report\nbody')
    assert.equal((out.data as any)?.truncated, false)
    assert.equal((out.data as any)?.totalBytes, 13)
  } finally {
    fx.cleanup()
  }
})

test('reads an absolute artifact path when it is still under the sandbox root', async () => {
  const fx = makeFixture()
  try {
    const absolutePath = join(fx.artifactRoot, '.logs', 'shell-output.txt')
    mkdirSync(join(fx.artifactRoot, '.logs'), { recursive: true })
    writeFileSync(absolutePath, 'full log', 'utf-8')

    const out = await executeReadArtifact(
      { relativePath: absolutePath },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )

    assert.equal(out.text, 'full log')
    assert.equal((out.data as any)?.truncated, false)
  } finally {
    fx.cleanup()
  }
})

test('reads bundled skill assets from the read-only asset root', async () => {
  const fx = makeFixture()
  try {
    mkdirSync(join(fx.assetRoot, 'references'), { recursive: true })
    writeFileSync(join(fx.assetRoot, 'references', 'okf-spec.md'), '# OKF spec', 'utf-8')

    const out = await executeReadArtifact(
      { relativePath: 'references/okf-spec.md' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )

    assert.equal(out.text, '# OKF spec')
    assert.equal((out.data as any)?.absolutePath, join(fx.assetRoot, 'references', 'okf-spec.md'))
  } finally {
    fx.cleanup()
  }
})

test('keeps artifactRoot precedence over bundled skill assets for relative reads', async () => {
  const fx = makeFixture()
  try {
    writeFileSync(join(fx.artifactRoot, 'report.md'), 'artifact report', 'utf-8')
    writeFileSync(join(fx.assetRoot, 'report.md'), 'asset report', 'utf-8')

    const out = await executeReadArtifact(
      { relativePath: 'report.md' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )

    assert.equal(out.text, 'artifact report')
    assert.equal((out.data as any)?.absolutePath, join(fx.artifactRoot, 'report.md'))
  } finally {
    fx.cleanup()
  }
})

test('honors maxBytes and marks truncated=true when the file is larger', async () => {
  const fx = makeFixture()
  try {
    const big = 'x'.repeat(100)
    writeFileSync(join(fx.artifactRoot, 'big.txt'), big, 'utf-8')
    const out = await executeReadArtifact(
      { relativePath: 'big.txt', maxBytes: 10 },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    assert.equal(out.text.length, 10)
    assert.equal((out.data as any)?.truncated, true)
    assert.equal((out.data as any)?.totalBytes, 100)
    assert.equal((out.data as any)?.bytesRead, 10)
  } finally {
    fx.cleanup()
  }
})

test('surfaces not_found for a missing file', async () => {
  const fx = makeFixture()
  try {
    await assert.rejects(
      executeReadArtifact(
        { relativePath: 'missing.txt' },
        { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
      ),
      (error: unknown) => (error as { errorKind?: string })?.errorKind === 'not_found',
    )
  } finally {
    fx.cleanup()
  }
})

test('surfaces not_a_file when path is a directory', async () => {
  const fx = makeFixture()
  try {
    mkdirSync(join(fx.artifactRoot, 'subdir'), { recursive: true })
    await assert.rejects(
      executeReadArtifact(
        { relativePath: 'subdir' },
        { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
      ),
      (error: unknown) => (error as { errorKind?: string })?.errorKind === 'not_a_file',
    )
  } finally {
    fx.cleanup()
  }
})

test('refuses path escapes across every configured read root', async () => {
  const fx = makeFixture()
  try {
    await assert.rejects(
      executeReadArtifact(
        { relativePath: '../../etc/passwd' },
        { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
      ),
      (error: unknown) => {
        const kind = (error as { errorKind?: string })?.errorKind
        return kind === 'path_escape' || kind === 'no_root_match'
      },
    )
  } finally {
    fx.cleanup()
  }
})

test('rejects unknown skillId with missing_skill errorKind', async () => {
  const fx = makeFixture()
  try {
    await assert.rejects(
      executeReadArtifact(
        { relativePath: 'x.txt' },
        { skillId: 'no-such-skill', lookupSkillRoots: fx.lookup },
      ),
      (error: unknown) => (error as { errorKind?: string })?.errorKind === 'missing_skill',
    )
  } finally {
    fx.cleanup()
  }
})
