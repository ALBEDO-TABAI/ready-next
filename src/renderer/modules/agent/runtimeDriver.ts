import { deriveScopeRunStatePatch, getActiveScopeRunState, isActiveScopePhase, mergeArtifacts, phaseToToolTraceStatus } from './scopeRunState'
import { persistAssistantMessage, extractAttachmentsFromMeta } from './messageComposer'
import { executeModuleToolAction, handleModuleToolAction } from './moduleExecutor'
import type { Agent, AgentMessage, ConversationScope, ScopeRunState } from './types'
import { useMode } from '../../stores/useMode'
import { extractSkillCommandFromText, runSkillCommand } from './commandHandlers'

interface AgentStoreLike {
  getState: () => any
  setState: (partial: any) => void
}

interface RunPayloadLike {
  sessionId?: string
  runId?: string
  agent?: string
}

export function syncActiveScopeRunAliases(
  state: Pick<{ currentScopeId: string | null; scopeRunStates: Record<string, ScopeRunState> }, 'currentScopeId' | 'scopeRunStates'>,
): Pick<{ isStreaming: boolean; toolTrace: ScopeRunState['toolTrace']; toolTraceStatus: 'idle' | 'running' | 'done' | 'error' | 'cancelled' }, 'isStreaming' | 'toolTrace' | 'toolTraceStatus'> {
  const activeRunState = getActiveScopeRunState(state.scopeRunStates, state.currentScopeId)
  return {
    isStreaming: isActiveScopePhase(activeRunState?.phase),
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
      const next = updater(previous)
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

  function resolveScopeIdForRunPayload(payload: RunPayloadLike): string | null {
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
    await persistAssistantMessage(scopeId, runState.responseMessageId, content, currentScope)
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
          await maybeAutoExecuteAssistantSkillCommand(scopeId, runState)
          await persistAssistantMessageForRun(scopeId, store.getState().scopeRunStates[scopeId] || runState)
          if (store.getState().currentScopeId === scopeId) {
            store.setState({
              streamingMessageId: null,
              streamingRequestId: null,
              ...syncActiveScopeRunAliases({
                currentScopeId: scopeId,
                scopeRunStates: store.getState().scopeRunStates,
              }),
            })
          }
        })()
        return
      }

      if (data.type !== 'text' || !data.chunk) return

      const currentState = store.getState()
      const runState = currentState.scopeRunStates[scopeId] || null
      const nextBuffer = `${runState?.responseBuffer || ''}${data.chunk}`
      if (
        scopeId === currentState.currentScopeId &&
        runState?.responseMessageId &&
        currentState.messages.some((item: AgentMessage) => item.id === runState.responseMessageId)
      ) {
        currentState.appendToMessage(runState.responseMessageId, data.chunk)
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
        responseMessageId: previous?.responseMessageId || null,
        responseBuffer: nextBuffer,
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

      const state = store.getState()
      const runState = state.scopeRunStates[scopeId] || null
      if (state.currentScopeId === scopeId) {
        state.addMessage({
          id: `error-${Date.now()}`,
          agent: data.agent,
          content: `Agent 错误: ${data.error}`,
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
        latestText: previous?.latestText || data.error,
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
        blockedReason: data.error,
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
        error: data.error,
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

    let toolActionRequestQueue: Promise<void> = Promise.resolve()
    const cleanupToolActionRequest = window.electronAPI.agent.onToolActionRequest
      ? window.electronAPI.agent.onToolActionRequest((data) => {
        toolActionRequestQueue = toolActionRequestQueue
          .then(async () => {
            const scopeId = resolveScopeIdForRunPayload(data)
            if (!scopeId) {
              await window.electronAPI.agent.completeToolActionRequest({
                requestId: data.requestId,
                handled: false,
                error: 'Scope run not found for tool action request',
              })
              return
            }

            const agentName = typeof data.agent === 'string' && data.agent.trim() ? data.agent : store.getState().currentAgent
            const tool = String(data.tool || '').trim()
            const args = (data.args || {}) as Record<string, unknown>
            const runId = typeof data.runId === 'string' ? data.runId : null
            const result = await executeModuleToolAction({
              scopeId,
              agentName,
              tool,
              args,
              runId,
              activateWorkbenchMode,
              upsertScopeRunState,
              getScopeRunState: () => store.getState().scopeRunStates[scopeId] || null,
            })
            await window.electronAPI.agent.completeToolActionRequest({
              requestId: data.requestId,
              handled: result.handled,
              payload: result.payload,
            })
          })
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
            await window.electronAPI.agent.completeToolActionRequest({
              requestId: data.requestId,
              handled: false,
              error: error instanceof Error ? error.message : String(error),
            })
          })
      })
      : () => { /* older test stubs */ }

    const cleanupScopeRunEvent = window.electronAPI.agent.onScopeRunEvent
      ? window.electronAPI.agent.onScopeRunEvent((event: any) => {
        if (!event.scopeId) return

        upsertScopeRunState(event.scopeId, (previous) => {
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
            phase: patch.phase || event.phase,
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
          if (event.type === 'started') {
            store.setState({ streamingRequestId: event.runId || currentState.streamingRequestId })
          }
          if (event.phase === 'done' || event.phase === 'error' || event.phase === 'cancelled') {
            store.setState({ streamingRequestId: null })
          }
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
