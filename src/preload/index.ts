import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import {
  BROWSER_VIEW_INTENT_CHANNEL,
  type BrowserViewIntent,
  type BrowserViewIntentAck,
} from '../shared/browser-view-intent'
import type { BrowserUtilityMenuRequest } from '../shared/browser-utility-menu'
import type { DocumentIndexChangedEvent } from '../shared/document-index-events'
import type { NativeContextMenuRequest } from '../shared/native-context-menu'
import type { RSSAutoRefreshSnapshot } from '../shared/rss-auto-refresh'
import type {
  ScheduleCreateRequest,
  SchedulePreviewRequest,
  ScheduledTasksAPI,
  ScheduleUpdateRequest,
} from '../shared/scheduled-tasks'
import type { RendererAgentMetricName } from '../shared/renderer-agent-metrics'
import type { ModelPackDownloadUpdate, ModelPackId, ModelSource } from '../shared/model-pack-types'
import type { RuntimeStatus, RuntimeProvisionTaskSnapshot } from '../shared/runtime-provision-types'
import type { PetActivitySnapshot, PetSettings, PetStickyNoteInput, PetWindowSnapshot } from '../shared/pet'
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
  BrowserFastCardContextActionEvent,
  FastCardOverlayCommand,
  FastCardOverlaySnapshot,
  FastCardDescribeImageRequest,
  FastCardResolveVideoRequest,
  FastCardTranslateRequest,
} from '../shared/fastcard'

type ContinuationIntentPayload = {
  taskId: string
  executionId?: string
  stepId?: string
  blockedReason?: string
  responseText?: string
  todoId?: string
  todoTitle?: string
  resumeKind?: 'snapshot' | 'paused' | 'done_residual'
  pauseReason?: string
  detachedTaskId?: string
  taskRunId?: string
  jobId?: string
  skillId?: string
  action?: string
  runStatePath?: string
  outputDir?: string
  progressFingerprint?: string
  /**
   * Stage Q (Stage 11) — child run identifier. Renderer-side resume
   * paths (`buildRunContinuationIntent`) read childRunId from the live
   * `taskContinuation` and propagate it through this payload to main,
   * where `runtime.buildContinuationIntent`'s canResumeShape gate
   * uses it to validate resumability.
   */
  childRunId?: string
}

function notifyAgentRegistryChanged(): void {
  try {
    queueMicrotask(() => {
      try {
        window.dispatchEvent(new CustomEvent('ready:agent-registry-changed'))
      } catch {
        // ignore — preview/test environments may not provide DOM events.
      }
    })
  } catch {
    // ignore
  }
}

async function invokeAndNotifyAgentRegistry(channel: string, ...args: unknown[]): Promise<unknown> {
  const result = await ipcRenderer.invoke(channel, ...args)
  if (result && typeof result === 'object' && (result as { success?: unknown }).success === true) {
    notifyAgentRegistryChanged()
  }
  return result
}

// Agent API
const agentAPI = {
  send: (
    agent: string,
    message: string | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>,
    sessionId?: string,
    requestId?: string,
    deliveryMode?: 'standard' | 'adaptive' | 'thorough'
  ) => ipcRenderer.invoke('agent:send', { agent, message, sessionId, requestId, deliveryMode }),
  newSession: (agent: string, sessionId?: string) => ipcRenderer.invoke('agent:newSession', { agent, sessionId }),
  sessionPrerouteEvaluate: (firstMessage: string) =>
    ipcRenderer.invoke('agent:sessionPreroute:evaluate', { firstMessage }),
  // Stage U PR U1.2 — removed `orchestrate / getStatus / getAll / getDiagnostics`
  // legacy AgentManager wrappers. Zero renderer callers (verified via grep).
  // Use `getRuntimeStatus` + `getCapabilityRuntimeSnapshot` for diagnostics.
  kill: (agent: string, sessionId?: string) => ipcRenderer.invoke('agent:kill', { agent, sessionId }),
  compactSession: (agent: string, sessionId?: string) =>
    ipcRenderer.invoke('agent:compactSession', { agent, sessionId }),
  getRuntimeStatus: () => ipcRenderer.invoke('agent:getRuntimeStatus'),
  getCapabilityRuntimeSnapshot: (config?: unknown) => ipcRenderer.invoke('agent:getCapabilityRuntimeSnapshot', config),
  listChannels: () => ipcRenderer.invoke('agent:listChannels'),
  listRegistry: () => ipcRenderer.invoke('agent:registry:list'),
  listRegistryKnowledge: (id: string) => ipcRenderer.invoke('agent:registry:listKnowledge', { id }),
  getSystemStudioSnapshot: () => ipcRenderer.invoke('agent:systemStudio:getSnapshot'),
  simulateSystemStudioRouting: (firstMessage: string) =>
    ipcRenderer.invoke('agent:systemStudio:simulateRouting', { firstMessage }),
  stageSystemStudioContentEdit: (payload: unknown) =>
    ipcRenderer.invoke('agent:systemStudio:stageContentEdit', payload),
  confirmSystemStudioContentEdit: (proposalId: string) =>
    ipcRenderer.invoke('agent:systemStudio:confirmContentEdit', { proposalId }),
  rejectSystemStudioContentEdit: (proposalId: string) =>
    ipcRenderer.invoke('agent:systemStudio:rejectContentEdit', { proposalId }),
  listSpecialistBlueprints: () => ipcRenderer.invoke('agent:specialistBlueprint:list'),
  upsertSpecialistBlueprintDraft: (blueprint: unknown) =>
    ipcRenderer.invoke('agent:specialistBlueprint:upsertDraft', { blueprint }),
  runSpecialistBlueprintAdmission: (payload: { blueprint?: unknown; blueprintId?: string }) =>
    ipcRenderer.invoke('agent:specialistBlueprint:runAdmission', payload),
  requestSpecialistBlueprintConfirmation: (payload: {
    blueprintId: string
    sessionId: string
    runId?: string | null
    unverifiedSemanticReviewAck?: { kind: 'unverified_semantic_review'; contentHash: string }
  }) =>
    ipcRenderer.invoke('agent:specialistBlueprint:requestConfirmation', payload),
  confirmSpecialistDraftCreate: (payload: { blueprintId: string; sessionId: string; runId?: string | null; tokenId: string; migrateCardRelPaths?: string[] }) =>
    invokeAndNotifyAgentRegistry('agent:specialistBlueprint:confirmCreate', payload),
  rejectSpecialistBlueprint: (blueprintId: string) =>
    ipcRenderer.invoke('agent:specialistBlueprint:reject', { blueprintId }),
  expireSpecialistBlueprint: (blueprintId: string) =>
    ipcRenderer.invoke('agent:specialistBlueprint:expire', { blueprintId }),
  updateRegistryStatus: (payload: {
    id: string
    status: 'active' | 'disabled' | 'retired' | 'merged'
    mergedIntoAgentId?: string | null
    migrateCardRelPaths?: string[]
  }) =>
    invokeAndNotifyAgentRegistry('agent:registry:updateStatus', payload),
  deleteRegistryAgent: (id: string) =>
    invokeAndNotifyAgentRegistry('agent:registry:delete', { id }),
  listDerivationCandidates: () => ipcRenderer.invoke('agent:derivation:listCandidates'),
  confirmDerivation: (payload: {
    candidateRelPath: string
    specialistId: string
    name: string
    charter?: string | null
    seedRulesText: string
    routingTriggers: string[]
    activateRouting?: boolean
    migrateCardRelPaths?: string[]
  }) => ipcRenderer.invoke('agent:derivation:confirm', payload),
  rejectDerivation: (candidateRelPath: string) =>
    ipcRenderer.invoke('agent:derivation:reject', { candidateRelPath }),
  listConversationScopes: (agent?: string) => ipcRenderer.invoke('agent:listConversationScopes', { agent }),
  listScopeRuns: (payload?: { channelKey?: string; statuses?: string[]; limit?: number }) =>
    ipcRenderer.invoke('agent:listScopeRuns', payload || {}),
  listTaskProjections: (scopeId: string) =>
    ipcRenderer.invoke('agent:listTaskProjections', { scopeId }),
  getTaskProjection: (taskId: string) =>
    ipcRenderer.invoke('agent:getTaskProjection', { taskId }),
  searchSessionRecall: (payload?: {
    query?: string
    channelKey?: string
    sourceKind?: 'local' | 'channel'
    userId?: string
    hasAttachments?: boolean
    currentScopeId?: string
    limit?: number
  }) => ipcRenderer.invoke('agent:searchSessionRecall', payload || {}),
  listRecentSessions: (payload?: {
    channelKey?: string
    sourceKind?: 'local' | 'channel'
    userId?: string
    hasAttachments?: boolean
    currentScopeId?: string
    limit?: number
  }) => ipcRenderer.invoke('agent:listRecentSessions', payload || {}),
  getSessionRecallCapsule: (conversationId: string) =>
    ipcRenderer.invoke('agent:getSessionRecallCapsule', { conversationId }),
  listAttachedSessionRecallContexts: (scopeId: string) =>
    ipcRenderer.invoke('agent:listAttachedSessionRecallContexts', { scopeId }),
  getReferenceSkillHint: (scopeId: string) =>
    ipcRenderer.invoke('agent:getReferenceSkillHint', { scopeId }),
  startDetachedSkillAction: (payload: {
    scopeId?: string
    sessionId?: string
    agent?: string
    skillId: string
    action: string
    params?: Record<string, unknown>
  }) => ipcRenderer.invoke('agent:startDetachedSkillAction', payload),
  inspectDetachedSkillTask: (taskId: string, scopeId: string) =>
    ipcRenderer.invoke('agent:inspectDetachedSkillTask', { taskId, scopeId }),
  listDetachedSkillTasks: (payload?: { scopeId?: string }) =>
    ipcRenderer.invoke('agent:listDetachedSkillTasks', payload || {}),
  cancelDetachedSkillTask: (taskId: string, scopeId: string) =>
    ipcRenderer.invoke('agent:cancelDetachedSkillTask', { taskId, scopeId }),
  listActiveChildRuns: () => ipcRenderer.invoke('agent:listActiveChildRuns'),
  cancelChildRun: (childRunId: string) =>
    ipcRenderer.invoke('agent:cancelChildRun', { childRunId }),
  attachSessionRecallContext: (currentScopeId: string, conversationId: string) =>
    ipcRenderer.invoke('agent:attachSessionRecallContext', { currentScopeId, conversationId }),
  detachSessionRecallContext: (currentScopeId: string, conversationId: string) =>
    ipcRenderer.invoke('agent:detachSessionRecallContext', { currentScopeId, conversationId }),
  resumeSessionCandidate: (payload: { conversationId?: string; resumeTitle?: string }) =>
    ipcRenderer.invoke('agent:resumeSessionCandidate', payload),
  getConversationScopeMessages: (scopeId: string) =>
    ipcRenderer.invoke('agent:getConversationScopeMessages', { scopeId }),
  createLocalScope: (agent: string, id?: string) => ipcRenderer.invoke('agent:createLocalScope', { agent, id }),
  listScopeAttachments: (scopeId?: string) => ipcRenderer.invoke('agent:listScopeAttachments', { scopeId }),
  getScopeAttachment: (scopeId: string, attachmentId: string) =>
    ipcRenderer.invoke('agent:getScopeAttachment', { scopeId, attachmentId }),
  clearRemoteAttachmentCache: (channelId?: string) =>
    ipcRenderer.invoke('agent:clearRemoteAttachmentCache', { channelId }),
  getRemoteAttachmentCacheStats: (channelId?: string) =>
    ipcRenderer.invoke('agent:getRemoteAttachmentCacheStats', { channelId }),
  sendScoped: (
    payload: {
      scopeId: string
      agent?: string
      message: string | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>
      requestId?: string
      workspaceRoots?: string[]
      deliveryMode?: 'standard' | 'adaptive' | 'thorough'
      userMessage?: {
        id: string
        content: string
        timestamp?: string
        meta?: Record<string, unknown>
        attachmentConfirmation?: {
          selectedCount: number
          metadataCount: number
          inputIncludedCount: number
          inputFailedCount: number
        }
      }
      continuationIntent?: ContinuationIntentPayload | null
    }
  ) => ipcRenderer.invoke('agent:sendScoped', payload),
  emitRendererMetric: (
    name: RendererAgentMetricName,
    payload: Record<string, unknown> = {},
  ) => ipcRenderer.invoke('agent:emitRendererMetric', { name, payload }),
  reportInfrastructureTimeout: (payload: { scopeId: string; requestId: string; elapsedMs?: number }) =>
    ipcRenderer.invoke('agent:reportInfrastructureTimeout', payload),
  suspendRun: (payload: { scopeId: string; taskId?: string }) =>
    ipcRenderer.invoke('agent:suspendRun', payload),
  resumeRun: (payload: {
    scopeId: string
    taskId?: string
    requestId?: string
    responseText?: string
    continuationIntent?: ContinuationIntentPayload | null
  }) =>
    ipcRenderer.invoke('agent:resumeRun', payload),
  respondToInteraction: (payload: {
    scopeId: string
    taskId?: string
    requestId?: string
    responseText: string
    confirmed?: boolean
    continuationIntent?: ContinuationIntentPayload | null
  }) =>
    ipcRenderer.invoke('agent:respondToInteraction', payload),
  upsertChannel: (payload: {
    id?: string
    type: 'local-debug' | 'generic-webhook' | 'feishu-bot' | 'feishu-app' | 'telegram-bot' | 'wechat-openclaw'
    name: string
    enabled?: boolean
    config?: Record<string, unknown>
  }) => ipcRenderer.invoke('agent:upsertChannel', payload),
  testChannel: (payload: {
    id?: string
    type: 'local-debug' | 'generic-webhook' | 'feishu-bot' | 'feishu-app' | 'telegram-bot' | 'wechat-openclaw'
    name: string
    enabled?: boolean
    config?: Record<string, unknown>
  }) => ipcRenderer.invoke('agent:testChannel', payload),
  startWechatLogin: (payload: {
    id?: string
    force?: boolean
  }) => ipcRenderer.invoke('agent:startWechatLogin', payload),
  getWechatLoginStatus: (payload: {
    channelId: string
    sessionKey: string
  }) => ipcRenderer.invoke('agent:getWechatLoginStatus', payload),
  submitWechatLoginVerifyCode: (payload: {
    channelId: string
    sessionKey: string
    code: string
  }) => ipcRenderer.invoke('agent:submitWechatLoginVerifyCode', payload),
  deleteChannel: (id: string) => ipcRenderer.invoke('agent:deleteChannel', { id }),
  setChannelEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('agent:setChannelEnabled', { id, enabled }),
  sendChannelProbe: (id: string, text: string) =>
    ipcRenderer.invoke('agent:sendChannelProbe', { id, text }),
  // Stage V V3.2 — push payloads carry `sessionId: string | null`
  // (not optional). null = global event (not session-scoped); a string
  // means the event belongs to a specific session and renderer routes by it.
  onStream: (callback: (data: { agent: string; sessionId: string | null; runId?: string; chunk: string; type: string }) => void) => {
    const handler = (_: unknown, data: { agent: string; sessionId: string | null; runId?: string; chunk: string; type: string }) => callback(data)
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
  }) => ipcRenderer.invoke('agent:completeToolActionRequest', payload),
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

const scheduledTasksAPI: ScheduledTasksAPI = {
  list: () => ipcRenderer.invoke('scheduledTasks:list'),
  get: (id: string) => ipcRenderer.invoke('scheduledTasks:get', { id }),
  preview: (request: SchedulePreviewRequest) => ipcRenderer.invoke('scheduledTasks:preview', request),
  create: (request: ScheduleCreateRequest) => ipcRenderer.invoke('scheduledTasks:create', request),
  update: (request: ScheduleUpdateRequest) => ipcRenderer.invoke('scheduledTasks:update', request),
  pause: (id: string) => ipcRenderer.invoke('scheduledTasks:pause', { id }),
  resume: (id: string) => ipcRenderer.invoke('scheduledTasks:resume', { id }),
  delete: (id: string) => ipcRenderer.invoke('scheduledTasks:delete', { id }),
  runNow: (id: string) => ipcRenderer.invoke('scheduledTasks:runNow', { id }),
  listOccurrences: (scheduleId: string, limit?: number) =>
    ipcRenderer.invoke('scheduledTasks:listOccurrences', { scheduleId, limit }),
  onChanged: (callback: (scheduleId?: string) => void) => {
    const handler = (_: IpcRendererEvent, scheduleId?: unknown): void => {
      callback(typeof scheduleId === 'string' ? scheduleId : undefined)
    }
    ipcRenderer.on('scheduledTasks:changed', handler)
    return () => ipcRenderer.removeListener('scheduledTasks:changed', handler)
  },
}

// Memory API
const memoryAPI = {
  query: (filters: unknown) => ipcRenderer.invoke('agent:memory:query', filters),
  create: (entry: unknown) => ipcRenderer.invoke('agent:memory:create', entry),
  update: (id: string, updates: unknown) => ipcRenderer.invoke('agent:memory:update', { id, updates }),
  delete: (id: string) => ipcRenderer.invoke('agent:memory:delete', id),
  stats: () => ipcRenderer.invoke('agent:memory:stats'),
  createFromConversation: (payload: unknown) => ipcRenderer.invoke('agent:memory:createFromConversation', payload),
}

const memoryCardsAPI = {
  list: () => ipcRenderer.invoke('agent:beliefCards:list'),
  transition: (payload: { relPath: string; action: 'approve' | 'reject' }) =>
    ipcRenderer.invoke('agent:beliefCards:transition', payload),
  setKnowledgeSystemEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('agent:beliefCards:setKnowledgeSystemEnabled', { enabled }),
}

// P0-4 (2026-07-02 P0 visibility batch) — read-only run quality stats.
const runQualityAPI = {
  stats: () => ipcRenderer.invoke('agent:runQuality:stats'),
}

// D5 后端切片 (2026-07-03) — per-run 用户反馈（评分/信号/评论）。
const runFeedbackAPI = {
  submit: (payload: unknown) => ipcRenderer.invoke('agent:runFeedback:submit', payload),
  list: (options?: unknown) => ipcRenderer.invoke('agent:runFeedback:list', options),
}

// 梯队三 (2026-07-03) — emergence feed（拉取式组装，四类卡）。
const emergenceAPI = {
  feed: () => ipcRenderer.invoke('agent:emergence:feed'),
}

// Trigger API
const triggerAPI = {
  list: (filters?: unknown) => ipcRenderer.invoke('agent:trigger:list', filters),
  create: (trigger: unknown) => ipcRenderer.invoke('agent:trigger:create', trigger),
  update: (id: string, updates: unknown) => ipcRenderer.invoke('agent:trigger:update', { id, updates }),
  createWithMemories: (payload: unknown) => ipcRenderer.invoke('agent:trigger:createWithMemories', payload),
}

// Memory Lifecycle API
const memoryLifecycleAPI = {
  status: () => ipcRenderer.invoke('agent:memory:lifecycle:status'),
  runMaintenance: () => ipcRenderer.invoke('agent:memory:lifecycle:runMaintenance'),
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
  // Agent-browser supervision (plan §3.6): two-step interrupt + task listing.
  getAgentSupervisionState: () => ipcRenderer.invoke('browser:getAgentSupervisionState'),
  requestAgentInterruption: () => ipcRenderer.invoke('browser:requestAgentInterruption'),
  confirmAgentInterruption: () => ipcRenderer.invoke('browser:confirmAgentInterruption'),
  dismissAgentInterruption: () => ipcRenderer.invoke('browser:dismissAgentInterruption'),
  confirmCollectionConsent: (payload: { requestId: string }) =>
    ipcRenderer.invoke('browser:confirmCollectionConsent', payload),
  resumeTask: (payload: { taskId: string }) => ipcRenderer.invoke('browser:resumeTask', payload),
  cancelTask: (payload: { taskId: string }) => ipcRenderer.invoke('browser:cancelTask', payload),
  onAgentControlChanged: (callback: (data: { state: string }) => void) => {
    const handler = (_event: unknown, data: { state: string }) => callback(data)
    ipcRenderer.on('browser:agentControlChanged', handler)
    return () => ipcRenderer.removeListener('browser:agentControlChanged', handler)
  },
  onLeaseChanged: (callback: (data: {
    surfaces?: Record<string, unknown>
    activeWriteSurface?: string | null
  }) => void) => {
    const handler = (_event: unknown, data: {
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

const boardAPI = {
  create: (payload: { parentDir: string }) => ipcRenderer.invoke('board:create', payload),
  open: (payload: { path: string }) => ipcRenderer.invoke('board:open', payload),
  setActive: (payload: { boardId: string | null; expectedBoardId?: string }) => ipcRenderer.invoke('board:setActive', payload),
  save: (payload: { boardId: string; state: unknown }) => ipcRenderer.invoke('board:save', payload),
  ackExternalAssets: (payload: { boardId: string; receiptIds: string[] }) =>
    ipcRenderer.invoke('board:ackExternalAssets', payload),
  importAsset: (payload: { boardId: string; srcPath: string; kind?: 'image' | 'video' | 'markdown' }) =>
    ipcRenderer.invoke('board:importAsset', payload),
  importRemoteImage: (payload: { boardId: string; url: string }) =>
    ipcRenderer.invoke('board:importRemoteImage', payload),
  pickAsset: (payload: { boardId: string; kind?: 'image' | 'video' | 'markdown' | 'any' }) =>
    ipcRenderer.invoke('board:pickAsset', payload),
  openInDocument: (payload: { boardId: string; relativePath: string }) =>
    ipcRenderer.invoke('board:openInDocument', payload),
  onActiveBoardExternalImageAdded: (callback: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('board:activeBoardExternalImageAdded', handler)
    return () => { ipcRenderer.removeListener('board:activeBoardExternalImageAdded', handler) }
  },
}

// RSS API
const rssAPI = {
  getSources: () => ipcRenderer.invoke('rss:getSources'),
  addSource: (source: unknown) => ipcRenderer.invoke('rss:addSource', source),
  removeSource: (id: string) => ipcRenderer.invoke('rss:removeSource', id),
  getItems: (sourceId?: string) => ipcRenderer.invoke('rss:getItems', sourceId),
  getDraftStoreSources: () => ipcRenderer.invoke('rss:getDraftStoreSources'),
  markRead: (itemId: string) => ipcRenderer.invoke('rss:markRead', itemId),
  markReadBatch: (itemIds: string[]) => ipcRenderer.invoke('rss:markReadBatch', itemIds),
  deleteItems: (payload: string[] | { itemIds: string[]; preserveStarred?: boolean }) =>
    ipcRenderer.invoke('rss:deleteItems', payload),
  toggleStarred: (itemId: string) => ipcRenderer.invoke('rss:toggleStarred', itemId),
  clearDraftStore: (payload?: { sourceId?: string }) => ipcRenderer.invoke('rss:clearDraftStore', payload),
  refreshSource: (sourceId: string) => ipcRenderer.invoke('rss:refreshSource', { sourceId }),
  fetchAll: (options?: { digest?: boolean; classification?: 'simple' | 'none'; group?: string; sourceIds?: string[] }) =>
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
  exportFeed: (type?: 'master' | 'tech' | 'humanities' | 'design' | 'entertainment' | 'others') =>
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
  getSources: () => ipcRenderer.invoke('calendar:getSources'),
  getEvents: (start: Date, end: Date) => ipcRenderer.invoke('calendar:getEvents', { start, end }),
  createEvent: (event: unknown) => ipcRenderer.invoke('calendar:createEvent', event),
  updateEvent: (id: string, event: unknown) => ipcRenderer.invoke('calendar:updateEvent', { id, event }),
  deleteEvent: (id: string) => ipcRenderer.invoke('calendar:deleteEvent', id),
  // L3-B — per-occurrence override CRUD. `upsertEventOverride` covers
  // both "modify single occurrence" (kind='single' + patch fields) and
  // "skip single occurrence" (kind='cancelled'); `deleteEventOverride`
  // removes the row so the parent's default rule re-applies.
  //
  // `splitRecurringSeries` is the "modify this and future" gesture:
  // it truncates the parent series at `occurrenceStart - 1s` and
  // creates a new event starting at `patch.startTime ?? occurrenceStart`
  // carrying the rest of the patched fields. The new event's RRULE
  // defaults to the parent's original rule unless `patch.recurrenceRule`
  // is explicitly provided.
  upsertEventOverride: (payload: {
    parentEventId: string
    occurrenceStart: number | string | Date
    kind: 'single' | 'cancelled'
    patch?: {
      title?: string
      description?: string | null
      location?: string | null
      startTime?: number | string | Date
      endTime?: number | string | Date
      allDay?: boolean
      reminders?: unknown
      /** L4-A — per-occurrence start tz; null = local. */
      startTz?: string | null
      /** L4-A — per-occurrence end tz; null = local. */
      endTz?: string | null
    }
  }) => ipcRenderer.invoke('calendar:upsertEventOverride', payload),
  deleteEventOverride: (payload: {
    parentEventId: string
    occurrenceStart: number | string | Date
  }) => ipcRenderer.invoke('calendar:deleteEventOverride', payload),
  splitRecurringSeries: (payload: {
    parentEventId: string
    occurrenceStart: number | string | Date
    patch: {
      title?: string
      description?: string | null
      location?: string | null
      startTime?: number | string | Date
      endTime?: number | string | Date
      allDay?: boolean
      reminders?: unknown
      recurrenceRule?: string | null
      calendarId?: string
      /** L4-A — start tz for the NEW series; null = local. */
      startTz?: string | null
      /** L4-A — end tz for the NEW series; null = local. */
      endTz?: string | null
    }
  }) => ipcRenderer.invoke('calendar:splitRecurringSeries', payload),
  // L4-B-External-Sync — ICS import + URL subscription.
  //
  // `importIcsString` takes raw ICS body text (renderer reads the file
  // and ships the string); the main process parses, dedupes by VEVENT
  // UID, and writes to the named source (creating one when needed).
  //
  // `subscribeUrl` registers a periodic poller against an ICS URL and
  // returns the count of events imported in the first sync (which is
  // run immediately so the calendar isn't empty while waiting for the
  // first scheduled tick).
  //
  // `unsubscribeSource` cascades — FK ON DELETE CASCADE drops every
  // event whose calendar_id matched the source.
  //
  // `syncSourceNow` is the "立即同步" action: forces one sync cycle
  // and returns the full SyncResult so the renderer can show counts.
  importIcsString: (payload: {
    rawIcs: string
    calendarSourceId?: string
    sourceName?: string
  }) => ipcRenderer.invoke('calendar:importIcsString', payload),
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
    ipcRenderer.invoke('skills:askUser:submit', payload),
  listPendingAskUser: () => ipcRenderer.invoke('skills:askUser:pending'),
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
  onBeforeQuitFlush: (callback: (requestId: string) => void) => {
    const handler = (_: IpcRendererEvent, requestId: string): void => callback(requestId)
    ipcRenderer.on('app:flushBeforeQuit', handler)
    return () => ipcRenderer.removeListener('app:flushBeforeQuit', handler)
  },
  ackBeforeQuitFlushed: (requestId: string) => ipcRenderer.send('app:beforeQuitFlushed', requestId),
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

// Settings API
const settingsAPI = {
  get: (key: string) => ipcRenderer.invoke('settings:get', key),
  set: (key: string, value: string) => ipcRenderer.invoke('settings:set', { key, value }),
  getAll: () => ipcRenderer.invoke('settings:getAll'),
  getAgentAutoNarrationContinuation: () => ipcRenderer.invoke('settings:getAgentAutoNarrationContinuation'),
  setAgentAutoNarrationContinuation: (enabled: boolean) =>
    ipcRenderer.invoke('settings:setAgentAutoNarrationContinuation', { enabled }),
  getAgentSessionPrerouteMode: () => ipcRenderer.invoke('settings:getAgentSessionPrerouteMode'),
  setAgentSessionPrerouteMode: (mode: 'off' | 'suggest' | 'auto') =>
    ipcRenderer.invoke('settings:setAgentSessionPrerouteMode', { mode }),
  getAIConfig: () => ipcRenderer.invoke('settings:getAIConfig'),
  setAIConfig: (config: unknown) => ipcRenderer.invoke('settings:setAIConfig', config),
  getAIWorkspace: () => ipcRenderer.invoke('settings:getAIWorkspace'),
  setAIWorkspace: (workspace: unknown) => ipcRenderer.invoke('settings:setAIWorkspace', workspace),
  testAIConnection: (config: unknown) => ipcRenderer.invoke('settings:testAIConnection', config),
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
  updateActivity: (snapshot: PetActivitySnapshot) => ipcRenderer.invoke('pet:updateActivity', snapshot),
  resetPosition: () => ipcRenderer.invoke('pet:resetPosition'),
  moveBy: (delta: { dx: number; dy: number }) => ipcRenderer.invoke('pet:moveBy', delta),
  pushStickyNote: (note: PetStickyNoteInput) => ipcRenderer.invoke('pet:pushStickyNote', note),
  dismissStickyNote: (id: string) => ipcRenderer.invoke('pet:dismissStickyNote', id),
  clearStickyNotes: () => ipcRenderer.invoke('pet:clearStickyNotes'),
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
  deleteConversation: (conversationId: string) => ipcRenderer.invoke('chat:deleteConversation', conversationId),
  saveMessage: (data: { id: string; conversationId: string; role: string; content: string; timestamp: string }) =>
    ipcRenderer.invoke('chat:saveMessage', data),
  createConversation: (data: { id: string; agent: string; title: string }) =>
    ipcRenderer.invoke('chat:createConversation', data),
  updateConversationTitle: (data: { id: string; title: string }) =>
    ipcRenderer.invoke('chat:updateConversationTitle', data),
  pickFiles: () => ipcRenderer.invoke('chat:pickFiles'),
  readFileForAI: (filePath: string) => ipcRenderer.invoke('chat:readFileForAI', filePath),
}

// User Profile API
const userProfileAPI = {
  get: (userId: string) => ipcRenderer.invoke('userProfile:get', userId),
  list: () => ipcRenderer.invoke('userProfile:list'),
  create: (profile: {
    id?: string
    name?: string
    avatarUrl?: string
    preferredLanguage?: string
    communicationStyle?: string
    preferencesJson?: Record<string, unknown>
  }) => ipcRenderer.invoke('userProfile:create', profile),
  update: (userId: string, updates: {
    name?: string
    avatarUrl?: string
    preferredLanguage?: string
    communicationStyle?: string
    preferencesJson?: Record<string, unknown>
  }) => ipcRenderer.invoke('userProfile:update', userId, updates),
  delete: (userId: string) => ipcRenderer.invoke('userProfile:delete', userId),
}

// Agent Personality API
const agentPersonalityAPI = {
  get: (agentName: string) => ipcRenderer.invoke('agentPersonality:get', agentName),
  list: () => ipcRenderer.invoke('agentPersonality:list'),
  create: (personality: {
    agentName: string
    displayName?: string
    personalityText: string
    tone?: string
    metaJson?: Record<string, unknown>
  }) => invokeAndNotifyAgentRegistry('agentPersonality:create', personality),
  update: (agentName: string, updates: {
    displayName?: string
    personalityText?: string
    tone?: string
    metaJson?: Record<string, unknown>
  }) => invokeAndNotifyAgentRegistry('agentPersonality:update', agentName, updates),
  delete: (agentName: string) => invokeAndNotifyAgentRegistry('agentPersonality:delete', agentName),
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
  questions: AgentInteractionQuestionPayload[]
  askedAt: number
}

const agentInteractionAPI = {
  submitAskUserQuestions: (payload: {
    cardId: string
    answers: Array<{ id: string; answer: string | string[] }>
  }) => ipcRenderer.invoke('agent:askUserQuestions:submit', payload),
  cancelAskUserQuestions: (payload: { cardId: string; reason?: string }) =>
    ipcRenderer.invoke('agent:askUserQuestions:cancel', payload),
  listPendingAskUserQuestions: () =>
    ipcRenderer.invoke('agent:askUserQuestions:listPending'),
  // EP1-I3-2 — confirm/deny a frozen tool call awaiting user confirmation.
  // Programmatic equivalent of answering the confirmation card variant.
  respondFrozenCall: (payload: { frozenCallId: string; decision: 'confirm' | 'deny' }) =>
    ipcRenderer.invoke('agent:frozenCall:respond', payload),
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
  saveConfig: (json: string) => ipcRenderer.invoke('mcp:saveConfig', { json }),
  reload: () => ipcRenderer.invoke('mcp:reload'),
}

contextBridge.exposeInMainWorld('electronAPI', {
  agent: agentAPI,
  scheduledTasks: scheduledTasksAPI,
  memory: memoryAPI,
  memoryCards: memoryCardsAPI,
  runQuality: runQualityAPI,
  runFeedback: runFeedbackAPI,
  emergence: emergenceAPI,
  trigger: triggerAPI,
  memoryLifecycle: memoryLifecycleAPI,
  browser: browserAPI,
  document: documentAPI,
  board: boardAPI,
  rss: rssAPI,
  calendar: calendarAPI,
  skills: skillsAPI,
  app: appAPI,
  window: windowAPI,
  theme: themeAPI,
  settings: settingsAPI,
  imageGeneration: imageGenerationAPI,
  fileEmergence: fileEmergenceAPI,
  tagForge: tagForgeAPI,
  pet: petAPI,
  chat: chatAPI,
  userProfile: userProfileAPI,
  agentPersonality: agentPersonalityAPI,
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
      scheduledTasks: typeof scheduledTasksAPI
      mcp: typeof mcpAPI
      memory: typeof memoryAPI
      memoryCards: typeof memoryCardsAPI
      runQuality: typeof runQualityAPI
      trigger: typeof triggerAPI
      memoryLifecycle: typeof memoryLifecycleAPI
      browser: typeof browserAPI
      document: typeof documentAPI
      board: typeof boardAPI
      rss: typeof rssAPI
      calendar: typeof calendarAPI
      skills: typeof skillsAPI
      app: typeof appAPI
      window: typeof windowAPI
      theme: typeof themeAPI
      settings: typeof settingsAPI
      imageGeneration: typeof imageGenerationAPI
      fileEmergence: typeof fileEmergenceAPI
      tagForge: typeof tagForgeAPI
      pet: typeof petAPI
      chat: typeof chatAPI
      userProfile: typeof userProfileAPI
      agentPersonality: typeof agentPersonalityAPI
      tools: typeof toolsAPI
      ui: typeof uiAPI
      agentInteraction: typeof agentInteractionAPI
      platform: string
      startNativeFileDrag: (paths: string[]) => void
      getFilePathFromDrop: (file: File) => string
    }
  }
}
