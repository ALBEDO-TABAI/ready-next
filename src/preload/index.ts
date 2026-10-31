import type { LibraryArchiveAPI, LibraryArchiveProgress } from '../shared/library'
import type { ObjectPresentationAPI, ObjectMovedEvent } from '../shared/object-identity'
import type { ObjectLinkQuery } from '../shared/object-links'
import type { LibraryHighlightContext, LibraryHighlightCreate, LibraryHighlightUpdate, LibraryHighlightRemove, LibraryHighlightState } from '../shared/library'
import type { LibraryBook, LibraryBookPatch, LibraryBookmark, LibraryImportResult, LibraryReadingPosition, LibraryResult, LibraryState } from '../shared/library'
import type { DocumentSyncRequest, DocumentSyncReply } from '../shared/document-operations'
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { createBeforeQuitFlushChannel } from './before-quit-flush'
import {
  BROWSER_VIEW_INTENT_CHANNEL,
  type BrowserViewIntent,
  type BrowserViewIntentAck,
} from '../shared/browser-view-intent'
import type { BrowserUtilityMenuRequest } from '../shared/browser-utility-menu'
import type {
  DocumentIndexChangedEvent,
  DocumentWatcherFailedEvent,
} from '../shared/document-index-events'
import type { NativeContextMenuRequest } from '../shared/native-context-menu'
import type { RSSAutoRefreshSnapshot } from '../shared/rss-auto-refresh'
import type { RendererAgentMetricName } from '../shared/renderer-agent-metrics'
import type { CanonicalAssistantMessage } from '../shared/ipc-contracts/canonical-message'
import {
  parseIngressAdmittedEvent,
  parseCodexActionSurfaceInvalidation,
  parseCreateSessionRequest,
  parseCreateSessionResult,
  parseBeginNewContextRequest,
  parseBeginNewContextResult,
  parseLifecycleRequest,
  parseLifecycleResult,
  parseProductLifecycleRequest,
  parseStopLifecycleRequest,
  parseSendScopedRequest,
  parseSendScopedResponse,
  type CreateSessionRequest,
  type BeginNewContextRequest,
  type SendScopedRequest,
  type LifecycleRequest,
  type ProductLifecycleRequest,
  type StopLifecycleRequest,
} from '../shared/ipc-contracts/agent-runtime'
import type { ActionAuthorizationMode } from '../shared/action-authorization-mode'
import {
  parseAgentRuntimeReadinessSnapshot,
  type AgentRuntimeReadinessSnapshot,
} from '../shared/ipc-contracts/agent-runtime-readiness'
import {
  parseLifecycleOperationProjectionV2,
  type LifecycleOperationProjectionV2,
} from '../shared/ipc-contracts/agent-lifecycle-snapshot'
import type { ModelPackDownloadUpdate, ModelPackId, ModelSource } from '../shared/model-pack-types'
import type { RendererStateFlushOutcome } from '../shared/renderer-state-flush'
import type { RuntimeStatus, RuntimeProvisionTaskSnapshot } from '../shared/runtime-provision-types'
import type {
  PetActivityOpenIdentity,
  PetSettings,
  PetStickyNoteInput,
  PetWindowSnapshot,
} from '../shared/pet'
import type {
  FileEmergenceGetSnapshotPayload,
  FileEmergenceRecordActivityPayload,
  FileEmergenceRecordReadingSessionPayload,
  FileEmergenceRenameProjectPayload,
  FileEmergenceAssignFilePayload,
  FileEmergenceCreateProjectForFilePayload,
  FileEmergenceFeedbackPayload,
} from '../shared/file-emergence'
import type { TagForgeFinalizeCreationPayload,TagForgePrepareCreationPayload } from '../shared/tag-forge'
import type {
  ImageGenerationCopyInput,
  ImageGenerationPersistToDirectoryInput,
  ImageGenerationPersistToDocumentInput,
} from '../shared/image-generation'
import type {
  BrowserLockOverlaySnapshot,
} from '../shared/browser-lock-overlay'
import type { BrowserAgentPointerSnapshot } from '../shared/browser-agent-pointer'
import type {
  VerticalRailOverlayCommand,
  VerticalRailOverlaySnapshot,
} from '../shared/browser-vertical-rail-overlay'
import type {
  FastCardItem,
  BrowserFastCardContextActionEvent,
  FastCardOverlayCommand,
  FastCardOverlaySnapshot,
  FastCardDescribeImageRequest,
  FastCardResolveVideoRequest,
  FastCardTranslateRequest,
} from '../shared/fastcard'
import { createAgentRuntimeInvokeGate } from './agent-runtime-invoke-gate'
import {
  parseReadyMemoryAddRequest,
  parseReadyMemoryConversationPolicyRequest,
  parseReadyMemoryDeleteRequest,
  parseReadyMemoryGlobalPolicyRequest,
  parseReadyMemoryPinRequest,
  parseReadyMemoryReadRequest,
  parseReadyMemoryResetRequest,
  parseReadyMemoryStateChange,
  parseReadyMemoryUpdateRequest,
  parseReadyMemoryView,
  type ReadyMemoryAddRequest,
  type ReadyMemoryConversationPolicyRequest,
  type ReadyMemoryDeleteRequest,
  type ReadyMemoryGlobalPolicyRequest,
  type ReadyMemoryPinRequest,
  type ReadyMemoryReadRequest,
  type ReadyMemoryResetRequest,
  type ReadyMemoryUpdateRequest,
  type ReadyMemoryStateChange,
} from '../shared/ready-memory'

const subscribeBeforeQuitFlush = createBeforeQuitFlushChannel({
  listen: (listener) => {
    ipcRenderer.on('app:flushBeforeQuit', listener)
    return () => ipcRenderer.removeListener('app:flushBeforeQuit', listener)
  },
  answer: (requestId, outcome) => ipcRenderer.send('app:beforeQuitFlushed', requestId, outcome),
})
const readAgentRuntimeReady = async (): Promise<AgentRuntimeReadinessSnapshot> => (
  parseAgentRuntimeReadinessSnapshot(await ipcRenderer.invoke('agent:readRuntimeReady'))
)

const subscribeAgentRuntimeReady = (
  callback: (snapshot: AgentRuntimeReadinessSnapshot) => void,
): (() => void) => {
  const listener = (_event: IpcRendererEvent, payload: unknown) => {
    callback(parseAgentRuntimeReadinessSnapshot(payload))
  }
  ipcRenderer.on('agent:runtimeReady', listener)
  return () => ipcRenderer.removeListener('agent:runtimeReady', listener)
}

const agentRuntimeInvokeGate = createAgentRuntimeInvokeGate({
  read: readAgentRuntimeReady,
  subscribe: subscribeAgentRuntimeReady,
})

const invokeAgentRuntime = <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => (
  agentRuntimeInvokeGate.invoke(() => ipcRenderer.invoke(channel, ...args) as Promise<T>)
)

const parseReadyMemoryResponse = (result: {
  success: boolean
  data?: unknown
  error?: string
}) => {
  return result.success && result.data
    ? { ...result, data: parseReadyMemoryView(result.data) }
    : result
}

// Agent API
const agentAPI = {
  createSession: async (request: CreateSessionRequest) => parseCreateSessionResult(
    await invokeAgentRuntime('agent:createSession', parseCreateSessionRequest(request)),
  ),
  beginNewContext: async (request: BeginNewContextRequest) => parseBeginNewContextResult(
    await invokeAgentRuntime('agent:beginNewContext', parseBeginNewContextRequest(request)),
  ),
  resetSession: async (request: ProductLifecycleRequest) => parseLifecycleResult(
    await invokeAgentRuntime('agent:resetSession', parseProductLifecycleRequest(request)),
  ),
  // Stage U PR U1.2 — removed `orchestrate / getStatus / getAll / getDiagnostics`
  // legacy AgentManager wrappers. Zero renderer callers (verified via grep).
  // Use `getRuntimeStatus` + `getCapabilityRuntimeSnapshot` for diagnostics.
  kill: async (request: StopLifecycleRequest) => parseLifecycleResult(
    await invokeAgentRuntime('agent:kill', parseStopLifecycleRequest(request)),
  ),
  closeSession: async (request: ProductLifecycleRequest) => parseLifecycleResult(
    await invokeAgentRuntime('agent:closeSession', parseProductLifecycleRequest(request)),
  ),
  compactSession: async (request: LifecycleRequest) => parseLifecycleResult(
    await invokeAgentRuntime('agent:compactSession', parseLifecycleRequest(request)),
  ),
  getRuntimeStatus: () => invokeAgentRuntime('agent:getRuntimeStatus'),
  getCapabilityRuntimeSnapshot: (config?: unknown) => invokeAgentRuntime('agent:getCapabilityRuntimeSnapshot', config),
  listChannels: () => invokeAgentRuntime('agent:listChannels'),
  listConversationScopes: () => invokeAgentRuntime('agent:listConversationScopes', {}),
  readRuntimeReady: readAgentRuntimeReady,
  onRuntimeReady: subscribeAgentRuntimeReady,
  listScopeRuns: (payload?: { channelKey?: string; statuses?: string[]; limit?: number }) =>
    invokeAgentRuntime('agent:listScopeRuns', payload || {}),
  readProductTurnPresentation: (
    readyRunId: string,
    requestedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar',
  ) => invokeAgentRuntime('agent:readProductTurnPresentation', {
    readyRunId,
    requestedWorkbenchMode,
  }),
  readProductTurnPresentations: (
    readyRunIds: string[],
    requestedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar',
  ) => invokeAgentRuntime('agent:readProductTurnPresentations', {
    readyRunIds,
    requestedWorkbenchMode,
  }),
  readCodexLifecycleSnapshot: async (request: LifecycleRequest) => {
    const result = await invokeAgentRuntime('agent:readCodexLifecycleSnapshot', parseLifecycleRequest(request)) as {
      success: boolean
      data?: unknown
      error?: string
    }
    return result.success && result.data
      ? { ...result, data: parseLifecycleOperationProjectionV2(result.data) as LifecycleOperationProjectionV2 }
      : result
  },
  readCodexHeadActionProjection: (request: LifecycleRequest) =>
    invokeAgentRuntime('agent:readCodexHeadActionProjection', parseLifecycleRequest(request)),
  readCodexActionSurface: (request: LifecycleRequest) =>
    invokeAgentRuntime('agent:readCodexActionSurface', parseLifecycleRequest(request)),
  readReadyMemory: async (request: ReadyMemoryReadRequest) => parseReadyMemoryResponse(
    await invokeAgentRuntime('agent:readReadyMemory', parseReadyMemoryReadRequest(request)),
  ),
  setReadyMemoryGlobalPolicy: async (request: ReadyMemoryGlobalPolicyRequest) => parseReadyMemoryResponse(
    await invokeAgentRuntime('agent:setReadyMemoryGlobalPolicy', parseReadyMemoryGlobalPolicyRequest(request)),
  ),
  setReadyMemoryConversationPolicy: async (request: ReadyMemoryConversationPolicyRequest) => parseReadyMemoryResponse(
    await invokeAgentRuntime('agent:setReadyMemoryConversationPolicy', parseReadyMemoryConversationPolicyRequest(request)),
  ),
  addReadyMemory: async (request: ReadyMemoryAddRequest) => parseReadyMemoryResponse(
    await invokeAgentRuntime('agent:addReadyMemory', parseReadyMemoryAddRequest(request)),
  ),
  updateReadyMemory: async (request: ReadyMemoryUpdateRequest) => parseReadyMemoryResponse(
    await invokeAgentRuntime('agent:updateReadyMemory', parseReadyMemoryUpdateRequest(request)),
  ),
  pinReadyMemory: async (request: ReadyMemoryPinRequest) => parseReadyMemoryResponse(
    await invokeAgentRuntime('agent:pinReadyMemory', parseReadyMemoryPinRequest(request)),
  ),
  deleteReadyMemory: async (request: ReadyMemoryDeleteRequest) => parseReadyMemoryResponse(
    await invokeAgentRuntime('agent:deleteReadyMemory', parseReadyMemoryDeleteRequest(request)),
  ),
  resetReadyMemory: async (request: ReadyMemoryResetRequest) => parseReadyMemoryResponse(
    await invokeAgentRuntime('agent:resetReadyMemory', parseReadyMemoryResetRequest(request)),
  ),
  onReadyMemoryStateChanged: (callback: (event: ReadyMemoryStateChange) => void) => {
    const handler = (_event: unknown, raw: unknown) => callback(parseReadyMemoryStateChange(raw))
    ipcRenderer.on('agent:readyMemoryStateChanged', handler)
    return () => { ipcRenderer.removeListener('agent:readyMemoryStateChanged', handler) }
  },
  onCodexActionSurfaceInvalidated: (
    callback: (event: import('../shared/ipc-contracts/agent-runtime').CodexActionSurfaceInvalidation) => void,
  ) => {
    const handler = (_event: unknown, value: unknown) => callback(
      parseCodexActionSurfaceInvalidation(value),
    )
    ipcRenderer.on('agent:codexActionSurfaceInvalidated', handler)
    return () => { ipcRenderer.removeListener('agent:codexActionSurfaceInvalidated', handler) }
  },
  listTaskProjections: (scopeId: string) =>
    invokeAgentRuntime('agent:listTaskProjections', { scopeId }),
  getTaskProjection: (taskId: string) =>
    invokeAgentRuntime('agent:getTaskProjection', { taskId }),
  searchSessionRecall: (payload?: {
    query?: string
    channelKey?: string
    sourceKind?: 'local' | 'channel'
    userId?: string
    hasAttachments?: boolean
    currentScopeId?: string
    limit?: number
  }) => invokeAgentRuntime('agent:searchSessionRecall', payload || {}),
  listRecentSessions: (payload?: {
    channelKey?: string
    sourceKind?: 'local' | 'channel'
    userId?: string
    hasAttachments?: boolean
    currentScopeId?: string
    limit?: number
  }) => invokeAgentRuntime('agent:listRecentSessions', payload || {}),
  getSessionRecallCapsule: (conversationId: string) =>
    invokeAgentRuntime('agent:getSessionRecallCapsule', { conversationId }),
  listAttachedSessionRecallContexts: (scopeId: string) =>
    invokeAgentRuntime('agent:listAttachedSessionRecallContexts', { scopeId }),
  getReferenceSkillHint: (scopeId: string) =>
    invokeAgentRuntime('agent:getReferenceSkillHint', { scopeId }),
  inspectDetachedSkillTask: (taskId: string, scopeId: string) =>
    invokeAgentRuntime('agent:inspectDetachedSkillTask', { taskId, scopeId }),
  listDetachedSkillTasks: (payload?: { scopeId?: string }) =>
    invokeAgentRuntime('agent:listDetachedSkillTasks', payload || {}),
  cancelDetachedSkillTask: (taskId: string, scopeId: string) =>
    invokeAgentRuntime('agent:cancelDetachedSkillTask', { taskId, scopeId }),
  listActiveChildRuns: () => invokeAgentRuntime('agent:listActiveChildRuns'),
  cancelChildRun: (childRunId: string) =>
    invokeAgentRuntime('agent:cancelChildRun', { childRunId }),
  attachSessionRecallContext: (
    currentScopeId: string,
    conversationId: string,
    expectedMessageVisibilityEpoch: number,
  ) => invokeAgentRuntime('agent:attachSessionRecallContext', {
    currentScopeId,
    conversationId,
    expectedMessageVisibilityEpoch,
  }),
  detachSessionRecallContext: (
    currentScopeId: string,
    conversationId: string,
    expectedMessageVisibilityEpoch: number,
  ) => invokeAgentRuntime('agent:detachSessionRecallContext', {
    currentScopeId,
    conversationId,
    expectedMessageVisibilityEpoch,
  }),
  resumeSessionCandidate: (payload: { conversationId?: string; resumeTitle?: string }) =>
    invokeAgentRuntime('agent:resumeSessionCandidate', payload),
  getConversationScopeMessages: (scopeId: string) =>
    invokeAgentRuntime('agent:getConversationScopeMessages', { scopeId }),
  setProjectDirectory: (scopeId: string, path: string | null, expectedMessageVisibilityEpoch: number) =>
    invokeAgentRuntime('agent:setProjectDirectory', { scopeId, path, expectedMessageVisibilityEpoch }),
  setActionAuthorizationMode: (
    scopeId: string,
    mode: ActionAuthorizationMode,
    expectedMessageVisibilityEpoch: number,
  ) => invokeAgentRuntime('agent:setActionAuthorizationMode', {
    scopeId,
    mode,
    expectedMessageVisibilityEpoch,
  }),
  listScopeAttachments: (scopeId?: string) => invokeAgentRuntime('agent:listScopeAttachments', { scopeId }),
  getScopeAttachment: (scopeId: string, attachmentId: string) =>
    invokeAgentRuntime('agent:getScopeAttachment', { scopeId, attachmentId }),
  clearRemoteAttachmentCache: (channelId?: string) =>
    invokeAgentRuntime('agent:clearRemoteAttachmentCache', { channelId }),
  getRemoteAttachmentCacheStats: (channelId?: string) =>
    invokeAgentRuntime('agent:getRemoteAttachmentCacheStats', { channelId }),
  sendScoped: (payload: SendScopedRequest) => invokeAgentRuntime(
    'agent:sendScoped',
    parseSendScopedRequest(payload),
  )
    .then(parseSendScopedResponse),
  onIngressAdmitted: (callback: (event: ReturnType<typeof parseIngressAdmittedEvent>) => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown) => {
      callback(parseIngressAdmittedEvent(payload))
    }
    ipcRenderer.on('agent:ingressAdmitted', listener)
    return () => ipcRenderer.removeListener('agent:ingressAdmitted', listener)
  },
  emitRendererMetric: (
    name: RendererAgentMetricName,
    payload: Record<string, unknown> = {},
  ) => invokeAgentRuntime('agent:emitRendererMetric', { name, payload }),
  reportInfrastructureTimeout: (payload: { scopeId: string; requestId: string; elapsedMs?: number }) =>
    invokeAgentRuntime('agent:reportInfrastructureTimeout', payload),
  upsertChannel: (payload: {
    id?: string
    type: 'local-debug' | 'generic-webhook' | 'feishu-bot' | 'feishu-app' | 'telegram-bot' | 'wechat-openclaw'
    name: string
    enabled?: boolean
    config?: Record<string, unknown>
  }) => invokeAgentRuntime('agent:upsertChannel', payload),
  testChannel: (payload: {
    id?: string
    type: 'local-debug' | 'generic-webhook' | 'feishu-bot' | 'feishu-app' | 'telegram-bot' | 'wechat-openclaw'
    name: string
    enabled?: boolean
    config?: Record<string, unknown>
  }) => invokeAgentRuntime('agent:testChannel', payload),
  startChannelPairing: (id: string) => invokeAgentRuntime('agent:startChannelPairing', { id }),
  startWechatLogin: (payload: {
    id?: string
    force?: boolean
  }) => invokeAgentRuntime('agent:startWechatLogin', payload),
  getWechatLoginStatus: (payload: {
    channelId: string
    sessionKey?: string
  }) => invokeAgentRuntime('agent:getWechatLoginStatus', payload),
  submitWechatLoginVerifyCode: (payload: {
    channelId: string
    sessionKey: string
    code: string
  }) => invokeAgentRuntime('agent:submitWechatLoginVerifyCode', payload),
  deleteChannel: (id: string) => invokeAgentRuntime('agent:deleteChannel', { id }),
  setChannelEnabled: (id: string, enabled: boolean) =>
    invokeAgentRuntime('agent:setChannelEnabled', { id, enabled }),
  sendChannelProbe: (id: string, text: string) =>
    invokeAgentRuntime('agent:sendChannelProbe', { id, text }),
  // Stage V V3.2 — push payloads carry `sessionId: string | null`
  // (not optional). null = global event (not session-scoped); a string
  // means the event belongs to a specific session and renderer routes by it.
  onStream: (callback: (data: {
    agent: string
    sessionId: string | null
    runId?: string
    chunk: string
    type: string
    canonicalMessage?: CanonicalAssistantMessage | null
    canonicalMessageDigest?: string | null
  }) => void) => {
    const handler = (_: unknown, data: {
      agent: string
      sessionId: string | null
      runId?: string
      chunk: string
      type: string
      canonicalMessage?: CanonicalAssistantMessage | null
      canonicalMessageDigest?: string | null
    }) => callback(data)
    ipcRenderer.on('agent:stream', handler)
    return () => { ipcRenderer.removeListener('agent:stream', handler) }
  },
  onStatusChange: (callback: (data: { agent: string; sessionId: string | null; runId?: string; status: string; isMock: boolean }) => void) => {
    const handler = (_: unknown, data: { agent: string; sessionId: string | null; runId?: string; status: string; isMock: boolean }) => callback(data)
    ipcRenderer.on('agent:status', handler)
    return () => { ipcRenderer.removeListener('agent:status', handler) }
  },
  onError: (callback: (data: { agent: string; sessionId: string | null; runId?: string; error: string; type: string; errorKind?: string; recoverable?: boolean; toolName?: string }) => void) => {
    const handler = (_: unknown, data: { agent: string; sessionId: string | null; runId?: string; error: string; type: string; errorKind?: string; recoverable?: boolean; toolName?: string }) => callback(data)
    ipcRenderer.on('agent:error', handler)
    return () => { ipcRenderer.removeListener('agent:error', handler) }
  },
  onToolAction: (callback: (data: { agent?: string; sessionId: string | null; runId?: string; tool: string; args: Record<string, unknown> }) => void) => {
    const handler = (_: unknown, data: { agent?: string; sessionId: string | null; runId?: string; tool: string; args: Record<string, unknown> }) => callback(data)
    ipcRenderer.on('agent:toolAction', handler)
    return () => { ipcRenderer.removeListener('agent:toolAction', handler) }
  },
  onToolActionRequest: (callback: (data: { requestId: string; agent?: string; sessionId: string | null; runId?: string; tool: string; args: Record<string, unknown> }) => void) => {
    const handler = (_: unknown, data: { requestId: string; agent?: string; sessionId: string | null; runId?: string; tool: string; args: Record<string, unknown> }) => callback(data)
    ipcRenderer.on('agent:toolActionRequest', handler)
    return () => { ipcRenderer.removeListener('agent:toolActionRequest', handler) }
  },
  onCancelToolActionRequest: (callback: (data: { requestIds: string[]; agent?: string; sessionId: string | null }) => void) => {
    const handler = (_: unknown, data: { requestIds: string[]; agent?: string; sessionId: string | null }) => callback(data)
    ipcRenderer.on('agent:cancelToolActionRequest', handler)
    return () => { ipcRenderer.removeListener('agent:cancelToolActionRequest', handler) }
  },
  completeToolActionRequest: (payload: {
    requestId: string
    handled: boolean
    payload?: Record<string, unknown>
    error?: string
  }) => invokeAgentRuntime('agent:completeToolActionRequest', payload),
  // Stage V V3.2 — sessionId field surfaced on the wire payload. unknown
  // shape retained for forward compat (renderer narrows further), but
  // callers may always read `data.sessionId` per V3.2 contract.
  onConversationEvent: (callback: (data: { sessionId: string | null } & Record<string, unknown>) => void) => {
    const handler = (_: unknown, data: unknown) =>
      callback(data as { sessionId: string | null } & Record<string, unknown>)
    ipcRenderer.on('agent:conversationEvent', handler)
    return () => { ipcRenderer.removeListener('agent:conversationEvent', handler) }
  },
  onScopeRunEvent: (callback: (data: { sessionId: string | null } & Record<string, unknown>) => void) => {
    const handler = (_: unknown, data: unknown) =>
      callback(data as { sessionId: string | null } & Record<string, unknown>)
    ipcRenderer.on('agent:scopeRunEvent', handler)
    return () => { ipcRenderer.removeListener('agent:scopeRunEvent', handler) }
  },
  // Stage U PR U2.1 — projection sync failure diagnostic event.
  // Fires when the runtime's fire-and-forget syncTaskProjection() rejects,
  // so renderer diagnose UI can show the failure instead of pretending
  // sync went through.
  onProjectionSyncFailed: (callback: (data: { scopeId: string; sessionId: string | null; taskId: string | null; reason: string; timestamp: string }) => void) => {
    const handler = (_: unknown, data: unknown) => callback(data as { scopeId: string; sessionId: string | null; taskId: string | null; reason: string; timestamp: string })
    ipcRenderer.on('agent:projectionSyncFailed', handler)
    return () => { ipcRenderer.removeListener('agent:projectionSyncFailed', handler) }
  },
  // Phase 5.3 — subscribe to reference-skill hint state changes pushed by
  // main. Renderer uses this to refresh the "上下文已启用" badge immediately
  // instead of relying on next scope-run tick.
  onReferenceSkillHintChanged: (callback: (data: { scopeId: string; sessionId: string | null; change: 'armed' | 'cleared' }) => void) => {
    const handler = (_: unknown, data: unknown) => callback(data as { scopeId: string; sessionId: string | null; change: 'armed' | 'cleared' })
    ipcRenderer.on('agent:referenceSkillHintChanged', handler)
    return () => { ipcRenderer.removeListener('agent:referenceSkillHintChanged', handler) }
  },
  // Stage O §0.4 — push notification when the main-side
  // `task_projections` table mutates. Renderer subscribes once per scope
  // window and uses the payload's scopeId to decide whether to refetch
  // projections via `agent:listTaskProjections`. The 2-second
  // `agent:listActiveChildRuns` polling timer is retired in §1.1.
  onTaskProjectionsChanged: (
    callback: (data: { scopeId: string; sessionId: string | null; changedTaskIds: string[]; reason: 'create' | 'update' | 'delete' | 'supersede' }) => void,
  ) => {
    const handler = (_: unknown, data: unknown) =>
      callback(data as { scopeId: string; sessionId: string | null; changedTaskIds: string[]; reason: 'create' | 'update' | 'delete' | 'supersede' })
    ipcRenderer.on('agent:taskProjectionsChanged', handler)
    return () => { ipcRenderer.removeListener('agent:taskProjectionsChanged', handler) }
  },
}

// P0-4 (2026-07-02 P0 visibility batch) — read-only run quality stats.
const runQualityAPI = {
  stats: () => invokeAgentRuntime('agent:runQuality:stats'),
}

// D5 后端切片 (2026-07-03) — per-run 用户反馈（评分/信号/评论）。
const runFeedbackAPI = {
  submit: (payload: unknown) => invokeAgentRuntime('agent:runFeedback:submit', payload),
  list: (options?: unknown) => invokeAgentRuntime('agent:runFeedback:list', options),
}

// 梯队三 (2026-07-03) — emergence feed（拉取式组装，四类卡）。
const emergenceAPI = {
  feed: () => invokeAgentRuntime('agent:emergence:feed'),
}

// Browser API
const browserAPI = {
  createTab: (url: string, options?: { background?: boolean }) =>
    ipcRenderer.invoke('browser:createTab', url, options),
  registerDormantTabs: (request: import('../shared/browser-tab-session').RegisterDormantBrowserTabsRequest) =>
    ipcRenderer.invoke('browser:registerDormantTabs', request),
  openForCaptureTarget: (url: string) => ipcRenderer.invoke('browser:openForCaptureTarget', url),
  closeTab: (tabId: string) => ipcRenderer.invoke('browser:closeTab', tabId),
  switchTab: (tabId: string) => ipcRenderer.invoke('browser:switchTab', tabId),
  navigate: (tabId: string, url: string) => ipcRenderer.invoke('browser:navigate', { tabId, url }),
  reorderTabs: (tabIds: string[]) => ipcRenderer.invoke('browser:reorderTabs', tabIds),
  goBack: (tabId: string) => ipcRenderer.invoke('browser:goBack', tabId),
  goForward: (tabId: string) => ipcRenderer.invoke('browser:goForward', tabId),
  reload: (tabId: string) => ipcRenderer.invoke('browser:reload', tabId),
  // Stage X4 PR-shell-1 — BrowserViewIntent boundary. Renderer pushes
  // declarative intents; main is the single decision point. Replaces
  // direct `updateBounds/hideAll/showActive/hideActiveHost` calls.
  sendIntent: (intent: BrowserViewIntent) => {
    ipcRenderer.send(BROWSER_VIEW_INTENT_CHANNEL, intent)
    return { success: true as const }
  },
  onIntentAck: (callback: (ack: BrowserViewIntentAck) => void) => {
    const handler = (_: IpcRendererEvent, ack: BrowserViewIntentAck): void => callback(ack)
    // Literal channel name — keep in sync with BROWSER_VIEW_INTENT_ACK_CHANNEL
    // (the IPC contract gate's literal-PUSH scanner requires a literal here).
    ipcRenderer.on('browser:intent-ack', handler)
    return () => ipcRenderer.removeListener('browser:intent-ack', handler)
  },
  fitActiveTabToBounds: (tabId?: string | null) => ipcRenderer.invoke('browser:fitActiveTabToBounds', tabId),
  uploadLocalMediaFiles: (payload: { tabId?: string | null; files: string[]; x?: number; y?: number }) =>
    ipcRenderer.invoke('browser:uploadLocalMediaFiles', payload),
  onLocalMediaUploadStatus: (callback: (data: { tabId?: string; status: { kind: 'uploading' | 'success' | 'error'; message: string } | null }) => void) => {
    const handler = (_event: unknown, data: { tabId?: string; status: { kind: 'uploading' | 'success' | 'error'; message: string } | null }) => callback(data)
    ipcRenderer.on('browser:localMediaUploadStatus', handler)
    return () => ipcRenderer.removeListener('browser:localMediaUploadStatus', handler)
  },
  captureWindowSnapshot: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('browser:captureWindowSnapshot', bounds),
  captureViewportSnapshot: (tabId?: string | null) => ipcRenderer.invoke('browser:captureViewportSnapshot', tabId),
  getTabs: () => ipcRenderer.invoke('browser:getTabs'),
  getAdblockState: () => ipcRenderer.invoke('browser:getAdblockState'),
  getDiagnostics: (options?: { includePerformance?: boolean }) => ipcRenderer.invoke('browser:getDiagnostics', options),
  // Agent-browser supervision: one-step takeover + task listing.
  getAgentSupervisionState: () => ipcRenderer.invoke('browser:getAgentSupervisionState'),
  requestAgentInterruption: () => ipcRenderer.invoke('browser:requestAgentInterruption'),
  onAgentControlChanged: (callback: (data: { state: string; takeoverError?: string | null }) => void) => {
    const handler = (_event: unknown, data: { state: string; takeoverError?: string | null }) => callback(data)
    ipcRenderer.on('browser:agentControlChanged', handler)
    return () => ipcRenderer.removeListener('browser:agentControlChanged', handler)
  },
  onLeaseChanged: (callback: (data: {
    claims?: Array<Record<string, unknown>>
    surfaces?: Record<string, unknown>
    activeWriteSurface?: string | null
  }) => void) => {
    const handler = (_event: unknown, data: {
      claims?: Array<Record<string, unknown>>
      surfaces?: Record<string, unknown>
      activeWriteSurface?: string | null
    }) => callback(data)
    ipcRenderer.on('browser:leaseChanged', handler)
    return () => ipcRenderer.removeListener('browser:leaseChanged', handler)
  },
  setAdblockEnabled: (enabled: boolean, scope?: 'main' | 'preview' | 'all') =>
    ipcRenderer.invoke('browser:setAdblockEnabled', { enabled, scope }),
  toggleAdblockDomain: (domain: string) => ipcRenderer.invoke('browser:toggleAdblockDomain', { domain }),
  getTabContext: (tabId?: string) => ipcRenderer.invoke('browser:getTabContext', tabId),
  previewOpen: (payload: { url: string }) => ipcRenderer.invoke('browser:previewOpen', payload),
  previewNavigate: (payload: { url: string }) => ipcRenderer.invoke('browser:previewNavigate', payload),
  previewGoBack: () => ipcRenderer.invoke('browser:previewGoBack'),
  previewGoForward: () => ipcRenderer.invoke('browser:previewGoForward'),
  previewReload: () => ipcRenderer.invoke('browser:previewReload'),
  previewUpdateBounds: (bounds: { x: number; y: number; width: number; height: number }) => {
    ipcRenderer.send('browser:previewUpdateBounds', bounds)
    return Promise.resolve({ success: true })
  },
  previewClose: () => ipcRenderer.invoke('browser:previewClose'),
  previewGetState: () => ipcRenderer.invoke('browser:previewGetState'),
  p7cLiveProofStartUserViewLease: () => ipcRenderer.invoke('browser:p7cLiveProofStartUserViewLease'),
  p7cLiveProofCreateManualTab: () => ipcRenderer.invoke('browser:p7cLiveProofCreateManualTab'),
  p7cLiveProofPrepareForegroundProbe: () => ipcRenderer.invoke('browser:p7cLiveProofPrepareForegroundProbe'),
  p7cLiveProofSampleActiveTabState: () => ipcRenderer.invoke('browser:p7cLiveProofSampleActiveTabState'),
  p7cLiveProofSendUserKey: (key?: string) => ipcRenderer.invoke('browser:p7cLiveProofSendUserKey', key),
  p7cLiveProofAgentClick: (x?: number, y?: number) =>
    ipcRenderer.invoke('browser:p7cLiveProofAgentClick', x, y),
  p7cLiveProofFinishAgentAction: (phase?: 'finish' | 'abort') =>
    ipcRenderer.invoke('browser:p7cLiveProofFinishAgentAction', phase),
  p7cLiveProofCheckWriteDenied: () => ipcRenderer.invoke('browser:p7cLiveProofCheckWriteDenied'),
  p7cLiveProofClear: () => ipcRenderer.invoke('browser:p7cLiveProofClear'),
  onPreviewUpdate: (callback: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('browser:previewUpdate', handler)
    return () => ipcRenderer.removeListener('browser:previewUpdate', handler)
  },
  onTabUpdate: (callback: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('browser:tabUpdate', handler)
    return () => ipcRenderer.removeListener('browser:tabUpdate', handler)
  },
  onTabOpened: (callback: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('browser:tabOpened', handler)
    return () => ipcRenderer.removeListener('browser:tabOpened', handler)
  },
  onAdblockUpdate: (callback: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('browser:adblockUpdate', handler)
    return () => ipcRenderer.removeListener('browser:adblockUpdate', handler)
  },
  onFastCardContextAction: (callback: (data: BrowserFastCardContextActionEvent) => void) => {
    const handler = (_: unknown, data: BrowserFastCardContextActionEvent): void => callback(data)
    ipcRenderer.on('browser:fastCardContextAction', handler)
    return () => ipcRenderer.removeListener('browser:fastCardContextAction', handler)
  },
  listFastCardItems: () => ipcRenderer.invoke('browser:fastCardList'),
  addFastCardItem: (item: FastCardItem) => ipcRenderer.invoke('browser:fastCardAdd', item),
  removeFastCardItem: (id: string) => ipcRenderer.invoke('browser:fastCardRemove', id),
  clearFastCardItems: () => ipcRenderer.invoke('browser:fastCardClear'),
  translateFastCardSelection: (payload: FastCardTranslateRequest) =>
    ipcRenderer.invoke('browser:fastCardTranslateSelection', payload),
  describeFastCardImage: (payload: FastCardDescribeImageRequest) =>
    ipcRenderer.invoke('browser:fastCardDescribeImage', payload),
  resolveFastCardVideo: (payload: FastCardResolveVideoRequest) =>
    ipcRenderer.invoke('browser:fastCardResolveVideo', payload),
  showFastCardOverlay: (payload: FastCardOverlaySnapshot) =>
    ipcRenderer.invoke('browser:fastCardOverlayShow', payload),
  hideFastCardOverlay: () =>
    ipcRenderer.invoke('browser:fastCardOverlayHide'),
  getFastCardOverlaySnapshot: () =>
    ipcRenderer.invoke('browser:fastCardOverlayGetSnapshot'),
  sendFastCardOverlayCommand: (command: FastCardOverlayCommand) =>
    ipcRenderer.invoke('browser:fastCardOverlayCommand', command),
  onFastCardOverlayCommand: (callback: (command: FastCardOverlayCommand) => void) => {
    const handler = (_: unknown, command: FastCardOverlayCommand): void => callback(command)
    ipcRenderer.on('browser:fastCardOverlayCommand', handler)
    return () => ipcRenderer.removeListener('browser:fastCardOverlayCommand', handler)
  },
  onFastCardOverlaySnapshot: (callback: (snapshot: FastCardOverlaySnapshot) => void) => {
    const handler = (_: unknown, snapshot: FastCardOverlaySnapshot): void => callback(snapshot)
    ipcRenderer.on('browser:fastCardOverlaySnapshot', handler)
    return () => ipcRenderer.removeListener('browser:fastCardOverlaySnapshot', handler)
  },
  showVerticalRailOverlay: (payload: VerticalRailOverlaySnapshot) =>
    ipcRenderer.invoke('browser:verticalRailOverlayShow', payload),
  hideVerticalRailOverlay: () =>
    ipcRenderer.invoke('browser:verticalRailOverlayHide'),
  getVerticalRailOverlaySnapshot: () =>
    ipcRenderer.invoke('browser:verticalRailOverlayGetSnapshot'),
  isVerticalRailOverlayPointerInside: () =>
    ipcRenderer.invoke('browser:verticalRailOverlayPointerInside'),
  sendVerticalRailOverlayCommand: (command: VerticalRailOverlayCommand) =>
    ipcRenderer.invoke('browser:verticalRailOverlayCommand', command),
  onVerticalRailOverlayCommand: (callback: (command: VerticalRailOverlayCommand) => void) => {
    const handler = (_: unknown, command: VerticalRailOverlayCommand): void => callback(command)
    ipcRenderer.on('browser:verticalRailOverlayCommand', handler)
    return () => ipcRenderer.removeListener('browser:verticalRailOverlayCommand', handler)
  },
  onVerticalRailOverlaySnapshot: (callback: (snapshot: VerticalRailOverlaySnapshot) => void) => {
    const handler = (_: unknown, snapshot: VerticalRailOverlaySnapshot): void => callback(snapshot)
    ipcRenderer.on('browser:verticalRailOverlaySnapshot', handler)
    return () => ipcRenderer.removeListener('browser:verticalRailOverlaySnapshot', handler)
  },
  showBrowserLockOverlay: (payload: BrowserLockOverlaySnapshot) =>
    ipcRenderer.invoke('browser:lockOverlayShow', payload),
  hideBrowserLockOverlay: () =>
    ipcRenderer.invoke('browser:lockOverlayHide'),
  dismissBrowserLockOverlay: () =>
    ipcRenderer.invoke('browser:lockOverlayDismiss'),
  getBrowserLockOverlaySnapshot: () =>
    ipcRenderer.invoke('browser:lockOverlayGetSnapshot'),
  onBrowserLockOverlaySnapshot: (callback: (snapshot: BrowserLockOverlaySnapshot) => void) => {
    const handler = (_: unknown, snapshot: BrowserLockOverlaySnapshot): void => callback(snapshot)
    ipcRenderer.on('browser:lockOverlaySnapshot', handler)
    return () => ipcRenderer.removeListener('browser:lockOverlaySnapshot', handler)
  },
  getBrowserAgentPointerSnapshot: () =>
    ipcRenderer.invoke('browser:agentPointerGetSnapshot'),
  onBrowserAgentPointerSnapshot: (callback: (snapshot: BrowserAgentPointerSnapshot) => void) => {
    const handler = (_: unknown, snapshot: BrowserAgentPointerSnapshot): void => callback(snapshot)
    ipcRenderer.on('browser:agentPointerSnapshot', handler)
    return () => ipcRenderer.removeListener('browser:agentPointerSnapshot', handler)
  },

  // Bookmarks
  addBookmark: (url: string, title: string, favicon?: string) =>
    ipcRenderer.invoke('browser:addBookmark', { url, title, favicon }),
  removeBookmark: (url: string) => ipcRenderer.invoke('browser:removeBookmark', url),
  getBookmarks: () => ipcRenderer.invoke('browser:getBookmarks'),
  isBookmarked: (url: string) => ipcRenderer.invoke('browser:isBookmarked', url),
  importBookmarks: () => ipcRenderer.invoke('browser:importBookmarks'),
  exportBookmarks: () => ipcRenderer.invoke('browser:exportBookmarks'),
  // P1.4 — obsidian-web-clip current tab. Renderer-only entry point;
  // there is intentionally no matching model-facing tool. See SKILL.md.
  clipCurrentTab: (args?: {
    tab_id?: string | null
    preset?: string | null
    preset_file?: string | null
    output_subdir?: string | null
    flatten_path?: boolean
    preserve_pagination?: boolean
    force_render_with_placeholders?: boolean
    target_hint?: string
    target_dir?: string
  }) => ipcRenderer.invoke('browser:clipCurrentTab', args ?? {}),
  onClipCurrentTabRequested: (callback: (data: { url?: string }) => void) => {
    const handler = (_: unknown, data: unknown): void => callback((data || {}) as { url?: string })
    ipcRenderer.on('browser:clipCurrentTabRequested', handler)
    return () => ipcRenderer.removeListener('browser:clipCurrentTabRequested', handler)
  },
  // Drag-tab-to-FileTree background clip. invoke acks immediately with
  // taskId; progress streams via onClipBackgroundUpdate. Not routed through
  // the agent loop. See ipc-clip-dragged-tab.ts.
  clipDraggedTab: (args: {
    url: string
    title?: string
    preset?: string | null
    preset_file?: string | null
    output_subdir?: string | null
    flatten_path?: boolean
    force_render_with_placeholders?: boolean
    target_hint?: string
    target_dir?: string
    client_task_id?: string
  }) => ipcRenderer.invoke('browser:clipDraggedTab', args),
  onClipBackgroundUpdate: (callback: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('clip:backgroundUpdate', handler)
    return () => ipcRenderer.removeListener('clip:backgroundUpdate', handler)
  },
  // Drag-tab-to-FileTree "内容学习" pipeline. invoke acks immediately with
  // both clipTaskId and studyTaskId; clip progress streams via the existing
  // `clip:backgroundUpdate`, study-phase progress streams via
  // `clip:contentStudyUpdate`. See ipc-content-study-dragged-tab.ts.
  contentStudyDraggedTab: (args: {
    url: string
    title?: string
    target_hint?: string
    target_dir?: string
    client_task_id_clip?: string
    client_task_id_study?: string
  }) => ipcRenderer.invoke('browser:contentStudyDraggedTab', args),
  onContentStudyUpdate: (callback: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('clip:contentStudyUpdate', handler)
    return () => ipcRenderer.removeListener('clip:contentStudyUpdate', handler)
  },
  onBookmarksChanged: (callback: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('browser:bookmarksChanged', handler)
    return () => ipcRenderer.removeListener('browser:bookmarksChanged', handler)
  },

  // History
  getHistory: (limit?: number) => ipcRenderer.invoke('browser:getHistory', limit),
  clearHistory: () => ipcRenderer.invoke('browser:clearHistory'),
  searchHistory: (query: string) => ipcRenderer.invoke('browser:searchHistory', query),

  // Downloads
  getDownloads: () => ipcRenderer.invoke('browser:getDownloads'),
  clearDownloads: () => ipcRenderer.invoke('browser:clearDownloads'),
  downloadUrlToDirectory: (payload: {
    url: string
    targetDir: string
    sourcePageUrl?: string | null
    suggestedName?: string | null
    downloadHeaders?: Record<string, string> | null
  }) => ipcRenderer.invoke('browser:downloadUrlToDirectory', payload),
  onDownloadUpdate: (callback: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('browser:downloadUpdate', handler)
    return () => ipcRenderer.removeListener('browser:downloadUpdate', handler)
  },

  // Privacy — clear browsing data & cookie management (persist:browser partition)
  getPrivacySummary: () => ipcRenderer.invoke('browser:getPrivacySummary'),
  clearBrowsingData: (payload: { dataTypes: string[]; sinceEpochSeconds?: number }) =>
    ipcRenderer.invoke('browser:clearBrowsingData', payload),
  listCookies: () => ipcRenderer.invoke('browser:listCookies'),
  removeCookie: (payload: { domain: string; path: string; name: string; secure: boolean }) =>
    ipcRenderer.invoke('browser:removeCookie', payload),
  removeCookiesForDomain: (payload: { domain: string }) =>
    ipcRenderer.invoke('browser:removeCookiesForDomain', payload),

  showUtilityMenu: (payload: BrowserUtilityMenuRequest) => ipcRenderer.invoke('browser:showUtilityMenu', payload),

  // Print
  print: (tabId: string) => ipcRenderer.invoke('browser:print', tabId)
}

// Document API
const documentAPI = {
  registerOperationSync: () => ipcRenderer.invoke('document:registerOperationSync'),
  onOperationSync: (callback: (payload: { requestId: string; request: DocumentSyncRequest }) => void) => {
    const listener = (_event: IpcRendererEvent, payload: { requestId: string; request: DocumentSyncRequest }) => callback(payload)
    ipcRenderer.on('document:operationSync', listener)
    return () => ipcRenderer.removeListener('document:operationSync', listener)
  },
  replyOperationSync: (requestId: string, reply: DocumentSyncReply) => ipcRenderer.send('document:operationSyncReply', { requestId, reply }),
  readFile: (path: string) => ipcRenderer.invoke('document:read', path),
  writeFile: (path: string, content: string) => ipcRenderer.invoke('document:write', { path, content }),
  saveFileAs: (payload: { content?: string; contentBase64?: string; suggestedName?: string; defaultPath?: string | null }) =>
    ipcRenderer.invoke('document:saveAs', payload),
  listFiles: (dir: string) => ipcRenderer.invoke('document:list', dir),
  parseDocx: (path: string) => ipcRenderer.invoke('document:parseDocx', path),
  parseXlsx: (path: string) => ipcRenderer.invoke('document:parseXlsx', path),
  importEbookAsMarkdown: (payload: { sourcePath: string }) =>
    ipcRenderer.invoke('document:importEbookAsMarkdown', payload),
  // File management
  mkdir: (path: string) => ipcRenderer.invoke('document:mkdir', path),
  rename: (oldPath: string, newPath: string) => ipcRenderer.invoke('document:rename', { oldPath, newPath }),
  deleteItem: (path: string) => ipcRenderer.invoke('document:deletePermanent', path),
  copyItem: (src: string, dest: string) => ipcRenderer.invoke('document:copy', { src, dest }),
  moveItem: (src: string, dest: string) => ipcRenderer.invoke('document:move', { src, dest }),
  stat: (path: string) => ipcRenderer.invoke('document:stat', path),
  openFolder: (payload?: { validateAsWorkspace?: boolean; title?: string }) =>
    ipcRenderer.invoke('document:openFolder', payload),
  exportWorkspace: (payload: { name: string; folders: string[] }) =>
    ipcRenderer.invoke('document:exportWorkspace', payload),
  importWorkspace: () => ipcRenderer.invoke('document:importWorkspace'),
  exportPdf: (payload: { html: string; suggestedName?: string; sourcePath?: string | null }) =>
    ipcRenderer.invoke('document:exportPdf', payload),
  exportMarkdownBundle: (payload: { content: string; sourcePath?: string | null; suggestedName?: string }) =>
    ipcRenderer.invoke('document:exportMarkdownBundle', payload),
  getHome: () => ipcRenderer.invoke('document:getHome'),
  showInFolder: (path: string) => ipcRenderer.invoke('document:showInFolder', path),
  openPath: (path: string) => ipcRenderer.invoke('document:openPath', path),
  createFile: (path: string) => ipcRenderer.invoke('document:createFile', path),
  watchDirectories: (paths: string[]) => ipcRenderer.invoke('document:watchDirectories', { paths }),
  onDirectoryChange: (callback: (data: { paths: string[]; timestamp: number }) => void) => {
    const handler = (_: unknown, data: { paths: string[]; timestamp: number }) => callback(data)
    ipcRenderer.on('document:directoryChanged', handler)
    return () => { ipcRenderer.removeListener('document:directoryChanged', handler) }
  },
  onIndexChanged: (callback: (event: DocumentIndexChangedEvent) => void) => {
    const handler = (_: IpcRendererEvent, event: DocumentIndexChangedEvent): void => callback(event)
    ipcRenderer.on('document:indexChanged', handler)
    return () => { ipcRenderer.removeListener('document:indexChanged', handler) }
  },
  onWatcherFailed: (callback: (event: DocumentWatcherFailedEvent) => void) => {
    const handler = (_: IpcRendererEvent, event: DocumentWatcherFailedEvent): void => callback(event)
    ipcRenderer.on('document:watcherFailed', handler)
    return () => { ipcRenderer.removeListener('document:watcherFailed', handler) }
  },
  notifyWidgetCommitted: (payload: { tabId: string; widgetId: string; requestId?: string; committedAt: number }) => {
    ipcRenderer.send('document:widgetCommitted', payload)
  },
  reindexWorkspace: (root: string) => ipcRenderer.invoke('document:reindexWorkspace', root),
  indexDocument: (payload: { path: string; root?: string; content?: string }) =>
    ipcRenderer.invoke('document:indexDocument', payload),
  searchIndex: (payload: {
    query: string
    limit?: number
    workspaceRoot?: string
    workspaceRoots?: string[]
    sources?: string[]
  }) => ipcRenderer.invoke('document:searchIndex', payload),
  reindexAllSources: (root: string) => ipcRenderer.invoke('document:reindexAllSources', root),
  listSources: () => ipcRenderer.invoke('document:listSources'),
  getBacklinks: (payload: { path: string; limit?: number }) =>
    ipcRenderer.invoke('document:getBacklinks', payload),
  getObjectOutgoingLinks: (payload: ObjectLinkQuery) => ipcRenderer.invoke('document:getObjectOutgoingLinks', payload),
  getObjectIncomingLinks: (payload: ObjectLinkQuery) => ipcRenderer.invoke('document:getObjectIncomingLinks', payload),
  getGraph: (payload?: { centerPath?: string; depth?: number; workspaceRoot?: string }) =>
    ipcRenderer.invoke('document:getGraph', payload),
  listMarks: (payload: { documentPath: string }) =>
    ipcRenderer.invoke('document:listMarks', payload),
  createMark: (payload: unknown) =>
    ipcRenderer.invoke('document:createMark', payload),
  updateMark: (payload: { id: string; patch: unknown }) =>
    ipcRenderer.invoke('document:updateMark', payload),
  deleteMark: (payload: { id: string }) =>
    ipcRenderer.invoke('document:deleteMark', payload),
  // perf-rescue B7 — chokidar watcher for delta incremental indexing.
  startWatcher: (payload: { workspaceRoot: string }) =>
    ipcRenderer.invoke('document:startWatcher', payload),
  stopWatcher: (payload: { watcherId: string }) =>
    ipcRenderer.invoke('document:stopWatcher', payload),
}



// RSS API
const rssAPI = {
  readExcerpt: (input: import('../shared/rss-excerpt').RSSReadExcerptInput) => ipcRenderer.invoke('rss:readExcerpt', input),
  readDigests: (input?: import('../shared/rss-digests').RSSDigestReadInput) => ipcRenderer.invoke('rss:readDigests', input),
  digestSettings: () => ipcRenderer.invoke('rss:digestSettings'),
  configureDigests: (input: import('../shared/rss-digests').RSSDigestSettings) => ipcRenderer.invoke('rss:configureDigests', input),
  generateDigest: (input: import('../shared/rss-digests').RSSDigestGenerateInput) => ipcRenderer.invoke('rss:generateDigest', input),
  exportDigest: (input: { reportId: string }) => ipcRenderer.invoke('rss:exportDigest', input),
  onDigestsChanged: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('rss:digestsChanged', handler)
    return () => ipcRenderer.removeListener('rss:digestsChanged', handler)
  },
  markEventFactsSeen: (input: { factIds: string[] }) => ipcRenderer.invoke('rss:markEventFactsSeen', input),
  onEventSeenChanged: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('rss:eventSeenChanged', handler)
    return () => ipcRenderer.removeListener('rss:eventSeenChanged', handler)
  },
  queryCards: (query?: import('../shared/rss-workspace').RSSQueryInput) => ipcRenderer.invoke('rss:queryCards', query),
  readEvents: (input?: import('../shared/rss-events').RSSReadEventsInput) => ipcRenderer.invoke('rss:readEvents', input),
  moveEventMember: (input: import('../shared/rss-events').RSSEventMoveInput) => ipcRenderer.invoke('rss:moveEventMember', input),
  mergeEvents: (input: import('../shared/rss-events').RSSEventMergeInput) => ipcRenderer.invoke('rss:mergeEvents', input),
  processingStatus: () => ipcRenderer.invoke('rss:processingStatus'),
  processingJobs: (input?: import('../shared/rss-processing').RSSProcessingListInput) => ipcRenderer.invoke('rss:processingJobs', input),
  configureProcessing: (input: import('../shared/rss-processing').RSSProcessingSettings) => ipcRenderer.invoke('rss:configureProcessing', input),
  reprocessArticle: (input: { itemId: string; expectedArticleRevision: string }) => ipcRenderer.invoke('rss:reprocessArticle', input),
  retryUnresolvedProcessing: (input: { expectedCount: number }) => ipcRenderer.invoke('rss:retryUnresolvedProcessing', input),
  cancelProcessing: (id: string) => ipcRenderer.invoke('rss:cancelProcessing', id),
  resumeProcessing: () => ipcRenderer.invoke('rss:resumeProcessing'),
  getDefinitions: () => ipcRenderer.invoke('rss:getDefinitions'),
  saveDefinition: (input: import('../shared/rss-organization').RSSDefinitionWrite) => ipcRenderer.invoke('rss:saveDefinition', input),
  removeDefinition: (input: { id: string; expectedRevision: number }) => ipcRenderer.invoke('rss:removeDefinition', input),
  setMembership: (input: import('../shared/rss-organization').RSSMembershipWrite) => ipcRenderer.invoke('rss:setMembership', input),
  onOrganizationChanged: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('rss:organizationChanged', handler)
    return () => ipcRenderer.removeListener('rss:organizationChanged', handler)
  },
  saveArticleNote: (input: import('../shared/rss-workspace').RSSSaveNoteInput) => ipcRenderer.invoke('rss:saveArticleNote', input),
  exportQuery: (input: import('../shared/rss-workspace').RSSQueryInput) => ipcRenderer.invoke('rss:exportQuery', input),
  queryItems: (query?: unknown) => ipcRenderer.invoke('rss:queryItems', query),
  dismissQuery: (input: import('../shared/rss-workspace').RSSQueryInput) => ipcRenderer.invoke('rss:dismissQuery', input),
  readArticle: (input: unknown) => ipcRenderer.invoke('rss:readArticle', input),
  loadArticle: (input: unknown) => ipcRenderer.invoke('rss:loadArticle', input),
  translateArticle: (input: import('../shared/rss-translation').RSSTranslateArticleInput) => ipcRenderer.invoke('rss:translateArticle', input),
  readTranslation: (input: import('../shared/rss-translation').RSSTranslationRef) => ipcRenderer.invoke('rss:readTranslation', input),
  cancelTranslation: (input: import('../shared/rss-translation').RSSTranslationRef) => ipcRenderer.invoke('rss:cancelTranslation', input),
  onTranslationChanged: (callback: (ref: import('../shared/rss-translation').RSSTranslationRef) => void) => {
    const handler = (_event: unknown, ref: import('../shared/rss-translation').RSSTranslationRef) => callback(ref)
    ipcRenderer.on('rss:translationChanged', handler)
    return () => ipcRenderer.removeListener('rss:translationChanged', handler)
  },
  getSources: () => ipcRenderer.invoke('rss:getSources'),
  addSource: (source: unknown) => ipcRenderer.invoke('rss:addSource', source),
  removeSource: (id: string) => ipcRenderer.invoke('rss:removeSource', id),
  getDraftStoreSources: () => ipcRenderer.invoke('rss:getDraftStoreSources'),
  markRead: (itemId: string) => ipcRenderer.invoke('rss:markRead', itemId),
  markReadBatch: (itemIds: string[]) => ipcRenderer.invoke('rss:markReadBatch', itemIds),
  deleteItems: (payload: string[] | { itemIds: string[]; preserveStarred?: boolean }) =>
    ipcRenderer.invoke('rss:deleteItems', payload),
  toggleStarred: (itemId: string) => ipcRenderer.invoke('rss:toggleStarred', itemId),
  clearDraftStore: (payload?: { sourceId?: string }) => ipcRenderer.invoke('rss:clearDraftStore', payload),
  refreshSource: (sourceId: string) => ipcRenderer.invoke('rss:refreshSource', { sourceId }),
  fetchAll: (options?: { digest?: boolean; group?: string; sourceIds?: string[] }) =>
    ipcRenderer.invoke('rss:fetchAll', options),
  autoRefreshStatus: () => ipcRenderer.invoke('rss:autoRefreshStatus'),
  onAutoRefreshCompleted: (callback: (snapshot: RSSAutoRefreshSnapshot) => void) => {
    const handler = (_: IpcRendererEvent, snapshot: RSSAutoRefreshSnapshot): void => callback(snapshot)
    ipcRenderer.on('rss:autoRefreshCompleted', handler)
    return () => ipcRenderer.removeListener('rss:autoRefreshCompleted', handler)
  },
  status: () => ipcRenderer.invoke('rss:status'),
  stats: () => ipcRenderer.invoke('rss:stats'),
  diagnostics: () => ipcRenderer.invoke('rss:diagnostics'),
  benchmarkSources: (options?: { group?: string; sourceIds?: string[] }) =>
    ipcRenderer.invoke('rss:benchmarkSources', options),
  repairRuntime: () => ipcRenderer.invoke('rss:repairRuntime'),
  exportOpml: () => ipcRenderer.invoke('rss:exportOpml'),
  exportFeed: (type?: string) =>
    ipcRenderer.invoke('rss:exportFeed', type),
  startItemAnalysis: (payload: {
    itemId: string
    action: 'copy' | 'visual'
    link: string
    title: string
    targetDir: string
    source?: string
    summary?: string
    publishedAt?: string
    force?: boolean
  }) => ipcRenderer.invoke('rss:startItemAnalysis', payload),
  getItemAnalysisProgress: (payload?: { itemIds?: string[] }) =>
    ipcRenderer.invoke('rss:getItemAnalysisProgress', payload),
  listItemAnalysisJobs: (payload?: { itemId?: string; limit?: number }) =>
    ipcRenderer.invoke('rss:listItemAnalysisJobs', payload),
  pauseAnalysisJob: (payload: { jobId: string }) => ipcRenderer.invoke('rss:pauseAnalysisJob', payload),
  resumeAnalysisJob: (payload: { jobId: string }) => ipcRenderer.invoke('rss:resumeAnalysisJob', payload),
  deleteAnalysisJob: (payload: { jobId: string }) => ipcRenderer.invoke('rss:deleteAnalysisJob', payload),
}

// Calendar API
//
// L2-B-Reminder-UI — `onReminderFired` subscribes to the
// `calendar:reminderFired` channel pushed by `reminder-notifier.ts` in
// main when a scheduled reminder triggers. Returns an unsubscriber. The
// payload shape is the shared `ReminderFirePayload` (see
// `src/shared/calendar-types.ts`).
import type { ReminderFirePayload as CalendarReminderFirePayload } from '../shared/calendar-types'

const calendarAPI = {
  getAttachmentDisplayRefs: (messageIds: string[]) => ipcRenderer.invoke('calendar:getAttachmentDisplayRefs', messageIds),
  prepareStandaloneImport: () => ipcRenderer.invoke('calendar:prepareStandaloneImport'),
  applyStandaloneImport: (ticket:string,skipExamples:boolean) => ipcRenderer.invoke('calendar:applyStandaloneImport',ticket,skipExamples),
  revealEvent: (id: string) => ipcRenderer.invoke('calendar:revealEvent', id),
  revealDay: (date: string) => ipcRenderer.invoke('calendar:revealDay', date),
  peekNavigation: () => ipcRenderer.invoke('calendar:peekNavigation'),
  ackNavigation: (id: string) => ipcRenderer.invoke('calendar:ackNavigation', id),
  onNavigation: (handler: () => void) => { const listener = () => handler(); ipcRenderer.on('calendar:navigationPending', listener); return () => ipcRenderer.removeListener('calendar:navigationPending', listener) },
  createMeetingNote: (input: import('../shared/calendar/event-links').MeetingNoteInput) => ipcRenderer.invoke('calendar:createMeetingNote', input),
  pendingMeetingNote: (key: string) => ipcRenderer.invoke('calendar:pendingMeetingNote', key),
  snapshot: () => ipcRenderer.invoke('calendar:snapshot'),
  mutate: (command: import('../shared/calendar/commands').CalendarCommand, versions: Record<string, number>) => ipcRenderer.invoke('calendar:mutate', command, versions),
  restore: (delta: import('../shared/calendar/commands').CalendarDelta, versions: Record<string, number>) => ipcRenderer.invoke('calendar:restore', delta, versions),
  putCalendars: (calendars: import('../shared/calendar/model').Calendar[]) => ipcRenderer.invoke('calendar:putCalendars', calendars),
  putCalendar: (calendar: import('../shared/calendar/model').Calendar) => ipcRenderer.invoke('calendar:putCalendar', calendar),
  deleteCalendar: (id: string) => ipcRenderer.invoke('calendar:deleteCalendar', id),
  putPreferences: (prefs: Record<string, unknown>) => ipcRenderer.invoke('calendar:putPreferences', prefs),
  exportIcs: (id?: string) => ipcRenderer.invoke('calendar:exportIcs', id),
  importCalendar: (raw: string, name: string, sourceId?: string) => ipcRenderer.invoke('calendar:importCalendar', raw, name, sourceId),
  openIcs: () => ipcRenderer.invoke('calendar:openIcs'),
  saveIcs: (name: string, text: string) => ipcRenderer.invoke('calendar:saveIcs', name, text),
  openLink: (url: string) => ipcRenderer.invoke('calendar:openLink', url),
  getLoginItem: () => ipcRenderer.invoke('calendar:getLoginItem'),
  setLoginItem: (enabled: boolean) => ipcRenderer.invoke('calendar:setLoginItem', enabled),
  onChanged: (handler: () => void) => { const listener = () => handler(); ipcRenderer.on('calendar:changed', listener); return () => ipcRenderer.removeListener('calendar:changed', listener) },
  getSources: () => ipcRenderer.invoke('calendar:getSources'),
  getEvents: (start: Date, end: Date, timeZone?: string) => ipcRenderer.invoke('calendar:getEvents', { start, end, timeZone }),
  subscribeUrl: (payload: {
    url: string
    name: string
    color?: string
    syncIntervalMinutes?: number
  }) => ipcRenderer.invoke('calendar:subscribeUrl', payload),
  unsubscribeSource: (sourceId: string) =>
    ipcRenderer.invoke('calendar:unsubscribeSource', sourceId),
  syncSourceNow: (sourceId: string) =>
    ipcRenderer.invoke('calendar:syncSourceNow', sourceId),
  onReminderFired: (handler: (payload: CalendarReminderFirePayload) => void) => {
    const listener = (_event: unknown, payload: CalendarReminderFirePayload) => handler(payload)
    ipcRenderer.on('calendar:reminderFired', listener)
    return () => { ipcRenderer.removeListener('calendar:reminderFired', listener) }
  },
  // L5-B — natural-language time-expression detection for the RSS
  // "create event from article" hint. `text` is the plain-text body to
  // scan (renderer is responsible for HTML stripping); `referenceDate`
  // defaults to "now" on the main side and can be set to the article's
  // `publishedAt` if older articles should resolve "tomorrow" relative
  // to when they were written rather than when read. The main handler
  // truncates inputs over 8KB.
  detectTimeExpressions: (payload: {
    text: string
    referenceDate?: string | number
  }) => ipcRenderer.invoke('calendar:detectTimeExpressions', payload),

  // L5-C-Universal — channel-agnostic "remote message → calendar event"
  // detection. Adapter / sidecar code (feishu / telegram / imessage /
  // discord / wechat / slack / generic-webhook) calls this with one
  // `RemoteChannelMessage` envelope; the main side runs chrono + applies
  // per-channel policy and returns suggestions. The renderer also
  // subscribes to `onRemoteEventSuggested` for runtime.ts-pushed
  // detections originating in the inbound-channel pipeline.
  detectRemoteChannelEvent: (payload: {
    message: import('../shared/calendar-remote-channel').RemoteChannelMessage
    autoDetectOverride?: boolean | null
    minConfidence?: 'high' | 'medium' | 'low'
  }) => ipcRenderer.invoke('calendar:detectRemoteChannelEvent', payload),
  listRemoteChannelEntries: () =>
    ipcRenderer.invoke('calendar:listRemoteChannelEntries'),
  onRemoteEventSuggested: (
    handler: (suggestion: import('../shared/calendar-remote-channel').RemoteCalendarEventSuggestion) => void,
  ) => {
    const listener = (
      _event: unknown,
      suggestion: import('../shared/calendar-remote-channel').RemoteCalendarEventSuggestion,
    ) => handler(suggestion)
    ipcRenderer.on('calendar:remoteEventSuggested', listener)
    return () => {
      ipcRenderer.removeListener('calendar:remoteEventSuggested', listener)
    }
  },
}

// Skills Runtime API
const skillsAPI = {
  list: () => ipcRenderer.invoke('skills:list'),
  runtimeInfo: () => ipcRenderer.invoke('skills:runtimeInfo'),
  listExternalCandidates: () => ipcRenderer.invoke('skills:listExternalCandidates'),
  listShellConsent: () => ipcRenderer.invoke('skills:listShellConsent'),
  setShellConsent: (payload: { skillId: string; granted: boolean }) => ipcRenderer.invoke('skills:setShellConsent', payload),
  importCustomSkill: (payload: { path: string }) => ipcRenderer.invoke('skills:importCustomSkill', payload),
  removeCustomSkill: (payload: { skillId: string }) => ipcRenderer.invoke('skills:removeCustomSkill', payload),
  updateCustomSkillDescription: (payload: { skillId: string; description: string; name?: string }) =>
    ipcRenderer.invoke('skills:updateCustomSkillDescription', payload),
  install: (payload: { skillId: string; force?: boolean }) => ipcRenderer.invoke('skills:install', payload),
  run: (payload: {
    skillId: string
    action: string
    params?: Record<string, unknown>
    timeoutMs?: number
    sessionId?: string
    executionMode?: 'auto' | 'workflow' | 'direct'
  }) => ipcRenderer.invoke('skills:run', payload),
  listJobs: (limit?: number) => ipcRenderer.invoke('skills:jobs:list', { limit }),
  getConfiguration: (payload: { skillId: string }) => ipcRenderer.invoke('skills:configuration:get', payload),
  updateConfiguration: (payload: {
    skillId: string
    serviceBindings?: Record<string, string>
    fields?: Record<string, string | number | boolean | null>
  }) => ipcRenderer.invoke('skills:configuration:update', payload),
  listModelPacks: () => ipcRenderer.invoke('modelPacks:list'),
  getModelPackStatus: (payload: { id: ModelPackId }) =>
    ipcRenderer.invoke('modelPacks:status', payload),
  startModelPackDownload: (payload: { id: ModelPackId; source?: ModelSource }) =>
    ipcRenderer.invoke('modelPacks:download', payload),
  cancelModelPackDownload: (payload: { id: ModelPackId }) =>
    ipcRenderer.invoke('modelPacks:cancel', payload),
  selfTestModelPacks: () => ipcRenderer.invoke('modelPacks:selfTest'),
  onModelPackDownloadUpdate: (handler: (update: ModelPackDownloadUpdate) => void) => {
    const listener = (_event: unknown, update: ModelPackDownloadUpdate) => handler(update)
    ipcRenderer.on('modelPacks:downloadUpdate', listener)
    return () => ipcRenderer.removeListener('modelPacks:downloadUpdate', listener)
  },
  // One-click skill-runtime provisioning (Python + ffmpeg + core deps).
  //   Named *SkillRuntime* to avoid colliding with the agent `getRuntimeStatus`.
  getSkillRuntimeStatus: (): Promise<{ success: boolean; data?: RuntimeStatus; error?: string }> =>
    ipcRenderer.invoke('runtime:status'),
  getSkillRuntimeProvisionState: (): Promise<{ success: boolean; data?: RuntimeProvisionTaskSnapshot; error?: string }> =>
    ipcRenderer.invoke('runtime:provisionState'),
  provisionSkillRuntime: (payload?: { force?: boolean }): Promise<{ success: boolean; data?: RuntimeProvisionTaskSnapshot; error?: string }> =>
    ipcRenderer.invoke('runtime:provision', payload),
  cancelSkillRuntimeProvision: (): Promise<{ success: boolean; data?: RuntimeProvisionTaskSnapshot; error?: string }> =>
    ipcRenderer.invoke('runtime:cancel'),
  getSkillRuntimeMirror: (): Promise<{ success: boolean; data?: string; error?: string }> =>
    ipcRenderer.invoke('runtime:getMirror'),
  setSkillRuntimeMirror: (payload: { mirror: string }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('runtime:setMirror', payload),
  selfTestSkillRuntime: (): Promise<{ success: boolean; data?: RuntimeStatus; error?: string }> =>
    ipcRenderer.invoke('runtime:selfTest'),
  onSkillRuntimeProvisionUpdate: (handler: (snapshot: RuntimeProvisionTaskSnapshot) => void) => {
    const listener = (_event: unknown, snapshot: RuntimeProvisionTaskSnapshot) => handler(snapshot)
    ipcRenderer.on('runtime:provisionUpdate', listener)
    return () => ipcRenderer.removeListener('runtime:provisionUpdate', listener)
  },
  // Skill-source diagnostics (reachability self-test for the agent install path).
  selfTestSkillSources: () => ipcRenderer.invoke('skills:sourcesSelfTest'),
  // Phase 4: skills:executions:* preload methods retired along with the
  // skill_executions state machine (listExecutions / getExecution /
  // submitInput / submitConfirmation / submitAgentResult / restartFromStep /
  // cancelExecution). Task card progress now lives in the in-memory todo
  // tracker + primitive projection patch.

  // B Phase 1 PR2 — ask_user: submit the user's answer to a pending ephemeral
  // question. Question metadata is pushed separately via `skill:askUserQuestion`.
  submitAskUserAnswer: (payload: { executionId: string; answer: string }) =>
    invokeAgentRuntime('skills:askUser:submit', payload),
  listPendingAskUser: () => invokeAgentRuntime('skills:askUser:pending'),
	  onAskUserQuestion: (
	    handler: (event: {
	      executionId: string
	      sessionId: string | null
	      scopeId?: string | null
	      agent?: string | null
	      requestId?: string | null
	      skillId: string | null
	      question: string
      options: string[] | null
      placeholder: string | null
      askedAt: number
    }) => void,
  ) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload)
	    ipcRenderer.on('skill:askUserQuestion', listener)
	    return () => ipcRenderer.removeListener('skill:askUserQuestion', listener)
	  },
	  onAskUserCleared: (
	    handler: (event: {
	      executionId: string
	      sessionId: string | null
	      scopeId: string | null
	      agent: string | null
	      requestId: string | null
	      reason: 'resolved' | 'rejected' | 'cleared'
	    }) => void,
	  ) => {
	    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload)
	    ipcRenderer.on('skill:askUserCleared', listener)
	    return () => ipcRenderer.removeListener('skill:askUserCleared', listener)
	  },
	  onSkillReferenceInlined: (
    handler: (event: {
      sessionId: string | null
      skillId: string
      skillName: string
      source: 'direct_read' | 'tool_fallback'
      bytesInjected: number
      truncated: boolean
      at: number
    }) => void,
  ) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload)
    ipcRenderer.on('skill:referenceInlined', listener)
    return () => ipcRenderer.removeListener('skill:referenceInlined', listener)
  },
  listSchedules: () => ipcRenderer.invoke('skills:schedules:list'),
  createSchedule: (payload: {
    skillId: string
    action: string
    params?: Record<string, unknown>
    intervalMinutes: number
    startAt?: string
  }) => ipcRenderer.invoke('skills:schedules:create', payload),
  toggleSchedule: (payload: { id: string; enabled: boolean }) =>
    ipcRenderer.invoke('skills:schedules:toggle', payload),
  deleteSchedule: (payload: { id: string }) => ipcRenderer.invoke('skills:schedules:delete', payload),
}

// App / Auto-update API
const appAPI = {
  browserLiveProofHandshake: (nonce: string) => ipcRenderer.invoke('app:browserLiveProofHandshake', nonce),
  browserLiveProofInspectFrozenCall: (payload: unknown) =>
    ipcRenderer.invoke('app:browserLiveProofInspectFrozenCall', payload),
  browserLiveProofQuit: (nonce: string) => ipcRenderer.invoke('app:browserLiveProofQuit', nonce),
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  captureWindow: () => ipcRenderer.invoke('app:captureWindow'),
  writeImageToClipboard: (payload: { path: string; text?: string }) =>
    ipcRenderer.invoke('app:writeImageToClipboard', payload),
  onUpdateStatus: (callback: (data: {
    status: string; version?: string; releaseDate?: string;
    percent?: number; bytesPerSecond?: number; transferred?: number; total?: number;
    error?: string
  }) => void) => {
    const handler = (_: unknown, data: {
      status: string; version?: string; releaseDate?: string;
      percent?: number; bytesPerSecond?: number; transferred?: number; total?: number;
      error?: string
    }): void => callback(data)
    ipcRenderer.on('update-status', handler)
    return () => ipcRenderer.removeListener('update-status', handler)
  },
  onShortcut: (callback: (data: {
    key: string
    metaKey?: boolean
    ctrlKey?: boolean
    shiftKey?: boolean
    altKey?: boolean
  }) => void) => {
    const handler = (_: unknown, data: {
      key: string
      metaKey?: boolean
      ctrlKey?: boolean
      shiftKey?: boolean
      altKey?: boolean
    }): void => callback(data)
    ipcRenderer.on('app:shortcut', handler)
    return () => ipcRenderer.removeListener('app:shortcut', handler)
  },
  onBeforeQuitFlush: (callback: (requestId: string) => void) => subscribeBeforeQuitFlush(callback),
  onBeforeQuitFlushCancelled: (callback: (requestId: string) => void) => {
    const handler = (_: IpcRendererEvent, requestId: string): void => callback(requestId)
    ipcRenderer.on('app:cancelBeforeQuitFlush', handler)
    return () => ipcRenderer.removeListener('app:cancelBeforeQuitFlush', handler)
  },
  ackBeforeQuitFlushed: (requestId: string, outcome: RendererStateFlushOutcome) => (
    ipcRenderer.send('app:beforeQuitFlushed', requestId, outcome)
  ),
  // D1: cache stats + cleanup
  getCacheStats: () => ipcRenderer.invoke('app:getCacheStats'),
  clearCache: (opts?: { includePuppeteer?: boolean }) =>
    ipcRenderer.invoke('app:clearCache', opts ?? {}),
  exportDiagnosticPack: () => ipcRenderer.invoke('app:exportDiagnosticPack'),
}

// Window API
type ThemeSkinIPC = 'liquid-glass' | 'ready-glass' | 'solid-green-glass' | 'solid-blue-glass'
interface ThemeSnapshotIPC {
  option: string
  resolved: 'light' | 'dark'
  skin: ThemeSkinIPC
  isNativeFullscreen: boolean
}

const windowAPI = {
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  refreshTransparentSurface: () => ipcRenderer.invoke('window:refreshTransparentSurface'),
  /**
   * 订阅主进程的 `window:fullscreen-changed` push。Stage 2 起会从 will-enter/leave-full-screen
   * lifecycle handlers 推送；Stage 1 阶段没有推送源，订阅了也不会收到事件，但订阅链路本身有效，
   * 不需要 Stage 2 再加新接口。
   */
  onFullscreenChanged: (listener: (isFullscreen: boolean) => void) => {
    const handler = (_event: IpcRendererEvent, isFullscreen: boolean) => {
      listener(Boolean(isFullscreen))
    }
    ipcRenderer.on('window:fullscreen-changed', handler)
    return () => ipcRenderer.removeListener('window:fullscreen-changed', handler)
  },
}

// Theme API
const themeAPI = {
  set: (theme: string) => ipcRenderer.invoke('theme:set', theme),
  /**
   * 切换玻璃风格：'liquid-glass'（真半透明，macOS 用 vibrancy under-window）/
   * 'ready-glass'（Ready 自持稳定底，不启用 vibrancy）/
   * 'solid-green-glass'（Ready 自持实色绿玻璃底）/
   * 'solid-blue-glass'（Ready 自持实色蓝玻璃底）。
   * 切换 skin **不** 触发昼夜 ritual，仅改变窗口材料与 .ready-app-bg 渐变可见性。
   */
  setSkin: (skin: ThemeSkinIPC) => ipcRenderer.invoke('theme:setSkin', skin),
  get: () => ipcRenderer.invoke('theme:get'),
  onChanged: (listener: (snapshot: ThemeSnapshotIPC) => void) => {
    const handler = (_event: IpcRendererEvent, snapshot: ThemeSnapshotIPC) => {
      listener(snapshot)
    }
    ipcRenderer.on('theme:changed', handler)
    return () => ipcRenderer.removeListener('theme:changed', handler)
  },
}

const documentImportAPI: import('../shared/document-import').DocumentImportAPI = {
  choose: kind => ipcRenderer.invoke('documentImport:choose', kind),
  preflight: (sourceId, target) => ipcRenderer.invoke('documentImport:preflight', sourceId, target),
  execute: id => ipcRenderer.invoke('documentImport:execute', id),
  resume: id => ipcRenderer.invoke('documentImport:resume', id),
  status: id => ipcRenderer.invoke('documentImport:status', id),
  list: () => ipcRenderer.invoke('documentImport:list'),
}

const sourceAnnotationsAPI: import('../main/modules/library-engine/source-document-ipc').SourceAnnotationsAPI = {
  rss: input => ipcRenderer.invoke('sourceAnnotations:rss', input),
  web: input => ipcRenderer.invoke('sourceAnnotations:web', input),
}

const documentAnnotationsAPI: import('../shared/document-comments').DocumentAnnotationsAPI = {
  comments: input => ipcRenderer.invoke('documentAnnotations:comments', input),
  synced: input => ipcRenderer.invoke('documentAnnotations:synced', input),
  templates: input => ipcRenderer.invoke('documentAnnotations:templates', input),
}

const documentPagesAPI: import('../shared/document-pages').DocumentPagesAPI = {
  tree: root => ipcRenderer.invoke('documentPages:tree', root),
  properties: id => ipcRenderer.invoke('documentPages:properties', id),
  patchProperties: (id, version, set, remove) => ipcRenderer.invoke('documentPages:patchProperties', id, version, set, remove),
  operate: input => ipcRenderer.invoke('documentPages:operate', input),
  operation: id => ipcRenderer.invoke('documentPages:operation', id),
  trash: root => ipcRenderer.invoke('documentPages:trash', root),
  order: (parent, ids) => ipcRenderer.invoke('documentPages:order', parent, ids),
  favorite: (id, value) => ipcRenderer.invoke('documentPages:favorite', id, value),
  visit: id => ipcRenderer.invoke('documentPages:visit', id),
  states: () => ipcRenderer.invoke('documentPages:states'),
  save: input => ipcRenderer.invoke('documentPages:save', input),
  onChanged: listener => {
    const handler = (_event: IpcRendererEvent, change: import('../shared/document-pages').PageChange) => listener(change)
    const indexed = (_event: IpcRendererEvent, change: DocumentIndexChangedEvent) => listener({ type: 'tree_invalidated', paths: [change.workspaceRoot] })
    const directories = (_event: IpcRendererEvent, change: { paths: string[] }) => listener({ type: 'tree_invalidated', paths: change.paths })
    ipcRenderer.on('documentPages:changed', handler)
    ipcRenderer.on('document:indexChanged', indexed)
    ipcRenderer.on('document:directoryChanged', directories)
    return () => {
      ipcRenderer.removeListener('documentPages:changed', handler)
      ipcRenderer.removeListener('document:indexChanged', indexed)
      ipcRenderer.removeListener('document:directoryChanged', directories)
    }
  },
}

const canvasAPI: import('../main/modules/board-engine/ipc').CanvasAPI = {
  create: input => ipcRenderer.invoke('canvas:create', input),
  open: id => ipcRenderer.invoke('canvas:open', id),
  read: id => ipcRenderer.invoke('canvas:read', id),
  release: id => ipcRenderer.invoke('canvas:release', id),
  write: input => ipcRenderer.invoke('canvas:write', input),
  updateBuffer: input => ipcRenderer.invoke('canvas:updateBuffer', input),
  readBuffer: id => ipcRenderer.invoke('canvas:readBuffer', id),
  saveBuffer: input => ipcRenderer.invoke('canvas:saveBuffer', input),
  prepareAttachment: path => ipcRenderer.invoke('canvas:prepareAttachment', path),
  import: input => ipcRenderer.invoke('canvas:import', input),
  onChanged: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: { root: string }) => listener(value)
    ipcRenderer.on('canvas:changed', handler)
    return () => ipcRenderer.removeListener('canvas:changed', handler)
  },
}
const canvasCompositionAPI: import('../shared/document-drafts').CanvasCompositionAPI = {
  compose: input => ipcRenderer.invoke('canvasComposition:compose', input),
  recover: () => ipcRenderer.invoke('canvasComposition:recover'),
  preview: input => ipcRenderer.invoke('canvasComposition:preview', input),
}
const fastCardAPI: import('../shared/fastcard').FastCardTransferAPI & import('../shared/fastcard').FastCardQuickNoteAPI = {
  transfer: input => ipcRenderer.invoke('fastcard:transfer', input),
  undo: id => ipcRenderer.invoke('fastcard:undo', id),
  targets: () => ipcRenderer.invoke('fastcard:targets'),
  pending: () => ipcRenderer.invoke('fastcard:pending'),
  quickClose: () => ipcRenderer.invoke('fastcard:quickClose'),
  quickStatus: () => ipcRenderer.invoke('fastcard:quickStatus'),
  quickText: input => ipcRenderer.invoke('fastcard:quickText', input),
  quickClipboard: id => ipcRenderer.invoke('fastcard:quickClipboard', id),
  quickRecording: input => ipcRenderer.invoke('fastcard:quickRecording', input),
  transcribe: id => ipcRenderer.invoke('fastcard:transcribe', id),
  playback: id => ipcRenderer.invoke('fastcard:playback', id),
}
const linkPreviewAPI = { get: (url: string) => ipcRenderer.invoke('link-preview:get', url) }

const documentDraftsAPI: import('../shared/document-drafts').DocumentDraftAPI = {
  create: (input) => ipcRenderer.invoke('documentDrafts:create', input),
  save: (id, revision, content, tabId) => ipcRenderer.invoke('documentDrafts:save', id, revision, content, tabId),
  list: tabId => ipcRenderer.invoke('documentDrafts:list', tabId),
  read: (id) => ipcRenderer.invoke('documentDrafts:read', id),
  discard: (id, revision) => ipcRenderer.invoke('documentDrafts:discard', id, revision),
  finalize: (id, revision, input) => ipcRenderer.invoke('documentDrafts:finalize', id, revision, input),
  importLegacy: (items) => ipcRenderer.invoke('documentDrafts:importLegacy', items),
}

const vaultAPI: import('../shared/vault').VaultAPI = {
  get: () => ipcRenderer.invoke('vault:get'),
  set: (path) => ipcRenderer.invoke('vault:set', path),
  createDefault: () => ipcRenderer.invoke('vault:createDefault'),
  onChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: import('../shared/vault').VaultState) => listener(state)
    ipcRenderer.on('vault:changed', handler)
    return () => ipcRenderer.removeListener('vault:changed', handler)
  },
}

const libraryArchiveAPI: LibraryArchiveAPI = {
  archiveSuggestion: () => ipcRenderer.invoke('library:archiveSuggestion'),
  pickAndImportArchive: () => ipcRenderer.invoke('library:pickAndImportArchive'),
  onArchiveProgress: listener => {
    const handler = (_event: IpcRendererEvent, progress: LibraryArchiveProgress) => listener(progress)
    ipcRenderer.on('library:archiveProgress', handler)
    return () => ipcRenderer.removeListener('library:archiveProgress', handler)
  },
}

const libraryAPI = {
  listHighlights: (input: LibraryHighlightContext): Promise<LibraryResult<LibraryHighlightState>> => ipcRenderer.invoke('library:listHighlights', input),
  createHighlight: (input: LibraryHighlightCreate): Promise<LibraryResult<LibraryHighlightState>> => ipcRenderer.invoke('library:createHighlight', input),
  updateHighlight: (input: LibraryHighlightUpdate): Promise<LibraryResult<LibraryHighlightState>> => ipcRenderer.invoke('library:updateHighlight', input),
  removeHighlight: (input: LibraryHighlightRemove): Promise<LibraryResult<LibraryHighlightState>> => ipcRenderer.invoke('library:removeHighlight', input),
  get: (): Promise<LibraryResult<LibraryState>> => ipcRenderer.invoke('library:get'),
  importFiles: (paths: string[]): Promise<LibraryResult<LibraryImportResult>> => ipcRenderer.invoke('library:importFiles', paths),
  pickAndImport: (): Promise<LibraryResult<LibraryImportResult>> => ipcRenderer.invoke('library:pickAndImport'),
  updateBook: (input: { id: string; patch: LibraryBookPatch }): Promise<LibraryResult<LibraryBook>> => ipcRenderer.invoke('library:updateBook', input),
  getPosition: (bookId: string): Promise<LibraryResult<LibraryReadingPosition | null>> => ipcRenderer.invoke('library:getPosition', bookId),
  setPosition: (position: LibraryReadingPosition): Promise<LibraryResult<LibraryReadingPosition>> => ipcRenderer.invoke('library:setPosition', position),
  listBookmarks: (bookId: string): Promise<LibraryResult<LibraryBookmark[]>> => ipcRenderer.invoke('library:listBookmarks', bookId),
  setBookmarks: (input: { bookId: string; bookmarks: LibraryBookmark[] }): Promise<LibraryResult<LibraryBookmark[]>> => ipcRenderer.invoke('library:setBookmarks', input),
  onChanged: (listener: (state: LibraryState) => void) => {
    const handler = (_event: IpcRendererEvent, state: LibraryState) => listener(state)
    ipcRenderer.on('library:changed', handler)
    return () => ipcRenderer.removeListener('library:changed', handler)
  },
}

const bookSourcesAPI: import('../shared/library-sources').BookSourcesAPI = {
  settings: () => ipcRenderer.invoke('librarySources:settings'),
  configure: input => ipcRenderer.invoke('librarySources:configure', input),
  status: () => ipcRenderer.invoke('librarySources:status'),
  search: input => ipcRenderer.invoke('librarySources:search', input),
  categories: () => ipcRenderer.invoke('librarySources:categories'),
  jobs: () => ipcRenderer.invoke('librarySources:jobs'),
  download: input => ipcRenderer.invoke('librarySources:download', input),
  cancel: id => ipcRenderer.invoke('librarySources:cancel', id),
  retry: id => ipcRenderer.invoke('librarySources:retry', id),
  answer: input => ipcRenderer.invoke('librarySources:answer', input),
  openManual: id => ipcRenderer.invoke('librarySources:openManual', id),
  onChanged: listener => {
    const handler = (_event: IpcRendererEvent, jobs: import('../shared/library-sources').SourceJob[]) => listener(jobs)
    ipcRenderer.on('librarySources:changed', handler)
    return () => ipcRenderer.removeListener('librarySources:changed', handler)
  },
}

// Settings API
const settingsAPI = {
  get: (key: string) => ipcRenderer.invoke('settings:get', key),
  set: (key: string, value: string) => ipcRenderer.invoke('settings:set', { key, value }),
  getAll: () => ipcRenderer.invoke('settings:getAll'),
  getAIConfig: () => ipcRenderer.invoke('settings:getAIConfig'),
  setAIConfig: (config: unknown) => ipcRenderer.invoke('settings:setAIConfig', config),
  getAIWorkspace: () => ipcRenderer.invoke('settings:getAIWorkspace'),
  setAIWorkspace: (workspace: unknown) => ipcRenderer.invoke('settings:setAIWorkspace', workspace),
  testAIConnection: (config: unknown) => ipcRenderer.invoke('settings:testAIConnection', config),
  cancelChatGptOAuth: (operationId: string) => ipcRenderer.invoke('settings:cancelChatGptOAuth', operationId),
  reopenChatGptOAuth: (operationId: string) => ipcRenderer.invoke('settings:reopenChatGptOAuth', operationId),
  getChatGptOAuthStatus: () => ipcRenderer.invoke('settings:getChatGptOAuthStatus'),
  connectChatGptOAuth: () => ipcRenderer.invoke('settings:connectChatGptOAuth'),
  resumeChatGptOAuth: () => ipcRenderer.invoke('settings:resumeChatGptOAuth'),
  disconnectChatGptOAuth: () => ipcRenderer.invoke('settings:disconnectChatGptOAuth'),
  listExternalServices: () => ipcRenderer.invoke('settings:listExternalServices'),
  updateExternalService: (input: unknown) => ipcRenderer.invoke('settings:updateExternalService', input),
  resetExternalService: (payload: { id: string }) => ipcRenderer.invoke('settings:resetExternalService', payload),
  testExternalService: (payload: { id: string }) => ipcRenderer.invoke('settings:testExternalService', payload),
  testExternalServiceDraft: (input: unknown) => ipcRenderer.invoke('settings:testExternalServiceDraft', input),
}

const imageGenerationAPI = {
  persistToDocument: (input: ImageGenerationPersistToDocumentInput) =>
    ipcRenderer.invoke('imageGeneration:persistToDocument', input),
  persistToDirectory: (input: ImageGenerationPersistToDirectoryInput) =>
    ipcRenderer.invoke('imageGeneration:persistToDirectory', input),
  copyToClipboard: (input: ImageGenerationCopyInput) =>
    ipcRenderer.invoke('imageGeneration:copyToClipboard', input),
}

const fileEmergenceAPI = {
  getSnapshot: (payload: FileEmergenceGetSnapshotPayload) =>
    ipcRenderer.invoke('fileEmergence:getSnapshot', payload),
  recordActivity: (payload: FileEmergenceRecordActivityPayload) =>
    ipcRenderer.invoke('fileEmergence:recordActivity', payload),
  recordReadingSession: (payload: FileEmergenceRecordReadingSessionPayload) =>
    ipcRenderer.invoke('fileEmergence:recordReadingSession', payload),
  renameProject: (payload: FileEmergenceRenameProjectPayload) =>
    ipcRenderer.invoke('fileEmergence:renameProject', payload),
  feedbackProject: (payload: FileEmergenceFeedbackPayload) =>
    ipcRenderer.invoke('fileEmergence:feedbackProject', payload),
  listSuppressed: (payload: { workspaceRoots: string[] }) =>
    ipcRenderer.invoke('fileEmergence:listSuppressed', payload),
  getEvaluation: (payload: { workspaceRoots: string[] }) =>
    ipcRenderer.invoke('fileEmergence:getEvaluation', payload),
  assignFile: (payload: FileEmergenceAssignFilePayload) =>
    ipcRenderer.invoke('fileEmergence:assignFile', payload),
  createProjectForFile: (payload: FileEmergenceCreateProjectForFilePayload) =>
    ipcRenderer.invoke('fileEmergence:createProjectForFile', payload),
}
const tagForgeAPI={
  prepareCreation:(payload:TagForgePrepareCreationPayload)=>ipcRenderer.invoke('tagForge:prepareCreation',payload),
  finalizeCreation:(payload:TagForgeFinalizeCreationPayload)=>ipcRenderer.invoke('tagForge:finalizeCreation',payload),
}

const petAPI = {
  getSettings: () => ipcRenderer.invoke('pet:getSettings'),
  updateSettings: (patch: Partial<PetSettings>) => ipcRenderer.invoke('pet:updateSettings', patch),
  listPets: () => ipcRenderer.invoke('pet:listPets'),
  getSnapshot: () => ipcRenderer.invoke('pet:getSnapshot'),
  show: () => ipcRenderer.invoke('pet:show'),
  hide: () => ipcRenderer.invoke('pet:hide'),
  setPet: (petId: string) => ipcRenderer.invoke('pet:setPet', petId),
  resetPosition: () => ipcRenderer.invoke('pet:resetPosition'),
  moveBy: (delta: { dx: number; dy: number }) => ipcRenderer.invoke('pet:moveBy', delta),
  pushStickyNote: (note: PetStickyNoteInput) => ipcRenderer.invoke('pet:pushStickyNote', note),
  dismissStickyNote: (id: string) => ipcRenderer.invoke('pet:dismissStickyNote', id),
  clearStickyNotes: () => ipcRenderer.invoke('pet:clearStickyNotes'),
  snapshotApplied: (applied: { revision: number; contentDigest: string }) => ipcRenderer.send('pet:snapshotApplied', applied),
  openActivity: (activity: PetActivityOpenIdentity) => (
    ipcRenderer.invoke('pet:openActivity', activity)
  ),
  activityOpened: (activity: PetActivityOpenIdentity) => (
    ipcRenderer.send('pet:activityOpened', activity)
  ),
  scopeViewed: (scopeId: string) => ipcRenderer.send('pet:scopeViewed', scopeId),
  onOpenActivity: (callback: (activity: PetActivityOpenIdentity) => void) => {
    const handler = (_: unknown, activity: PetActivityOpenIdentity) => callback(activity)
    ipcRenderer.on('pet:openActivity', handler)
    return () => { ipcRenderer.removeListener('pet:openActivity', handler) }
  },
  onSnapshot: (callback: (snapshot: PetWindowSnapshot) => void) => {
    const handler = (_: unknown, snapshot: PetWindowSnapshot) => callback(snapshot)
    ipcRenderer.on('pet:snapshot', handler)
    return () => { ipcRenderer.removeListener('pet:snapshot', handler) }
  },
}

// Chat History + File API
const chatAPI = {
  getConversations: (agent: string) => ipcRenderer.invoke('chat:getConversations', agent),
  getMessages: (conversationId: string) => ipcRenderer.invoke('chat:getMessages', conversationId),
  updateConversationTitle: (data: { id: string; title: string }) =>
    ipcRenderer.invoke('chat:updateConversationTitle', data),
  pickFiles: () => ipcRenderer.invoke('chat:pickFiles'),
  savePastedImage: (bytes: Uint8Array) => ipcRenderer.invoke('chat:savePastedImage', bytes),
  readFileForAI: (filePath: string) => ipcRenderer.invoke('chat:readFileForAI', filePath),
}

const toolsAPI = {
  logToolEvent: (payload: {
    type: 'dispatch' | 'ack' | 'watchdog' | 'cancel' | 'self-rescue' | 'duplicate'
    requestId: string
    tool: string
    scopeId?: string | null
    elapsedMs?: number
    error?: string
  }) => ipcRenderer.send('tools:logToolEvent', payload),
}

const uiAPI = {
  showNativeContextMenu: (payload: NativeContextMenuRequest) => ipcRenderer.invoke('ui:showNativeContextMenu', payload),
}

// agent_interaction — `ask_user_questions` IPC. Deliberately a top-level API
// (not under skillsAPI) because the underlying tool is a main-agent built-in
// and bypasses skill authorization (§6.23).
interface AgentInteractionQuestionPayload {
  id: string
  question: string
  kind: 'single_choice' | 'multi_choice' | 'free_text'
  options?: string[]
  placeholder?: string
  required?: boolean
}

interface AgentInteractionCardEvent {
  cardId: string
  sessionId: string | null
  conversationId: string | null
  readyRunId?: string | null
  aliasGeneration?: number | null
  messageVisibilityEpoch?: number | null
  questions: AgentInteractionQuestionPayload[]
  askedAt: number
}

const agentInteractionAPI = {
  submitAskUserQuestions: (payload: {
    cardId: string
    answers: Array<{ id: string; answer: string | string[] }>
  }) => invokeAgentRuntime('agent:askUserQuestions:submit', payload),
  cancelAskUserQuestions: (payload: { cardId: string; reason?: string }) =>
    invokeAgentRuntime('agent:askUserQuestions:cancel', payload),
  listPendingAskUserQuestions: () =>
    invokeAgentRuntime('agent:askUserQuestions:listPending'),
  // EP1-I3-2 — confirm/deny a frozen tool call awaiting user confirmation.
  // Programmatic equivalent of answering the confirmation card variant.
  respondFrozenCall: (payload: { frozenCallId: string; decision: 'confirm' | 'deny' }) =>
    invokeAgentRuntime('agent:frozenCall:respond', payload),
  onAskUserQuestionsCard: (handler: (event: AgentInteractionCardEvent) => void) => {
    const listener = (_event: unknown, payload: AgentInteractionCardEvent) => handler(payload)
    ipcRenderer.on('agent:askUserQuestions:push', listener)
    return () => ipcRenderer.removeListener('agent:askUserQuestions:push', listener)
  },
}

// Expose APIs to renderer
// Phase M 管理面（2026-07-05）—— MCP 设置页：状态 / 保存配置 / 重连
const mcpAPI = {
  getStatus: () => ipcRenderer.invoke('mcp:status'),
  saveConfig: (servers: unknown[]) => ipcRenderer.invoke('mcp:saveConfig', { servers }),
  reload: () => ipcRenderer.invoke('mcp:reload'),
  listResources: (serverId: string) => ipcRenderer.invoke('mcp:listResources', { serverId }),
  readResource: (payload: { serverId: string; uri: string; catalogGeneration: number }) => (
    ipcRenderer.invoke('mcp:readResource', payload)
  ),
}

const objectsAPI: ObjectPresentationAPI = {
  resolvePath: (path) => ipcRenderer.invoke('object:resolve-path', path),
  locate: (id) => ipcRenderer.invoke('object:locate', id),
  prepareMigration: (request) => ipcRenderer.invoke('object:migration-prepare', request),
  completeMigration: (id) => ipcRenderer.invoke('object:migration-complete', id),
  onMoved: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, event: ObjectMovedEvent) => callback(event)
    ipcRenderer.on('object:moved', handler)
    return () => ipcRenderer.removeListener('object:moved', handler)
  },
}

contextBridge.exposeInMainWorld('electronAPI', {
  agent: agentAPI,
  runQuality: runQualityAPI,
  runFeedback: runFeedbackAPI,
  emergence: emergenceAPI,
  browser: browserAPI,
  objects: objectsAPI,
  objectRelations: { query: (id: string) => ipcRenderer.invoke('objectRelations:query', id) },
  document: documentAPI,
  canvas: canvasAPI,
  canvasComposition: canvasCompositionAPI,
  fastCard: fastCardAPI,
  linkPreview: linkPreviewAPI,
  rss: rssAPI,
  dateMentions: {
    list: () => ipcRenderer.invoke('dateMentions:list'),
    locate: (ref: import('../shared/ready-ref').ReadyRef) => ipcRenderer.invoke('dateMentions:locate', ref),
    takeOpen: () => ipcRenderer.invoke('dateMentions:takeOpen'),
    onChanged: (handler: () => void) => {
      const listener = () => handler()
      ipcRenderer.on('dateMentions:changed', listener)
      return () => ipcRenderer.removeListener('dateMentions:changed', listener)
    },
    onOpen: (handler: () => void) => {
      const listener = () => handler()
      ipcRenderer.on('dateMentions:open', listener)
      return () => ipcRenderer.removeListener('dateMentions:open', listener)
    },
  } satisfies import('../shared/calendar/date-mentions').DateMentionsAPI,
  calendarLayers: {
    query: (range: import('../shared/calendar-layers').LayerRange) => ipcRenderer.invoke('calendarLayers:query', range),
    move: (input: import('../shared/calendar-layers').LayerMove) => ipcRenderer.invoke('calendarLayers:move', input),
    beginReading: (input: import('../shared/calendar-layers').ReadingBegin) => ipcRenderer.invoke('calendarLayers:beginReading', input),
    endReading: (input: import('../shared/calendar-layers').ReadingEnd) => ipcRenderer.invoke('calendarLayers:endReading', input),
    onChanged: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('calendarLayers:changed', listener)
      ipcRenderer.on('document:indexChanged', listener)
      return () => { ipcRenderer.removeListener('calendarLayers:changed', listener); ipcRenderer.removeListener('document:indexChanged', listener) }
    },
  },
  calendar: calendarAPI,
  skills: skillsAPI,
  app: appAPI,
  window: windowAPI,
  theme: themeAPI,
  settings: settingsAPI,
  vault: vaultAPI,
  documentDrafts: documentDraftsAPI,
  documentPages: documentPagesAPI,
  sourceAnnotations: sourceAnnotationsAPI,
  documentAnnotations: documentAnnotationsAPI,
  documentImport: documentImportAPI,
  documentDatabase: (request: import('../shared/document-database').DatabaseRequest): Promise<import('../shared/document-database').DatabaseReply> => ipcRenderer.invoke('documentDatabase:request', request),
  library: libraryAPI,
  libraryArchive: libraryArchiveAPI,
  bookSources: bookSourcesAPI,
  imageGeneration: imageGenerationAPI,
  fileEmergence: fileEmergenceAPI,
  tagForge: tagForgeAPI,
  pet: petAPI,
  chat: chatAPI,
  tools: toolsAPI,
  ui: uiAPI,
  agentInteraction: agentInteractionAPI,
  mcp: mcpAPI,
  platform: process.platform,
  startNativeFileDrag: (paths: string[]) => ipcRenderer.send('app:startNativeFileDrag', paths),
  // Utility for drag-and-drop: get real file path from File object
  getFilePathFromDrop: (file: File) => webUtils.getPathForFile(file),
})

// Type declarations for renderer
declare global {
  interface Window {
    electronAPI: {
      agent: typeof agentAPI
      mcp: typeof mcpAPI
      runQuality: typeof runQualityAPI
      browser: typeof browserAPI
      objects: typeof objectsAPI
      document: typeof documentAPI
      canvas: typeof canvasAPI
      canvasComposition: typeof canvasCompositionAPI
      fastCard: typeof fastCardAPI
      linkPreview: typeof linkPreviewAPI
      rss: typeof rssAPI
      calendar: typeof calendarAPI
      skills: typeof skillsAPI
      app: typeof appAPI
      window: typeof windowAPI
      theme: typeof themeAPI
      settings: typeof settingsAPI
      vault: typeof vaultAPI
      documentDrafts: typeof documentDraftsAPI
      documentPages: typeof documentPagesAPI
      sourceAnnotations: typeof sourceAnnotationsAPI
      documentAnnotations: typeof documentAnnotationsAPI
      documentImport: typeof documentImportAPI
      bookSources: typeof bookSourcesAPI
      libraryArchive: LibraryArchiveAPI
      library: typeof libraryAPI
      imageGeneration: typeof imageGenerationAPI
      fileEmergence: typeof fileEmergenceAPI
      tagForge: typeof tagForgeAPI
      pet: typeof petAPI
      chat: typeof chatAPI
      tools: typeof toolsAPI
      ui: typeof uiAPI
      agentInteraction: typeof agentInteractionAPI
      platform: string
      startNativeFileDrag: (paths: string[]) => void
      getFilePathFromDrop: (file: File) => string
    }
  }
}
