/**
 * Stage 10 Step D — verify primitive skillId resolution semantics
 * indirectly via `executeSkillTool` dispatch.
 *
 * Three input shapes feed `resolvePrimitiveSkillId(sessionId?, runtimeContext?)`:
 *   - mode:'selected' authorization → primitive uses auth.skillId.
 *   - mode:'none' authorization without candidates → primitive returns
 *     `errorKind: 'primitive_no_skill_context'`.
 *   - mode:'none' with candidateSkillPrimitives → primitive uses the
 *     candidate skillId (additive method, not an exclusive selected skill).
 *   - No runtimeContext at all → with no session reference hint and no
 *     active context, also returns `errorKind: 'primitive_no_skill_context'`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { executeSkillTool } from '../main/modules/tools/skills-tools'
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
} from '../main/modules/agent-control/skills/skill-tool-authorization'

function outputData(result: unknown): Record<string, unknown> | null {
  if (typeof result === 'string') return null
  return ((result as { data?: Record<string, unknown> | null }).data) || null
}

test('mode:selected authorization routes the primitive to auth.skillId (does NOT short-circuit on primitive_no_skill_context)', async () => {
  // If `resolvePrimitiveSkillId` honours mode:'selected', the dispatch
  // advances past the no-skill-context guard and either succeeds or hits a
  // downstream failure (e.g. missing skill, runtime not initialized in
  // host-Node tests, etc). If it ignored auth and returned null, the
  // structured response would be `primitive_no_skill_context`.
  let structuredResult: unknown = null
  let downstreamThrew = false
  try {
    structuredResult = await executeSkillTool(
      'skill_read_artifact',
      { relativePath: 'whatever.json' },
      undefined, // sessionId — intentionally absent
      undefined,
      undefined,
      undefined,
      {
        authorization: buildSelectedSkillToolAuthorization({
          skillId: 'unregistered-skill-id-for-test',
          allowedTypedActions: [],
          allowedPrimitives: ['skill_read_artifact'],
          source: 'explicit',
          reason: 'test_setup',
        }),
      },
    )
  } catch {
    downstreamThrew = true
  }
  // Either downstream threw OR we got a structured result that is NOT
  // `primitive_no_skill_context`. Either outcome proves auth.skillId
  // flowed through resolvePrimitiveSkillId past the null-skillId guard.
  if (!downstreamThrew) {
    const data = outputData(structuredResult)
    assert.notEqual(
      data?.errorKind,
      'primitive_no_skill_context',
      'mode:selected must NOT collapse to primitive_no_skill_context — auth.skillId is the single source of truth',
    )
  }
})

test('mode:none candidate primitives route the primitive to the candidate skillId', async () => {
  let structuredResult: unknown = null
  let downstreamThrew = false
  try {
    structuredResult = await executeSkillTool(
      'skill_read_artifact',
      { relativePath: 'whatever.json' },
      undefined,
      undefined,
      undefined,
      undefined,
      {
        authorization: buildExplicitNoSkillAuthorization('no_skill_signal', {
          candidateSkillPrimitives: {
            skillId: 'unregistered-candidate-skill',
            primitives: ['skill_read_artifact'],
          },
        }),
      },
    )
  } catch {
    downstreamThrew = true
  }
  if (!downstreamThrew) {
    const data = outputData(structuredResult)
    assert.notEqual(
      data?.errorKind,
      'primitive_no_skill_context',
      'candidate primitives must bind a skillId for dispatch',
    )
  }
})

test('mode:none (no_skill_signal) authorization returns primitive_no_skill_context', async () => {
  const result = await executeSkillTool(
    'skill_read_artifact',
    { relativePath: 'whatever.json' },
    undefined,
    undefined,
    undefined,
    undefined,
    { authorization: buildExplicitNoSkillAuthorization('no_skill_signal') },
  )
  const data = outputData(result)
  assert.equal(data?.errorKind, 'primitive_no_skill_context')
})

test('no runtimeContext (and no sessionId / hint) falls through to legacy chain and returns primitive_no_skill_context', async () => {
  const result = await executeSkillTool(
    'skill_read_artifact',
    { relativePath: 'whatever.json' },
    undefined,
  )
  const data = outputData(result)
  assert.equal(data?.errorKind, 'primitive_no_skill_context')
})
