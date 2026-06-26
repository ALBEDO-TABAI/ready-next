/**
 * B Phase 1 PR2 T1-9 — reference-skill inline injection refactor.
 * Verifies:
 *   - When managedPath contains SKILL.md the orchestrator reads it directly
 *     and injects a `role: 'system'` message (no tool_use round-trip)
 *   - The injection header points the model at the surviving primitive tools
 *     (skill_ask_user / skill_run_shell / ...) without naming retired
 *     execution-control tools (Phase 4 cleanup)
 *   - The hint store gets populated with the skill id
 *   - Oversized SKILL.md is truncated to 12000 chars (Phase 2: raised from 6K)
 *   - When SKILL.md is missing, the legacy tool-call path still runs
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SkillContextOrchestrator } from '../main/modules/agent-control/skills/skill-context-orchestrator'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import {
  _resetLastReferenceSkillHintsForTests,
  getLastReferenceSkill,
} from '../main/modules/agent-control/skills/skill-reference-hints'
import { TOOL_ERROR_METRICS } from '../main/modules/agent-control/tools-runtime/tool-error-metrics'

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
    assert.ok(
      !msg.content.includes('skill_submit_'),
      'must not name retired execution-control tools after Phase 4',
    )
    assert.ok(
      !msg.content.includes('skill_restart_') && !msg.content.includes('skill_cancel_execution'),
      'must not name retired execution-control tools after Phase 4',
    )
    assert.ok(msg.content.includes('skill_ask_user'), 'points the model at the ask_user primitive instead')
    assert.ok(msg.content.includes('ask_user_questions'), 'points multi-question clarification at the paged card tool')
    assert.ok(
      msg.content.includes('不要把多个问题塞进 skill_ask_user.options'),
      'must not let several questions collapse into one skill_ask_user options list',
    )
    assert.ok(msg.content.includes('skill_export_artifact'), 'points the model at export_artifact for user target paths')
    assert.ok(
      msg.content.includes('不要把用户目标文件夹的绝对路径传给 skill_write_artifact'),
      'must steer target-folder delivery away from absolute write_artifact paths',
    )
    assert.ok(msg.content.includes('mode="append"'), 'must steer long documents toward append repair')
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

test('inline injection still fires when read_skill is internal and resolveSkillToolByAction returns null', async () => {
  // Regression — `video-expert-analyzer`'s read_skill action is
  // `visibility: internal`, so `findSkillToolBySkillAction` (which powers the
  // dep here) returns null. Before the fix this silently skipped the whole
  // skill, leaving the user with no SKILL.md injection and no toast; the
  // model then defaulted to unrelated tools. Now the orchestrator reads
  // SKILL.md from managedPath regardless.
  _resetLastReferenceSkillHintsForTests()
  const managedPath = realpathSync.native(mkdtempSync(join(tmpdir(), 'skill-ref-internal-')))
  try {
    writeFileSync(join(managedPath, 'SKILL.md'), '# Expert Rails\n视频深度分析方法论正文。', 'utf-8')

    const skill = {
      id: 'video-expert-analyzer',
      name: 'Video Expert Analyzer (VNext)',
      description: '长视频深度分析',
      defaultAction: 'read_skill',
      executionMode: 'advisory',
      managedPath,
      actions: [
        { name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] },
        { name: 'video_expert_pipeline', visibility: 'internal', runtime: 'python', params: [] },
      ],
    } as any

    const orchestrator = new SkillContextOrchestrator({
      extractPrimaryUserInstruction: (raw) => raw,
      listSkills: () => [skill],
      // Mimics production `findSkillToolBySkillAction` filtering out internal
      // actions → returns null for read_skill.
      resolveSkillToolByAction: () => null,
    })

    const session: any = { messages: [] }
    let toolCalls = 0
    await orchestrator.maybeInjectExplicitSkillContext({
      userText: '用 video-expert-analyzer 分析这个视频 URL',
      session,
      sessionId: 'session-internal',
      emitOutput: () => {},
      emitToolAction: () => { toolCalls += 1 },
      executeTool: async () => {
        toolCalls += 1
        return { text: '', shape: 'text', data: null, projectionPatch: null, interactionHint: null }
      },
    })

    assert.equal(toolCalls, 0, 'inline path must not fabricate a tool_use event')
    assert.equal(session.messages.length, 1, 'SKILL.md should be inlined as a system message')
    const msg = session.messages[0] as { role: string; content: string }
    assert.equal(msg.role, 'system')
    assert.ok(msg.content.includes('已加载技能'))
    assert.ok(msg.content.includes('视频深度分析方法论正文'))
    assert.equal(getLastReferenceSkill('session-internal')?.id, 'video-expert-analyzer')
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

test('emits a metric when reference skill inline read fails before fallback', async () => {
  _resetLastReferenceSkillHintsForTests()
  const managedPath = realpathSync.native(mkdtempSync(join(tmpdir(), 'skill-ref-read-fail-')))
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    mkdirSync(join(managedPath, 'SKILL.md'))

    const orchestrator = buildOrchestrator(makeSkill(managedPath))
    const session: any = { messages: [] }
    await orchestrator.maybeInjectExplicitSkillContext({
      userText: '用 novel_writer_system 写',
      session,
      sessionId: 's-read-fail',
      emitOutput: () => {},
      emitToolAction: () => {},
      executeTool: async () => ({
        text: 'STDOUT:\n（fallback 内容）',
        shape: 'text',
        data: null,
        projectionPatch: null,
        interactionHint: null,
      }),
    })

    const event = events.find((item) => item.metric === TOOL_ERROR_METRICS.skillReferenceInlineFailed)
    assert.ok(event)
    assert.equal(event.skillId, 'novel_writer_system')
    assert.equal(event.basename, 'SKILL.md')
    assert.equal(event.errorKind, 'EISDIR')
    assert.equal((session.messages[0] as { role: string }).role, 'user')
  } finally {
    __setMetricSinkForTests(null)
    rmSync(managedPath, { recursive: true, force: true })
    _resetLastReferenceSkillHintsForTests()
  }
})

test('does not emit reference inline failure when a later candidate succeeds', async () => {
  _resetLastReferenceSkillHintsForTests()
  const managedPath = realpathSync.native(mkdtempSync(join(tmpdir(), 'skill-ref-read-recover-')))
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    mkdirSync(join(managedPath, 'SKILL.md'))
    writeFileSync(join(managedPath, 'README.md'), '# Fallback README\n可读内容。', 'utf-8')

    const orchestrator = buildOrchestrator(makeSkill(managedPath))
    const session: any = { messages: [] }
    let toolCalls = 0
    await orchestrator.maybeInjectExplicitSkillContext({
      userText: '用 novel_writer_system 写',
      session,
      sessionId: 's-read-recover',
      emitOutput: () => {},
      emitToolAction: () => { toolCalls += 1 },
      executeTool: async () => {
        toolCalls += 1
        return { text: 'UNUSED', shape: 'text', data: null, projectionPatch: null, interactionHint: null }
      },
    })

    assert.equal(toolCalls, 0)
    assert.equal((session.messages[0] as { role: string }).role, 'system')
    assert.equal(events.some((item) => item.metric === TOOL_ERROR_METRICS.skillReferenceInlineFailed), false)
  } finally {
    __setMetricSinkForTests(null)
    rmSync(managedPath, { recursive: true, force: true })
    _resetLastReferenceSkillHintsForTests()
  }
})
