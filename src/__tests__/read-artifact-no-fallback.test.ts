/**
 * Stage M (M4+M5) — `skill_read_artifact` cold-session regression.
 *
 * After M0a seeded `frame.activeArtifactRoots` from `ActiveSkillContext`,
 * a session that *would* have worked via the legacy fallback (because
 * resolveActiveSkillContext returned a known outputDir) must continue to
 * work via the frame's seeded roots.
 *
 * This test pins the `additionalAllowedReadRoots` plumbing: when the caller
 * passes the seeded roots (mirroring what the dispatcher does in
 * skills-tools.ts:1697+), `executeReadArtifact` resolves a relative path
 * inside that root.
 *
 * The empty-session counterpart lives in `read-artifact-no-fallback-empty.test.ts`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { executeReadArtifact } from '../main/modules/tools/skill-primitives/read-artifact'

test('read-artifact via seeded frame roots: succeeds without consulting legacy active-context fallback', async () => {
  // Two real directories: an unrelated per-skill artifactRoot, and a
  // separate "frame-known" outputDir that the seeded roots point at.
  const skillRoot = mkdtempSync(join(tmpdir(), 'stage-m-skill-root-'))
  const frameRoot = mkdtempSync(join(tmpdir(), 'stage-m-frame-root-'))
  try {
    const runStatePath = join(frameRoot, 'run_state.json')
    writeFileSync(runStatePath, JSON.stringify({ ok: true }), 'utf8')

    // The dispatcher in skills-tools.ts now passes `additionalAllowedReadRoots`
    // sourced ONLY from runtimeContext.activeFrame.activeArtifactRoots (no
    // active-context fallback). Simulate the seeded roots that M0a's
    // resolver would put on the frame: an absolute path to the run_state's
    // directory.
    const result = await executeReadArtifact(
      { relativePath: runStatePath },
      {
        skillId: 'video-expert-analyzer',
        lookupSkillRoots: () => ({
          artifactRoot: skillRoot,
          managedPath: skillRoot,
          configRoot: null,
          packageRoot: null,
        }),
        additionalAllowedReadRoots: [frameRoot],
      },
    )
    assert.ok(result.text.length > 0, 'read result must include text')
    assert.ok(result.shape !== 'error', 'no domain error for a frame-known path')
  } finally {
    rmSync(skillRoot, { recursive: true, force: true })
    rmSync(frameRoot, { recursive: true, force: true })
  }
})
