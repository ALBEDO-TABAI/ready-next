/**
 * B Phase 1 PR2 T1-9 — reference-skill inline injection refactor.
 * Verifies:
 *   - When managedPath contains SKILL.md the orchestrator reads it directly
 *     and injects a `role: 'system'` message (no tool_use round-trip)
 *   - The injection header carries the "don't call skill_submit_* tools"
 *     guidance
 *   - The hint store gets populated with the skill id
 *   - Oversized SKILL.md is truncated to 12000 chars (Phase 2: raised from 6K)
 *   - When SKILL.md is missing, the legacy tool-call path still runs
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SkillContextOrchestrator } from '../main/modules/agent-control/skill-context-orchestrator'
import {
  _resetLastReferenceSkillHintsForTests,
  getLastReferenceSkill,
} from '../main/modules/agent-control/skill-reference-hints'

function makeSkill(managedPath: string | null): any {
  return {
    id: 'novel_writer_system',
    name: 'Novel Writer System',
    description: 'A reference skill for writing fiction.',
    defaultAction: 'read_skill',
    executionMode: 'advisory',
    managedPath,
    actions: [
      {
        name: 'read_skill',
        visibility: 'internal',
        runtime: 'reference',
        params: [],
      },
    ],
  }
}

function buildOrchestrator(skill: any) {
  return new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [skill],
    listExecutions: () => [],
    resolveSkillToolByAction: () => ({
      name: 'skill_novel_writer_system_read_skill',
      action: 'read_skill',
      params: [],
    }) as any,
  })
}

test('direct readFileSync path skips the tool call when SKILL.md exists', async () => {
  _resetLastReferenceSkillHintsForTests()
  const managedPath = realpathSync.native(mkdtempSync(join(tmpdir(), 'skill-ref-inline-')))
  try {
    writeFileSync(join(managedPath, 'SKILL.md'), '# Rails\n写作指南正文内容。', 'utf-8')

    const orchestrator = buildOrchestrator(makeSkill(managedPath))
    const session: any = { messages: [] }
    let toolCalls = 0
    await orchestrator.maybeInjectExplicitSkillContext({
      userText: '用 novel_writer_system 写一段场景',
      session,
      sessionId: 'session-direct',
      emitOutput: () => {},
      emitToolAction: () => { toolCalls += 1 },
      executeTool: async () => {
        toolCalls += 1
        return {
          text: 'UNUSED',
          shape: 'text',
          data: null,
          projectionPatch: null,
          interactionHint: null,
        }
      },
    })

    assert.equal(toolCalls, 0, 'no tool call should be made when SKILL.md is read directly')
    assert.equal(session.messages.length, 1, 'one system-role injection')
    const msg = session.messages[0] as { role: string; content: string }
    assert.equal(msg.role, 'system')
    assert.ok(msg.content.includes('已加载技能'))
    assert.ok(msg.content.includes('skill_submit_*'), 'mentions the workflow tools the model should NOT call')
    assert.ok(msg.content.includes('skill_ask_user'), 'points the model at the ask_user primitive instead')
    assert.ok(msg.content.includes('写作指南正文内容'))

    const hint = getLastReferenceSkill('session-direct')
    assert.equal(hint?.id, 'novel_writer_system')
  } finally {
    rmSync(managedPath, { recursive: true, force: true })
  }
})

test('truncates to 12000 chars when SKILL.md exceeds the cap', async () => {
  _resetLastReferenceSkillHintsForTests()
  const managedPath = realpathSync.native(mkdtempSync(join(tmpdir(), 'skill-ref-trunc-')))
  try {
    const big = 'X'.repeat(14_000)
    writeFileSync(join(managedPath, 'SKILL.md'), big, 'utf-8')

    const orchestrator = buildOrchestrator(makeSkill(managedPath))
    const session: any = { messages: [] }
    await orchestrator.maybeInjectExplicitSkillContext({
      userText: '用 novel_writer_system 写',
      session,
      sessionId: 's',
      emitOutput: () => {},
      emitToolAction: () => {},
      executeTool: async () => ({ text: '', shape: 'text', data: null, projectionPatch: null, interactionHint: null }),
    })

    const msg = session.messages[0] as { role: string; content: string }
    // Header + goal + body marker takes less than ~200 chars; the truncated
    // body itself should be exactly 12_000 chars of 'X' (Phase 2: raised cap).
    assert.ok(msg.content.includes('X'.repeat(12_000)))
    assert.ok(!msg.content.includes('X'.repeat(12_001)), 'must not pass the cap through')
  } finally {
    rmSync(managedPath, { recursive: true, force: true })
  }
})

test('falls back to the tool-call path when managedPath is missing and SKILL.md cannot be read', async () => {
  _resetLastReferenceSkillHintsForTests()
  const orchestrator = buildOrchestrator(makeSkill(null))
  const session: any = { messages: [] }
  let toolCallCount = 0
  await orchestrator.maybeInjectExplicitSkillContext({
    userText: '用 novel_writer_system 写',
    session,
    sessionId: 's',
    emitOutput: () => {},
    emitToolAction: () => { toolCallCount += 1 },
    executeTool: async () => {
      toolCallCount += 1
      return {
        text: 'STDOUT:\n（fallback 内容）',
        shape: 'text',
        data: null,
        projectionPatch: null,
        interactionHint: null,
      }
    },
  })
  // `emitToolAction` + `executeTool` each invoke the counter once.
  assert.equal(toolCallCount, 2)
  const msg = session.messages[0] as { role: string; content: string }
  assert.equal(msg.role, 'user', 'fallback path still uses the user-role injection')
  assert.ok(msg.content.includes('fallback 内容'))
  assert.equal(getLastReferenceSkill('s')?.id, 'novel_writer_system')
})
