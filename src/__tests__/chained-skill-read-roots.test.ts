import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { executeReadArtifact } from '../main/modules/tools/skill-primitives/read-artifact'
import { executeWriteArtifact } from '../main/modules/tools/skill-primitives/write-artifact'
import { collectSkillReadArtifactRoots } from '../main/modules/agent-control/tools-runtime/tool-runtime'
import { resolvePendingSkillHandoffWriteTargets } from '../main/modules/agent-control/skills/skill-agent-handoff'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('chained-skill-read-roots declares transitive sqlite coverage', (t) => {
  skipIfSqliteUnavailable(t, 'chained-skill-read-roots transitive sqlite guard')
})

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ready-xread-')))
  const outputsRoot = join(root, 'outputs')
  const selectedAsset = join(root, 'skills', 'selected')
  const selectedArtifact = join(outputsRoot, 'selected')
  const siblingAsset = join(root, 'skills', 'sibling')
  const siblingOutput = join(outputsRoot, 'sibling')
  const external = join(root, 'external')
  for (const dir of [selectedAsset, selectedArtifact, siblingAsset, siblingOutput, external]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(join(siblingAsset, 'references.md'), 'sibling reference', 'utf8')
  writeFileSync(join(siblingOutput, 'prior.md'), 'prior output', 'utf8')
  writeFileSync(join(external, 'private.md'), 'outside', 'utf8')
  return {
    root,
    outputsRoot,
    selectedAsset,
    selectedArtifact,
    siblingAsset,
    siblingOutput,
    external,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function lookup(selectedAsset: string, selectedArtifact: string) {
  return (skillId: string) => skillId === 'selected'
    ? { skillId, assetRoot: selectedAsset, artifactRoot: selectedArtifact }
    : null
}

test('selected skill reads sibling asset and sibling output with observable root kinds', async () => {
  const env = fixture()
  try {
    const kinds = {
      [env.siblingAsset]: 'sibling_asset',
      [env.siblingOutput]: 'sibling_output',
    } as const
    const asset = await executeReadArtifact({ relativePath: join(env.siblingAsset, 'references.md') }, {
      skillId: 'selected',
      lookupSkillRoots: lookup(env.selectedAsset, env.selectedArtifact),
      additionalAllowedReadRoots: [env.siblingAsset, env.siblingOutput],
      additionalAllowedReadRootKinds: kinds,
    })
    assert.equal(asset.data?.matchedRootKind, 'sibling_asset')
    assert.match(String(asset.data?.content), /sibling reference/)

    const output = await executeReadArtifact({ relativePath: join(env.siblingOutput, 'prior.md') }, {
      skillId: 'selected',
      lookupSkillRoots: lookup(env.selectedAsset, env.selectedArtifact),
      additionalAllowedReadRoots: [env.siblingAsset, env.siblingOutput],
      additionalAllowedReadRootKinds: kinds,
    })
    assert.equal(output.data?.matchedRootKind, 'sibling_output')
    assert.match(String(output.data?.content), /prior output/)
  } finally {
    env.cleanup()
  }
})

test('collectSkillReadArtifactRoots unions artifact + read-only roots, deduped and order-preserving', () => {
  assert.deepEqual(
    collectSkillReadArtifactRoots({ activeArtifactRoots: ['/a', '/b'], activeReadOnlyRoots: ['/b', '/c'] }),
    ['/a', '/b', '/c'],
  )
  assert.deepEqual(collectSkillReadArtifactRoots(null), [])
  assert.deepEqual(collectSkillReadArtifactRoots({ activeArtifactRoots: ['/a'] }), ['/a'])
})

// R-XREAD leak fence: a seeded sibling root that holds a pending audiovisual
// handoff receipt must be READABLE yet never become a writable handoff target.
// Regression for the write-path leak where chained read roots were seeded into
// the shared `activeArtifactRoots` that the handoff-target resolver consumes.
test('R-XREAD read-only roots stay out of the handoff write-target path', () => {
  const env = fixture()
  try {
    mkdirSync(join(env.siblingOutput, 'audiovisual_handoff'), { recursive: true })
    writeFileSync(
      join(env.siblingOutput, 'audiovisual_handoff', 'receipt.json'),
      JSON.stringify({ tasks: { clip1: { status: 'pending', output: 'clip1.mp4' } } }),
      'utf8',
    )
    // Chained read roots land in the read-only channel, never activeArtifactRoots.
    const frame = { activeArtifactRoots: [] as string[], activeReadOnlyRoots: [env.siblingOutput] }
    // Positive control: the receipt is valid + pending — it WOULD grant a target
    // if the sibling root were write-eligible.
    assert.equal(resolvePendingSkillHandoffWriteTargets([env.siblingOutput]).length, 1)
    // Fence: the production write path feeds activeArtifactRoots only → no target.
    assert.deepEqual(resolvePendingSkillHandoffWriteTargets(frame.activeArtifactRoots), [])
    // Read face still sees the sibling output (readable).
    assert.ok(collectSkillReadArtifactRoots(frame).includes(env.siblingOutput))
  } finally {
    env.cleanup()
  }
})

test('sibling roots are read-only and symlinks remain rejected', async () => {
  const env = fixture()
  try {
    await assert.rejects(
      executeWriteArtifact({ relativePath: join(env.siblingOutput, 'forbidden.md'), content: 'no' }, {
        skillId: 'selected',
        lookupSkillRoots: lookup(env.selectedAsset, env.selectedArtifact),
      }),
      (error: unknown) => Boolean(error && typeof error === 'object' && ['absolute_path', 'path_escape'].includes(String((error as { errorKind?: string }).errorKind))),
    )
    symlinkSync(join(env.siblingAsset, 'references.md'), join(env.siblingAsset, 'link.md'))
    await assert.rejects(
      executeReadArtifact({ relativePath: join(env.siblingAsset, 'link.md') }, {
        skillId: 'selected',
        lookupSkillRoots: lookup(env.selectedAsset, env.selectedArtifact),
        additionalAllowedReadRoots: [env.siblingAsset],
        additionalAllowedReadRootKinds: { [env.siblingAsset]: 'sibling_asset' },
      }),
      (error: unknown) => Boolean(error && typeof error === 'object' && (error as { errorKind?: string }).errorKind === 'symlink_rejected'),
    )
  } finally {
    env.cleanup()
  }
})
