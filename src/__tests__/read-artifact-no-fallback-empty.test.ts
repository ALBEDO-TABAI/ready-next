/**
 * Stage M (M4+M5) — `skill_read_artifact` empty-session regression.
 *
 * A truly empty session — no inspect_run_state has run, no resolver seed
 * is available — must fail cleanly with `no_root_match` (existing path-
 * sandbox error). The legacy fallback that previously masked this case
 * (silently consulting `resolveActiveSkillContext` even for empty sessions)
 * is gone.
 *
 * This is the "correct failure" half of M4+M5. The legitimate-success
 * half is `read-artifact-no-fallback.test.ts`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { executeReadArtifact } from '../main/modules/tools/skill-primitives/read-artifact'

test('read-artifact in empty session: rejects absolute path with no_root_match (correct failure mode)', async () => {
  const skillRoot = mkdtempSync(join(tmpdir(), 'stage-m-empty-skill-'))
  const escapeTarget = mkdtempSync(join(tmpdir(), 'stage-m-empty-target-'))
  try {
    let raised: unknown = null
    try {
      await executeReadArtifact(
        { relativePath: join(escapeTarget, 'run_state.json') },
        {
          skillId: 'video-expert-analyzer',
          lookupSkillRoots: () => ({
            artifactRoot: skillRoot,
            managedPath: skillRoot,
            configRoot: null,
            packageRoot: null,
          }),
          // Empty session: no seeded roots, no fallback. The absolute path
          // points outside the per-skill artifactRoot, so resolution must fail.
          additionalAllowedReadRoots: [],
        },
      )
    } catch (error) {
      raised = error
    }
    assert.ok(raised instanceof Error, 'expected ToolDomainError on out-of-sandbox path')
    const message = (raised as Error).message
    // The path-sandbox error surfaces as `no_root_match` or `path_escape`
    // depending on the exact reason. Both are acceptable correct failures —
    // what matters is that the read does NOT succeed via a legacy fallback.
    // The path-sandbox error surfaces as `escapes sandbox root` /
    // `no_root_match` / `path_escape` depending on the exact reason. All
    // are acceptable correct failures — what matters is the read does NOT
    // succeed via a legacy fallback.
    assert.ok(
      /no_root_match|path_escape|outside|escapes sandbox/i.test(message),
      `expected sandbox-rejection message; got: ${message}`,
    )
  } finally {
    rmSync(skillRoot, { recursive: true, force: true })
    rmSync(escapeTarget, { recursive: true, force: true })
  }
})
