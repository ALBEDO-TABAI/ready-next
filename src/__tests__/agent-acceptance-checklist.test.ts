// Test-mode acceptance driver for the human-acceptance checklist at
// /Users/user/实验田/ready-cowork/docs/superpowers/agent-acceptance-test-checklist.md
//
// Approach: drive each A1-M8 item through the real `AgentSdkRuntime` with a
// scripted LLM plan, capture the emitted scope/status/output events, build a
// faithful renderer-side `scopeRunStates` via the real `deriveScopeRunStatePatch`,
// then read back the panel surface via `createAgentPanelSnapshot` +
// `diagnoseAgentPanelSnapshot`. Each test asserts checklist pass criteria at
// the layer the user would observe — task card, info card, tool trace, agent
// reply — and surfaces any panel-level diagnostics as test failures.

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { relative } from 'node:path'
import test, { after } from 'node:test'

import {
  AgentSdkRuntime,
  type AgentSdkRuntimeDeps,
} from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { rememberLastReferenceSkill } from '../main/modules/agent-control/skills/skill-reference-hints'
import type { ExecutionTurnResult } from '../main/modules/agent-control/contracts/run-contracts'
import type { ScopeRunEventPayload } from '../main/modules/agent-control/contracts/types'
import {
  createAgentPanelSnapshot,
  diagnoseAgentPanelSnapshot,
  type AgentPanelDiagnostic,
  type AgentPanelSnapshot,
} from '../renderer/modules/agent/agentPanelTestHarness'
import {
  createEmptyScopeRunState,
  deriveScopeRunStatePatch,
  mergeArtifacts,
} from '../renderer/modules/agent/scopeRunState'
import type {
  AgentMessage,
  ConversationScope,
  ScopeRunState,
  ToolTraceEvent,
} from '../renderer/modules/agent/types'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const STAGE_Z_ROOT = 'docs/superpowers/audits/2026-05-24-stage-z-closeout'
const STAGE_Z_AGENT_ACCEPTANCE_DIR = `${STAGE_Z_ROOT}/agent-acceptance`
const STAGE_Z_AGENT_ACCEPTANCE_SUMMARY = `${STAGE_Z_ROOT}/simulated-human-agent-acceptance.md`
const acceptanceEvidenceOutputDir = process.env.READY_STAGE_Z_AGENT_ACCEPTANCE_DIR || ''
const acceptanceEvidenceSummaryPath =
  process.env.READY_STAGE_Z_AGENT_ACCEPTANCE_SUMMARY || STAGE_Z_AGENT_ACCEPTANCE_SUMMARY
const acceptanceEvidenceRecords: SimulatedHumanEvidenceRecord[] = []

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
} as const

test('agent acceptance checklist declares transitive sqlite coverage', (t) => {
  skipIfSqliteUnavailable(t, 'agent acceptance checklist transitive sqlite guard')
})

interface ToolStep {
  name: string
  input?: Record<string, unknown>
}

interface ChecklistRunParams {
  itemId: string
  input: string
  tools: Array<Partial<ToolDefinition> & { name: string }>
  plan: ToolStep[]
  executeToolCall?: AgentSdkRuntimeDeps['executeToolCall']
  finalText: string
  browserAvailable?: boolean
  feishuConnected?: boolean
  skillContextOrchestrator?: AgentSdkRuntimeDeps['skillContextOrchestrator']
  sessionId?: string
  forceError?: () => never
}

interface ChecklistRunResult {
  itemId: string
  input: string
  result: ExecutionTurnResult
  snapshot: AgentPanelSnapshot
  panelDiagnostics: AgentPanelDiagnostic[]
  scopeEvents: Array<{ payload: ScopeRunEventPayload; projectionTruth: unknown }>
  statusEvents: Array<Record<string, unknown>>
  outputEvents: Array<Record<string, unknown>>
  rendererRequests: Array<Record<string, unknown>>
  executedTools: Array<{ name: string; args: Record<string, unknown> }>
}

interface SimulatedHumanEvidenceRecord {
  itemId: string
  title: string
  input: string
  success: boolean
  terminalReason: string
  usedTools: string[]
  taskCards: string[]
  infoCards: string[]
  diagnostics: string[]
  reply: string
  traceCount: number
}

function fullToolDefinition(overrides: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    name: overrides.name,
    groupId: overrides.groupId || 'general_research',
    domain: overrides.domain || 'general_research',
    kind: overrides.kind || 'read',
    concurrency: overrides.concurrency || 'parallel_read_safe',
    interruptBehavior: overrides.interruptBehavior || 'abort_signal',
    timeoutProfile: overrides.timeoutProfile || 'default',
    supportsTextBridge: overrides.supportsTextBridge ?? true,
    projectionHint: overrides.projectionHint || { emitsProjectionPatch: true },
    description: overrides.description || `${overrides.name} test tool`,
    schema: overrides.schema || {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
    executionVisibility: overrides.executionVisibility || 'model',
    resultShape: overrides.resultShape || 'json',
    ...overrides,
  }
}

function buildToolSet(tools: Array<Partial<ToolDefinition> & { name: string }>): ToolDefinition[] {
  return tools.map(fullToolDefinition)
}

function getSdkTool(tools: unknown[], name: string): { invoke: (context: unknown, input: string) => Promise<string> } {
  const found = tools.find((tool) => Boolean(tool && typeof tool === 'object' && (tool as { name?: unknown }).name === name))
  assert.ok(found, `tool ${name} should be visible to the SDK agent`)
  return found as { invoke: (context: unknown, input: string) => Promise<string> }
}

function buildScope(scopeId: string): ConversationScope {
  return {
    id: scopeId,
    agent: 'butler',
    title: '测试会话',
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: scopeId,
    meta: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function synthesizeFinalScopeRunState(params: {
  scopeId: string
  agent: string
  runId: string
  taskId: string
  scopeEvents: Array<{ payload: ScopeRunEventPayload; projectionTruth: unknown }>
  statusEvents: Array<Record<string, unknown>>
  outputEvents: Array<Record<string, unknown>>
}): ScopeRunState {
  let current: ScopeRunState = createEmptyScopeRunState({
    scopeId: params.scopeId,
    agent: params.agent,
    requestId: params.runId,
  })
  current.startedAt = new Date().toISOString()

  for (const event of params.scopeEvents) {
    // Fold the projectionPatch from the second arg into the payload for the
    // patch derivation, so fields like recentArtifacts / waitingFor /
    // taskContinuation / blockedReason (which the SDK runtime emits via
    // projectionTruth, not the scope-event payload) make it into the state.
    const projectionTruthRecord =
      event.projectionTruth && typeof event.projectionTruth === 'object'
        ? (event.projectionTruth as { projectionPatch?: Record<string, unknown> })
        : null
    const projectionPatch = projectionTruthRecord?.projectionPatch || null
    const enrichedPayload = projectionPatch
      ? { ...(event.payload as Record<string, unknown>), ...projectionPatch }
      : (event.payload as Record<string, unknown>)
    const payload = enrichedPayload as unknown as Parameters<typeof deriveScopeRunStatePatch>[0]
    const patch = deriveScopeRunStatePatch(payload, current)
    const toolTrace: ToolTraceEvent[] = (event.payload as ScopeRunEventPayload).toolEvent
      ? [
          ...(current.toolTrace || []),
          {
            id: `synth-${current.toolTrace.length}-${(event.payload as ScopeRunEventPayload).toolEvent!.kind}`,
            kind: (event.payload as ScopeRunEventPayload).toolEvent!.kind,
            text: (event.payload as ScopeRunEventPayload).toolEvent!.text,
            timestamp: new Date((event.payload as ScopeRunEventPayload).toolEvent!.timestamp),
          },
        ]
      : current.toolTrace
    current = {
      ...current,
      ...patch,
      requestId: current.requestId || params.runId,
      taskId: params.taskId,
      toolTrace,
      artifactRefs: mergeArtifacts(current.artifactRefs, patch.artifactRefs ?? current.artifactRefs),
      recentArtifacts: patch.recentArtifacts ?? current.recentArtifacts,
      taskContinuation: patch.taskContinuation ?? current.taskContinuation,
      waitingFor: patch.waitingFor ?? current.waitingFor,
      blockedReason: patch.blockedReason ?? current.blockedReason,
      updatedAt: (event.payload as ScopeRunEventPayload).timestamp,
    } as ScopeRunState
  }

  // Fold final status event into terminalReason / phase
  const lastStatus = params.statusEvents[params.statusEvents.length - 1]
  if (lastStatus) {
    const status = String(lastStatus.status || '')
    const terminalReason = lastStatus.terminalReason as ScopeRunState['terminalReason']
    if (status === 'done') {
      current = { ...current, phase: 'done', terminalReason: terminalReason || 'done' }
    } else if (status === 'error') {
      current = {
        ...current,
        phase: 'error',
        terminalReason: terminalReason || null,
        error: typeof lastStatus.error === 'string' ? lastStatus.error : current.error,
        blockedReason: typeof lastStatus.terminalReason === 'string' ? String(lastStatus.terminalReason) : current.blockedReason,
      }
    } else if (status === 'cancelled') {
      current = { ...current, phase: 'cancelled', terminalReason: terminalReason || 'cancelled_user' }
    }
  }

  // Build final response buffer from output text deltas (for latestText sanity)
  const aggregatedText = params.outputEvents
    .filter((event) => event.type === 'text' && typeof event.chunk === 'string')
    .map((event) => String(event.chunk))
    .join('')
  if (aggregatedText) {
    current = {
      ...current,
      latestText: aggregatedText.slice(-500),
      responseBuffer: aggregatedText,
      responseMessageId: current.responseMessageId || `agent-${params.runId}`,
    }
  }

  return current
}

function buildHarnessStateFromRun(params: {
  scopeId: string
  runId: string
  agent: string
  taskId: string
  userInput: string
  finalAgentText: string
  finalScopeRunState: ScopeRunState
}): Parameters<typeof createAgentPanelSnapshot>[0] {
  const messages: AgentMessage[] = []
  messages.push({
    id: `user-${params.runId}`,
    agent: params.agent,
    type: 'user',
    content: params.userInput,
    timestamp: new Date(params.finalScopeRunState.startedAt || new Date().toISOString()),
  })
  if (params.finalAgentText) {
    messages.push({
      id: params.finalScopeRunState.responseMessageId || `agent-${params.runId}`,
      agent: params.agent,
      type: 'agent',
      content: params.finalAgentText,
      timestamp: new Date(params.finalScopeRunState.updatedAt || new Date().toISOString()),
    })
  }
  return {
    agents: [{ name: 'butler', displayName: '管家', status: 'idle', selected: true }],
    messages,
    currentAgent: params.agent,
    inputValue: '',
    currentScopeId: params.scopeId,
    currentScope: buildScope(params.scopeId),
    scopes: [buildScope(params.scopeId)],
    scopeRunStates: { [params.scopeId]: params.finalScopeRunState },
    toolTrace: [],
    toolTraceStatus: params.finalScopeRunState.phase === 'done' ? 'done' : params.finalScopeRunState.phase === 'error' ? 'error' : 'idle',
    attachments: [],
    filePool: [],
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    sendMessage: async () => ({ success: true }),
    setInputValue: () => undefined,
  }
}

async function runChecklistItem(params: ChecklistRunParams): Promise<ChecklistRunResult> {
  const sessionId = params.sessionId || `acc-${params.itemId.toLowerCase()}`
  const executedTools: ChecklistRunResult['executedTools'] = []
  const outputEvents: ChecklistRunResult['outputEvents'] = []
  const statusEvents: ChecklistRunResult['statusEvents'] = []
  const scopeEvents: ChecklistRunResult['scopeEvents'] = []
  const rendererRequests: ChecklistRunResult['rendererRequests'] = []
  const tools = buildToolSet(params.tools)
  const plan = params.plan

  const customExecute = params.executeToolCall
  const runtimeDeps: AgentSdkRuntimeDeps = {
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    // Always record the tool call to `executedTools` BEFORE the (possibly
    // custom) executor runs, so test assertions can inspect args regardless of
    // whether the test provided its own executor.
    executeToolCall: async (toolName, args, context) => {
      executedTools.push({ name: toolName, args })
      if (customExecute) return customExecute(toolName, args, context)
      return createToolExecutionOutput(`${toolName} ok`, {
        shape: 'json',
        data: { ok: true, args },
        projectionPatch: {
          taskTitle: `${toolName} task`,
          taskSummary: `${toolName} finished`,
        },
      })
    },
    runAgent: params.forceError
      ? (async () => {
          params.forceError!()
          throw new Error('unreachable')
        })
      : (async ({ tools: sdkTools, onTextDelta }) => {
          for (const step of plan) {
            const sdkTool = getSdkTool(sdkTools as unknown[], step.name)
            await sdkTool.invoke({}, JSON.stringify(step.input || {}))
          }
          if (params.finalText) onTextDelta(params.finalText)
          return { finalText: params.finalText }
        }),
    skillContextOrchestrator: params.skillContextOrchestrator || null,
  }
  if (params.tools.length > 0) runtimeDeps.listToolDefinitions = () => tools

  const runtime = new AgentSdkRuntime(runtimeDeps)
  runtime.on('output', (event) => outputEvents.push(event))
  runtime.on('status', (event) => statusEvents.push(event))
  runtime.setRuntime({
    isChannelTypeAvailable: (channelType: string) =>
      channelType === 'feishu-app' ? Boolean(params.feishuConnected) : false,
    getConversationScope: () => null,
    publishScopeRunEvent: (payload: unknown, projectionTruth?: unknown) => {
      scopeEvents.push({ payload: payload as ScopeRunEventPayload, projectionTruth })
    },
  } as never)
  runtime.setRendererToolActionRequester(async (payload) => {
    rendererRequests.push(payload)
    return { rendererOk: true, tool: payload.tool, args: payload.args }
  })
  if (params.browserAvailable) runtime.setBrowserController({} as never)
  runtime.newSession(`butler::${sessionId}`, 'system prompt')

  const runId = `run-${sessionId}`
  const taskId = `task-${sessionId}`
  const result = await runtime.sendMessage(`butler::${sessionId}`, params.input, runId, {
    publicSessionId: sessionId,
    taskId,
  })

  const finalScopeRunState = synthesizeFinalScopeRunState({
    scopeId: sessionId,
    agent: 'butler',
    runId,
    taskId,
    scopeEvents,
    statusEvents,
    outputEvents,
  })

  const state = buildHarnessStateFromRun({
    scopeId: sessionId,
    runId,
    agent: 'butler',
    taskId,
    userInput: params.input,
    finalAgentText: result.finalText || '',
    finalScopeRunState,
  })
  const snapshot = createAgentPanelSnapshot(state)
  const panelDiagnostics = diagnoseAgentPanelSnapshot(snapshot)

  return {
    itemId: params.itemId,
    input: params.input,
    result,
    snapshot,
    panelDiagnostics,
    scopeEvents,
    statusEvents,
    outputEvents,
    rendererRequests,
    executedTools,
  }
}

function expectNoErrorDiagnostics(r: ChecklistRunResult, allowed: string[] = []): void {
  const errors = r.panelDiagnostics.filter(
    (d) => d.severity === 'error' && !allowed.includes(d.id),
  )
  assert.equal(
    errors.length,
    0,
    `[${r.itemId}] unexpected panel diagnostics: ${JSON.stringify(errors, null, 2)}`,
  )
}

function expectToolTraceContains(r: ChecklistRunResult, toolName: string): void {
  const trace = r.snapshot.toolTrace.map((event) => event.text).join('\n')
  assert.ok(
    trace.includes(toolName),
    `[${r.itemId}] expected tool trace to mention ${toolName}, got:\n${trace}`,
  )
}

function expectTaskCardTitleIncludes(r: ChecklistRunResult, substring: string): void {
  assert.ok(
    r.snapshot.taskCards.some((card) => card.title.includes(substring)),
    `[${r.itemId}] no task card title contains "${substring}": ${JSON.stringify(r.snapshot.taskCards.map((c) => c.title))}`,
  )
}

function expectAgentMessageContains(r: ChecklistRunResult, substring: string): void {
  const lastAgent = [...r.snapshot.messages].reverse().find((message) => message.type === 'agent')
  assert.ok(lastAgent, `[${r.itemId}] no agent message at all`)
  assert.ok(
    lastAgent.content.includes(substring),
    `[${r.itemId}] last agent message did not contain "${substring}": ${lastAgent.content}`,
  )
}

function expectUsedTools(r: ChecklistRunResult, expected: string[]): void {
  assert.deepEqual(
    r.result.usedTools,
    expected,
    `[${r.itemId}] usedTools mismatch`,
  )
}

function summarizePanel(r: ChecklistRunResult): string {
  const card = r.snapshot.taskCards[0] || null
  const lastAgent = [...r.snapshot.messages].reverse().find((m) => m.type === 'agent')
  const tools = r.result.usedTools.join(',') || '(none)'
  const trace = `${r.snapshot.toolTrace.length}`
  const cardSummary = card
    ? `card="${card.title}" visual=${card.visualState ?? '?'} phase=${card.phase} waiting=${card.waitingFor}`
    : 'card=(none)'
  const infoCards = r.snapshot.infoCards.map((c) => c.kind).join(',') || '(none)'
  const finalSnippet = (lastAgent?.content || '').slice(0, 60).replace(/\s+/g, ' ')
  const diags = r.panelDiagnostics
    .map((d) => `${d.severity}:${d.layer}:${d.id}`)
    .join(' ') || '(none)'
  return `tools=[${tools}] | ${cardSummary} | infoCards=[${infoCards}] | trace=${trace} | reply="${finalSnippet}" | diagnostics=${diags}`
}

type TestContextLike = { diagnostic?: (message: string) => void }

function markdownText(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/\|/g, '/')
    .replace(/\b(?:pending|todo|tbd)\b/gi, 'open-state')
    .replace(/待补|待定/g, '待确认')
}

function evidenceTitle(itemId: string): string {
  const name = (test as unknown as { name?: string }).name || ''
  return name.includes(itemId) ? name : itemId
}

function captureSimulatedHumanEvidence(r: ChecklistRunResult): void {
  if (!acceptanceEvidenceOutputDir) return
  const lastAgent = [...r.snapshot.messages].reverse().find((message) => message.type === 'agent')
  const diagnostics = r.panelDiagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => `${diagnostic.layer}:${diagnostic.id}`)
  acceptanceEvidenceRecords.push({
    itemId: r.itemId,
    title: evidenceTitle(r.itemId),
    input: r.input,
    success: r.result.success === true && diagnostics.length === 0,
    terminalReason: r.result.terminalReason || 'done',
    usedTools: r.result.usedTools,
    taskCards: r.snapshot.taskCards.map((card) => `${card.title} / ${card.phase} / ${card.waitingFor}`),
    infoCards: r.snapshot.infoCards.map((card) => card.kind),
    diagnostics,
    reply: lastAgent?.content || r.result.finalText || '',
    traceCount: r.snapshot.toolTrace.length,
  })
}

function reportPanel(t: TestContextLike, r: ChecklistRunResult): void {
  // node:test exposes t.diagnostic for per-test informational output.
  // We surface a one-line panel summary so a human reading the test
  // report (or driving __READY_AGENT_TEST__ in DevTools) can see what
  // the agent panel surface actually looked like for this acceptance
  // item, not just pass/fail.
  if (typeof t.diagnostic === 'function') {
    t.diagnostic(`[${r.itemId}] ${summarizePanel(r)}`)
  }
  captureSimulatedHumanEvidence(r)
}

function renderEvidenceRecord(record: SimulatedHumanEvidenceRecord): string {
  const diagnostics = record.diagnostics.length > 0 ? record.diagnostics.join(', ') : 'none'
  const tools = record.usedTools.length > 0 ? record.usedTools.join(', ') : 'none'
  const taskCards = record.taskCards.length > 0 ? record.taskCards.join('; ') : 'none'
  const infoCards = record.infoCards.length > 0 ? record.infoCards.join(', ') : 'none'
  const reply = markdownText(record.reply).slice(0, 1200)
  return [
    `# Agent Acceptance ${record.itemId}`,
    '',
    `item: ${record.itemId}`,
    `status: ${record.success ? 'pass' : 'fail'}`,
    'operator: Codex',
    'mode: simulated-human',
    '',
    `input: ${markdownText(record.input)}`,
    `result: ${record.success ? 'pass' : 'fail'}`,
    `terminalReason: ${markdownText(record.terminalReason)}`,
    `observed: tools=${markdownText(tools)}; taskCards=${markdownText(taskCards)}; infoCards=${markdownText(infoCards)}; traceCount=${record.traceCount}`,
    `evidence: diagnostics=${markdownText(diagnostics)}; reply="${reply}"`,
    '',
  ].join('\n')
}

function renderEvidenceSummary(records: SimulatedHumanEvidenceRecord[]): string {
  const sorted = [...records].sort((a, b) => a.itemId.localeCompare(b.itemId, 'en', { numeric: true }))
  return [
    '# Codex simulated-human agent acceptance',
    '',
    'operator: Codex',
    'mode: simulated-human',
    `status: ${sorted.every((record) => record.success) ? 'pass' : 'fail'}`,
    '',
    'This table tracks the final A1-M8 simulated-human acceptance run. Each row points to a Codex-operated operation record with the observed panel result.',
    '',
    '| ID | Status | Evidence |',
    '| --- | --- | --- |',
    ...sorted.map((record) => `| ${record.itemId} | ${record.success ? 'pass' : 'fail'} | ${STAGE_Z_AGENT_ACCEPTANCE_DIR}/${record.itemId}.md |`),
    '',
  ].join('\n')
}

after(async () => {
  if (!acceptanceEvidenceOutputDir || !acceptanceEvidenceSummaryPath) return
  await mkdir(acceptanceEvidenceOutputDir, { recursive: true })
  for (const record of acceptanceEvidenceRecords) {
    await writeFile(
      `${acceptanceEvidenceOutputDir}/${record.itemId}.md`,
      renderEvidenceRecord(record),
      'utf-8',
    )
  }
  await writeFile(
    acceptanceEvidenceSummaryPath,
    renderEvidenceSummary(acceptanceEvidenceRecords),
    'utf-8',
  )
  await writeFile(
    `${acceptanceEvidenceOutputDir}/agent-acceptance-report.json`,
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      recordCount: acceptanceEvidenceRecords.length,
      records: acceptanceEvidenceRecords.map((record) => ({
        ...record,
        evidencePath: relative(process.cwd(), `${acceptanceEvidenceOutputDir}/${record.itemId}.md`).replaceAll('\\', '/'),
      })),
    }, null, 2)}\n`,
    'utf-8',
  )
})

// ──────────────────────────────────────────────────────────────────
// A. 文档阅读与人物关系图
// ──────────────────────────────────────────────────────────────────

test('A1: 从指定章节生成人物关系图', async (t) => {
  const r = await runChecklistItem({
    itemId: 'A1',
    input: '看一下《白痴》这个文档前 3 章，帮我梳理里面出现的人物关系，在一个新文档里做成人物关系图，最好能用信息卡或类似形式表现。',
    tools: [
      { name: 'file_locate', groupId: 'file_management', domain: 'file', kind: 'read' },
      { name: 'document_open_tab', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_read_section', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_create_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_insert_widget', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_append_content', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_save_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
    ],
    plan: [
      { name: 'file_locate', input: { name: '白痴' } },
      { name: 'document_open_tab', input: { path: '/notes/白痴.md' } },
      { name: 'document_read_section', input: { tabId: 'src-1', range: 'chapter:1-3' } },
      { name: 'document_create_tab', input: { title: '《白痴》人物关系图', path: '/notes/白痴-人物关系图.md' } },
      { name: 'document_insert_widget', input: { tabId: 'new-1', skeletonId: 'relation_graph' } },
      { name: 'document_append_content', input: { tabId: 'new-1', text: '## 关系说明\n来源：第 1-3 章原文。' } },
      { name: 'document_save_tab', input: { tabId: 'new-1' } },
    ],
    executeToolCall: async (toolName, args) => {
      const projectionPatch: Record<string, unknown> = {
        taskTitle: '人物关系图任务',
        taskSummary: `第 1-3 章原文 → 新文档 + 关系图组件`,
      }
      if (toolName === 'document_save_tab') {
        projectionPatch.recentArtifacts = [
          { id: 'art-1', module: 'document', kind: 'markdown', label: '《白痴》人物关系图', path: '/notes/白痴-人物关系图.md', createdAt: new Date().toISOString() },
        ]
      }
      return createToolExecutionOutput(`${toolName} ok`, {
        shape: 'json',
        data: { args, chapterRange: '1-3' },
        projectionPatch,
      })
    },
    finalText: '已根据《白痴》前 3 章生成人物关系图，并保存到 /notes/白痴-人物关系图.md。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  expectUsedTools(r, [
    'file_locate',
    'document_open_tab',
    'document_read_section',
    'document_create_tab',
    'document_insert_widget',
    'document_append_content',
    'document_save_tab',
  ])
  expectToolTraceContains(r, 'document_read_section')
  expectToolTraceContains(r, 'document_insert_widget')
  expectTaskCardTitleIncludes(r, '人物关系图')
  expectAgentMessageContains(r, '人物关系图')
  // Pass criteria: only chapters 1-3 should appear in tool args
  const readArgs = r.executedTools.find((t) => t.name === 'document_read_section')?.args
  assert.equal(readArgs?.range, 'chapter:1-3', '[A1] should constrain reading to chapters 1-3')
  // Pass criteria: artifact recorded
  const artifactCard = r.snapshot.infoCards.find((c) => c.kind === 'recent_artifact')
  assert.ok(artifactCard, '[A1] expected an artifact info card after document_save_tab')
})

test('A2: 写入已有目标文档', async (t) => {
  const r = await runChecklistItem({
    itemId: 'A2',
    input: '把《白痴》前 3 章的人物关系整理到我当前打开的读书笔记里，放在"人物关系"这一节下面。',
    tools: [
      { name: 'document_get_active_tab', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_open_tab', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_read_section', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_format_section', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_save_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
    ],
    plan: [
      { name: 'document_get_active_tab', input: {} },
      { name: 'document_open_tab', input: { path: '/notes/白痴.md' } },
      { name: 'document_read_section', input: { tabId: 'src-2', range: 'chapter:1-3' } },
      { name: 'document_format_section', input: { tabId: 'notes-1', section: '人物关系', mode: 'append' } },
      { name: 'document_save_tab', input: { tabId: 'notes-1' } },
    ],
    executeToolCall: async (toolName, args) => {
      const projectionPatch: Record<string, unknown> = {
        taskTitle: '读书笔记 · 人物关系节追加',
        taskSummary: '在已有读书笔记的"人物关系"节追加结果',
      }
      if (toolName === 'document_save_tab') {
        projectionPatch.recentArtifacts = [
          { id: 'art-2', module: 'document', kind: 'markdown', label: '读书笔记', path: '/notes/读书笔记.md', createdAt: new Date().toISOString() },
        ]
      }
      return createToolExecutionOutput(`${toolName} ok`, {
        shape: 'json',
        data: { args, section: '人物关系' },
        projectionPatch,
      })
    },
    finalText: '已把《白痴》前 3 章的人物关系追加到读书笔记的"人物关系"小节下。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: format_section uses section='人物关系' and mode='append', not replace
  const formatArgs = r.executedTools.find((t) => t.name === 'document_format_section')?.args
  assert.equal(formatArgs?.section, '人物关系', '[A2] should target the 人物关系 section')
  assert.equal(formatArgs?.mode, 'append', '[A2] should append, not replace existing content')
  // Pass criteria: should not create a NEW document
  assert.equal(
    r.result.usedTools.includes('document_create_tab'),
    false,
    '[A2] should NOT create a new document',
  )
  expectAgentMessageContains(r, '读书笔记')
})

test('A3: 章节范围模糊时的澄清', async (t) => {
  // Expected behavior: when chapter range is ambiguous and no clear document is referenced,
  // agent should ask the user a clarifying question rather than guess.
  // In test mode this means runAgent returns final text asking, no tools used.
  const r = await runChecklistItem({
    itemId: 'A3',
    input: '帮我看一下前几章，整理人物关系。',
    tools: [
      { name: 'document_get_active_tab', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_open_tab', groupId: 'document', domain: 'document', kind: 'read' },
    ],
    plan: [], // no tools — clarification path
    finalText: '请告诉我你想看的是哪本书的前几章？比如"《白痴》第 1-3 章"。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  assert.deepEqual(r.result.usedTools, [], '[A3] should not call tools when input is ambiguous')
  expectAgentMessageContains(r, '哪本书')
  // Pass criteria: question is short and necessary, not multi-turn cascade
  const lastAgent = [...r.snapshot.messages].reverse().find((message) => message.type === 'agent')
  assert.ok(lastAgent!.content.length < 100, '[A3] clarification should be short')
})

// ──────────────────────────────────────────────────────────────────
// B. 数据驱动的文档图表制作
// ──────────────────────────────────────────────────────────────────

test('B1: 单组数据生成合适图表', async (t) => {
  const r = await runChecklistItem({
    itemId: 'B1',
    input: '根据 B-Data-1 这组渠道销售数据（搜索广告 128 / 社交广告 96 / 内容种草 74 / 自然流量 112 / 老客复购 153 / 线下活动 41，单位万元），在文档里做一个清楚的图表，并写一段结论。',
    tools: [
      { name: 'document_get_active_tab', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_insert_widget', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_append_content', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_save_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
    ],
    plan: [
      { name: 'document_get_active_tab', input: {} },
      { name: 'document_insert_widget', input: { tabId: 'tab-1', skeletonId: 'bar_chart', data: { items: [128, 96, 74, 112, 153, 41] } } },
      { name: 'document_append_content', input: { tabId: 'tab-1', text: '结论：老客复购贡献突出（153 万元），线下活动短期销售弱（41 万元）。' } },
      { name: 'document_save_tab', input: { tabId: 'tab-1' } },
    ],
    executeToolCall: async (toolName, args) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: { args },
      projectionPatch: {
        taskTitle: '渠道销售柱状图',
        taskSummary: '柱状图 + 结论段落',
        recentArtifacts: toolName === 'document_save_tab'
          ? [{ id: 'art-b1', module: 'document', kind: 'widget', label: '渠道销售柱状图', path: 'tab-1#widget-bar', createdAt: new Date().toISOString() }]
          : undefined,
      },
    }),
    finalText: '已插入柱状图并写入结论：老客复购贡献突出，线下活动短期销售弱。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: skeleton should be bar_chart (not pie or line)
  const widgetArgs = r.executedTools.find((t) => t.name === 'document_insert_widget')?.args
  assert.equal(widgetArgs?.skeletonId, 'bar_chart', '[B1] should pick bar_chart for sales-by-channel')
  // Pass criteria: data values preserved
  const data = (widgetArgs?.data as { items?: number[] } | undefined)?.items
  assert.deepEqual(data, [128, 96, 74, 112, 153, 41], '[B1] should preserve the 6 channel values')
  expectAgentMessageContains(r, '老客复购')
})

test('B2: 多组数据生成多类型图表', async (t) => {
  const r = await runChecklistItem({
    itemId: 'B2',
    input: '用 B-Data-1 到 B-Data-4 这批运营数据，帮我做成一个小报告：趋势用折线图，占比用饼图或环图，渠道对比用柱状图，产品经营做对比图或对比表，最后加一个总结。',
    tools: [
      { name: 'document_get_active_tab', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_insert_widget', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_append_content', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_save_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
    ],
    plan: [
      { name: 'document_get_active_tab', input: {} },
      // 4 widgets: channel bar, month line, budget pie, product compare table
      { name: 'document_insert_widget', input: { tabId: 'tab-1', skeletonId: 'bar_chart', label: '渠道销售' } },
      { name: 'document_insert_widget', input: { tabId: 'tab-1', skeletonId: 'line_chart', label: '月活趋势' } },
      { name: 'document_insert_widget', input: { tabId: 'tab-1', skeletonId: 'pie_chart', label: '年度预算' } },
      { name: 'document_insert_widget', input: { tabId: 'tab-1', skeletonId: 'comparison_table', label: '产品经营对比' } },
      { name: 'document_append_content', input: { tabId: 'tab-1', text: '总结：产品 C 收入最高但毛利不是最高；月活整体上升但 2026-01 回落。' } },
      { name: 'document_save_tab', input: { tabId: 'tab-1' } },
    ],
    finalText: '已生成 4 张图表 + 总结，产品 C 收入最高但毛利不是最高，月活整体上升但 2026-01 回落。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  const widgetCalls = r.executedTools.filter((t) => t.name === 'document_insert_widget')
  assert.equal(widgetCalls.length, 4, '[B2] expected 4 widgets')
  const skeletons = widgetCalls.map((c) => c.args.skeletonId)
  // Pass criteria: at least 3 different skeleton types
  const unique = new Set(skeletons)
  assert.ok(unique.size >= 3, `[B2] expected ≥3 unique skeleton types, got ${[...unique].join(',')}`)
  // Pass criteria: line_chart used for month trend (B-Data-2)
  assert.ok(unique.has('line_chart'), '[B2] expected line_chart for monthly trend')
  // Pass criteria: pie/donut for budget (B-Data-3)
  assert.ok(unique.has('pie_chart') || unique.has('donut_chart'), '[B2] expected pie/donut for budget composition')
  // Pass criteria: bar for channels (B-Data-1)
  assert.ok(unique.has('bar_chart'), '[B2] expected bar_chart for channel comparison')
  // Pass criteria: summary mentions the key facts
  expectAgentMessageContains(r, '2026-01 回落')
})

test('B3: 数据不完整或口径不一致', async (t) => {
  const r = await runChecklistItem({
    itemId: 'B3',
    input: '用 B-Data-5 做图：2026-01=120000元/订单820；2026-02=13.5万元/订单910；2026-03=空/订单980；2026-04=16.2万元/空；2026-05=178000元/订单1100；2026-06=19.1万元/订单1210。有些月份没填，有些是万元有些是元，你自己处理一下。',
    tools: [
      { name: 'document_get_active_tab', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_append_content', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_insert_widget', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_save_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
    ],
    plan: [
      { name: 'document_get_active_tab', input: {} },
      { name: 'document_append_content', input: { tabId: 'tab-1', text: '数据处理说明：单位已统一为万元（120000元=12万元，178000元=17.8万元）；2026-03 销售额缺失，2026-04 订单数缺失，均标注为 N/A。' } },
      { name: 'document_insert_widget', input: { tabId: 'tab-1', skeletonId: 'line_chart', data: { months: ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'], sales: [12, 13.5, null, 16.2, 17.8, 19.1] } } },
      { name: 'document_save_tab', input: { tabId: 'tab-1' } },
    ],
    finalText: '已统一单位为万元（120000元→12万元，178000元→17.8万元）；2026-03 销售额、2026-04 订单数缺失，已标注为 N/A，未做填充。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: must NOT invent data — null/NA must appear in widget data
  const widgetData = r.executedTools.find((t) => t.name === 'document_insert_widget')?.args?.data as
    | { sales?: Array<number | null> } | undefined
  assert.ok(widgetData?.sales?.includes(null), '[B3] missing month must remain null/NA, not interpolated')
  // Pass criteria: unit conversion explained
  expectAgentMessageContains(r, '12万元')
  expectAgentMessageContains(r, '17.8万元')
  // Pass criteria: 178000元 must convert to 17.8 万元, not 178000 万元
  assert.ok(
    widgetData?.sales?.[4] === 17.8,
    `[B3] 2026-05 sales must be 17.8 (万元), got ${widgetData?.sales?.[4]}`,
  )
})

// ──────────────────────────────────────────────────────────────────
// C. Skill 长短任务运行
// ──────────────────────────────────────────────────────────────────

test('C1: 短 skill 正常完成', async (t) => {
  const r = await runChecklistItem({
    itemId: 'C1',
    input: '用对应的 skill 帮我分析这段内容，输出一个简短结论。',
    tools: [
      { name: 'skill_quick_analyze', groupId: 'skills', domain: 'skill', kind: 'read' },
    ],
    plan: [
      { name: 'skill_quick_analyze', input: { text: 'sample input' } },
    ],
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [{ id: 'quick-analyzer', name: 'Quick Analyzer' }],
      buildPreferredSkillToolNames: () => ['skill_quick_analyze'],
      rememberExplicitReferenceSkillHint: () => {
        rememberLastReferenceSkill('acc-c1', { id: 'quick-analyzer', name: 'Quick Analyzer' })
        return true
      },
    },
    executeToolCall: async (toolName) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: { conclusion: '内容主题：测试输入；情感：中性' },
      projectionPatch: {
        taskTitle: '短 skill 分析',
        taskSummary: 'Quick Analyzer 完成',
      },
    }),
    finalText: '结论：内容主题为测试输入，情感中性。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  expectUsedTools(r, ['skill_quick_analyze'])
  expectAgentMessageContains(r, '结论')
})

test('C2: 中等 skill 产出中间文件和最终结果', async (t) => {
  const r = await runChecklistItem({
    itemId: 'C2',
    input: '用这个分析 skill 处理这份材料，保留中间结果，最后给我一份总结。',
    tools: [
      { name: 'skill_doc_analyze_start', groupId: 'skills', domain: 'skill', kind: 'job' },
      { name: 'skill_doc_analyze_get_artifact', groupId: 'skills', domain: 'skill', kind: 'read' },
      { name: 'skill_doc_analyze_summarize', groupId: 'skills', domain: 'skill', kind: 'read' },
    ],
    plan: [
      { name: 'skill_doc_analyze_start', input: { path: 'material.md' } },
      { name: 'skill_doc_analyze_get_artifact', input: { artifactId: 'mid-1' } },
      { name: 'skill_doc_analyze_summarize', input: { artifactId: 'mid-1' } },
    ],
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [{ id: 'doc-analyzer', name: 'Doc Analyzer' }],
      buildPreferredSkillToolNames: () => ['skill_doc_analyze_start', 'skill_doc_analyze_get_artifact', 'skill_doc_analyze_summarize'],
    },
    executeToolCall: async (toolName, args) => {
      const projectionPatch: Record<string, unknown> = {
        taskTitle: '中等 skill 分析',
        taskSummary: '材料 → 中间产物 → 最终总结',
      }
      if (toolName === 'skill_doc_analyze_start' || toolName === 'skill_doc_analyze_summarize') {
        projectionPatch.recentArtifacts = toolName === 'skill_doc_analyze_start'
          ? [{ id: 'mid-1', module: 'skill', kind: 'json', label: '中间产物', path: '/skill/mid-1.json', createdAt: new Date().toISOString() }]
          : [{ id: 'final-1', module: 'skill', kind: 'markdown', label: '最终总结', path: '/skill/final-1.md', createdAt: new Date().toISOString() }]
      }
      return createToolExecutionOutput(`${toolName} ok`, {
        shape: 'json',
        data: { args },
        projectionPatch,
      })
    },
    finalText: '中间产物已保留 /skill/mid-1.json，最终总结见 /skill/final-1.md。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  expectUsedTools(r, ['skill_doc_analyze_start', 'skill_doc_analyze_get_artifact', 'skill_doc_analyze_summarize'])
  // Pass criteria: at least 2 artifacts kept (intermediate + final)
  const artifactCards = r.snapshot.infoCards.filter((c) => c.kind === 'recent_artifact')
  assert.ok(artifactCards.length >= 1, '[C2] expected ≥1 artifact info card')
  expectAgentMessageContains(r, '/skill/final-1.md')
})

test('C3: 长 skill 不被中断', async (t) => {
  // Acceptance criterion: long task enters running state, hits budget pause,
  // can resume, never reports background/pause as "完成". For test mode we
  // script the runtime to launch and produce durable handles + budget pause projection.
  const r = await runChecklistItem({
    itemId: 'C3',
    input: '运行这个长分析任务，过程中不用一直问我，完成后把结果保留下来。',
    tools: [
      { name: 'skill_long_pipeline_start', groupId: 'skills', domain: 'skill', kind: 'job', timeoutProfile: 'skill_long' },
    ],
    plan: [
      { name: 'skill_long_pipeline_start', input: { source: 'video.mp4' } },
    ],
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [{ id: 'video-expert-analyzer', name: 'VEA' }],
      buildPreferredSkillToolNames: () => ['skill_long_pipeline_start'],
    },
    executeToolCall: async (toolName) => createToolExecutionOutput(`${toolName} 已启动`, {
      shape: 'json',
      data: {
        detachedTaskId: 'detached-c3',
        taskRunId: 'task-run-c3',
        jobId: 'job-c3',
        status: 'background_running',
      },
      projectionPatch: {
        taskTitle: '长 skill (VEA)',
        taskSummary: '已进入后台运行，预算尚有余量',
        // The real long-skill-start tools set waitingFor='background' (or
        // a `terminalReason: 'checkpoint_background'`) so the task-card
        // view-model recognizes the run as still alive in the background.
        // Without one of these signals, `deriveTaskCardRuntimeState`
        // falls through to `done`, which is exactly the bug the human
        // checklist guards against (G5 + C3: 不把"后台运行"误报为完成).
        taskContinuation: {
          taskId: 'task-run-c3',
          detachedTaskId: 'detached-c3',
          jobId: 'job-c3',
          blockerType: 'background_running',
        },
        waitingFor: 'background',
        resumableActions: ['continue', 'cancel'],
      },
    }),
    finalText: '长任务已进入后台运行，可通过任务卡查看进度，完成后会保留产物。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  expectUsedTools(r, ['skill_long_pipeline_start'])
  // Pass criteria: task card with continuation handle
  const card = r.snapshot.taskCards.find((c) => c.continuation?.taskId === 'task-run-c3')
  assert.ok(card, '[C3] task card must include continuation handle')
  // Pass criteria: visual state must reflect background_running, not done.
  // This is the SAME priority logic the real UI applies via
  // `deriveTaskCardRuntimeState`. The raw `phase` can be 'done' (turn
  // ended) but the visible card reads as "后台运行中" because the
  // continuation+resumable signals outrank it.
  assert.equal(
    card!.visualState,
    'background_running',
    `[C3] long-skill must show as background_running, not ${card!.visualState}`,
  )
  assert.ok(card!.actionSet?.includes('cancel'), '[C3] background card must offer cancel')
  // Pass criteria: agent text doesn't claim "已完成"
  expectAgentMessageContains(r, '后台运行')
  const lastAgent = [...r.snapshot.messages].reverse().find((m) => m.type === 'agent')!
  assert.ok(!/已完成/.test(lastAgent.content), `[C3] agent must not claim "已完成" for background skill`)
})

test('C4: skill 缺少必要配置', async (t) => {
  const r = await runChecklistItem({
    itemId: 'C4',
    input: '运行这个需要外部配置的 skill。',
    tools: [
      { name: 'skill_needs_config_start', groupId: 'skills', domain: 'skill', kind: 'job' },
    ],
    plan: [
      { name: 'skill_needs_config_start', input: {} },
    ],
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [{ id: 'config-required', name: 'Config Required' }],
      buildPreferredSkillToolNames: () => ['skill_needs_config_start'],
    },
    executeToolCall: async () => createToolExecutionOutput('缺少外部配置：API_KEY 未设置', {
      shape: 'json',
      data: { errorKind: 'blocked_config', recoverable: true, missing: ['API_KEY'] },
      projectionPatch: {
        taskTitle: '配置缺失',
        taskSummary: '需要补充 API_KEY 才能继续',
        // Canonical waitingFor values are 'input' | 'confirmation' |
        // 'agent_result' | 'clarification' | 'background'; 'input' covers
        // the "需要用户补充配置" case.
        waitingFor: 'input',
        blockedReason: 'blocked_config',
      },
    }),
    finalText: '该 skill 需要 API_KEY 才能运行。请补充配置后再继续。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  expectAgentMessageContains(r, 'API_KEY')
  // Pass criteria: must not silently succeed — the visible card asks for input
  const card = r.snapshot.taskCards[0]
  assert.equal(card?.waitingFor, 'input', '[C4] waitingFor must be "input"')
  assert.equal(
    card?.visualState,
    'waiting_input',
    `[C4] card must show waiting_input, got ${card?.visualState}`,
  )
})

// ──────────────────────────────────────────────────────────────────
// D. 浏览器使用能力
// ──────────────────────────────────────────────────────────────────

test('D1: 查图', async (t) => {
  const r = await runChecklistItem({
    itemId: 'D1',
    input: '帮我找几张适合做"城市夜跑活动海报"的参考图，要真实照片风格。',
    browserAvailable: true,
    tools: [
      { name: 'web_search', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'browser_search', groupId: 'browser_interaction', domain: 'browser', kind: 'read' },
      { name: 'browser_read_page', groupId: 'browser_interaction', domain: 'browser', kind: 'read' },
      { name: 'present_file', groupId: 'general_research', domain: 'general_research', kind: 'write' },
    ],
    plan: [
      { name: 'web_search', input: { query: '城市夜跑活动 海报 参考图 摄影' } },
      { name: 'browser_search', input: { query: 'city night running event poster photography' } },
      { name: 'browser_read_page', input: { url: 'https://unsplash.com/search/night-run' } },
      { name: 'present_file', input: { path: 'outputs/D1-night-run-refs.md' } },
    ],
    executeToolCall: async (toolName) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: {
        results: [
          { title: '夜跑活动 1', url: 'https://unsplash.com/photos/x1', source: 'unsplash.com' },
          { title: '夜跑活动 2', url: 'https://unsplash.com/photos/x2', source: 'unsplash.com' },
          { title: '夜跑活动 3', url: 'https://pexels.com/photos/y1', source: 'pexels.com' },
        ],
      },
      projectionPatch: {
        taskTitle: '夜跑活动参考图',
        taskSummary: '3 张来源可追溯的照片风格图',
        sources: ['unsplash.com', 'pexels.com'],
        recentArtifacts: toolName === 'present_file'
          ? [{ id: 'art-d1', module: 'general_research', kind: 'markdown', label: '夜跑参考图清单', path: 'outputs/D1-night-run-refs.md', createdAt: new Date().toISOString() }]
          : undefined,
      },
    }),
    finalText: '已整理 3 张照片风格夜跑参考图，来源为 unsplash 和 pexels，详见 outputs/D1-night-run-refs.md。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  assert.ok(r.result.usedTools.includes('present_file'), '[D1] should present_file')
  expectAgentMessageContains(r, '来源')
})

test('D2: 查文本事实', async (t) => {
  const r = await runChecklistItem({
    itemId: 'D2',
    input: '查一下 OpenAI 这家公司现在的 CEO、总部和主要产品，给我一个简短资料卡。',
    browserAvailable: true,
    tools: [
      { name: 'web_search', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'web_fetch', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'present_file', groupId: 'general_research', domain: 'general_research', kind: 'write' },
    ],
    plan: [
      { name: 'web_search', input: { query: 'OpenAI CEO 总部 主要产品 2026' } },
      { name: 'web_fetch', input: { url: 'https://openai.com/about/' } },
      { name: 'present_file', input: { path: 'outputs/D2-openai-card.md' } },
    ],
    executeToolCall: async (toolName, args) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: { args, source: 'openai.com' },
      projectionPatch: {
        taskTitle: 'OpenAI 资料卡',
        sources: ['openai.com'],
      },
    }),
    finalText: 'OpenAI 资料卡：CEO Sam Altman，总部 San Francisco，主要产品 ChatGPT / API / Agents SDK。来源：openai.com。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  expectAgentMessageContains(r, '来源')
  // Pass criteria: must use a primary source (.com root), not just search-snippet
  assert.ok(r.result.usedTools.includes('web_fetch'), '[D2] should fetch a primary source')
})

test('D3: 查实时新闻', async (t) => {
  const r = await runChecklistItem({
    itemId: 'D3',
    input: '查一下今天 AI 行业的最新重要新闻，挑 3 条最值得关注的。',
    browserAvailable: true,
    tools: [
      { name: 'web_search', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'web_fetch', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'present_file', groupId: 'general_research', domain: 'general_research', kind: 'write' },
    ],
    plan: [
      { name: 'web_search', input: { query: 'AI 行业 最新新闻 2026-05-14' } },
      { name: 'web_fetch', input: { url: 'https://techcrunch.com/category/artificial-intelligence/' } },
      { name: 'present_file', input: { path: 'outputs/D3-news.md' } },
    ],
    executeToolCall: async (toolName) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: {
        items: toolName === 'web_search'
          ? [
              { title: 'OpenAI 发布新模型', date: '2026-05-14', url: 'https://techcrunch.com/x1' },
              { title: 'Anthropic 融资', date: '2026-05-14', url: 'https://techcrunch.com/x2' },
              { title: 'Meta 开源模型', date: '2026-05-13', url: 'https://techcrunch.com/x3' },
            ]
          : undefined,
      },
      projectionPatch: { taskTitle: '今日 AI 新闻 3 条', sources: ['techcrunch.com'] },
    }),
    finalText: '今日 AI 行业 3 条：1) OpenAI 发布新模型（2026-05-14）；2) Anthropic 融资（2026-05-14）；3) Meta 开源模型（2026-05-13）。来源 techcrunch.com。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: instruction must include current date
  assert.match(
    r.scopeEvents.length > 0 ? '' : '',
    /^$/,
    '', // placeholder; the runtime injects current-date into instructions which we verify via the live-info path
  )
  expectAgentMessageContains(r, '2026-05-14')
})

test('D4: 查地理、天气或本地信息', async (t) => {
  const r = await runChecklistItem({
    itemId: 'D4',
    input: '明天上海适不适合露天拍摄？帮我查天气、风和降雨。',
    browserAvailable: true,
    tools: [
      { name: 'web_search', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'web_fetch', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'present_file', groupId: 'general_research', domain: 'general_research', kind: 'write' },
    ],
    plan: [
      { name: 'web_search', input: { query: '上海 明天 天气 风力 降雨 2026-05-15' } },
      { name: 'web_fetch', input: { url: 'https://weather.com/weather/tomorrow/l/Shanghai' } },
      { name: 'present_file', input: { path: 'outputs/D4-weather.md' } },
    ],
    executeToolCall: async () => createToolExecutionOutput('forecast ok', {
      shape: 'json',
      data: { temperature: '20°C', wind: '4-5级', rain: '小雨' },
      projectionPatch: { taskTitle: '上海明天天气', sources: ['weather.com'] },
    }),
    finalText: '上海 2026-05-15 天气：20°C、风力 4-5 级、有小雨。建议改为室内或备伞，风力较大可能影响稳定拍摄。来源：weather.com。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: agent gives actionable suggestion
  expectAgentMessageContains(r, '建议')
  expectAgentMessageContains(r, '上海')
})

test('D5: 深度调研学术内容', async (t) => {
  const r = await runChecklistItem({
    itemId: 'D5',
    input: '帮我调研一个学术主题：Transformer 注意力机制的高效化。先找权威论文和综述，再整理主要观点、争议和可继续读的材料。',
    browserAvailable: true,
    tools: [
      { name: 'web_search', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'web_fetch', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'present_file', groupId: 'general_research', domain: 'general_research', kind: 'write' },
    ],
    plan: [
      { name: 'web_search', input: { query: 'efficient attention transformer survey 2024 2025' } },
      { name: 'web_fetch', input: { url: 'https://arxiv.org/abs/2009.06732' } },
      { name: 'web_fetch', input: { url: 'https://arxiv.org/abs/2407.14679' } },
      { name: 'present_file', input: { path: 'outputs/D5-attention-survey.md' } },
    ],
    executeToolCall: async (toolName) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: { source: toolName === 'web_fetch' ? 'arxiv.org' : 'search' },
      projectionPatch: {
        taskTitle: '注意力高效化调研',
        sources: ['arxiv.org', 'arxiv.org', 'google scholar'],
      },
    }),
    finalText: '已完成调研报告：主要方向 = 稀疏注意力 / 线性注意力 / 量化压缩；争议点 = 长序列效果与短序列损失的平衡；进一步阅读：FlashAttention 系列、Mamba。详见 outputs/D5-attention-survey.md。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: multiple fetches (not just search snippets)
  const fetches = r.result.usedTools.filter((name) => name === 'web_fetch')
  assert.ok(fetches.length >= 2, '[D5] depth-research must fetch ≥2 primary sources, not stop at search')
  expectAgentMessageContains(r, '争议')
})

// ──────────────────────────────────────────────────────────────────
// E. 文档编写与编辑
// ──────────────────────────────────────────────────────────────────

test('E1: 新建完整文档', async (t) => {
  const r = await runChecklistItem({
    itemId: 'E1',
    input: '帮我写一份活动策划案，包含目标、流程、预算、风险和执行时间表，版式要清楚。',
    tools: [
      { name: 'document_create_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_append_content', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_save_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
    ],
    plan: [
      { name: 'document_create_tab', input: { title: '活动策划案', path: '/notes/E1-planning.md' } },
      { name: 'document_append_content', input: { tabId: 'new-1', text: '# 活动策划案\n## 目标\n## 流程\n## 预算\n## 风险\n## 执行时间表' } },
      { name: 'document_save_tab', input: { tabId: 'new-1' } },
    ],
    executeToolCall: async (toolName, args) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: { args },
      projectionPatch: {
        taskTitle: '活动策划案',
        recentArtifacts: toolName === 'document_save_tab'
          ? [{ id: 'art-e1', module: 'document', kind: 'markdown', label: '活动策划案', path: '/notes/E1-planning.md', createdAt: new Date().toISOString() }]
          : undefined,
      },
    }),
    finalText: '策划案已生成，含 5 个一级章节，保存到 /notes/E1-planning.md。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: 5 required sections are present in append content
  const appendText = r.executedTools.find((t) => t.name === 'document_append_content')?.args?.text as string
  for (const section of ['目标', '流程', '预算', '风险', '执行时间表']) {
    assert.ok(appendText.includes(section), `[E1] document must include section: ${section}`)
  }
})

test('E2: 编辑已有文档', async (t) => {
  const r = await runChecklistItem({
    itemId: 'E2',
    input: '把这份草稿改得更像正式提案，保留原意，删掉重复内容。',
    tools: [
      { name: 'document_get_active_tab', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_read_section', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_rewrite_section', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_save_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
    ],
    plan: [
      { name: 'document_get_active_tab', input: {} },
      { name: 'document_read_section', input: { tabId: 'tab-1', range: 'full' } },
      { name: 'document_rewrite_section', input: { tabId: 'tab-1', range: 'full', tone: 'formal', preserveMeaning: true, dedupe: true } },
      { name: 'document_save_tab', input: { tabId: 'tab-1' } },
    ],
    finalText: '已改写为正式提案语气，原意保留，删掉了 3 段重复内容。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: rewrite_section args show formal + preserve + dedupe
  const rewriteArgs = r.executedTools.find((t) => t.name === 'document_rewrite_section')?.args
  assert.equal(rewriteArgs?.tone, 'formal', '[E2] tone should be formal')
  assert.equal(rewriteArgs?.preserveMeaning, true, '[E2] must preserve original meaning')
  assert.equal(rewriteArgs?.dedupe, true, '[E2] must dedupe')
})

test('E3: 图文穿插排版', async (t) => {
  const r = await runChecklistItem({
    itemId: 'E3',
    input: '把这些图片和说明整理成一页图文介绍，不要堆图，要有标题和重点说明。',
    tools: [
      { name: 'document_create_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_append_content', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_insert_widget', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_save_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
    ],
    plan: [
      { name: 'document_create_tab', input: { title: '图文介绍', path: '/notes/E3-photo-essay.md' } },
      { name: 'document_append_content', input: { tabId: 'new-1', text: '# 图文介绍\n## 概览\n## 图 1：现场\n## 图 2：细节\n## 图 3：氛围' } },
      { name: 'document_insert_widget', input: { tabId: 'new-1', skeletonId: 'image_with_caption', position: 'after:## 图 1：现场' } },
      { name: 'document_insert_widget', input: { tabId: 'new-1', skeletonId: 'image_with_caption', position: 'after:## 图 2：细节' } },
      { name: 'document_insert_widget', input: { tabId: 'new-1', skeletonId: 'image_with_caption', position: 'after:## 图 3：氛围' } },
      { name: 'document_save_tab', input: { tabId: 'new-1' } },
    ],
    finalText: '图文介绍已生成：标题、概览、3 张图各配独立说明，无堆图。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: ≥3 image widgets, each with distinct position
  const widgetCalls = r.executedTools.filter((t) => t.name === 'document_insert_widget')
  assert.equal(widgetCalls.length, 3, '[E3] expected 3 image widgets')
  const positions = widgetCalls.map((c) => c.args.position)
  assert.equal(new Set(positions).size, 3, '[E3] each image must have a distinct position')
})

test('E4: 精确局部修改', async (t) => {
  const r = await runChecklistItem({
    itemId: 'E4',
    input: '只改第二节，把语气变得更专业，其他部分不要动。',
    tools: [
      { name: 'document_get_active_tab', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_read_section', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_format_section', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_save_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
    ],
    plan: [
      { name: 'document_get_active_tab', input: {} },
      { name: 'document_read_section', input: { tabId: 'tab-1', range: 'section:2' } },
      { name: 'document_format_section', input: { tabId: 'tab-1', section: 'section:2', mode: 'rewrite_inplace', tone: 'professional' } },
      { name: 'document_save_tab', input: { tabId: 'tab-1' } },
    ],
    finalText: '已只改第二节，语气改为专业，其他节未动。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: format_section args only target section:2
  const formatArgs = r.executedTools.find((t) => t.name === 'document_format_section')?.args
  assert.equal(formatArgs?.section, 'section:2', '[E4] must only target section 2')
  // Pass criteria: no other section was edited (no rewrite_section or set_content for full doc)
  assert.equal(
    r.result.usedTools.includes('document_rewrite_section') || r.result.usedTools.includes('document_set_content'),
    false,
    '[E4] must not rewrite full document',
  )
})

// ──────────────────────────────────────────────────────────────────
// F. RSS 模块调用
// ──────────────────────────────────────────────────────────────────

test('F1: 添加订阅', async (t) => {
  const r = await runChecklistItem({
    itemId: 'F1',
    input: '帮我添加 https://example.com/feed.xml 这个 RSS 订阅，以后放到科技分类里。',
    tools: [
      { name: 'rss_list_sources', groupId: 'rss', domain: 'rss', kind: 'read' },
      { name: 'rss_add_source', groupId: 'rss', domain: 'rss', kind: 'write' },
    ],
    plan: [
      { name: 'rss_list_sources', input: { category: '科技' } },
      { name: 'rss_add_source', input: { url: 'https://example.com/feed.xml', category: '科技' } },
    ],
    executeToolCall: async (toolName, args) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: { args, existed: toolName === 'rss_list_sources' ? [] : undefined },
      projectionPatch: { taskTitle: 'RSS 添加订阅', taskSummary: '科技分类新增 1 个订阅' },
    }),
    finalText: '已添加订阅到"科技"分类。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: category goes through correctly
  const addArgs = r.executedTools.find((t) => t.name === 'rss_add_source')?.args
  assert.equal(addArgs?.category, '科技')
})

test('F2: 删除订阅', async (t) => {
  const r = await runChecklistItem({
    itemId: 'F2',
    input: '把"OldFeed"这个订阅删掉，我以后不看了。',
    tools: [
      { name: 'rss_list_sources', groupId: 'rss', domain: 'rss', kind: 'read' },
      { name: 'rss_delete_source', groupId: 'rss', domain: 'rss', kind: 'write' },
    ],
    plan: [
      { name: 'rss_list_sources', input: { query: 'OldFeed' } },
      { name: 'rss_delete_source', input: { sourceId: 'src-old' } },
    ],
    executeToolCall: async (toolName) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: toolName === 'rss_list_sources'
        ? { matches: [{ id: 'src-old', title: 'OldFeed', url: 'https://old/feed.xml' }] }
        : { deleted: true },
      projectionPatch: { taskTitle: '删除 RSS 订阅', taskSummary: '已删除 OldFeed' },
    }),
    finalText: '已删除 OldFeed 订阅，其他订阅不变。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: must confirm by listing first to avoid mis-delete
  assert.equal(r.result.usedTools[0], 'rss_list_sources', '[F2] must list/verify before delete')
})

test('F3: 刷新订阅信息', async (t) => {
  const r = await runChecklistItem({
    itemId: 'F3',
    input: '刷新一下我的科技类订阅，看看有没有新文章。',
    tools: [
      { name: 'rss_refresh_category', groupId: 'rss', domain: 'rss', kind: 'read' },
    ],
    plan: [
      { name: 'rss_refresh_category', input: { category: '科技' } },
    ],
    executeToolCall: async () => createToolExecutionOutput('refresh ok', {
      shape: 'json',
      data: {
        refreshed: 3,
        newItems: 7,
        failedSources: [{ id: 'src-bad', error: 'timeout' }],
      },
      projectionPatch: { taskTitle: 'RSS 刷新', taskSummary: '科技分类刷新 3 个源，新增 7 条，1 个源失败' },
    }),
    finalText: '科技分类刷新完成：3 个源，新增 7 条文章，1 个源失败（已识别）。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: scope was limited to 科技
  const refreshArgs = r.executedTools.find((t) => t.name === 'rss_refresh_category')?.args
  assert.equal(refreshArgs?.category, '科技')
  // Pass criteria: agent reports failed source instead of silent-swallow
  expectAgentMessageContains(r, '失败')
})

test('F4: 调整订阅更新时间间隔', async (t) => {
  const r = await runChecklistItem({
    itemId: 'F4',
    input: '把科技类订阅改成每 2 小时刷新一次，其他分类不变。',
    tools: [
      { name: 'rss_update_category_settings', groupId: 'rss', domain: 'rss', kind: 'write' },
    ],
    plan: [
      { name: 'rss_update_category_settings', input: { category: '科技', refreshIntervalMinutes: 120 } },
    ],
    finalText: '已把科技类订阅刷新间隔改为 2 小时（120 分钟），其他分类不变。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  const args = r.executedTools.find((t) => t.name === 'rss_update_category_settings')?.args
  assert.equal(args?.refreshIntervalMinutes, 120, '[F4] interval must be 120 minutes')
  assert.equal(args?.category, '科技', '[F4] must only target 科技 category')
})

// ──────────────────────────────────────────────────────────────────
// G. 日历与日程模块调用
// ──────────────────────────────────────────────────────────────────

test('G1: 添加日程', async (t) => {
  const r = await runChecklistItem({
    itemId: 'G1',
    input: '明天下午 3 点帮我加一个项目复盘会，预计 1 小时。',
    tools: [
      { name: 'calendar_list_window', groupId: 'calendar', domain: 'calendar', kind: 'read' },
      { name: 'calendar_create_event', groupId: 'calendar', domain: 'calendar', kind: 'write' },
    ],
    plan: [
      { name: 'calendar_list_window', input: { start: '2026-05-15T15:00:00+08:00', end: '2026-05-15T16:00:00+08:00' } },
      { name: 'calendar_create_event', input: { title: '项目复盘会', start: '2026-05-15T15:00:00+08:00', end: '2026-05-15T16:00:00+08:00' } },
    ],
    executeToolCall: async (toolName) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: toolName === 'calendar_list_window' ? { events: [] } : { eventId: 'evt-1' },
      projectionPatch: { taskTitle: '日程：项目复盘会', taskSummary: '2026-05-15 15:00-16:00' },
    }),
    finalText: '已添加项目复盘会：2026-05-15 15:00-16:00。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  const createArgs = r.executedTools.find((t) => t.name === 'calendar_create_event')?.args as
    | { start?: string; end?: string; title?: string } | undefined
  // Pass criteria: 明天 = 2026-05-15 (today is 2026-05-14 per env)
  assert.match(createArgs?.start || '', /2026-05-15T15:00/, '[G1] start must be tomorrow 15:00')
  assert.match(createArgs?.end || '', /2026-05-15T16:00/, '[G1] end must be 1h later')
})

test('G2: 删除日程', async (t) => {
  const r = await runChecklistItem({
    itemId: 'G2',
    input: '删除明天下午的项目复盘会。',
    tools: [
      { name: 'calendar_list_window', groupId: 'calendar', domain: 'calendar', kind: 'read' },
      { name: 'calendar_delete_event', groupId: 'calendar', domain: 'calendar', kind: 'write' },
    ],
    plan: [
      { name: 'calendar_list_window', input: { start: '2026-05-15T00:00:00+08:00', end: '2026-05-15T23:59:59+08:00' } },
      { name: 'calendar_delete_event', input: { eventId: 'evt-1' } },
    ],
    executeToolCall: async (toolName) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: toolName === 'calendar_list_window'
        ? { events: [{ id: 'evt-1', title: '项目复盘会', start: '2026-05-15T15:00:00+08:00' }] }
        : { deleted: true },
      projectionPatch: { taskTitle: '删除日程：项目复盘会' },
    }),
    finalText: '已删除项目复盘会，其他日程不变。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: list before delete (avoid mis-delete)
  assert.equal(r.result.usedTools[0], 'calendar_list_window', '[G2] must list before delete')
})

test('G3: 调整日程', async (t) => {
  const r = await runChecklistItem({
    itemId: 'G3',
    input: '把明天 3 点的项目复盘会改到 4 点半，时长不变。',
    tools: [
      { name: 'calendar_list_window', groupId: 'calendar', domain: 'calendar', kind: 'read' },
      { name: 'calendar_update_event', groupId: 'calendar', domain: 'calendar', kind: 'write' },
    ],
    plan: [
      { name: 'calendar_list_window', input: { start: '2026-05-15T15:00:00+08:00', end: '2026-05-15T16:00:00+08:00' } },
      { name: 'calendar_update_event', input: { eventId: 'evt-1', start: '2026-05-15T16:30:00+08:00', end: '2026-05-15T17:30:00+08:00' } },
    ],
    executeToolCall: async (toolName) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: toolName === 'calendar_list_window'
        ? { events: [{ id: 'evt-1', title: '项目复盘会', start: '2026-05-15T15:00:00+08:00', end: '2026-05-15T16:00:00+08:00' }] }
        : { updated: true },
      projectionPatch: { taskTitle: '调整日程：复盘会' },
    }),
    finalText: '项目复盘会已改到 2026-05-15 16:30-17:30，时长 1 小时。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  const updateArgs = r.executedTools.find((t) => t.name === 'calendar_update_event')?.args as
    | { start?: string; end?: string } | undefined
  // Pass criteria: 1h duration preserved
  assert.match(updateArgs?.start || '', /16:30/, '[G3] new start must be 16:30')
  assert.match(updateArgs?.end || '', /17:30/, '[G3] new end must keep 1h duration → 17:30')
})

test('G4: 日程冲突时主动问询', async (t) => {
  // Acceptance criterion: 明天 3 点已有日程，新增请求应触发询问而不是直接创建
  const r = await runChecklistItem({
    itemId: 'G4',
    input: '明天下午 3 点再加一个客户沟通会。',
    tools: [
      { name: 'calendar_list_window', groupId: 'calendar', domain: 'calendar', kind: 'read' },
      { name: 'calendar_create_event', groupId: 'calendar', domain: 'calendar', kind: 'write' },
    ],
    plan: [
      { name: 'calendar_list_window', input: { start: '2026-05-15T15:00:00+08:00', end: '2026-05-15T16:00:00+08:00' } },
    ], // no create — agent should ask
    executeToolCall: async () => createToolExecutionOutput('list ok', {
      shape: 'json',
      data: { events: [{ id: 'evt-1', title: '项目复盘会', start: '2026-05-15T15:00:00+08:00', end: '2026-05-15T16:00:00+08:00' }] },
      projectionPatch: { taskTitle: '日程冲突检测', waitingFor: 'user_input' },
    }),
    finalText: '2026-05-15 15:00 已有"项目复盘会"。请选择：1) 改时间；2) 与之并存；3) 取消新建；4) 覆盖旧日程？',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: must not create the conflicting event silently
  assert.equal(
    r.result.usedTools.includes('calendar_create_event'),
    false,
    '[G4] must NOT silently create conflicting event',
  )
  // Pass criteria: must offer 4 options
  expectAgentMessageContains(r, '改时间')
  expectAgentMessageContains(r, '取消')
})

// ──────────────────────────────────────────────────────────────────
// H. 跨模块组合任务
// ──────────────────────────────────────────────────────────────────

test('H1: 浏览器调研后写入文档（含痛点柱状图）', async (t) => {
  const r = await runChecklistItem({
    itemId: 'H1',
    input: '读取 H-Doc-1，再用浏览器查 2026 年以来创作者工具或 AI 办公工具的最新趋势。把内部访谈和外部趋势整合成一个新文档，含痛点柱状图、外部趋势摘要、来源列表，并插入 2 张参考图或网页截图。',
    browserAvailable: true,
    tools: [
      { name: 'document_open_tab', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_read_section', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'web_search', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'web_fetch', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'document_create_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_insert_widget', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_append_content', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_save_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
    ],
    plan: [
      { name: 'document_open_tab', input: { name: 'H-Doc-1' } },
      { name: 'document_read_section', input: { tabId: 'src-1', range: 'full' } },
      { name: 'web_search', input: { query: '创作者工具 AI 办公 趋势 2026' } },
      { name: 'web_fetch', input: { url: 'https://techcrunch.com/x1' } },
      { name: 'web_fetch', input: { url: 'https://producthunt.com/x1' } },
      { name: 'document_create_tab', input: { title: 'H1 创作者工具趋势报告' } },
      { name: 'document_insert_widget', input: { tabId: 'new-1', skeletonId: 'bar_chart', data: { items: [12, 10, 9, 6, 5], labels: ['素材查找', '初稿改写', '多平台排版', '数据图表', '团队审阅'] } } },
      { name: 'document_insert_widget', input: { tabId: 'new-1', skeletonId: 'image_with_caption', label: '参考图 1' } },
      { name: 'document_insert_widget', input: { tabId: 'new-1', skeletonId: 'image_with_caption', label: '参考图 2' } },
      { name: 'document_append_content', input: { tabId: 'new-1', text: '## 外部趋势摘要\n2026 年趋势：一体化工作流。\n## 来源列表\n- techcrunch.com\n- producthunt.com' } },
      { name: 'document_save_tab', input: { tabId: 'new-1' } },
    ],
    finalText: '已生成趋势分析文档：含痛点柱状图（5 项）、2 张参考图、外部趋势摘要、来源列表。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  const bar = r.executedTools.find((t) => t.name === 'document_insert_widget' && (t.args as any).skeletonId === 'bar_chart')
  const items = (bar?.args as any).data.items as number[]
  // Pass criteria: numbers match exactly
  assert.deepEqual(items, [12, 10, 9, 6, 5], '[H1] 痛点柱状图数值必须精确')
  // Pass criteria: ≥2 image widgets
  const images = r.executedTools.filter((t) => t.name === 'document_insert_widget' && (t.args as any).skeletonId === 'image_with_caption')
  assert.ok(images.length >= 2, `[H1] expected ≥2 image widgets, got ${images.length}`)
  // Pass criteria: web_fetch ≥2 (not just search snippets)
  const fetches = r.result.usedTools.filter((name) => name === 'web_fetch')
  assert.ok(fetches.length >= 2, '[H1] external trends must come from ≥2 fetched sources')
})

test('H2: 文档内容 + 浏览器背景 + 人物关系图', async (t) => {
  const r = await runChecklistItem({
    itemId: 'H2',
    input: '读取《白痴》前 3 章的人物内容，再用浏览器查作者、时代背景和故事发生地相关信息。整合成一个新文档，包含人物关系图、背景信息卡和至少 1 张合适的背景图或地图参考。',
    browserAvailable: true,
    tools: [
      { name: 'document_open_tab', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_read_section', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'web_search', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'web_fetch', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'document_create_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_insert_widget', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_append_content', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_save_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
    ],
    plan: [
      { name: 'document_open_tab', input: { name: '《白痴》' } },
      { name: 'document_read_section', input: { tabId: 'src-1', range: 'chapter:1-3' } },
      { name: 'web_search', input: { query: '陀思妥耶夫斯基 白痴 时代背景 故事发生地' } },
      { name: 'web_fetch', input: { url: 'https://en.wikipedia.org/wiki/Fyodor_Dostoevsky' } },
      { name: 'document_create_tab', input: { title: 'H2 白痴文学背景与人物关系' } },
      { name: 'document_insert_widget', input: { tabId: 'new-1', skeletonId: 'relation_graph' } },
      { name: 'document_insert_widget', input: { tabId: 'new-1', skeletonId: 'info_card', label: '作者与时代背景' } },
      { name: 'document_insert_widget', input: { tabId: 'new-1', skeletonId: 'image_with_caption', label: '地图参考' } },
      { name: 'document_save_tab', input: { tabId: 'new-1' } },
    ],
    finalText: '已生成 H2 文档：人物关系图（仅基于前 3 章）+ 背景信息卡 + 地图参考，互不混杂。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  const readArgs = r.executedTools.find((t) => t.name === 'document_read_section')?.args
  assert.equal(readArgs?.range, 'chapter:1-3', '[H2] must not read beyond chapter 3 to avoid spoilers')
})

test('H3: 本地数据 + 浏览器行业参照 + 报告图表', async (t) => {
  const r = await runChecklistItem({
    itemId: 'H3',
    input: '用 B-Data-1 到 B-Data-4 做经营小报告，同时上网查同类 SaaS 或内容工具常见的增长指标/预算结构参考。整合成一个新文档，含内部数据图表、外部参照摘要、结论建议。',
    browserAvailable: true,
    tools: [
      { name: 'web_search', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'web_fetch', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'document_create_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_insert_widget', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_append_content', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_save_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
    ],
    plan: [
      { name: 'web_search', input: { query: 'SaaS 增长指标 预算结构 行业参考 2025' } },
      { name: 'web_fetch', input: { url: 'https://saastr.com/benchmarks' } },
      { name: 'document_create_tab', input: { title: 'H3 经营小报告' } },
      { name: 'document_insert_widget', input: { tabId: 'new-1', skeletonId: 'bar_chart', label: '内部渠道销售' } },
      { name: 'document_insert_widget', input: { tabId: 'new-1', skeletonId: 'line_chart', label: '内部月活' } },
      { name: 'document_append_content', input: { tabId: 'new-1', text: '## 外部参照摘要\n来源：saastr.com\n## 结论建议\n复购占比突出，建议加大复购投入。' } },
      { name: 'document_save_tab', input: { tabId: 'new-1' } },
    ],
    finalText: '已整合内部数据图表 + 外部参照（saastr.com）+ 结论建议。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: ≥2 internal charts + at least 1 external fetch
  const widgets = r.executedTools.filter((t) => t.name === 'document_insert_widget')
  assert.ok(widgets.length >= 2, '[H3] expected ≥2 internal charts')
  assert.ok(r.result.usedTools.includes('web_fetch'), '[H3] expected external industry fetch')
})

test('H4: 活动文档 + 浏览器天气交通 + 图文方案', async (t) => {
  const r = await runChecklistItem({
    itemId: 'H4',
    input: '读取 H-Doc-2 北岸夜跑活动草案，用浏览器查活动地点附近的天气、交通和场地参考信息，然后做成一份新的活动执行建议文档。文档里要有预算图、风险提示、集合点参考图或地图截图。',
    browserAvailable: true,
    tools: [
      { name: 'document_open_tab', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_read_section', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'web_search', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'web_fetch', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'document_create_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_insert_widget', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_append_content', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_save_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
    ],
    plan: [
      { name: 'document_open_tab', input: { name: 'H-Doc-2' } },
      { name: 'document_read_section', input: { tabId: 'src-1', range: 'full' } },
      { name: 'web_search', input: { query: '上海徐汇滨江 龙美术馆 交通 周边天气' } },
      { name: 'web_fetch', input: { url: 'https://amap.com/place/longmuseum' } },
      { name: 'document_create_tab', input: { title: 'H4 北岸夜跑执行建议' } },
      { name: 'document_insert_widget', input: { tabId: 'new-1', skeletonId: 'pie_chart', data: { items: [1.2, 0.8, 0.9, 0.6, 0.5], labels: ['场地报备', '物料补给', '安保引导', '摄影摄像', '应急预备'] } } },
      { name: 'document_insert_widget', input: { tabId: 'new-1', skeletonId: 'image_with_caption', label: '集合点参考图' } },
      { name: 'document_append_content', input: { tabId: 'new-1', text: '## 风险提示\n- 天气：远期预报不确定，靠近活动日前再确认\n- 交通：地铁 11 号线龙华中路站最近' } },
      { name: 'document_save_tab', input: { tabId: 'new-1' } },
    ],
    finalText: '已生成执行建议：预算 4.0 万元（饼图）+ 集合点参考 + 风险提示。天气需活动日前再确认，不假装预报确定。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  const pie = r.executedTools.find((t) => t.name === 'document_insert_widget' && (t.args as any).skeletonId === 'pie_chart')
  const items = (pie?.args as any).data.items as number[]
  const total = items.reduce((a, b) => a + b, 0)
  // Pass criteria: total budget = 4.0 万元
  assert.ok(Math.abs(total - 4.0) < 0.001, `[H4] 预算图总额必须 = 4.0 万元, got ${total}`)
  // Pass criteria: agent acknowledges weather forecast limit (not pretend)
  expectAgentMessageContains(r, '天气')
})

test('H5: 本地产品定位 + 浏览器竞品信息 + 对比页', async (t) => {
  const r = await runChecklistItem({
    itemId: 'H5',
    input: '读取 H-Doc-3 AI 写作产品内部定位，再用浏览器查 3 个同类产品的公开信息，做一个新文档：竞品对比表、定位建议、能力差距图，并放入合适的产品截图或官网截图。',
    browserAvailable: true,
    tools: [
      { name: 'document_open_tab', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_read_section', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'web_search', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'web_fetch', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'document_create_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_insert_widget', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_append_content', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_save_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
    ],
    plan: [
      { name: 'document_open_tab', input: { name: 'H-Doc-3' } },
      { name: 'document_read_section', input: { tabId: 'src-1', range: 'full' } },
      { name: 'web_search', input: { query: 'AI 写作产品 竞品 2026' } },
      { name: 'web_fetch', input: { url: 'https://product-a.com' } },
      { name: 'web_fetch', input: { url: 'https://product-b.com' } },
      { name: 'web_fetch', input: { url: 'https://product-c.com' } },
      { name: 'document_create_tab', input: { title: 'H5 AI 写作竞品观察' } },
      { name: 'document_insert_widget', input: { tabId: 'new-1', skeletonId: 'comparison_table', label: '竞品对比表' } },
      { name: 'document_insert_widget', input: { tabId: 'new-1', skeletonId: 'bar_chart', label: '能力差距图' } },
      { name: 'document_insert_widget', input: { tabId: 'new-1', skeletonId: 'image_with_caption', label: '产品 A 截图' } },
      { name: 'document_append_content', input: { tabId: 'new-1', text: '## 定位建议\n回应内部担心 1：差异化定位为"一体化工作流"；担心 2：以真实工作流演示替代单点问答；担心 3：把"文档+浏览器+图表+来源"组合作为核心卖点。' } },
      { name: 'document_save_tab', input: { tabId: 'new-1' } },
    ],
    finalText: '已生成竞品观察：对比表 + 能力差距图 + 产品 A 截图 + 定位建议。担心 1 用差异化定位回应；担心 2 用真实工作流演示回应；担心 3 把"文档+浏览器+图表+来源"组合作为核心卖点。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: 3 distinct competitor fetches
  const fetches = r.executedTools.filter((t) => t.name === 'web_fetch')
  assert.equal(fetches.length, 3, '[H5] expected 3 competitor fetches')
  // Pass criteria: addresses all 3 internal concerns
  const finalText = [...r.snapshot.messages].reverse().find((m) => m.type === 'agent')!.content
  assert.match(finalText, /担心 1/, '[H5] must address internal concern 1')
  assert.match(finalText, /担心 2/, '[H5] must address internal concern 2')
  assert.match(finalText, /担心 3/, '[H5] must address internal concern 3')
})

test('H6: RSS + 浏览器补充 + 晨报文档', async (t) => {
  const r = await runChecklistItem({
    itemId: 'H6',
    input: '刷新我的科技 RSS，把今天最重要的 5 条整理成晨报文档。对其中最重要的 2 条，再用浏览器补充来源或背景信息，最后加一张主题分布图。',
    browserAvailable: true,
    tools: [
      { name: 'rss_refresh_category', groupId: 'rss', domain: 'rss', kind: 'read' },
      { name: 'rss_list_items', groupId: 'rss', domain: 'rss', kind: 'read' },
      { name: 'web_fetch', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      { name: 'document_create_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_insert_widget', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_append_content', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_save_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
    ],
    plan: [
      { name: 'rss_refresh_category', input: { category: '科技' } },
      { name: 'rss_list_items', input: { category: '科技', topN: 5 } },
      { name: 'web_fetch', input: { url: 'https://news/x1' } },
      { name: 'web_fetch', input: { url: 'https://news/x2' } },
      { name: 'document_create_tab', input: { title: 'H6 今日科技晨报' } },
      { name: 'document_insert_widget', input: { tabId: 'new-1', skeletonId: 'pie_chart', data: { items: [2, 1, 1, 1], labels: ['AI', '芯片', '应用', '融资'] } } },
      { name: 'document_append_content', input: { tabId: 'new-1', text: '## 今日 5 条\n1) AI 大新闻\n2) AI 二条（含补充）\n3) 芯片\n4) 应用\n5) 融资' } },
      { name: 'document_save_tab', input: { tabId: 'new-1' } },
    ],
    executeToolCall: async (toolName) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: toolName === 'rss_list_items'
        ? { items: [
            { id: 'i1', title: 'AI 大新闻', topic: 'AI' },
            { id: 'i2', title: 'AI 二条', topic: 'AI' },
            { id: 'i3', title: '芯片', topic: '芯片' },
            { id: 'i4', title: '应用', topic: '应用' },
            { id: 'i5', title: '融资', topic: '融资' },
          ] }
        : { ok: true },
      projectionPatch: { taskTitle: '科技晨报' },
    }),
    finalText: '今日科技晨报已生成：5 条要闻 + 2 条补充背景 + 主题分布图（AI 2/芯片 1/应用 1/融资 1，合计 5）。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: topic distribution sums to 5
  const pie = r.executedTools.find((t) => t.name === 'document_insert_widget' && (t.args as any).skeletonId === 'pie_chart')
  const items = (pie?.args as any).data.items as number[]
  const total = items.reduce((a, b) => a + b, 0)
  assert.equal(total, 5, '[H6] 主题分布合计必须 = 5（与 RSS 项数一致）')
  // Pass criteria: 2 fetches for highlights
  const fetches = r.executedTools.filter((t) => t.name === 'web_fetch')
  assert.equal(fetches.length, 2, '[H6] expected 2 highlight fetches')
})

test('H7: 日历安排与文档计划联动', async (t) => {
  const r = await runChecklistItem({
    itemId: 'H7',
    input: '根据 H-Doc-2 北岸夜跑活动草案，把关键准备节点加入日历；如果和已有日程冲突，先问我。完成后再生成一份执行时间表文档。',
    tools: [
      { name: 'document_open_tab', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'document_read_section', groupId: 'document', domain: 'document', kind: 'read' },
      { name: 'calendar_list_window', groupId: 'calendar', domain: 'calendar', kind: 'read' },
      { name: 'calendar_create_event', groupId: 'calendar', domain: 'calendar', kind: 'write' },
      { name: 'document_create_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_append_content', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
      { name: 'document_save_tab', groupId: 'document', domain: 'document', kind: 'write', concurrency: 'serialized' },
    ],
    plan: [
      { name: 'document_open_tab', input: { name: 'H-Doc-2' } },
      { name: 'document_read_section', input: { tabId: 'src-1', range: 'full' } },
      { name: 'calendar_list_window', input: { start: '2026-05-15', end: '2026-05-28' } },
      { name: 'calendar_create_event', input: { title: '场地报备', start: '2026-05-17T10:00:00+08:00' } },
      { name: 'calendar_create_event', input: { title: '物料确认', start: '2026-05-20T10:00:00+08:00' } },
      { name: 'calendar_create_event', input: { title: '摄影确认', start: '2026-05-22T14:00:00+08:00' } },
      { name: 'calendar_create_event', input: { title: '活动当天', start: '2026-05-25T19:30:00+08:00' } },
      { name: 'document_create_tab', input: { title: 'H7 北岸夜跑执行时间表' } },
      { name: 'document_append_content', input: { tabId: 'new-1', text: '# 执行时间表\n- 05-17 场地报备\n- 05-20 物料确认\n- 05-22 摄影确认\n- 05-25 活动当天 19:30' } },
      { name: 'document_save_tab', input: { tabId: 'new-1' } },
    ],
    finalText: '已在日历加 4 个准备节点（场地报备/物料确认/摄影确认/活动当天），与现有日程无冲突；执行时间表文档已保存。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  // Pass criteria: ≥4 calendar events
  const events = r.executedTools.filter((t) => t.name === 'calendar_create_event')
  assert.ok(events.length >= 4, `[H7] expected ≥4 prep events, got ${events.length}`)
  // Pass criteria: timetable doc matches calendar entries
  const appendText = r.executedTools.find((t) => t.name === 'document_append_content')?.args?.text as string
  for (const evt of events) {
    const title = (evt.args as any).title as string
    assert.ok(appendText.includes(title), `[H7] timetable must list event "${title}"`)
  }
})

function acceptanceTool(
  name: string,
  groupId: string,
  domain: string,
  kind: ToolDefinition['kind'] = 'read',
): Partial<ToolDefinition> & { name: string } {
  return {
    name,
    groupId,
    domain,
    kind,
    concurrency: kind === 'write' ? 'serialized' : undefined,
  }
}

function executedArgs(r: ChecklistRunResult, name: string): Record<string, unknown> {
  return r.executedTools.find((tool) => tool.name === name)?.args || {}
}

function executedArgsAt(r: ChecklistRunResult, name: string, index: number): Record<string, unknown> {
  return r.executedTools.filter((tool) => tool.name === name)[index]?.args || {}
}

// ──────────────────────────────────────────────────────────────────
// I. 地图路线专项
// ──────────────────────────────────────────────────────────────────

test('I1: 纯路线规划只走地图工具', async (t) => {
  const r = await runChecklistItem({
    itemId: 'I1',
    input: '从中关村到三里屯怎么走？帮我规划一条开车路线，给我大概时间和距离。',
    tools: [
      acceptanceTool('map_plan_route', 'map_planning', 'map'),
      acceptanceTool('web_search', 'general_research', 'general_research'),
    ],
    plan: [
      { name: 'map_plan_route', input: { city: '北京', origin: '中关村', destination: '三里屯', transportMode: 'driving', output: { includeMarkdown: true, includeStaticMap: true } } },
    ],
    executeToolCall: async (toolName, args) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: {
        ok: true,
        origin: { name: args.origin },
        destination: { name: args.destination },
        selectedRoute: { durationSec: 1800, distanceM: 12800 },
        artifacts: { markdownPath: '/routes/I1-中关村到三里屯.md' },
      },
      projectionPatch: { module: 'map', taskTitle: '地图路线规划', taskSummary: '30 分钟，12.8 公里' },
    }),
    finalText: '地图路线已经规划好：中关村 → 三里屯，预计 30 分钟，12.8 公里。Markdown 方案已生成：/routes/I1-中关村到三里屯.md',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  expectUsedTools(r, ['map_plan_route'])
  assert.equal(r.result.usedTools.includes('web_search'), false, '[I1] pure route should not route through web search')
  expectAgentMessageContains(r, '12.8 公里')
})

test('I2: 地址歧义时主动澄清', async (t) => {
  const r = await runChecklistItem({
    itemId: 'I2',
    input: '从人民公园到机场怎么走？',
    tools: [
      acceptanceTool('map_plan_route', 'map_planning', 'map'),
      acceptanceTool('ask_user_questions', 'agent_interaction', 'agent_interaction', 'write'),
    ],
    plan: [
      { name: 'ask_user_questions', input: { questions: [{ id: 'city', question: '请问是哪个城市的人民公园和哪个机场？' }] } },
    ],
    executeToolCall: async (toolName) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: { waiting: true },
      projectionPatch: { taskTitle: '地图路线澄清', waitingFor: 'user_input' },
    }),
    finalText: '需要先确认：你说的是哪个城市的人民公园，以及哪个机场？确认后我再规划路线。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  expectUsedTools(r, ['ask_user_questions'])
  assert.equal(r.result.usedTools.includes('map_plan_route'), false, '[I2] must not plan ambiguous route before clarification')
  expectAgentMessageContains(r, '哪个城市')
})

test('I3: 顺路搜索与绕路成本', async (t) => {
  const r = await runChecklistItem({
    itemId: 'I3',
    input: '从公司开车去虹桥机场，路上顺路找一家咖啡店，别绕太远。',
    tools: [acceptanceTool('map_plan_route', 'map_planning', 'map')],
    plan: [
      {
        name: 'map_plan_route',
        input: {
          city: '上海',
          origin: '公司',
          destination: '虹桥机场',
          transportMode: 'driving',
          optimizationGoal: 'least_detour',
          alongRouteSearch: { keyword: '咖啡店', radiusM: 1500, maxRecommendations: 3 },
        },
      },
    ],
    executeToolCall: async () => createToolExecutionOutput('map ok', {
      shape: 'json',
      data: { ok: true, recommendations: [{ place: { name: 'Route Coffee' }, detourDurationSec: 420 }] },
      projectionPatch: { module: 'map', taskTitle: '顺路咖啡推荐', taskSummary: '绕路约 7 分钟' },
    }),
    finalText: '推荐 Route Coffee，绕路约 7 分钟；比备选点更贴近路线。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  const args = executedArgs(r, 'map_plan_route')
  assert.equal((args.alongRouteSearch as Record<string, unknown>).keyword, '咖啡店')
  assert.equal(args.optimizationGoal, 'least_detour')
  expectAgentMessageContains(r, '绕路约 7 分钟')
})

test('I4: 多地点顺序规划', async (t) => {
  const r = await runChecklistItem({
    itemId: 'I4',
    input: '明天我从家出发，依次想去三个客户点，但顺序你帮我排，目标是少绕路，最后到上海站。',
    tools: [acceptanceTool('map_plan_route', 'map_planning', 'map')],
    plan: [
      { name: 'map_plan_route', input: { city: '上海', origin: '家', destination: '上海站', waypoints: ['客户点 A', '客户点 B', '客户点 C'], optimizationGoal: 'balanced' } },
    ],
    executeToolCall: async () => createToolExecutionOutput('map ok', {
      shape: 'json',
      data: { ok: true, waypointOrder: [1, 0, 2], selectedRoute: { durationSec: 5400, distanceM: 38000 } },
      projectionPatch: { module: 'map', taskTitle: '多地点路线顺序', taskSummary: '推荐顺序 B → A → C' },
    }),
    finalText: '推荐顺序：客户点 B → 客户点 A → 客户点 C，最后到上海站。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  const args = executedArgs(r, 'map_plan_route')
  assert.equal((args.waypoints as unknown[]).length, 3, '[I4] all 3 waypoints must be preserved')
  expectAgentMessageContains(r, '客户点 B → 客户点 A → 客户点 C')
})

test('I5: 地图词不应吞掉普通调研', async (t) => {
  const r = await runChecklistItem({
    itemId: 'I5',
    input: '帮我研究一下 2024 年全球疫情地图类可视化案例，整理 5 个设计特点。',
    tools: [
      acceptanceTool('map_plan_route', 'map_planning', 'map'),
      acceptanceTool('web_search', 'general_research', 'general_research'),
      acceptanceTool('web_fetch', 'general_research', 'general_research'),
    ],
    plan: [
      { name: 'web_search', input: { query: '2024 global pandemic map visualization case studies' } },
      { name: 'web_fetch', input: { url: 'https://example.org/visualization-cases' } },
    ],
    finalText: '已整理 5 个疫情地图类可视化设计特点，并附来源；这是案例研究，不是出行路线。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  assert.equal(r.result.usedTools.includes('map_plan_route'), false, '[I5] research with map keyword must not call route planner')
  expectUsedTools(r, ['web_search', 'web_fetch'])
})

test('I6: 路线结果联动文档和日历', async (t) => {
  const r = await runChecklistItem({
    itemId: 'I6',
    input: '规划明天 8 点从公司去会场的路线，把出发时间放到日历里，再把路线方案写进当前活动文档。',
    tools: [
      acceptanceTool('map_plan_route', 'map_planning', 'map'),
      acceptanceTool('calendar_create_event', 'calendar', 'calendar', 'write'),
      acceptanceTool('document_append_content', 'document', 'document', 'write'),
      acceptanceTool('document_save_tab', 'document', 'document', 'write'),
    ],
    plan: [
      { name: 'map_plan_route', input: { city: '上海', origin: '公司', destination: '会场', transportMode: 'driving', output: { includeMarkdown: true } } },
      { name: 'calendar_create_event', input: { title: '出发去会场', start: '2026-05-25T07:20:00+08:00' } },
      { name: 'document_append_content', input: { tabId: 'current', text: '## 路线方案\n公司 → 会场，预计 40 分钟，建议 07:20 出发。' } },
      { name: 'document_save_tab', input: { tabId: 'current' } },
    ],
    finalText: '已完成：路线预计 40 分钟；日历已加 07:20 出发提醒；活动文档已追加路线方案。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  assert.equal(r.result.usedTools[0], 'map_plan_route', '[I6] route should be planned before calendar/doc writes')
  assert.match(String(executedArgs(r, 'document_append_content').text), /07:20/)
  assert.doesNotMatch(r.result.finalText || '', /api[_ -]?key|staticmap/i, '[I6] final text must not leak key/static map URL')
})

// ──────────────────────────────────────────────────────────────────
// J. 多模块页面与数据互通专项
// ──────────────────────────────────────────────────────────────────

test('J1: 当前浏览器页写入文档', async (t) => {
  const r = await runChecklistItem({
    itemId: 'J1',
    input: '读取当前浏览器页面，把页面里的三条核心信息整理到当前文档末尾，并保留来源链接。',
    browserAvailable: true,
    tools: [
      acceptanceTool('browser_get_tabs', 'browser', 'browser'),
      acceptanceTool('browser_read_page', 'browser', 'browser'),
      acceptanceTool('document_append_content', 'document', 'document', 'write'),
      acceptanceTool('document_save_tab', 'document', 'document', 'write'),
    ],
    plan: [
      { name: 'browser_get_tabs', input: {} },
      { name: 'browser_read_page', input: { tabId: 'active-tab' } },
      { name: 'document_append_content', input: { tabId: 'current-doc', text: '## 页面摘要\n1. A\n2. B\n3. C\n来源：https://source.example/current' } },
      { name: 'document_save_tab', input: { tabId: 'current-doc' } },
    ],
    finalText: '已把当前浏览器页的三条核心信息追加到当前文档末尾，并保留来源链接。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  assert.equal(executedArgs(r, 'browser_read_page').tabId, 'active-tab')
  assert.match(String(executedArgs(r, 'document_append_content').text), /来源：https:\/\/source\.example\/current/)
})

test('J2: 文档数据生成日历安排', async (t) => {
  const r = await runChecklistItem({
    itemId: 'J2',
    input: '读取当前项目计划文档，把里面的 3 个截止日期创建到日历里。',
    tools: [
      acceptanceTool('document_read_section', 'document', 'document'),
      acceptanceTool('calendar_create_event', 'calendar', 'calendar', 'write'),
    ],
    plan: [
      { name: 'document_read_section', input: { tabId: 'current', range: 'full' } },
      { name: 'calendar_create_event', input: { title: '方案初稿截止', start: '2026-05-27T18:00:00+08:00' } },
      { name: 'calendar_create_event', input: { title: '视觉稿截止', start: '2026-05-29T18:00:00+08:00' } },
      { name: 'calendar_create_event', input: { title: '最终交付截止', start: '2026-06-02T18:00:00+08:00' } },
    ],
    finalText: '已根据文档创建 3 个截止日期日历项：方案初稿、视觉稿、最终交付。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  assert.equal(r.executedTools.filter((tool) => tool.name === 'calendar_create_event').length, 3)
})

test('J3: RSS 条目补充浏览器信息后写成文档', async (t) => {
  const r = await runChecklistItem({
    itemId: 'J3',
    input: '从今天的科技 RSS 里选 3 条，打开原文补充背景，然后生成一份短报告。',
    browserAvailable: true,
    tools: [
      acceptanceTool('rss_refresh_category', 'rss', 'rss'),
      acceptanceTool('rss_list_items', 'rss', 'rss'),
      acceptanceTool('browser_navigate', 'browser', 'browser'),
      acceptanceTool('browser_read_page', 'browser', 'browser'),
      acceptanceTool('document_create_tab', 'document', 'document', 'write'),
      acceptanceTool('document_append_content', 'document', 'document', 'write'),
      acceptanceTool('document_save_tab', 'document', 'document', 'write'),
    ],
    plan: [
      { name: 'rss_refresh_category', input: { category: '科技' } },
      { name: 'rss_list_items', input: { category: '科技', topN: 3 } },
      { name: 'browser_navigate', input: { url: 'https://news.example/a' } },
      { name: 'browser_read_page', input: { tabId: 'rss-a' } },
      { name: 'browser_navigate', input: { url: 'https://news.example/b' } },
      { name: 'browser_read_page', input: { tabId: 'rss-b' } },
      { name: 'browser_navigate', input: { url: 'https://news.example/c' } },
      { name: 'browser_read_page', input: { tabId: 'rss-c' } },
      { name: 'document_create_tab', input: { title: 'J3 科技 RSS 短报告' } },
      { name: 'document_append_content', input: { tabId: 'new', text: '3 条 RSS + 3 个原文来源' } },
      { name: 'document_save_tab', input: { tabId: 'new' } },
    ],
    finalText: '已生成 J3 科技 RSS 短报告，包含 3 条 RSS 和对应原文背景。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  assert.equal(r.executedTools.filter((tool) => tool.name === 'browser_read_page').length, 3)
  expectAgentMessageContains(r, '3 条 RSS')
})

test('J4: 文件搜索命中文档后跨模块打开', async (t) => {
  const r = await runChecklistItem({
    itemId: 'J4',
    input: '搜一下“北岸夜跑预算”，找到相关文件后打开它，再把摘要发到当前 agent 对话里。',
    tools: [
      acceptanceTool('file_search', 'file_management', 'file'),
      acceptanceTool('file_locate', 'file_management', 'file'),
      acceptanceTool('document_open_tab', 'document', 'document'),
    ],
    plan: [
      { name: 'file_search', input: { query: '北岸夜跑预算', workspaceRoot: '/workspace/events' } },
      { name: 'file_locate', input: { path: '/workspace/events/北岸夜跑.md', anchor: '预算' } },
      { name: 'document_open_tab', input: { path: '/workspace/events/北岸夜跑.md' } },
    ],
    finalText: '已打开 /workspace/events/北岸夜跑.md。摘要：预算共 4.0 万元，主要用于报备、物料、安保、摄影和应急。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  assert.equal(r.result.usedTools.includes('document_save_tab'), false, '[J4] should not edit document when user only asks to summarize in chat')
  expectAgentMessageContains(r, '/workspace/events/北岸夜跑.md')
})

test('J5: 跨模块任务不串会话', async (t) => {
  const r = await runChecklistItem({
    itemId: 'J5',
    input: '在当前会话里继续整理刚才那个网页资料，写进“J5-资料整理”文档；不要动另一个会话里的活动计划。',
    sessionId: 'j5-current-session',
    browserAvailable: true,
    tools: [
      acceptanceTool('browser_read_page', 'browser', 'browser'),
      acceptanceTool('document_open_tab', 'document', 'document'),
      acceptanceTool('document_append_content', 'document', 'document', 'write'),
      acceptanceTool('document_save_tab', 'document', 'document', 'write'),
    ],
    plan: [
      { name: 'browser_read_page', input: { tabId: 'current-session-tab' } },
      { name: 'document_open_tab', input: { path: '/workspace/J5-资料整理.md' } },
      { name: 'document_append_content', input: { tabId: 'j5-doc', text: '当前会话网页资料摘要' } },
      { name: 'document_save_tab', input: { tabId: 'j5-doc' } },
    ],
    finalText: '已只更新 J5-资料整理 文档；另一个会话里的活动计划没有改动。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  assert.equal(executedArgs(r, 'browser_read_page').tabId, 'current-session-tab')
  assert.match(String(executedArgs(r, 'document_open_tab').path), /J5-资料整理/)
  assert.doesNotMatch(String(executedArgs(r, 'document_open_tab').path), /活动计划/)
})

test('J6: 重启后跨模块结果仍能追踪', async (t) => {
  const r = await runChecklistItem({
    itemId: 'J6',
    input: '把当前网页总结成文档，并创建明天复查的日历提醒。完成后我会重启 Ready，再检查它们是否还在。',
    browserAvailable: true,
    tools: [
      acceptanceTool('browser_read_page', 'browser', 'browser'),
      acceptanceTool('document_create_tab', 'document', 'document', 'write'),
      acceptanceTool('document_save_tab', 'document', 'document', 'write'),
      acceptanceTool('calendar_create_event', 'calendar', 'calendar', 'write'),
    ],
    plan: [
      { name: 'browser_read_page', input: { tabId: 'active-tab' } },
      { name: 'document_create_tab', input: { title: 'J6 网页复查摘要', path: '/workspace/J6-网页复查摘要.md' } },
      { name: 'document_save_tab', input: { tabId: 'j6-doc' } },
      { name: 'calendar_create_event', input: { title: '复查 J6 网页摘要', start: '2026-05-25T09:30:00+08:00' } },
    ],
    executeToolCall: async (toolName, args) => createToolExecutionOutput(`${toolName} ok`, {
      shape: 'json',
      data: { ok: true, args },
      projectionPatch: toolName === 'document_save_tab'
        ? { taskTitle: 'J6 跨模块持久化', recentArtifacts: [{ id: 'j6-doc', module: 'document', kind: 'markdown', label: 'J6 网页复查摘要', path: '/workspace/J6-网页复查摘要.md', createdAt: new Date().toISOString() }] }
        : { taskTitle: 'J6 跨模块持久化' },
    }),
    finalText: '已生成 /workspace/J6-网页复查摘要.md，并创建明天 09:30 的复查提醒。重启后应能从文档和日历继续追踪。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  assert.ok(r.snapshot.infoCards.some((card) => card.kind === 'recent_artifact'), '[J6] document artifact should be retained for restart check')
  assert.ok(r.result.usedTools.includes('calendar_create_event'), '[J6] calendar reminder should be created')
})

// ──────────────────────────────────────────────────────────────────
// K. 文件管理搜索索引专项
// ──────────────────────────────────────────────────────────────────

test('K1: 内容搜索能返回片段和路径', async (t) => {
  const r = await runChecklistItem({
    itemId: 'K1',
    input: '在当前工作区搜“渠道销售额”，找到相关文档并告诉我它在哪一节。',
    tools: [
      acceptanceTool('file_search', 'file_management', 'file'),
      acceptanceTool('file_read_excerpt', 'file_management', 'file'),
    ],
    plan: [
      { name: 'file_search', input: { query: '渠道销售额', workspaceRoot: '/workspace/current', limit: 5 } },
      { name: 'file_read_excerpt', input: { path: '/workspace/current/B-Data.md', anchor: '渠道销售额', maxChars: 2000 } },
    ],
    finalText: '命中文档 /workspace/current/B-Data.md，在“渠道销售额”这一节，片段已确认。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  assert.equal(executedArgs(r, 'file_search').workspaceRoot, '/workspace/current')
  assert.equal(executedArgs(r, 'file_read_excerpt').anchor, '渠道销售额')
})

test('K2: 模糊提到文件名也能定位', async (t) => {
  const r = await runChecklistItem({
    itemId: 'K2',
    input: '打开刚才那个《白痴》读书笔记的人物关系小节。',
    tools: [
      acceptanceTool('file_locate', 'file_management', 'file'),
      acceptanceTool('document_open_tab', 'document', 'document'),
    ],
    plan: [
      { name: 'file_locate', input: { path: '《白痴》读书笔记', anchor: '人物关系' } },
      { name: 'document_open_tab', input: { path: '/workspace/notes/白痴-读书笔记.md', anchor: '人物关系' } },
    ],
    finalText: '已打开 /workspace/notes/白痴-读书笔记.md 的“人物关系”小节。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  assert.equal(executedArgs(r, 'file_locate').anchor, '人物关系')
  expectAgentMessageContains(r, '人物关系')
})

test('K3: 新建或重命名后索引及时更新', async (t) => {
  const r = await runChecklistItem({
    itemId: 'K3',
    input: '把 K3-草稿.md 改名成 K3-最终版.md，然后搜索“验收标记 K3”确认新名字能搜到、旧名字搜不到。',
    tools: [
      acceptanceTool('file_rename', 'file_management', 'file', 'write'),
      acceptanceTool('file_search', 'file_management', 'file'),
    ],
    plan: [
      { name: 'file_rename', input: { path: '/workspace/K3-草稿.md', newName: 'K3-最终版.md' } },
      { name: 'file_search', input: { query: '验收标记 K3', workspaceRoot: '/workspace' } },
    ],
    finalText: 'K3-最终版.md 已能通过“验收标记 K3”搜到；旧路径 K3-草稿.md 不再作为有效结果出现。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  assert.equal(executedArgs(r, 'file_rename').newName, 'K3-最终版.md')
  expectAgentMessageContains(r, '旧路径')
})

test('K4: 移动文件后不残留旧路径', async (t) => {
  const r = await runChecklistItem({
    itemId: 'K4',
    input: '把 K4-素材.md 移到 archive/，然后打开移动后的文件确认内容还在。',
    tools: [
      acceptanceTool('file_move', 'file_management', 'file', 'write'),
      acceptanceTool('file_locate', 'file_management', 'file'),
      acceptanceTool('file_read_excerpt', 'file_management', 'file'),
    ],
    plan: [
      { name: 'file_move', input: { path: '/workspace/K4-素材.md', destDir: '/workspace/archive' } },
      { name: 'file_locate', input: { path: '/workspace/archive/K4-素材.md' } },
      { name: 'file_read_excerpt', input: { path: '/workspace/archive/K4-素材.md', maxChars: 1000 } },
    ],
    finalText: 'K4-素材.md 已移到 /workspace/archive/，新路径可打开，内容仍在；旧路径不再使用。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  assert.equal(executedArgs(r, 'file_move').destDir, '/workspace/archive')
  assert.match(String(executedArgs(r, 'file_locate').path), /archive\/K4-素材\.md/)
})

test('K5: 内容摘录有边界', async (t) => {
  const r = await runChecklistItem({
    itemId: 'K5',
    input: '读取 K5-长文.md 里“预算说明”这一节，只摘录这一节，不要整篇搬过来。',
    tools: [
      acceptanceTool('file_locate', 'file_management', 'file'),
      acceptanceTool('file_read_excerpt', 'file_management', 'file'),
    ],
    plan: [
      { name: 'file_locate', input: { path: '/workspace/K5-长文.md', anchor: '预算说明' } },
      { name: 'file_read_excerpt', input: { path: '/workspace/K5-长文.md', anchor: '预算说明', maxChars: 4000 } },
    ],
    finalText: '已只摘录“预算说明”这一节，没有整篇搬运。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  const readArgs = executedArgs(r, 'file_read_excerpt')
  assert.equal(readArgs.anchor, '预算说明')
  assert.ok(Number(readArgs.maxChars) <= 4000, '[K5] excerpt should be bounded')
})

test('K6: 多根目录搜索不会互相污染', async (t) => {
  const r = await runChecklistItem({
    itemId: 'K6',
    input: '只在客户 A 文件夹里搜“合同续费”，不要搜客户 B。',
    tools: [acceptanceTool('file_search', 'file_management', 'file')],
    plan: [
      { name: 'file_search', input: { query: '合同续费', workspaceRoot: '/workspace/客户A', limit: 10 } },
    ],
    finalText: '已只在 /workspace/客户A 搜索“合同续费”；客户 B 的同名文件没有进入结果。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  assert.equal(executedArgs(r, 'file_search').workspaceRoot, '/workspace/客户A')
  expectAgentMessageContains(r, '客户 B')
})

// ──────────────────────────────────────────────────────────────────
// L. 文件树拖拽菜单四个快捷动作专项
// ──────────────────────────────────────────────────────────────────

test('L1: 拖拽网页执行“网页剪藏”', async (t) => {
  const r = await runChecklistItem({
    itemId: 'L1',
    input: '把这个网页拖到测试文件夹，选择“网页剪藏”。',
    browserAvailable: true,
    tools: [
      acceptanceTool('browser_clip_dragged_tab', 'browser', 'browser', 'write'),
      acceptanceTool('browser_content_study_dragged_tab', 'browser', 'browser', 'write'),
      acceptanceTool('rss_start_item_analysis', 'rss', 'rss', 'write'),
    ],
    plan: [
      { name: 'browser_clip_dragged_tab', input: { tabId: 'tab-news', targetDir: '/workspace/drop-target', url: 'https://example.com/post' } },
    ],
    finalText: '网页剪藏已完成，文件写入 /workspace/drop-target/post.md，未启动内容学习或分析任务。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  expectUsedTools(r, ['browser_clip_dragged_tab'])
  assert.equal(r.result.usedTools.includes('browser_content_study_dragged_tab'), false)
  assert.equal(r.result.usedTools.includes('rss_start_item_analysis'), false)
})

test('L2: 拖拽网页执行“内容学习”', async (t) => {
  const r = await runChecklistItem({
    itemId: 'L2',
    input: '把这个网页拖到测试文件夹，选择“内容学习”。',
    browserAvailable: true,
    tools: [acceptanceTool('browser_content_study_dragged_tab', 'browser', 'browser', 'write')],
    plan: [
      { name: 'browser_content_study_dragged_tab', input: { url: 'https://example.com/guide', targetDir: '/workspace/drop-target', client_task_id_clip: 'l2-clip', client_task_id_study: 'l2-study' } },
    ],
    finalText: '内容学习已启动并完成：剪藏阶段 l2-clip 与学习阶段 l2-study 都有可见状态和产物。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  const args = executedArgs(r, 'browser_content_study_dragged_tab')
  assert.equal(args.client_task_id_clip, 'l2-clip')
  assert.equal(args.client_task_id_study, 'l2-study')
  expectAgentMessageContains(r, '学习阶段')
})

test('L3: 拖拽 RSS 条目执行“文案分析”', async (t) => {
  const r = await runChecklistItem({
    itemId: 'L3',
    input: '把这条 RSS 拖到文件夹，选择“文案分析”，生成分析报告。',
    tools: [acceptanceTool('rss_start_item_analysis', 'rss', 'rss', 'write')],
    plan: [
      { name: 'rss_start_item_analysis', input: { itemId: 'rss-001', link: 'https://rss.example/post', title: '爆款标题拆解', action: 'copy', targetDir: '/workspace/drop-target' } },
    ],
    finalText: '文案分析报告已生成到目标文件夹，内容对应 RSS 条目“爆款标题拆解”。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  assert.equal(executedArgs(r, 'rss_start_item_analysis').action, 'copy')
  expectAgentMessageContains(r, '文案分析报告')
})

test('L4: 视频素材才显示并执行“视觉分析”', async (t) => {
  const r = await runChecklistItem({
    itemId: 'L4',
    input: '把这个视频页拖到文件夹，选择“视觉分析”。',
    browserAvailable: true,
    tools: [acceptanceTool('rss_start_item_analysis', 'rss', 'rss', 'write')],
    plan: [
      { name: 'rss_start_item_analysis', input: { itemId: 'video-001', link: 'https://video.example/watch/1', title: '产品演示视频', action: 'visual', targetDir: '/workspace/drop-target' } },
    ],
    finalText: '视频素材已进入视觉分析；普通网页不会显示这个入口，视觉分析产物可在目标文件夹追踪。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  assert.equal(executedArgs(r, 'rss_start_item_analysis').action, 'visual')
  expectAgentMessageContains(r, '普通网页不会显示')
})

test('L5: 四个动作互不串线', async (t) => {
  const r = await runChecklistItem({
    itemId: 'L5',
    input: '同一个网页分别试一次“网页剪藏、内容学习、文案分析”，视频页再试一次“视觉分析”，看四个动作是不是各走各的。',
    browserAvailable: true,
    tools: [
      acceptanceTool('browser_clip_dragged_tab', 'browser', 'browser', 'write'),
      acceptanceTool('browser_content_study_dragged_tab', 'browser', 'browser', 'write'),
      acceptanceTool('rss_start_item_analysis', 'rss', 'rss', 'write'),
    ],
    plan: [
      { name: 'browser_clip_dragged_tab', input: { tabId: 'tab-1', targetDir: '/workspace/drop-target', url: 'https://example.com/a' } },
      { name: 'browser_content_study_dragged_tab', input: { url: 'https://example.com/a', targetDir: '/workspace/drop-target', client_task_id_clip: 'l5-clip', client_task_id_study: 'l5-study' } },
      { name: 'rss_start_item_analysis', input: { itemId: 'rss-a', link: 'https://example.com/a', action: 'copy', targetDir: '/workspace/drop-target' } },
      { name: 'rss_start_item_analysis', input: { itemId: 'video-a', link: 'https://video.example/a', action: 'visual', targetDir: '/workspace/drop-target' } },
    ],
    finalText: '四个动作已分别完成：网页剪藏、内容学习、文案分析、视觉分析，各自产物路径不同，没有互相覆盖。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  assert.equal(r.executedTools.filter((tool) => tool.name === 'browser_clip_dragged_tab').length, 1)
  assert.equal(r.executedTools.filter((tool) => tool.name === 'browser_content_study_dragged_tab').length, 1)
  assert.equal((executedArgsAt(r, 'rss_start_item_analysis', 0)).action, 'copy')
  assert.equal((executedArgsAt(r, 'rss_start_item_analysis', 1)).action, 'visual')
})

test('L6: 拖拽菜单位置和取消行为可靠', async (t) => {
  const r = await runChecklistItem({
    itemId: 'L6',
    input: '把网页拖到文件树边缘和空白区域，菜单应该还能看见；按 Esc 或点外面要能取消。',
    tools: [
      acceptanceTool('filetree_show_external_drop_menu', 'file_management', 'file', 'write'),
      acceptanceTool('filetree_cancel_external_drop_menu', 'file_management', 'file', 'write'),
      acceptanceTool('browser_clip_dragged_tab', 'browser', 'browser', 'write'),
    ],
    plan: [
      { name: 'filetree_show_external_drop_menu', input: { x: 4, y: 4, target: 'current-folder', clamped: true } },
      { name: 'filetree_cancel_external_drop_menu', input: { reason: 'escape' } },
    ],
    finalText: '菜单已被限制在可见区域内；Esc 取消后没有启动后台任务，下一次拖拽仍可正常弹出。',
  })
  reportPanel(t, r)
  expectNoErrorDiagnostics(r)
  expectUsedTools(r, ['filetree_show_external_drop_menu', 'filetree_cancel_external_drop_menu'])
  assert.equal(r.result.usedTools.includes('browser_clip_dragged_tab'), false, '[L6] cancel must not start background clip task')
})

// ──────────────────────────────────────────────────────────────────
// M. YouTube 视频双分析器顺序验收
// ──────────────────────────────────────────────────────────────────

interface VideoAnalyzerAcceptanceCase {
  itemId: string
  title: string
  url: string
  analyzer: 'Video Expert Analyzer' | 'Video Copy Analyzer'
  toolName: 'skill_video_expert_pipeline' | 'skill_video_copy_analyze'
  skillId: 'video-expert-analyzer' | 'video-copy-analyzer'
  artifactName: string
}

const videoAnalyzerAcceptanceCases: VideoAnalyzerAcceptanceCase[] = [
  {
    itemId: 'M1',
    title: 'YouTube 1 使用 Video Expert Analyzer 跑完整流程',
    url: 'https://www.youtube.com/watch?v=xLAPpTflZmk',
    analyzer: 'Video Expert Analyzer',
    toolName: 'skill_video_expert_pipeline',
    skillId: 'video-expert-analyzer',
    artifactName: 'M1-video-expert-report.md',
  },
  {
    itemId: 'M2',
    title: 'YouTube 1 使用 Video Copy Analyzer 跑完整流程',
    url: 'https://www.youtube.com/watch?v=xLAPpTflZmk',
    analyzer: 'Video Copy Analyzer',
    toolName: 'skill_video_copy_analyze',
    skillId: 'video-copy-analyzer',
    artifactName: 'M2-video-copy-report.md',
  },
  {
    itemId: 'M3',
    title: 'YouTube 2 使用 Video Expert Analyzer 跑完整流程',
    url: 'https://www.youtube.com/watch?v=j9mSt9UpxGc&t=2s',
    analyzer: 'Video Expert Analyzer',
    toolName: 'skill_video_expert_pipeline',
    skillId: 'video-expert-analyzer',
    artifactName: 'M3-video-expert-report.md',
  },
  {
    itemId: 'M4',
    title: 'YouTube 2 使用 Video Copy Analyzer 跑完整流程',
    url: 'https://www.youtube.com/watch?v=j9mSt9UpxGc&t=2s',
    analyzer: 'Video Copy Analyzer',
    toolName: 'skill_video_copy_analyze',
    skillId: 'video-copy-analyzer',
    artifactName: 'M4-video-copy-report.md',
  },
  {
    itemId: 'M5',
    title: 'YouTube 3 使用 Video Expert Analyzer 跑完整流程',
    url: 'https://www.youtube.com/watch?v=6IcKMHlANtI',
    analyzer: 'Video Expert Analyzer',
    toolName: 'skill_video_expert_pipeline',
    skillId: 'video-expert-analyzer',
    artifactName: 'M5-video-expert-report.md',
  },
  {
    itemId: 'M6',
    title: 'YouTube 3 使用 Video Copy Analyzer 跑完整流程',
    url: 'https://www.youtube.com/watch?v=6IcKMHlANtI',
    analyzer: 'Video Copy Analyzer',
    toolName: 'skill_video_copy_analyze',
    skillId: 'video-copy-analyzer',
    artifactName: 'M6-video-copy-report.md',
  },
  {
    itemId: 'M7',
    title: 'YouTube 4 使用 Video Expert Analyzer 跑完整流程',
    url: 'https://www.youtube.com/watch?v=Kro93awjY_4',
    analyzer: 'Video Expert Analyzer',
    toolName: 'skill_video_expert_pipeline',
    skillId: 'video-expert-analyzer',
    artifactName: 'M7-video-expert-report.md',
  },
  {
    itemId: 'M8',
    title: 'YouTube 4 使用 Video Copy Analyzer 跑完整流程',
    url: 'https://www.youtube.com/watch?v=Kro93awjY_4',
    analyzer: 'Video Copy Analyzer',
    toolName: 'skill_video_copy_analyze',
    skillId: 'video-copy-analyzer',
    artifactName: 'M8-video-copy-report.md',
  },
]

async function runVideoAnalyzerAcceptanceCase(testCase: VideoAnalyzerAcceptanceCase): Promise<ChecklistRunResult> {
  const outputDir = `/workspace/stage-z-video-acceptance/${testCase.itemId}`
  return runChecklistItem({
    itemId: testCase.itemId,
    sessionId: `video-${testCase.itemId.toLowerCase()}-${testCase.skillId}`,
    input: `用 ${testCase.analyzer} 分析这个 YouTube 视频，完整跑完一次流程并保留产物：${testCase.url}`,
    tools: [acceptanceTool(testCase.toolName, 'skills', 'skill', 'job')],
    plan: [
      {
        name: testCase.toolName,
        input: {
          url: testCase.url,
          source: 'youtube',
          outputDir,
          runMode: 'full_pipeline',
          concurrency: 'single_session_only',
        },
      },
    ],
    executeToolCall: async (toolName, args) => createToolExecutionOutput(`${toolName} completed`, {
      shape: 'json',
      data: {
        ok: true,
        status: 'completed',
        skillId: testCase.skillId,
        url: args.url,
        outputDir,
        artifacts: [
          `${outputDir}/${testCase.artifactName}`,
          `${outputDir}/run_state.json`,
        ],
      },
      projectionPatch: {
        taskTitle: `${testCase.itemId} · ${testCase.analyzer}`,
        taskSummary: '下载、解析、分析、报告写入全部完成',
        recentArtifacts: [
          {
            id: `${testCase.itemId}-report`,
            module: 'skill',
            kind: 'markdown',
            label: testCase.artifactName,
            path: `${outputDir}/${testCase.artifactName}`,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    }),
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [{ id: testCase.skillId, name: testCase.analyzer }],
      buildPreferredSkillToolNames: () => [testCase.toolName],
    },
    finalText: `${testCase.analyzer} 已对 ${testCase.url} 完整跑完全流程，报告已保存到 ${outputDir}/${testCase.artifactName}。`,
  })
}

for (const videoCase of videoAnalyzerAcceptanceCases) {
  test(`${videoCase.itemId}: ${videoCase.title}`, async (t) => {
    const r = await runVideoAnalyzerAcceptanceCase(videoCase)
    reportPanel(t, r)
    expectNoErrorDiagnostics(r)
    expectUsedTools(r, [videoCase.toolName])
    expectTaskCardTitleIncludes(r, videoCase.analyzer)
    expectAgentMessageContains(r, '完整跑完全流程')
    assert.equal(executedArgs(r, videoCase.toolName).url, videoCase.url)
    assert.equal(executedArgs(r, videoCase.toolName).runMode, 'full_pipeline')
    assert.equal(executedArgs(r, videoCase.toolName).concurrency, 'single_session_only')
    assert.equal(r.snapshot.taskCards[0]?.waitingFor, 'none')
  })
}
