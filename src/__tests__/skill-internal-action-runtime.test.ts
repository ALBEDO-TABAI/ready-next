import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { ToolGateway } from '../main/modules/agent-control/tools-runtime/tool-gateway'
import { ToolRuntime } from '../main/modules/agent-control/tools-runtime/tool-runtime'
import { resolveToolInputSchemaForExecution } from '../main/modules/agent-control/tools-runtime/tool-registry'
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
  type SkillToolAuthorization,
} from '../main/modules/agent-control/skills/skill-tool-authorization'
import { executeToolCall } from '../main/modules/tools/tool-executor'
import {
  resolveSkillActionTimeoutMs,
  resolveStartDetachedActionTool,
} from '../main/modules/tools/skills-tools'
import {
  rememberLastReferenceSkill,
  _resetLastReferenceSkillHintsForTests,
} from '../main/modules/agent-control/skills/skill-reference-hints'

const STANDARD_PRIMITIVES = [
  'skill_ask_user',
  'skill_run_shell',
  'skill_write_artifact',
  'skill_read_artifact',
  'skill_patch_config',
  'skill_start_detached',
  'skill_inspect_detached',
  'skill_cancel_detached',
  'skill_inspect_run_state',
]

function openAIToolNames(
  gateway: ToolGateway,
  sessionId: string | undefined,
  authorization: SkillToolAuthorization,
): string[] {
  return gateway.getOpenAIToolsForGroups(['skills'], sessionId, authorization)
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
    !openAIToolNames(gateway, sessionId, buildExplicitNoSkillAuthorization('no_skill_signal'))
      .includes('skill_video_expert_pipeline'),
    'without a VEA hint, internal VEA actions stay hidden from LLM schemas',
  )

  rememberLastReferenceSkill(sessionId, {
    id: 'video-expert-analyzer',
    name: 'video-expert-analyzer',
  })

  assert.ok(
    openAIToolNames(gateway, sessionId, buildSelectedSkillToolAuthorization({
      skillId: 'video-expert-analyzer',
      allowedTypedActions: ['skill_video_expert_pipeline'],
      allowedPrimitives: STANDARD_PRIMITIVES,
      source: 'explicit',
      reason: 'test_setup',
    })).includes('skill_video_expert_pipeline'),
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

  const names = openAIToolNames(gateway, sessionId, buildSelectedSkillToolAuthorization({
    skillId: 'lets-go-rss',
    allowedTypedActions: [],
    allowedPrimitives: STANDARD_PRIMITIVES,
    source: 'explicit',
    reason: 'test_setup',
  }))
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
      authorization: buildSelectedSkillToolAuthorization({
        skillId: 'video-expert-analyzer',
        allowedTypedActions: ['skill_video_expert_pipeline'],
        allowedPrimitives: STANDARD_PRIMITIVES,
        source: 'explicit',
        reason: 'test_setup',
      }),
    },
  })

  assert.equal(result.results[0]?.result.data?.reason, undefined)
  assert.equal(result.results[0]?.result.text, 'vea:ok')
})

test('ToolRuntime preflight bypasses skill_* allowedToolNames check (W3a — executor admission is canonical)', async () => {
  // Pre-W3a: this test pinned ToolRuntime's own allowedToolNames preflight
  // for `skill_*` tools, expecting `tool_restricted_this_turn` from runtime.
  // W3a moved the canonical denial signal for skill_* to tool-executor's
  // admission (`authorization_denied` for unauthorized model calls,
  // `tool_restricted_this_turn` from executor's own allowedToolNames gate
  // for back-compat). ToolRuntime preflight now passes skill_* through to
  // the executor — verified here by injecting a fake executor and
  // observing it's actually called even when the runtime's allowedToolNames
  // is empty.
  let executorCalls = 0
  const runtime = new ToolRuntime({
    log: () => {},
    executeToolCall: async () => {
      executorCalls += 1
      return 'vea:ok'
    },
  })

  const result = await runtime.executeBatch({
    toolCalls: [
      { id: 'vea-1', name: 'skill_video_expert_pipeline', input: {} },
    ],
    context: {
      authorization: buildSelectedSkillToolAuthorization({
        skillId: 'video-expert-analyzer',
        allowedTypedActions: ['skill_video_expert_pipeline'],
        allowedPrimitives: STANDARD_PRIMITIVES,
        source: 'explicit',
        reason: 'test_setup',
      }),
    },
  })

  assert.equal(executorCalls, 1, 'runtime preflight must NOT pre-reject skill_* — executor admission is the canonical gate')
  assert.equal(result.results[0]?.result.text, 'vea:ok')
  assert.equal(result.results[0]?.result.data?.reason, undefined)
})

test('ToolRuntime preflight still rejects non-skill tools missing from allowedToolNames', async () => {
  // The W3a preflight bypass is scoped to `skill_*` tools — non-skill
  // tools continue to receive `tool_restricted_this_turn` from runtime
  // preflight. Pinned here so a future refactor can't accidentally widen
  // the bypass and silently change errorKind for browser_/document_/etc.
  let executorCalls = 0
  const runtime = new ToolRuntime({
    log: () => {},
    executeToolCall: async () => {
      executorCalls += 1
      return 'doc:ok'
    },
  })

  const result = await runtime.executeBatch({
    toolCalls: [
      { id: 'doc-1', name: 'document_open_tab', input: { url: 'https://example.test' } },
    ],
    context: {
      allowedToolNames: new Set<string>(),
      authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    },
  })

  assert.equal(executorCalls, 0, 'runtime preflight must reject non-skill tool BEFORE the executor is invoked')
  assert.equal(result.results[0]?.result.data?.errorKind, 'tool_restricted_this_turn')
  assert.equal(result.results[0]?.result.data?.reason, undefined)
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
        authorization: buildSelectedSkillToolAuthorization({
          skillId: 'video-expert-analyzer',
          allowedTypedActions: ['skill_video_expert_ai_analyze'],
          allowedPrimitives: [],
          source: 'explicit',
          reason: 'test_setup',
        }),
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
      authorization: buildSelectedSkillToolAuthorization({
        skillId: 'lets-go-rss',
        allowedTypedActions: [],
        allowedPrimitives: [],
        source: 'explicit',
        reason: 'test_setup',
      }),
    },
  )

  assert.equal(result.data?.reason, 'tool_not_in_allowed_typed_actions')
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
      authorization: buildSelectedSkillToolAuthorization({
        skillId: 'video-expert-analyzer',
        allowedTypedActions: ['skill_video_expert_pipeline'],
        allowedPrimitives: STANDARD_PRIMITIVES,
        source: 'explicit',
        reason: 'test_setup',
      }),
    },
  })

  assert.equal(resolvedTimeoutMs, 3 * 60 * 60 * 1000)
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
