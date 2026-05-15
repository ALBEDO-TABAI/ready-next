import { describe, it } from 'node:test'
import assert from 'node:assert'

import {
  createAgentPanelSnapshot,
  diagnoseAgentPanelSnapshot,
  installAgentPanelTestHarness,
} from '../renderer/modules/agent/agentPanelTestHarness'
import type { AgentMessage, ConversationScope, ScopeRunState } from '../renderer/modules/agent/types'

type HarnessState = Parameters<typeof createAgentPanelSnapshot>[0]

const scope: ConversationScope = {
  id: 'scope-test',
  agent: 'butler',
  title: '测试会话',
  sourceKind: 'local',
  sourceId: 'app',
  threadKey: 'scope-test',
  meta: {},
  createdAt: '2026-05-14T09:00:00.000Z',
  updatedAt: '2026-05-14T09:00:00.000Z',
}

function message(input: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'type' | 'content'>): AgentMessage {
  return {
    agent: 'butler',
    timestamp: new Date('2026-05-14T09:00:01.000Z'),
    ...input,
  }
}

function run(input: Partial<ScopeRunState> = {}): ScopeRunState {
  return {
    scopeId: 'scope-test',
    agent: 'butler',
    requestId: 'req-test',
    phase: 'tool_running',
    terminalReason: null,
    toolTrace: [],
    startedAt: '2026-05-14T09:00:02.000Z',
    updatedAt: '2026-05-14T09:00:03.000Z',
    latestText: null,
    module: 'document',
    intent: 'document_update',
    executionKind: 'interactive',
    jobId: null,
    artifactRefs: [],
    memoryRefs: [],
    triggerHits: [],
    contextBudget: null,
    ownerResourceId: null,
    lastEvidenceAt: null,
    blockedReason: null,
    controllerId: null,
    ownerTabId: null,
    checkpointExpiresAt: null,
    responseMessageId: 'response-test',
    responseBuffer: '',
    responseSegmentBreakPending: false,
    responseSegmentToolTraceStart: 0,
    stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
    designPhase: null,
    designTodo: [],
    designReviewSummary: null,
    ownedNodeIds: [],
    repairScope: null,
    taskTitle: null,
    taskSummary: null,
    steps: [],
    currentStepId: null,
    waitingFor: 'none',
    resumableActions: [],
    recentArtifacts: [],
    taskContinuation: null,
    progress: null,
    memoryCapture: null,
    error: null,
    softError: null,
    ...input,
  }
}

function baseState(input: Partial<HarnessState> = {}): HarnessState {
  return {
    agents: [{ name: 'butler', displayName: '管家', status: 'idle', selected: true }],
    messages: [],
    currentAgent: 'butler',
    inputValue: '',
    currentScopeId: 'scope-test',
    currentScope: scope,
    scopes: [scope],
    scopeRunStates: {},
    toolTrace: [],
    toolTraceStatus: 'idle',
    attachments: [],
    filePool: [],
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    sendMessage: async () => ({ success: true, shouldClearInput: true, preserveInput: false }),
    setInputValue: () => {},
    ...input,
  }
}

describe('agent panel test harness', () => {
  it('captures panel-visible task cards, info cards, messages, and tool trace', () => {
    const activeRun = run({
      taskId: 'task-1',
      taskTitle: '读取文档并生成关系图',
      taskSummary: '先定位章节，再更新目标文档',
      stepMetrics: { toolCalls: 1, toolResults: 1, lastToolAt: '2026-05-14T09:00:04.000Z' },
      steps: [
        { id: 'step-1', title: '定位文件', status: 'done', updatedAt: '2026-05-14T09:00:04.000Z' },
      ],
      toolTrace: [
        { id: 'tool-1', kind: 'call', text: 'file_locate {"path":"白痴.md"}', timestamp: new Date('2026-05-14T09:00:04.000Z') },
        { id: 'tool-2', kind: 'result', text: '{"ok":true}', timestamp: new Date('2026-05-14T09:00:05.000Z') },
      ],
      progress: {
        stage: 'locate',
        completed: 1,
        total: 2,
        coverage: 0.5,
        fingerprint: 'fp-1',
        updatedAt: '2026-05-14T09:00:05.000Z',
        lastError: null,
      },
      recentArtifacts: [
        {
          id: 'artifact-1',
          module: 'document',
          kind: 'markdown',
          label: '关系图草稿',
          path: '/tmp/relation.md',
          createdAt: '2026-05-14T09:00:05.000Z',
        },
      ],
      softError: {
        message: 'file_locate retried',
        errorKind: 'recoverable_tool_error',
        toolName: 'file_locate',
        friendlyMessage: '文件定位已自动重试',
        technicalDetails: 'first attempt missed indexed basename',
        receivedAt: '2026-05-14T09:00:05.000Z',
      },
    })
    const snapshot = createAgentPanelSnapshot(baseState({
      messages: [
        message({ id: 'user-1', type: 'user', content: '根据@[白痴.md]生成关系图' }),
        message({ id: 'response-test', type: 'agent', content: '我正在定位章节。' }),
      ],
      scopeRunStates: { 'scope-test': activeRun },
      toolTraceStatus: 'running',
      foregroundBusy: true,
      composerLocked: true,
    }))

    assert.equal(snapshot.currentScopeId, 'scope-test')
    assert.equal(snapshot.messages.length, 2)
    assert.equal(snapshot.taskCards[0].title, '读取文档并生成关系图')
    assert.equal(snapshot.taskCards[0].steps[0].title, '定位文件')
    assert.equal(snapshot.toolTrace.length, 2)
    assert.equal(snapshot.runtime.activeRun?.stepMetrics.toolCalls, 1)
    assert.ok(snapshot.infoCards.some((card) => card.kind === 'soft_error'))
    assert.ok(snapshot.infoCards.some((card) => card.kind === 'recent_artifact'))
  })

  it('diagnoses send failures and unpaired tool calls with layer labels', () => {
    const snapshot = createAgentPanelSnapshot(baseState({
      messages: [
        message({ id: 'user-1', type: 'user', content: '读取文件' }),
        message({ id: 'system-1', type: 'system', content: '发送失败' }),
      ],
      scopeRunStates: {
        'scope-test': run({
          phase: 'error',
          error: '工具执行失败：file_locate path not in index',
          toolTrace: [
            { id: 'tool-1', kind: 'call', text: 'file_locate {"path":"白痴.md"}', timestamp: new Date('2026-05-14T09:00:04.000Z') },
          ],
        }),
      },
    }))
    const diagnostics = diagnoseAgentPanelSnapshot(snapshot)

    assert.ok(diagnostics.some((item) => item.id === 'send_failed_message' && item.layer === 'send'))
    assert.ok(diagnostics.some((item) => item.id === 'active_run_error' && item.layer === 'tool'))
    assert.ok(diagnostics.some((item) => item.id === 'tool_call_without_result' && item.layer === 'tool'))
  })

  it('diagnoses failed tool results even when the run later reports done', () => {
    const snapshot = createAgentPanelSnapshot(baseState({
      messages: [
        message({ id: 'user-1', type: 'user', content: '展示产物' }),
        message({ id: 'agent-1', type: 'agent', content: '已完成。' }),
      ],
      scopeRunStates: {
        'scope-test': run({
          phase: 'done',
          terminalReason: 'done',
          toolTrace: [
            { id: 'tool-1', kind: 'call', text: 'present_file(path)', timestamp: new Date('2026-05-14T09:00:04.000Z') },
            { id: 'tool-2', kind: 'result', text: 'present_file: 工具 present_file 失败：path escapes sandbox root', timestamp: new Date('2026-05-14T09:00:05.000Z') },
          ],
        }),
      },
    }))
    const diagnostics = diagnoseAgentPanelSnapshot(snapshot)

    assert.ok(diagnostics.some((item) => item.id === 'tool_result_failure' && item.layer === 'tool'))
  })

  it('diagnoses raw tool-call protocol leaked into agent messages', () => {
    const snapshot = createAgentPanelSnapshot(baseState({
      messages: [
        message({ id: 'user-1', type: 'user', content: '生成文档' }),
        message({
          id: 'response-1',
          type: 'agent',
          content: '<tool_call>\n<function=document_save_tab>\n</function>\n</tool_call>',
        }),
      ],
    }))
    const diagnostics = diagnoseAgentPanelSnapshot(snapshot)

    assert.ok(diagnostics.some((item) => item.id === 'raw_tool_call_visible' && item.layer === 'renderer'))
  })

  it('installs a forced window harness that can submit through the store fallback and record events', async () => {
    const originalWindow = (globalThis as { window?: unknown }).window
    const originalDocument = (globalThis as { document?: unknown }).document
    class FakeTextarea {
      value = ''
      focus() {}
      dispatchEvent() {
        return true
      }
    }
    let domClickCount = 0
    const fakeTextarea = new FakeTextarea()
    const fakeButton = {
      disabled: false,
      click: () => {
        domClickCount += 1
      },
    }
    const testWindow = {
      location: { search: '' },
      localStorage: { getItem: () => null },
      electronAPI: undefined,
      HTMLTextAreaElement: FakeTextarea,
    }
    ;(globalThis as { window?: unknown }).window = testWindow
    ;(globalThis as { document?: unknown }).document = {
      querySelector: (selector: string) => selector === '[data-ready-agent-input="true"]'
        ? fakeTextarea
        : fakeButton,
    }

    let state = baseState()
    const listeners = new Set<(next: HarnessState, previous: HarnessState) => void>()
    const notify = (next: HarnessState, previous: HarnessState) => {
      for (const listener of listeners) listener(next, previous)
    }
    state = {
      ...state,
      setInputValue: (value) => {
        const previous = state
        state = { ...state, inputValue: value }
        notify(state, previous)
      },
      sendMessage: async (content) => {
        const previous = state
        state = {
          ...state,
          inputValue: '',
          messages: [
            ...state.messages,
            message({ id: 'user-1', type: 'user', content }),
            message({ id: 'agent-1', type: 'agent', content: '收到，测试完成。' }),
          ],
        }
        notify(state, previous)
        return { success: true, shouldClearInput: true, preserveInput: false }
      },
    }
    const store = {
      getState: () => state,
      subscribe: (listener: (next: HarnessState, previous: HarnessState) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }

    const harness = installAgentPanelTestHarness(store, { force: true })
    assert.ok(harness)
    assert.equal((testWindow as { __READY_AGENT_TEST__?: unknown }).__READY_AGENT_TEST__, harness)

    const result = await harness.submit('模拟用户输入', { mode: 'store', waitForIdle: false })
    assert.equal(result.inputMode, 'store')
    assert.equal(result.sendResult?.success, true)
    assert.equal(result.after.messages.at(-1)?.content, '收到，测试完成。')
    assert.ok(harness.events().some((event) => event.kind === 'message_count'))

    const domFallback = await harness.submit('DOM 空点提交', { mode: 'dom', waitForIdle: false })
    assert.equal(domClickCount, 1)
    assert.equal(domFallback.inputMode, 'store')
    assert.equal(domFallback.sendResult?.success, true)

    const missingTool = await harness.submit('模拟 VEA 输入', {
      mode: 'store',
      waitForIdle: false,
      expectedToolNames: ['skill_video_expert_pipeline'],
    })
    assert.equal(missingTool.ok, false)
    assert.ok(missingTool.diagnostics.some((item) => item.id === 'expected_tool_not_called'))

    harness.dispose()
    ;(globalThis as { window?: unknown }).window = originalWindow
    ;(globalThis as { document?: unknown }).document = originalDocument
  })
})
