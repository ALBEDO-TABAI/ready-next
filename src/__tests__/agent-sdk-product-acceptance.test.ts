import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentSdkRuntime,
  type AgentSdkRuntimeDeps,
} from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import {
  createToolExecutionOutput,
} from '../main/modules/agent-control/tools-runtime/tool-result-types'
import {
  clearLastReferenceSkill,
  rememberLastReferenceSkill,
} from '../main/modules/agent-control/skills/skill-reference-hints'
import type { AIModelConfig } from '../shared/ai-providers'
import {
  authorizeMcpToolForScope,
  registerMcpServer,
  __resetMcpRegistryForTests,
} from '../main/modules/mcp/registry'
import {
  setCachedMcpOAuthToken,
  __resetMcpOAuthForTests,
} from '../main/modules/mcp/oauth'
import { __setSkillActionToolDefsForTests } from '../main/modules/tools/skills-tools'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { enabledSdkToolNames } from './utils/sdk-tool-visibility'

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
} as const

test('agent sdk product acceptance declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'agent-sdk-product-acceptance transitive sqlite load')
})

type SdkToolForTest = {
  name: string
  invoke: (context: unknown, input: string) => Promise<string>
}

interface ToolStep {
  name: string
  input?: Record<string, unknown>
}

interface AcceptanceRun {
  runtime: AgentSdkRuntime
  executedTools: Array<{ name: string; args: Record<string, unknown> }>
  toolOutputs: Array<{ name: string; output: string }>
  outputEvents: Array<Record<string, unknown>>
  statusEvents: Array<Record<string, unknown>>
  scopeEvents: Array<{ payload: Record<string, unknown>; projectionTruth: unknown }>
  rendererRequests: Array<Record<string, unknown>>
  seenInstructions: string[]
  seenToolNames: string[]
  send: (message: string, runId?: string) => Promise<Awaited<ReturnType<AgentSdkRuntime['sendMessage']>>>
}

function createToolDefinition(overrides: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    name: overrides.name,
    groupId: 'general_research',
    domain: 'general_research',
    kind: 'read',
    concurrency: 'parallel_read_safe',
    interruptBehavior: 'abort_signal',
    timeoutProfile: 'default',
    supportsTextBridge: true,
    projectionHint: { emitsProjectionPatch: true },
    description: `${overrides.name} test tool`,
    schema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
    executionVisibility: 'model',
    resultShape: 'json',
    ...overrides,
  }
}

function createToolSet(tools: Array<Partial<ToolDefinition> & { name: string }>): ToolDefinition[] {
  return tools.map((toolDefinition) => createToolDefinition(toolDefinition))
}

function getSdkTool(tools: unknown[], name: string): SdkToolForTest {
  const sdkTool = tools.find((tool) =>
    Boolean(tool && typeof tool === 'object' && (tool as { name?: unknown }).name === name),
  ) as SdkToolForTest | undefined
  assert.ok(sdkTool, `${name} should be visible to the SDK agent`)
  return sdkTool
}

async function invokeSdkTool(
  tools: unknown[],
  step: ToolStep,
): Promise<string> {
  const sdkTool = getSdkTool(tools, step.name)
  return sdkTool.invoke({}, JSON.stringify(step.input || {}))
}

function createAcceptanceRun(params: {
  tools?: ToolDefinition[]
  plan?: ToolStep[]
  sessionId?: string
  finalText?: string
  config?: AIModelConfig
  executeToolCall?: AgentSdkRuntimeDeps['executeToolCall']
  runAgent?: AgentSdkRuntimeDeps['runAgent']
  skillContextOrchestrator?: AgentSdkRuntimeDeps['skillContextOrchestrator']
  feishuConnected?: boolean
  browserAvailable?: boolean
} = {}): AcceptanceRun {
  const executedTools: AcceptanceRun['executedTools'] = []
  const toolOutputs: AcceptanceRun['toolOutputs'] = []
  const outputEvents: AcceptanceRun['outputEvents'] = []
  const statusEvents: AcceptanceRun['statusEvents'] = []
  const scopeEvents: AcceptanceRun['scopeEvents'] = []
  const rendererRequests: AcceptanceRun['rendererRequests'] = []
  const seenInstructions: string[] = []
  const seenToolNames: string[] = []
  const sessionId = params.sessionId || 'scope-acceptance'
  const hasExplicitToolList = Object.prototype.hasOwnProperty.call(params, 'tools')
  const tools = params.tools || []
  const plan = params.plan || []
  const runtimeDeps: AgentSdkRuntimeDeps = {
    loadAIConfig: () => ({
      ok: true,
      config: params.config || fakeConfig,
      reason: 'present',
    }),
    executeToolCall: params.executeToolCall || (async (toolName, args) => {
      executedTools.push({ name: toolName, args })
      return createToolExecutionOutput(`${toolName} ok`, {
        shape: 'json',
        data: { ok: true, args },
        projectionPatch: {
          taskTitle: `${toolName} task`,
          taskSummary: `${toolName} finished`,
        },
      })
    }),
    runAgent: params.runAgent || (async ({ tools: sdkTools, instructions, onTextDelta }) => {
      seenInstructions.push(instructions)
      seenToolNames.push(...await enabledSdkToolNames(sdkTools))
      for (const step of plan) {
        const output = await invokeSdkTool(sdkTools, step)
        toolOutputs.push({ name: step.name, output })
      }
      const finalText = params.finalText || '验收完成'
      onTextDelta(finalText)
      return { finalText }
    }),
    skillContextOrchestrator: params.skillContextOrchestrator || null,
  }
  if (hasExplicitToolList) {
    runtimeDeps.listToolDefinitions = () => tools
  }
  const runtime = new AgentSdkRuntime(runtimeDeps)

  runtime.on('output', (event) => outputEvents.push(event))
  runtime.on('status', (event) => statusEvents.push(event))
  runtime.setRuntime({
    isChannelTypeAvailable: (channelType: string) =>
      channelType === 'feishu-app' ? Boolean(params.feishuConnected) : false,
    getConversationScope: () => null,
    publishScopeRunEvent: (payload: unknown, projectionTruth?: unknown) => {
      scopeEvents.push({
        payload: payload as Record<string, unknown>,
        projectionTruth,
      })
    },
  } as never)
  runtime.setRendererToolActionRequester(async (payload) => {
    rendererRequests.push(payload)
    return { rendererOk: true, tool: payload.tool, args: payload.args }
  })
  if (params.browserAvailable) runtime.setBrowserController({} as never)
  runtime.newSession(`butler::${sessionId}`, 'system prompt')

  return {
    runtime,
    executedTools,
    toolOutputs,
    outputEvents,
    statusEvents,
    scopeEvents,
    rendererRequests,
    seenInstructions,
    seenToolNames,
    send: (message, runId = `run-${sessionId}`) => runtime.sendMessage(
      `butler::${sessionId}`,
      message,
      runId,
      {
        publicSessionId: sessionId,
        taskId: `task-${sessionId}`,
      },
    ),
  }
}

test('acceptance 01: SDK direct answer stays on the existing stream and terminal contract', async () => {
  const run = createAcceptanceRun({
    sessionId: 'accept-direct',
    tools: [],
    finalText: '可以，已经记下。',
  })

  const result = await run.send('只回答一句话')

  assert.equal(result.success, true)
  assert.equal(result.taskType, 'direct_answer')
  assert.equal(result.finalText, '可以，已经记下。')
  assert.deepEqual(result.usedTools, [])
  assert.deepEqual(
    run.statusEvents.map((event) => [event.status, event.terminalReason]),
    [
      ['working', undefined],
      ['done', 'done'],
    ],
  )
  assert.equal(run.outputEvents.some((event) => event.type === 'done'), true)
})

test('acceptance 02: SDK research run uses search, fetch, present_file, sources, and current date prompt', async () => {
  const run = createAcceptanceRun({
    sessionId: 'accept-research',
    tools: createToolSet([
      { name: 'web_search', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'web_fetch', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'present_file', groupId: 'general_research', domain: 'general_research', kind: 'write' },
    ]),
    plan: [
      { name: 'web_search', input: { query: 'Agents SDK Ready rebuild' } },
      { name: 'web_fetch', input: { url: 'https://developers.openai.com/api/docs/guides/agents' } },
      { name: 'present_file', input: { path: 'outputs/research.md' } },
    ],
    executeToolCall: async (toolName, args) => {
      const projectionPatch = {
        taskTitle: 'Research report',
        taskSummary: '3 sources, 1 output file',
        sources: ['OpenAI Agents guide', 'Ready requirements'],
        recentArtifacts: [{ path: 'outputs/research.md', kind: 'markdown' }],
      }
      return createToolExecutionOutput(`${toolName} ok`, {
        shape: 'json',
        data: { ok: true, args, sources: projectionPatch.sources },
        projectionPatch,
      })
    },
  })

  const result = await run.send('研究 Agents SDK 的最新实现依据')

  assert.equal(result.success, true)
  assert.equal(result.taskType, 'research')
  assert.deepEqual(result.usedTools, ['web_search', 'web_fetch', 'present_file'])
  assert.match(run.seenInstructions[0] || '', /当前日期：\d{4}-\d{2}-\d{2}/)
  assert.deepEqual(result.projectionTruth?.projectionPatch?.sources, [
    'OpenAI Agents guide',
    'Ready requirements',
  ])
  assert.deepEqual(result.projectionTruth?.projectionPatch?.recentArtifacts, [
    { path: 'outputs/research.md', kind: 'markdown' },
  ])
})

test('acceptance 03: SDK document inspect, update, and save keep renderer-mediated writes intact', async () => {
  const run = createAcceptanceRun({
    sessionId: 'accept-document',
    tools: createToolSet([
      { name: 'document_open_tab', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_set_content', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized', timeoutProfile: 'document_write' },
      { name: 'document_save_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized', timeoutProfile: 'document_write' },
    ]),
    plan: [
      { name: 'document_open_tab', input: { tabId: 'tab-1' } },
      { name: 'document_set_content', input: { tabId: 'tab-1', content: '更新后的正文' } },
      { name: 'document_save_tab', input: { tabId: 'tab-1' } },
    ],
    executeToolCall: async (toolName, args, context) => {
      if (toolName === 'document_set_content' || toolName === 'document_save_tab') {
        const requestModuleToolAction = (
          context as {
            requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
          }
        ).requestModuleToolAction
        assert.ok(requestModuleToolAction)
        await requestModuleToolAction(toolName, args)
      }
      return createToolExecutionOutput(`${toolName} ok`, {
        shape: 'json',
        data: { tabId: args.tabId, saved: toolName === 'document_save_tab' },
        projectionPatch: {
          taskTitle: 'Document edit',
          taskSummary: 'Document inspected, updated, and saved',
          currentStepId: toolName,
        },
      })
    },
  })

  const result = await run.send('检查当前文档，改写并保存')

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, ['document_open_tab', 'document_set_content', 'document_save_tab'])
  assert.deepEqual(
    run.rendererRequests.map((request) => request.tool),
    ['document_set_content', 'document_save_tab'],
  )
  assert.equal(result.projectionTruth?.projectionPatch?.taskTitle, 'Document edit')
})

test('acceptance 04: SDK widget update prefers existing target over duplicate creation', async () => {
  const run = createAcceptanceRun({
    sessionId: 'accept-widget-update',
    tools: createToolSet([
      { name: 'document_list_widgets', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_update_widget', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized', timeoutProfile: 'document_write' },
      { name: 'document_insert_widget', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized', timeoutProfile: 'document_write' },
    ]),
    plan: [
      { name: 'document_list_widgets', input: { tabId: 'tab-1' } },
      { name: 'document_update_widget', input: { tabId: 'tab-1', widgetId: 'widget-7', skeletonId: 'metric_summary' } },
    ],
    executeToolCall: async (toolName, args) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: {
        widgets: toolName === 'document_list_widgets' ? [{ id: 'widget-7' }] : undefined,
        updatedWidgetId: args.widgetId,
        // 文档变更追踪要求写类工具回传文档身份（tabId+title），否则
        // orchestrator 以「无法自动保存」拒绝完成——对齐真实 widget 工具输出。
        document: toolName === 'document_update_widget'
          ? { tabId: 'tab-1', title: '目标文档', path: '/tmp/target.md', saveState: 'saved' }
          : undefined,
      },
      projectionPatch: {
        taskTitle: 'Widget update',
        targetWidgetId: 'widget-7',
        operation: toolName === 'document_update_widget' ? 'update_existing' : 'inspect',
      },
    }),
  })

  const result = await run.send('把这张信息卡更新一下，不要新建')

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, ['document_list_widgets', 'document_update_widget'])
  assert.equal(result.usedTools.includes('document_insert_widget'), false)
  assert.equal(result.projectionTruth?.projectionPatch?.targetWidgetId, 'widget-7')
  assert.equal(result.projectionTruth?.projectionPatch?.operation, 'update_existing')
})

test('acceptance 05: SDK browser current-page task can read, click, type, and verify evidence', async () => {
  const run = createAcceptanceRun({
    sessionId: 'accept-browser-current',
    browserAvailable: true,
    tools: createToolSet([
      { name: 'browser_read', groupId: 'browser_interaction', domain: 'browser', kind: 'read' },
      { name: 'browser_click', groupId: 'browser_interaction', domain: 'browser', kind: 'write', concurrency: 'serialized', timeoutProfile: 'browser_interactive' },
      { name: 'browser_type', groupId: 'browser_interaction', domain: 'browser', kind: 'write', concurrency: 'serialized', timeoutProfile: 'browser_interactive' },
    ]),
    plan: [
      { name: 'browser_read', input: { mode: 'current' } },
      { name: 'browser_click', input: { selector: '#prompt' } },
      { name: 'browser_type', input: { selector: '#prompt', text: 'Ready Agent SDK' } },
      { name: 'browser_read', input: { mode: 'evidence' } },
    ],
    executeToolCall: async (toolName, args) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: {
        args,
        pageEvidence: toolName === 'browser_read',
        promptEntered: toolName === 'browser_type',
      },
      projectionPatch: {
        taskTitle: 'Browser current page',
        taskSummary: 'Read page, interacted, and verified evidence',
      },
    }),
  })

  const result = await run.send('在当前网页输入提示并检查结果')

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, [
    'browser_read',
    'browser_click',
    'browser_type',
    'browser_read',
  ])
  assert.equal(result.projectionTruth?.projectionPatch?.taskTitle, 'Browser current page')
})

test('acceptance 06: SDK browser upload path captures the four required evidence points', async () => {
  const uploadEvidence = {
    attachmentMounted: false,
    promptEntered: false,
    submitted: false,
    runningEvidenceSeen: false,
  }
  const run = createAcceptanceRun({
    sessionId: 'accept-browser-upload',
    browserAvailable: true,
    tools: createToolSet([
      { name: 'browser_find', groupId: 'browser_interaction', domain: 'browser', kind: 'read', timeoutProfile: 'browser_interactive' },
      { name: 'browser_upload', groupId: 'browser_interaction', domain: 'browser', kind: 'write', concurrency: 'serialized', timeoutProfile: 'browser_interactive' },
      { name: 'browser_type', groupId: 'browser_interaction', domain: 'browser', kind: 'write', concurrency: 'serialized', timeoutProfile: 'browser_interactive' },
      { name: 'browser_click', groupId: 'browser_interaction', domain: 'browser', kind: 'write', concurrency: 'serialized', timeoutProfile: 'browser_interactive' },
      { name: 'browser_read', groupId: 'browser_interaction', domain: 'browser', kind: 'read' },
    ]),
    plan: [
      { name: 'browser_find', input: { reason: 'find input' } },
      { name: 'browser_upload', input: { attachmentId: 'att-1', targetId: 'upload-1' } },
      { name: 'browser_type', input: { selector: '#prompt', text: '分析这张图' } },
      { name: 'browser_click', input: { selector: '#send' } },
      { name: 'browser_read', input: { mode: 'result_evidence' } },
    ],
    executeToolCall: async (toolName) => {
      if (toolName === 'browser_upload') uploadEvidence.attachmentMounted = true
      if (toolName === 'browser_type') uploadEvidence.promptEntered = true
      if (toolName === 'browser_click') uploadEvidence.submitted = true
      if (toolName === 'browser_read') uploadEvidence.runningEvidenceSeen = true
      const evidence = {
        ...uploadEvidence,
      }
      return createToolExecutionOutput(`${toolName} ok`, {
        shape: 'json',
        data: evidence,
        projectionPatch: {
          taskTitle: 'Browser upload',
          uploadEvidence: evidence,
        },
      })
    },
  })

  const result = await run.send('把附件上传到网页，输入提示并提交')

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, [
    'browser_find',
    'browser_upload',
    'browser_type',
    'browser_click',
    'browser_read',
  ])
  assert.deepEqual(result.projectionTruth?.projectionPatch?.uploadEvidence, {
    attachmentMounted: true,
    promptEntered: true,
    submitted: true,
    runningEvidenceSeen: true,
  })
})

test('acceptance 07: SDK background browser task uses persistent task tools and projection truth', async () => {
  const run = createAcceptanceRun({
    sessionId: 'accept-browser-background',
    browserAvailable: true,
    tools: createToolSet([
      { name: 'browser_collect', groupId: 'browser_content', domain: 'browser', kind: 'job', concurrency: 'serialized', timeoutProfile: 'browser_interactive' },
      { name: 'browser_task', groupId: 'browser_content', domain: 'browser', kind: 'read', timeoutProfile: 'browser_interactive' },
    ]),
    plan: [
      { name: 'browser_collect', input: { kind: 'scroll_collect', payload: { url: 'https://example.com' } } },
      { name: 'browser_task', input: { taskId: 'browser-task-1' } },
    ],
    executeToolCall: async (toolName) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: { taskId: 'browser-task-1', status: toolName === 'browser_task' ? 'running' : 'queued' },
      projectionPatch: {
        taskTitle: 'Background browser',
        backgroundTaskId: 'browser-task-1',
        backgroundStatus: toolName === 'browser_task' ? 'running' : 'queued',
      },
    }),
  })

  const result = await run.send('后台收集这个网页的完整内容')

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, ['browser_collect', 'browser_task'])
  assert.equal(result.projectionTruth?.projectionPatch?.backgroundTaskId, 'browser-task-1')
  assert.equal(result.projectionTruth?.projectionPatch?.backgroundStatus, 'running')
})

test('acceptance 08: SDK RSS chain fetches, selects, analyzes, and captures session', async () => {
  const run = createAcceptanceRun({
    sessionId: 'accept-rss',
    tools: createToolSet([
      { name: 'rss_fetch_updates', groupId: 'rss', domain: 'rss', kind: 'read' },
      { name: 'rss_select_item', groupId: 'rss', domain: 'rss', kind: 'read' },
      { name: 'rss_analyze_item', groupId: 'rss', domain: 'rss', kind: 'read' },
      { name: 'rss_capture_session', groupId: 'rss', domain: 'rss', kind: 'write' },
    ]),
    plan: [
      { name: 'rss_fetch_updates', input: { sourceId: 'rss-1' } },
      { name: 'rss_select_item', input: { itemId: 'item-1' } },
      { name: 'rss_analyze_item', input: { itemId: 'item-1' } },
      { name: 'rss_capture_session', input: { itemId: 'item-1' } },
    ],
  })

  const result = await run.send('帮我分析 RSS 里这条更新')

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, [
    'rss_fetch_updates',
    'rss_select_item',
    'rss_analyze_item',
    'rss_capture_session',
  ])
  assert.equal(result.taskType, 'multi_step_task')
})

test('acceptance 09: SDK calendar chain lists, creates, updates, and captures session', async () => {
  const run = createAcceptanceRun({
    sessionId: 'accept-calendar',
    tools: createToolSet([
      { name: 'calendar_list_window', groupId: 'calendar', domain: 'calendar', kind: 'read' },
      { name: 'calendar_create_event', groupId: 'calendar', domain: 'calendar', kind: 'write' },
      { name: 'calendar_update_event', groupId: 'calendar', domain: 'calendar', kind: 'write' },
      { name: 'calendar_capture_session', groupId: 'calendar', domain: 'calendar', kind: 'write' },
    ]),
    plan: [
      { name: 'calendar_list_window', input: { start: '2026-05-13', end: '2026-05-20' } },
      { name: 'calendar_create_event', input: { title: 'Agent SDK 验收', start: '2026-05-13T10:00:00+08:00' } },
      { name: 'calendar_update_event', input: { eventId: 'event-1', title: 'Agent SDK 验收完成' } },
      { name: 'calendar_capture_session', input: { eventId: 'event-1' } },
    ],
  })

  const result = await run.send('帮我安排并更新一个日程')

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, [
    'calendar_list_window',
    'calendar_create_event',
    'calendar_update_event',
    'calendar_capture_session',
  ])
})

test('acceptance 10: SDK Feishu path can read context, reply, create docs, and upload file', async () => {
  const run = createAcceptanceRun({
    sessionId: 'accept-feishu',
    feishuConnected: true,
    tools: createToolSet([
      { name: 'feishu_message_get_context', groupId: 'channel_feishu', domain: 'feishu', kind: 'read', timeoutProfile: 'feishu' },
      { name: 'feishu_message_reply', groupId: 'channel_feishu', domain: 'feishu', kind: 'write', timeoutProfile: 'feishu' },
      { name: 'feishu_doc_create', groupId: 'channel_feishu', domain: 'feishu', kind: 'write', timeoutProfile: 'feishu' },
      { name: 'feishu_file_upload', groupId: 'channel_feishu', domain: 'feishu', kind: 'write', timeoutProfile: 'feishu' },
    ]),
    plan: [
      { name: 'feishu_message_get_context', input: { messageId: 'msg-1' } },
      { name: 'feishu_doc_create', input: { title: 'Ready 验收' } },
      { name: 'feishu_file_upload', input: { filePath: 'outputs/research.md', fileType: 'doc' } },
      { name: 'feishu_message_reply', input: { messageId: 'msg-1', text: '已完成' } },
    ],
  })

  const result = await run.send('回复飞书并同步产物')

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, [
    'feishu_message_get_context',
    'feishu_doc_create',
    'feishu_file_upload',
    'feishu_message_reply',
  ])
})

test('acceptance 11: SDK pet and file domains keep their product tool chains available', async () => {
  const run = createAcceptanceRun({
    sessionId: 'accept-pet-file',
    tools: createToolSet([
      { name: 'file_search', groupId: 'file_management', domain: 'file', kind: 'read' },
      { name: 'file_locate', groupId: 'file_management', domain: 'file', kind: 'read' },
      { name: 'pet_show_sticky_note', groupId: 'pet', domain: 'pet', kind: 'write' },
    ]),
    plan: [
      { name: 'file_search', input: { query: 'Ready' } },
      { name: 'file_locate', input: { path: 'docs/superpowers/specs/requirements.md' } },
      { name: 'pet_show_sticky_note', input: { text: '验收完成' } },
    ],
  })

  const result = await run.send('找文件并贴一条提醒')

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, ['file_search', 'file_locate', 'pet_show_sticky_note'])
})

test('acceptance 12: SDK memory capture and search remain in the tool loop', async () => {
  const run = createAcceptanceRun({
    sessionId: 'accept-memory',
    tools: createToolSet([
      { name: 'memory_create', groupId: 'memory', domain: 'memory', kind: 'write' },
      { name: 'memory_search', groupId: 'memory', domain: 'memory', kind: 'read' },
    ]),
    plan: [
      { name: 'memory_create', input: { text: '用户偏好：验收要完整通过' } },
      { name: 'memory_search', input: { query: '验收' } },
    ],
  })

  const result = await run.send('记住这个偏好并查一下')

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, ['memory_create', 'memory_search'])
})

test('acceptance 13: SDK session recall can search prior scoped context', async () => {
  const run = createAcceptanceRun({
    sessionId: 'accept-session-recall',
    tools: createToolSet([
      { name: 'session_search', groupId: 'session', domain: 'session', kind: 'read' },
    ]),
    plan: [
      { name: 'session_search', input: { query: '上次的验收计划' } },
    ],
    executeToolCall: async (toolName, args) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: { query: args.query, matches: [{ scopeId: 'conv-1', title: '验收计划' }] },
      projectionPatch: { taskTitle: 'Session recall', recalledScopeId: 'conv-1' },
    }),
  })

  const result = await run.send('找一下之前说过的验收计划')

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, ['session_search'])
  assert.equal(result.projectionTruth?.projectionPatch?.recalledScopeId, 'conv-1')
})

test('acceptance 14: SDK recoverable tool errors surface as structured tool results, not crashes', async () => {
  const run = createAcceptanceRun({
    sessionId: 'accept-soft-failure',
    tools: createToolSet([
      { name: 'memory_search', groupId: 'memory', domain: 'memory', kind: 'read' },
    ]),
    plan: [{ name: 'memory_search', input: { query: 'quota' } }],
    executeToolCall: async () => createToolExecutionOutput('暂时无法读取记忆，可稍后重试', {
      shape: 'json',
      data: {
        errorKind: 'recoverable_tool_failure',
        recoverable: true,
        detail: 'temporary index busy',
      },
      projectionPatch: {
        taskTitle: 'Soft failure',
        softFailure: true,
      },
    }),
  })

  const result = await run.send('查一下记忆')

  assert.equal(result.success, true)
  assert.equal(result.usedTools[0], 'memory_search')
  assert.match(run.toolOutputs[0]?.output || '', /"recoverable":true/)
  assert.equal(result.projectionTruth?.projectionPatch?.softFailure, true)
})

test('acceptance 15: SDK terminal provider or config errors end with explicit blocked status', async () => {
  const statuses: Array<Record<string, unknown>> = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    runAgent: async () => {
      throw new Error('429 quota exhausted')
    },
  })
  runtime.on('status', (event) => statuses.push(event))
  runtime.on('error', () => undefined)
  runtime.newSession('butler::accept-terminal-error', 'system prompt')

  const result = await runtime.sendMessage('butler::accept-terminal-error', '测试外部阻断', 'run-terminal-error', {
    publicSessionId: 'accept-terminal-error',
    taskId: 'task-accept-terminal-error',
  })

  assert.equal(result.success, false)
  assert.equal(result.status, 'error')
  assert.equal(result.terminalReason, 'blocked_external')
  assert.deepEqual(
    statuses.map((event) => [event.status, event.terminalReason]),
    [
      ['working', undefined],
      ['error', 'blocked_external'],
    ],
  )
})

test('acceptance 16: SDK skill launch records durable background handles in projection truth', async () => {
  const run = createAcceptanceRun({
    sessionId: 'accept-skill-launch',
    tools: createToolSet([
      { name: 'skill_video_expert_pipeline', groupId: 'skills', domain: 'skill', kind: 'job', timeoutProfile: 'skill_long' },
    ]),
    plan: [
      { name: 'skill_video_expert_pipeline', input: { input: 'video.mp4' } },
    ],
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [{ id: 'video-expert-analyzer', name: 'Video Expert Analyzer' }],
      buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline'],
      rememberExplicitReferenceSkillHint: () => {
        rememberLastReferenceSkill('accept-skill-surface', {
          id: 'video-expert-analyzer',
          name: 'Video Expert Analyzer',
        })
        return true
      },
    },
    executeToolCall: async () => createToolExecutionOutput('VEA 已启动', {
      shape: 'json',
      data: {
        detachedTaskId: 'detached-1',
        taskRunId: 'task-run-1',
        jobId: 'job-1',
        runStatePath: '/tmp/ready-vea/run_state.json',
        outputDir: '/tmp/ready-vea',
      },
      projectionPatch: {
        taskTitle: 'VEA',
        status: 'background_running',
        canResume: true,
        detachedTaskId: 'detached-1',
        taskRunId: 'task-run-1',
        jobId: 'job-1',
        runStatePath: '/tmp/ready-vea/run_state.json',
        outputDir: '/tmp/ready-vea',
      },
    }),
  })

  const result = await run.send('使用 video expert analyzer 分析这个视频')

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, ['skill_video_expert_pipeline'])
  assert.equal(result.projectionTruth?.projectionPatch?.canResume, true)
  assert.equal(result.projectionTruth?.projectionPatch?.runStatePath, '/tmp/ready-vea/run_state.json')
})

test('acceptance 17: SDK skill continuation can surface budget pause, continue, cancel, and close event states', async () => {
  const run = createAcceptanceRun({
    sessionId: 'accept-skill-continue',
    tools: createToolSet([
      { name: 'skill_inspect_run_state', groupId: 'skills', domain: 'skill', kind: 'read', timeoutProfile: 'skill' },
      { name: 'skill_video_expert_ai_analyze', groupId: 'skills', domain: 'skill', kind: 'job', timeoutProfile: 'skill_long' },
      { name: 'skill_cancel_detached', groupId: 'skills', domain: 'skill', kind: 'write', timeoutProfile: 'skill' },
    ]),
    plan: [
      { name: 'skill_inspect_run_state', input: { runStatePath: '/tmp/ready-vea/run_state.json' } },
      { name: 'skill_video_expert_ai_analyze', input: { runStatePath: '/tmp/ready-vea/run_state.json', continue: true } },
      { name: 'skill_cancel_detached', input: { detachedTaskId: 'detached-1' } },
    ],
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [{ id: 'video-expert-analyzer', name: 'Video Expert Analyzer' }],
      buildPreferredSkillToolNames: () => ['skill_video_expert_ai_analyze'],
    },
    executeToolCall: async (toolName) => {
      const statusByTool: Record<string, string> = {
        skill_inspect_run_state: 'budget_paused',
        skill_video_expert_ai_analyze: 'background_running',
        skill_cancel_detached: 'cancelled',
      }
      return createToolExecutionOutput(`${toolName} ok`, {
        shape: 'json',
        data: { status: statusByTool[toolName] },
        projectionPatch: {
          taskTitle: 'VEA continuation',
          status: statusByTool[toolName],
          canResume: toolName !== 'skill_cancel_detached',
          closeEvent: toolName === 'skill_cancel_detached' ? { status: 'cancelled', terminalReason: 'cancelled_user' } : null,
        },
      })
    },
  })

  const result = await run.send('继续刚才暂停的 video expert analyzer，如果不需要就取消')

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, [
    'skill_inspect_run_state',
    'skill_video_expert_ai_analyze',
    'skill_cancel_detached',
  ])
  assert.equal(result.projectionTruth?.projectionPatch?.status, 'cancelled')
  assert.deepEqual(result.projectionTruth?.projectionPatch?.closeEvent, {
    status: 'cancelled',
    terminalReason: 'cancelled_user',
  })
})

test('acceptance 18: SDK channel scoped run can reply through the Feishu tool surface', async () => {
  const run = createAcceptanceRun({
    sessionId: 'accept-channel',
    feishuConnected: true,
    tools: createToolSet([
      { name: 'feishu_message_reply', groupId: 'channel_feishu', domain: 'feishu', kind: 'write', timeoutProfile: 'feishu' },
    ]),
    plan: [
      { name: 'feishu_message_reply', input: { threadKey: 'thread-1', text: '频道回复完成' } },
    ],
    executeToolCall: async (toolName, args) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: { channelReply: true, args },
      projectionPatch: {
        taskTitle: 'Channel reply',
        sourceKind: 'channel',
        sourceId: 'feishu-app',
        threadKey: 'thread-1',
      },
    }),
  })

  const result = await run.send('回复这个频道线程')

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, ['feishu_message_reply'])
  assert.equal(result.projectionTruth?.projectionPatch?.sourceKind, 'channel')
  assert.equal(result.projectionTruth?.projectionPatch?.threadKey, 'thread-1')
})

test('acceptance 19: SDK scheduled run-now prompt preserves schedule metadata in projection truth', async () => {
  const run = createAcceptanceRun({
    sessionId: 'accept-schedule',
    tools: createToolSet([
      { name: 'memory_search', groupId: 'memory', domain: 'memory', kind: 'read' },
      { name: 'calendar_capture_session', groupId: 'calendar', domain: 'calendar', kind: 'write' },
    ]),
    plan: [
      { name: 'memory_search', input: { query: 'daily plan' } },
      { name: 'calendar_capture_session', input: { scheduleId: 'schedule-1' } },
    ],
    executeToolCall: async (toolName) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: { scheduleId: 'schedule-1', runNow: true },
      projectionPatch: {
        taskTitle: 'Scheduled run',
        scheduleId: 'schedule-1',
        runNow: true,
      },
    }),
  })

  const result = await run.send('立即执行这条计划任务')

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, ['memory_search', 'calendar_capture_session'])
  assert.equal(result.projectionTruth?.projectionPatch?.scheduleId, 'schedule-1')
  assert.equal(result.projectionTruth?.projectionPatch?.runNow, true)
})

test('acceptance 20: SDK OpenAI-compatible text bridge keeps tools available without direct native calls', async () => {
  const run = createAcceptanceRun({
    sessionId: 'accept-text-bridge',
    config: {
      ...fakeConfig,
      provider: 'openai-compatible',
      baseUrl: 'https://code.newcli.com/codex/v1',
      agentProtocol: 'openai',
      wireApi: 'chat/completions',
      toolUseMode: 'on',
    },
    tools: createToolSet([
      { name: 'web_search', groupId: 'general_research', domain: 'general_research', kind: 'read' },
    ]),
    runAgent: async ({ tools, instructions, input }) => {
      assert.equal(tools.length, 0)
      assert.match(instructions, /文本工具桥接/)
      if (!String(input).includes('tool_result')) {
        return {
          finalText: [
            ':::tool_call',
            '{"tool":"web_search","args":{"query":"Ready SDK"}}',
            ':::',
          ].join('\n'),
        }
      }
      return { finalText: '文本桥接完成' }
    },
  })

  const result = await run.send('查一下 Ready SDK')

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, ['web_search'])
  assert.equal(result.finalText, '文本桥接完成')
})

test('acceptance 21: SDK vision-disabled profiles remove image-dependent tools before the model sees them', async () => {
  __resetMcpRegistryForTests()
  registerMcpServer({
    serverId: 'accept-vision',
    toolNames: ['view_image', 'mcp_plain_text_action'],
    requiresAuthorization: false,
  })
  const run = createAcceptanceRun({
    sessionId: 'accept-vision',
    config: {
      ...fakeConfig,
      model: 'o3-mini',
      visionMode: 'off',
    },
    finalText: '视觉门禁完成',
  })

  try {
    const result = await run.send('看一下这张图片')

    assert.equal(result.success, true)
    assert.equal(run.seenToolNames.includes('mcp_plain_text_action'), true)
    assert.equal(run.seenToolNames.includes('view_image'), false)
  } finally {
    __resetMcpRegistryForTests()
  }
})

test('acceptance 22: SDK MCP tools require both OAuth and per-scope authorization', async () => {
  __resetMcpRegistryForTests()
  __resetMcpOAuthForTests()
  registerMcpServer({
    serverId: 'accept-mcp',
    toolNames: ['mcp_acceptance_action'],
    requiresAuthorization: true,
  })
  setCachedMcpOAuthToken('accept-mcp', {
    accessToken: 'token',
    expiresAt: Date.now() + 60_000,
    scopes: ['read'],
  })
  authorizeMcpToolForScope('accept-mcp', 'mcp_acceptance_action', 'accept-mcp-allowed', 'accept-mcp-allowed')

  const allowed = createAcceptanceRun({
    sessionId: 'accept-mcp-allowed',
    finalText: 'MCP allowed',
  })
  const denied = createAcceptanceRun({
    sessionId: 'accept-mcp-denied',
    finalText: 'MCP denied',
  })

  try {
    const allowedResult = await allowed.send('使用授权 MCP')
    const deniedResult = await denied.send('使用未授权 MCP')

    assert.equal(allowedResult.success, true)
    assert.equal(deniedResult.success, true)
    assert.equal(allowed.seenToolNames.includes('mcp_acceptance_action'), true)
    assert.equal(denied.seenToolNames.includes('mcp_acceptance_action'), false)
  } finally {
    __resetMcpRegistryForTests()
    __resetMcpOAuthForTests()
  }
})

test('acceptance 23: SDK explicit skill turns expose only the selected skill action and primitives', async () => {
  __setSkillActionToolDefsForTests(() => [
    {
      name: 'skill_video_expert_pipeline',
      description: 'Run VEA pipeline',
      kind: 'skill_action',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      visibility: 'public',
      params: [],
    },
    {
      name: 'skill_rss_update',
      description: 'Update RSS',
      kind: 'skill_action',
      skillId: 'lets-go-rss',
      action: 'rss_update',
      visibility: 'public',
      params: [],
    },
  ])
  const run = createAcceptanceRun({
    sessionId: 'accept-skill-surface',
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [{ id: 'video-expert-analyzer', name: 'Video Expert Analyzer' }],
      buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline'],
    },
    finalText: '技能面完成',
  })

  try {
    const result = await run.send('使用 video expert analyzer')

    assert.equal(result.success, true)
    assert.equal(run.seenToolNames.includes('skill_video_expert_pipeline'), true)
    assert.equal(run.seenToolNames.includes('skill_run_shell'), false)
    assert.equal(run.seenToolNames.includes('skill_inspect_run_state'), true)
    assert.equal(run.seenToolNames.includes('skill_rss_update'), false)
  } finally {
    __setSkillActionToolDefsForTests(null)
    clearLastReferenceSkill('accept-skill-surface')
  }
})
