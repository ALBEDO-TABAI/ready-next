/**
 * Stage 5 — `skill_read_artifact` accepts additional read-only roots derived
 * from the active TurnFrame. Verifies the sandbox accepts active task output
 * dirs while keeping the existing relative-path-against-artifactRoot
 * semantics, and rejects any path that escapes ALL configured roots.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { executeReadArtifact } from '../main/modules/tools/skill-primitives/read-artifact'

function makeTempDir(prefix: string): string {
  // realpath the freshly-created tmp dir so test assertions that compare
  // the resolved `absolutePath` from the handler match the canonicalized
  // result on macOS (where `/var/folders/...` is a symlink target of
  // `/private/var/folders/...`).
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
}

interface TestEnv {
  artifactRoot: string
  outsideRoot: string
  cleanup: () => void
}

function setupEnv(): TestEnv {
  const artifactRoot = makeTempDir('ready-read-artifact-primary-')
  const outsideRoot = makeTempDir('ready-read-artifact-outside-')
  // Pre-populate primary artifact root with a sample file so relative-path
  // tests work.
  writeFileSync(join(artifactRoot, 'primary.txt'), 'primary content', 'utf-8')
  return {
    artifactRoot,
    outsideRoot,
    cleanup: () => {
      rmSync(artifactRoot, { recursive: true, force: true })
      rmSync(outsideRoot, { recursive: true, force: true })
    },
  }
}

function lookupRoots(skillId: string, artifactRoot: string) {
  return (id: string) => {
    if (id !== skillId) return null
    return {
      skillId,
      artifactRoot,
      assetRoot: artifactRoot,
    }
  }
}

test('skill_read_artifact accepts absolute path under additional allowed read root', async () => {
  const env = setupEnv()
  try {
    // Active task wrote run_state.json into the OUTSIDE dir (which mimics
    // VEA writing to /Users/.../测试/4qkyxm4jppc/run_state.json).
    const runStateAbsPath = join(env.outsideRoot, 'run_state.json')
    writeFileSync(runStateAbsPath, JSON.stringify({ status: 'running', stage: 'score_batches' }), 'utf-8')

    const output = await executeReadArtifact(
      { relativePath: runStateAbsPath },
      {
        skillId: 'video-expert-analyzer',
        lookupSkillRoots: lookupRoots('video-expert-analyzer', env.artifactRoot),
        additionalAllowedReadRoots: [env.outsideRoot],
      },
    )
    const data = (output as any).data as Record<string, unknown>
    assert.equal(data.absolutePath, runStateAbsPath)
    assert.equal(typeof data.content, 'string')
    assert.match(String(data.content), /score_batches/)
  } finally {
    env.cleanup()
  }
})

test('skill_read_artifact rejects active-task abs path when additional roots are empty', async () => {
  const env = setupEnv()
  try {
    const runStateAbsPath = join(env.outsideRoot, 'run_state.json')
    writeFileSync(runStateAbsPath, '{}', 'utf-8')

    let caught: any = null
    try {
      await executeReadArtifact(
        { relativePath: runStateAbsPath },
        {
          skillId: 'video-expert-analyzer',
          lookupSkillRoots: lookupRoots('video-expert-analyzer', env.artifactRoot),
          additionalAllowedReadRoots: [],
        },
      )
    } catch (error) {
      caught = error
    }
    assert.ok(caught, 'expected ToolDomainError to be thrown')
    assert.equal(caught.name, 'ToolDomainError')
    // Error reason should be one of the sandbox path-rejection reasons.
    assert.ok(
      caught.errorKind === 'path_escape' || caught.errorKind === 'no_root_match',
      `unexpected errorKind: ${caught.errorKind}`,
    )
  } finally {
    env.cleanup()
  }
})

test('skill_read_artifact resolves relative path against primary artifactRoot first', async () => {
  const env = setupEnv()
  try {
    // primary.txt was written to artifactRoot in setup.
    // outside dir has a different file.
    writeFileSync(join(env.outsideRoot, 'primary.txt'), 'OUTSIDE content', 'utf-8')

    const output = await executeReadArtifact(
      { relativePath: 'primary.txt' },
      {
        skillId: 'video-expert-analyzer',
        lookupSkillRoots: lookupRoots('video-expert-analyzer', env.artifactRoot),
        additionalAllowedReadRoots: [env.outsideRoot],
      },
    )
    const data = (output as any).data as Record<string, unknown>
    assert.match(String(data.content), /primary content/)
    assert.doesNotMatch(String(data.content), /OUTSIDE content/)
    assert.equal(data.absolutePath, join(env.artifactRoot, 'primary.txt'))
  } finally {
    env.cleanup()
  }
})

test('skill_read_artifact returns no_root_match when path escapes every configured root', async () => {
  const env = setupEnv()
  try {
    // Create a third dir that is NOT in either the primary or extra roots.
    const trulyOutside = makeTempDir('ready-read-artifact-trulyoutside-')
    const orphanPath = join(trulyOutside, 'forbidden.txt')
    writeFileSync(orphanPath, 'should not be reachable', 'utf-8')

    let caught: any = null
    try {
      await executeReadArtifact(
        { relativePath: orphanPath },
        {
          skillId: 'video-expert-analyzer',
          lookupSkillRoots: lookupRoots('video-expert-analyzer', env.artifactRoot),
          additionalAllowedReadRoots: [env.outsideRoot],
        },
      )
    } catch (error) {
      caught = error
    } finally {
      rmSync(trulyOutside, { recursive: true, force: true })
    }
    assert.ok(caught, 'expected ToolDomainError to be thrown')
    assert.equal(caught.name, 'ToolDomainError')
    assert.equal(caught.errorKind, 'no_root_match')
    assert.ok(typeof caught.message === 'string' && caught.message.includes(orphanPath))
  } finally {
    env.cleanup()
  }
})
