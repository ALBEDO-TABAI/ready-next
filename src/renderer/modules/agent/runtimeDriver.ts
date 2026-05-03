import { deriveScopeRunStatePatch, getActiveScopeRunState, isScopeRunPhase, isStreamingScopeRunState, mergeArtifacts, phaseToToolTraceStatus } from './scopeRunState'
import { persistAssistantMessage, extractAttachmentsFromMeta } from './messageComposer'
import { executeModuleToolAction, handleModuleToolAction } from './moduleExecutor'
import { cancelAllPendingWidgetWrites } from './documentActions'
import type { Agent, AgentMessage, ConversationScope, ScopeRunState } from './types'
import { useMode } from '../../stores/useMode'
import { extractSkillCommandFromText, runSkillCommand } from './commandHandlers'
import { mapBackendErrorToFriendly } from './error-message-mapping'
import { emitRendererAgentMetric } from './rendererMetrics'

interface AgentStoreLike {
  getState: () => any
  setState: (partial: any) => void
}

interface RunPayloadLike {
  sessionId?: string
  runId?: string
  agent?: string
  scopeId?: string
}

function generateResponseSegmentId(): string {
  return `response-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function buildTaskSnapshotMeta(scopeId: string, scope: ConversationScope | null, runState: ScopeRunState | null): Record<string, unknown> | undefined {
  if (!runState) return undefined
  return {
    taskSnapshot: {
      scopeId,
      agent: runState.agent,
      taskId: runState.taskId || null,
      title: scope?.title || '任务',
      taskTitle: runState.taskTitle || null,
      taskSummary: runState.taskSummary || null,
      steps: runState.steps || [],
      currentStepId: runState.currentStepId || null,
      waitingFor: runState.waitingFor || 'none',
      resumableActions: runState.resumableActions || [],
      recentArtifacts: runState.recentArtifacts || [],
      taskContinuation: runState.taskContinuation || null,
      memoryCapture: runState.memoryCapture || null,
      blockedReason: runState.blockedReason || null,
      error: runState.error || null,
      updatedAt: runState.updatedAt || new Date().toISOString(),
      responseMessageId: runState.responseMessageId || null,
      phase: runState.phase,
      terminalReason: runState.terminalReason || null,
      toolTrace: (runState.toolTrace || []).map((event) => ({
        id: event.id,
        kind: event.kind,
        text: event.text,
        timestamp: event.timestamp instanceof Date ? event.timestamp.toISOString() : String(event.timestamp),
      })),
    },
  }
}

function buildToolTraceSnapshotMeta(runState: ScopeRunState | null): Record<string, unknown> | undefined {
  if (!runState) return undefined
  const startIndex = Math.max(0, runState.responseSegmentToolTraceStart || 0)
  const toolTraceSnapshot = (runState.toolTrace || []).slice(startIndex).map((event) => ({
    id: event.id,
    kind: event.kind,
    text: event.text,
    timestamp: event.timestamp instanceof Date ? event.timestamp.toISOString() : String(event.timestamp),
  }))

  if (toolTraceSnapshot.length === 0) return undefined
  return { toolTraceSnapshot }
}

function buildResponseSegmentMeta(scopeId: string, scope: ConversationScope | null, runState: ScopeRunState | null): Record<string, unknown> | undefined {
  const taskMeta = buildTaskSnapshotMeta(scopeId, scope, runState)
  const toolMeta = buildToolTraceSnapshotMeta(runState)
  if (!taskMeta && !toolMeta) return undefined
  return {
    ...(taskMeta || {}),
    ...(toolMeta || {}),
  }
}

export function syncActiveScopeRunAliases(
  state: Pick<{ currentScopeId: string | null; scopeRunStates: Record<string, ScopeRunState> }, 'currentScopeId' | 'scopeRunStates'>,
): Pick<{ isStreaming: boolean; toolTrace: ScopeRunState['toolTrace']; toolTraceStatus: 'idle' | 'running' | 'done' | 'error' | 'cancelled' }, 'isStreaming' | 'toolTrace' | 'toolTraceStatus'> {
  const activeRunState = getActiveScopeRunState(state.scopeRunStates, state.currentScopeId)
  return {
    isStreaming: isStreamingScopeRunState(activeRunState),
    toolTrace: activeRunState?.toolTrace || [],
    toolTraceStatus: phaseToToolTraceStatus(activeRunState?.phase),
  }
}

export function createAgentRuntimeDriver(store: AgentStoreLike) {
  let listenersInitialized = false

  function upsertScopeRunState(
    scopeId: string,
    updater: (previous: ScopeRunState | null) => ScopeRunState,
  ): void {
    store.setState((state: any) => {
      const previous = state.scopeRunStates[scopeId] || null
      const produced = updater(previous)
      const hasTerminalReasonField = Object.prototype.hasOwnProperty.call(produced, 'terminalReason')
      const sameRun = Boolean(
        previous?.terminalReason &&
        previous.requestId &&
        produced.requestId &&
        previous.requestId === produced.requestId,
      )
      const next = !hasTerminalReasonField && sameRun
        ? { ...produced, terminalReason: previous.terminalReason }
        : produced
      const nextScopeRunStates = {
        ...state.scopeRunStates,
        [scopeId]: next,
      }
      return {
        scopeRunStates: nextScopeRunStates,
        ...syncActiveScopeRunAliases({
          currentScopeId: state.currentScopeId,
          scopeRunStates: nextScopeRunStates,
        }),
      }
    })
  }

  function finalizeScopeRunAfterStreamDone(scopeId: string, fallbackRunState: ScopeRunState | null): void {
    store.setState((state: any) => {
      const previous = state.scopeRunStates[scopeId] || fallbackRunState || null
      const nextScopeRunStates = previous
        ? {
          ...state.scopeRunStates,
          [scopeId]: {
            ...previous,
            scopeId,
            phase: 'done',
            terminalReason: previous.terminalReason || 'done',
            updatedAt: new Date().toISOString(),
          },
        }
        : state.scopeRunStates

      return {
        scopeRunStates: nextScopeRunStates,
        ...(state.currentScopeId === scopeId
          ? {
            streamingMessageId: null,
            streamingRequestId: null,
          }
          : {}),
        ...syncActiveScopeRunAliases({
          currentScopeId: state.currentScopeId,
          scopeRunStates: nextScopeRunStates,
        }),
      }
    })
  }

  function resolveScopeIdForRunPayload(payload: RunPayloadLike): string | null {
    if (typeof payload.scopeId === 'string' && payload.scopeId.trim()) {
      return payload.scopeId.trim()
    }
    if (typeof payload.sessionId === 'string' && payload.sessionId.trim()) {
      return payload.sessionId.trim()
    }
    if (!payload.runId) return null
    const entries = Object.entries(store.getState().scopeRunStates as Record<string, ScopeRunState>)
    for (const [scopeId, runState] of entries) {
      if (runState.requestId !== payload.runId) continue
      if (payload.agent && runState.agent !== payload.agent) continue
      return scopeId
    }
    return null
  }

  function activateWorkbenchMode(mode: 'browser' | 'document' | 'rss' | 'calendar'): void {
    const modeStore = useMode.getState()
    modeStore.setWorkbenchMode(mode)
    modeStore.setReadySubMode(mode)
  }

  async function persistAssistantMessageForRun(scopeId: string, runState: ScopeRunState | null): Promise<void> {
    if (!runState?.responseMessageId) return
    const state = store.getState()
    const currentScope = (state.scopes.find((item: ConversationScope) => item.id === scopeId) || state.currentScope || null) as ConversationScope | null
    const currentMessage = state.messages.find((item: AgentMessage) => item.id === runState.responseMessageId)
    const content = currentMessage?.content || runState.responseBuffer || ''
    const snapshotMeta = buildResponseSegmentMeta(scopeId, currentScope, runState)
    if (snapshotMeta) {
      store.setState((current: any) => ({
        messages: current.messages.map((item: AgentMessage) =>
          item.id === runState.responseMessageId
            ? { ...item, meta: { ...(item.meta || {}), ...snapshotMeta } }
            : item,
        ),
      }))
    }
    const result = await persistAssistantMessage(scopeId, runState.responseMessageId, content, currentScope, snapshotMeta)
    if (!result.success) {
      emitRendererAgentMetric('renderer_assistant_persistence_failed', {
        scopeId,
        responseMessageId: runState.responseMessageId,
        error: result.error || 'assistant persist failed',
      })
    }
  }

  function sealResponseSegment(scopeId: string, runState: ScopeRunState | null): void {
    if (!runState?.responseMessageId) return
    const state = store.getState()
    const currentScope = (state.scopes.find((item: ConversationScope) => item.id === scopeId) || state.currentScope || null) as ConversationScope | null
    const currentMessage = state.messages.find((item: AgentMessage) => item.id === runState.responseMessageId)
    const content = currentMessage?.content || runState.responseBuffer || ''
    if (!content.trim()) return
    const segmentMeta = buildResponseSegmentMeta(scopeId, currentScope, runState)
    if (segmentMeta) {
      store.setState((current: any) => ({
        messages: current.messages.map((item: AgentMessage) =>
          item.id === runState.responseMessageId
            ? { ...item, meta: { ...(item.meta || {}), ...segmentMeta } }
            : item,
        ),
      }))
    }
    void persistAssistantMessage(scopeId, runState.responseMessageId, content, currentScope, segmentMeta)
      .then((result) => {
        if (result.success) return
        emitRendererAgentMetric('renderer_assistant_persistence_failed', {
          scopeId,
          responseMessageId: runState.responseMessageId,
          error: result.error || 'assistant persist failed',
        })
      })
  }

  async function maybeAutoExecuteAssistantSkillCommand(scopeId: string, runState: ScopeRunState | null): Promise<void> {
    if (!runState?.responseMessageId) return
    const state = store.getState()
    if (state.currentScopeId !== scopeId) return
    const currentMessage = state.messages.find((item: AgentMessage) => item.id === runState.responseMessageId)
    const content = String(currentMessage?.content || runState.responseBuffer || '')
    const command = extractSkillCommandFromText(content)
    if (!command) return

    const responseIndex = state.messages.findIndex((item: AgentMessage) => item.id === runState.responseMessageId)
    const sourceMessages = responseIndex >= 0 ? state.messages.slice(0, responseIndex) : state.messages
    const latestUserWithAttachments = [...sourceMessages]
      .reverse()
      .find((item: AgentMessage) => item.type === 'user' && Array.isArray(item.attachments) && item.attachments.length > 0)
    const attachments = latestUserWithAttachments?.attachments || []

    const result = await runSkillCommand(command, attachments)
    if (!result.handled) return

    const appended = `\n\n[系统已自动执行技能命令]\n${result.text}`
    store.setState((current: any) => ({
      messages: current.messages.map((item: AgentMessage) =>
        item.id === runState.responseMessageId ? { ...item, content: `${item.content}${appended}` } : item,
      ),
      scopeRunStates: {
        ...current.scopeRunStates,
        [scopeId]: current.scopeRunStates[scopeId]
          ? {
            ...current.scopeRunStates[scopeId],
            responseBuffer: `${current.scopeRunStates[scopeId].responseBuffer || ''}${appended}`,
            latestText: result.text.slice(-500),
            updatedAt: new Date().toISOString(),
          }
          : current.scopeRunStates[scopeId],
      },
    }))
  }

  function initAgentListeners(): () => void {
    if (listenersInitialized) return () => { /* already initialized */ }
    if (typeof window === 'undefined' || !window.electronAPI) return () => { /* no electronAPI */ }

    listenersInitialized = true
    void store.getState().loadSendPreferences()

    const cleanupStream = window.electronAPI.agent.onStream((data) => {
      const scopeId = resolveScopeIdForRunPayload(data)
      if (!scopeId) return

      if (data.type === 'done') {
        const runState = store.getState().scopeRunStates[scopeId] || null
        void (async () => {
          let finalized = false
          const finalize = () => {
            finalizeScopeRunAfterStreamDone(scopeId, store.getState().scopeRunStates[scopeId] || runState)
            finalized = true
          }
          try {
            await maybeAutoExecuteAssistantSkillCommand(scopeId, runState)
            finalize()
            await persistAssistantMessageForRun(scopeId, store.getState().scopeRunStates[scopeId] || runState)
          } catch (error) {
            emitRendererAgentMetric('renderer_assistant_done_finalize_failed', {
              scopeId,
              responseMessageId: runState?.responseMessageId || null,
              error: error instanceof Error ? error.message : String(error),
            })
          } finally {
            if (!finalized) finalize()
          }
        })()
        return
      }

      if (data.type !== 'text' || !data.chunk) return

      const currentState = store.getState()
      const runState = currentState.scopeRunStates[scopeId] || null
      const previousMessage = runState?.responseMessageId
        ? currentState.messages.find((item: AgentMessage) => item.id === runState.responseMessageId) || null
        : null
      const shouldStartNewSegment = Boolean(
        runState?.responseSegmentBreakPending ||
        !runState?.responseMessageId ||
        (scopeId === currentState.currentScopeId && runState?.responseMessageId && !previousMessage),
      )

      let targetResponseMessageId = runState?.responseMessageId || null
      let nextBuffer = `${runState?.responseBuffer || ''}${data.chunk}`

      if (shouldStartNewSegment) {
        if (runState?.responseSegmentBreakPending) {
          sealResponseSegment(scopeId, runState)
        }
        targetResponseMessageId = generateResponseSegmentId()
        nextBuffer = data.chunk
        if (scopeId === currentState.currentScopeId) {
          currentState.addMessage({
            id: targetResponseMessageId,
            agent: data.agent,
            content: data.chunk,
            type: 'agent',
            timestamp: new Date(),
            meta: { transient: true },
          })
          store.setState({ streamingMessageId: targetResponseMessageId })
        }
      } else if (
        scopeId === currentState.currentScopeId &&
        targetResponseMessageId &&
        currentState.messages.some((item: AgentMessage) => item.id === targetResponseMessageId)
      ) {
        currentState.appendToMessage(targetResponseMessageId, data.chunk)
      }

      upsertScopeRunState(scopeId, (previous) => ({
        scopeId,
        agent: previous?.agent || data.agent,
        requestId: previous?.requestId || (typeof data.runId === 'string' ? data.runId : null),
        phase: previous?.phase === 'takeover' ? previous.phase : 'responding',
        toolTrace: previous?.toolTrace || [],
        startedAt: previous?.startedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        latestText: nextBuffer.slice(-500),
        module: previous?.module || null,
        intent: previous?.intent || null,
        executionKind: previous?.executionKind || null,
        jobId: previous?.jobId || null,
        artifactRefs: previous?.artifactRefs || [],
        memoryRefs: previous?.memoryRefs || [],
        triggerHits: previous?.triggerHits || [],
        contextBudget: previous?.contextBudget || null,
        ownerResourceId: previous?.ownerResourceId || null,
        lastEvidenceAt: previous?.lastEvidenceAt || null,
        blockedReason: previous?.blockedReason || null,
        controllerId: previous?.controllerId || null,
        ownerTabId: previous?.ownerTabId || null,
        checkpointExpiresAt: previous?.checkpointExpiresAt || null,
        responseMessageId: targetResponseMessageId,
        responseBuffer: nextBuffer,
        responseSegmentBreakPending: false,
        responseSegmentToolTraceStart: shouldStartNewSegment
          ? (previous?.toolTrace || []).length
          : (previous?.responseSegmentToolTraceStart ?? 0),
        stepMetrics: previous?.stepMetrics || { toolCalls: 0, toolResults: 0, lastToolAt: null },
        designPhase: previous?.designPhase || null,
        designTodo: previous?.designTodo || [],
        designReviewSummary: previous?.designReviewSummary || null,
        ownedNodeIds: previous?.ownedNodeIds || [],
        repairScope: previous?.repairScope || null,
        taskTitle: previous?.taskTitle || null,
        taskSummary: previous?.taskSummary || null,
        steps: previous?.steps || [],
        currentStepId: previous?.currentStepId || null,
        waitingFor: previous?.waitingFor || 'none',
        resumableActions: previous?.resumableActions || [],
        recentArtifacts: previous?.recentArtifacts || [],
        taskContinuation: previous?.taskContinuation || null,
        memoryCapture: previous?.memoryCapture || null,
        error: previous?.error || null,
      }))
    })

    const cleanupStatus = window.electronAPI.agent.onStatusChange((data) => {
      const { agents, setAgents } = store.getState()
      setAgents(agents.map((agent: Agent) => agent.name === data.agent ? { ...agent, status: data.status as Agent['status'] } : agent))
    })

    const cleanupError = window.electronAPI.agent.onError((data) => {
      const scopeId = resolveScopeIdForRunPayload(data)
      if (!scopeId) return

      // Phase 3: double-defense — AbortError is already short-circuited inside
      // turn-engine before emitRuntimeError fires, but if anything ever leaks
      // through as 'aborted' we still want to avoid showing a capsule OR a
      // system message (cancellation has its own runComplete path).
      if (data.errorKind === 'aborted') return

      const recoverable = data.recoverable === true

      const state = store.getState()
      const runState = state.scopeRunStates[scopeId] || null

      if (recoverable) {
        const friendly = mapBackendErrorToFriendly({
          error: data.error,
          errorKind: data.errorKind || 'unknown',
        })
        emitRendererAgentMetric('renderer_friendly_error_surfaced', {
          scopeId,
          agent: data.agent,
          errorKind: data.errorKind || 'unknown',
        })
        // Only mutate the softError slot — do NOT touch phase, error,
        // blockedReason, toolTraceStatus, and do NOT persist an assistant
        // message. The turn continues; the capsule is purely a renderer hint.
        upsertScopeRunState(scopeId, (previous) => ({
          scopeId,
          agent: previous?.agent || data.agent,
          requestId: previous?.requestId || (typeof data.runId === 'string' ? data.runId : null),
          phase: previous?.phase || 'idle',
          toolTrace: previous?.toolTrace || [],
          startedAt: previous?.startedAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          latestText: previous?.latestText || null,
          module: previous?.module || null,
          intent: previous?.intent || null,
          executionKind: previous?.executionKind || null,
          jobId: previous?.jobId || null,
          artifactRefs: previous?.artifactRefs || [],
          memoryRefs: previous?.memoryRefs || [],
          triggerHits: previous?.triggerHits || [],
          contextBudget: previous?.contextBudget || null,
          ownerResourceId: previous?.ownerResourceId || null,
          lastEvidenceAt: previous?.lastEvidenceAt || null,
          blockedReason: previous?.blockedReason || null,
          controllerId: previous?.controllerId || null,
          ownerTabId: previous?.ownerTabId || null,
          checkpointExpiresAt: previous?.checkpointExpiresAt || null,
          responseMessageId: previous?.responseMessageId || null,
          responseBuffer: previous?.responseBuffer || '',
          stepMetrics: previous?.stepMetrics || { toolCalls: 0, toolResults: 0, lastToolAt: null },
          designPhase: previous?.designPhase || null,
          designTodo: previous?.designTodo || [],
          designReviewSummary: previous?.designReviewSummary || null,
          ownedNodeIds: previous?.ownedNodeIds || [],
          repairScope: previous?.repairScope || null,
          taskTitle: previous?.taskTitle || null,
          taskSummary: previous?.taskSummary || null,
          steps: previous?.steps || [],
          currentStepId: previous?.currentStepId || null,
          waitingFor: previous?.waitingFor || 'none',
          resumableActions: previous?.resumableActions || [],
          recentArtifacts: previous?.recentArtifacts || [],
          taskContinuation: previous?.taskContinuation || null,
          memoryCapture: previous?.memoryCapture || null,
          error: previous?.error || null,
          softError: {
            message: data.error,
            errorKind: data.errorKind || 'unknown',
            toolName: data.toolName || null,
            friendlyMessage: friendly.friendlyMessage,
            technicalDetails: friendly.technicalDetails || null,
            receivedAt: new Date().toISOString(),
          },
        }))
        return
      }

      // Terminal path — unchanged behavior, plus clear softError so a stale
      // capsule does not linger behind a newer system-message error.
      const friendly = mapBackendErrorToFriendly({
        error: data.error,
        errorKind: data.errorKind || 'unknown',
      })
      emitRendererAgentMetric('renderer_friendly_error_surfaced', {
        scopeId,
        agent: data.agent,
        errorKind: data.errorKind || 'unknown',
      })
      if (state.currentScopeId === scopeId) {
        state.addMessage({
          id: `error-${Date.now()}`,
          agent: data.agent,
          content: friendly.friendlyMessage,
          type: 'system',
          timestamp: new Date(),
        })
        store.setState({ streamingMessageId: null, streamingRequestId: null, toolTraceStatus: 'error' })
      }

      upsertScopeRunState(scopeId, (previous) => ({
        scopeId,
        agent: previous?.agent || data.agent,
        requestId: previous?.requestId || (typeof data.runId === 'string' ? data.runId : null),
        phase: 'error',
        toolTrace: previous?.toolTrace || [],
        startedAt: previous?.startedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        latestText: previous?.latestText || friendly.friendlyMessage,
        module: previous?.module || null,
        intent: previous?.intent || null,
        executionKind: previous?.executionKind || null,
        jobId: previous?.jobId || null,
        artifactRefs: previous?.artifactRefs || [],
        memoryRefs: previous?.memoryRefs || [],
        triggerHits: previous?.triggerHits || [],
        contextBudget: previous?.contextBudget || null,
        ownerResourceId: previous?.ownerResourceId || null,
        lastEvidenceAt: previous?.lastEvidenceAt || null,
        blockedReason: friendly.friendlyMessage,
        controllerId: previous?.controllerId || null,
        ownerTabId: previous?.ownerTabId || null,
        checkpointExpiresAt: null,
        responseMessageId: previous?.responseMessageId || null,
        responseBuffer: previous?.responseBuffer || '',
        stepMetrics: previous?.stepMetrics || { toolCalls: 0, toolResults: 0, lastToolAt: null },
        designPhase: previous?.designPhase || null,
        designTodo: previous?.designTodo || [],
        designReviewSummary: previous?.designReviewSummary || null,
        ownedNodeIds: previous?.ownedNodeIds || [],
        repairScope: previous?.repairScope || null,
        taskTitle: previous?.taskTitle || null,
        taskSummary: previous?.taskSummary || null,
        steps: previous?.steps || [],
        currentStepId: previous?.currentStepId || null,
        waitingFor: previous?.waitingFor || 'none',
        resumableActions: previous?.resumableActions || [],
        recentArtifacts: previous?.recentArtifacts || [],
        taskContinuation: previous?.taskContinuation || null,
        memoryCapture: previous?.memoryCapture || null,
        error: friendly.friendlyMessage,
        softError: null,
      }))
      void persistAssistantMessageForRun(scopeId, runState)
    })

    let toolActionQueue: Promise<void> = Promise.resolve()
    const cleanupToolAction = window.electronAPI.agent.onToolAction((data) => {
      toolActionQueue = toolActionQueue
        .then(async () => {
          const scopeId = resolveScopeIdForRunPayload(data)
          if (!scopeId) return
          const agentName = typeof data.agent === 'string' && data.agent.trim() ? data.agent : store.getState().currentAgent
          const tool = String(data.tool || '').trim()
          const args = (data.args || {}) as Record<string, unknown>
          const runId = typeof data.runId === 'string' ? data.runId : null
          const handled = await handleModuleToolAction({
            scopeId,
            agentName,
            tool,
            args,
            runId,
            activateWorkbenchMode,
            upsertScopeRunState,
            getScopeRunState: () => store.getState().scopeRunStates[scopeId] || null,
          })
          if (!handled) return
        })
        .catch((error) => {
          const scopeId = resolveScopeIdForRunPayload(data)
          if (!scopeId) return
          upsertScopeRunState(scopeId, (previous) => ({
            scopeId,
            agent: previous?.agent || store.getState().currentAgent,
            requestId: previous?.requestId || (typeof data.runId === 'string' ? data.runId : null),
            phase: 'error',
            toolTrace: [
              ...(previous?.toolTrace || []),
              {
                id: `toolerr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                kind: 'result',
                text: `工具执行失败：${error instanceof Error ? error.message : String(error)}`,
                timestamp: new Date(),
              },
            ],
            startedAt: previous?.startedAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            latestText: previous?.latestText || null,
            module: previous?.module || null,
            intent: previous?.intent || null,
            executionKind: previous?.executionKind || null,
            jobId: previous?.jobId || null,
            artifactRefs: previous?.artifactRefs || [],
            memoryRefs: previous?.memoryRefs || [],
            triggerHits: previous?.triggerHits || [],
            contextBudget: previous?.contextBudget || null,
            ownerResourceId: previous?.ownerResourceId || null,
            lastEvidenceAt: previous?.lastEvidenceAt || null,
            blockedReason: error instanceof Error ? error.message : String(error),
            controllerId: previous?.controllerId || null,
            ownerTabId: previous?.ownerTabId || null,
            checkpointExpiresAt: previous?.checkpointExpiresAt || null,
            responseMessageId: previous?.responseMessageId || null,
            responseBuffer: previous?.responseBuffer || '',
            stepMetrics: previous?.stepMetrics || { toolCalls: 0, toolResults: 0, lastToolAt: null },
            designPhase: previous?.designPhase || null,
            designTodo: previous?.designTodo || [],
            designReviewSummary: previous?.designReviewSummary || null,
            ownedNodeIds: previous?.ownedNodeIds || [],
            repairScope: previous?.repairScope || null,
            taskTitle: previous?.taskTitle || null,
            taskSummary: previous?.taskSummary || null,
            steps: previous?.steps || [],
            currentStepId: previous?.currentStepId || null,
            waitingFor: previous?.waitingFor || 'none',
            resumableActions: previous?.resumableActions || [],
            recentArtifacts: previous?.recentArtifacts || [],
            taskContinuation: previous?.taskContinuation || null,
            memoryCapture: previous?.memoryCapture || null,
            error: error instanceof Error ? error.message : String(error),
          }))
        })
    })

    const logToolEvent = (payload: {
      type: 'dispatch' | 'ack' | 'watchdog' | 'cancel' | 'self-rescue' | 'duplicate'
      requestId: string
      tool: string
      scopeId?: string | null
      elapsedMs?: number
      error?: string
    }) => {
      try { window.electronAPI.tools?.logToolEvent?.(payload) } catch { /* ignore */ }
    }

    // Per-scope serialized queue: prevents one stuck tool from blocking other scopes.
    // scopeless requests each get an ephemeral chain keyed by requestId so they never block.
    const scopeQueues = new Map<string, Promise<void>>()
    // Per-request cancellation latch: cancel IPC from main flips these to settle the queued task early.
    // `cancelled` is checked at runWithWatchdog entry so a cancel that arrives while the request is
    //   still queued (before its turn) is honored. `queuedAt` powers the self-rescue TTL — if an entry
    //   sits in the queue for > 180s without execution, runWithWatchdog treats it as cancelled.
    const QUEUE_SELF_RESCUE_MS = 180_000
    const activeToolRequests = new Map<string, {
      settled: boolean
      cancelled: boolean
      abort: () => void
      queuedAt: number
    }>()

    const budgetForTool = (tool: string): number => {
      const name = String(tool || '').trim().toLowerCase()
      if (!name) return 15_000
      if (name.startsWith('skill_') || name.startsWith('skill:')) return 120_000
      if (name.startsWith('browser_') || name.startsWith('browser:')) return 60_000
      if (name.startsWith('document_') || name.startsWith('document:')) return 30_000
      if (name.startsWith('feishu_') || name.startsWith('feishu:')) return 30_000
      return 15_000
    }

    const runWithWatchdog = async (data: {
      requestId: string
      agent?: string
      sessionId?: string
      runId?: string
      tool: string
      args: Record<string, unknown>
    }): Promise<void> => {
      const requestId = data.requestId
      const existing = activeToolRequests.get(requestId)
      const now = Date.now()
      const queuedTooLong = existing && now - existing.queuedAt > QUEUE_SELF_RESCUE_MS
      // Cancel IPC may have flipped the latch while this request was still queued.
      if (existing?.cancelled || queuedTooLong) {
        activeToolRequests.delete(requestId)
        const elapsed = existing ? now - existing.queuedAt : undefined
        logToolEvent({
          type: queuedTooLong ? 'self-rescue' : 'cancel',
          requestId,
          tool: String(data.tool || ''),
          scopeId: resolveScopeIdForRunPayload(data),
          elapsedMs: typeof elapsed === 'number' ? elapsed : undefined,
          error: queuedTooLong ? 'queue-self-rescue' : 'cancelled',
        })
        await window.electronAPI.agent.completeToolActionRequest({
          requestId,
          handled: false,
          error: queuedTooLong ? 'queue-self-rescue' : 'cancelled',
        }).catch(() => { /* ignore */ })
        return
      }
      if (existing?.settled) { activeToolRequests.delete(requestId); return }

      const scopeId = resolveScopeIdForRunPayload(data)
      if (!scopeId) {
        activeToolRequests.delete(requestId)
        await window.electronAPI.agent.completeToolActionRequest({
          requestId,
          handled: false,
          error: 'Scope run not found for tool action request',
        })
        return
      }

      const agentName = typeof data.agent === 'string' && data.agent.trim() ? data.agent : store.getState().currentAgent
      const tool = String(data.tool || '').trim()
      const args = (data.args || {}) as Record<string, unknown>
      const runId = typeof data.runId === 'string' ? data.runId : null
      const budgetMs = budgetForTool(tool)

      const startedAt = Date.now()
      let watchdog: ReturnType<typeof setTimeout> | null = null
      const watchdogPromise = new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => {
          const entry = activeToolRequests.get(requestId)
          if (entry && !entry.settled) {
            entry.settled = true
            const message = `renderer-watchdog:${budgetMs}`
            logToolEvent({
              type: 'watchdog',
              requestId,
              tool,
              scopeId,
              elapsedMs: budgetMs,
              error: message,
            })
            reject(new Error(message))
          }
        }, budgetMs)
      })
      const cancelPromise = new Promise<never>((_, reject) => {
        const entry = activeToolRequests.get(requestId)
        if (entry) {
          // Share the latch with the queue-level abort so cancels that raced ahead (cancelled=true)
          //   still propagate into the race when runWithWatchdog finally enters.
          if (entry.cancelled) {
            entry.settled = true
            logToolEvent({
              type: 'cancel',
              requestId,
              tool,
              scopeId,
              elapsedMs: Date.now() - startedAt,
            })
            reject(new Error('cancelled'))
            return
          }
          entry.abort = () => {
            if (entry.settled) return
            entry.cancelled = true
            entry.settled = true
            logToolEvent({
              type: 'cancel',
              requestId,
              tool,
              scopeId,
              elapsedMs: Date.now() - startedAt,
            })
            reject(new Error('cancelled'))
          }
        }
      })

      try {
        const result = await Promise.race([
          executeModuleToolAction({
            scopeId,
            agentName,
            tool,
            args,
            runId,
            activateWorkbenchMode,
            upsertScopeRunState,
            getScopeRunState: () => store.getState().scopeRunStates[scopeId] || null,
          }),
          watchdogPromise,
          cancelPromise,
        ])
        await window.electronAPI.agent.completeToolActionRequest({
          requestId,
          handled: result.handled,
          payload: result.payload,
        })
        logToolEvent({
          type: 'ack',
          requestId,
          tool,
          scopeId,
          elapsedMs: Date.now() - startedAt,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // For cancelled we've already been told; still ack so main's pending map releases even if
        // the cancel IPC was missed. completeToolActionRequest on an unknown id is a no-op.
        await window.electronAPI.agent.completeToolActionRequest({
          requestId,
          handled: false,
          error: message,
        }).catch(() => { /* ignore */ })
        throw error
      } finally {
        if (watchdog) clearTimeout(watchdog)
        activeToolRequests.delete(requestId)
      }
    }

    const cleanupToolActionRequest = window.electronAPI.agent.onToolActionRequest
      ? window.electronAPI.agent.onToolActionRequest((data) => {
        const scopeIdForLog = resolveScopeIdForRunPayload(data)
        const queueKey = scopeIdForLog || `scopeless:${data.requestId}`
        // Idempotent: if we already have an entry for this requestId, ignore the duplicate dispatch.
        //   This guards against IPC replay and covers G-Z9.
        if (activeToolRequests.has(data.requestId)) {
          logToolEvent({
            type: 'duplicate',
            requestId: data.requestId,
            tool: String(data.tool || ''),
            scopeId: scopeIdForLog,
            error: 'duplicate-dispatch',
          })
          try {
            void window.electronAPI.agent.completeToolActionRequest?.({
              requestId: data.requestId,
              handled: false,
              error: 'duplicate-dispatch',
            }).catch(() => { /* ignore */ })
          } catch { /* ignore */ }
          return
        }
        // Queue-level abort: flipping `cancelled` guarantees runWithWatchdog's entry check sees
        //   the cancel even if the request is still waiting its turn in the scope queue.
        const abortFromQueue = () => {
          const entry = activeToolRequests.get(data.requestId)
          if (!entry || entry.settled) return
          entry.cancelled = true
          entry.settled = true
        }
        activeToolRequests.set(data.requestId, {
          settled: false,
          cancelled: false,
          abort: abortFromQueue,
          queuedAt: Date.now(),
        })
        logToolEvent({
          type: 'dispatch',
          requestId: data.requestId,
          tool: String(data.tool || ''),
          scopeId: scopeIdForLog,
        })
        const prev = scopeQueues.get(queueKey) || Promise.resolve()
        const next = prev
          .catch(() => { /* previous task's error already handled */ })
          .then(() => runWithWatchdog(data))
          .catch(async (error) => {
            const scopeId = resolveScopeIdForRunPayload(data)
            if (scopeId) {
              upsertScopeRunState(scopeId, (previous) => ({
                scopeId,
                agent: previous?.agent || store.getState().currentAgent,
                requestId: previous?.requestId || (typeof data.runId === 'string' ? data.runId : null),
                phase: 'error',
                toolTrace: [
                  ...(previous?.toolTrace || []),
                  {
                    id: `toolreqerr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    kind: 'result',
                    text: `工具执行失败：${error instanceof Error ? error.message : String(error)}`,
                    timestamp: new Date(),
                  },
                ],
                startedAt: previous?.startedAt || new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                latestText: previous?.latestText || null,
                module: previous?.module || null,
                intent: previous?.intent || null,
                executionKind: previous?.executionKind || null,
                jobId: previous?.jobId || null,
                artifactRefs: previous?.artifactRefs || [],
                memoryRefs: previous?.memoryRefs || [],
                triggerHits: previous?.triggerHits || [],
                contextBudget: previous?.contextBudget || null,
                ownerResourceId: previous?.ownerResourceId || null,
                lastEvidenceAt: previous?.lastEvidenceAt || null,
                blockedReason: error instanceof Error ? error.message : String(error),
                controllerId: previous?.controllerId || null,
                ownerTabId: previous?.ownerTabId || null,
                checkpointExpiresAt: previous?.checkpointExpiresAt || null,
                responseMessageId: previous?.responseMessageId || null,
                responseBuffer: previous?.responseBuffer || '',
                stepMetrics: previous?.stepMetrics || { toolCalls: 0, toolResults: 0, lastToolAt: null },
                designPhase: previous?.designPhase || null,
                designTodo: previous?.designTodo || [],
                designReviewSummary: previous?.designReviewSummary || null,
                ownedNodeIds: previous?.ownedNodeIds || [],
                repairScope: previous?.repairScope || null,
                taskTitle: previous?.taskTitle || null,
                taskSummary: previous?.taskSummary || null,
                steps: previous?.steps || [],
                currentStepId: previous?.currentStepId || null,
                waitingFor: previous?.waitingFor || 'none',
                resumableActions: previous?.resumableActions || [],
                recentArtifacts: previous?.recentArtifacts || [],
                taskContinuation: previous?.taskContinuation || null,
                memoryCapture: previous?.memoryCapture || null,
                error: error instanceof Error ? error.message : String(error),
              }))
            }
            // runWithWatchdog already acked main; nothing else to do.
          })
        scopeQueues.set(queueKey, next)
        void next.finally(() => {
          if (scopeQueues.get(queueKey) === next) scopeQueues.delete(queueKey)
        })
      })
      : () => { /* older test stubs */ }

    const cleanupCancelToolActionRequest = window.electronAPI.agent.onCancelToolActionRequest
      ? window.electronAPI.agent.onCancelToolActionRequest((data) => {
        const ids = Array.isArray(data?.requestIds) ? data.requestIds : []
        for (const rid of ids) {
          const entry = activeToolRequests.get(rid)
          if (!entry || entry.settled) continue
          entry.abort()
        }
        // Any queued widget writes that haven't yet committed to the store should
        // treat this as a preempt — bump the per-tab epoch so the runUpdate
        // closures bail before setTabContent instead of landing old content.
        if (ids.length > 0) cancelAllPendingWidgetWrites()
      })
      : () => { /* older test stubs */ }

    const cleanupScopeRunEvent = window.electronAPI.agent.onScopeRunEvent
      ? window.electronAPI.agent.onScopeRunEvent((event: any) => {
        if (!event.scopeId) return
        if (!isScopeRunPhase(event.phase) || event.phase === 'idle') return

        upsertScopeRunState(event.scopeId, (previous) => {
          const currentState = store.getState()
          const activeMessage = previous?.responseMessageId
            ? currentState.messages.find((item: AgentMessage) => item.id === previous.responseMessageId) || null
            : null
          const shouldBreakSegment = Boolean(
            event.toolEvent &&
            previous?.responseMessageId &&
            String(activeMessage?.content || previous?.responseBuffer || '').trim(),
          )
          const toolTrace = previous?.toolTrace || []
          const nextTrace = event.toolEvent
            ? [
              ...toolTrace,
              {
                id: event.toolEvent.id,
                kind: event.toolEvent.kind,
                text: event.toolEvent.text,
                timestamp: new Date(event.toolEvent.timestamp),
              },
            ]
            : toolTrace
          const patch = deriveScopeRunStatePatch(event, previous)

          return {
            scopeId: event.scopeId,
            agent: previous?.agent || event.agent,
            requestId: event.runId || previous?.requestId || null,
            taskId: event.taskId || previous?.taskId || patch.taskContinuation?.taskId || null,
            phase: patch.phase || event.phase,
            terminalReason: patch.terminalReason ?? null,
            toolTrace: nextTrace,
            startedAt: previous?.startedAt || event.timestamp,
            updatedAt: event.timestamp,
            latestText: patch.latestText ?? previous?.latestText ?? null,
            module: patch.module ?? event.module ?? previous?.module ?? null,
            intent: patch.intent ?? event.intent ?? previous?.intent ?? null,
            executionKind: patch.executionKind ?? event.executionKind ?? previous?.executionKind ?? null,
            jobId: patch.jobId ?? event.jobId ?? previous?.jobId ?? null,
            artifactRefs: mergeArtifacts(previous?.artifactRefs, patch.artifactRefs ?? event.artifactRefs),
            memoryRefs: patch.memoryRefs ?? event.memoryRefs ?? previous?.memoryRefs ?? [],
            triggerHits: patch.triggerHits ?? event.triggerHits ?? previous?.triggerHits ?? [],
            contextBudget: patch.contextBudget ?? event.contextBudget ?? previous?.contextBudget ?? null,
            ownerResourceId: patch.ownerResourceId ?? event.ownerResourceId ?? previous?.ownerResourceId ?? null,
            lastEvidenceAt: patch.lastEvidenceAt ?? event.lastEvidenceAt ?? previous?.lastEvidenceAt ?? null,
            blockedReason: patch.blockedReason ?? previous?.blockedReason ?? null,
            controllerId: patch.controllerId ?? previous?.controllerId ?? null,
            ownerTabId: patch.ownerTabId ?? previous?.ownerTabId ?? null,
            checkpointExpiresAt: patch.checkpointExpiresAt ?? previous?.checkpointExpiresAt ?? null,
            responseMessageId: previous?.responseMessageId || null,
            responseBuffer: previous?.responseBuffer || '',
            responseSegmentBreakPending: shouldBreakSegment
              ? true
              : previous?.responseSegmentBreakPending ?? false,
            responseSegmentToolTraceStart: previous?.responseSegmentToolTraceStart ?? 0,
            stepMetrics: patch.stepMetrics ?? previous?.stepMetrics ?? { toolCalls: 0, toolResults: 0, lastToolAt: null },
            designPhase: patch.designPhase ?? previous?.designPhase ?? null,
            designTodo: patch.designTodo ?? previous?.designTodo ?? [],
            designReviewSummary: patch.designReviewSummary ?? previous?.designReviewSummary ?? null,
            ownedNodeIds: patch.ownedNodeIds ?? previous?.ownedNodeIds ?? [],
            repairScope: patch.repairScope ?? previous?.repairScope ?? null,
            taskTitle: patch.taskTitle ?? previous?.taskTitle ?? null,
            taskSummary: patch.taskSummary ?? previous?.taskSummary ?? null,
            steps: patch.steps ?? previous?.steps ?? [],
            currentStepId: patch.currentStepId ?? previous?.currentStepId ?? null,
            waitingFor: patch.waitingFor ?? previous?.waitingFor ?? 'none',
            resumableActions: patch.resumableActions ?? previous?.resumableActions ?? [],
            recentArtifacts: patch.recentArtifacts ?? previous?.recentArtifacts ?? [],
            taskContinuation: patch.taskContinuation ?? previous?.taskContinuation ?? null,
            memoryCapture: patch.memoryCapture ?? previous?.memoryCapture ?? null,
            error: patch.error ?? event.error ?? previous?.error ?? null,
          }
        })

        const currentState = store.getState()
        if (currentState.currentScopeId === event.scopeId) {
          const detachedJobEvent = event.module === 'skill' && event.executionKind === 'job' && String(event.taskId || '').startsWith('detached:')
          if (event.type === 'started' && !detachedJobEvent) {
            store.setState({ streamingRequestId: event.runId || currentState.streamingRequestId })
          }
          const terminalRunEvent = Boolean(
            store.getState().scopeRunStates[event.scopeId]?.terminalReason ||
            event.phase === 'done' ||
            event.phase === 'error' ||
            event.phase === 'cancelled',
          )
          if (terminalRunEvent) {
            const latestRunState = store.getState().scopeRunStates[event.scopeId] || null
            store.setState({
              isStreaming: false,
              streamingMessageId: null,
              streamingRequestId: null,
              toolTraceStatus: phaseToToolTraceStatus(latestRunState?.phase || event.phase),
            })
          }
        }
        if (
          event.terminalReason ||
          event.phase === 'done' ||
          event.phase === 'error' ||
          event.phase === 'cancelled'
        ) {
          void persistAssistantMessageForRun(event.scopeId, store.getState().scopeRunStates[event.scopeId] || null)
        }
      })
      : () => { /* older test stubs */ }

    const cleanupConversationEvent = window.electronAPI.agent.onConversationEvent((data) => {
      const event = data as {
        type: 'scope_created' | 'scope_updated' | 'message_added'
        scope: ConversationScope
        message?: {
          id: string
          role: string
          content: string
          timestamp: string
          meta?: Record<string, unknown>
        }
      }
      store.setState((state: any) => {
        const existing = state.scopes.find((scope: ConversationScope) => scope.id === event.scope.id)
        const mergedScopes = existing
          ? state.scopes.map((scope: ConversationScope) => scope.id === event.scope.id ? event.scope : scope)
          : [event.scope, ...state.scopes]
        const nextState: Record<string, unknown> = {
          scopes: mergedScopes,
          conversations: mergedScopes.map((scope: ConversationScope) => ({
            id: scope.id,
            agent: scope.agent,
            title: scope.title,
            created_at: scope.createdAt,
            updated_at: scope.updatedAt,
          })),
        }

        if (state.currentScopeId === event.scope.id) {
          nextState.currentScope = event.scope
        }

        if (event.type === 'message_added' && event.message && state.currentScopeId === event.scope.id) {
          const nextMessage: AgentMessage = {
            id: event.message.id,
            agent: event.scope.agent,
            content: event.message.content,
            type: event.message.role === 'user' ? 'user' : event.message.role === 'assistant' ? 'agent' : 'system',
            timestamp: new Date(event.message.timestamp),
            attachments: extractAttachmentsFromMeta(event.message.meta),
            meta: event.message.meta || {},
          }
          const hasMessage = state.messages.some((message: AgentMessage) => message.id === nextMessage.id)
          nextState.messages = hasMessage ? state.messages : [...state.messages, nextMessage]
        }

        return nextState
      })
    })

    return () => {
      listenersInitialized = false
      cleanupStream()
      cleanupStatus()
      cleanupError()
      cleanupToolAction()
      cleanupToolActionRequest()
      cleanupCancelToolActionRequest()
      cleanupScopeRunEvent()
      cleanupConversationEvent()
    }
  }

  return {
    initAgentListeners,
    upsertScopeRunState,
    resolveScopeIdForRunPayload,
  }
}
