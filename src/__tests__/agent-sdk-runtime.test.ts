import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AgentSdkRuntime,
  removeAlreadyEmittedNativeText,
  resolveToolFailurePageUrl,
  sdkStatusFromTerminalReason,
  splitNativeTextBufferForSafeFlush,
  type AgentSdkRuntimeDeps
} from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'
import type { CheckInRecord } from '../main/modules/agent-control/quality/task-adjudicator'
import { createTaskBudgetRuntime } from '../main/modules/agent-control/task-projection/run-budget-policy'
import {
  authorizeMcpToolForScope,
  registerMcpServer,
  __resetMcpRegistryForTests
} from '../main/modules/mcp/registry'
import { setCachedMcpOAuthToken, __resetMcpOAuthForTests } from '../main/modules/mcp/oauth'
import { __resetBrowserWriteLeaseServiceForTests } from '../main/modules/browser-engine/agent-browser-lease-singleton'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'
import type { BrowserTurnLease } from '../main/modules/browser-engine/agent-browser-turn-lease'
import {
  clearLastReferenceSkill,
  rememberLastReferenceSkill
} from '../main/modules/agent-control/skills/skill-reference-hints'
import { buildSelectedSkillToolAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { __setSkillActionToolDefsForTests } from '../main/modules/tools/skills-tools'
import {
  __setMetricSinkForTests,
  type AgentMetricEvent
} from '../main/modules/agent-control/metrics'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test'
} as const

test('agent sdk runtime declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'agent-sdk-runtime transitive sqlite load')
})

test('agent sdk runtime treats adjudication_degraded as completed-with-warning status', () => {
  assert.equal(sdkStatusFromTerminalReason('adjudication_degraded'), 'done')
  assert.equal(sdkStatusFromTerminalReason('adjudication_degraded', false), 'error')
})

test('agent sdk native text buffer flushes safe prefixes before tool markers', () => {
  const split = splitNativeTextBufferForSafeFlush('我先生成方案。<tool_call><function=web_search>')
  assert.equal(split.emitText, '我先生成方案。')
  assert.equal(split.remainingText, '<tool_call><function=web_search>')
})

test('agent sdk native text buffer time flush keeps dangling tool markers hidden', () => {
  assert.deepEqual(
    splitNativeTextBufferForSafeFlush('我先生成方案。', { flushWithoutMarker: true }),
    { emitText: '我先生成方案。', remainingText: '' }
  )
  assert.deepEqual(
    splitNativeTextBufferForSafeFlush('我先生成方案。<tool_', { flushWithoutMarker: true }),
    { emitText: '', remainingText: '我先生成方案。<tool_' }
  )
})

test('agent sdk native text buffer does not repeat already flushed visible text', () => {
  assert.equal(
    removeAlreadyEmittedNativeText('我先生成方案。\n已保存。', '我先生成方案。').trimStart(),
    '已保存。'
  )
})

function createRuntime(deps: Partial<AgentSdkRuntimeDeps>): AgentSdkRuntime {
  return new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    ...deps
  })
}

function attachMemoryRunMeta(runtime: AgentSdkRuntime): Map<string, Record<string, unknown>> {
  const rows = new Map<string, Record<string, unknown>>()
  runtime.setRuntime({
    getRunMetaRepository: () => ({
      get: (runId: string) => rows.get(runId) ?? null,
      create: (input: Record<string, unknown>) => {
        rows.set(String(input.runId), { ...input })
        return input
      },
      update: (runId: string, patch: Record<string, unknown>) => {
        const next = { ...(rows.get(runId) || {}), ...patch }
        rows.set(runId, next)
        return next
      }
    })
  } as never)
  return rows
}

function createToolDefinition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'web_search',
    groupId: 'general_research',
    domain: 'general_research',
    kind: 'read',
    concurrency: 'parallel_read_safe',
    interruptBehavior: 'abort_signal',
    timeoutProfile: 'default',
    supportsTextBridge: true,
    projectionHint: { emitsProjectionPatch: true },
    description: 'Test tool',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string' }
      },
      required: ['query'],
      additionalProperties: false
    },
    executionVisibility: 'model',
    resultShape: 'json',
    ...overrides
  }
}

async function seedSdkSession(
  runtime: AgentSdkRuntime,
  name: string,
  items: AgentInputItem[]
): Promise<void> {
  const session = (
    runtime as unknown as {
      sessionManager: {
        get: (
          name: string
        ) => { sdkSession: { addItems: (items: AgentInputItem[]) => Promise<void> } } | undefined
      }
    }
  ).sessionManager.get(name)
  assert.ok(session, `missing test session ${name}`)
  await session.sdkSession.addItems(items)
}

async function readSdkSessionItems(
  runtime: AgentSdkRuntime,
  name: string
): Promise<AgentInputItem[]> {
  const session = (
    runtime as unknown as {
      sessionManager: {
        get: (
          name: string
        ) => { sdkSession: { getItems: () => Promise<AgentInputItem[]> } } | undefined
      }
    }
  ).sessionManager.get(name)
  assert.ok(session, `missing test session ${name}`)
  return session.sdkSession.getItems()
}

function historyTextItems(prefix: string, count: number): AgentInputItem[] {
  const items: AgentInputItem[] = []
  for (let index = 0; index < count; index += 1) {
    items.push({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${prefix}-${index} ${'长上下文片段 '.repeat(80)}`
    } as AgentInputItem)
  }
  return items
}

function chatCompletionResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: `chatcmpl-${Date.now()}`,
      choices: [
        {
          message: { content: text },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
    }),
    { status: 200 }
  )
}

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1
}

test('agent sdk runtime streams text and closes with terminal reason', async () => {
  const events: Array<Record<string, unknown>> = []
  const runtime = createRuntime({
    runAgent: async ({ onTextDelta }) => {
      onTextDelta('你好')
      onTextDelta('，已完成')
      return { finalText: '你好，已完成' }
    }
  })
  runtime.on('output', (event) => events.push({ channel: 'output', ...event }))
  runtime.on('status', (event) => events.push({ channel: 'status', ...event }))
  runtime.newSession('butler::scope-1', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-1', '打个招呼', 'run-1', {
    publicSessionId: 'scope-1',
    taskId: 'task-1'
  })

  assert.equal(result.success, true)
  assert.equal(result.finalText, '你好，已完成')
  assert.equal(result.terminalReason, 'done')
  assert.deepEqual(
    events.filter((event) => event.channel === 'output').map((event) => [event.type, event.chunk]),
    [
      ['text', '你好，已完成'],
      ['done', '']
    ]
  )
  assert.deepEqual(
    events
      .filter((event) => event.channel === 'status')
      .map((event) => [event.status, event.terminalReason]),
    [
      ['working', undefined],
      ['done', 'done']
    ]
  )
})

test('agent sdk runtime soft-recovers once when SDK rejects an unregistered tool', async () => {
  let calls = 0
  let secondInputText = ''
  const runtime = createRuntime({
    runAgent: async ({ input }) => {
      calls += 1
      if (calls === 1)
        throw new Error('Tool web_search not found in agent butler::scope-missing-tool')
      secondInputText = JSON.stringify(input)
      return { finalText: '已换用可用路径完成' }
    }
  })
  runtime.newSession('butler::scope-missing-tool', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-missing-tool',
    '继续查资料',
    'run-missing-tool',
    {
      publicSessionId: 'scope-missing-tool',
      taskId: 'task-missing-tool'
    }
  )

  assert.equal(calls, 2)
  assert.equal(result.success, true)
  assert.equal(result.finalText, '已换用可用路径完成')
  assert.equal(result.terminalReason, 'done')
  assert.match(secondInputText, /未注册工具 web_search/)
})

test('agent sdk runtime scales max turns for long reading resources', async () => {
  const longText = '字'.repeat(81_916)
  const runtime = createRuntime({
    runAgent: async ({ maxTurns }) => {
      assert.equal(maxTurns, 40)
      return { finalText: '长文预算已放宽' }
    }
  })
  runtime.newSession('butler::scope-long-reading-budget', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-long-reading-budget',
    '@[study-notes]带我学一下这篇文章@[long-images-transcribed.md]',
    'run-long-reading-budget',
    {
      publicSessionId: 'scope-long-reading-budget',
      taskId: 'task-long-reading-budget',
      requestEnvelope: {
        primaryInstruction: '@[study-notes]带我学一下这篇文章@[long-images-transcribed.md]',
        resources: [
          {
            name: 'long-images-transcribed.md',
            path: '/tmp/long-images-transcribed.md',
            text: longText
          }
        ]
      }
    }
  )

  assert.equal(result.success, true)
  assert.equal(result.finalText, '长文预算已放宽')
})

test('agent sdk runtime exposes only background collection workflow tools for multi-note browser collection', async () => {
  let toolNames: string[] = []
  const runtime = createRuntime({
    runAgent: async ({ tools }) => {
      toolNames = tools.map((tool) => tool.name)
      return { finalText: '采集工具已收窄' }
    }
  })
  runtime.setBrowserController({} as never)
  runtime.newSession('butler::scope-browser-batch-collect-tools', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-browser-batch-collect-tools',
    '把这个博主的每篇笔记都采集下来并保存图片',
    'run-browser-batch-collect-tools',
    {
      publicSessionId: 'scope-browser-batch-collect-tools',
      taskId: 'task-browser-batch-collect-tools',
      requestEnvelope: {
        primaryInstruction: '把这个博主的每篇笔记都采集下来并保存图片',
        resources: []
      }
    }
  )

  assert.equal(result.success, true)
  for (const name of [
    'browser_visible_collect',
    'browser_collect_notes',
    'browser_download_collected_media',
    'browser_resume_task',
    'browser_get_task'
  ]) {
    assert.ok(toolNames.includes(name), `${name} should be exposed`)
  }
  for (const name of [
    'browser_navigate',
    'browser_click_text',
    'browser_collect_images',
    'browser_resolve_video',
    'browser_download_urls',
    'browser_extract_structured'
  ]) {
    assert.ok(!toolNames.includes(name), `${name} should be hidden for batch collection`)
  }

  toolNames = []
  const followUp = await runtime.sendMessage(
    'butler::scope-browser-batch-collect-tools',
    '继续',
    'run-browser-batch-collect-tools-follow-up',
    {
      publicSessionId: 'scope-browser-batch-collect-tools',
      taskId: 'task-browser-batch-collect-tools-follow-up',
      requestEnvelope: {
        primaryInstruction: '继续',
        resources: []
      }
    }
  )
  assert.equal(followUp.success, true)
  assert.ok(toolNames.includes('browser_visible_collect'))
  assert.ok(toolNames.includes('browser_collect_notes'))
  assert.ok(toolNames.includes('browser_download_collected_media'))
  assert.ok(!toolNames.includes('browser_click_text'))
  assert.ok(!toolNames.includes('browser_download_urls'))
})

test('agent sdk runtime demotes widget edits before exposing browser tools', async () => {
  let toolNames: string[] = []
  const runtime = createRuntime({
    runAgent: async ({ tools }) => {
      toolNames = tools.map((tool) => tool.name)
      return { finalText: 'widget tools captured' }
    }
  })
  runtime.setBrowserController({} as never)
  runtime.newSession('butler::scope-widget-tool-surface', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-widget-tool-surface',
    '把当前天气卡标题字号调大一点',
    'run-widget-tool-surface',
    {
      publicSessionId: 'scope-widget-tool-surface',
      taskId: 'task-widget-tool-surface',
      requestEnvelope: {
        rawUserText: '## 环境信息\n当前模式: 文档模式\n\n把当前天气卡标题字号调大一点',
        primaryInstruction: '把当前天气卡标题字号调大一点',
        environmentHints: {
          hasDocumentContext: true,
          hasWidgetTargetContext: true,
          hasAttachments: false,
          hasBootstrapContext: true
        },
        resources: [
          {
            name: '天气卡',
            path: '/virtual/widget/weather-card',
            kind: 'widget_target',
            source: 'widget_target'
          }
        ]
      }
    }
  )

  assert.equal(result.success, true)
  assert.ok(toolNames.includes('document_update_widget'))
  assert.equal(
    toolNames.some((name) => name.startsWith('browser_')),
    false
  )
})

test('agent sdk runtime exposes map tools for deterministic route intent', async () => {
  let toolNames: string[] = []
  const runtime = createRuntime({
    runAgent: async ({ tools }) => {
      toolNames = tools.map((tool) => tool.name)
      return { finalText: 'map tools captured' }
    }
  })
  runtime.newSession('butler::scope-map-tool-surface', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-map-tool-surface',
    '从公司到虹桥机场怎么走',
    'run-map-tool-surface',
    {
      publicSessionId: 'scope-map-tool-surface',
      taskId: 'task-map-tool-surface',
      requestEnvelope: {
        primaryInstruction: '从公司到虹桥机场怎么走',
        resources: []
      }
    }
  )

  assert.equal(result.success, true)
  assert.ok(toolNames.includes('map_plan_route'))
})

test('agent sdk runtime applies selected skill allowed_tools to default surface', async () => {
  let toolNames: string[] = []
  const runtime = createRuntime({
    runAgent: async ({ tools }) => {
      toolNames = tools.map((tool) => tool.name)
      return { finalText: 'send-im tools captured' }
    }
  })
  runtime.newSession('butler::scope-send-im-tool-surface', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-send-im-tool-surface',
    '把这个附件发到我微信',
    'run-send-im-tool-surface',
    {
      publicSessionId: 'scope-send-im-tool-surface',
      taskId: 'task-send-im-tool-surface',
      requestEnvelope: {
        primaryInstruction: '把这个附件发到我微信',
        resources: [
          {
            name: '成片.png',
            path: '/tmp/ready-send-im-proof/成片.png',
            kind: 'attachment',
            source: 'user_attachment'
          }
        ]
      }
    }
  )

  assert.equal(result.success, true)
  assert.deepEqual(toolNames, [
    'skill_send_im_file',
    'agent_propose_handoff',
    'declare_completion_criteria'
  ])
})

test('agent sdk runtime preserves base tools when selected skill tools are unavailable', () => {
  const runtime = createRuntime({})
  const privateRuntime = runtime as unknown as {
    // listDefaultToolDefinitionsForTurn was extracted to AgentSdkToolExecutor (V3 Phase 5-A).
    toolExecutor: {
      listDefaultToolDefinitionsForTurn: (params: {
        message: string
        sessionId?: string
        scopeId?: string
        config: typeof fakeConfig
        browserHostAvailable: boolean
        feishuConnected: boolean
        authorization: ReturnType<typeof buildSelectedSkillToolAuthorization>
        requestEnvelope?: unknown
      }) => Array<{ name: string; groupId: string }>
    }
  }
  const definitions = privateRuntime.toolExecutor.listDefaultToolDefinitionsForTurn({
    message: '输出方案文档到这个目录里',
    sessionId: 'scope-missing-skill-tools',
    scopeId: 'scope-missing-skill-tools',
    config: fakeConfig,
    browserHostAvailable: true,
    feishuConnected: false,
    authorization: buildSelectedSkillToolAuthorization({
      skillId: 'missing-runtime-skill',
      allowedTypedActions: ['skill_missing_runtime_action'],
      allowedPrimitives: [],
      source: 'explicit',
      reason: 'test_missing_runtime_skill'
    }),
    requestEnvelope: buildRequestEnvelope({ userText: '输出方案文档到这个目录里' })
  })
  const names = definitions.map((definition) => definition.name)

  assert.equal(names.includes('skill_missing_runtime_action'), false)
  assert.ok(names.length > 0)
  assert.ok(names.some((name) => name.startsWith('document_') || name.startsWith('file_')))
})

test('agent sdk runtime keeps research acquisition tools beside a selected reference skill', () => {
  const runtime = createRuntime({})
  const privateRuntime = runtime as unknown as {
    toolExecutor: {
      listDefaultToolDefinitionsForTurn: (params: Record<string, unknown>) => Array<{ name: string }>
    }
  }
  const userText = [
    '帮我调研宝矿力广告史，整理人物、案例与来源为多份文件和索引，存到@[宝矿力]',
    '',
    '### 当前文档上下文',
    '- 标题: unrelated.md',
    '- 路径: /tmp/unrelated.md',
    '',
    '### 文件夹引用',
    '- 名称: 宝矿力',
    '- 路径: /tmp/宝矿力',
  ].join('\n')
  const requestEnvelope = buildRequestEnvelope({ userText })
  const definitions = privateRuntime.toolExecutor.listDefaultToolDefinitionsForTurn({
    message: userText,
    sessionId: 'scope-brand-research',
    scopeId: 'scope-brand-research',
    config: fakeConfig,
    browserHostAvailable: true,
    feishuConnected: false,
    authorization: buildSelectedSkillToolAuthorization({
      skillId: 'deep-research',
      allowedTypedActions: [],
      allowedPrimitives: ['skill_write_artifact', 'skill_export_artifact'],
      source: 'explicit',
      reason: 'test',
    }),
    requestEnvelope,
  })
  const names = definitions.map((definition) => definition.name)

  for (const required of ['web_search', 'web_fetch', 'declare_completion_criteria', 'skill_write_artifact', 'skill_export_artifact']) {
    assert.ok(names.includes(required), `expected ${required}, got ${names.join(',')}`)
  }
})

test('agent sdk runtime keeps handoff available when a fuzzy skill match narrows the turn', () => {
  const runtime = createRuntime({})
  const privateRuntime = runtime as unknown as {
    toolExecutor: {
      listDefaultToolDefinitionsForTurn: (params: Record<string, unknown>) => Array<{ name: string }>
    }
  }
  const definitions = privateRuntime.toolExecutor.listDefaultToolDefinitionsForTurn({
    message: '请把当前任务转交给文案 Agent',
    sessionId: 'scope-skill-handoff',
    scopeId: 'scope-skill-handoff',
    config: fakeConfig,
    browserHostAvailable: true,
    feishuConnected: false,
    authorization: buildSelectedSkillToolAuthorization({
      skillId: 'context-compact',
      allowedTypedActions: ['skill_compact_context'],
      allowedPrimitives: [],
      source: 'explicit',
      reason: 'test_fuzzy_skill_handoff'
    }),
    requestEnvelope: buildRequestEnvelope({ userText: '请把当前任务转交给文案 Agent' })
  })

  assert.ok(definitions.some((definition) => definition.name === 'agent_propose_handoff'))
})

test('agent sdk runtime sanitizes raw tool-call text before transcript output', async () => {
  const runtime = createRuntime({
    runAgent: async () => ({
      finalText: ['我先检查目录。', '<function=file_list><parameter=path>/tmp'].join('\n')
    })
  })
  runtime.newSession('butler::scope-sanitize-sdk-text', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-sanitize-sdk-text',
    '检查目录',
    'run-sanitize-sdk-text',
    {
      publicSessionId: 'scope-sanitize-sdk-text',
      taskId: 'task-sanitize-sdk-text',
      requestEnvelope: buildRequestEnvelope({ userText: '检查目录' })
    }
  )
  const visibleText = (result.projectionTruth?.transcriptEvents || [])
    .filter((event) => event.kind === 'output' && event.type === 'text')
    .map((event) => event.chunk)
    .join('')

  assert.equal(result.success, true)
  assert.match(visibleText, /我先检查目录/)
  assert.doesNotMatch(visibleText, /<tool_call|<function=|<parameter=/)
})

test('agent sdk runtime exposes skill_send_im_file when the file to send is referenced as @[file.md]', async () => {
  // Regression: "@[Send IM]@[2026 世界杯-...md]" (the natural way to name the file to send)
  //   used to collide with shouldUseLocalDocumentToolSet — the @[...md] reference routed the
  //   turn to the document tool set, stripping skill_send_im_file and leaving zero tools
  //   ("当前会话未开放 skill_send_im_file 工具").
  let toolNames: string[] = []
  const runtime = createRuntime({
    runAgent: async ({ tools }) => {
      toolNames = tools.map((tool) => tool.name)
      return { finalText: 'send-im md ref captured' }
    }
  })
  runtime.newSession('butler::scope-send-im-md-ref', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-send-im-md-ref',
    '@[Send IM]@[2026 世界杯-1781619835060.md]',
    'run-send-im-md-ref',
    {
      publicSessionId: 'scope-send-im-md-ref',
      taskId: 'task-send-im-md-ref',
      requestEnvelope: {
        primaryInstruction: '@[Send IM]@[2026 世界杯-1781619835060.md]',
        resources: [
          {
            name: '2026 世界杯-1781619835060.md',
            path: '/tmp/ready-send-im-proof/2026 世界杯-1781619835060.md',
            kind: 'attachment',
            source: 'user_attachment'
          }
        ]
      }
    }
  )

  assert.equal(result.success, true)
  assert.ok(
    toolNames.includes('skill_send_im_file'),
    `expected skill_send_im_file, got: ${toolNames.join(',') || '(none)'}`
  )
})

test('agent sdk runtime suppresses browser task tools for active VEA skill resume after recent collection intent', async () => {
  const seenToolNames: string[][] = []
  let activeSkillHint = false
  __setSkillActionToolDefsForTests(() => [
    {
      name: 'skill_video_expert_pipeline',
      description: 'Run VEA pipeline',
      kind: 'skill_action',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      visibility: 'public',
      params: []
    },
    {
      name: 'skill_video_expert_ai_analyze',
      description: 'Run VEA analysis',
      kind: 'skill_action',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_ai_analyze',
      visibility: 'public',
      params: []
    }
  ])
  const runtime = createRuntime({
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [],
      buildPreferredSkillToolNames: () => [],
      peekCurrentReferenceSkillHint: () =>
        activeSkillHint ? { id: 'video-expert-analyzer', name: 'Video Expert Analyzer' } : null,
      getCurrentReferenceSkillHint: () =>
        activeSkillHint ? { id: 'video-expert-analyzer', name: 'Video Expert Analyzer' } : null
    },
    getScopeTaskRefs: () =>
      activeSkillHint ? [{ taskId: 'task-vea-active', status: 'running' }] : [],
    runAgent: async ({ tools }) => {
      seenToolNames.push(tools.map((tool) => tool.name))
      return { finalText: 'ok' }
    }
  })
  runtime.setBrowserController({} as never)
  runtime.newSession('butler::scope-vea-resume-tools', 'system prompt')

  try {
    const collect = await runtime.sendMessage(
      'butler::scope-vea-resume-tools',
      '把这个博主的每篇笔记都采集下来并保存图片',
      'run-vea-resume-tools-1',
      {
        publicSessionId: 'scope-vea-resume-tools',
        taskId: 'task-vea-resume-tools-1',
        requestEnvelope: {
          primaryInstruction: '把这个博主的每篇笔记都采集下来并保存图片',
          resources: []
        }
      }
    )
    activeSkillHint = true
    const resume = await runtime.sendMessage(
      'butler::scope-vea-resume-tools',
      '跑 finalize',
      'run-vea-resume-tools-2',
      {
        publicSessionId: 'scope-vea-resume-tools',
        taskId: 'task-vea-resume-tools-2',
        requestEnvelope: {
          primaryInstruction: '跑 finalize',
          resources: []
        }
      }
    )

    assert.equal(collect.success, true)
    assert.equal(resume.success, true)
    assert.ok(seenToolNames[0]?.includes('browser_resume_task'))
    assert.ok(seenToolNames[1]?.includes('skill_video_expert_pipeline'))
    assert.ok(seenToolNames[1]?.includes('skill_video_expert_ai_analyze'))
    for (const name of [
      'browser_get_task',
      'browser_resume_task',
      'browser_visible_collect',
      'browser_collect_notes',
      'browser_download_collected_media'
    ]) {
      assert.equal(
        seenToolNames[1]?.includes(name),
        false,
        `${name} should be hidden during active skill resume`
      )
    }
  } finally {
    __setSkillActionToolDefsForTests(null)
  }
})

test('agent sdk runtime keeps Send IM visible for a bare retry after explicit local Send IM', async () => {
  const seenToolNames: string[][] = []
  const runtime = createRuntime({
    runAgent: async ({ tools }) => {
      seenToolNames.push(tools.map((tool) => tool.name))
      return { finalText: 'ok' }
    }
  })
  runtime.setBrowserController({} as never)
  runtime.newSession('butler::scope-send-im-retry-tools', 'system prompt')

  const first = await runtime.sendMessage(
    'butler::scope-send-im-retry-tools',
    '@[Send IM]把这四张图发到我微信',
    'run-send-im-retry-tools-1',
    {
      publicSessionId: 'scope-send-im-retry-tools',
      taskId: 'task-send-im-retry-tools-1',
      requestEnvelope: {
        primaryInstruction: '@[Send IM]把这四张图发到我微信',
        resources: []
      }
    }
  )
  const retry = await runtime.sendMessage(
    'butler::scope-send-im-retry-tools',
    '重试一次',
    'run-send-im-retry-tools-2',
    {
      publicSessionId: 'scope-send-im-retry-tools',
      taskId: 'task-send-im-retry-tools-2',
      requestEnvelope: {
        primaryInstruction: '重试一次',
        resources: []
      }
    }
  )

  assert.equal(first.success, true)
  assert.equal(retry.success, true)
  assert.equal(seenToolNames.length, 2)
  assert.ok(seenToolNames[0]?.includes('skill_send_im_file'))
  assert.ok(seenToolNames[1]?.includes('skill_send_im_file'))
  assert.equal(seenToolNames[1]?.includes('browser_visible_collect'), false)
  assert.equal(seenToolNames[1]?.includes('browser_download_urls'), false)
})

test('agent sdk runtime keeps Send IM visible for an attached try-this follow-up', async () => {
  const seenToolNames: string[][] = []
  const runtime = createRuntime({
    runAgent: async ({ tools }) => {
      seenToolNames.push(tools.map((tool) => tool.name))
      return { finalText: 'ok' }
    }
  })
  runtime.setBrowserController({} as never)
  runtime.newSession('butler::scope-send-im-attachment-followup', 'system prompt')

  const first = await runtime.sendMessage(
    'butler::scope-send-im-attachment-followup',
    '@[Send IM]把这四张图发到我微信',
    'run-send-im-attachment-followup-1',
    {
      publicSessionId: 'scope-send-im-attachment-followup',
      taskId: 'task-send-im-attachment-followup-1',
      requestEnvelope: {
        primaryInstruction: '@[Send IM]把这四张图发到我微信',
        resources: []
      }
    }
  )
  const followUp = await runtime.sendMessage(
    'butler::scope-send-im-attachment-followup',
    '@[BV1shJP6TEEQ.mp4]再试试这个',
    'run-send-im-attachment-followup-2',
    {
      publicSessionId: 'scope-send-im-attachment-followup',
      taskId: 'task-send-im-attachment-followup-2',
      requestEnvelope: {
        primaryInstruction: '@[BV1shJP6TEEQ.mp4]再试试这个',
        resources: [
          {
            name: 'BV1shJP6TEEQ.mp4',
            path: '/tmp/BV1shJP6TEEQ.mp4',
            kind: 'video',
            source: 'attachment'
          }
        ]
      }
    }
  )

  assert.equal(first.success, true)
  assert.equal(followUp.success, true)
  assert.equal(seenToolNames.length, 2)
  assert.ok(seenToolNames[1]?.includes('skill_send_im_file'))
  assert.equal(seenToolNames[1]?.includes('browser_visible_collect'), false)
  assert.equal(seenToolNames[1]?.includes('browser_download_urls'), false)
})

test('agent sdk runtime preempts old run and cancels pending renderer actions', async () => {
  let cancelCount = 0
  let firstSignal: AbortSignal | null = null
  let firstStartedResolve!: () => void
  const firstStarted = new Promise<void>((resolve) => {
    firstStartedResolve = resolve
  })
  const runAgentQueue: NonNullable<AgentSdkRuntimeDeps['runAgent']>[] = [
    ({ signal }) => {
      firstSignal = signal
      firstStartedResolve()
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            const error = new Error('process_restarted')
            error.name = 'AbortError'
            reject(error)
          },
          { once: true }
        )
      })
    },
    async ({ onTextDelta }) => {
      onTextDelta('第二轮完成')
      return { finalText: '第二轮完成' }
    }
  ]
  const runtime = createRuntime({
    runAgent: (params) => {
      const next = runAgentQueue.shift()
      assert.ok(next)
      return next(params)
    }
  })
  runtime.setCancelPendingToolActions(() => {
    cancelCount += 1
  })
  runtime.newSession('butler::scope-2', 'system prompt')

  const first = runtime.sendMessage('butler::scope-2', '第一轮', 'run-old', {
    publicSessionId: 'scope-2',
    taskId: 'task-old'
  })
  await firstStarted
  const second = await runtime.sendMessage('butler::scope-2', '第二轮', 'run-new', {
    publicSessionId: 'scope-2',
    taskId: 'task-new'
  })
  const firstResult = await first

  assert.equal(firstSignal?.aborted, true)
  assert.equal(cancelCount, 1)
  assert.equal(firstResult.cancelled, true)
  assert.deepEqual(firstResult.scopeRunAuthority, {
    state: 'lost',
    reason: 'preempted_by_same_user',
    currentRunId: null
  })
  assert.equal(second.success, true)
  assert.equal(second.finalText, '第二轮完成')
})

test('agent sdk runtime does not mark user cancellation as preempted', async () => {
  let firstSignal: AbortSignal | null = null
  let signalReadyResolve!: () => void
  const signalReady = new Promise<void>((resolve) => {
    signalReadyResolve = resolve
  })
  const runtime = createRuntime({
    runAgent: ({ signal }) => {
      firstSignal = signal
      signalReadyResolve()
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            const error = new Error('cancelled_user')
            error.name = 'AbortError'
            reject(error)
          },
          { once: true }
        )
      })
    }
  })
  runtime.newSession('butler::scope-user-cancel', 'system prompt')

  const pending = runtime.sendMessage('butler::scope-user-cancel', '第一轮', 'run-cancelled', {
    publicSessionId: 'scope-user-cancel',
    taskId: 'task-cancelled'
  })
  await signalReady
  runtime.stopGeneration('butler::scope-user-cancel')
  const result = await pending

  assert.equal(firstSignal?.aborted, true)
  assert.equal(result.cancelled, true)
  assert.equal(result.scopeRunAuthority, undefined)
})

test('agent sdk runtime exposes Ready tool definitions and preserves structured patches', async () => {
  const toolDefinition = createToolDefinition({ description: 'Search the web' })
  let receivedArgs: Record<string, unknown> | null = null
  const runtime = createRuntime({
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async (_toolName, args) => {
      receivedArgs = args
      return createToolExecutionOutput('found result', {
        shape: 'json',
        data: { ok: true },
        projectionPatch: {
          taskTitle: 'Research',
          taskSummary: 'Search done'
        }
      })
    },
    runAgent: async ({ tools, onTextDelta }) => {
      assert.equal(tools.length, 1)
      const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      const toolOutput = await sdkTool.invoke({}, JSON.stringify({ query: 'OpenAI Agents SDK' }))
      assert.match(toolOutput, /"projectionPatch"/)
      onTextDelta('研究完成')
      return { finalText: '研究完成' }
    }
  })
  runtime.newSession('butler::scope-3', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-3', '查一下最新资料', 'run-tool', {
    publicSessionId: 'scope-3',
    taskId: 'task-tool'
  })

  assert.deepEqual(receivedArgs, { query: 'OpenAI Agents SDK' })
  assert.deepEqual(result.usedTools, ['web_search'])
  assert.equal(result.taskType, 'research')
  assert.deepEqual(result.projectionTruth?.projectionPatch, {
    taskTitle: 'Research',
    taskSummary: 'Search done'
  })
})

test('native handoff tool result checkpoints before reading a stale model final output', async () => {
  const handoffDefinition = createToolDefinition({
    name: 'agent_propose_handoff',
    groupId: 'agent_interaction',
    domain: 'agent_interaction'
  })
  const runtime = createRuntime({
    listToolDefinitions: () => [handoffDefinition],
    executeToolCall: async () => createToolExecutionOutput('已采纳交接', {
      shape: 'json',
      data: { outcome: { control: 'handoff_takeover' } }
    }),
    runAgent: async ({ tools }) => {
      const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      await sdkTool.invoke({}, JSON.stringify({ targetAgentId: 'copywriter' }))
      return { finalText: '旧身份不应继续输出' }
    }
  })
  runtime.newSession('butler::scope-native-handoff', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-native-handoff',
    '转交给文案',
    'run-native-handoff',
    { publicSessionId: 'scope-native-handoff', taskId: 'task-native-handoff' }
  )

  assert.equal(result.status, 'checkpoint')
  assert.equal(result.terminalReason, 'manual_suspend')
  assert.equal(result.finalText, '')
})

test('agent sdk runtime buffers native text before recovering XML tool calls', async () => {
  const toolDefinition = createToolDefinition({ description: 'Search the web' })
  const outputEvents: Array<Record<string, unknown>> = []
  const calls: Array<Record<string, unknown>> = []
  let runCount = 0
  const runtime = createRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'openai-compatible',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
        model: 'mimo-v2.5',
        agentProtocol: 'anthropic'
      }
    }),
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async (_toolName, args) => {
      calls.push(args)
      return createToolExecutionOutput('found result', {
        shape: 'json',
        data: { ok: true }
      })
    },
    runAgent: async ({ onTextDelta }) => {
      runCount += 1
      if (runCount === 1) {
        const leaked = [
          'Now I will search.',
          '<tool_call>',
          '<function=web_search>',
          '<parameter=query>OpenAI Agents SDK</parameter>',
          '</function>',
          '</tool_call>'
        ].join('\n')
        onTextDelta(leaked)
        return { finalText: leaked }
      }
      onTextDelta('研究完成')
      return { finalText: '研究完成' }
    }
  })
  runtime.on('output', (event) => outputEvents.push(event))
  runtime.newSession('butler::scope-xml-buffer', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-xml-buffer',
    '查一下资料',
    'run-xml-buffer',
    {
      publicSessionId: 'scope-xml-buffer',
      taskId: 'task-xml-buffer'
    }
  )

  assert.equal(result.success, true)
  assert.equal(runCount, 2)
  assert.deepEqual(calls, [{ query: 'OpenAI Agents SDK' }])
  const visibleText = outputEvents
    .filter((event) => event.type === 'text')
    .map((event) => String(event.chunk || ''))
    .join('\n')
  assert.doesNotMatch(visibleText, /<tool_call>|<function=|<parameter=/)
  assert.match(visibleText, /Now I will search/)
  assert.match(visibleText, /研究完成/)
})

test('agent sdk runtime asks for map place choice and retries with selected coordinates', async () => {
  const mapTool = createToolDefinition({
    name: 'map_plan_route',
    groupId: 'map_planning',
    domain: 'map',
    kind: 'write',
    description: 'Plan map route',
    schema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        origin: {},
        destination: {},
        transportMode: { type: 'string' }
      },
      required: ['origin', 'destination'],
      additionalProperties: false
    }
  })
  const askTool = createToolDefinition({
    name: 'ask_user_questions',
    groupId: 'agent_interaction',
    domain: 'agent_interaction',
    kind: 'write',
    description: 'Ask user questions',
    schema: {
      type: 'object',
      properties: { questions: { type: 'array' } },
      required: ['questions'],
      additionalProperties: false
    }
  })
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = []
  let selectedOption = ''
  let runCount = 0
  const runtime = createRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'openai-compatible',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
        model: 'mimo-v2.5',
        agentProtocol: 'anthropic'
      }
    }),
    listToolDefinitions: () => [mapTool, askTool],
    executeToolCall: async (toolName, args) => {
      calls.push({ toolName, args })
      if (toolName === 'map_plan_route') {
        if (typeof args.destination === 'object' && args.destination !== null) {
          assert.deepEqual(args.destination, {
            name: '上海市闵行区上海虹桥火车站',
            location: '121.320011,31.194416'
          })
          const routeData = {
            ok: true,
            origin: { name: '人民广场', location: '121.47519,31.228833' },
            destination: args.destination,
            selectedRoute: {
              transportMode: 'driving',
              distanceM: 21000,
              durationSec: 2400,
              polyline: '',
              steps: []
            }
          }
          return createToolExecutionOutput(JSON.stringify(routeData), {
            shape: 'json',
            data: routeData
          })
        }
        const ambiguousData = {
          ok: false,
          errorKind: 'place_ambiguous',
          message: '终点“上海虹桥火车站”存在多个可能地点，请选择一个。',
          candidates: [
            {
              name: '上海市闵行区上海虹桥火车站',
              address: '上海市闵行区上海虹桥火车站',
              location: '121.320011,31.194416',
              city: '上海市',
              district: '闵行区'
            },
            {
              name: '上海虹桥站',
              address: '上海市闵行区申贵路',
              location: '121.31881,31.19449',
              city: '上海市',
              district: '闵行区'
            }
          ]
        }
        return createToolExecutionOutput(JSON.stringify(ambiguousData), {
          shape: 'json',
          data: ambiguousData
        })
      }
      if (toolName === 'ask_user_questions') {
        const questions = Array.isArray(args.questions) ? args.questions : []
        assert.equal(questions.length, 1)
        const question = questions[0] as { id?: string; kind?: string; options?: string[] }
        assert.equal(question.id, 'map_place_choice')
        assert.equal(question.kind, 'single_choice')
        assert.ok(Array.isArray(question.options))
        selectedOption = question.options![0]!
        assert.match(selectedOption, /121\.320011,31\.194416/)
        return createToolExecutionOutput(`用户回答了 1/1 个问题：${selectedOption}`, {
          shape: 'json',
          data: {
            cardId: 'ask-card-1',
            askedAt: Date.now(),
            answeredAt: Date.now(),
            answers: [
              {
                id: 'map_place_choice',
                question: '请选择地点',
                kind: 'single_choice',
                answer: selectedOption
              }
            ]
          }
        })
      }
      throw new Error(`unexpected tool: ${toolName}`)
    },
    runAgent: async ({ input, onTextDelta }) => {
      runCount += 1
      if (runCount === 1) {
        const toolCall = [
          ':::tool_call',
          JSON.stringify({
            tool: 'map_plan_route',
            args: {
              city: '上海',
              origin: '人民广场',
              destination: '上海虹桥火车站',
              transportMode: 'driving'
            }
          }),
          ':::'
        ].join('\n')
        onTextDelta(toolCall)
        return { finalText: toolCall }
      }
      assert.match(String(input), /ask_user_questions/)
      assert.match(String(input), /121\.320011,31\.194416/)
      onTextDelta('路线已经按你选择的虹桥火车站规划好。')
      return { finalText: '路线已经按你选择的虹桥火车站规划好。' }
    }
  })
  runtime.newSession('butler::scope-map-ambiguity', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-map-ambiguity',
    '从人民广场到虹桥火车站怎么走？',
    'run-map-ambiguity',
    {
      publicSessionId: 'scope-map-ambiguity',
      taskId: 'task-map-ambiguity'
    }
  )

  assert.equal(result.success, true)
  assert.equal(runCount, 2)
  assert.deepEqual(
    calls.map((call) => call.toolName),
    ['map_plan_route', 'ask_user_questions', 'map_plan_route']
  )
  assert.deepEqual(result.usedTools, ['map_plan_route', 'ask_user_questions', 'map_plan_route'])
  assert.match(result.finalText, /路线已经按你选择/)
})

test('agent sdk runtime closes failed map retry after place disambiguation', async () => {
  const mapTool = createToolDefinition({
    name: 'map_plan_route',
    groupId: 'map_planning',
    domain: 'map',
    kind: 'write',
    description: 'Plan map route',
    schema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        origin: {},
        destination: {}
      },
      required: ['origin', 'destination'],
      additionalProperties: false
    }
  })
  const askTool = createToolDefinition({
    name: 'ask_user_questions',
    groupId: 'agent_interaction',
    domain: 'agent_interaction',
    kind: 'write',
    description: 'Ask user questions',
    schema: {
      type: 'object',
      properties: { questions: { type: 'array' } },
      required: ['questions'],
      additionalProperties: false
    }
  })
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = []
  let runCount = 0
  const runtime = createRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'openai-compatible',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
        model: 'mimo-v2.5',
        agentProtocol: 'anthropic'
      }
    }),
    listToolDefinitions: () => [mapTool, askTool],
    executeToolCall: async (toolName, args) => {
      calls.push({ toolName, args })
      if (toolName === 'map_plan_route') {
        if (typeof args.destination === 'object' && args.destination !== null) {
          const data = {
            ok: false,
            errorKind: 'route_not_found',
            message: '高德地图未返回可用路线。'
          }
          return createToolExecutionOutput(JSON.stringify(data), { shape: 'json', data })
        }
        const data = {
          ok: false,
          errorKind: 'place_ambiguous',
          message: '终点“上海虹桥火车站”存在多个可能地点，请选择一个。',
          candidates: [
            {
              name: '上海市闵行区上海虹桥火车站',
              address: '上海市闵行区上海虹桥火车站',
              location: '121.320011,31.194416',
              city: '上海市',
              district: '闵行区'
            },
            {
              name: '上海虹桥站',
              address: '上海市闵行区申贵路',
              location: '121.31881,31.19449',
              city: '上海市',
              district: '闵行区'
            }
          ]
        }
        return createToolExecutionOutput(JSON.stringify(data), { shape: 'json', data })
      }
      if (toolName === 'ask_user_questions') {
        const questions = Array.isArray(args.questions) ? args.questions : []
        const question = questions[0] as { id?: string; options?: string[] }
        const selected = question.options?.[0] || ''
        assert.equal(question.id, 'map_place_choice')
        assert.match(selected, /121\.320011,31\.194416/)
        return createToolExecutionOutput(`用户回答了 1/1 个问题：${selected}`, {
          shape: 'json',
          data: {
            answers: [
              {
                id: 'map_place_choice',
                question: '请选择地点',
                kind: 'single_choice',
                answer: selected
              }
            ]
          }
        })
      }
      throw new Error(`unexpected tool: ${toolName}`)
    },
    runAgent: async ({ input, onTextDelta }) => {
      runCount += 1
      if (runCount > 1) {
        throw new Error(
          `map retry failure should close before returning to the model: ${String(input)}`
        )
      }
      const toolCall = [
        ':::tool_call',
        JSON.stringify({
          tool: 'map_plan_route',
          args: {
            city: '上海',
            origin: '人民广场',
            destination: '上海虹桥火车站'
          }
        }),
        ':::'
      ].join('\n')
      onTextDelta(toolCall)
      return { finalText: toolCall }
    }
  })
  runtime.newSession('butler::scope-map-retry-failure', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-map-retry-failure',
    '从人民广场到虹桥火车站怎么走？',
    'run-map-retry-failure',
    {
      publicSessionId: 'scope-map-retry-failure',
      taskId: 'task-map-retry-failure'
    }
  )

  assert.equal(result.success, false)
  assert.equal(result.terminalReason, 'blocked_tool_error')
  assert.equal(result.error, '高德地图未返回可用路线。')
  assert.equal(runCount, 1)
  assert.deepEqual(
    calls.map((call) => call.toolName),
    ['map_plan_route', 'ask_user_questions', 'map_plan_route']
  )
})

test('agent sdk native tool path asks for map place choice before returning to the model', async () => {
  const mapTool = createToolDefinition({
    name: 'map_plan_route',
    groupId: 'map_planning',
    domain: 'map',
    kind: 'write',
    description: 'Plan map route',
    schema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        origin: {},
        destination: {}
      },
      required: ['origin', 'destination'],
      additionalProperties: false
    }
  })
  const askTool = createToolDefinition({
    name: 'ask_user_questions',
    groupId: 'agent_interaction',
    domain: 'agent_interaction',
    kind: 'write',
    description: 'Ask user questions',
    schema: {
      type: 'object',
      properties: { questions: { type: 'array' } },
      required: ['questions'],
      additionalProperties: false
    }
  })
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = []
  const runtime = createRuntime({
    listToolDefinitions: () => [mapTool, askTool],
    executeToolCall: async (toolName, args) => {
      calls.push({ toolName, args })
      if (toolName === 'map_plan_route') {
        if (typeof args.destination === 'object' && args.destination !== null) {
          const data = {
            ok: true,
            origin: { name: '人民广场', location: '121.47519,31.228833' },
            destination: args.destination,
            selectedRoute: {
              transportMode: 'driving',
              distanceM: 18800,
              durationSec: 1920,
              polyline: '',
              steps: []
            }
          }
          return createToolExecutionOutput(JSON.stringify(data), { shape: 'json', data })
        }
        const data = {
          ok: false,
          errorKind: 'place_ambiguous',
          message: '终点“虹桥火车站”存在多个可能地点，请选择一个。',
          candidates: [
            {
              name: '上海市闵行区虹桥火车站(地铁站)',
              address: '上海市闵行区虹桥火车站(地铁站)',
              location: '121.318910,31.193987',
              city: '上海市',
              district: '闵行区'
            },
            {
              name: '虹桥火车站P9停车场',
              address: '上海市闵行区申虹路',
              location: '121.321110,31.194220',
              city: '上海市',
              district: '闵行区'
            }
          ]
        }
        return createToolExecutionOutput(JSON.stringify(data), { shape: 'json', data })
      }
      if (toolName === 'ask_user_questions') {
        const questions = Array.isArray(args.questions) ? args.questions : []
        const question = questions[0] as { id?: string; options?: string[] }
        assert.equal(question.id, 'map_place_choice')
        const selected = question.options?.[0] || ''
        assert.match(selected, /121\.318910,31\.193987/)
        return createToolExecutionOutput(`用户回答了 1/1 个问题：${selected}`, {
          shape: 'json',
          data: {
            answers: [
              {
                id: 'map_place_choice',
                question: '请选择地点',
                kind: 'single_choice',
                answer: selected
              }
            ]
          }
        })
      }
      throw new Error(`unexpected tool: ${toolName}`)
    },
    runAgent: async ({ tools, onTextDelta }) => {
      const mapSdkTool = tools.find((item) => item.name === 'map_plan_route') as
        | { invoke: (context: unknown, input: string) => Promise<string> }
        | undefined
      assert.ok(mapSdkTool)
      const toolOutput = await mapSdkTool.invoke(
        {},
        JSON.stringify({
          city: '上海',
          origin: '人民广场',
          destination: '虹桥火车站'
        })
      )
      assert.match(toolOutput, /ask_user_questions/)
      assert.match(toolOutput, /121\.318910,31\.193987/)
      assert.match(toolOutput, /"ok":true/)
      onTextDelta('已按用户选择的地点规划路线。')
      return { finalText: '已按用户选择的地点规划路线。' }
    }
  })
  runtime.newSession('butler::scope-map-native-ambiguity', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-map-native-ambiguity',
    '从人民广场到虹桥火车站怎么走？',
    'run-map-native-ambiguity',
    {
      publicSessionId: 'scope-map-native-ambiguity',
      taskId: 'task-map-native-ambiguity'
    }
  )

  assert.equal(result.success, true)
  assert.deepEqual(
    calls.map((call) => call.toolName),
    ['map_plan_route', 'ask_user_questions', 'map_plan_route']
  )
  assert.match(result.finalText, /用户选择/)
})

test('agent sdk native tool path ignores malformed duplicate map ambiguity ask after card handling', async () => {
  const mapTool = createToolDefinition({
    name: 'map_plan_route',
    groupId: 'map_planning',
    domain: 'map',
    kind: 'write',
    description: 'Plan map route',
    schema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        origin: {},
        destination: {}
      },
      required: ['origin', 'destination'],
      additionalProperties: false
    }
  })
  const askTool = createToolDefinition({
    name: 'ask_user_questions',
    groupId: 'agent_interaction',
    domain: 'agent_interaction',
    kind: 'write',
    description: 'Ask user questions',
    schema: {
      type: 'object',
      properties: { questions: { type: 'array' } },
      required: ['questions'],
      additionalProperties: false
    }
  })
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = []
  const runtime = createRuntime({
    listToolDefinitions: () => [mapTool, askTool],
    executeToolCall: async (toolName, args) => {
      calls.push({ toolName, args })
      if (toolName === 'map_plan_route') {
        if (typeof args.destination === 'object' && args.destination !== null) {
          const data = {
            ok: true,
            origin: { name: '人民广场', location: '121.47519,31.228833' },
            destination: args.destination,
            selectedRoute: {
              transportMode: 'driving',
              distanceM: 18800,
              durationSec: 1920,
              polyline: '',
              steps: []
            }
          }
          return createToolExecutionOutput(JSON.stringify(data), { shape: 'json', data })
        }
        const data = {
          ok: false,
          errorKind: 'place_ambiguous',
          message: '终点“虹桥火车站”存在多个可能地点，请选择一个。',
          candidates: [
            {
              name: '上海市闵行区虹桥火车站(地铁站)',
              address: '上海市闵行区虹桥火车站(地铁站)',
              location: '121.318910,31.193987',
              city: '上海市',
              district: '闵行区'
            },
            {
              name: '虹桥火车站P9停车场',
              address: '上海市闵行区申虹路',
              location: '121.321110,31.194220',
              city: '上海市',
              district: '闵行区'
            }
          ]
        }
        return createToolExecutionOutput(JSON.stringify(data), { shape: 'json', data })
      }
      if (toolName === 'ask_user_questions') {
        const questions = Array.isArray(args.questions) ? args.questions : []
        const question = questions[0] as { id?: string; options?: string[] }
        const selected = question.options?.[0] || ''
        assert.equal(question.id, 'map_place_choice')
        assert.match(selected, /121\.318910,31\.193987/)
        return createToolExecutionOutput(`用户回答了 1/1 个问题：${selected}`, {
          shape: 'json',
          data: {
            answers: [
              {
                id: 'map_place_choice',
                question: '请选择地点',
                kind: 'single_choice',
                answer: selected
              }
            ]
          }
        })
      }
      throw new Error(`unexpected tool: ${toolName}`)
    },
    runAgent: async ({ tools, onTextDelta }) => {
      const mapSdkTool = tools.find((item) => item.name === 'map_plan_route') as
        | { invoke: (context: unknown, input: string) => Promise<string> }
        | undefined
      const askSdkTool = tools.find((item) => item.name === 'ask_user_questions') as
        | { invoke: (context: unknown, input: string) => Promise<string> }
        | undefined
      assert.ok(mapSdkTool)
      assert.ok(askSdkTool)
      const routeOutput = await mapSdkTool.invoke(
        {},
        JSON.stringify({
          city: '上海',
          origin: '人民广场',
          destination: '虹桥火车站'
        })
      )
      assert.match(routeOutput, /ask_user_questions/)
      assert.match(routeOutput, /"ok":true/)

      const duplicateAskOutput = await askSdkTool.invoke(
        {},
        JSON.stringify({
          questions: '请选择一个虹桥火车站候选项'
        })
      )
      assert.match(duplicateAskOutput, /map_ambiguity_already_resolved/)

      onTextDelta('已按用户选择的地点规划路线。')
      return { finalText: '已按用户选择的地点规划路线。' }
    }
  })
  runtime.newSession('butler::scope-map-native-duplicate-ask', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-map-native-duplicate-ask',
    '从人民广场到虹桥火车站怎么走？',
    'run-map-native-duplicate-ask',
    {
      publicSessionId: 'scope-map-native-duplicate-ask',
      taskId: 'task-map-native-duplicate-ask'
    }
  )

  assert.equal(result.success, true)
  assert.deepEqual(
    calls.map((call) => call.toolName),
    ['map_plan_route', 'ask_user_questions', 'map_plan_route']
  )
  assert.match(result.finalText, /用户选择/)
})

test('agent sdk native tool path closes failed map retry after place disambiguation', async () => {
  const mapTool = createToolDefinition({
    name: 'map_plan_route',
    groupId: 'map_planning',
    domain: 'map',
    kind: 'write',
    description: 'Plan map route',
    schema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        origin: {},
        destination: {}
      },
      required: ['origin', 'destination'],
      additionalProperties: false
    }
  })
  const askTool = createToolDefinition({
    name: 'ask_user_questions',
    groupId: 'agent_interaction',
    domain: 'agent_interaction',
    kind: 'write',
    description: 'Ask user questions',
    schema: {
      type: 'object',
      properties: { questions: { type: 'array' } },
      required: ['questions'],
      additionalProperties: false
    }
  })
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = []
  const runtime = createRuntime({
    listToolDefinitions: () => [mapTool, askTool],
    executeToolCall: async (toolName, args) => {
      calls.push({ toolName, args })
      if (toolName === 'map_plan_route') {
        if (typeof args.destination === 'object' && args.destination !== null) {
          const data = {
            ok: false,
            errorKind: 'route_not_found',
            message: '高德地图未返回可用路线。'
          }
          return createToolExecutionOutput(JSON.stringify(data), { shape: 'json', data })
        }
        const data = {
          ok: false,
          errorKind: 'place_ambiguous',
          message: '终点“虹桥火车站”存在多个可能地点，请选择一个。',
          candidates: [
            {
              name: '上海市闵行区虹桥火车站(地铁站)',
              address: '上海市闵行区虹桥火车站(地铁站)',
              location: '121.318910,31.193987',
              city: '上海市',
              district: '闵行区'
            },
            {
              name: '虹桥火车站P9停车场',
              address: '上海市闵行区申虹路',
              location: '121.321110,31.194220',
              city: '上海市',
              district: '闵行区'
            }
          ]
        }
        return createToolExecutionOutput(JSON.stringify(data), { shape: 'json', data })
      }
      if (toolName === 'ask_user_questions') {
        const questions = Array.isArray(args.questions) ? args.questions : []
        const question = questions[0] as { id?: string; options?: string[] }
        const selected = question.options?.[0] || ''
        assert.equal(question.id, 'map_place_choice')
        assert.match(selected, /121\.318910,31\.193987/)
        return createToolExecutionOutput(`用户回答了 1/1 个问题：${selected}`, {
          shape: 'json',
          data: {
            answers: [
              {
                id: 'map_place_choice',
                question: '请选择地点',
                kind: 'single_choice',
                answer: selected
              }
            ]
          }
        })
      }
      throw new Error(`unexpected tool: ${toolName}`)
    },
    runAgent: async ({ tools, onTextDelta }) => {
      const mapSdkTool = tools.find((item) => item.name === 'map_plan_route') as
        | { invoke: (context: unknown, input: string) => Promise<string> }
        | undefined
      assert.ok(mapSdkTool)
      const toolOutput = await mapSdkTool.invoke(
        {},
        JSON.stringify({
          city: '上海',
          origin: '人民广场',
          destination: '虹桥火车站'
        })
      )
      assert.match(toolOutput, /ask_user_questions/)
      assert.match(toolOutput, /"ok":false/)
      onTextDelta('已按用户选择的地点规划路线。')
      return { finalText: '已按用户选择的地点规划路线。' }
    }
  })
  runtime.newSession('butler::scope-map-native-retry-failure', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-map-native-retry-failure',
    '从人民广场到虹桥火车站怎么走？',
    'run-map-native-retry-failure',
    {
      publicSessionId: 'scope-map-native-retry-failure',
      taskId: 'task-map-native-retry-failure'
    }
  )

  assert.equal(result.success, false)
  assert.equal(result.terminalReason, 'blocked_tool_error')
  assert.equal(result.error, '高德地图未返回可用路线。')
  assert.deepEqual(
    calls.map((call) => call.toolName),
    ['map_plan_route', 'ask_user_questions', 'map_plan_route']
  )
})

test('agent sdk native tool path clears stale map failure after later success', async () => {
  const mapTool = createToolDefinition({
    name: 'map_plan_route',
    groupId: 'map_planning',
    domain: 'map',
    kind: 'write',
    description: 'Plan map route',
    schema: {
      type: 'object',
      properties: {
        origin: {},
        destination: {}
      },
      required: ['origin', 'destination'],
      additionalProperties: false
    }
  })
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = []
  const runtime = createRuntime({
    listToolDefinitions: () => [mapTool],
    executeToolCall: async (toolName, args) => {
      calls.push({ toolName, args })
      if (toolName !== 'map_plan_route') {
        throw new Error(`unexpected tool: ${toolName}`)
      }
      if (calls.length === 1) {
        const data = {
          ok: false,
          errorKind: 'route_not_found',
          message: '第一次路线失败。'
        }
        return createToolExecutionOutput(JSON.stringify(data), { shape: 'json', data })
      }
      const data = {
        ok: true,
        origin: { name: '人民广场', location: '121.47519,31.228833' },
        destination: { name: '虹桥火车站', location: '121.31891,31.193987' },
        selectedRoute: {
          transportMode: 'driving',
          distanceM: 18800,
          durationSec: 1920,
          polyline: '',
          steps: []
        }
      }
      return createToolExecutionOutput(JSON.stringify(data), { shape: 'json', data })
    },
    runAgent: async ({ tools, onTextDelta }) => {
      const mapSdkTool = tools.find((item) => item.name === 'map_plan_route') as
        | { invoke: (context: unknown, input: string) => Promise<string> }
        | undefined
      assert.ok(mapSdkTool)
      const first = await mapSdkTool.invoke(
        {},
        JSON.stringify({
          origin: '人民广场',
          destination: '不存在的目的地'
        })
      )
      assert.match(first, /route_not_found/)
      const second = await mapSdkTool.invoke(
        {},
        JSON.stringify({
          origin: '人民广场',
          destination: '虹桥火车站'
        })
      )
      assert.match(second, /"ok":true/)
      onTextDelta('第二次路线已规划好。')
      return { finalText: '第二次路线已规划好。' }
    }
  })
  runtime.newSession('butler::scope-map-native-stale-close', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-map-native-stale-close',
    '先后尝试两条地图路线',
    'run-map-native-stale-close',
    {
      publicSessionId: 'scope-map-native-stale-close',
      taskId: 'task-map-native-stale-close'
    }
  )

  assert.equal(result.success, true)
  assert.equal(result.terminalReason, 'done')
  assert.equal(result.error, undefined)
  assert.equal(result.finalText, '第二次路线已规划好。')
  assert.deepEqual(
    calls.map((call) => call.toolName),
    ['map_plan_route', 'map_plan_route']
  )
})

test('agent sdk runtime emits tool trace truth and registers run cleanup', async () => {
  const toolDefinition = createToolDefinition({ description: 'Search the web' })
  const outputEvents: Array<Record<string, unknown>> = []
  const scopeEvents: Array<Record<string, unknown>> = []
  const cleanups: Array<{ runId: string; cleanup: () => void | Promise<void> }> = []
  const runtime = createRuntime({
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async (_toolName, _args, context) => {
      context.registerRunCleanup?.(() => undefined)
      return createToolExecutionOutput('found result', {
        shape: 'json',
        data: { ok: true },
        projectionPatch: {
          taskTitle: 'Research',
          taskSummary: 'Search done'
        }
      })
    },
    runAgent: async ({ tools, onTextDelta }) => {
      const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      await sdkTool.invoke({}, JSON.stringify({ query: 'Agents SDK' }))
      onTextDelta('研究完成')
      return { finalText: '研究完成' }
    }
  })
  runtime.setRunCleanupRegistry({
    registerRunCleanup: (runId, cleanup) => {
      cleanups.push({ runId, cleanup })
    }
  })
  runtime.setRuntime({
    getConversationScope: () => null,
    publishScopeRunEvent: (payload: unknown, projectionTruth?: unknown) => {
      scopeEvents.push({ payload, projectionTruth })
    }
  } as never)
  runtime.on('output', (event) => outputEvents.push(event))
  runtime.newSession('butler::scope-host', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-host', '查一下资料', 'run-host', {
    publicSessionId: 'scope-host',
    taskId: 'task-host'
  })

  assert.equal(result.success, true)
  assert.equal(result.finalText, '研究完成')
  assert.deepEqual(result.usedTools, ['web_search'])
  assert.equal(result.terminalReason, 'done')
  assert.equal(cleanups.length, 1)
  assert.equal(cleanups[0].runId, 'run-host')
  assert.deepEqual(result.projectionTruth?.projectionPatch, {
    taskTitle: 'Research',
    taskSummary: 'Search done'
  })
  assert.deepEqual(
    outputEvents
      .filter((entry) => entry.type === 'tool_use' || entry.type === 'tool_result')
      .map((entry) => entry.type),
    ['tool_use', 'tool_result']
  )
  // P0-3 (2026-07-02): planning heartbeats now share this channel; they must
  // carry NO toolEvent and precede the tool trace without disturbing it.
  const heartbeatEvents = scopeEvents.filter(
    (entry) => (entry.payload as { phase?: string }).phase === 'planning'
  )
  assert.ok(heartbeatEvents.length >= 2, 'planning heartbeats published before the model call')
  assert.ok(
    heartbeatEvents.every(
      (entry) => (entry.payload as { toolEvent?: unknown }).toolEvent === undefined
    )
  )
  const toolScopeEvents = scopeEvents.filter(
    (entry) => (entry.payload as { phase?: string }).phase !== 'planning'
  )
  assert.deepEqual(
    toolScopeEvents.map(
      (entry) =>
        (entry.payload as { phase?: string; toolEvent?: { kind?: string } }).toolEvent?.kind
    ),
    ['call', 'result']
  )
  assert.deepEqual(
    toolScopeEvents.map((entry) => (entry.payload as { phase?: string }).phase),
    ['tool_running', 'responding']
  )
})

test('agent sdk runtime uses Ready Anthropic model adapter with SDK tool loop', async () => {
  const toolDefinition = createToolDefinition({ description: 'Search the web' })
  const requests: Array<Record<string, unknown>> = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-haiku-3-5-20241022',
        agentProtocol: 'anthropic'
      }
    }),
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async () =>
      createToolExecutionOutput('found result at /Users/alice/Ready/out.txt', {
        shape: 'json',
        data: { ok: true, absolutePath: '/Users/alice/Ready/out.txt' },
        projectionPatch: {
          taskTitle: 'Research',
          runStatePath: '/Users/alice/Ready/run_state.json'
        }
      }),
    fetchWithTimeout: async (url, init) => {
      requests.push({
        url,
        body: JSON.parse(String(init.body || '{}')) as Record<string, unknown>
      })
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({
            id: 'msg-1',
            content: [
              {
                type: 'tool_use',
                id: 'toolu-1',
                name: 'web_search',
                input: { query: 'Agents SDK' }
              }
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 3 }
          }),
          { status: 200 }
        )
      }
      return new Response(
        JSON.stringify({
          id: 'msg-2',
          content: [{ type: 'text', text: '研究完成' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 12, output_tokens: 4 }
        }),
        { status: 200 }
      )
    }
  })
  runtime.newSession('butler::scope-anthropic', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-anthropic',
    '查一下资料',
    'run-anthropic',
    {
      publicSessionId: 'scope-anthropic',
      taskId: 'task-anthropic'
    }
  )

  assert.equal(result.success, true)
  assert.equal(result.finalText, '研究完成')
  assert.deepEqual(result.usedTools, ['web_search'])
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages')
  assert.ok(Array.isArray((requests[0].body as { tools?: unknown[] }).tools))
  const secondAnthropicMessages = JSON.stringify(
    (requests[1].body as { messages?: unknown[] }).messages
  )
  assert.match(secondAnthropicMessages, /function_call_result|tool_result|found result/)
  assert.doesNotMatch(secondAnthropicMessages, /\/Users\/alice/)
  assert.match(secondAnthropicMessages, /\/Users\/<redacted>\/Ready/)
  assert.deepEqual(result.projectionTruth?.projectionPatch, {
    taskTitle: 'Research',
    runStatePath: '/Users/alice/Ready/run_state.json'
  })
})

test('agent sdk runtime uses Ready OpenAI-compatible adapter and provider patchers', async () => {
  const toolDefinition = createToolDefinition({ description: 'Search the web' })
  const requests: Array<Record<string, unknown>> = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'openai-compatible',
        baseUrl: 'https://compat.example/v1',
        model: 'compat-chat',
        agentProtocol: 'openai',
        wireApi: 'chat/completions',
        toolUseMode: 'on'
      }
    }),
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async () =>
      createToolExecutionOutput('found result at C:\\Users\\alice\\Ready\\out.txt', {
        shape: 'json',
        data: { ok: true, absolutePath: 'C:\\Users\\alice\\Ready\\out.txt' },
        projectionPatch: {
          taskTitle: 'Compatible research',
          runStatePath: 'C:\\Users\\alice\\Ready\\run_state.json'
        }
      }),
    fetchWithTimeout: async (url, init) => {
      requests.push({
        url,
        body: JSON.parse(String(init.body || '{}')) as Record<string, unknown>
      })
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-1',
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: 'call-compat-1',
                      type: 'function',
                      function: {
                        name: 'web_search',
                        arguments: JSON.stringify({ query: 'Agents SDK' })
                      }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ],
            usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 }
          }),
          { status: 200 }
        )
      }
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-2',
          choices: [
            {
              message: { content: '兼容端完成' },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }
        }),
        { status: 200 }
      )
    }
  })
  runtime.newSession('butler::scope-compatible', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-compatible',
    '查一下资料',
    'run-compatible',
    {
      publicSessionId: 'scope-compatible',
      taskId: 'task-compatible'
    }
  )

  assert.equal(result.success, true)
  assert.equal(result.finalText, '兼容端完成')
  assert.deepEqual(result.usedTools, ['web_search'])
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://compat.example/v1/chat/completions')
  // P0-0 true SSE (2026-07-02): the wire request now legitimately streams,
  // so the openai-compatible provider-default patcher (openai-compatible.ts
  // stream_usage default) fires exactly as it always did on the streaming
  // execution clients — include_usage + the legacy stream_usage mirror.
  assert.equal((requests[0].body as Record<string, unknown>).stream, true)
  assert.deepEqual((requests[0].body as Record<string, unknown>).stream_options, {
    include_usage: true
  })
  assert.equal((requests[0].body as Record<string, unknown>).stream_usage, true)
  const secondCompatibleMessages = JSON.stringify(
    (requests[1].body as { messages?: unknown[] }).messages
  )
  assert.match(secondCompatibleMessages, /function_call_result|found result|tool/)
  assert.doesNotMatch(secondCompatibleMessages, /C:\\Users\\alice/)
  assert.match(secondCompatibleMessages, /<redacted>/)
  assert.match(secondCompatibleMessages, /Ready/)
  assert.deepEqual(result.projectionTruth?.projectionPatch, {
    taskTitle: 'Compatible research',
    runStatePath: 'C:\\Users\\alice\\Ready\\run_state.json'
  })
})

test('agent sdk runtime carries compatible reasoning content across tool turns', async () => {
  const toolDefinition = createToolDefinition({
    name: 'file_locate',
    groupId: 'file',
    domain: 'file',
    kind: 'read',
    description: 'Locate a referenced file',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string' }
      },
      required: ['query'],
      additionalProperties: false
    }
  })
  const requests: Array<Record<string, unknown>> = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'openai-compatible',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
        model: 'mimo-v2.5',
        agentProtocol: 'openai',
        wireApi: 'chat/completions',
        toolUseMode: 'on',
        thinkingMode: 'auto'
      }
    }),
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async () =>
      createToolExecutionOutput('定位失败：path_missing', {
        shape: 'json',
        data: { ok: false, error: 'path_missing' }
      }),
    fetchWithTimeout: async (url, init) => {
      requests.push({
        url,
        body: JSON.parse(String(init.body || '{}')) as Record<string, unknown>
      })
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-mimo-1',
            choices: [
              {
                message: {
                  content: '',
                  reasoning_content: '需要先定位文件中的第 2、3 章。',
                  tool_calls: [
                    {
                      id: 'call-mimo-1',
                      type: 'function',
                      function: {
                        name: 'file_locate',
                        arguments: JSON.stringify({ query: '白痴.md' })
                      }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
          }),
          { status: 200 }
        )
      }
      const body = requests[1].body as { messages?: Array<Record<string, unknown>> }
      const toolTurn = body.messages?.find(
        (message) => message.role === 'assistant' && Array.isArray(message.tool_calls)
      )
      assert.equal(toolTurn?.reasoning_content, '需要先定位文件中的第 2、3 章。')
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-mimo-2',
          choices: [
            {
              message: { content: '我没找到该文件，请重新选择附件。' },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
        }),
        { status: 200 }
      )
    }
  })
  runtime.newSession('butler::scope-mimo', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-mimo', '读取白痴.md', 'run-mimo', {
    publicSessionId: 'scope-mimo',
    taskId: 'task-mimo'
  })

  assert.equal(result.success, true)
  assert.equal(result.finalText, '我没找到该文件，请重新选择附件。')
  assert.deepEqual(result.usedTools, ['file_locate'])
  assert.equal(requests.length, 2)
})

test('agent sdk runtime carries anthropic thinking blocks across tool turns', async () => {
  const toolDefinition = createToolDefinition({
    name: 'file_locate',
    groupId: 'file',
    domain: 'file',
    kind: 'read',
    description: 'Locate a referenced file',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' }
      },
      required: ['path'],
      additionalProperties: false
    }
  })
  const requests: Array<Record<string, unknown>> = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'openai-compatible',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
        model: 'mimo-v2.5',
        agentProtocol: 'anthropic',
        toolUseMode: 'on',
        thinkingMode: 'auto'
      }
    }),
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async () =>
      createToolExecutionOutput('定位失败：path_missing', {
        shape: 'json',
        data: { ok: false, error: 'path_missing' }
      }),
    fetchWithTimeout: async (url, init) => {
      requests.push({
        url,
        body: JSON.parse(String(init.body || '{}')) as Record<string, unknown>
      })
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({
            id: 'msg-mimo-anthropic-1',
            role: 'assistant',
            type: 'message',
            content: [
              {
                type: 'thinking',
                thinking: '需要先定位文件中的第 2、3 章。',
                signature: 'thinking-signature-1'
              },
              {
                type: 'tool_use',
                id: 'call-mimo-anthropic-1',
                name: 'file_locate',
                input: { path: '白痴.md' }
              }
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 4 }
          }),
          { status: 200 }
        )
      }
      const body = requests[1].body as { messages?: Array<Record<string, unknown>> }
      const assistantTurn = body.messages?.find(
        (message) => message.role === 'assistant' && Array.isArray(message.content)
      )
      const content = assistantTurn?.content as Array<Record<string, unknown>> | undefined
      assert.equal(content?.[0]?.type, 'thinking')
      assert.equal(content?.[0]?.thinking, '需要先定位文件中的第 2、3 章。')
      assert.equal(content?.[0]?.signature, 'thinking-signature-1')
      assert.equal(content?.[1]?.type, 'tool_use')
      assert.equal(content?.[1]?.id, 'call-mimo-anthropic-1')
      return new Response(
        JSON.stringify({
          id: 'msg-mimo-anthropic-2',
          role: 'assistant',
          type: 'message',
          content: [{ type: 'text', text: '我没找到该文件，请重新选择附件。' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 12, output_tokens: 6 }
        }),
        { status: 200 }
      )
    }
  })
  runtime.newSession('butler::scope-mimo-anthropic', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-mimo-anthropic',
    '读取白痴.md',
    'run-mimo-anthropic',
    {
      publicSessionId: 'scope-mimo-anthropic',
      taskId: 'task-mimo-anthropic'
    }
  )

  assert.equal(result.success, true)
  assert.equal(result.finalText, '我没找到该文件，请重新选择附件。')
  assert.deepEqual(result.usedTools, ['file_locate'])
  assert.equal(requests.length, 2)
})

test('agent sdk runtime keeps browser tools hidden for local document attachment tasks', async () => {
  const requests: Array<Record<string, unknown>> = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'openai-compatible',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
        model: 'mimo-v2.5',
        agentProtocol: 'anthropic',
        toolUseMode: 'on'
      }
    }),
    executeToolCall: async (name) =>
      createToolExecutionOutput(name === 'file_read_excerpt' ? '已读取章节正文' : 'ok', {
        shape: 'json',
        data: { ok: true }
      }),
    fetchWithTimeout: async (url, init) => {
      const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>
      requests.push({ url, body })
      const toolNames = Array.isArray(body.tools)
        ? body.tools.map((item) => (item as { name?: string }).name)
        : []
      assert.equal(toolNames.includes('browser_navigate'), false)
      assert.equal(toolNames.includes('browser_click'), false)
      assert.equal(toolNames.includes('web_fetch'), false)
      assert.equal(toolNames.includes('web_search'), false)
      assert.equal(toolNames.includes('present_file'), false)
      assert.ok(
        toolNames.includes('file_locate') ||
          toolNames.some((name) => typeof name === 'string' && name.startsWith('document_'))
      )
      assert.equal(toolNames.includes('file_read_excerpt'), true)
      assert.match(String(body.system || ''), /必须先调用 file_read_excerpt/)
      assert.match(String(body.system || ''), /顺序大块读取/)
      assert.match(String(body.system || ''), /不要反复读取互相重叠/)
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({
            id: 'msg-doc-tools-1',
            role: 'assistant',
            type: 'message',
            content: [
              {
                type: 'tool_use',
                id: 'call-read-excerpt',
                name: 'file_read_excerpt',
                input: { path: '/tmp/白痴.md', anchor: '一' }
              }
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 4 }
          }),
          { status: 200 }
        )
      }
      return new Response(
        JSON.stringify({
          id: 'msg-doc-tools-2',
          role: 'assistant',
          type: 'message',
          // 完成陈述而非行动承诺：零工具收尾若用「我会…处理」会被行动宣告闸
          // 正当拦截（steer→checkpoint），那是闸的合同而非本测试的主题。
          content: [{ type: 'text', text: '已根据文档梳理完成人物关系。' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 4 }
        }),
        { status: 200 }
      )
    }
  })
  runtime.newSession('butler::scope-doc-no-browser', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-doc-no-browser',
    [
      '根据@[白痴.md]前 3 章的内容梳理人物关系',
      '',
      '--- 测试模式附件路径 ---',
      '以下路径来自测试 harness 注入，附件正文里的 https://example.com 或 浏览器 字样不能污染主指令路由。',
      '- 白痴.md: /tmp/白痴.md',
      '- 新文档.md: /tmp/新文档.md'
    ].join('\n'),
    'run-doc-no-browser',
    {
      publicSessionId: 'scope-doc-no-browser',
      taskId: 'task-doc-no-browser'
    }
  )

  assert.equal(result.success, true)
  assert.equal(result.finalText, '已根据文档梳理完成人物关系。')
  assert.equal(requests.length, 2)
})

test('agent sdk runtime repairs failed workspace excerpt by reading the active document section', async () => {
  const externalPath =
    '/Users/user/matrix-unpack/analysis/02-CEO主入口部门需求理解与任务分发流程规格书.md'
  const fileReadDefinition = createToolDefinition({
    name: 'file_read_excerpt',
    groupId: 'file_management',
    domain: 'file',
    kind: 'read',
    description: 'Read file excerpt',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' }, anchor: { type: 'string' } },
      required: ['path'],
      additionalProperties: false
    }
  })
  const documentReadDefinition = createToolDefinition({
    name: 'document_read_section',
    groupId: 'document',
    domain: 'document',
    kind: 'read',
    description: 'Read current document section',
    schema: {
      type: 'object',
      properties: { tabId: { type: 'string' }, range: { type: 'string' } },
      required: [],
      additionalProperties: false
    }
  })
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let runCount = 0
  const runtime = createRuntime({
    listToolDefinitions: () => [fileReadDefinition, documentReadDefinition],
    executeToolCall: async (name, args) => {
      calls.push({ name, args })
      if (name === 'file_read_excerpt') {
        return createToolExecutionOutput(
          `Error: path is outside any known workspace: ${externalPath}`,
          { shape: 'json', data: { ok: false, error: 'outside_workspace' } }
        )
      }
      return createToolExecutionOutput(
        [
          '已读取文档片段：02-CEO主入口部门需求理解与任务分发流程规格书.md（第 12-35 行，片段 1200 字）',
          '- tabId: current',
          '- 范围: section:3',
          '- 命中章节: 意图理解规格',
          '',
          '--- 文档片段开始 ---',
          '"Read the intent in the user language: what they said, what repetition or ambition implies, what outcome would help."',
          '--- 文档片段结束 ---'
        ].join('\n'),
        { shape: 'json', data: { ok: true } }
      )
    },
    runAgent: async ({ tools, instructions, input }) => {
      runCount += 1
      const byName = new Map(
        tools.map((tool) => [
          tool.name,
          tool as { invoke: (context: unknown, input: string) => Promise<string> }
        ])
      )
      assert.match(instructions, /document_read_section/)
      assert.match(instructions, /当前编辑器文档/)
      if (runCount === 1) {
        await byName.get('file_read_excerpt')?.invoke(
          {},
          JSON.stringify({
            path: externalPath,
            anchor: '第三部分'
          })
        )
        return {
          finalText: `文件 ${externalPath} 不在当前工作区索引范围内，请把第3章内容粘贴给我。`
        }
      }
      assert.match(JSON.stringify(input), /document_read_section/)
      await byName.get('document_read_section')?.invoke(
        {},
        JSON.stringify({
          tabId: 'current',
          range: 'section:3'
        })
      )
      return { finalText: '已读取第3部分，并会在英文原文下补中文意思。' }
    }
  })
  runtime.newSession('butler::scope-current-doc-section-repair', 'system prompt')
  const userText = [
    '这个第三部分下的英文内容附上中文意义在原英文提示词下',
    '',
    '## 环境信息',
    '- 当前模式: 文档模式',
    '',
    '### 当前文档上下文',
    '- 标题: 02-CEO主入口部门需求理解与任务分发流程规格书.md',
    `- 路径: ${externalPath}`,
    '- 类型: md',
    '- 字符数: 8000',
    '',
    '--- 文档摘要开始 ---',
    '2.2 文本通道',
    '...[文档摘要已截断]',
    '--- 文档摘要结束 ---'
  ].join('\n')
  const requestEnvelope = buildRequestEnvelope({ userText })

  const result = await runtime.sendMessage(
    'butler::scope-current-doc-section-repair',
    userText,
    'run-current-doc-section-repair',
    {
      publicSessionId: 'scope-current-doc-section-repair',
      taskId: 'task-current-doc-section-repair',
      requestEnvelope
    }
  )

  assert.equal(result.success, true)
  assert.equal(result.finalText, '已读取第3部分，并会在英文原文下补中文意思。')
  assert.deepEqual(
    calls.map((call) => call.name),
    ['file_read_excerpt', 'document_read_section']
  )
  assert.equal(calls[1]?.args.tabId, 'current')
  assert.equal(calls[1]?.args.range, 'section:3')
  assert.deepEqual(result.usedTools, ['file_read_excerpt', 'document_read_section'])
  assert.equal(runCount, 2)
})

test('agent sdk runtime does not require source excerpts when the only local document is the target', async () => {
  const openDefinition = createToolDefinition({
    name: 'document_open_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'read',
    description: 'Open document',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false
    }
  })
  const setContentDefinition = createToolDefinition({
    name: 'document_set_content',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Set document content',
    schema: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
      additionalProperties: false
    }
  })
  const saveDefinition = createToolDefinition({
    name: 'document_save_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Save document',
    schema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  })
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const runtime = createRuntime({
    listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
    executeToolCall: async (name, args) => {
      calls.push({ name, args })
      return createToolExecutionOutput(
        name === 'document_open_tab'
          ? 'opened target'
          : name === 'document_save_tab'
            ? 'saved target'
            : 'updated target',
        { shape: 'json', data: { ok: true } }
      )
    },
    runAgent: async ({ tools, onTextDelta }) => {
      const setContentTool = tools[0] as {
        invoke: (context: unknown, input: string) => Promise<string>
      }
      await setContentTool.invoke(
        {},
        JSON.stringify({ content: '# B1 渠道销售图表\n\n老客复购最高，线下活动最低。' })
      )
      onTextDelta('已根据内联数据生成图表文档。')
      return { finalText: '已根据内联数据生成图表文档。' }
    }
  })
  runtime.newSession('butler::scope-target-only-inline-data', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-target-only-inline-data',
    [
      '根据下面这组渠道销售数据，在@[B1-渠道销售图表.md]里做一个清楚的图表，并写一段结论。',
      '搜索广告 128，社交广告 96，内容种草 74，自然流量 112，老客复购 153，线下活动 41。',
      '',
      '--- 附件: B1-渠道销售图表.md ---',
      '- 路径: /tmp/B1-渠道销售图表.md'
    ].join('\n'),
    'run-target-only-inline-data',
    {
      publicSessionId: 'scope-target-only-inline-data',
      taskId: 'task-target-only-inline-data',
      requestEnvelope: {
        primaryInstruction:
          '根据下面这组渠道销售数据，在@[B1-渠道销售图表.md]里做一个清楚的图表，并写一段结论。',
        resources: [{ name: 'B1-渠道销售图表.md', path: '/tmp/B1-渠道销售图表.md' }]
      }
    }
  )

  assert.equal(result.success, true)
  assert.deepEqual(calls, [
    { name: 'document_open_tab', args: { path: '/tmp/B1-渠道销售图表.md' } },
    {
      name: 'document_set_content',
      args: { content: '# B1 渠道销售图表\n\n老客复购最高，线下活动最低。' }
    },
    { name: 'document_save_tab', args: {} }
  ])
})

test('agent sdk runtime autosaves the unique observed document target on continuation turns', async () => {
  const targetPath = '/tmp/世界杯视觉设计研究.md'
  const replaceDefinition = createToolDefinition({
    name: 'document_replace_exact',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Replace exact text',
    schema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        replacement: { type: 'string' }
      },
      required: ['target', 'replacement'],
      additionalProperties: false
    }
  })
  const saveDefinition = createToolDefinition({
    name: 'document_save_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Save document',
    schema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      additionalProperties: false
    }
  })
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const runtime = createRuntime({
    listToolDefinitions: () => [replaceDefinition, saveDefinition],
    executeToolCall: async (name, args) => {
      calls.push({ name, args })
      if (name === 'document_save_tab') {
        return createToolExecutionOutput(`已保存文档：${targetPath}`, {
          shape: 'json',
          data: {
            ok: true,
            documentSaved: true,
            document: {
              tabId: 'doc-world-cup',
              title: '世界杯视觉设计研究.md',
              path: targetPath,
              dirty: false,
              requiresSave: false,
              saveState: 'saved'
            }
          }
        })
      }
      return createToolExecutionOutput('已精准替换第 1 处目标片段（世界杯视觉设计研究.md）', {
        shape: 'json',
        data: {
          ok: true,
          mutated: true,
          mutationReason: 'changed',
          document: {
            tabId: 'doc-world-cup',
            title: '世界杯视觉设计研究.md',
            path: targetPath,
            dirty: true,
            requiresSave: true,
            saveState: 'dirty'
          }
        }
      })
    },
    runAgent: async ({ tools, onTextDelta }) => {
      const replaceTool = tools.find((tool) => tool.name === 'document_replace_exact') as {
        invoke: (context: unknown, input: string) => Promise<string>
      }
      await replaceTool.invoke(
        {},
        JSON.stringify({
          target: '文化典故（深度解读）：',
          replacement: '文化典故（深度解读）：\n\n补充后的内容。'
        })
      )
      onTextDelta('已继续补充文档。')
      return { finalText: '已继续补充文档。' }
    }
  })
  const runMeta = attachMemoryRunMeta(runtime)
  runtime.newSession('butler::scope-observed-doc-autosave', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-observed-doc-autosave',
    '继续',
    'run-observed-doc-autosave',
    {
      publicSessionId: 'scope-observed-doc-autosave',
      taskId: 'task-observed-doc-autosave',
      taskBudgetRuntime: createTaskBudgetRuntime('short_task'),
      requestEnvelope: { primaryInstruction: '继续', resources: [] }
    }
  )

  assert.equal(result.success, true)
  assert.deepEqual(calls, [
    {
      name: 'document_replace_exact',
      args: {
        target: '文化典故（深度解读）：',
        replacement: '文化典故（深度解读）：\n\n补充后的内容。'
      }
    },
    { name: 'document_save_tab', args: { tabId: 'doc-world-cup' } }
  ])
  assert.match(result.finalText, /已保存文档/)
  assert.equal(runMeta.get('run-observed-doc-autosave')?.lastMessageText, result.finalText)
  assert.equal(result.executionDiagnostics?.taskBudgetRuntime?.usage.toolCallsUsed, 2)
})

test('agent sdk runtime allows rewrite tasks that preserve meaning without preserving exact old lines', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-agent-sdk-meaning-'))
  const targetPath = join(tmpRoot, 'E2-提案草稿.md')
  await writeFile(
    targetPath,
    '# 草稿\n\n这个方案挺好的，但是有点乱。这个目标要重复说一下，目标是提高报名。\n',
    'utf-8'
  )
  try {
    const openDefinition = createToolDefinition({
      name: 'document_open_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'read',
      description: 'Open document',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      }
    })
    const setContentDefinition = createToolDefinition({
      name: 'document_set_content',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Set document content',
      schema: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
        additionalProperties: false
      }
    })
    const saveDefinition = createToolDefinition({
      name: 'document_save_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Save document',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    })
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const runtime = createRuntime({
      listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
      executeToolCall: async (name, args) => {
        calls.push({ name, args })
        if (name === 'document_set_content') {
          await writeFile(targetPath, String(args.content || ''), 'utf-8')
        }
        return createToolExecutionOutput(
          name === 'document_open_tab'
            ? 'opened target'
            : name === 'document_save_tab'
              ? 'saved target'
              : 'updated target',
          { shape: 'json', data: { ok: true } }
        )
      },
      runAgent: async ({ tools, onTextDelta }) => {
        const setContentTool = tools[0] as {
          invoke: (context: unknown, input: string) => Promise<string>
        }
        await setContentTool.invoke(
          {},
          JSON.stringify({
            content: '# 正式提案\n\n## 目标\n\n通过更清晰的活动方案提升报名转化。'
          })
        )
        onTextDelta('已改写为正式提案。')
        return { finalText: '已改写为正式提案。' }
      }
    })
    runtime.newSession('butler::scope-doc-preserve-meaning', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-doc-preserve-meaning',
      [
        '把@[E2-提案草稿.md]改得更像正式提案，保留原意，删掉重复内容。',
        '',
        '--- 附件: E2-提案草稿.md ---',
        `- 路径: ${targetPath}`
      ].join('\n'),
      'run-doc-preserve-meaning',
      {
        publicSessionId: 'scope-doc-preserve-meaning',
        taskId: 'task-doc-preserve-meaning',
        requestEnvelope: {
          primaryInstruction: '把@[E2-提案草稿.md]改得更像正式提案，保留原意，删掉重复内容。',
          resources: [{ name: 'E2-提案草稿.md', path: targetPath }]
        }
      }
    )

    assert.equal(result.success, true)
    assert.deepEqual(
      calls.map((call) => call.name),
      ['document_open_tab', 'document_set_content', 'document_save_tab']
    )
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('agent sdk runtime repairs new document turns that mutate without saving', async () => {
  const newTabDefinition = createToolDefinition({
    name: 'document_new_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Create document',
    schema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false
    }
  })
  const insertWidgetDefinition = createToolDefinition({
    name: 'document_insert_widget',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Insert widget',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        position: { type: 'string' },
        widgetCode: { type: 'string' }
      },
      required: ['title', 'widgetCode'],
      additionalProperties: false
    }
  })
  const saveDefinition = createToolDefinition({
    name: 'document_save_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Save document',
    schema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  })
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const runInputs: unknown[] = []
  let runCount = 0
  const runtime = createRuntime({
    listToolDefinitions: () => [newTabDefinition, insertWidgetDefinition, saveDefinition],
    executeToolCall: async (name, args) => {
      calls.push({ name, args })
      return createToolExecutionOutput(
        name === 'document_save_tab'
          ? '已另存文档：/tmp/A1-人物关系图.md'
          : name === 'document_new_tab'
            ? '已创建文档标签：A1-人物关系图'
            : '已在文档尾部插入 widget（人物关系图）',
        { shape: 'json', data: { ok: true } }
      )
    },
    runAgent: async ({ tools, input, onTextDelta }) => {
      runInputs.push(input)
      runCount += 1
      const byName = new Map(
        tools.map((tool) => [
          tool.name,
          tool as { invoke: (context: unknown, input: string) => Promise<string> }
        ])
      )
      if (runCount === 1) {
        await byName.get('document_new_tab')?.invoke({}, JSON.stringify({ title: 'A1-人物关系图' }))
        await byName.get('document_insert_widget')?.invoke(
          {},
          JSON.stringify({
            title: '人物关系图',
            position: 'end',
            widgetCode: '{"type":"relationship-map"}'
          })
        )
        return { finalText: '' }
      }
      assert.match(String(input), /还没有调用 document_save_tab 保存/)
      onTextDelta('我会保存当前文档。')
      return { finalText: '我会保存当前文档。' }
    }
  })
  runtime.newSession('butler::scope-new-doc-save-repair', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-new-doc-save-repair',
    '新建一份《白痴》前 3 章人物关系图文档',
    'run-new-doc-save-repair',
    {
      publicSessionId: 'scope-new-doc-save-repair',
      taskId: 'task-new-doc-save-repair'
    }
  )

  assert.equal(result.success, true)
  assert.equal(runCount, 2)
  assert.match(result.finalText, /已另存文档/)
  assert.match(result.finalText, /我会保存当前文档/)
  assert.deepEqual(calls, [
    { name: 'document_new_tab', args: { title: 'A1-人物关系图' } },
    {
      name: 'document_insert_widget',
      args: { title: '人物关系图', position: 'end', widgetCode: '{"type":"relationship-map"}' }
    },
    { name: 'document_save_tab', args: {} }
  ])
})

test('agent sdk runtime anchors explicit target document instead of exposing new-tab writes', async () => {
  const requests: Array<Record<string, unknown>> = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'openai-compatible',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
        model: 'mimo-v2.5',
        agentProtocol: 'anthropic',
        toolUseMode: 'on'
      }
    }),
    fetchWithTimeout: async (url, init) => {
      const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>
      requests.push({ url, body })
      const toolNames = Array.isArray(body.tools)
        ? body.tools.map((item) => (item as { name?: string }).name)
        : []
      assert.equal(toolNames.includes('document_new_tab'), false)
      assert.equal(toolNames.includes('document_open_tab'), true)
      assert.equal(toolNames.includes('document_save_tab'), true)
      assert.equal(toolNames.includes('web_fetch'), false)
      assert.equal(toolNames.includes('web_search'), false)
      assert.match(String(body.system || ''), /\/tmp\/新文档\.md/)
      assert.match(String(body.system || ''), /不要新建临时文档/)
      return new Response(
        JSON.stringify({
          id: 'msg-doc-target-1',
          role: 'assistant',
          type: 'message',
          content: [{ type: 'text', text: '会写入目标文档。' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 4 }
        }),
        { status: 200 }
      )
    }
  })
  const runMeta = attachMemoryRunMeta(runtime)
  runtime.newSession('butler::scope-doc-target', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-doc-target',
    [
      '在@[新文档.md]里写入一段人物关系图占位内容',
      '',
      '--- 附件: 新文档.md ---',
      '- 路径: /tmp/新文档.md'
    ].join('\n'),
    'run-doc-target',
    {
      publicSessionId: 'scope-doc-target',
      taskId: 'task-doc-target'
    }
  )

  assert.equal(result.success, false)
  assert.equal(result.terminalReason, 'blocked_tool_error')
  assert.match(result.error || '', /目标文档/)
  assert.equal(requests.length, 2)
  // W10-F5（2026-07-11 dogfood）：守卫强制 error 终态不再丢弃模型的进展说明——
  // 失败语义由 status=error + terminalReason + 错误文案承担，正文保留供用户理解现场。
  assert.equal(runMeta.get('run-doc-target')?.lastMessageText, '会写入目标文档。')
})

test('agent sdk runtime opens explicit target document before the first mutation', async () => {
  const openDefinition = createToolDefinition({
    name: 'document_open_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'read',
    description: 'Open document',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' }
      },
      required: ['path'],
      additionalProperties: false
    }
  })
  const setContentDefinition = createToolDefinition({
    name: 'document_set_content',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Set document content',
    schema: {
      type: 'object',
      properties: {
        content: { type: 'string' }
      },
      required: ['content'],
      additionalProperties: false
    }
  })
  const saveDefinition = createToolDefinition({
    name: 'document_save_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Save document',
    schema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  })
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const runtime = createRuntime({
    listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
    executeToolCall: async (name, args) => {
      calls.push({ name, args })
      return createToolExecutionOutput(
        name === 'document_open_tab'
          ? 'opened target'
          : name === 'document_save_tab'
            ? 'saved target'
            : 'updated target',
        {
          shape: 'json',
          data: { ok: true }
        }
      )
    },
    runAgent: async ({ tools, onTextDelta }) => {
      const setContentTool = tools[0] as {
        invoke: (context: unknown, input: string) => Promise<string>
      }
      await setContentTool.invoke(
        {},
        JSON.stringify({ content: '人物关系图内容', tabId: 'draft-tab' })
      )
      onTextDelta('已写入目标文档')
      return { finalText: '已写入目标文档' }
    }
  })
  runtime.newSession('butler::scope-doc-auto-open', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-doc-auto-open',
    [
      '在@[新文档.md]里写入一段人物关系图占位内容',
      '',
      '--- 附件: 新文档.md ---',
      '- 路径: /tmp/新文档.md'
    ].join('\n'),
    'run-doc-auto-open',
    {
      publicSessionId: 'scope-doc-auto-open',
      taskId: 'task-doc-auto-open',
      requestEnvelope: {
        primaryInstruction: '在@[新文档.md]里写入一段人物关系图占位内容',
        resources: [{ name: '新文档.md', path: '/tmp/新文档.md' }]
      }
    }
  )

  assert.equal(result.success, true)
  assert.deepEqual(calls, [
    { name: 'document_open_tab', args: { path: '/tmp/新文档.md' } },
    { name: 'document_set_content', args: { content: '人物关系图内容' } },
    { name: 'document_save_tab', args: {} }
  ])
})

test('agent sdk runtime repairs explicit target turns that finish before writing', async () => {
  const openDefinition = createToolDefinition({
    name: 'document_open_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'read',
    description: 'Open document',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false
    }
  })
  const setContentDefinition = createToolDefinition({
    name: 'document_set_content',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Set document content',
    schema: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
      additionalProperties: false
    }
  })
  const saveDefinition = createToolDefinition({
    name: 'document_save_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Save document',
    schema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  })
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const runInputs: unknown[] = []
  let runCount = 0
  const runtime = createRuntime({
    listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
    executeToolCall: async (name, args) => {
      calls.push({ name, args })
      return createToolExecutionOutput(
        name === 'document_open_tab'
          ? 'opened target'
          : name === 'document_save_tab'
            ? 'saved target'
            : 'updated target',
        { shape: 'json', data: { ok: true } }
      )
    },
    runAgent: async ({ tools, input, onTextDelta }) => {
      runInputs.push(input)
      runCount += 1
      if (runCount === 1) {
        onTextDelta('我准备写入。')
        return { finalText: '我准备写入。' }
      }
      const setContentTool = tools[0] as {
        invoke: (context: unknown, input: string) => Promise<string>
      }
      await setContentTool.invoke({}, JSON.stringify({ content: '补救写入的人物关系图' }))
      onTextDelta('已写入目标文档。')
      return { finalText: '已写入目标文档。' }
    }
  })
  runtime.newSession('butler::scope-doc-repair-write', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-doc-repair-write',
    [
      '在@[新文档.md]里写入一段人物关系图占位内容',
      '',
      '--- 附件: 新文档.md ---',
      '- 路径: /tmp/新文档.md'
    ].join('\n'),
    'run-doc-repair-write',
    {
      publicSessionId: 'scope-doc-repair-write',
      taskId: 'task-doc-repair-write',
      requestEnvelope: {
        primaryInstruction: '在@[新文档.md]里写入一段人物关系图占位内容',
        resources: [{ name: '新文档.md', path: '/tmp/新文档.md' }]
      }
    }
  )

  assert.equal(result.success, true)
  assert.equal(runCount, 2)
  assert.match(String(runInputs[1]), /目标文档尚未发生实际写入/)
  assert.deepEqual(calls, [
    { name: 'document_open_tab', args: { path: '/tmp/新文档.md' } },
    { name: 'document_set_content', args: { content: '补救写入的人物关系图' } },
    { name: 'document_save_tab', args: {} }
  ])
})

test('agent sdk runtime does not count no-op section rewrites as target writes', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-agent-sdk-noop-rewrite-'))
  const targetPath = join(tmpRoot, '人物关系.md')
  await writeFile(targetPath, '# 一、背景\n\n原文。', 'utf-8')
  try {
    const openDefinition = createToolDefinition({
      name: 'document_open_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'read',
      description: 'Open document',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      }
    })
    const rewriteDefinition = createToolDefinition({
      name: 'document_rewrite_section',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Rewrite section',
      schema: {
        type: 'object',
        properties: {
          sectionTitle: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['sectionTitle', 'content'],
        additionalProperties: false
      }
    })
    const setContentDefinition = createToolDefinition({
      name: 'document_set_content',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Set document content',
      schema: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
        additionalProperties: false
      }
    })
    const saveDefinition = createToolDefinition({
      name: 'document_save_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Save document',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    })
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const runInputs: unknown[] = []
    let runCount = 0
    const runtime = createRuntime({
      listToolDefinitions: () => [
        rewriteDefinition,
        setContentDefinition,
        openDefinition,
        saveDefinition
      ],
      executeToolCall: async (name, args) => {
        calls.push({ name, args })
        if (name === 'document_set_content') {
          await writeFile(targetPath, String(args.content || ''), 'utf-8')
        }
        return createToolExecutionOutput(
          name === 'document_open_tab'
            ? 'opened target'
            : name === 'document_save_tab'
              ? 'saved target'
              : name === 'document_rewrite_section'
                ? '未找到章节“二、人物关系图”，未做改动'
                : 'updated target',
          { shape: 'json', data: { ok: true } }
        )
      },
      runAgent: async ({ tools, input, onTextDelta }) => {
        runInputs.push(input)
        runCount += 1
        const rewriteTool = tools[0] as {
          invoke: (context: unknown, input: string) => Promise<string>
        }
        const setContentTool = tools[1] as {
          invoke: (context: unknown, input: string) => Promise<string>
        }
        if (runCount === 1) {
          await rewriteTool.invoke(
            {},
            JSON.stringify({
              sectionTitle: '二、人物关系图',
              content: '修复后的人物关系图'
            })
          )
          onTextDelta('已完成。')
          return { finalText: '已完成。' }
        }
        await setContentTool.invoke(
          {},
          JSON.stringify({ content: '# 二、人物关系图\n\n修复后的人物关系图' })
        )
        onTextDelta('已真正写入目标文档。')
        return { finalText: '已真正写入目标文档。' }
      }
    })
    runtime.newSession('butler::scope-doc-noop-rewrite', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-doc-noop-rewrite',
      [
        '把@[人物关系.md]里的 Mermaid 段落改成可渲染版本',
        '',
        '--- 附件: 人物关系.md ---',
        `- 路径: ${targetPath}`
      ].join('\n'),
      'run-doc-noop-rewrite',
      {
        publicSessionId: 'scope-doc-noop-rewrite',
        taskId: 'task-doc-noop-rewrite',
        requestEnvelope: {
          primaryInstruction: '把@[人物关系.md]里的 Mermaid 段落改成可渲染版本',
          resources: [{ name: '人物关系.md', path: targetPath }]
        }
      }
    )

    assert.equal(result.success, true)
    assert.equal(runCount, 2)
    assert.match(String(runInputs[1]), /目标文档尚未发生实际写入/)
    assert.deepEqual(
      calls.map((call) => call.name),
      ['document_open_tab', 'document_rewrite_section', 'document_set_content', 'document_save_tab']
    )
    assert.match(await readFile(targetPath, 'utf-8'), /修复后的人物关系图/)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('agent sdk runtime blocks explicit target replacements that drop preserved content', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-agent-sdk-preserve-'))
  const targetPath = join(tmpRoot, 'A2-读书笔记.md')
  const initialContent = [
    '# 《白痴》读书笔记',
    '',
    '## 阅读目标',
    '',
    '这是一份原有笔记，请保留这一段。',
    '',
    '## 人物关系',
    '',
    '> 这里是原有占位说明，不要删除。',
    '',
    '## 主题观察',
    '',
    '原有主题观察：公爵返俄后的处境值得继续记录。',
    ''
  ].join('\n')
  await writeFile(targetPath, initialContent, 'utf-8')
  try {
    const openDefinition = createToolDefinition({
      name: 'document_open_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'read',
      description: 'Open document',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      }
    })
    const fileReadDefinition = createToolDefinition({
      name: 'file_read_excerpt',
      groupId: 'file_management',
      domain: 'file',
      kind: 'read',
      description: 'Read excerpt',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      }
    })
    const replaceDefinition = createToolDefinition({
      name: 'document_replace_exact',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Replace exact text',
      schema: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          replacement: { type: 'string' }
        },
        required: ['target', 'replacement'],
        additionalProperties: false
      }
    })
    const saveDefinition = createToolDefinition({
      name: 'document_save_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Save document',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    })
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const runtime = createRuntime({
      listToolDefinitions: () => [
        fileReadDefinition,
        replaceDefinition,
        openDefinition,
        saveDefinition
      ],
      executeToolCall: async (name, args) => {
        calls.push({ name, args })
        if (name === 'document_replace_exact') {
          const current = await readFile(targetPath, 'utf-8')
          await writeFile(
            targetPath,
            current.replace(String(args.target || ''), String(args.replacement || '')),
            'utf-8'
          )
        }
        if (name === 'file_read_excerpt') {
          return createToolExecutionOutput(await readFile(targetPath, 'utf-8'), {
            shape: 'json',
            data: { ok: true }
          })
        }
        return createToolExecutionOutput(
          name === 'document_open_tab'
            ? 'opened target'
            : name === 'document_save_tab'
              ? 'saved target'
              : 'updated target',
          { shape: 'json', data: { ok: true } }
        )
      },
      runAgent: async ({ tools, onTextDelta }) => {
        const fileReadTool = tools[0] as {
          invoke: (context: unknown, input: string) => Promise<string>
        }
        const replaceTool = tools[1] as {
          invoke: (context: unknown, input: string) => Promise<string>
        }
        await fileReadTool.invoke({}, JSON.stringify({ path: targetPath }))
        const unsafe = await replaceTool.invoke(
          {},
          JSON.stringify({
            target: '> 这里是原有占位说明，不要删除。',
            replacement: '> 以下人物关系基于前三章整理。'
          })
        )
        assert.match(unsafe, /原有内容/)
        await replaceTool.invoke(
          {},
          JSON.stringify({
            target: '> 这里是原有占位说明，不要删除。',
            replacement: [
              '> 这里是原有占位说明，不要删除。',
              '',
              '> 以下人物关系基于前三章整理。'
            ].join('\n')
          })
        )
        onTextDelta('已保留原文并补充内容。')
        return { finalText: '已保留原文并补充内容。' }
      }
    })
    runtime.newSession('butler::scope-doc-preserve-replace', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-doc-preserve-replace',
      [
        '把人物关系整理到@[A2-读书笔记.md]的“人物关系”这一节下面，保留原有笔记内容，不要覆盖其他章节。',
        '',
        '--- 附件: A2-读书笔记.md ---',
        `- 路径: ${targetPath}`
      ].join('\n'),
      'run-doc-preserve-replace',
      {
        publicSessionId: 'scope-doc-preserve-replace',
        taskId: 'task-doc-preserve-replace',
        requestEnvelope: {
          primaryInstruction:
            '把人物关系整理到@[A2-读书笔记.md]的“人物关系”这一节下面，保留原有笔记内容，不要覆盖其他章节。',
          resources: [{ name: 'A2-读书笔记.md', path: targetPath }]
        }
      }
    )

    const finalContent = await readFile(targetPath, 'utf-8')
    assert.equal(result.success, true)
    assert.equal(finalContent.includes('这是一份原有笔记，请保留这一段。'), true)
    assert.equal(finalContent.includes('> 这里是原有占位说明，不要删除。'), true)
    assert.equal(finalContent.includes('原有主题观察：公爵返俄后的处境值得继续记录。'), true)
    assert.deepEqual(
      calls.map((call) => call.name),
      ['file_read_excerpt', 'document_open_tab', 'document_replace_exact', 'document_save_tab']
    )
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('agent sdk runtime continues explicit target turns that admit the document is incomplete', async () => {
  const openDefinition = createToolDefinition({
    name: 'document_open_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'read',
    description: 'Open document',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false
    }
  })
  const setContentDefinition = createToolDefinition({
    name: 'document_set_content',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Set document content',
    schema: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
      additionalProperties: false
    }
  })
  const saveDefinition = createToolDefinition({
    name: 'document_save_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Save document',
    schema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  })
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const runInputs: unknown[] = []
  let runCount = 0
  const runtime = createRuntime({
    listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
    executeToolCall: async (name, args) => {
      calls.push({ name, args })
      return createToolExecutionOutput(
        name === 'document_open_tab'
          ? 'opened target'
          : name === 'document_save_tab'
            ? 'saved target'
            : 'updated target',
        { shape: 'json', data: { ok: true } }
      )
    },
    runAgent: async ({ tools, input, onTextDelta }) => {
      runInputs.push(input)
      runCount += 1
      const setContentTool = tools[0] as {
        invoke: (context: unknown, input: string) => Promise<string>
      }
      if (runCount === 1) {
        await setContentTool.invoke({}, JSON.stringify({ content: '未完成内容 ——' }))
        onTextDelta('内容被截断了，我来补完末尾部分。')
        return { finalText: '内容被截断了，我来补完末尾部分。' }
      }
      await setContentTool.invoke({}, JSON.stringify({ content: '完整内容。' }))
      onTextDelta('已补完并保存。')
      return { finalText: '已补完并保存。' }
    }
  })
  runtime.newSession('butler::scope-doc-incomplete-continue', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-doc-incomplete-continue',
    [
      '在@[新文档.md]里写入一段人物关系图占位内容',
      '',
      '--- 附件: 新文档.md ---',
      '- 路径: /tmp/新文档.md'
    ].join('\n'),
    'run-doc-incomplete-continue',
    {
      publicSessionId: 'scope-doc-incomplete-continue',
      taskId: 'task-doc-incomplete-continue',
      requestEnvelope: {
        primaryInstruction: '在@[新文档.md]里写入一段人物关系图占位内容',
        resources: [{ name: '新文档.md', path: '/tmp/新文档.md' }]
      }
    }
  )

  assert.equal(result.success, true)
  assert.equal(runCount, 2)
  assert.match(String(runInputs[1]), /还没补完/)
  assert.deepEqual(calls, [
    { name: 'document_open_tab', args: { path: '/tmp/新文档.md' } },
    { name: 'document_set_content', args: { content: '未完成内容 ——' } },
    { name: 'document_save_tab', args: {} },
    { name: 'document_set_content', args: { content: '完整内容。' } },
    { name: 'document_save_tab', args: {} }
  ])
})

test('agent sdk runtime repairs damaged show-widget content before completing target document turns', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-agent-sdk-widget-'))
  const targetPath = join(tmpRoot, '新文档.md')
  await writeFile(targetPath, '\n', 'utf-8')
  try {
    const openDefinition = createToolDefinition({
      name: 'document_open_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'read',
      description: 'Open document',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      }
    })
    const setContentDefinition = createToolDefinition({
      name: 'document_set_content',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Set document content',
      schema: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
        additionalProperties: false
      }
    })
    const saveDefinition = createToolDefinition({
      name: 'document_save_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Save document',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    })
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const runInputs: unknown[] = []
    let runCount = 0
    const runtime = createRuntime({
      listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
      executeToolCall: async (name, args) => {
        calls.push({ name, args })
        if (name === 'document_set_content') {
          await writeFile(targetPath, String(args.content || ''), 'utf-8')
        }
        return createToolExecutionOutput(
          name === 'document_open_tab'
            ? 'opened target'
            : name === 'document_save_tab'
              ? 'saved target'
              : 'updated target',
          { shape: 'json', data: { ok: true } }
        )
      },
      runAgent: async ({ tools, input, onTextDelta }) => {
        runInputs.push(input)
        runCount += 1
        const setContentTool = tools[0] as {
          invoke: (context: unknown, input: string) => Promise<string>
        }
        if (runCount === 1) {
          await setContentTool.invoke(
            {},
            JSON.stringify({
              content: [
                '# 人物关系图',
                '',
                '```show-widget',
                JSON.stringify({ id: 'broken', widget_code: '<svg><line x1="1"' }),
                '```'
              ].join('\n')
            })
          )
          onTextDelta('已完成。')
          return { finalText: '已完成。' }
        }
        await setContentTool.invoke(
          {},
          JSON.stringify({ content: '# 人物关系图\n\n文本版关系图。' })
        )
        onTextDelta('已改成稳定版本并保存。')
        return { finalText: '已改成稳定版本并保存。' }
      }
    })
    runtime.newSession('butler::scope-doc-widget-repair', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-doc-widget-repair',
      [
        '在@[新文档.md]里写入一段人物关系图占位内容',
        '',
        '--- 附件: 新文档.md ---',
        `- 路径: ${targetPath}`
      ].join('\n'),
      'run-doc-widget-repair',
      {
        publicSessionId: 'scope-doc-widget-repair',
        taskId: 'task-doc-widget-repair',
        requestEnvelope: {
          primaryInstruction: '在@[新文档.md]里写入一段人物关系图占位内容',
          resources: [{ name: '新文档.md', path: targetPath }]
        }
      }
    )

    assert.equal(result.success, true)
    assert.equal(runCount, 2)
    assert.match(String(runInputs[1]), /show-widget/)
    assert.deepEqual(
      calls.map((call) => call.name),
      [
        'document_open_tab',
        'document_set_content',
        'document_save_tab',
        'document_set_content',
        'document_save_tab'
      ]
    )
    assert.equal((await readFile(targetPath, 'utf-8')).includes('show-widget'), false)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('agent sdk runtime repairs exposed Mermaid source before completing target document turns', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-agent-sdk-mermaid-'))
  const targetPath = join(tmpRoot, '新文档.md')
  await writeFile(targetPath, '\n', 'utf-8')
  try {
    const openDefinition = createToolDefinition({
      name: 'document_open_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'read',
      description: 'Open document',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      }
    })
    const setContentDefinition = createToolDefinition({
      name: 'document_set_content',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Set document content',
      schema: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
        additionalProperties: false
      }
    })
    const saveDefinition = createToolDefinition({
      name: 'document_save_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Save document',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    })
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const runInputs: unknown[] = []
    let runCount = 0
    const runtime = createRuntime({
      listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
      executeToolCall: async (name, args) => {
        calls.push({ name, args })
        if (name === 'document_set_content') {
          await writeFile(targetPath, String(args.content || ''), 'utf-8')
        }
        return createToolExecutionOutput(
          name === 'document_open_tab'
            ? 'opened target'
            : name === 'document_save_tab'
              ? 'saved target'
              : 'updated target',
          { shape: 'json', data: { ok: true } }
        )
      },
      runAgent: async ({ tools, input, onTextDelta }) => {
        runInputs.push(input)
        runCount += 1
        const setContentTool = tools[0] as {
          invoke: (context: unknown, input: string) => Promise<string>
        }
        if (runCount === 1) {
          await setContentTool.invoke(
            {},
            JSON.stringify({
              content: [
                '# 人物关系图',
                '',
                '```mermaid',
                'graph LR',
                '公爵["梅诗金公爵"]',
                '娜斯塔霞["娜斯塔霞"]',
                '```',
                '',
                '公爵 --- "一见钟情" --> 娜斯塔霞',
                '%% 叶班钦家族',
                '将军["叶班钦将军"] --- "父女" --> 大姐["亚历山德拉"]'
              ].join('\n')
            })
          )
          onTextDelta('已完成。')
          return { finalText: '已完成。' }
        }
        await setContentTool.invoke(
          {},
          JSON.stringify({
            content: [
              '# 人物关系图',
              '',
              '```mermaid',
              'graph LR',
              '公爵["梅诗金公爵"] --> 娜斯塔霞["娜斯塔霞"]',
              '将军["叶班钦将军"] --> 大姐["亚历山德拉"]',
              '```'
            ].join('\n')
          })
        )
        onTextDelta('已改成完整 Mermaid 图并保存。')
        return { finalText: '已改成完整 Mermaid 图并保存。' }
      }
    })
    runtime.newSession('butler::scope-doc-mermaid-repair', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-doc-mermaid-repair',
      [
        '在@[新文档.md]里写入一段人物关系图占位内容',
        '',
        '--- 附件: 新文档.md ---',
        `- 路径: ${targetPath}`
      ].join('\n'),
      'run-doc-mermaid-repair',
      {
        publicSessionId: 'scope-doc-mermaid-repair',
        taskId: 'task-doc-mermaid-repair',
        requestEnvelope: {
          primaryInstruction: '在@[新文档.md]里写入一段人物关系图占位内容',
          resources: [{ name: '新文档.md', path: targetPath }]
        }
      }
    )

    assert.equal(result.success, true)
    assert.equal(runCount, 2)
    assert.match(String(runInputs[1]), /Mermaid\/关系图源码裸露/)
    assert.deepEqual(
      calls.map((call) => call.name),
      [
        'document_open_tab',
        'document_set_content',
        'document_save_tab',
        'document_set_content',
        'document_save_tab'
      ]
    )
    const saved = await readFile(targetPath, 'utf-8')
    assert.match(saved, /```mermaid/)
    assert.doesNotMatch(saved, /\n公爵 --- "一见钟情"/)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('agent sdk runtime treats a single selected document as target for section repair turns', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-agent-sdk-selected-target-'))
  const targetPath = join(tmpRoot, '白痴-笔记.md')
  await writeFile(targetPath, '# 二、人物关系图\n\n旧内容。', 'utf-8')
  try {
    const openDefinition = createToolDefinition({
      name: 'document_open_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'read',
      description: 'Open document',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      }
    })
    const setContentDefinition = createToolDefinition({
      name: 'document_set_content',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Set document content',
      schema: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
        additionalProperties: false
      }
    })
    const saveDefinition = createToolDefinition({
      name: 'document_save_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Save document',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    })
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const runInputs: unknown[] = []
    let runCount = 0
    const runtime = createRuntime({
      listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
      executeToolCall: async (name, args) => {
        calls.push({ name, args })
        if (name === 'document_set_content') {
          await writeFile(targetPath, String(args.content || ''), 'utf-8')
        }
        return createToolExecutionOutput(
          name === 'document_open_tab'
            ? 'opened target'
            : name === 'document_save_tab'
              ? 'saved target'
              : 'updated target',
          { shape: 'json', data: { ok: true } }
        )
      },
      runAgent: async ({ tools, input, onTextDelta }) => {
        runInputs.push(input)
        runCount += 1
        const setContentTool = tools[0] as {
          invoke: (context: unknown, input: string) => Promise<string>
        }
        if (runCount === 1) {
          await setContentTool.invoke(
            {},
            JSON.stringify({
              content: [
                '# 二、人物关系图',
                '',
                '```mermaid',
                'graph TD',
                'duke -- "一见钟情" --- nastasya',
                '%% 叶班钦家族',
                'epanchin["叶班钦将军"]',
                '```'
              ].join('\n')
            })
          )
          onTextDelta('已修复并保存。')
          return { finalText: '已修复并保存。' }
        }
        await setContentTool.invoke(
          {},
          JSON.stringify({
            content: [
              '# 二、人物关系图',
              '',
              '| 人物 | 关系 | 对象 |',
              '| --- | --- | --- |',
              '| 梅诗金公爵 | 一见钟情 | 娜斯塔霞 |'
            ].join('\n')
          })
        )
        onTextDelta('已改成表格并保存。')
        return { finalText: '已改成表格并保存。' }
      }
    })
    runtime.newSession('butler::scope-doc-selected-target', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-doc-selected-target',
      ['修复一下这段 mermaid', '', '--- 附件: 白痴-笔记.md ---', `- 路径: ${targetPath}`].join(
        '\n'
      ),
      'run-doc-selected-target',
      {
        publicSessionId: 'scope-doc-selected-target',
        taskId: 'task-doc-selected-target',
        requestEnvelope: {
          primaryInstruction: '修复一下这段 mermaid',
          resources: [{ name: '白痴-笔记.md', path: targetPath }]
        }
      }
    )

    assert.equal(result.success, true)
    assert.equal(runCount, 2)
    assert.match(String(runInputs[1]), /Mermaid/)
    assert.match(String(runInputs[1]), /边标签/)
    assert.deepEqual(
      calls.map((call) => call.name),
      [
        'document_open_tab',
        'document_set_content',
        'document_save_tab',
        'document_set_content',
        'document_save_tab'
      ]
    )
    const saved = await readFile(targetPath, 'utf-8')
    assert.match(saved, /\| 人物 \| 关系 \| 对象 \|/)
    assert.doesNotMatch(saved, /duke --/)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('agent sdk runtime treats max-turn exhaustion after a valid saved target document as complete', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-agent-sdk-max-turn-'))
  const targetPath = join(tmpRoot, 'B2-运营数据多图表报告.md')
  await writeFile(targetPath, '# B2 运营数据多图表报告\n\n', 'utf-8')
  try {
    const openDefinition = createToolDefinition({
      name: 'document_open_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'read',
      description: 'Open document',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      }
    })
    const setContentDefinition = createToolDefinition({
      name: 'document_set_content',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Set document content',
      schema: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
        additionalProperties: false
      }
    })
    const saveDefinition = createToolDefinition({
      name: 'document_save_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Save document',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    })
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const runtime = createRuntime({
      listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
      executeToolCall: async (name, args) => {
        calls.push({ name, args })
        if (name === 'document_set_content') {
          await writeFile(targetPath, String(args.content || ''), 'utf-8')
        }
        return createToolExecutionOutput(
          name === 'document_open_tab'
            ? 'opened target'
            : name === 'document_save_tab'
              ? 'saved target'
              : 'updated target',
          { shape: 'json', data: { ok: true } }
        )
      },
      runAgent: async ({ tools }) => {
        const setContentTool = tools[0] as {
          invoke: (context: unknown, input: string) => Promise<string>
        }
        await setContentTool.invoke(
          {},
          JSON.stringify({
            content: '# B2 运营数据多图表报告\n\n已生成 4 个图表，并保存关键结论。'
          })
        )
        throw new Error('Max turns (16) exceeded')
      }
    })
    const runMeta = attachMemoryRunMeta(runtime)
    runtime.newSession('butler::scope-doc-max-turn-complete', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-doc-max-turn-complete',
      [
        '把多组运营数据整理到@[B2-运营数据多图表报告.md]里。',
        '',
        '--- 附件: B2-运营数据多图表报告.md ---',
        `- 路径: ${targetPath}`
      ].join('\n'),
      'run-doc-max-turn-complete',
      {
        publicSessionId: 'scope-doc-max-turn-complete',
        taskId: 'task-doc-max-turn-complete',
        requestEnvelope: {
          primaryInstruction: '把多组运营数据整理到@[B2-运营数据多图表报告.md]里。',
          resources: [{ name: 'B2-运营数据多图表报告.md', path: targetPath }]
        }
      }
    )

    assert.equal(result.success, true)
    assert.equal(result.terminalReason, 'done')
    assert.match(result.finalText, /已完成并保存/)
    assert.equal(runMeta.get('run-doc-max-turn-complete')?.lastMessageText, result.finalText)
    assert.deepEqual(
      calls.map((call) => call.name),
      ['document_open_tab', 'document_set_content', 'document_save_tab']
    )
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('agent sdk runtime checkpoints max-turn loops after a successful file excerpt', async () => {
  const readExcerptDefinition = createToolDefinition({
    name: 'file_read_excerpt',
    groupId: 'file',
    domain: 'file',
    kind: 'read',
    description: 'Read file excerpt',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false
    }
  })
  const statuses: Array<Record<string, unknown>> = []
  const errors: Array<Record<string, unknown>> = []
  const runtime = createRuntime({
    listToolDefinitions: () => [readExcerptDefinition],
    executeToolCall: async () =>
      createToolExecutionOutput(
        JSON.stringify({
          ok: true,
          path: '/tmp/events/北岸夜跑.md',
          content:
            '# 北岸夜跑\n\n## 预算\n北岸夜跑预算共 4.0 万元，主要用于报备、物料、安保、摄影和应急。'
        }),
        {
          shape: 'json',
          data: {
            ok: true,
            path: '/tmp/events/北岸夜跑.md',
            content:
              '# 北岸夜跑\n\n## 预算\n北岸夜跑预算共 4.0 万元，主要用于报备、物料、安保、摄影和应急。'
          }
        }
      ),
    runAgent: async ({ tools }) => {
      const readTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      await readTool.invoke({}, JSON.stringify({ path: '/tmp/events/北岸夜跑.md' }))
      throw new Error('Max turns (16) exceeded')
    }
  })
  runtime.on('status', (event) => statuses.push(event as Record<string, unknown>))
  runtime.on('error', (event) => errors.push(event as Record<string, unknown>))
  runtime.newSession('butler::scope-file-max-turn', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-file-max-turn',
    '告诉我北岸夜跑预算数字',
    'run-file-max-turn',
    {
      publicSessionId: 'scope-file-max-turn',
      taskId: 'task-file-max-turn'
    }
  )

  assert.equal(result.success, true)
  assert.equal(result.terminalReason, 'checkpoint_budget')
  assert.match(result.finalText, /4\.0 万元/)
  assert.deepEqual(result.usedTools, ['file_read_excerpt'])
  assert.equal(errors.length, 0)
  assert.deepEqual(
    statuses.map((event) => [event.status, event.terminalReason]),
    [
      ['working', undefined],
      ['checkpoint', 'checkpoint_budget']
    ]
  )
})

test('agent sdk runtime checkpoints max-turn loops after generic successful tool progress', async () => {
  const readExcerptDefinition = createToolDefinition({
    name: 'file_read_excerpt',
    groupId: 'file',
    domain: 'file',
    kind: 'read',
    description: 'Read file excerpt',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false
    }
  })
  const statuses: Array<Record<string, unknown>> = []
  const errors: Array<Record<string, unknown>> = []
  const runtime = createRuntime({
    listToolDefinitions: () => [readExcerptDefinition],
    executeToolCall: async () =>
      createToolExecutionOutput(
        JSON.stringify({
          ok: true,
          path: '/tmp/notes/long-images-transcribed.md',
          bytesRead: 4096
        }),
        {
          shape: 'json',
          data: {
            ok: true,
            path: '/tmp/notes/long-images-transcribed.md',
            bytesRead: 4096
          }
        }
      ),
    runAgent: async ({ tools }) => {
      const readTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      await readTool.invoke({}, JSON.stringify({ path: '/tmp/notes/long-images-transcribed.md' }))
      throw new Error('Max turns (16) exceeded')
    }
  })
  runtime.on('status', (event) => statuses.push(event as Record<string, unknown>))
  runtime.on('error', (event) => errors.push(event as Record<string, unknown>))
  runtime.newSession('butler::scope-generic-progress-max-turn', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-generic-progress-max-turn',
    '@[study-notes]带我学一下这篇文章',
    'run-generic-progress-max-turn',
    {
      publicSessionId: 'scope-generic-progress-max-turn',
      taskId: 'task-generic-progress-max-turn'
    }
  )

  assert.equal(result.success, true)
  assert.equal(result.terminalReason, 'checkpoint_budget')
  assert.match(result.finalText, /工具调用次数已用完/)
  assert.deepEqual(result.usedTools, ['file_read_excerpt'])
  assert.equal(errors.length, 0)
  assert.deepEqual(
    statuses.map((event) => [event.status, event.terminalReason]),
    [
      ['working', undefined],
      ['checkpoint', 'checkpoint_budget']
    ]
  )
})

test('agent sdk runtime does not expose source excerpts when a local document write hits max turns', async () => {
  const sourceContent = [
    '# 第二部第一章',
    '',
    'SENSITIVE_SOURCE: 动辄发怒的原文章节内容，只能作为写文档依据，不能贴回聊天。'
  ].join('\n')
  const readExcerptDefinition = createToolDefinition({
    name: 'file_read_excerpt',
    groupId: 'file',
    domain: 'file',
    kind: 'read',
    description: 'Read file excerpt',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false
    }
  })
  const newTabDefinition = createToolDefinition({
    name: 'document_new_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Create document',
    schema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false
    }
  })
  const setContentDefinition = createToolDefinition({
    name: 'document_set_content',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Set document content',
    schema: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
      additionalProperties: false
    }
  })
  const saveDefinition = createToolDefinition({
    name: 'document_save_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Save document',
    schema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  })
  const statuses: Array<Record<string, unknown>> = []
  const errors: Array<Record<string, unknown>> = []
  const runtime = createRuntime({
    listToolDefinitions: () => [
      readExcerptDefinition,
      newTabDefinition,
      setContentDefinition,
      saveDefinition
    ],
    executeToolCall: async () =>
      createToolExecutionOutput(
        JSON.stringify({
          ok: true,
          path: '/tmp/library/白痴.md',
          content: sourceContent
        }),
        {
          shape: 'json',
          data: {
            ok: true,
            path: '/tmp/library/白痴.md',
            content: sourceContent
          }
        }
      ),
    runAgent: async ({ tools, maxTurns }) => {
      assert.equal(maxTurns, 40)
      const byName = new Map(
        tools.map((tool) => [
          tool.name,
          tool as { invoke: (context: unknown, input: string) => Promise<string> }
        ])
      )
      await byName.get('file_read_excerpt')?.invoke(
        {},
        JSON.stringify({
          path: '/tmp/library/白痴.md',
          anchor: '第二部第一章'
        })
      )
      throw new Error('Max turns (40) exceeded')
    }
  })
  runtime.on('status', (event) => statuses.push(event as Record<string, unknown>))
  runtime.on('error', (event) => errors.push(event as Record<string, unknown>))
  runtime.newSession('butler::scope-doc-write-max-turn-source', 'system prompt')

  const instruction =
    '@[白痴.md]看一下第二部第一章，同样新建一个文档在@[白痴笔记]目录下写章节笔记并保存好'
  const result = await runtime.sendMessage(
    'butler::scope-doc-write-max-turn-source',
    [
      instruction,
      '',
      '--- 附件: 白痴.md ---',
      '- 路径: /tmp/library/白痴.md',
      '',
      '--- 附件: 白痴笔记 ---',
      '- 路径: /tmp/library/白痴笔记'
    ].join('\n'),
    'run-doc-write-max-turn-source',
    {
      publicSessionId: 'scope-doc-write-max-turn-source',
      taskId: 'task-doc-write-max-turn-source',
      requestEnvelope: {
        primaryInstruction: instruction,
        resources: [
          { name: '白痴.md', path: '/tmp/library/白痴.md' },
          { name: '白痴笔记', path: '/tmp/library/白痴笔记' }
        ]
      }
    }
  )

  assert.equal(result.success, true)
  assert.equal(result.terminalReason, 'checkpoint_budget')
  assert.match(result.finalText, /已经读取源文档/)
  assert.match(result.finalText, /不会把原文贴到聊天里/)
  assert.doesNotMatch(result.finalText, /SENSITIVE_SOURCE/)
  assert.doesNotMatch(result.finalText, /动辄发怒/)
  assert.deepEqual(result.usedTools, ['file_read_excerpt'])
  assert.equal(errors.length, 0)
  assert.deepEqual(
    statuses.map((event) => [event.status, event.terminalReason]),
    [
      ['working', undefined],
      ['checkpoint', 'checkpoint_budget']
    ]
  )
})

test('agent sdk runtime does not checkpoint max-turn loops after a failed file excerpt', async () => {
  const readExcerptDefinition = createToolDefinition({
    name: 'file_read_excerpt',
    groupId: 'file',
    domain: 'file',
    kind: 'read',
    description: 'Read file excerpt',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false
    }
  })
  const statuses: Array<Record<string, unknown>> = []
  const errors: Array<Record<string, unknown>> = []
  const runtime = createRuntime({
    listToolDefinitions: () => [readExcerptDefinition],
    executeToolCall: async () =>
      createToolExecutionOutput(
        JSON.stringify({
          ok: false,
          path: '/tmp/events/missing.md',
          error: 'path not in index'
        }),
        {
          shape: 'json',
          data: {
            ok: false,
            path: '/tmp/events/missing.md',
            error: 'path not in index'
          }
        }
      ),
    runAgent: async ({ tools }) => {
      const readTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      await readTool.invoke({}, JSON.stringify({ path: '/tmp/events/missing.md' }))
      throw new Error('Max turns (16) exceeded')
    }
  })
  runtime.on('status', (event) => statuses.push(event as Record<string, unknown>))
  runtime.on('error', (event) => errors.push(event as Record<string, unknown>))
  runtime.newSession('butler::scope-file-max-turn-failed-read', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-file-max-turn-failed-read',
    '告诉我缺失文件里的预算数字',
    'run-file-max-turn-failed-read',
    {
      publicSessionId: 'scope-file-max-turn-failed-read',
      taskId: 'task-file-max-turn-failed-read'
    }
  )

  assert.equal(result.success, false)
  assert.equal(result.terminalReason, 'blocked_external')
  assert.equal(result.finalText, '')
  assert.equal(errors.length, 1)
  assert.equal(
    statuses.some((event) => event.status === 'checkpoint'),
    false
  )
})

test('agent sdk runtime checkpoints max-turn target document turns with no effective mutation', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-agent-sdk-max-turn-empty-'))
  const targetPath = join(tmpRoot, '空文档.md')
  await writeFile(targetPath, '\n', 'utf-8')
  try {
    const statuses: Array<Record<string, unknown>> = []
    const errors: Array<Record<string, unknown>> = []
    const runtime = createRuntime({
      runAgent: async () => {
        throw new Error('Max turns (16) exceeded')
      }
    })
    runtime.on('status', (event) => statuses.push(event as Record<string, unknown>))
    runtime.on('error', (event) => errors.push(event as Record<string, unknown>))
    runtime.newSession('butler::scope-doc-max-turn-no-mutation', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-doc-max-turn-no-mutation',
      ['修复@[空文档.md]里的信息卡。', '', '--- 附件: 空文档.md ---', `- 路径: ${targetPath}`].join(
        '\n'
      ),
      'run-doc-max-turn-no-mutation',
      {
        publicSessionId: 'scope-doc-max-turn-no-mutation',
        taskId: 'task-doc-max-turn-no-mutation',
        requestEnvelope: {
          primaryInstruction: '修复@[空文档.md]里的信息卡。',
          resources: [{ name: '空文档.md', path: targetPath }]
        }
      }
    )

    assert.equal(result.success, true)
    assert.equal(result.terminalReason, 'checkpoint_budget')
    assert.match(result.finalText, /还没有发生有效写入/)
    assert.equal(errors.length, 0)
    assert.equal(
      statuses.some(
        (event) => event.status === 'checkpoint' && event.terminalReason === 'checkpoint_budget'
      ),
      true
    )
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('agent sdk runtime recovers loose XML tool calls leaked as native model text', async () => {
  const openDefinition = createToolDefinition({
    name: 'document_open_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'read',
    description: 'Open document',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false
    }
  })
  const setContentDefinition = createToolDefinition({
    name: 'document_set_content',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Set document content',
    schema: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
      additionalProperties: false
    }
  })
  const saveDefinition = createToolDefinition({
    name: 'document_save_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Save document',
    schema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  })
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let runCount = 0
  const runtime = createRuntime({
    listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
    executeToolCall: async (name, args) => {
      calls.push({ name, args })
      return createToolExecutionOutput(
        name === 'document_open_tab'
          ? 'opened target'
          : name === 'document_save_tab'
            ? 'saved target'
            : 'updated target',
        { shape: 'json', data: { ok: true } }
      )
    },
    runAgent: async ({ onTextDelta }) => {
      runCount += 1
      if (runCount === 1) {
        const leaked = [
          '现在写入目标文档：',
          '<tool_call>',
          '<function=document_set_content>',
          '<parameter=content>XML 恢复写入的人物关系图'
        ].join('\n')
        onTextDelta(leaked)
        return { finalText: leaked }
      }
      onTextDelta('已写入并保存。')
      return { finalText: '已写入并保存。' }
    }
  })
  runtime.newSession('butler::scope-doc-xml-recovery', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-doc-xml-recovery',
    [
      '在@[新文档.md]里写入一段人物关系图占位内容',
      '',
      '--- 附件: 新文档.md ---',
      '- 路径: /tmp/新文档.md'
    ].join('\n'),
    'run-doc-xml-recovery',
    {
      publicSessionId: 'scope-doc-xml-recovery',
      taskId: 'task-doc-xml-recovery',
      requestEnvelope: {
        primaryInstruction: '在@[新文档.md]里写入一段人物关系图占位内容',
        resources: [{ name: '新文档.md', path: '/tmp/新文档.md' }]
      }
    }
  )

  assert.equal(result.success, true)
  assert.equal(runCount, 2)
  assert.deepEqual(calls, [
    { name: 'document_open_tab', args: { path: '/tmp/新文档.md' } },
    { name: 'document_set_content', args: { content: 'XML 恢复写入的人物关系图' } },
    { name: 'document_save_tab', args: {} }
  ])
})

test('agent sdk runtime honors Ready OpenAI-compatible responses wire API', async () => {
  const requests: Array<Record<string, unknown>> = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'fox',
        baseUrl: 'https://code.newcli.com/codex/v1',
        model: 'gpt-5.4',
        agentProtocol: 'openai',
        wireApi: 'responses'
      }
    }),
    fetchWithTimeout: async (url, init) => {
      requests.push({
        url,
        body: JSON.parse(String(init.body || '{}')) as Record<string, unknown>
      })
      return new Response(
        JSON.stringify({
          id: 'resp-1',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'responses 完成' }]
            }
          ],
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 }
        }),
        { status: 200 }
      )
    }
  })
  runtime.newSession('butler::scope-responses', 'system prompt')
  await seedSdkSession(runtime, 'butler::scope-responses', [
    {
      type: 'function_call_result',
      callId: 'call-prev-path',
      output: 'previous run at /Users/alice/Ready/run_state.json'
    } as AgentInputItem
  ])

  const result = await runtime.sendMessage('butler::scope-responses', '你好', 'run-responses', {
    publicSessionId: 'scope-responses',
    taskId: 'task-responses'
  })

  assert.equal(result.success, true)
  assert.equal(result.finalText, 'responses 完成')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://code.newcli.com/codex/v1/responses')
  // P0-0 true SSE (2026-07-02): the responses wire streams by default; this
  // fake returns plain JSON so rung-1 degrade keeps the blocking parse path.
  assert.equal((requests[0].body as { stream?: boolean }).stream, true)
  const responsesInput = JSON.stringify((requests[0].body as { input?: unknown[] }).input)
  assert.doesNotMatch(responsesInput, /\/Users\/alice/)
  assert.match(responsesInput, /\/Users\/<redacted>\/Ready\/run_state\.json/)
})

test('agent sdk runtime compacts oversized session history before sending wire input', async () => {
  const requests: Array<Record<string, unknown>> = []
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => metrics.push(event))
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'openai-compatible',
        baseUrl: 'https://compat.example/v1',
        model: 'compat-chat',
        agentProtocol: 'openai',
        wireApi: 'chat/completions',
        contextWindowOverride: 900
      }
    }),
    fetchWithTimeout: async (_url, init) => {
      requests.push(JSON.parse(String(init.body || '{}')) as Record<string, unknown>)
      return chatCompletionResponse('压缩后完成')
    }
  })
  try {
    runtime.newSession('butler::scope-presend-compact', 'system prompt')
    await seedSdkSession(runtime, 'butler::scope-presend-compact', [
      ...historyTextItems('old-hidden-context', 16),
      { role: 'user', content: 'recent-tail-marker' } as AgentInputItem
    ])

    const result = await runtime.sendMessage(
      'butler::scope-presend-compact',
      'CURRENT_INPUT_UNIQUE',
      'run-presend-compact',
      {
        publicSessionId: 'scope-presend-compact',
        taskId: 'task-presend-compact'
      }
    )

    assert.equal(result.success, true)
    assert.equal(requests.length, 1)
    const bodyText = JSON.stringify(requests[0])
    assert.match(bodyText, /ready:context-compacted/)
    assert.doesNotMatch(bodyText, /old-hidden-context-4/)
    assert.match(bodyText, /recent-tail-marker/)
    assert.equal(countOccurrences(bodyText, 'CURRENT_INPUT_UNIQUE'), 1)
    const compactionMetric = metrics.find(
      (event) => event.metric === 'agent_sdk_auto_context_compacted'
    )
    assert.ok(compactionMetric, 'automatic compaction must emit an observability metric')
    assert.equal(compactionMetric.runId, 'run-presend-compact')
    assert.equal(compactionMetric.taskId, 'task-presend-compact')
    assert.equal(typeof compactionMetric.beforeTokens, 'number')
    assert.equal(typeof compactionMetric.afterTokens, 'number')
    assert.equal(typeof compactionMetric.droppedItems, 'number')
    assert.equal(typeof compactionMetric.truncatedToolResults, 'number')
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('agent sdk runtime retries context overflow after compacting the captured session', async () => {
  const requests: Array<Record<string, unknown>> = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'openai-compatible',
        baseUrl: 'https://compat.example/v1',
        model: 'compat-chat',
        agentProtocol: 'openai',
        wireApi: 'chat/completions',
        contextWindowOverride: 100_000
      }
    }),
    fetchWithTimeout: async (_url, init) => {
      requests.push(JSON.parse(String(init.body || '{}')) as Record<string, unknown>)
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'context_length_exceeded',
              message: 'prompt is too long'
            }
          }),
          { status: 413 }
        )
      }
      return chatCompletionResponse('重试成功')
    }
  })
  runtime.newSession('butler::scope-overflow-retry', 'system prompt')
  await seedSdkSession(
    runtime,
    'butler::scope-overflow-retry',
    historyTextItems('overflow-history', 24)
  )

  const result = await runtime.sendMessage(
    'butler::scope-overflow-retry',
    'CURRENT_OVERFLOW_INPUT',
    'run-overflow-retry',
    {
      publicSessionId: 'scope-overflow-retry',
      taskId: 'task-overflow-retry'
    }
  )

  assert.equal(result.success, true)
  assert.equal(result.finalText, '重试成功')
  assert.equal(requests.length, 2)
  const firstBody = JSON.stringify(requests[0])
  const secondBody = JSON.stringify(requests[1])
  assert.ok(
    secondBody.length < firstBody.length,
    `expected retry body to shrink (${firstBody.length} -> ${secondBody.length})`
  )
  assert.match(secondBody, /ready:context-compacted/)
  assert.equal(countOccurrences(secondBody, 'CURRENT_OVERFLOW_INPUT'), 1)
})

test('agent sdk runtime compact primitive compresses the run-bound captured session', async () => {
  const compactDefinition = createToolDefinition({
    name: 'skill_compact_context',
    groupId: 'skill',
    domain: 'skill',
    kind: 'write',
    description: 'Compact context',
    schema: { type: 'object', properties: {}, additionalProperties: false }
  })
  const runtime = createRuntime({
    listToolDefinitions: () => [compactDefinition],
    runAgent: async ({ tools }) => {
      const compactTool = tools[0] as {
        invoke: (context: unknown, input: string) => Promise<string>
      }
      const output = await compactTool.invoke({}, JSON.stringify({}))
      assert.match(output, /context compacted|上下文|压缩/)
      return { finalText: '已压缩' }
    }
  })
  runtime.newSession('butler::scope-compact-primitive', 'system prompt')
  await seedSdkSession(
    runtime,
    'butler::scope-compact-primitive',
    historyTextItems('primitive-history', 20)
  )

  const result = await runtime.sendMessage(
    'butler::scope-compact-primitive',
    '使用 context compact 压缩当前上下文',
    'run-compact-primitive',
    {
      publicSessionId: 'scope-compact-primitive',
      taskId: 'task-compact-primitive'
    }
  )
  const items = await readSdkSessionItems(runtime, 'butler::scope-compact-primitive')

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, ['skill_compact_context'])
  assert.ok(items.length < 20)
  assert.match(JSON.stringify(items), /ready:context-compacted/)
})

test('agent sdk runtime waits for idle manual compaction before starting a new run', async () => {
  let runStarted = false
  let releaseCompact!: () => void
  let compactEntered!: () => void
  const compactEnteredPromise = new Promise<void>((resolve) => {
    compactEntered = resolve
  })
  const releaseCompactPromise = new Promise<void>((resolve) => {
    releaseCompact = resolve
  })
  const runtime = createRuntime({
    runAgent: async () => {
      runStarted = true
      return { finalText: 'done' }
    }
  })
  const name = 'butler::scope-compact-lock'
  runtime.newSession(name, 'system prompt')
  await seedSdkSession(runtime, name, historyTextItems('lock-history', 20))

  const session = (
    runtime as unknown as {
      sessionManager: {
        get: (name: string) => { sdkSession: { clearSession: () => Promise<void> } } | undefined
      }
    }
  ).sessionManager.get(name)
  assert.ok(session, `missing test session ${name}`)
  const originalClearSession = session.sdkSession.clearSession.bind(session.sdkSession)
  session.sdkSession.clearSession = async () => {
    compactEntered()
    await releaseCompactPromise
    await originalClearSession()
  }

  const compactPromise = runtime.compactSession(name, 'manual')
  await compactEnteredPromise
  const sendPromise = runtime.sendMessage(name, 'hello after compact', 'run-compact-lock', {
    publicSessionId: 'scope-compact-lock',
    taskId: 'task-compact-lock'
  })

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(runStarted, false)

  releaseCompact()
  const compactResult = await compactPromise
  const sendResult = await sendPromise

  assert.equal(compactResult.status, 'compacted')
  assert.equal(sendResult.success, true)
  assert.equal(runStarted, true)
})

test('agent sdk runtime forwards renderer-mediated tool requests', async () => {
  const toolDefinition = createToolDefinition({
    name: 'document_set_content',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Set document content',
    schema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['tabId', 'content'],
      additionalProperties: false
    }
  })
  const saveDefinition = createToolDefinition({
    name: 'document_save_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Save document',
    schema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      additionalProperties: false
    }
  })
  const rendererRequests: Array<Record<string, unknown>> = []
  const runtime = createRuntime({
    listToolDefinitions: () => [toolDefinition, saveDefinition],
    executeToolCall: async (toolName, args, context) => {
      if (toolName === 'document_save_tab') {
        return createToolExecutionOutput('已保存文档：/tmp/renderer.md', {
          shape: 'json',
          data: {
            ok: true,
            documentSaved: true,
            document: {
              tabId: 'tab-1',
              title: 'renderer.md',
              path: '/tmp/renderer.md',
              dirty: false,
              requiresSave: false,
              saveState: 'saved'
            }
          }
        })
      }
      const requestModuleToolAction = (
        context as {
          requestModuleToolAction?: (
            tool: string,
            args: Record<string, unknown>
          ) => Promise<Record<string, unknown>>
        }
      ).requestModuleToolAction
      assert.ok(requestModuleToolAction)
      ;(
        context as { emitToolAction?: (tool: string, args: Record<string, unknown>) => void }
      ).emitToolAction?.('document.setContent', args)
      const rendererResult = await requestModuleToolAction('document_set_content', args)
      return createToolExecutionOutput('document updated', {
        shape: 'json',
        data: {
          ...rendererResult,
          mutated: true,
          mutationReason: 'changed',
          document: {
            tabId: 'tab-1',
            title: 'renderer.md',
            path: '/tmp/renderer.md',
            dirty: true,
            requiresSave: true,
            saveState: 'dirty'
          }
        },
        projectionPatch: { taskTitle: 'Document update' }
      })
    },
    runAgent: async ({ tools, onTextDelta }) => {
      const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      const toolOutput = await sdkTool.invoke(
        {},
        JSON.stringify({
          tabId: 'tab-1',
          content: 'hello'
        })
      )
      assert.match(toolOutput, /"rendererOk":true/)
      onTextDelta('文档已更新')
      return { finalText: '文档已更新' }
    }
  })
  runtime.setRendererToolActionRequester(async (payload) => {
    rendererRequests.push(payload)
    return { rendererOk: true }
  })
  runtime.newSession('butler::scope-renderer', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-renderer', '更新文档', 'run-renderer', {
    publicSessionId: 'scope-renderer',
    taskId: 'task-renderer'
  })

  assert.equal(result.success, true)
  assert.equal(result.taskType, 'multi_step_task')
  assert.deepEqual(rendererRequests, [
    {
      agent: 'butler::scope-renderer',
      sessionId: 'scope-renderer',
      runId: 'run-renderer',
      tool: 'document_set_content',
      args: {
        tabId: 'tab-1',
        content: 'hello'
      }
    }
  ])
  assert.deepEqual(result.projectionTruth?.projectionPatch, { taskTitle: 'Document update' })
})

test('agent sdk runtime preserves structured tool validation errors', async () => {
  const toolDefinition = createToolDefinition({
    name: 'rss_fetch_updates',
    groupId: 'rss',
    domain: 'rss',
    description: 'Fetch RSS updates'
  })
  let toolOutput = ''
  const runtime = createRuntime({
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async () =>
      createToolExecutionOutput('输入参数不完整', {
        shape: 'json',
        data: {
          errorKind: 'input_validation',
          detail: 'query is required'
        }
      }),
    runAgent: async ({ tools, onTextDelta }) => {
      const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      toolOutput = await sdkTool.invoke({}, JSON.stringify({}))
      onTextDelta('需要补充参数')
      return { finalText: '需要补充参数' }
    }
  })
  runtime.newSession('butler::scope-validation', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-validation',
    '更新 RSS',
    'run-validation',
    {
      publicSessionId: 'scope-validation',
      taskId: 'task-validation'
    }
  )

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, ['rss_fetch_updates'])
  assert.match(toolOutput, /"errorKind":"input_validation"/)
  assert.match(toolOutput, /"detail":"query is required"/)
})

test('agent sdk runtime does not turn recoverable skill path errors into terminal proof gaps', async () => {
  const cases: Array<{
    label: string
    data: Record<string, unknown>
  }> = [
    {
      label: 'sandbox path escape',
      data: {
        errorKind: 'path_escape',
        relativePath: '/Users/example/out.md'
      }
    },
    {
      label: 'relativePath input validation',
      data: {
        errorKind: 'input_validation',
        issues: [
          {
            path: ['relativePath'],
            code: 'invalid_type',
            message: 'Expected string'
          }
        ]
      }
    }
  ]

  for (const item of cases) {
    const toolDefinition = createToolDefinition({
      name: 'skill_write_artifact',
      groupId: 'skills',
      domain: 'skills',
      description: 'Write skill artifact'
    })
    const runtime = createRuntime({
      listToolDefinitions: () => [toolDefinition],
      executeToolCall: async () =>
        createToolExecutionOutput('路径参数需要修正', {
          shape: 'json',
          data: item.data
        }),
      runAgent: async ({ tools, onTextDelta }) => {
        const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
        await sdkTool.invoke(
          {},
          JSON.stringify({ relativePath: '/Users/example/out.md', content: 'x' })
        )
        onTextDelta(`继续修正 ${item.label}`)
        return { finalText: `继续修正 ${item.label}` }
      }
    })
    const slug = item.label.replace(/\s+/g, '-')
    const sessionId = `butler::scope-skill-path-${slug}`
    runtime.newSession(sessionId, 'system prompt')

    const result = await runtime.sendMessage(sessionId, '写入方案', `run-skill-path-${slug}`, {
      publicSessionId: sessionId,
      taskId: `task-skill-path-${slug}`
    })

    assert.equal(result.success, true)
    assert.equal(result.projectionTruth?.projectionPatch?.terminalFailureReason, undefined)
    assert.equal(
      result.projectionTruth?.projectionPatch?.terminalFailureTool,
      'skill_write_artifact'
    )
    assert.equal(
      result.projectionTruth?.projectionPatch?.terminalFailureErrorKind,
      item.data.errorKind
    )
  }
})

test('agent sdk runtime executes representative domain tools without losing projection truth', async () => {
  const cases: Array<{
    label: string
    tool: Partial<ToolDefinition> & { name: string }
    expectedTaskType: 'multi_step_task' | 'research'
  }> = [
    {
      label: 'browser',
      tool: {
        name: 'browser_read_page',
        groupId: 'browser_interaction',
        domain: 'browser',
        kind: 'read'
      },
      expectedTaskType: 'multi_step_task'
    },
    {
      label: 'rss',
      tool: { name: 'rss_analyze_item', groupId: 'rss', domain: 'rss', kind: 'read' },
      expectedTaskType: 'multi_step_task'
    },
    {
      label: 'calendar',
      tool: {
        name: 'calendar_create_event',
        groupId: 'calendar',
        domain: 'calendar',
        kind: 'write'
      },
      expectedTaskType: 'multi_step_task'
    },
    {
      label: 'feishu',
      tool: {
        name: 'feishu_message_reply',
        groupId: 'channel_feishu',
        domain: 'feishu',
        kind: 'write'
      },
      expectedTaskType: 'multi_step_task'
    },
    {
      label: 'pet',
      tool: { name: 'pet_show_sticky_note', groupId: 'pet', domain: 'pet', kind: 'write' },
      expectedTaskType: 'multi_step_task'
    },
    {
      label: 'file',
      tool: { name: 'file_search', groupId: 'file_management', domain: 'file', kind: 'read' },
      expectedTaskType: 'multi_step_task'
    },
    {
      label: 'research',
      tool: {
        name: 'web_fetch',
        groupId: 'general_research',
        domain: 'general_research',
        kind: 'read'
      },
      expectedTaskType: 'research'
    }
  ]

  for (const item of cases) {
    const toolDefinition = createToolDefinition({
      description: `${item.label} tool`,
      ...item.tool
    })
    const runtime = createRuntime({
      listToolDefinitions: () => [toolDefinition],
      executeToolCall: async () =>
        createToolExecutionOutput(`${item.label} done`, {
          shape: 'json',
          projectionPatch: {
            taskTitle: `${item.label} task`,
            taskSummary: `${item.label} finished`
          }
        }),
      runAgent: async ({ tools, onTextDelta }) => {
        const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
        await sdkTool.invoke({}, JSON.stringify({ id: item.label }))
        onTextDelta(`${item.label} 完成`)
        return { finalText: `${item.label} 完成` }
      }
    })
    runtime.newSession(`butler::scope-${item.label}`, 'system prompt')

    const result = await runtime.sendMessage(
      `butler::scope-${item.label}`,
      `${item.label} task`,
      `run-${item.label}`,
      {
        publicSessionId: `scope-${item.label}`,
        taskId: `task-${item.label}`
      }
    )

    assert.equal(result.success, true, `${item.label} should succeed`)
    assert.deepEqual(result.usedTools, [item.tool.name], `${item.label} used tool`)
    assert.equal(result.taskType, item.expectedTaskType, `${item.label} task type`)
    assert.deepEqual(result.projectionTruth?.projectionPatch, {
      taskTitle: `${item.label} task`,
      taskSummary: `${item.label} finished`
    })
  }
})

test('agent sdk runtime uses Ready text bridge for non-native tool transports', async () => {
  const toolDefinition = createToolDefinition({ description: 'Search the web' })
  const outputEvents: Array<Record<string, unknown>> = []
  const runInputs: unknown[] = []
  let runCount = 0
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'openai-compatible',
        baseUrl: 'https://code.newcli.com/codex/v1',
        agentProtocol: 'openai',
        wireApi: 'chat/completions'
      }
    }),
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async (_toolName, args) =>
      createToolExecutionOutput('found result', {
        shape: 'json',
        data: { args },
        projectionPatch: { taskTitle: 'Text bridge research' }
      }),
    runAgent: async ({ tools, instructions, input }) => {
      runCount += 1
      runInputs.push(input)
      assert.equal(tools.length, 0)
      assert.match(instructions, /文本工具桥接/)
      assert.match(instructions, /web_search/)
      if (runCount === 1) {
        return {
          finalText: [
            ':::tool_call',
            '{"tool":"web_search","args":{"query":"Agents SDK"}}',
            ':::'
          ].join('\n')
        }
      }
      assert.match(String(input), /tool_result/)
      assert.match(String(input), /found result/)
      return { finalText: '研究完成' }
    }
  })
  runtime.on('output', (event) => outputEvents.push(event))
  runtime.newSession('butler::scope-text-bridge', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-text-bridge',
    '查一下 Agents SDK',
    'run-text-bridge',
    {
      publicSessionId: 'scope-text-bridge',
      taskId: 'task-text-bridge'
    }
  )

  assert.equal(result.success, true)
  assert.equal(result.taskType, 'research')
  assert.equal(result.finalText, '研究完成')
  assert.equal(runInputs.length, 2)
  assert.deepEqual(result.usedTools, ['web_search'])
  assert.deepEqual(result.projectionTruth?.projectionPatch, { taskTitle: 'Text bridge research' })
  assert.equal(
    outputEvents.some(
      (event) => event.type === 'text' && /:::tool_call/.test(String(event.chunk || ''))
    ),
    false
  )
})

test('agent sdk runtime keeps skill eligibility fixed across text-bridge iterations', async () => {
  const prompt = 'hi，今天让你跟我聊哲学的话，你会怎么开头'
  const finalAnswer =
    '不是需要补充信息才能继续；我已经给了两个切入口：1. 我是谁？2. 今天的问题是什么？'
  const webTool = createToolDefinition({ name: 'web_search', description: 'Search the web' })
  const skillAskTool = createToolDefinition({
    name: 'skill_ask_user',
    groupId: 'skills',
    domain: 'skill',
    kind: 'interactive',
    description: 'Ask user for active skill clarification',
    schema: {
      type: 'object',
      properties: {
        question: { type: 'string' }
      },
      required: ['question'],
      additionalProperties: false
    }
  })
  let runCount = 0
  const outputEvents: Array<Record<string, unknown>> = []
  const runtime = createRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'openai-compatible',
        baseUrl: 'https://code.newcli.com/codex/v1',
        agentProtocol: 'openai',
        wireApi: 'chat/completions'
      }
    }),
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [],
      peekCurrentReferenceSkillHint: () => ({ id: 'hfp-space-design', name: 'hfp-space-design' }),
      getCurrentReferenceSkillHint: () => {
        throw new Error('unrelated chat must not consume stale skill hint')
      },
      buildPreferredSkillToolNames: () => {
        throw new Error('unrelated chat must not expose skill primitives')
      }
    },
    listToolDefinitions: () => [webTool, skillAskTool],
    executeToolCall: async () =>
      createToolExecutionOutput('found result', { shape: 'json', data: { ok: true } }),
    runAgent: async ({ input }) => {
      runCount += 1
      if (runCount === 1) {
        return {
          finalText: [
            ':::tool_call',
            '{"tool":"web_search","args":{"query":"philosophy opener"}}',
            ':::'
          ].join('\n')
        }
      }
      assert.match(String(input), /found result/)
      return { finalText: finalAnswer }
    }
  })
  runtime.on('output', (event) => outputEvents.push(event))
  runtime.newSession('butler::scope-stale-skill-text-bridge', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-stale-skill-text-bridge',
    prompt,
    'run-stale-skill-text-bridge',
    {
      publicSessionId: 'scope-stale-skill-text-bridge',
      taskId: 'task-stale-skill-text-bridge',
      requestEnvelope: {
        primaryInstruction: prompt,
        pureUserText: prompt,
        rawUserText: prompt,
        resources: []
      }
    }
  )

  assert.equal(runCount, 2)
  assert.equal(result.success, true)
  assert.equal(result.terminalReason, 'done')
  assert.equal(result.finalText, finalAnswer)
  assert.equal(
    outputEvents.some((event) => String(event.chunk || '').includes('未能打开反问卡')),
    false
  )
})

test('agent sdk runtime exposes authorized skill tools for explicit skill turns', async () => {
  const seenToolNames: string[] = []
  let remembered = false
  __setSkillActionToolDefsForTests(() => [
    {
      name: 'skill_video_expert_pipeline',
      description: 'Run VEA pipeline',
      kind: 'skill_action',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      visibility: 'public',
      params: []
    },
    {
      name: 'skill_rss_update',
      description: 'Update RSS',
      kind: 'skill_action',
      skillId: 'lets-go-rss',
      action: 'rss_update',
      visibility: 'public',
      params: []
    }
  ])
  const runtime = createRuntime({
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [
        { id: 'video-expert-analyzer', name: 'Video Expert Analyzer' }
      ],
      buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline'],
      rememberExplicitReferenceSkillHint: () => {
        remembered = true
        rememberLastReferenceSkill('scope-skill-tools', {
          id: 'video-expert-analyzer',
          name: 'Video Expert Analyzer'
        })
        return true
      }
    },
    runAgent: async ({ tools, onTextDelta }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      onTextDelta('技能工具面已加载')
      return { finalText: '技能工具面已加载' }
    }
  })
  runtime.newSession('butler::scope-skill-tools', 'system prompt')

  try {
    const result = await runtime.sendMessage(
      'butler::scope-skill-tools',
      '使用 video expert analyzer 分析视频',
      'run-skill-tools',
      {
        publicSessionId: 'scope-skill-tools',
        taskId: 'task-skill-tools'
      }
    )

    assert.equal(result.success, true)
    assert.equal(remembered, true)
    assert.equal(seenToolNames.includes('skill_video_expert_pipeline'), true)
    assert.equal(seenToolNames.includes('skill_run_shell'), false)
    assert.equal(seenToolNames.includes('skill_inspect_run_state'), true)
    assert.equal(seenToolNames.includes('skill_start_detached'), false)
    assert.equal(seenToolNames.includes('skill_rss_update'), false)
  } finally {
    __setSkillActionToolDefsForTests(null)
    clearLastReferenceSkill('scope-skill-tools')
  }
})

test('agent sdk runtime preserves browser tools when an explicit reference skill joins a browser workflow', async () => {
  const seenToolNames: string[] = []
  let seenInstructions = ''
  const prompt = '打开小红书网页，帮我发布一篇笔记'
  const runtime = createRuntime({
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [{ id: 'extract', name: 'extract' }],
      buildPreferredSkillToolNames: () => ['skill_ask_user', 'skill_inspect_run_state'],
      rememberExplicitReferenceSkillHint: () => {
        rememberLastReferenceSkill('scope-browser-reference-skill-tools', {
          id: 'extract',
          name: 'extract'
        })
        return true
      }
    },
    runAgent: async ({ tools, instructions, onTextDelta }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      seenInstructions = instructions
      onTextDelta('浏览器工具面已加载')
      return { finalText: '浏览器工具面已加载' }
    }
  })
  runtime.setBrowserController({} as never)
  runtime.newSession('butler::scope-browser-reference-skill-tools', 'system prompt')

  try {
    const result = await runtime.sendMessage(
      'butler::scope-browser-reference-skill-tools',
      prompt,
      'run-browser-reference-skill-tools',
      {
        publicSessionId: 'scope-browser-reference-skill-tools',
        taskId: 'task-browser-reference-skill-tools',
        requestEnvelope: buildRequestEnvelope({ userText: prompt })
      }
    )

    assert.equal(result.success, true)
    assert.equal(seenToolNames.includes('skill_ask_user'), true)
    for (const expected of [
      'browser_navigate',
      'browser_click',
      'browser_type',
      'browser_power_eval',
      'browser_power_cdp'
    ]) {
      assert.equal(seenToolNames.includes(expected), true, `${expected} should remain visible`)
    }
    assert.match(seenInstructions, /Power 网页操作配方/)
    assert.match(seenInstructions, /页面结构探测/)
    assert.match(seenInstructions, /读回验证/)
    assert.match(seenInstructions, /viewport=0/)
    assert.match(seenInstructions, /Page\.getFrameTree/)
    assert.doesNotMatch(seenInstructions, /一律走视觉通道|禁用脚本（封号风险）/)
  } finally {
    clearLastReferenceSkill('scope-browser-reference-skill-tools')
  }
})

test('agent sdk runtime does not expose clarification tools for unrelated chat with stale reference hint', async () => {
  const prompt = 'hi，今天让你跟我聊哲学的话，你会怎么开头'
  const answer =
    '我会从一个能把球轻轻传回给你的问题开始：我到底是谁？如果今天只谈一件事，什么问题最值得停下来？'
  const seenToolNames: string[] = []
  const outputEvents: Array<Record<string, unknown>> = []
  const runtime = createRuntime({
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [],
      peekCurrentReferenceSkillHint: () => ({ id: 'hfp-space-design', name: 'hfp-space-design' }),
      getCurrentReferenceSkillHint: () => {
        throw new Error('stale reference hint should not be consumed for unrelated chat')
      },
      buildPreferredSkillToolNames: () => {
        throw new Error('stale reference hint should not expose skill primitives')
      }
    },
    runAgent: async ({ tools, onTextDelta }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      onTextDelta(answer)
      return { finalText: answer }
    }
  })
  runtime.on('output', (event) => outputEvents.push(event))
  runtime.newSession('butler::scope-stale-skill-chat', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-stale-skill-chat',
    prompt,
    'run-stale-skill-chat',
    {
      publicSessionId: 'scope-stale-skill-chat',
      taskId: 'task-stale-skill-chat',
      requestEnvelope: {
        primaryInstruction: prompt,
        pureUserText: prompt,
        rawUserText: prompt,
        resources: []
      }
    }
  )

  assert.equal(result.success, true)
  assert.equal(result.terminalReason, 'done')
  assert.equal(result.finalText, answer)
  assert.equal(seenToolNames.includes('skill_ask_user'), false)
  assert.equal(seenToolNames.includes('ask_user_questions'), false)
  assert.equal(
    outputEvents.some(
      (event) => event.type === 'text' && String(event.chunk || '').includes(answer)
    ),
    true
  )
  assert.equal(
    outputEvents.some((event) => String(event.chunk || '').includes('未能打开反问卡')),
    false
  )
})

test('agent sdk runtime ignores stale skill names in assembled context for no-tool image analysis', async () => {
  const taskId = 'task-image-analysis-direct'
  const now = new Date('2026-06-27T06:25:00.000Z').toISOString()
  const rows = new Map<string, TaskProjectionRecord>()
  rows.set(taskId, {
    taskId,
    scopeId: 'scope-image-analysis-direct',
    runId: 'run-image-analysis-direct',
    taskType: 'multi_step_task',
    module: 'skill',
    status: 'running',
    interactionState: 'running',
    steps: [],
    proofRefs: [],
    createdAt: now,
    updatedAt: now
  } as TaskProjectionRecord)
  const store = {
    get: (id: string) => rows.get(id) ?? null,
    update: (id: string, patch: Partial<TaskProjectionRecord>) => {
      rows.set(id, { ...rows.get(id)!, ...patch })
    }
  }
  const userPrompt = '那你试试按照这几层的方法来分析这张图'
  const assembledMessage = [
    '## 环境信息',
    '旧上下文提到 hfp-space-design，但这不是本轮用户要求。',
    '## 最近会话摘要',
    '上一轮使用过 hfp-space-design。',
    '',
    userPrompt
  ].join('\n')
  const answer = '分析已经完成了。简单总结一下：先看清楚是什么，再判断它为什么这样呈现。'
  const seenToolNames: string[] = []
  const scannedTexts: string[] = []
  const runtime = createRuntime({
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: (text: string) => {
        scannedTexts.push(text)
        return text.includes('hfp-space-design')
          ? [{ id: 'hfp-space-design', name: 'hfp-space-design' }]
          : []
      },
      peekCurrentReferenceSkillHint: () => ({ id: 'hfp-space-design', name: 'hfp-space-design' }),
      getCurrentReferenceSkillHint: () => {
        throw new Error('stale context-only skill mention must not be consumed')
      },
      buildPreferredSkillToolNames: () => {
        throw new Error('stale context-only skill mention must not expose primitives')
      },
      rememberExplicitReferenceSkillHint: () => {
        throw new Error('context-only skill mention must not be remembered as explicit')
      }
    },
    runAgent: async ({ tools, onTextDelta }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      onTextDelta(answer)
      return { finalText: answer }
    }
  })
  runtime.setRuntime({
    publishScopeRunEvent: () => {},
    getTaskProjectionStoreForFinalize: () => store
  } as never)
  runtime.newSession('butler::scope-image-analysis-direct', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-image-analysis-direct',
    assembledMessage,
    'run-image-analysis-direct',
    {
      publicSessionId: 'scope-image-analysis-direct',
      taskId,
      requestEnvelope: {
        primaryInstruction: userPrompt,
        pureUserText: userPrompt,
        rawUserText: assembledMessage,
        resources: [{ name: 'download-2.jpg', path: '/tmp/download-2.jpg', kind: 'image' }]
      }
    }
  )

  assert.equal(result.success, true)
  assert.equal(result.terminalReason, 'done')
  assert.equal(result.taskType, 'direct_answer')
  assert.equal(result.finalText, answer)
  assert.equal(seenToolNames.includes('skill_ask_user'), false)
  assert.equal(
    scannedTexts.some((text) => text.includes('hfp-space-design')),
    false
  )
  const row = rows.get(taskId)!
  const checkins = row.checkins as CheckInRecord[]
  assert.equal(checkins[0].verdict, 'accept')
  assert.equal(
    (row.proofRefs as Array<{ kind: string }>).some((proof) => proof.kind === 'assistant_response'),
    true
  )
})

test('agent sdk runtime keeps stale reference tools for natural skill follow-ups', async () => {
  const seenToolNames: string[] = []
  const runtime = createRuntime({
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [],
      peekCurrentReferenceSkillHint: () => ({ id: 'hfp-space-design', name: 'hfp-space-design' }),
      getCurrentReferenceSkillHint: () => ({ id: 'hfp-space-design', name: 'hfp-space-design' }),
      buildPreferredSkillToolNames: () => ['skill_ask_user', 'skill_inspect_run_state']
    },
    runAgent: async ({ tools }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      return { finalText: '继续推进' }
    }
  })
  runtime.newSession('butler::scope-natural-skill-followup', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-natural-skill-followup',
    '好的，那就按第二个方案推进，预算两万',
    'run-natural-skill-followup',
    {
      publicSessionId: 'scope-natural-skill-followup',
      taskId: 'task-natural-skill-followup',
      requestEnvelope: {
        primaryInstruction: '好的，那就按第二个方案推进，预算两万',
        resources: []
      }
    }
  )

  assert.equal(result.success, true)
  assert.equal(seenToolNames.includes('skill_ask_user'), true)
  assert.equal(seenToolNames.includes('skill_inspect_run_state'), true)
})

test('agent sdk runtime keeps reference tools for unfinished skill task facts', async () => {
  const seenToolNames: string[] = []
  const runtime = createRuntime({
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [],
      peekCurrentReferenceSkillHint: () => ({ id: 'hfp-space-design', name: 'hfp-space-design' }),
      getCurrentReferenceSkillHint: () => ({ id: 'hfp-space-design', name: 'hfp-space-design' }),
      buildPreferredSkillToolNames: () => ['skill_ask_user', 'skill_inspect_run_state']
    },
    getScopeTaskRefs: () => [{ taskId: 'task-hfp-active', status: 'running' }],
    runAgent: async ({ tools }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      return { finalText: '继续推进' }
    }
  })
  runtime.newSession('butler::scope-active-skill-followup', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-active-skill-followup',
    '好的，那就按第二个方案继续推进，预算两万，门店面积大概三十平',
    'run-active-skill-followup',
    {
      publicSessionId: 'scope-active-skill-followup',
      taskId: 'task-active-skill-followup',
      requestEnvelope: {
        primaryInstruction: '好的，那就按第二个方案继续推进，预算两万，门店面积大概三十平',
        resources: []
      }
    }
  )

  assert.equal(result.success, true)
  assert.equal(seenToolNames.includes('skill_ask_user'), true)
  assert.equal(seenToolNames.includes('skill_inspect_run_state'), true)
})

test('agent sdk runtime exposes skill_run_shell for explicit script-backed reference skills', async () => {
  const skillRoot = await mkdtemp(join(tmpdir(), 'ready-script-reference-skill-'))
  await mkdir(join(skillRoot, 'scripts'))
  const seenToolNames: string[] = []
  let seenInstructions = ''
  let injected = false
  const runtime = createRuntime({
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [
        {
          id: 'okf-bundle',
          name: 'OKF Bundle',
          managedPath: skillRoot
        }
      ],
      buildPreferredSkillToolNames: () => [
        'skill_run_shell',
        'skill_write_artifact',
        'skill_read_artifact'
      ],
      rememberExplicitReferenceSkillHint: () => {
        rememberLastReferenceSkill('scope-script-reference-tools', {
          id: 'okf-bundle',
          name: 'OKF Bundle'
        })
        return true
      },
      maybeInjectExplicitSkillContext: async ({ session }) => {
        injected = true
        session.messages.push({
          role: 'system',
          content: '已加载技能「OKF Bundle」。必须实际创建知识包文件夹并写入 .md 文件。'
        })
      }
    },
    runAgent: async ({ tools, instructions, onTextDelta }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      seenInstructions = instructions
      onTextDelta('脚本型 reference skill 工具面已加载')
      return { finalText: '脚本型 reference skill 工具面已加载' }
    }
  })
  runtime.newSession('butler::scope-script-reference-tools', 'system prompt')

  try {
    const result = await runtime.sendMessage(
      'butler::scope-script-reference-tools',
      '使用 okf-bundle 提取知识包',
      'run-script-reference-tools',
      {
        publicSessionId: 'scope-script-reference-tools',
        taskId: 'task-script-reference-tools'
      }
    )

    assert.equal(result.success, true)
    assert.equal(injected, true)
    assert.match(seenInstructions, /必须实际创建知识包文件夹/)
    assert.equal(seenToolNames.includes('skill_run_shell'), true)
    assert.equal(seenToolNames.includes('skill_write_artifact'), true)
    assert.equal(seenToolNames.includes('skill_start_detached'), false)
  } finally {
    clearLastReferenceSkill('scope-script-reference-tools')
    await rm(skillRoot, { recursive: true, force: true })
  }
})

test('agent sdk runtime threads selected skill authorization into tool execution', async () => {
  const skillDefinition = createToolDefinition({
    name: 'skill_video_expert_pipeline',
    groupId: 'skills',
    domain: 'skill',
    kind: 'job',
    description: 'Run VEA pipeline'
  })
  let listAuthorizationMode: string | null = null
  let executionAuthorization: Record<string, unknown> | null = null
  const runtime = createRuntime({
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [
        { id: 'video-expert-analyzer', name: 'Video Expert Analyzer' }
      ],
      buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline']
    },
    listToolDefinitions: ({ authorization }) => {
      listAuthorizationMode = authorization.mode
      return [skillDefinition]
    },
    executeToolCall: async (_toolName, _args, context) => {
      executionAuthorization =
        (context as unknown as { authorization?: Record<string, unknown> }).authorization || null
      return createToolExecutionOutput('skill launched', {
        shape: 'json',
        projectionPatch: { taskTitle: 'VEA' }
      })
    },
    runAgent: async ({ tools, onTextDelta }) => {
      const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      await sdkTool.invoke({}, JSON.stringify({ input: 'video.mp4' }))
      onTextDelta('技能已启动')
      return { finalText: '技能已启动' }
    }
  })
  runtime.newSession('butler::scope-skill-auth', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-skill-auth',
    '使用 video expert analyzer',
    'run-skill-auth',
    {
      publicSessionId: 'scope-skill-auth',
      taskId: 'task-skill-auth'
    }
  )

  assert.equal(result.success, true)
  assert.equal(result.taskType, 'multi_step_task')
  assert.equal(listAuthorizationMode, 'selected')
  assert.equal(executionAuthorization?.mode, 'selected')
  assert.equal(executionAuthorization?.skillId, 'video-expert-analyzer')
  assert.deepEqual(result.usedTools, ['skill_video_expert_pipeline'])
  assert.deepEqual(result.projectionTruth?.projectionPatch, { taskTitle: 'VEA' })
})

test('agent sdk runtime redacts model-visible tool output while carrying raw active roots into later SDK tool calls', async () => {
  const outputDir = '/Users/alice/ready-agent-sdk-active-root'
  const pipelineDefinition = createToolDefinition({
    name: 'skill_video_expert_pipeline',
    groupId: 'skills',
    domain: 'skill',
    kind: 'job',
    description: 'Run VEA pipeline'
  })
  const readArtifactDefinition = createToolDefinition({
    name: 'skill_read_artifact',
    groupId: 'skills',
    domain: 'skill',
    kind: 'read',
    description: 'Read skill artifact'
  })
  let observedRoots: string[] = []
  let pipelineToolReturn = ''
  const runtime = createRuntime({
    listToolDefinitions: () => [pipelineDefinition, readArtifactDefinition],
    executeToolCall: async (name, _args, context) => {
      if (name === 'skill_video_expert_pipeline') {
        return createToolExecutionOutput(
          JSON.stringify({
            status: 'child_launched',
            childRunId: 'child-active-root',
            skillId: 'video-expert-analyzer',
            action: 'video_expert_pipeline',
            outputDir,
            runStatePath: join(outputDir, 'run_state.json'),
            parentNextHint: 'wait_for_close_event'
          }),
          {
            shape: 'json',
            data: {
              status: 'child_launched',
              childRunId: 'child-active-root',
              skillId: 'video-expert-analyzer',
              action: 'video_expert_pipeline',
              outputDir,
              runStatePath: join(outputDir, 'run_state.json'),
              parentNextHint: 'wait_for_close_event'
            },
            contextModifier: {
              activeFrame: {
                activeArtifactRoots: [outputDir]
              }
            }
          }
        )
      }
      observedRoots = [
        ...((context as { activeFrame?: { activeArtifactRoots?: string[] } }).activeFrame
          ?.activeArtifactRoots || [])
      ]
      return createToolExecutionOutput('artifact read', { shape: 'json', data: { ok: true } })
    },
    runAgent: async ({ tools }) => {
      const pipelineTool = tools.find((item) => item.name === 'skill_video_expert_pipeline') as {
        invoke: (context: unknown, input: string) => Promise<string>
      }
      const readTool = tools.find((item) => item.name === 'skill_read_artifact') as {
        invoke: (context: unknown, input: string) => Promise<string>
      }
      pipelineToolReturn = await pipelineTool.invoke(
        {},
        JSON.stringify({ url: 'fixture.mp4', outputDir })
      )
      await readTool.invoke({}, JSON.stringify({ relativePath: 'scene_scores.json' }))
      return { finalText: '已读取产物' }
    }
  })
  runtime.newSession('butler::scope-skill-active-root', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-skill-active-root',
    '使用 VEA 分析视频',
    'run-skill-active-root',
    {
      publicSessionId: 'scope-skill-active-root',
      taskId: 'task-skill-active-root'
    }
  )

  assert.equal(result.success, true)
  assert.doesNotMatch(pipelineToolReturn, /\/Users\/alice/)
  assert.match(pipelineToolReturn, /\/Users\/<redacted>\/ready-agent-sdk-active-root/)
  assert.ok(observedRoots.includes(outputDir))
})

test('agent sdk runtime recovers max-turn after long skill checkpoint instead of surfacing send failure', async () => {
  const outputDir = join(tmpdir(), 'ready-agent-sdk-long-skill-checkpoint')
  const statuses: Array<Record<string, unknown>> = []
  const pipelineDefinition = createToolDefinition({
    name: 'skill_video_expert_pipeline',
    groupId: 'skills',
    domain: 'skill',
    kind: 'job',
    description: 'Run VEA pipeline'
  })
  const runtime = createRuntime({
    listToolDefinitions: () => [pipelineDefinition],
    executeToolCall: async () =>
      createToolExecutionOutput(
        JSON.stringify({
          status: 'child_launched',
          childRunId: 'child-checkpoint',
          skillId: 'video-expert-analyzer',
          action: 'video_expert_pipeline',
          outputDir,
          runStatePath: join(outputDir, 'run_state.json'),
          parentNextHint: 'wait_for_close_event'
        }),
        {
          shape: 'json',
          data: {
            status: 'child_launched',
            childRunId: 'child-checkpoint',
            skillId: 'video-expert-analyzer',
            action: 'video_expert_pipeline',
            outputDir,
            runStatePath: join(outputDir, 'run_state.json'),
            parentNextHint: 'wait_for_close_event'
          }
        }
      ),
    runAgent: async ({ tools }) => {
      const pipelineTool = tools[0] as {
        invoke: (context: unknown, input: string) => Promise<string>
      }
      await pipelineTool.invoke({}, JSON.stringify({ url: 'fixture.mp4', outputDir }))
      throw new Error('Max turns (16) exceeded')
    }
  })
  runtime.on('status', (event) => statuses.push(event as Record<string, unknown>))
  runtime.newSession('butler::scope-long-skill-checkpoint', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-long-skill-checkpoint',
    '使用 VEA 分析视频',
    'run-long-skill-checkpoint',
    {
      publicSessionId: 'scope-long-skill-checkpoint',
      taskId: 'task-long-skill-checkpoint'
    }
  )

  assert.equal(result.success, true)
  assert.equal(result.terminalReason, 'checkpoint_background')
  assert.match(result.finalText, /技能任务已启动/)
  assert.equal(
    statuses.some((event) => event.status === 'error'),
    false
  )
  assert.equal(
    statuses.some(
      (event) => event.status === 'checkpoint' && event.terminalReason === 'checkpoint_background'
    ),
    true
  )
})

test('agent sdk runtime reports provider quota failures as external blockers', async () => {
  const errors: Array<Record<string, unknown>> = []
  const statuses: Array<Record<string, unknown>> = []
  const runtime = createRuntime({
    runAgent: async () => {
      throw new Error('429 You exceeded your current quota')
    }
  })
  runtime.on('error', (event) => errors.push(event))
  runtime.on('status', (event) => statuses.push(event))
  runtime.newSession('butler::scope-provider-error', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-provider-error',
    '你好',
    'run-provider-error',
    {
      publicSessionId: 'scope-provider-error',
      taskId: 'task-provider-error'
    }
  )

  assert.equal(result.success, false)
  assert.equal(result.terminalReason, 'blocked_external')
  assert.equal(errors[0]?.errorKind, 'blocked_external')
  assert.deepEqual(
    statuses.map((event) => [event.status, event.terminalReason]),
    [
      ['working', undefined],
      ['error', 'blocked_external']
    ]
  )
})

test('agent sdk runtime keeps default model-visible surface intent-scoped', async () => {
  const seenToolNames: string[] = []
  const runtime = createRuntime({
    runAgent: async ({ tools, onTextDelta }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      onTextDelta('工具面已加载')
      return { finalText: '工具面已加载' }
    }
  })
  runtime.newSession('butler::scope-tools', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-tools',
    '整理这篇文档并查一下资料',
    'run-tools',
    {
      publicSessionId: 'scope-tools',
      taskId: 'task-tools'
    }
  )

  assert.equal(result.success, true)
  assert.ok(seenToolNames.includes('document_set_content'))
  assert.ok(seenToolNames.includes('file_search'))
  assert.ok(seenToolNames.includes('memory_search'))
  assert.ok(seenToolNames.includes('session_search'))
  assert.equal(seenToolNames.includes('rss_fetch_updates'), false)
  assert.equal(seenToolNames.includes('calendar_list_window'), false)
  assert.equal(seenToolNames.includes('web_search'), false)
  assert.equal(
    seenToolNames.some((name) => name.startsWith('browser_')),
    false
  )
})

test('agent sdk runtime exposes browser, feishu, file, pet, and research tools when runtime is available', async () => {
  const seenToolNames: string[] = []
  const runtime = createRuntime({
    runAgent: async ({ tools, onTextDelta }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      onTextDelta('工具面已加载')
      return { finalText: '工具面已加载' }
    }
  })
  runtime.setBrowserController({} as never)
  runtime.setRuntime({
    isChannelTypeAvailable: (channelType: string) => channelType === 'feishu-app',
    getConversationScope: () => null
  } as never)
  runtime.newSession('butler::scope-domain-tools', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-domain-tools',
    '打开网页搜索资料，点击并输入内容，同时回复飞书，找文件，给宠物贴一条提醒，并对比市场趋势',
    'run-domain-tools',
    {
      publicSessionId: 'scope-domain-tools',
      taskId: 'task-domain-tools'
    }
  )

  assert.equal(result.success, true)
  for (const expected of [
    'browser_navigate',
    'browser_read_page',
    'browser_click',
    'browser_type',
    'browser_start_task',
    'feishu_message_reply',
    'file_search',
    'pet_show_sticky_note',
    'web_search',
    'web_fetch',
    'present_file'
  ]) {
    assert.ok(seenToolNames.includes(expected), `${expected} should be SDK-visible`)
  }
})

test('agent sdk runtime reuses one browser write lease across consecutive tool calls in a run', async () => {
  __resetBrowserWriteLeaseServiceForTests()
  try {
    const goBackDefinition = createToolDefinition({
      name: 'browser_go_back',
      groupId: 'browser',
      domain: 'browser',
      kind: 'write',
      concurrency: 'serialized',
      description: 'Go back',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    })
    const navigateDefinition = createToolDefinition({
      name: 'browser_navigate',
      groupId: 'browser',
      domain: 'browser',
      kind: 'write',
      concurrency: 'serialized',
      description: 'Navigate',
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' }
        },
        required: ['url'],
        additionalProperties: false
      }
    })
    const leaseIds: string[] = []
    const runtime = createRuntime({
      listToolDefinitions: () => [goBackDefinition, navigateDefinition],
      executeToolCall: async (toolName, _args, context) => {
        const turnLease = (context as { browserLease?: BrowserTurnLease | null }).browserLease
        assert.ok(turnLease, 'browser tools must receive a turn lease')
        const gate = turnLease.ensureGate()
        if (isAgentBrowserError(gate)) {
          return createToolExecutionOutput(gate.message, {
            shape: 'json',
            data: gate
          })
        }
        leaseIds.push(gate.leaseId)
        return createToolExecutionOutput(`${toolName} ok`, {
          shape: 'json',
          data: { ok: true, leaseId: gate.leaseId }
        })
      },
      runAgent: async ({ tools, onTextDelta }) => {
        const byName = new Map(
          tools.map((tool) => [
            tool.name,
            tool as { invoke: (context: unknown, input: string) => Promise<string> }
          ])
        )
        const first = await byName.get('browser_go_back')?.invoke({}, '{}')
        const second = await byName
          .get('browser_navigate')
          ?.invoke({}, JSON.stringify({ url: 'https://example.com' }))
        assert.doesNotMatch(first || '', /lease_held/)
        assert.doesNotMatch(second || '', /lease_held/)
        onTextDelta('浏览器操作完成')
        return { finalText: '浏览器操作完成' }
      }
    })
    runtime.setBrowserController({} as never)
    runtime.newSession('butler::scope-browser-lease-reuse', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-browser-lease-reuse',
      '打开网页并返回',
      'run-browser-lease-reuse',
      {
        publicSessionId: 'scope-browser-lease-reuse',
        taskId: 'task-browser-lease-reuse'
      }
    )

    assert.equal(result.success, true)
    assert.equal(leaseIds.length, 2)
    assert.equal(leaseIds[0], leaseIds[1], 'one SDK run must reuse the same browser lease')
  } finally {
    __resetBrowserWriteLeaseServiceForTests()
  }
})

test('agent sdk runtime exposes upload browser tools for upload workflow intent', async () => {
  const seenToolNames: string[] = []
  const runtime = createRuntime({
    runAgent: async ({ tools, onTextDelta }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      onTextDelta('上传工具面已加载')
      return { finalText: '上传工具面已加载' }
    }
  })
  runtime.setBrowserController({} as never)
  runtime.newSession('butler::scope-upload-tools', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-upload-tools',
    '把这个附件上传到当前网页并提交',
    'run-upload-tools',
    {
      publicSessionId: 'scope-upload-tools',
      taskId: 'task-upload-tools'
    }
  )

  assert.equal(result.success, true)
  assert.ok(seenToolNames.includes('browser_list_upload_targets'))
  assert.ok(seenToolNames.includes('browser_upload_scope_attachment'))
  // 6e99f0e6（交易成功证明）起，唯一裁决点 capability-resolver 对
  // browser_upload_workflow 同步开放 browser_content_tasks（Power 证明工具
  // 所在组），browser_start_task 随组曝光——与 capability-resolver.test.ts 同源。
  assert.equal(seenToolNames.includes('browser_start_task'), true)
})

test('agent sdk runtime records tool and artifact proofs before final adjudication', async () => {
  const taskId = 'task-proof-collection'
  const now = new Date('2026-06-16T12:00:00.000Z').toISOString()
  const rows = new Map<string, TaskProjectionRecord>()
  rows.set(taskId, {
    taskId,
    scopeId: 'scope-proof-collection',
    runId: 'run-proof-collection',
    taskType: 'multi_step_task',
    module: 'document',
    status: 'running',
    interactionState: 'running',
    steps: [],
    proofRefs: [],
    createdAt: now,
    updatedAt: now
  } as TaskProjectionRecord)
  const store = {
    get: (id: string) => rows.get(id) ?? null,
    update: (id: string, patch: Partial<TaskProjectionRecord>) => {
      rows.set(id, { ...rows.get(id)!, ...patch })
    }
  }
  const runtime = createRuntime({
    listToolDefinitions: () => [
      createToolDefinition({
        name: 'document_save_tab',
        groupId: 'document',
        domain: 'document',
        kind: 'write',
        concurrency: 'serialized',
        schema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      })
    ],
    executeToolCall: async () =>
      createToolExecutionOutput('已保存文档：/tmp/world-cup-report.md', {
        shape: 'json',
        data: { documentSaved: true, path: '/tmp/world-cup-report.md' }
      }),
    runAgent: async ({ tools, onTextDelta }) => {
      const saveTool = tools.find((tool) => tool.name === 'document_save_tab') as
        | { invoke: (context: unknown, input: string) => Promise<string> }
        | undefined
      assert.ok(saveTool)
      await saveTool.invoke({}, '{}')
      onTextDelta('文档已保存')
      return { finalText: '文档已保存' }
    }
  })
  runtime.setRuntime({
    publishScopeRunEvent: () => {},
    getTaskProjectionStoreForFinalize: () => store
  } as never)
  runtime.newSession('butler::scope-proof-collection', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-proof-collection',
    '保存研究报告',
    'run-proof-collection',
    {
      publicSessionId: 'scope-proof-collection',
      taskId
    }
  )

  assert.equal(result.success, true)
  const row = rows.get(taskId)!
  const proofKinds = (row.proofRefs as Array<{ kind: string; ref: string }>).map(
    (proof) => proof.kind
  )
  assert.equal(proofKinds.includes('tool_result'), true)
  assert.equal(
    (row.proofRefs as Array<{ kind: string; ref: string }>).some(
      (proof) => proof.kind === 'artifact' && proof.ref === '/tmp/world-cup-report.md'
    ),
    true
  )
  const checkins = row.checkins as CheckInRecord[]
  assert.equal(checkins[0].verdict, 'accept')
})

test('agent sdk runtime keeps MCP tools scoped to explicit OAuth authorization', async () => {
  __resetMcpRegistryForTests()
  __resetMcpOAuthForTests()
  registerMcpServer({
    serverId: 'sdk-scope',
    toolNames: ['mcp_sdk_scope_action'],
    requiresAuthorization: true
  })
  setCachedMcpOAuthToken('sdk-scope', {
    accessToken: 'tok-sdk',
    expiresAt: Date.now() + 60_000,
    scopes: ['read']
  })
  authorizeMcpToolForScope('sdk-scope', 'mcp_sdk_scope_action', 'scope-allowed', 'scope-allowed')

  const seenByScope = new Map<string, string[]>()
  const runtime = createRuntime({
    runAgent: async ({ tools, onTextDelta, sessionId }) => {
      seenByScope.set(
        sessionId || '',
        tools.map((item) => item.name)
      )
      onTextDelta('MCP 工具面已加载')
      return { finalText: 'MCP 工具面已加载' }
    }
  })

  runtime.newSession('butler::scope-allowed', 'system prompt')
  const allowed = await runtime.sendMessage(
    'butler::scope-allowed',
    '使用已授权的 MCP 工具',
    'run-mcp-allowed',
    {
      publicSessionId: 'scope-allowed',
      taskId: 'task-mcp-allowed'
    }
  )
  runtime.newSession('butler::scope-denied', 'system prompt')
  const denied = await runtime.sendMessage(
    'butler::scope-denied',
    '使用未授权的 MCP 工具',
    'run-mcp-denied',
    {
      publicSessionId: 'scope-denied',
      taskId: 'task-mcp-denied'
    }
  )

  assert.equal(allowed.success, true)
  assert.equal(denied.success, true)
  assert.equal(seenByScope.get('scope-allowed')?.includes('mcp_sdk_scope_action'), true)
  assert.equal(seenByScope.get('scope-denied')?.includes('mcp_sdk_scope_action'), false)

  __resetMcpRegistryForTests()
  __resetMcpOAuthForTests()
})

test('agent sdk runtime gates vision tools with resolved provider capability', async () => {
  __resetMcpRegistryForTests()
  registerMcpServer({
    serverId: 'sdk-vision',
    toolNames: ['view_image', 'mcp_plain_text_action'],
    requiresAuthorization: false
  })

  const seenToolNames: string[] = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        model: 'o3-mini',
        visionMode: 'off'
      }
    }),
    runAgent: async ({ tools, onTextDelta }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      onTextDelta('视觉工具检查完成')
      return { finalText: '视觉工具检查完成' }
    }
  })
  runtime.newSession('butler::scope-vision-gate', 'system prompt')

  try {
    const result = await runtime.sendMessage(
      'butler::scope-vision-gate',
      '看一下图片并总结',
      'run-vision-gate',
      {
        publicSessionId: 'scope-vision-gate',
        taskId: 'task-vision-gate'
      }
    )

    assert.equal(result.success, true)
    assert.equal(seenToolNames.includes('mcp_plain_text_action'), true)
    assert.equal(seenToolNames.includes('view_image'), false)
  } finally {
    __resetMcpRegistryForTests()
  }
})

test('agent sdk runtime does not leak host-only or unauthorized skill tools by default', async () => {
  const seenToolNames: string[] = []
  const runtime = createRuntime({
    runAgent: async ({ tools, onTextDelta }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      onTextDelta('工具检查完成')
      return { finalText: '工具检查完成' }
    }
  })
  runtime.newSession('butler::scope-internal-tools', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-internal-tools',
    '看看可用能力',
    'run-internal-tools',
    {
      publicSessionId: 'scope-internal-tools',
      taskId: 'task-internal-tools'
    }
  )

  assert.equal(result.success, true)
  assert.equal(seenToolNames.includes('system_run_openclaw'), false)
  assert.equal(seenToolNames.includes('system_run_embedded_python'), false)
  assert.equal(seenToolNames.includes('skill_run_shell'), false)
  assert.equal(seenToolNames.includes('skill_patch_config'), false)
})

test('G1: resolveToolFailurePageUrl prefers the targeted tab, falls back to active tab, never mis-attributes', () => {
  const controller = {
    getTabList: () => [
      { id: 'tab-1', url: 'https://active.example.com/a' },
      { id: 'tab-6', url: 'https://jp.pinterest.com/u/board' }
    ],
    getActiveTab: () => ({ url: 'https://active.example.com/a' })
  }
  // targeted tab_id wins over the active tab (no wrong-domain attribution)
  assert.equal(
    resolveToolFailurePageUrl(controller, { tab_id: 'tab-6' }),
    'https://jp.pinterest.com/u/board'
  )
  // no tab_id → active tab
  assert.equal(resolveToolFailurePageUrl(controller, {}), 'https://active.example.com/a')
  // targeted tab not found (e.g. closed) → null, NOT the active tab
  assert.equal(resolveToolFailurePageUrl(controller, { tab_id: 'tab-gone' }), null)
  // no controller → null
  assert.equal(resolveToolFailurePageUrl(null, { tab_id: 'tab-6' }), null)
})

// ============================================================================
// P0-1 (2026-07-02 P0 visibility batch) — hold-until-final response-boundary
// release. T1/T3 pin the pre-existing no-leak contract (must be green before
// AND after the change); T2 asserts the new boundary-release behavior.
// Fixture mirrors the proven browser+explicit-skill shape (see the
// "preserves browser tools when an explicit reference skill joins" test):
// that combination surfaces the skills capability group, so skill_ask_user
// lands in allowedToolNames and holdNativeTextUntilFinal turns ON.
// ============================================================================

function createSkillHoldRuntime(
  runAgent: NonNullable<AgentSdkRuntimeDeps['runAgent']>
): AgentSdkRuntime {
  const runtime = createRuntime({
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [{ id: 'extract', name: 'extract' }],
      buildPreferredSkillToolNames: () => ['skill_ask_user', 'skill_inspect_run_state'],
      rememberExplicitReferenceSkillHint: () => true
    },
    executeToolCall: async () =>
      createToolExecutionOutput('查到了页面状态', {
        shape: 'json',
        data: { ok: true }
      }),
    runAgent
  })
  runtime.setBrowserController({} as never)
  return runtime
}

function joinedTextOutputs(events: Array<Record<string, unknown>>): string {
  return events
    .filter((event) => event.type === 'text')
    .map((event) => String(event.chunk || ''))
    .join('\n')
}

const HOLD_PROMPT = '打开小红书网页，用 extract 技能整理并发布一篇笔记'

test('P0-1 pin: clarification-shaped final text on a skill turn never leaks into text output (steer path)', async () => {
  let runAgentCalls = 0
  const runtime = createSkillHoldRuntime(async ({ tools, onTextDelta }) => {
    runAgentCalls += 1
    if (runAgentCalls === 1) {
      assert.ok(
        tools.some((item) => (item as { name?: string }).name === 'skill_ask_user'),
        'fixture must produce a hold turn (skill_ask_user exposed)'
      )
      onTextDelta('需要你确认预算')
      onTextDelta('是多少，才能继续。')
      return { finalText: '需要你确认预算是多少，才能继续。' }
    }
    onTextDelta('好的，我按默认预算继续整理。')
    return { finalText: '好的，我按默认预算继续整理。' }
  })
  const events: Array<Record<string, unknown>> = []
  runtime.on('output', (event) => events.push(event as Record<string, unknown>))
  runtime.newSession('butler::scope-hold-steer', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-hold-steer',
    HOLD_PROMPT,
    'run-hold-steer',
    {
      publicSessionId: 'scope-hold-steer',
      taskId: 'task-hold-steer'
    }
  )

  assert.equal(result.success, true)
  assert.equal(runAgentCalls, 2, 'clarification guard should steer once and re-run the model')
  const visible = joinedTextOutputs(events)
  assert.ok(
    !visible.includes('才能继续'),
    `steered clarification text must never surface: ${visible}`
  )
  assert.ok(visible.includes('好的，我按默认预算继续整理。'))
})

test('P0-1: hold turn flushes buffered narration at the native tool boundary (text before tool_use, no dup/loss)', async () => {
  const runtime = createSkillHoldRuntime(async ({ tools, onTextDelta }) => {
    onTextDelta('我先查一下页面状态。')
    const anyTool = tools.find((item) => {
      const name = (item as { name?: string }).name || ''
      return name.startsWith('browser_') || name === 'web_search'
    }) as { invoke: (context: unknown, input: string) => Promise<unknown> } | undefined
    assert.ok(anyTool, 'a native tool should be exposed to the run')
    await anyTool.invoke({}, JSON.stringify({}))
    onTextDelta('查完了，继续执行。')
    return { finalText: '查完了，继续执行。' }
  })
  const events: Array<Record<string, unknown>> = []
  runtime.on('output', (event) => events.push(event as Record<string, unknown>))
  runtime.newSession('butler::scope-hold-boundary', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-hold-boundary',
    HOLD_PROMPT,
    'run-hold-boundary',
    {
      publicSessionId: 'scope-hold-boundary',
      taskId: 'task-hold-boundary'
    }
  )

  assert.equal(result.success, true)
  const firstNarrationIndex = events.findIndex(
    (event) => event.type === 'text' && String(event.chunk || '').includes('我先查一下页面状态。')
  )
  const firstToolUseIndex = events.findIndex((event) => event.type === 'tool_use')
  assert.ok(firstNarrationIndex >= 0, 'narration before the tool call must become visible')
  assert.ok(firstToolUseIndex >= 0, 'tool_use trace event must exist')
  assert.ok(
    firstNarrationIndex < firstToolUseIndex,
    `narration must flush BEFORE the tool row (${firstNarrationIndex} vs ${firstToolUseIndex})`
  )
  const visible = joinedTextOutputs(events)
  assert.equal(
    countOccurrences(visible, '我先查一下页面状态。'),
    1,
    `narration must appear exactly once: ${visible}`
  )
  assert.equal(
    countOccurrences(visible, '查完了，继续执行。'),
    1,
    `tail text must appear exactly once: ${visible}`
  )
})

test('P0-1 pin: checkpoint after repeated clarification emits preserved text exactly once (no dup with hold)', async () => {
  let runAgentCalls = 0
  const runtime = createSkillHoldRuntime(async ({ onTextDelta }) => {
    runAgentCalls += 1
    if (runAgentCalls === 1) {
      onTextDelta('需要你确认预算是多少，才能继续。')
      return {
        finalText: '需要你确认预算是多少，才能继续。',
        usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 }
      }
    }
    onTextDelta('请提供门店面积和预算，才能继续。')
    return {
      finalText: '请提供门店面积和预算，才能继续。',
      usage: { inputTokens: 21, outputTokens: 8, totalTokens: 29 }
    }
  })
  const events: Array<Record<string, unknown>> = []
  runtime.on('output', (event) => events.push(event as Record<string, unknown>))
  runtime.newSession('butler::scope-hold-checkpoint', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-hold-checkpoint',
    HOLD_PROMPT,
    'run-hold-checkpoint',
    {
      publicSessionId: 'scope-hold-checkpoint',
      taskId: 'task-hold-checkpoint'
    }
  )

  assert.equal(result.success, true)
  assert.equal(runAgentCalls, 2)
  assert.equal(result.contextUsage?.usedInputTokens, 32)
  const visible = joinedTextOutputs(events)
  assert.equal(
    countOccurrences(visible, '请提供门店面积和预算，才能继续。'),
    1,
    `checkpoint text must appear exactly once: ${visible}`
  )
  assert.match(String(result.finalText || ''), /我先暂停在这里/)
})

test('P0-3: planning heartbeats surface before the first visible output', async () => {
  const seq: string[] = []
  const runtime = createRuntime({
    runAgent: async ({ onTextDelta }) => {
      onTextDelta('好的，这就开始。')
      return { finalText: '好的，这就开始。' }
    }
  })
  runtime.setRuntime({
    publishScopeRunEvent: (payload: Record<string, unknown>) => {
      seq.push(`hb:${String(payload.phase)}:${String(payload.latestText || '')}`)
    }
  } as never)
  runtime.on('output', (event) =>
    seq.push(`out:${String((event as Record<string, unknown>).type)}`)
  )
  runtime.newSession('butler::scope-heartbeat', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-heartbeat',
    '随便聊聊今天的安排',
    'run-heartbeat',
    {
      publicSessionId: 'scope-heartbeat',
      taskId: 'task-heartbeat'
    }
  )

  assert.equal(result.success, true)
  const firstOutputIndex = seq.findIndex((entry) => entry.startsWith('out:'))
  const heartbeatsBeforeOutput = seq
    .slice(0, firstOutputIndex === -1 ? seq.length : firstOutputIndex)
    .filter((entry) => entry.startsWith('hb:planning:'))
  assert.ok(firstOutputIndex >= 0, `run must produce visible output: ${seq.join(' | ')}`)
  assert.ok(
    heartbeatsBeforeOutput.length >= 2,
    `>=2 planning heartbeats before first output: ${seq.join(' | ')}`
  )
  assert.ok(heartbeatsBeforeOutput.some((entry) => entry.includes('正在理解需求')))
  assert.ok(heartbeatsBeforeOutput.some((entry) => entry.includes('正在调用模型')))
})

test('agent sdk runtime surfaces capability floor tools to the model end-to-end for a local-document skill turn (P1-3 wiring)', async () => {
  // Drives the REAL orchestrator sendMessage + executor: the capability floor (skill primitives +
  // document read tools) must survive the whole narrowing pipeline and reach the model. Guards the
  // 母合同 §4 "管线末端 surface ⊇ floors" claim end-to-end (executor floors + orchestrator preserve).
  const seenToolNames: string[] = []
  const skillRoot = join(process.cwd(), 'assets', 'embedded-skills', 'ready-human-touch-ppt')
  const runtime = createRuntime({
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: (t: string) =>
        t.includes('ready-human-touch-ppt')
          ? [{ id: 'ready-human-touch-ppt', name: 'ready-human-touch-ppt', managedPath: skillRoot }]
          : [],
      buildPreferredSkillToolNames: (t: string) =>
        t.includes('ready-human-touch-ppt')
          ? [
              'skill_run_shell',
              'skill_write_artifact',
              'skill_read_artifact',
              'skill_export_artifact'
            ]
          : [],
      rememberExplicitReferenceSkillHint: () => true
    },
    runAgent: async ({
      tools,
      onTextDelta
    }: {
      tools: Array<{ name: string }>
      onTextDelta: (t: string) => void
    }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      onTextDelta('done')
      return { finalText: 'done' }
    }
  })
  runtime.newSession('butler::scope-floor-wiring', 'system prompt')
  try {
    const result = await runtime.sendMessage(
      'butler::scope-floor-wiring',
      '用@[ready-human-touch-ppt]根据@[notes.md]生成一个人文感 ppt',
      'run-floor-wiring',
      {
        publicSessionId: 'scope-floor-wiring',
        requestEnvelope: {
          primaryInstruction: '用@[ready-human-touch-ppt]根据@[notes.md]生成一个人文感 ppt',
          resources: [{ name: 'notes.md', path: '/tmp/notes.md', text: '' }]
        }
      }
    )
    // runAgent captured the tool surface at model-call time (before any post-turn doc-read enforcement),
    // so we assert on the captured floor tools, not the turn's terminal outcome.
    void result
    assert.ok(
      seenToolNames.includes('skill_read_artifact'),
      `skill floor skill_read_artifact must reach model; got ${seenToolNames.join('|')}`
    )
    assert.ok(
      seenToolNames.includes('skill_run_shell'),
      `skill floor skill_run_shell must reach model; got ${seenToolNames.join('|')}`
    )
    assert.ok(
      seenToolNames.includes('file_read_excerpt'),
      `document read floor file_read_excerpt must reach model; got ${seenToolNames.join('|')}`
    )
  } finally {
    clearLastReferenceSkill('scope-floor-wiring')
  }
})
