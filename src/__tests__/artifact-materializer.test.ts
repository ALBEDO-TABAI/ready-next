import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  ArtifactMaterializer,
  ArtifactMaterializerError,
  type ArtifactDirectoryIdentity,
} from '../main/modules/tools/artifact-materializer'
import { executeSkillTool } from '../main/modules/tools/skills-tools'

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function destination(path: string, logicalResourceId = 'folder:one'): ArtifactDirectoryIdentity {
  const metadata = statSync(path)
  return {
    logicalResourceId,
    path,
    device: String(metadata.dev),
    inode: String(metadata.ino),
    mode: metadata.mode,
    policyEpoch: 1,
  }
}

test('materializer composes immutable expectedVersion segments and replays an action once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-materializer-'))
  try {
    const materializer = new ArtifactMaterializer(join(root, 'staging'))
    const first = await materializer.write({
      readyRunId: 'run-1', itemId: 'report.md', actionId: 'call-1',
      expectedVersion: 'empty', mode: 'replace', content: 'first',
    })
    const second = await materializer.write({
      readyRunId: 'run-1', itemId: 'report.md', actionId: 'call-2',
      expectedVersion: first.version, mode: 'append', content: ' second',
    })
    assert.equal(materializer.readVersion({
      readyRunId: 'run-1', itemId: 'report.md', version: second.version,
    }).toString(), 'first second')
    assert.equal(second.logicalBytes, Buffer.byteLength('first second'))
    assert.equal(second.logicalSha256, digest('first second'))
    assert.deepEqual(await materializer.write({
      readyRunId: 'run-1', itemId: 'report.md', actionId: 'call-2',
      expectedVersion: first.version, mode: 'append', content: ' second',
    }), second)
    await assert.rejects(
      materializer.write({
        readyRunId: 'run-1', itemId: 'report.md', actionId: 'call-2',
        expectedVersion: first.version, mode: 'append', content: ' changed',
      }),
      (error: unknown) => error instanceof ArtifactMaterializerError
        && error.code === 'artifact_action_replay_conflict',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('steady append does not reread old segments and bounded reads do not load the full artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-materializer-'))
  try {
    const base = join(root, 'staging')
    const materializer = new ArtifactMaterializer(base)
    const first = await materializer.write({
      readyRunId: 'run-fast', itemId: 'report.md', actionId: 'call-1',
      expectedVersion: null, mode: 'replace', content: 'first',
    })
    const firstSegment = join(
      base,
      'runs', digest('run-fast'), 'items', digest('report.md'), 'segments', `${first.segmentSha256}.bin`,
    )
    unlinkSync(firstSegment)
    const second = await materializer.write({
      readyRunId: 'run-fast', itemId: 'report.md', actionId: 'call-2',
      expectedVersion: first.version, mode: 'append', content: ' second',
    })
    assert.equal(second.logicalSha256, digest('first second'))
    assert.throws(() => materializer.readVersionPrefix({
      readyRunId: 'run-fast', itemId: 'report.md', version: second.version, maxBytes: 3,
    }))

    const intact = await materializer.write({
      readyRunId: 'run-prefix', itemId: 'large.md', actionId: 'prefix-1',
      expectedVersion: null, mode: 'replace', content: 'abcdef',
    })
    const prefix = materializer.readVersionPrefix({
      readyRunId: 'run-prefix', itemId: 'large.md', version: intact.version, maxBytes: 3,
    })
    assert.equal(prefix.content.toString(), 'abc')
    assert.equal(prefix.logicalBytes, 6)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('materializer survives process recreation and copy-on-write never writes predecessor root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-materializer-'))
  try {
    const base = join(root, 'staging')
    const firstProcess = new ArtifactMaterializer(base)
    const source = await firstProcess.write({
      readyRunId: 'run-old', itemId: 'report.md', actionId: 'old-call',
      expectedVersion: null, mode: 'replace', content: 'preserved',
    })
    const secondProcess = new ArtifactMaterializer(base)
    assert.equal(secondProcess.readVersion({
      readyRunId: 'run-old', itemId: 'report.md', version: source.version,
    }).toString(), 'preserved')
    const copied = await secondProcess.copyOnWrite({
      sourceReadyRunId: 'run-old', sourceItemId: 'report.md', sourceVersion: source.version,
      targetReadyRunId: 'run-new', targetItemId: 'report.md', actionId: 'retry-cow',
    })
    const appended = await secondProcess.write({
      readyRunId: 'run-new', itemId: 'report.md', actionId: 'new-call',
      expectedVersion: copied.version, mode: 'append', content: ' plus',
    })
    assert.equal(secondProcess.readVersion({
      readyRunId: 'run-old', itemId: 'report.md', version: source.version,
    }).toString(), 'preserved')
    assert.equal(secondProcess.readVersion({
      readyRunId: 'run-new', itemId: 'report.md', version: appended.version,
    }).toString(), 'preserved plus')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('export is create-only, hash verified, idempotent, and refuses conflicts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-materializer-'))
  try {
    const targetRoot = join(root, 'target')
    mkdirSync(targetRoot)
    const materializer = new ArtifactMaterializer(join(root, 'staging'))
    const staged = await materializer.write({
      readyRunId: 'run-1', itemId: 'report.md', actionId: 'write-call',
      expectedVersion: null, mode: 'replace', content: 'verified bytes',
    })
    const receipt = await materializer.exportVersion({
      actionReadyRunId: 'run-1', sourceReadyRunId: 'run-1', itemId: 'report.md', actionId: 'export-call',
      version: staged.version, expectedSha256: staged.logicalSha256,
      destination: destination(targetRoot), targetRelativePath: 'nested/report.md',
    })
    assert.equal(receipt.result, 'created')
    assert.equal(receipt.readbackVerified, true)
    assert.equal(readFileSync(join(targetRoot, 'nested/report.md'), 'utf8'), 'verified bytes')
    assert.deepEqual(await materializer.exportVersion({
      actionReadyRunId: 'run-1', sourceReadyRunId: 'run-1', itemId: 'report.md', actionId: 'export-call',
      version: staged.version, expectedSha256: staged.logicalSha256,
      destination: destination(targetRoot), targetRelativePath: 'nested/report.md',
    }), receipt)

    writeFileSync(join(targetRoot, 'conflict.md'), 'external')
    await assert.rejects(
      materializer.exportVersion({
        actionReadyRunId: 'run-1', sourceReadyRunId: 'run-1', itemId: 'report.md', actionId: 'export-conflict',
        version: staged.version, expectedSha256: staged.logicalSha256,
        destination: destination(targetRoot), targetRelativePath: 'conflict.md',
      }),
      (error: unknown) => error instanceof ArtifactMaterializerError
        && error.code === 'artifact_target_conflict',
    )
    assert.equal(readFileSync(join(targetRoot, 'conflict.md'), 'utf8'), 'external')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a retry exports its frozen predecessor version without taking ownership of the staged bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-materializer-'))
  try {
    const targetRoot = join(root, 'target')
    mkdirSync(targetRoot)
    const materializer = new ArtifactMaterializer(join(root, 'staging'))
    const staged = await materializer.write({
      readyRunId: 'run-original', itemId: 'report.md', actionId: 'write-original',
      expectedVersion: null, mode: 'replace', content: 'preserved predecessor bytes',
    })
    const exported = await materializer.exportVersion({
      actionReadyRunId: 'run-retry',
      sourceReadyRunId: 'run-original',
      itemId: 'report.md',
      actionId: 'export-retry',
      version: staged.version,
      expectedSha256: staged.logicalSha256,
      destination: destination(targetRoot),
      targetRelativePath: 'report.md',
    })

    assert.equal(exported.logicalArtifactRef, staged.logicalArtifactRef)
    assert.equal(readFileSync(join(targetRoot, 'report.md'), 'utf8'), 'preserved predecessor bytes')
    assert.throws(
      () => materializer.readVersion({
        readyRunId: 'run-retry', itemId: 'report.md', version: staged.version,
      }),
      /ENOENT/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the Codex export primitive directly delivers a frozen predecessor version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-materializer-'))
  try {
    const targetRoot = join(root, 'target')
    mkdirSync(targetRoot)
    const materializer = new ArtifactMaterializer(join(root, 'staging'))
    const staged = await materializer.write({
      readyRunId: 'run-original', itemId: 'report.md', actionId: 'write-original',
      expectedVersion: null, mode: 'replace', content: 'direct predecessor export',
    })
    const target = destination(targetRoot)
    await executeSkillTool(
      'skill_export_artifact',
      {
        relativePath: 'report.md',
        targetRelativePath: 'report.md',
        destinationResourceId: target.logicalResourceId,
        expectedVersion: staged.version,
        expectedSha256: staged.logicalSha256,
      },
      'scope-retry',
      undefined,
      undefined,
      null,
      {
        scopeId: 'scope-retry',
        runId: 'run-retry',
        authorization: {
          mode: 'selected',
          skillId: 'artifact-test',
          allowedTypedActions: [],
          allowedPrimitives: ['skill_export_artifact'],
        },
        codexHostPrimitiveOnly: true,
        artifactMaterializer: materializer,
        readArtifactWriteHead: () => null,
        codexExecutionIdentity: {
          readyActionId: 'export-retry',
          actionIdentityDigest: 'export-retry-digest',
        },
        requestEnvelope: {
          outputContract: {
            destination: {
              logicalResourceId: target.logicalResourceId,
              path: target.path,
              directoryIdentity: {
                device: target.device,
                inode: target.inode,
                mode: target.mode,
              },
              policyEpoch: target.policyEpoch,
            },
          },
          folderOutputActivation: {
            kind: 'positive',
            destinationResourceId: target.logicalResourceId,
            expectedOutputs: ['report.md'],
          },
          retryArtifactSources: [{
            sourceReadyRunId: 'run-original',
            relativePath: 'report.md',
            logicalArtifactRef: staged.logicalArtifactRef,
            version: staged.version,
            sha256: staged.logicalSha256,
          }],
        },
      } as never,
    )
    assert.equal(readFileSync(join(targetRoot, 'report.md'), 'utf8'), 'direct predecessor export')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// 2026-10-06: the user confirmed overwriting the document they asked to edit, and the export still refused it.
test('the Codex export primitive replaces an existing file only on a confirmed overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-materializer-'))
  try {
    const targetRoot = join(root, 'target')
    mkdirSync(targetRoot)
    const original = join(targetRoot, '阅读回顾.md')
    writeFileSync(original, '# 原文\n', { mode: 0o644 })
    const materializer = new ArtifactMaterializer(join(root, 'staging'))
    const staged = await materializer.write({
      readyRunId: 'run-edit', itemId: '阅读回顾.md', actionId: 'write-edit',
      expectedVersion: null, mode: 'replace', content: '# 原文\n\n> 信息卡\n',
    })
    const target = destination(targetRoot)
    const exportOnce = (actionId: string, overwrite?: boolean) => executeSkillTool(
      'skill_export_artifact',
      {
        relativePath: '阅读回顾.md',
        targetRelativePath: '阅读回顾.md',
        destinationResourceId: target.logicalResourceId,
        expectedVersion: staged.version,
        expectedSha256: staged.logicalSha256,
        ...(overwrite === undefined ? {} : { overwrite }),
      },
      'scope-edit', undefined, undefined, null,
      {
        scopeId: 'scope-edit',
        runId: 'run-edit',
        authorization: {
          mode: 'selected', skillId: 'artifact-test', allowedTypedActions: [], allowedPrimitives: ['skill_export_artifact'],
        },
        codexHostPrimitiveOnly: true,
        artifactMaterializer: materializer,
        readArtifactWriteHead: () => ({ version: staged.version, logicalSha256: staged.logicalSha256 }),
        codexExecutionIdentity: { readyActionId: actionId, actionIdentityDigest: `${actionId}-digest` },
        requestEnvelope: {
          outputContract: {
            destination: {
              logicalResourceId: target.logicalResourceId,
              path: target.path,
              directoryIdentity: { device: target.device, inode: target.inode, mode: target.mode },
              policyEpoch: target.policyEpoch,
            },
          },
          folderOutputActivation: {
            kind: 'positive', destinationResourceId: target.logicalResourceId, expectedOutputs: ['阅读回顾.md'],
          },
        },
      } as never,
    )
    for (const [actionId, overwrite] of [['export-plain', undefined], ['export-declined', false]] as const) {
      await assert.rejects(exportOnce(actionId, overwrite), (error: unknown) => (
        error instanceof ArtifactMaterializerError && error.code === 'artifact_target_conflict'
      ), actionId)
      assert.equal(readFileSync(original, 'utf8'), '# 原文\n', `${actionId} keeps the file`)
    }
    const replaced = await exportOnce('export-confirmed', true)
    assert.equal((replaced.data as { result?: string }).result, 'replaced')
    assert.equal(readFileSync(original, 'utf8'), '# 原文\n\n> 信息卡\n')
    assert.equal(statSync(original).mode & 0o777, 0o644, 'the replaced file keeps its permissions')
    assert.deepEqual((await exportOnce('export-confirmed', true)).data, replaced.data, 'the confirmed action replays once')
    symlinkSync(original, join(targetRoot, 'link.md'))
    await assert.rejects(materializer.exportVersion({
      actionReadyRunId: 'run-edit', sourceReadyRunId: 'run-edit', itemId: '阅读回顾.md', actionId: 'export-link',
      version: staged.version, expectedSha256: staged.logicalSha256, destination: target,
      targetRelativePath: 'link.md', replaceExisting: true,
    }), (error: unknown) => error instanceof ArtifactMaterializerError && error.code === 'artifact_target_conflict')
    assert.equal(lstatSync(join(targetRoot, 'link.md')).isSymbolicLink(), true, 'a confirmed overwrite never replaces a link')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('same-hash target is accepted without rewrite and destination drift or symlinks are refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-materializer-'))
  try {
    const targetRoot = join(root, 'target')
    mkdirSync(targetRoot)
    const materializer = new ArtifactMaterializer(join(root, 'staging'))
    const staged = await materializer.write({
      readyRunId: 'run-1', itemId: 'report.md', actionId: 'write-call',
      expectedVersion: null, mode: 'replace', content: 'same',
    })
    const samePath = join(targetRoot, 'same.md')
    writeFileSync(samePath, 'same')
    const before = lstatSync(samePath)
    const same = await materializer.exportVersion({
      actionReadyRunId: 'run-1', sourceReadyRunId: 'run-1', itemId: 'report.md', actionId: 'same-call',
      version: staged.version, expectedSha256: staged.logicalSha256,
      destination: destination(targetRoot), targetRelativePath: 'same.md',
    })
    assert.equal(same.result, 'same_hash_idempotent')
    assert.equal(lstatSync(samePath).ino, before.ino)

    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(targetRoot, 'link'))
    await assert.rejects(
      materializer.exportVersion({
        actionReadyRunId: 'run-1', sourceReadyRunId: 'run-1', itemId: 'report.md', actionId: 'link-call',
        version: staged.version, expectedSha256: staged.logicalSha256,
        destination: destination(targetRoot), targetRelativePath: 'link/escape.md',
      }),
      /artifact_target_parent_invalid/,
    )

    const drifted = destination(targetRoot)
    await assert.rejects(
      materializer.exportVersion({
        actionReadyRunId: 'run-1', sourceReadyRunId: 'run-1', itemId: 'report.md', actionId: 'drift-call',
        version: staged.version, expectedSha256: staged.logicalSha256,
        destination: { ...drifted, inode: 'wrong' }, targetRelativePath: 'drift.md',
      }),
      /artifact_destination_identity_mismatch/,
    )

    const linkedRoot = join(root, 'linked-target')
    symlinkSync(targetRoot, linkedRoot)
    await assert.rejects(
      materializer.exportVersion({
        actionReadyRunId: 'run-1', sourceReadyRunId: 'run-1', itemId: 'report.md', actionId: 'linked-root-call',
        version: staged.version, expectedSha256: staged.logicalSha256,
        destination: { ...destination(targetRoot), path: linkedRoot }, targetRelativePath: 'linked.md',
      }),
      /artifact_destination_identity_mismatch/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('two no-replace exporters cannot overwrite a last-moment external winner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-materializer-'))
  try {
    const targetRoot = join(root, 'target')
    mkdirSync(targetRoot)
    const materializer = new ArtifactMaterializer(join(root, 'staging'))
    const left = await materializer.write({
      readyRunId: 'run-1', itemId: 'left', actionId: 'write-left',
      expectedVersion: null, mode: 'replace', content: 'left',
    })
    const right = await materializer.write({
      readyRunId: 'run-2', itemId: 'right', actionId: 'write-right',
      expectedVersion: null, mode: 'replace', content: 'right',
    })
    const outcomes = await Promise.allSettled([
      materializer.exportVersion({
        actionReadyRunId: 'run-1', sourceReadyRunId: 'run-1', itemId: 'left', actionId: 'export-left', version: left.version,
        expectedSha256: left.logicalSha256, destination: destination(targetRoot),
        targetRelativePath: 'winner.md',
      }),
      materializer.exportVersion({
        actionReadyRunId: 'run-2', sourceReadyRunId: 'run-2', itemId: 'right', actionId: 'export-right', version: right.version,
        expectedSha256: right.logicalSha256, destination: destination(targetRoot),
        targetRelativePath: 'winner.md',
      }),
    ])
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1)
    assert.ok(['left', 'right'].includes(readFileSync(join(targetRoot, 'winner.md'), 'utf8')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a document above one inline call survives segmented restart read and exports once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-materializer-'))
  try {
    const base = join(root, 'staging')
    const targetRoot = join(root, 'target')
    mkdirSync(targetRoot)
    const firstChunk = '甲'.repeat(320_000)
    const secondChunk = '乙'.repeat(320_000)
    const expected = `${firstChunk}${secondChunk}`
    const firstProcess = new ArtifactMaterializer(base)
    const first = await firstProcess.write({
      readyRunId: 'run-large', itemId: 'large.md', actionId: 'large-1',
      expectedVersion: null, mode: 'replace', content: firstChunk,
    })
    const second = await firstProcess.write({
      readyRunId: 'run-large', itemId: 'large.md', actionId: 'large-2',
      expectedVersion: first.version, mode: 'append', content: secondChunk,
    })
    const restarted = new ArtifactMaterializer(base)
    const streamed: Buffer[] = []
    const streamReceipt = restarted.streamVersion({
      readyRunId: 'run-large', itemId: 'large.md', version: second.version,
    }, (chunk) => streamed.push(chunk))
    assert.equal(Buffer.concat(streamed).toString('utf8'), expected)
    assert.equal(streamReceipt.sha256, digest(expected))
    assert.ok(streamReceipt.bytes > 1_000_000)
    const exported = await restarted.exportVersion({
      actionReadyRunId: 'run-large', sourceReadyRunId: 'run-large', itemId: 'large.md', actionId: 'large-export',
      version: second.version, expectedSha256: streamReceipt.sha256,
      destination: destination(targetRoot), targetRelativePath: 'large.md',
    })
    assert.equal(exported.result, 'created')
    assert.equal(digest(readFileSync(join(targetRoot, 'large.md'))), streamReceipt.sha256)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('storage pressure removes only host-approved unreferenced runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-materializer-'))
  try {
    const base = join(root, 'staging')
    let retention = { protectedRunIds: [] as string[], collectibleRunIds: [] as string[] }
    const materializer = new ArtifactMaterializer(base, {
      maxStorageBytes: 5_000,
      readStorageRetention: () => retention,
    })
    const old = await materializer.write({
      readyRunId: 'run-verified', itemId: 'report.md', actionId: 'write-old',
      expectedVersion: null, mode: 'replace', content: 'a'.repeat(2_000),
    })
    retention = { protectedRunIds: [], collectibleRunIds: ['run-verified'] }
    const fresh = await materializer.write({
      readyRunId: 'run-fresh', itemId: 'report.md', actionId: 'write-fresh',
      expectedVersion: null, mode: 'replace', content: 'b'.repeat(2_000),
    })
    assert.equal(materializer.readVersion({
      readyRunId: 'run-fresh', itemId: 'report.md', version: fresh.version,
    }).toString(), 'b'.repeat(2_000))
    assert.throws(() => materializer.readVersion({
      readyRunId: 'run-verified', itemId: 'report.md', version: old.version,
    }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('storage pressure preserves retryable predecessor sources and fails explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-materializer-'))
  try {
    const base = join(root, 'staging')
    const materializer = new ArtifactMaterializer(base, {
      maxStorageBytes: 5_000,
      readStorageRetention: () => ({
        protectedRunIds: ['run-predecessor'],
        collectibleRunIds: ['run-predecessor'],
      }),
    })
    const predecessor = await materializer.write({
      readyRunId: 'run-predecessor', itemId: 'report.md', actionId: 'write-old',
      expectedVersion: null, mode: 'replace', content: 'a'.repeat(2_000),
    })
    await assert.rejects(materializer.write({
      readyRunId: 'run-retry', itemId: 'report.md', actionId: 'write-retry',
      expectedVersion: null, mode: 'replace', content: 'b'.repeat(2_000),
    }), (error: unknown) => error instanceof ArtifactMaterializerError
      && error.code === 'artifact_storage_budget_exhausted')
    assert.equal(materializer.readVersion({
      readyRunId: 'run-predecessor', itemId: 'report.md', version: predecessor.version,
    }).toString(), 'a'.repeat(2_000))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
