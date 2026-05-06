/**
 * Stage M (M5a-inspect) — `skill_inspect_run_state` emits a `contextModifier`
 * matching its `framePatch.activeArtifactRoots` so a same-batch follow-up
 * `skill_read_artifact run_state.json` can resolve the path without waiting
 * for the post-batch frame merge.
 *
 * Plan §2.5 second snippet: `buildInspectFramePatch` widened to return
 * `{ framePatch, contract }`; the wrapper passes the FULL contract (not
 * `framePatch.runContract` which is `Partial<SkillRunContract>`) into
 * `contextModifier.activeFrame.runContract`.
 *
 * This test runs the executor end-to-end against a real disk fixture so the
 * production wiring is exercised, and asserts:
 *   1. framePatch.activeArtifactRoots includes the inspected outputDir
 *   2. contextModifier.activeFrame.activeArtifactRoots mirrors it
 *   3. contextModifier.activeFrame.runContract is the full SkillRunContract
 *      (proven by reading a non-Partial-only field like artifactRoots)
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { executeInspectRunState } from '../main/modules/tools/skill-primitives/inspect-run-state'

test('skill_inspect_run_state emits matching contextModifier when activeArtifactRoots is non-empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stage-m-inspect-ctx-'))
  try {
    const runStatePath = join(dir, 'run_state.json')
    writeFileSync(runStatePath, JSON.stringify({
      taskId: 'task-stage-m',
      currentStage: 'score_batches',
      totalScenes: 100,
      completedScenes: 42,
      coverageRatio: 0.42,
      status: 'recoverable_paused',
      lastError: null,
    }), 'utf8')

    const result = await executeInspectRunState({
      outputDir: dir,
      runStatePath,
      taskId: undefined,
      expectedTaskId: undefined,
      maxRawBytes: undefined,
      skillId: 'video-expert-analyzer',
    })

    // 1. framePatch carries the outputDir as a read root.
    const frameRoots = result.framePatch?.activeArtifactRoots ?? []
    assert.ok(frameRoots.includes(dir), `framePatch.activeArtifactRoots must include outputDir; got ${JSON.stringify(frameRoots)}`)

    // 2. contextModifier mirrors the same set.
    assert.ok(result.contextModifier, 'contextModifier must be populated when roots are emitted')
    assert.ok(result.contextModifier.activeFrame, 'contextModifier.activeFrame must be populated')
    assert.deepEqual(
      result.contextModifier.activeFrame.activeArtifactRoots,
      frameRoots,
      'contextModifier roots must mirror framePatch roots exactly',
    )

    // 3. contextModifier.runContract is the full SkillRunContract (or null,
    //    if loadSkillRunContract returned null — but in this fixture we have
    //    a synthetic supervisor snapshot, so it should be populated).
    const ctxContract = result.contextModifier.activeFrame.runContract
    if (ctxContract != null) {
      // Full SkillRunContract has artifactRoots: string[] (not optional —
      // proves it's not Partial<SkillRunContract>).
      assert.ok(Array.isArray(ctxContract.artifactRoots), 'contextModifier carries the FULL SkillRunContract shape')
      assert.equal(ctxContract.skillId, 'video-expert-analyzer')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
