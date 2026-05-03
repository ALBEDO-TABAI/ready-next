import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { ToolGateway } from '../main/modules/agent-control/tool-gateway'
import { ToolRuntime } from '../main/modules/agent-control/tool-runtime'
import { resolveToolInputSchemaForExecution } from '../main/modules/agent-control/tool-registry'
import { executeToolCall } from '../main/modules/tools/tool-executor'
import {
  resolveSkillActionTimeoutMs,
  resolveStartDetachedActionTool,
} from '../main/modules/tools/skills-tools'
import {
  rememberLastReferenceSkill,
  _resetLastReferenceSkillHintsForTests,
} from '../main/modules/agent-control/skill-reference-hints'

function openAIToolNames(gateway: ToolGateway, sessionId?: string): string[] {
  return gateway.getOpenAIToolsForGroups(['skills'], sessionId)
    .map((tool) => (tool.function as { name?: string } | undefined)?.name || '')
    .filter(Boolean)
}

beforeEach(() => {
  _resetLastReferenceSkillHintsForTests()
})

test('VEA internal typed actions are LLM-visible only when its reference hint is armed', () => {
  const gateway = new ToolGateway()
  const sessionId = 'session-vea-runtime'

  assert.ok(
    !openAIToolNames(gateway, sessionId).includes('skill_video_expert_pipeline'),
    'without a VEA hint, internal VEA actions stay hidden from LLM schemas',
  )

  rememberLastReferenceSkill(sessionId, {
    id: 'video-expert-analyzer',
    name: 'video-expert-analyzer',
  })

  assert.ok(
    openAIToolNames(gateway, sessionId).includes('skill_video_expert_pipeline'),
    'with a VEA hint, whitelisted internal VEA action is visible',
  )
})

test('resume hint exposes only the current skill internal actions', () => {
  const gateway = new ToolGateway()
  const sessionId = 'session-resume-current-skill'

  rememberLastReferenceSkill(sessionId, {
    id: 'lets-go-rss',
    name: 'Lets Go RSS',
  })

  const names = openAIToolNames(gateway, sessionId)
  assert.equal(
    names.includes('skill_video_expert_pipeline'),
    false,
    'VEA internal action must stay hidden when the resume hint belongs to a different skill',
  )
  assert.equal(
    names.includes('skill_video_expert_ai_analyze'),
    false,
    'VEA AI action must stay hidden when the resume hint belongs to a different skill',
  )
})

test('ToolRuntime does not reject an allowed VEA typed action as unregistered', async () => {
  const runtime = new ToolRuntime({
    log: () => {},
    executeToolCall: async () => 'vea:ok',
  })

  const result = await runtime.executeBatch({
    toolCalls: [
      { id: 'vea-1', name: 'skill_video_expert_pipeline', input: {} },
    ],
    context: {
      allowedToolNames: new Set(['skill_video_expert_pipeline']),
    },
  })

  assert.equal(result.results[0]?.result.data?.reason, undefined)
  assert.equal(result.results[0]?.result.text, 'vea:ok')
})

test('ToolRuntime still requires explicit allowlist for internal VEA typed actions', async () => {
  const runtime = new ToolRuntime({
    log: () => {},
    executeToolCall: async () => 'vea:ok',
  })

  const result = await runtime.executeBatch({
    toolCalls: [
      { id: 'vea-1', name: 'skill_video_expert_pipeline', input: {} },
    ],
    context: {},
  })

  assert.equal(result.results[0]?.result.data?.reason, 'tool_restricted_this_turn')
  assert.notEqual(result.results[0]?.result.text, 'vea:ok')
})

test('tool executor admits frame-scoped internal VEA actions after explicit allowlist', async () => {
  const abortController = new AbortController()
  abortController.abort()

  await assert.rejects(
    executeToolCall(
      'skill_video_expert_ai_analyze',
      { sceneScoresPath: '/tmp/ready/scene_scores.json' },
      {
        allowedToolNames: new Set(['skill_video_expert_ai_analyze']),
        frameSkillId: 'video-expert-analyzer',
        abortSignal: abortController.signal,
      },
    ),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
})

test('tool executor rejects internal VEA actions when the active frame belongs to another skill', async () => {
  const abortController = new AbortController()
  abortController.abort()

  const result = await executeToolCall(
    'skill_video_expert_ai_analyze',
    { sceneScoresPath: '/tmp/ready/scene_scores.json' },
    {
      allowedToolNames: new Set(['skill_video_expert_ai_analyze']),
      frameSkillId: 'lets-go-rss',
      abortSignal: abortController.signal,
    },
  )

  assert.equal(result.data?.reason, 'internal_tool_not_allowed')
})

test('ToolRuntime uses the VEA typed action timeout instead of the generic skill timeout', async () => {
  let resolvedTimeoutMs: number | undefined
  const runtime = new ToolRuntime({
    log: () => {},
    executeToolCall: async () => 'vea:ok',
    resolveTimeoutMs: (definition) => {
      resolvedTimeoutMs = (definition as { executionTimeoutMs?: number } | null)?.executionTimeoutMs
      return resolvedTimeoutMs || 1
    },
  })

  await runtime.executeBatch({
    toolCalls: [
      { id: 'vea-1', name: 'skill_video_expert_pipeline', input: {} },
    ],
    context: {
      allowedToolNames: new Set(['skill_video_expert_pipeline']),
    },
  })

  assert.equal(resolvedTimeoutMs, 30 * 60 * 1000)
})

test('skill action timeout falls back to host default action timeout', () => {
  const timeout = resolveSkillActionTimeoutMs(
    { hostRequirements: { default_action_timeout_ms: 30 * 60 * 1000 } },
    {},
  )

  assert.equal(timeout, 30 * 60 * 1000)
})

test('dispatch validation resolves schema for internal skill actions too', () => {
  const schema = resolveToolInputSchemaForExecution('skill_video_expert_pipeline')

  assert.ok(schema, 'expected a schema for the internal VEA typed action')
  assert.equal(schema.safeParse({}).success, false)
  assert.equal(schema.safeParse({ url: 'https://example.com/video.mp4' }).success, true)
})

test('skill_start_detached normalizes full skill tool names before action gating', () => {
  const result = resolveStartDetachedActionTool({
    skillId: 'video-expert-analyzer',
    requestedAction: 'skill_video_expert_pipeline',
    findByToolName: (name) => name === 'skill_video_expert_pipeline'
      ? {
          name,
          description: 'VEA pipeline',
          kind: 'skill_action',
          skillId: 'video-expert-analyzer',
          action: 'video_expert_pipeline',
          visibility: 'internal',
          params: [],
        }
      : null,
    findBySkillAction: () => null,
  })

  assert.equal(result.action, 'video_expert_pipeline')
  assert.equal(result.actionTool?.name, 'skill_video_expert_pipeline')
  assert.equal(result.actionTool?.action, 'video_expert_pipeline')
})
