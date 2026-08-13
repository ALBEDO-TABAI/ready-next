import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  executeReadArtifact,
  type ReadArtifactExactResource,
} from '../main/modules/tools/skill-primitives/read-artifact'
import type { SkillRootSet } from '../main/modules/tools/skill-primitives/root-resolver'

function exactResource(logicalPath: string, root: string, relativePath: string): ReadArtifactExactResource {
  const path = join(root, relativePath)
  const stats = statSync(path)
  return {
    logicalPath,
    root,
    relativePath,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    fileIdentity: {
      device: String(stats.dev),
      inode: String(stats.ino),
      size: stats.size,
      mode: stats.mode,
      mtimeMs: stats.mtimeMs,
    },
  }
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ready-exact-read-'))
  const assetRoot = join(root, 'lark-doc')
  const siblingRoot = join(root, 'lark-shared')
  const artifactRoot = join(root, 'output')
  mkdirSync(join(assetRoot, 'references'), { recursive: true })
  mkdirSync(siblingRoot, { recursive: true })
  mkdirSync(artifactRoot, { recursive: true })
  writeFileSync(join(assetRoot, 'SKILL.md'), 'selected-skill-marker')
  writeFileSync(join(siblingRoot, 'SKILL.md'), 'sibling-skill-marker')
  writeFileSync(join(assetRoot, 'references/lark-doc-fetch.md'), 'fetch-reference-marker')
  writeFileSync(join(artifactRoot, 'SKILL.md'), 'shadow-marker')
  const exactResources = [
    exactResource('lark-doc/SKILL.md', assetRoot, 'SKILL.md'),
    exactResource('lark-shared/SKILL.md', siblingRoot, 'SKILL.md'),
    exactResource(
      'lark-doc/references/lark-doc-fetch.md',
      assetRoot,
      'references/lark-doc-fetch.md',
    ),
  ]
  const lookupSkillRoots = (skillId: string): SkillRootSet | null => skillId === 'lark-doc'
    ? { skillId, assetRoot, artifactRoot }
    : null
  return {
    root,
    assetRoot,
    siblingRoot,
    exactResources,
    lookupSkillRoots,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('exact read aliases cannot be shadowed and never expose host paths', async () => {
  const fixture = makeFixture()
  try {
    const expected = new Map([
      ['lark-doc/SKILL.md', 'selected-skill-marker'],
      ['lark-shared/SKILL.md', 'sibling-skill-marker'],
      ['lark-doc/references/lark-doc-fetch.md', 'fetch-reference-marker'],
    ])
    for (const [resourcePath, marker] of expected) {
      const output = await executeReadArtifact(
        { relativePath: resourcePath },
        {
          skillId: 'lark-doc',
          lookupSkillRoots: fixture.lookupSkillRoots,
          exactResources: fixture.exactResources,
        },
      )
      assert.equal(output.text, marker)
      assert.equal(output.data?.resourcePath, resourcePath)
      assert.equal('absolutePath' in (output.data || {}), false)
      assert.equal(JSON.stringify(output).includes(fixture.root), false)
    }
  } finally {
    fixture.cleanup()
  }
})

test('exact read aliases reject every unlisted or path-shaped request before target IO', async () => {
  const fixture = makeFixture()
  try {
    for (const relativePath of [
      'SKILL.md',
      '../lark-shared/SKILL.md',
      'lark-shared/other.md',
      join(fixture.siblingRoot, 'SKILL.md'),
    ]) {
      await assert.rejects(
        executeReadArtifact(
          { relativePath },
          {
            skillId: 'lark-doc',
            lookupSkillRoots: fixture.lookupSkillRoots,
            exactResources: fixture.exactResources,
          },
        ),
        (error: unknown) => {
          const candidate = error as { errorKind?: string; details?: unknown }
          assert.equal(candidate.errorKind, 'resource_not_authorized')
          assert.equal(JSON.stringify(candidate.details || {}).includes(fixture.root), false)
          return true
        },
      )
    }
  } finally {
    fixture.cleanup()
  }
})

test('exact read aliases reject file replacement and symlink drift', async () => {
  const fixture = makeFixture()
  try {
    const selectedPath = join(fixture.assetRoot, 'SKILL.md')
    writeFileSync(selectedPath, 'changed-after-prepare')
    await assert.rejects(
      executeReadArtifact(
        { relativePath: 'lark-doc/SKILL.md' },
        {
          skillId: 'lark-doc',
          lookupSkillRoots: fixture.lookupSkillRoots,
          exactResources: fixture.exactResources,
        },
      ),
      (error: unknown) => (error as { errorKind?: string }).errorKind === 'dependency_identity_drift',
    )

    unlinkSync(selectedPath)
    symlinkSync(join(fixture.siblingRoot, 'SKILL.md'), selectedPath)
    assert.equal(lstatSync(selectedPath).isSymbolicLink(), true)
    await assert.rejects(
      executeReadArtifact(
        { relativePath: 'lark-doc/SKILL.md' },
        {
          skillId: 'lark-doc',
          lookupSkillRoots: fixture.lookupSkillRoots,
          exactResources: fixture.exactResources,
        },
      ),
      (error: unknown) => (error as { errorKind?: string }).errorKind === 'dependency_identity_drift',
    )
  } finally {
    fixture.cleanup()
  }
})

test('required-resource consumption is recorded only after the complete pinned file is read', async () => {
  const fixture = makeFixture()
  try {
    const consumed: string[] = []
    await executeReadArtifact(
      { relativePath: 'lark-doc/SKILL.md', maxBytes: 1 },
      {
        skillId: 'lark-doc',
        lookupSkillRoots: fixture.lookupSkillRoots,
        exactResources: fixture.exactResources,
        onExactResourceRead: (logicalPath) => consumed.push(logicalPath),
      },
    )
    assert.deepEqual(consumed, [])

    await executeReadArtifact(
      { relativePath: 'lark-doc/SKILL.md' },
      {
        skillId: 'lark-doc',
        lookupSkillRoots: fixture.lookupSkillRoots,
        exactResources: fixture.exactResources,
        onExactResourceRead: (logicalPath) => consumed.push(logicalPath),
      },
    )
    assert.deepEqual(consumed, ['lark-doc/SKILL.md'])
  } finally {
    fixture.cleanup()
  }
})
