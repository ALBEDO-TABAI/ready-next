import { emitRunTimelineEvent } from './run-timeline-emitter'
import { ipcMain, BrowserWindow, dialog } from 'electron'
import { randomUUID } from 'crypto'
import { AgentManager } from './agent-manager'
// Stage V V2.1c — `MultimodalBlock` import retired: the only call sites
// (`agent:send` + `agent:sendScoped` payload types) moved into
// `agentLifecycleGroup`.
// Stage V V2.1d — `AIModelConfig` import retired: the only call site
// (`agent:getCapabilityRuntimeSnapshot` payload type) moved into
// `agentRuntimeGroup`.
import { BrowserController } from '../browser-engine/ipc-handler'
import { makeNoteCollectProjectionSink } from './browser-collection-projection-sink'
import { readFileSync, statSync } from 'fs'
import { basename, extname } from 'path'
import { AgentControlRuntime } from '../agent-control/runtime-core/runtime'
import { ChatRepository } from '../repositories/chat-repository'
// Stage V V2.1b — `getLogPath` import retired: the only call site (the
// design-run NDJSON append inside `agent:completeToolActionRequest`) moved
// into `toolEventGroup`.
import { createRotatingLogger } from '../../utils/rotating-logger'
// Stage V V2.1b — `appendToolEventLog` import retired from this file when
// the `tools:logToolEvent` handler moved into `toolEventGroup`. The host no
// longer calls the tool-event logger directly.
import {
  clearAllReferenceSkillHints,
  clearLastReferenceSkill,
  setReferenceHintChangeEmitter,
} from '../agent-control/skills/skill-reference-hints'
import { clearSkillTaskProjection } from '../agent-control/skills/skill-task-tracker'
import { registerAskUserQuestionEmitter } from '../agent-control/ask-user/ask-user-bridge'
import {
  getFrozenCallStore,
  registerFrozenCallStore,
} from '../agent-control/safety/frozen-call-bridge'
import { FrozenCallStore } from '../agent-control/safety/frozen-call-store'
import {
  registerAskUserQuestionsCardEmitter,
  registerAskUserQuestionsCardPersistor,
} from '../agent-control/ask-user/ask-user-questions-bridge'
import { registerSkillReferenceInlinedEmitter } from '../agent-control/skills/skill-reference-inlined-bridge'
import { getEphemeralExecutionStore } from '../tools/skill-primitives/ephemeral-execution-store'
import {
  getAskUserQuestionsStore,
  type AskUserQuestionSpec,
} from '../tools/builtins/ask-user-questions-store'
import { getDatabase } from '../database'
import { getSkillsRuntimeManager } from '../skills-runtime/runtime-manager'
import { sanitizeAssistantText } from '../agent-control/tools-runtime/tool-call-text-guard'
import { cancelChildRunForIpc, listActiveChildRunsForIpc } from './active-child-run-ipc'
import { askUserGroup } from './ipc/ask-user-group'
import { toolEventGroup } from './ipc/tool-event-group'
import { agentLifecycleGroup } from './ipc/agent-lifecycle-group'
import { agentRuntimeGroup } from './ipc/agent-runtime-group'
import { mcpGroup, runMcpBoot } from './ipc/mcp-group'
import { agentRegistryGroup } from './ipc/agent-registry-group'
import { agentDerivationGroup } from './ipc/agent-derivation-group'
import { agentSystemStudioGroup } from './ipc/agent-system-studio-group'
import { agentSpecialistBlueprintGroup } from './ipc/agent-specialist-blueprint-group'
import { sessionPrerouteGroup } from './ipc/session-preroute-group'
import { beliefCardGroup } from './ipc/belief-card-group'
import { runQualityGroup } from './ipc/run-quality-group'
import { runFeedbackGroup } from './ipc/run-feedback-group'
import { RunFeedbackRepository } from '../agent-control/task-projection/run-feedback-repository'
import { emergenceFeedGroup } from './ipc/emergence-feed-group'
import { getFileEmergenceIntentCardsForFeed } from '../file-emergence/ipc-handler'
import { listDerivationCandidates } from './ipc/agent-derivation-group'
import { conversationGroup } from './ipc/conversation-group'
import { taskProjectionGroup } from './ipc/task-projection-group'
import { recallGroup } from './ipc/recall-group'
import { detachedTaskGroup } from './ipc/detached-task-group'
import { runControlGroup } from './ipc/run-control-group'
import { telemetryGroup } from './ipc/telemetry-group'
import { channelManagementGroup } from './ipc/channel-management-group'
import { scheduleGroup } from './ipc/schedule-group'
import { chatPersistenceGroup } from './ipc/chat-persistence-group'
import { memoryGroup } from './ipc/memory-group'
import { triggerGroup } from './ipc/trigger-group'
import type { IpcDisposeHandle } from './ipc/types'
import {
  getSpecialistBlueprintConfirmationStore,
  getSpecialistBlueprintStore,
} from '../agent-control/agents/specialist-blueprint-runtime'
import { getSpecialistContentEditProposalStore } from '../agent-control/agents/specialist-content-edit-runtime'
import { resolveSpecialistFoundationSemanticJudge } from '../agent-control/agents/specialist-foundation-semantic-judge-provider'
import { logAgentMetric } from '../agent-control/metrics'
import { KNOWLEDGE_SYSTEM_SETTING_KEY, isKnowledgeSystemEnabled } from '../agent-control/knowledge/knowledge-truth-source'
import { learnSiteCardFromFailure } from '../agent-control/knowledge/site-card-learning'
import { getLastMaintenanceRoundStatus } from '../agent-control/maintenance/maintenance-llm-round'
import { isRendererAgentMetricName } from '../../../shared/renderer-agent-metrics'
// Stage V V2.1c — `SendScopedUserMessage` import retired: the only call
// site (the `agent:sendScoped` payload type) moved into `agentLifecycleGroup`.
import type { ScopeRunEventPayload } from '../agent-control/contracts/types'
import type { TaskProjectionChangeEvent } from '../agent-control/contracts/run-contracts'

let mammothLib: typeof import('mammoth') | null = null
let xlsxLib: typeof import('xlsx') | null = null

async function getMammoth(): Promise<typeof import('mammoth') | null> {
  if (mammothLib) return mammothLib
  try {
    mammothLib = await import('mammoth')
    return mammothLib
  } catch {
    return null
  }
}

async function getXlsx(): Promise<typeof import('xlsx') | null> {
  if (xlsxLib) return xlsxLib
  try {
    xlsxLib = await import('xlsx')
    return xlsxLib
  } catch {
    return null
  }
}

function normalizeCell(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function looksLikeReadableText(value: string): boolean {
  if (!value || value.trim().length === 0) return false
  const sample = value.slice(0, 4000)
  let printable = 0
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i)
    const isControl = code < 32 && code !== 9 && code !== 10 && code !== 13
    if (!isControl) printable += 1
  }
  return printable / sample.length > 0.88
}

const directChatLogger = createRotatingLogger('ready-directchat.log')
function log(msg: string) {
  try { directChatLogger.append(`[${new Date().toISOString()}] ${msg}\n`) } catch { /* */ }
}

function mapAgentStatusToScopeRunPhase(status: unknown): ScopeRunEventPayload['phase'] | null {
  const normalized = String(status || '').trim()
  if (normalized === 'working') return 'planning'
  if (normalized === 'checkpoint') return 'checkpoint'
  if (normalized === 'done') return 'done'
  if (normalized === 'cancelled') return 'cancelled'
  if (normalized === 'error' || normalized === 'timeout') return 'error'
  return null
}

function mapAgentStatusToScopeRunEventType(status: unknown): ScopeRunEventPayload['type'] {
  const normalized = String(status || '').trim()
  if (normalized === 'working') return 'started'
  if (
    normalized === 'checkpoint' ||
    normalized === 'done' ||
    normalized === 'cancelled' ||
    normalized === 'error' ||
    normalized === 'timeout'
  ) {
    return 'finished'
  }
  return 'updated'
}

function normalizeScopeRunTerminalReason(value: unknown): ScopeRunEventPayload['terminalReason'] {
  const normalized = String(value || '').trim()
  if (
    normalized === 'done' ||
    normalized === 'checkpoint_budget' ||
    normalized === 'checkpoint_background' ||
    normalized === 'checkpoint_user_input' ||
    normalized === 'blocked_config' ||
    normalized === 'blocked_external' ||
    normalized === 'blocked_tool_error' ||
    normalized === 'failed_skill' ||
    normalized === 'resume_launch_failed' ||
    normalized === 'persistence_failed' ||
    normalized === 'cancelled_user' ||
    normalized === 'cancelled_runtime' ||
    normalized === 'main_no_progress_timeout'
  ) {
    return normalized
  }
  return null
}

export interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  mock?: boolean
  errorKind?: string
  persistence?: unknown
}

let runtime: AgentControlRuntime | null = null
const chatRepository = new ChatRepository()

/**
 * Stage O — module-scoped slot holding the unsubscribe function returned
 * when `setupAgentIPC` subscribes to `taskProjectionStore.on('change')`.
 * Dev-reload re-runs `setupAgentIPC`; we call this slot before re-binding
 * to prevent listener leaks. `cleanupAgentRuntime` also drains it ahead
 * of `await runtime.stop()` so a trailing emit during stop doesn't fire
 * into a destroyed mainWindow.
 */
let currentTaskProjectionsChangeOff: (() => void) | null = null
let currentAskUserClearedOff: (() => void) | null = null

/**
 * Stage U (PR 1, B.4b) — module-scoped guard so the ask_user_questions DB
 * sweep runs at most once per main-process lifetime. `setupAgentIPC` is
 * re-invoked on dev hot-reload of the renderer side; without this latch
 * the sweep would re-cancel any live in-memory cards on every reload.
 *
 * Reset only by a true main-process restart (the module is reloaded along
 * with the rest of main). `cleanupAgentRuntime` deliberately does NOT reset
 * it — quitting the app and re-launching is the only legitimate path to
 * re-trigger the sweep.
 */
let askUserQuestionsSweepRanForBoot = false
// Phase M —— MCP 启动装配一次性闸（dev reload 不得重复 spawn stdio 子进程）。
let mcpBootstrapRanForBoot = false
let mcpGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.1a — dispose handle returned by `askUserGroup.register`. The 5
 * channels the group owns are removed via `dispose()` so dev-reload can
 * re-register cleanly and `cleanupAgentRuntime` can drop them on shutdown.
 * Idempotent: the slot is null on first call and on second invocation of
 * cleanup.
 */
let askUserGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.1b — dispose handle returned by `toolEventGroup.register`. Owns
 * the 2 channels `tools:logToolEvent` + `agent:completeToolActionRequest`.
 * Same lifecycle pattern as `askUserGroupDispose`: register on
 * `setupAgentIPC`, dispose on dev-reload re-entry, dispose on
 * `cleanupAgentRuntime` shutdown.
 */
let toolEventGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.1c — dispose handle returned by `agentLifecycleGroup.register`.
 * Owns the 4 channels `agent:send` + `agent:newSession` + `agent:kill` +
 * `agent:sendScoped`. Same lifecycle pattern as the other group dispose
 * slots: register on `setupAgentIPC`, dispose on dev-reload re-entry,
 * dispose on `cleanupAgentRuntime` shutdown.
 */
let agentLifecycleGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.1d — dispose handle returned by `agentRuntimeGroup.register`.
 * Owns the 3 read-only runtime introspection channels (`agent:getRuntimeStatus`,
 * `agent:getCapabilityRuntimeSnapshot`, `agent:listChannels`). Same lifecycle
 * pattern as the other group dispose slots: register on `setupAgentIPC`,
 * dispose on dev-reload re-entry, dispose on `cleanupAgentRuntime` shutdown.
 */
let agentRuntimeGroupDispose: IpcDisposeHandle | null = null

/** EP4-A7 — dispose handle for agent registry lifecycle channels. */
let agentRegistryGroupDispose: IpcDisposeHandle | null = null

/** EP4-A6b — dispose handle for candidate-to-agent derivation channels. */
let agentDerivationGroupDispose: IpcDisposeHandle | null = null

/** P8a/P8b — dispose handle for read-only Agent System Studio snapshot. */
let agentSystemStudioGroupDispose: IpcDisposeHandle | null = null

/** P8c/P8f — dispose handle for specialist blueprint draft/admission channels. */
let agentSpecialistBlueprintGroupDispose: IpcDisposeHandle | null = null

/** EP4-A5 — dispose handle for the session preroute evaluate channel. */
let sessionPrerouteGroupDispose: IpcDisposeHandle | null = null

/** EP4 settings surface — belief-card truth-source review/confirmation. */
let beliefCardGroupDispose: IpcDisposeHandle | null = null
let runQualityGroupDispose: IpcDisposeHandle | null = null
/** D5 后端切片 — per-run 用户反馈通道（renderer 评分控件属 D5 待做）。 */
let runFeedbackGroupDispose: IpcDisposeHandle | null = null
/** 梯队三 — emergence feed 组装通道（拉取式，fired 账本随组装打点）。 */
let emergenceFeedGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.1e — dispose handle returned by `conversationGroup.register`.
 * Owns the 8 conversation-scope + attachment channels
 * (`agent:listConversationScopes`, `agent:listScopeRuns`,
 * `agent:getConversationScopeMessages`, `agent:createLocalScope`,
 * `agent:listScopeAttachments`, `agent:getScopeAttachment`,
 * `agent:clearRemoteAttachmentCache`, `agent:getRemoteAttachmentCacheStats`).
 * Same lifecycle pattern as the other group dispose slots: register on
 * `setupAgentIPC`, dispose on dev-reload re-entry, dispose on
 * `cleanupAgentRuntime` shutdown.
 */
let conversationGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.1f — dispose handle returned by `taskProjectionGroup.register`.
 * Owns the 2 task-projection read channels (`agent:listTaskProjections`,
 * `agent:getTaskProjection`). Same lifecycle pattern as the other group
 * dispose slots: register on `setupAgentIPC`, dispose on dev-reload re-entry,
 * dispose on `cleanupAgentRuntime` shutdown.
 */
let taskProjectionGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.1g — dispose handle returned by `recallGroup.register`.
 * Owns the 8 session-recall channels (`agent:searchSessionRecall`,
 * `agent:listRecentSessions`, `agent:getSessionRecallCapsule`,
 * `agent:listAttachedSessionRecallContexts`, `agent:getReferenceSkillHint`,
 * `agent:attachSessionRecallContext`, `agent:detachSessionRecallContext`,
 * `agent:resumeSessionCandidate`). Same lifecycle pattern as the other group
 * dispose slots: register on `setupAgentIPC`, dispose on dev-reload re-entry,
 * dispose on `cleanupAgentRuntime` shutdown.
 */
let recallGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.1h — dispose handle returned by `detachedTaskGroup.register`.
 * Owns the 4 detached-skill task channels (`agent:startDetachedSkillAction`,
 * `agent:inspectDetachedSkillTask`, `agent:listDetachedSkillTasks`,
 * `agent:cancelDetachedSkillTask`). Same lifecycle pattern as the other group
 * dispose slots: register on `setupAgentIPC`, dispose on dev-reload re-entry,
 * dispose on `cleanupAgentRuntime` shutdown.
 */
let detachedTaskGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.1i — dispose handle returned by `runControlGroup.register`.
 * Owns the 5 run-control channels (`agent:listActiveChildRuns`,
 * `agent:cancelChildRun`, `agent:suspendRun`, `agent:resumeRun`,
 * `agent:respondToInteraction`). Same lifecycle pattern as the other group
 * dispose slots: register on `setupAgentIPC`, dispose on dev-reload re-entry,
 * dispose on `cleanupAgentRuntime` shutdown.
 */
let runControlGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.1j — dispose handle returned by `telemetryGroup.register`.
 * Owns the single telemetry channel (`agent:emitRendererMetric`). Same
 * lifecycle pattern as the other group dispose slots: register on
 * `setupAgentIPC`, dispose on dev-reload re-entry, dispose on
 * `cleanupAgentRuntime` shutdown.
 */
let telemetryGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.1k — dispose handle returned by `channelManagementGroup.register`.
 * Owns the 8 agent-channel CRUD + WeChat-login channels (`agent:upsertChannel`,
 * `agent:testChannel`, `agent:startWechatLogin`, `agent:getWechatLoginStatus`,
 * `agent:submitWechatLoginVerifyCode`, `agent:deleteChannel`,
 * `agent:setChannelEnabled`, `agent:sendChannelProbe`). Same lifecycle pattern
 * as the other group dispose slots: register on `setupAgentIPC`, dispose on
 * dev-reload re-entry, dispose on `cleanupAgentRuntime` shutdown.
 */
let channelManagementGroupDispose: IpcDisposeHandle | null = null

/**
 * Dispose handle returned by `scheduleGroup.register`.
 * Owns the structured `scheduledTasks:*` read, mutation, preview, history,
 * and manual-run channels.
 * Same lifecycle pattern as the other group dispose slots: register on
 * `setupAgentIPC`, dispose on dev-reload re-entry, dispose on
 * `cleanupAgentRuntime` shutdown.
 */
let scheduleGroupDispose: IpcDisposeHandle | null = null
let scheduledTaskChangedOff: (() => void) | null = null

/**
 * Stage V V2.1m — dispose handle returned by `chatPersistenceGroup.register`.
 * Owns the 8 chat-persistence + file-picker channels
 * (`chat:getConversations`, `chat:getMessages`, `chat:deleteConversation`,
 * `chat:saveMessage`, `chat:createConversation`, `chat:updateConversationTitle`,
 * `chat:pickFiles`, `chat:readFileForAI`). Same lifecycle pattern as the other
 * group dispose slots: register on `setupAgentIPC`, dispose on dev-reload
 * re-entry, dispose on `cleanupAgentRuntime` shutdown.
 */
let chatPersistenceGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.1n — dispose handle returned by `memoryGroup.register`. Owns
 * the 8 agent-memory channels (`agent:memory:query`, `agent:memory:create`,
 * `agent:memory:update`, `agent:memory:delete`, `agent:memory:stats`,
 * `agent:memory:lifecycle:status`, `agent:memory:lifecycle:runMaintenance`,
 * `agent:memory:createFromConversation`). Same lifecycle pattern as the
 * other group dispose slots: register on `setupAgentIPC`, dispose on
 * dev-reload re-entry, dispose on `cleanupAgentRuntime` shutdown.
 */
let memoryGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.1o — dispose handle returned by `triggerGroup.register`. Owns
 * the 4 agent-trigger channels (`agent:trigger:list`, `agent:trigger:create`,
 * `agent:trigger:update`, `agent:trigger:createWithMemories`). Same lifecycle
 * pattern as the other group dispose slots: register on `setupAgentIPC`,
 * dispose on dev-reload re-entry, dispose on `cleanupAgentRuntime` shutdown.
 * This is the final claude-bridge channel group — `ipc-handler.ts` no longer
 * registers any inline `ipcMain.handle` calls of its own (every surface lives
 * in an extracted group).
 */
let triggerGroupDispose: IpcDisposeHandle | null = null

function cleanupSkillSessionState(sessionId?: string, reason = 'Skill session state cleared'): void {
  if (sessionId) {
    clearLastReferenceSkill(sessionId)
    clearSkillTaskProjection(sessionId)
    getEphemeralExecutionStore().rejectBySession(sessionId, new Error(reason))
    // agent_interaction — pending ask_user_questions cards belong to the
    // turn that issued them; a session reset / kill must drop them too so
    // the renderer card UI clears and the model's awaiting Promise unblocks.
    getAskUserQuestionsStore().rejectBySession(sessionId, new Error(reason))
    // PR 1 B.4c — DB rows for cards in this session must also be swept,
    // otherwise the next renderer hydrate would resurrect a pending row whose
    // in-memory Promise is already gone.
    try {
      const swept = getDatabase().sweepPendingAskUserQuestionsCardsBySession(sessionId, 'session_reset')
      if (swept > 0) {
        logAgentMetric('ask_user_questions_session_reset_swept_db', { sessionId, swept })
      }
    } catch { /* swallow — best-effort */ }
    return
  }
  clearAllReferenceSkillHints()
  clearSkillTaskProjection()
  getEphemeralExecutionStore().clear()
  getAskUserQuestionsStore().clear()
}

function cancelSkillSessionPendingInteractions(sessionId?: string, reason = 'Skill session interaction cancelled'): void {
  if (sessionId) {
    getEphemeralExecutionStore().rejectBySession(sessionId, new Error(reason))
    getAskUserQuestionsStore().rejectBySession(sessionId, new Error(reason))
    // PR 1 B.4c — keep DB aligned with in-memory store after a session-scoped
    // interaction cancel.
    try {
      const swept = getDatabase().sweepPendingAskUserQuestionsCardsBySession(sessionId, 'session_reset')
      if (swept > 0) {
        logAgentMetric('ask_user_questions_session_reset_swept_db', { sessionId, swept })
      }
    } catch { /* swallow — best-effort */ }
    return
  }
  getEphemeralExecutionStore().clear()
  getAskUserQuestionsStore().clear()
}

interface PersistAskUserQuestionsCardArgs {
  cardId: string
  sessionId: string | null
  conversationId: string | null
  questions: AskUserQuestionSpec[]
  askedAt: number
}

/**
 * Persist a card row in `chat_messages` with status='pending'. Runs BEFORE
 * the IPC push so renderer hydrate (`agent:askUserQuestions:listPending`)
 * can never observe a card in IPC that DB hasn't seen yet.
 *
 * Returns the chat_messages row id (= cardId, by design — the cardId IS the
 * message id so submit / cancel / boot-sweep can target it without a join).
 */
function persistAskUserQuestionsCardPending(args: PersistAskUserQuestionsCardArgs): void {
  const conversationId = args.conversationId || args.sessionId || ''
  if (!conversationId) {
    throw new Error('ask_user_questions persist requires a conversationId or sessionId')
  }
  const askedAt = new Date(args.askedAt).toISOString()
  const summary = `等待用户回答 ${args.questions.length} 个问题`
  getDatabase().addChatMessage(
    args.cardId,
    conversationId,
    'agent_card',
    summary,
    askedAt,
    {
      askUserQuestions: {
        cardId: args.cardId,
        status: 'pending',
        questions: args.questions,
        askedAt: args.askedAt,
      },
    },
  )
}

export async function cleanupAgentRuntime(): Promise<void> {
  // Stage O — drop the projection-change subscription BEFORE stopping the
  // runtime so any trailing emit during stop() doesn't reach a destroyed
  // mainWindow. Idempotent: the slot is null on first call.
  if (currentTaskProjectionsChangeOff) {
    try { currentTaskProjectionsChangeOff() } catch { /* ignore */ }
    currentTaskProjectionsChangeOff = null
  }
  if (currentAskUserClearedOff) {
    try { currentAskUserClearedOff() } catch { /* ignore */ }
    currentAskUserClearedOff = null
  }
  // Stage V V2.1a — release the askUser channel handlers symmetric with
  // their register-on-setup. Other extracted groups follow the same shape.
  if (askUserGroupDispose) {
    try { askUserGroupDispose.dispose() } catch { /* ignore */ }
    askUserGroupDispose = null
  }
  // Stage V V2.1b — symmetric release of the 2 toolEvent channel handlers
  // (`tools:logToolEvent` + `agent:completeToolActionRequest`).
  if (toolEventGroupDispose) {
    try { toolEventGroupDispose.dispose() } catch { /* ignore */ }
    toolEventGroupDispose = null
  }
  // Stage V V2.1c — symmetric release of the 4 agent-lifecycle channel
  // handlers (`agent:send` + `agent:newSession` + `agent:kill` +
  // `agent:sendScoped`).
  if (agentLifecycleGroupDispose) {
    try { agentLifecycleGroupDispose.dispose() } catch { /* ignore */ }
    agentLifecycleGroupDispose = null
  }
  // Stage V V2.1d — symmetric release of the 3 agent-runtime introspection
  // channel handlers (`agent:getRuntimeStatus`,
  // `agent:getCapabilityRuntimeSnapshot`, `agent:listChannels`).
  if (agentRuntimeGroupDispose) {
    try { agentRuntimeGroupDispose.dispose() } catch { /* ignore */ }
    agentRuntimeGroupDispose = null
  }
  if (agentRegistryGroupDispose) {
    try { agentRegistryGroupDispose.dispose() } catch { /* ignore */ }
    agentRegistryGroupDispose = null
  }
  if (agentDerivationGroupDispose) {
    try { agentDerivationGroupDispose.dispose() } catch { /* ignore */ }
    agentDerivationGroupDispose = null
  }
  if (agentSystemStudioGroupDispose) {
    try { agentSystemStudioGroupDispose.dispose() } catch { /* ignore */ }
    agentSystemStudioGroupDispose = null
  }
  if (agentSpecialistBlueprintGroupDispose) {
    try { agentSpecialistBlueprintGroupDispose.dispose() } catch { /* ignore */ }
    agentSpecialistBlueprintGroupDispose = null
  }
  // EP4-A5 — symmetric release of the session preroute evaluate channel.
  if (sessionPrerouteGroupDispose) {
    try { sessionPrerouteGroupDispose.dispose() } catch { /* ignore */ }
    sessionPrerouteGroupDispose = null
  }
  if (beliefCardGroupDispose) {
    try { beliefCardGroupDispose.dispose() } catch { /* ignore */ }
    beliefCardGroupDispose = null
  }
  if (runQualityGroupDispose) {
    try { runQualityGroupDispose.dispose() } catch { /* ignore */ }
    runQualityGroupDispose = null
  }
  if (runFeedbackGroupDispose) {
    try { runFeedbackGroupDispose.dispose() } catch { /* ignore */ }
    runFeedbackGroupDispose = null
  }
  if (emergenceFeedGroupDispose) {
    try { emergenceFeedGroupDispose.dispose() } catch { /* ignore */ }
    emergenceFeedGroupDispose = null
  }
  // Stage V V2.1e — symmetric release of the 8 conversation-scope + attachment
  // channel handlers (listConversationScopes / listScopeRuns /
  // getConversationScopeMessages / createLocalScope / listScopeAttachments /
  // getScopeAttachment / clearRemoteAttachmentCache /
  // getRemoteAttachmentCacheStats).
  if (conversationGroupDispose) {
    try { conversationGroupDispose.dispose() } catch { /* ignore */ }
    conversationGroupDispose = null
  }
  // Stage V V2.1f — symmetric release of the 2 task-projection read channel
  // handlers (`agent:listTaskProjections`, `agent:getTaskProjection`).
  if (taskProjectionGroupDispose) {
    try { taskProjectionGroupDispose.dispose() } catch { /* ignore */ }
    taskProjectionGroupDispose = null
  }
  // Stage V V2.1g — symmetric release of the 8 session-recall channel
  // handlers (searchSessionRecall / listRecentSessions /
  // getSessionRecallCapsule / listAttachedSessionRecallContexts /
  // getReferenceSkillHint / attachSessionRecallContext /
  // detachSessionRecallContext / resumeSessionCandidate).
  if (recallGroupDispose) {
    try { recallGroupDispose.dispose() } catch { /* ignore */ }
    recallGroupDispose = null
  }
  // Stage V V2.1h — symmetric release of the 4 detached-skill task channel
  // handlers (startDetachedSkillAction / inspectDetachedSkillTask /
  // listDetachedSkillTasks / cancelDetachedSkillTask).
  if (detachedTaskGroupDispose) {
    try { detachedTaskGroupDispose.dispose() } catch { /* ignore */ }
    detachedTaskGroupDispose = null
  }
  // Stage V V2.1i — symmetric release of the 5 run-control channel handlers
  // (listActiveChildRuns / cancelChildRun / suspendRun / resumeRun /
  // respondToInteraction).
  if (runControlGroupDispose) {
    try { runControlGroupDispose.dispose() } catch { /* ignore */ }
    runControlGroupDispose = null
  }
  // Stage V V2.1j — symmetric release of the single telemetry channel
  // handler (emitRendererMetric).
  if (telemetryGroupDispose) {
    try { telemetryGroupDispose.dispose() } catch { /* ignore */ }
    telemetryGroupDispose = null
  }
  // Stage V V2.1k — symmetric release of the 8 channel-management +
  // WeChat-login channel handlers (upsertChannel / testChannel /
  // startWechatLogin / getWechatLoginStatus / submitWechatLoginVerifyCode /
  // deleteChannel / setChannelEnabled / sendChannelProbe).
  if (channelManagementGroupDispose) {
    try { channelManagementGroupDispose.dispose() } catch { /* ignore */ }
    channelManagementGroupDispose = null
  }
  // Symmetric release of the structured scheduled-task handlers.
  if (scheduleGroupDispose) {
    try { scheduleGroupDispose.dispose() } catch { /* ignore */ }
    scheduleGroupDispose = null
  }
  if (scheduledTaskChangedOff) {
    scheduledTaskChangedOff()
    scheduledTaskChangedOff = null
  }
  // Stage V V2.1m — symmetric release of the 8 chat-persistence +
  // file-picker channel handlers (getConversations / getMessages /
  // deleteConversation / saveMessage / createConversation /
  // updateConversationTitle / pickFiles / readFileForAI).
  if (chatPersistenceGroupDispose) {
    try { chatPersistenceGroupDispose.dispose() } catch { /* ignore */ }
    chatPersistenceGroupDispose = null
  }
  // Stage V V2.1n — symmetric release of the 8 agent-memory channel
  // handlers (memory:query / create / update / delete / stats +
  // memory:lifecycle:status / runMaintenance + memory:createFromConversation).
  if (memoryGroupDispose) {
    try { memoryGroupDispose.dispose() } catch { /* ignore */ }
    memoryGroupDispose = null
  }
  // Stage V V2.1o — symmetric release of the 4 agent-trigger channel
  // handlers (trigger:list / create / update / createWithMemories). Final
  // claude-bridge group — `ipc-handler.ts` no longer owns any inline
  // handlers of its own.
  if (triggerGroupDispose) {
    try { triggerGroupDispose.dispose() } catch { /* ignore */ }
    triggerGroupDispose = null
  }
  if (runtime) {
    await runtime.stop()
    runtime = null
  }
  cleanupSkillSessionState(undefined, 'Agent runtime shut down')
  // RE-AUDIT FIX 5.4 — release the reference-skill hint emitter so its
  // closure (which captures mainWindow) doesn't pin the destroyed window
  // and prevent GC. Idempotent — safe to call when no emitter was set.
  setReferenceHintChangeEmitter(null)
  registerSkillReferenceInlinedEmitter(null)
}

export async function reconcileAgentSchedulesOnResume(): Promise<void> {
  await runtime?.reconcileScheduledTasks('resume')
}

export function setupAgentIPC(agentManager: AgentManager, mainWindow: BrowserWindow, browserController?: BrowserController): void {
  if (!runtime) {
    runtime = new AgentControlRuntime(agentManager, browserController)
    void runtime.start()
    // Phase 1.3 — kick off the Python venv health check immediately after the
    // runtime starts. Fire-and-forget: a stale 3.14 venv (left over from a
    // prior install) gets nuked + rebuilt in the background BEFORE the first
    // skill_run_shell hits a confused interpreter. The wrapper logs a startup
    // banner so the version is observable in `<tmp>/ready-startup.log`.
    void getSkillsRuntimeManager().ensurePythonRuntimeReady()
  } else if (browserController) {
    runtime.getOrchestrator().setBrowserController(browserController)
  }
  // Wire the note_collect → chat task-projection sink (plan §3.3). setting it
  // re-projects any already-running/resumed collection so its card appears.
  if (browserController) {
    browserController.setTaskProjectionSink(makeNoteCollectProjectionSink(runtime))
    browserController.setSiteCardLearningSink({
      learnFromVisibleCollectFailure: (signal) => {
        try {
          learnSiteCardFromFailure(runtime!.getBeliefCardStore(), signal)
        } catch (error) {
          logAgentMetric('site_card_learning_failed', {
            domain: signal.domain,
            failureKind: signal.failureKind,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    })
  }
  // B Phase 1 PR2 T1-7: wire `skill_ask_user` to push questions to the
  // renderer. The bridge keeps the handler independent of electron so it can
  // be unit-tested under `tsx --test`.
	  registerAskUserQuestionEmitter((event) => {
	    if (mainWindow.isDestroyed()) return
	    mainWindow.webContents.send('skill:askUserQuestion', event)
	  })
	  if (currentAskUserClearedOff) {
	    try { currentAskUserClearedOff() } catch { /* ignore */ }
	    currentAskUserClearedOff = null
	  }
	  currentAskUserClearedOff = getEphemeralExecutionStore().onCleared((event) => {
	    if (mainWindow.isDestroyed()) return
	    mainWindow.webContents.send('skill:askUserCleared', event)
	  })
  // agent_interaction — wire `ask_user_questions` emitter + persistor.
  // Boot sweep runs FIRST (synchronously, before any renderer hydrate) so
  // pending cards from a previous app run never resurrect with a missing
  // Promise resolver.
  //
  // Stage U (PR 1, B.4b) — guarded by `askUserQuestionsSweepRanForBoot` so
  // the sweep happens once per main-process lifetime. Even within that one
  // sweep, the in-memory store snapshot (`liveCardIds`) protects any cards
  // whose Promise resolver is still alive (e.g. dev reload preserved them).
  if (!askUserQuestionsSweepRanForBoot) {
    try {
      const liveCardIds = new Set(
        getAskUserQuestionsStore().list().map((entry) => entry.cardId),
      )
      const { mutated, skippedLive } = getDatabase().sweepPendingAskUserQuestionsCardsOnBoot({ liveCardIds })
      if (mutated > 0) {
        log(`ask_user_questions boot sweep cancelled ${mutated} stale pending card(s)`)
      }
      if (skippedLive > 0) {
        log(`ask_user_questions boot sweep skipped ${skippedLive} live card(s) (in-memory store)`)
        logAgentMetric('ask_user_questions_boot_sweep_skipped_live', { skippedLive })
      }
    } catch (sweepErr) {
      // Don't crash boot — the worst case is one stale pending card we'll
      // hide via renderer-side timestamp check.
      log(`ask_user_questions boot sweep failed: ${sweepErr instanceof Error ? sweepErr.message : String(sweepErr)}`)
    }
    askUserQuestionsSweepRanForBoot = true
  }
  registerAskUserQuestionsCardEmitter((event) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:askUserQuestions:push', event)
    }
    // Phase I P0 —— 远程 scope 的卡同时转投微信线程（本地 push 保持原样，
    // 双出口）。非渠道 scope 在 runtime 内零动作；转投失败只记 metric，
    // 本地卡照常可答（合同条款 1/5）。
    void runtime?.forwardAskUserCardToRemoteChannel(event).catch(() => undefined)
  })
  registerAskUserQuestionsCardPersistor((args) => persistAskUserQuestionsCardPending(args))
  // Phase M（2026-07-05）—— MCP 管理面 IPC group（status/saveConfig/reload）+
  // 一次性启动装配（dev reload 不重复 spawn stdio 子进程；逐 server 容错，
  // 永不阻塞 agent IPC 启动）。
  if (mcpGroupDispose) {
    try { mcpGroupDispose.dispose() } catch { /* ignore */ }
    mcpGroupDispose = null
  }
  mcpGroupDispose = mcpGroup.register(ipcMain, {
    getDatabase: () => getDatabase(),
    log: (line) => log(line),
  })
  if (!mcpBootstrapRanForBoot) {
    mcpBootstrapRanForBoot = true
    void runMcpBoot({
      getDatabase: () => getDatabase(),
      log: (line) => log(line),
    }).catch((bootstrapErr) => {
      log(`mcp bootstrap failed: ${bootstrapErr instanceof Error ? bootstrapErr.message : String(bootstrapErr)}`)
    })
  }
  // EP1-I3-2 — frozen-call confirmation store (M2/M3 action-confirmation
  // gate). Register once per main-process lifetime: a dev reload must not
  // replace a store that may hold live pending waiters. The constructor's
  // boot sweep expires DB-pending orphans from a previous run (the release
  // token is memory-only — there is no context to resume into).
  if (!getFrozenCallStore()) {
    try {
      registerFrozenCallStore(new FrozenCallStore(getDatabase().getRawDb()))
    } catch (frozenStoreErr) {
      // Without a store the gate keeps its deny-by-default placeholder —
      // unconfirmable M2/M3 calls are rejected, never silently executed.
      log(`frozen-call store wiring failed: ${frozenStoreErr instanceof Error ? frozenStoreErr.message : String(frozenStoreErr)}`)
    }
  }
  registerSkillReferenceInlinedEmitter((event) => {
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send('skill:referenceInlined', event)
  })
  // Phase 5.3 — push reference-skill hint changes to the renderer so the
  // "上下文已启用" badge stays in sync without needing scope-run-event ticks
  // to pull. Audit Phase 5 §E3.
  setReferenceHintChangeEmitter((scopeId, change) => {
    if (mainWindow.isDestroyed()) return
    // Stage V V3.2 — push payload carries sessionId so renderer can route
    // per-session. scopeId === sessionId in current model; we mirror to
    // sessionId explicitly so consumers don't have to know that aliasing.
    mainWindow.webContents.send('agent:referenceSkillHintChanged', {
      scopeId,
      sessionId: scopeId,
      change,
    })
  })
  // Stage O §0.3 — push `agent:taskProjectionsChanged` to the renderer on
  // every successful create/update/delete in the task-projection store.
  // dev-reload re-runs setupAgentIPC; first drain any prior subscription
  // so we don't leak listeners and double-send.
  if (currentTaskProjectionsChangeOff) {
    try { currentTaskProjectionsChangeOff() } catch { /* ignore */ }
    currentTaskProjectionsChangeOff = null
  }
  const projectionStore = runtime.getTaskProjectionStore()
  const onProjectionChange = (event: TaskProjectionChangeEvent): void => {
    if (mainWindow.isDestroyed()) return
    // Stage V V3.2 — mirror scopeId to sessionId so multi-session renderer
    // listeners can route without coupling to the scopeId alias.
    mainWindow.webContents.send('agent:taskProjectionsChanged', {
      ...event,
      sessionId: event.scopeId,
    })
  }
  projectionStore.on('change', onProjectionChange)
  currentTaskProjectionsChangeOff = () => {
    try { projectionStore.off('change', onProjectionChange) } catch { /* ignore */ }
  }
  // Stage V V2.1a — 5 askUser channels (skills:askUser:* + agent:askUserQuestions:*)
  // moved into `askUserGroup`. The group handles dev-reload removeHandler
  // pre-clear internally; we hold the dispose handle so `cleanupAgentRuntime`
  // can drop the handlers on shutdown. Re-binding on dev reload first calls
  // `dispose()` on the prior handle so listener slots stay clean.
  if (askUserGroupDispose) {
    try { askUserGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    askUserGroupDispose = null
  }
	  askUserGroupDispose = askUserGroup.register(ipcMain, {
	    getDatabase,
	    getEphemeralExecutionStore,
	    getAskUserQuestionsStore,
	    logAgentMetric: (name, payload) => logAgentMetric(name, payload),
	    refreshActiveRunProgress: (agent, sessionId, requestId) =>
	      runtime!.getOrchestrator().refreshActiveRunProgress(agent, sessionId, requestId),
	  })
  const orchestrator = runtime.getOrchestrator()
  const pendingToolActionRequests = new Map<string, {
    resolve: (payload: Record<string, unknown>) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
    agent: string
    sessionId: string
  }>()
  // Reverse index: "${agent}|${sessionId}" → requestIds waiting on the renderer.
  // Lets agent:kill / agent:newSession cancel in-flight requests instead of waiting for the 120s watchdog.
  const sessionPendingIndex = new Map<string, Set<string>>()
  const indexKey = (agent: string, sessionId?: string): string => `${agent || ''}|${sessionId || ''}`
  const releasePendingRequest = (requestId: string): void => {
    const entry = pendingToolActionRequests.get(requestId)
    if (!entry) return
    pendingToolActionRequests.delete(requestId)
    clearTimeout(entry.timer)
    const key = indexKey(entry.agent, entry.sessionId)
    const set = sessionPendingIndex.get(key)
    if (set) {
      set.delete(requestId)
      if (set.size === 0) sessionPendingIndex.delete(key)
    }
  }
  const cancelToolActionRequestsBySession = (agent: string, sessionId?: string): void => {
    const key = indexKey(agent, sessionId)
    const requestIds = sessionPendingIndex.get(key)
    if (!requestIds || requestIds.size === 0) return
    const cancelled: string[] = []
    for (const rid of Array.from(requestIds)) {
      const entry = pendingToolActionRequests.get(rid)
      if (!entry) continue
      pendingToolActionRequests.delete(rid)
      clearTimeout(entry.timer)
      entry.reject(new Error('cancelled'))
      cancelled.push(rid)
    }
    sessionPendingIndex.delete(key)
    if (!mainWindow.isDestroyed() && cancelled.length > 0) {
      // Stage V V3.2 — carry sessionId on the cancel push so the renderer
      // can scope the cancellation to the correct session (multi-session UI
      // ignores cancels destined for other sessions).
      mainWindow.webContents.send('agent:cancelToolActionRequest', {
        requestIds: cancelled,
        agent,
        sessionId: sessionId || null,
      })
    }
  }
  const requestRendererToolAction = async (payload: {
    agent?: string
    sessionId?: string
    runId?: string
    tool: string
    args: Record<string, unknown>
  }): Promise<Record<string, unknown>> => {
    if (mainWindow.isDestroyed()) {
      throw new Error('Main window is not available for design tool execution')
    }
    const requestId = randomUUID()
    const agent = payload.agent || ''
    const sessionId = payload.sessionId || ''
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        releasePendingRequest(requestId)
        reject(new Error(`Timed out waiting for renderer tool action result: ${payload.tool}`))
      }, 120_000)
      pendingToolActionRequests.set(requestId, { resolve, reject, timer, agent, sessionId })
      const key = indexKey(agent, sessionId)
      let set = sessionPendingIndex.get(key)
      if (!set) { set = new Set<string>(); sessionPendingIndex.set(key, set) }
      set.add(requestId)
      // Renderer resolves scopeId by scanning scopeRunStates when scopeId/sessionId absent.
      //   Main's sessionId is the scopeId in practice — forward it explicitly so the renderer
      //   short-circuits the scan even when its scope run state has been retired.
      // Stage V V3.2 — explicit sessionId on the push (null when global)
      // so multi-session renderer can route the request without aliasing
      // through scopeId.
      mainWindow.webContents.send('agent:toolActionRequest', {
        requestId,
        scopeId: sessionId || undefined,
        ...payload,
        sessionId: payload.sessionId ?? null,
      })
    })
  }
  orchestrator.setRendererToolActionRequester(requestRendererToolAction)
  orchestrator.setCancelPendingToolActions(cancelToolActionRequestsBySession)
  log('setupAgentIPC called, Ready agent runtime initialized')

  // Stage V V2.1b — 2 toolEvent channels (`tools:logToolEvent` +
  // `agent:completeToolActionRequest`) moved into `toolEventGroup`. The group
  // handles dev-reload removeAllListeners + removeHandler pre-clear
  // internally; we hold the dispose handle so `cleanupAgentRuntime` can drop
  // the handlers on shutdown. Re-binding on dev reload first calls
  // `dispose()` on the prior handle so listener slots stay clean.
  if (toolEventGroupDispose) {
    try { toolEventGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    toolEventGroupDispose = null
  }
  toolEventGroupDispose = toolEventGroup.register(ipcMain, {
    pendingToolActionRequests,
    releasePendingRequest,
  })

  // Stage V V2.1c — 4 agent-lifecycle channels (`agent:send`,
  // `agent:newSession`, `agent:kill`, `agent:sendScoped`) moved into
  // `agentLifecycleGroup`. The group handles dev-reload removeHandler
  // pre-clear internally; we hold the dispose handle so `cleanupAgentRuntime`
  // can drop the handlers on shutdown. Re-binding on dev reload first calls
  // `dispose()` on the prior handle so listener slots stay clean.
  //
  // Note `runtime!.sendScoped` is bound here (rather than passing `runtime`)
  // so the group never imports `AgentControlRuntime` and stays decoupled from
  // engine internals — the `runtime` non-null assertion is safe because the
  // module-scope `runtime` is initialized at the top of `setupAgentIPC`.
  if (agentLifecycleGroupDispose) {
    try { agentLifecycleGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    agentLifecycleGroupDispose = null
  }
  agentLifecycleGroupDispose = agentLifecycleGroup.register(ipcMain, {
    orchestrator,
    sendScoped: (payload) => runtime!.sendScoped(payload),
    cancelToolActionRequestsBySession,
    cleanupSkillSessionState,
    cancelSkillSessionPendingInteractions,
    log,
  })

  // Stage U PR U1.2 — legacy agent IPC channels removed.
  // `agent:orchestrate`, `agent:getStatus`, `agent:getAll`, `agent:getDiagnostics`
  // were the AgentManager-era admission surface. Verified zero renderer callers
  // before deletion (see audit §1.1). Current production runs exclusively
  // through `agent:getRuntimeStatus` + `agent:getCapabilityRuntimeSnapshot` +
  // the SDK runtime channels below. Reintroduction is fenced by
  // `scripts/check-no-legacy-agent-ipc.cjs`.

  // Stage V V2.1d — agent runtime introspection channels lifted into
  // `agentRuntimeGroup`. The group pre-clears internally; we hold the dispose
  // handle so `cleanupAgentRuntime` can drop them on shutdown.
  if (agentRuntimeGroupDispose) {
    try { agentRuntimeGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    agentRuntimeGroupDispose = null
  }
  agentRuntimeGroupDispose = agentRuntimeGroup.register(ipcMain, {
    getRuntimeStatus: () => runtime!.getRuntimeStatus(),
    getCapabilityRuntimeSnapshot: (config) => runtime!.getCapabilityRuntimeSnapshot(config),
    listChannels: () => runtime!.listChannels(),
  })

  if (agentRegistryGroupDispose) {
    try { agentRegistryGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    agentRegistryGroupDispose = null
  }
  agentRegistryGroupDispose = agentRegistryGroup.register(ipcMain, {
    listAgents: () => runtime!.getAgentRegistry().list(),
    getBeliefCardStore: () => runtime?.getBeliefCardStore() ?? null,
    updateStatus: (id, status, options) => runtime!.getAgentRegistry().updateStatus(id, status, options),
    deleteAgent: (id) => runtime!.getAgentRegistry().deleteAgent(id),
  })
  if (agentDerivationGroupDispose) {
    try { agentDerivationGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    agentDerivationGroupDispose = null
  }
  agentDerivationGroupDispose = agentDerivationGroup.register(ipcMain, {
    getBeliefCardStore: () => runtime?.getBeliefCardStore() ?? null,
    getAgentRegistry: () => runtime!.getAgentRegistry(),
    getBlueprintStore: getSpecialistBlueprintStore,
  })
  if (agentSpecialistBlueprintGroupDispose) {
    try { agentSpecialistBlueprintGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    agentSpecialistBlueprintGroupDispose = null
  }
  const specialistSemanticJudge = resolveSpecialistFoundationSemanticJudge()
  agentSpecialistBlueprintGroupDispose = agentSpecialistBlueprintGroup.register(ipcMain, {
    getBlueprintStore: getSpecialistBlueprintStore,
    getConfirmationStore: getSpecialistBlueprintConfirmationStore,
    getBeliefCardStore: () => runtime?.getBeliefCardStore() ?? null,
    getAgentRegistry: () => runtime!.getAgentRegistry(),
    runSemanticFoundationJudge: specialistSemanticJudge.judge,
    semanticFoundationJudgeUnavailableReason: specialistSemanticJudge.unavailableReason,
  })
  if (agentSystemStudioGroupDispose) {
    try { agentSystemStudioGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    agentSystemStudioGroupDispose = null
  }
  agentSystemStudioGroupDispose = agentSystemStudioGroup.register(ipcMain, {
    listAgents: () => runtime!.getAgentRegistry().list(),
    getAgentRegistry: () => runtime!.getAgentRegistry(),
    getBeliefCardStore: () => runtime?.getBeliefCardStore() ?? null,
    getContentEditProposalStore: getSpecialistContentEditProposalStore,
    listOwnedTasks: (agentId) => runtime!.listTaskProjectionsByOwner(agentId, 8),
    listRecentPrerouteTraces: (limit) => runtime!.listRecentSessionPrerouteTraces(limit),
    listStagedBlueprints: () => getSpecialistBlueprintStore().list(['draft', 'needs_clarification', 'staged', 'confirmed']),
    getAgentReadiness: (agentId) => runtime!.resolveAgentExecutionReadiness(agentId),
    simulateRouting: (firstMessage) => runtime!.simulateSessionPrerouteForStudio(firstMessage),
  })

  // EP4-A5 — session preroute evaluate (pure, read-only; renderer acts).
  if (sessionPrerouteGroupDispose) {
    try { sessionPrerouteGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    sessionPrerouteGroupDispose = null
  }
  sessionPrerouteGroupDispose = sessionPrerouteGroup.register(ipcMain, {
    evaluateSessionPreroute: (firstMessage) => runtime!.evaluateSessionPreroute(firstMessage),
  })

  if (beliefCardGroupDispose) {
    try { beliefCardGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    beliefCardGroupDispose = null
  }
  beliefCardGroupDispose = beliefCardGroup.register(ipcMain, {
    getBeliefCardStore: () => runtime?.getBeliefCardStore() ?? null,
    getKnowledgeSystemEnabled: () => isKnowledgeSystemEnabled(getDatabase()),
    setKnowledgeSystemEnabled: (enabled) => {
      getDatabase().setSetting(KNOWLEDGE_SYSTEM_SETTING_KEY, enabled ? 'true' : 'false')
      runtime?.applyKnowledgeSystemEnabled(enabled)
    },
    getLifecycleStatus: () => {
      const manager = runtime!.getMemoryLifecycleManager()
      return { running: manager.isRunning(), lastMaintenanceAt: manager.getLastMaintenanceAt() }
    },
    getMaintenanceRoundStatus: () => getLastMaintenanceRoundStatus(),
  })

  // P0-4 (2026-07-02 P0 visibility batch) — read-only run quality stats.
  if (runQualityGroupDispose) {
    try { runQualityGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    runQualityGroupDispose = null
  }
  runQualityGroupDispose = runQualityGroup.register(ipcMain, {})

  // D5 后端切片 — per-run 用户反馈（submit/list）。repository 按需从 rawDb
  // 构造；SQLite 不可用时通道回结构化 sqlite_unavailable，而非静默丢失。
  if (runFeedbackGroupDispose) {
    try { runFeedbackGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    runFeedbackGroupDispose = null
  }
  runFeedbackGroupDispose = runFeedbackGroup.register(ipcMain, {
    getRepository: () => {
      const rawDb = getDatabase().getRawDb()
      return rawDb ? new RunFeedbackRepository(rawDb) : null
    },
    resolveRunIdForTask: (taskId) => {
      const projection = runtime!.getTaskProjection(taskId)
      return projection && typeof projection.runId === 'string' && projection.runId.length > 0
        ? projection.runId
        : null
    },
  })

  // 梯队三 — emergence feed 组装。信号源三路：跨 scope 最近投影（resume/
  // follow_up）、belief 卡（crystallize：staged aspire + 疑似重复）、涌现候选
  // （复用 derivation 的 stage=candidate + 证据≥3 投影）。
  if (emergenceFeedGroupDispose) {
    try { emergenceFeedGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    emergenceFeedGroupDispose = null
  }
  emergenceFeedGroupDispose = emergenceFeedGroup.register(ipcMain, {
    listRecentProjections: (limit) => runtime!.listRecentTaskProjections(limit),
    listCrystallizeSignals: () => {
      const store = runtime?.getBeliefCardStore() ?? null
      if (!store) return []
      return store.listCards({ includeStaged: true }).map((card) => ({
        relPath: card.relPath,
        title: card.frontmatter.title,
        tag: card.frontmatter.tag,
        status: card.frontmatter.status,
        source: card.frontmatter.source ?? null,
        stage: card.frontmatter.stage ?? null,
      }))
    },
    listCandidateSignals: () => {
      const store = runtime?.getBeliefCardStore() ?? null
      if (!store) return []
      return listDerivationCandidates(store).map((candidate) => ({
        relPath: candidate.candidateRelPath,
        title: candidate.title,
        stage: 'candidate',
        evidenceDates: candidate.evidenceDates,
      }))
    },
    listFileIntentCards: () => getFileEmergenceIntentCardsForFeed(),
  })

  // Stage V V2.1e — conversation-scope + attachment channels lifted into
  // `conversationGroup`. The group pre-clears internally; we hold the dispose
  // handle so `cleanupAgentRuntime` can drop them on shutdown. Eight channels
  // moved in one shot: listConversationScopes, listScopeRuns,
  // getConversationScopeMessages, createLocalScope, listScopeAttachments,
  // getScopeAttachment, clearRemoteAttachmentCache, getRemoteAttachmentCacheStats.
  if (conversationGroupDispose) {
    try { conversationGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    conversationGroupDispose = null
  }
  conversationGroupDispose = conversationGroup.register(ipcMain, {
    listConversationScopes: (agent) => runtime!.listConversationScopes(agent),
    listScopeRuns: (payload) => runtime!.listScopeRuns(payload),
    getConversationScopeMessages: (scopeId) => runtime!.getConversationScopeMessages(scopeId),
    createLocalScopeWithMode: (agent, id) => runtime!.createLocalScopeWithMode(agent, id),
    listScopeAttachments: (scopeId) => runtime!.listScopeAttachments(scopeId),
    getScopeAttachment: (scopeId, attachmentId) => runtime!.getScopeAttachment(scopeId, attachmentId),
    clearRemoteAttachmentCache: (channelId) => runtime!.clearRemoteAttachmentCache(channelId),
    getRemoteAttachmentCacheStats: (channelId) => runtime!.getRemoteAttachmentCacheStats(channelId),
    log,
  })

  // Stage V V2.1f — 2 task-projection read channels (`agent:listTaskProjections`,
  // `agent:getTaskProjection`) moved into `taskProjectionGroup`. The group
  // pre-clears internally; we hold the dispose handle so `cleanupAgentRuntime`
  // can drop the handlers on shutdown. Re-binding on dev reload first calls
  // `dispose()` on the prior handle so listener slots stay clean.
  if (taskProjectionGroupDispose) {
    try { taskProjectionGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    taskProjectionGroupDispose = null
  }
  taskProjectionGroupDispose = taskProjectionGroup.register(ipcMain, {
    listTaskProjections: (scopeId) => runtime!.listTaskProjections(scopeId),
    getTaskProjection: (taskId) => runtime!.getTaskProjection(taskId),
  })

  // Stage V V2.1g — 8 session-recall channels (`agent:searchSessionRecall`,
  // `agent:listRecentSessions`, `agent:getSessionRecallCapsule`,
  // `agent:listAttachedSessionRecallContexts`, `agent:getReferenceSkillHint`,
  // `agent:attachSessionRecallContext`, `agent:detachSessionRecallContext`,
  // `agent:resumeSessionCandidate`) moved into `recallGroup`. The group
  // pre-clears internally; we hold the dispose handle so `cleanupAgentRuntime`
  // can drop them on shutdown. Re-binding on dev reload first calls
  // `dispose()` on the prior handle so listener slots stay clean.
  if (recallGroupDispose) {
    try { recallGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    recallGroupDispose = null
  }
  recallGroupDispose = recallGroup.register(ipcMain, {
    searchSessionRecall: (payload) => runtime!.searchSessionRecall(payload),
    listRecentSessions: (payload) => runtime!.listRecentSessions(payload),
    getSessionRecallCapsule: (conversationId) => runtime!.getSessionRecallCapsule(conversationId),
    listAttachedSessionRecallContexts: (scopeId) => runtime!.listAttachedSessionRecallContexts(scopeId),
    getReferenceSkillHint: (scopeId) => runtime!.getReferenceSkillHint(scopeId),
    attachSessionRecallContext: (currentScopeId, conversationId) => runtime!.attachSessionRecallContext(currentScopeId, conversationId),
    detachSessionRecallContext: (currentScopeId, conversationId) => runtime!.detachSessionRecallContext(currentScopeId, conversationId),
    resumeSessionCandidate: (payload) => runtime!.resumeSessionCandidate(payload),
  })

  // Stage V V2.1h — the 4 detached-skill task channels
  // (`agent:startDetachedSkillAction`, `agent:inspectDetachedSkillTask`,
  // `agent:listDetachedSkillTasks`, `agent:cancelDetachedSkillTask`) moved
  // into `detachedTaskGroup`. Symmetric dispose lives in
  // `cleanupAgentRuntime`; defensive dev-reload re-entry disposes the
  // previous handle first so `ipcMain.handle` does not double-register.
  if (detachedTaskGroupDispose) {
    try { detachedTaskGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    detachedTaskGroupDispose = null
  }
  detachedTaskGroupDispose = detachedTaskGroup.register(ipcMain, {
    startDetachedSkillAction: (payload) => runtime!.startDetachedSkillAction(payload),
    inspectDetachedSkillTask: (taskId, scopeId) => runtime!.inspectDetachedSkillTask(taskId, scopeId),
    listDetachedSkillTasks: (payload) => runtime!.listDetachedSkillTasks(payload),
    cancelDetachedSkillTask: (taskId, scopeId) => runtime!.cancelDetachedSkillTask(taskId, scopeId),
  })

  // Stage V V2.1i — the 5 run-control channels (`agent:listActiveChildRuns`,
  // `agent:cancelChildRun`, `agent:suspendRun`, `agent:resumeRun`,
  // `agent:respondToInteraction`) moved into `runControlGroup`. Symmetric
  // dispose lives in `cleanupAgentRuntime`; defensive dev-reload re-entry
  // disposes the previous handle first so `ipcMain.handle` does not
  // double-register.
  if (runControlGroupDispose) {
    try { runControlGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    runControlGroupDispose = null
  }
  runControlGroupDispose = runControlGroup.register(ipcMain, {
    listActiveChildRuns: () => listActiveChildRunsForIpc(runtime),
    cancelChildRun: (payload) => cancelChildRunForIpc(runtime, payload),
    reportInfrastructureTimeout: (payload) => runtime!.reportInfrastructureTimeout(payload),
    suspendRun: (payload) => runtime!.suspendRun(payload),
    resumeRun: (payload) => runtime!.resumeRun(payload),
    respondToInteraction: (payload) => runtime!.respondToInteraction(payload),
  })

  // Stage V V2.1g — `agent:attachSessionRecallContext`,
  // `agent:detachSessionRecallContext` and `agent:resumeSessionCandidate`
  // moved into `recallGroup` (registered above, alongside the 5 earlier
  // session-recall read channels). See the single `recallGroup.register`
  // call above.

  // Stage V V2.1e — the 6 channels that used to live here
  // (`agent:getConversationScopeMessages`, `agent:createLocalScope`,
  // `agent:listScopeAttachments`, `agent:getScopeAttachment`,
  // `agent:clearRemoteAttachmentCache`, `agent:getRemoteAttachmentCacheStats`)
  // moved into `conversationGroup` along with the 2 earlier scope-list
  // channels. See the single `conversationGroup.register` call above.

  // Stage V V2.1c — `agent:sendScoped` moved into `agentLifecycleGroup`
  // (registered above, alongside `agent:send` + `agent:newSession` +
  // `agent:kill`). Removed from this site to keep the lifecycle channels in
  // a single group.

  // Stage V V2.1j — `agent:emitRendererMetric` moved into `telemetryGroup`.
  // Symmetric dispose lives in `cleanupAgentRuntime`; defensive dev-reload
  // re-entry disposes the previous handle first so `ipcMain.handle` does not
  // double-register.
  if (telemetryGroupDispose) {
    try { telemetryGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    telemetryGroupDispose = null
  }
  telemetryGroupDispose = telemetryGroup.register(ipcMain, {
    isRendererAgentMetricName,
    logAgentMetric: (name, payload) => logAgentMetric(name, payload),
  })

  // Stage V V2.1k — the 8 channel-management + WeChat-login channels
  // (`agent:upsertChannel`, `agent:testChannel`, `agent:startWechatLogin`,
  // `agent:getWechatLoginStatus`, `agent:submitWechatLoginVerifyCode`,
  // `agent:deleteChannel`, `agent:setChannelEnabled`, `agent:sendChannelProbe`)
  // moved into `channelManagementGroup`. Symmetric dispose lives in
  // `cleanupAgentRuntime`; defensive dev-reload re-entry disposes the previous
  // handle first so `ipcMain.handle` does not double-register.
  if (channelManagementGroupDispose) {
    try { channelManagementGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    channelManagementGroupDispose = null
  }
  channelManagementGroupDispose = channelManagementGroup.register(ipcMain, {
    upsertChannel: (payload) => runtime!.upsertChannel(payload),
    testChannel: (payload) => runtime!.testChannel(payload),
    startWechatLogin: (payload) => runtime!.startWechatLogin(payload),
    getWechatLoginStatus: (channelId, sessionKey) => runtime!.getWechatLoginStatus(channelId, sessionKey),
    submitWechatLoginVerifyCode: (channelId, sessionKey, code) => runtime!.submitWechatLoginVerifyCode(channelId, sessionKey, code),
    deleteChannel: (id) => runtime!.deleteChannel(id),
    setChannelEnabled: (id, enabled) => runtime!.setChannelEnabled(id, enabled),
    sendChannelProbe: (id, text) => runtime!.sendChannelProbe(id, text),
  })

  // Structured scheduled-task handlers. Symmetric dispose lives in
  // `cleanupAgentRuntime` above and the dev-reload re-entry block below.
  if (scheduleGroupDispose) {
    try { scheduleGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    scheduleGroupDispose = null
  }
  scheduleGroupDispose = scheduleGroup.register(ipcMain, {
    list: () => runtime!.listScheduledTasks(),
    get: (id) => runtime!.getScheduledTask(id),
    preview: (payload) => runtime!.previewScheduledTask(payload),
    create: (payload) => runtime!.createScheduledTask(payload),
    update: (payload) => runtime!.updateScheduledTask(payload),
    runNow: (id) => runtime!.runScheduledTaskNow(id),
    pause: (id) => runtime!.pauseScheduledTask(id),
    resume: (id) => runtime!.resumeScheduledTask(id),
    delete: (id) => runtime!.deleteScheduledTask(id),
    listOccurrences: (scheduleId, limit) => runtime!.listScheduledTaskOccurrences(scheduleId, limit),
    emitChanged: (scheduleId) => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send('scheduledTasks:changed', scheduleId)
    },
  })
  if (scheduledTaskChangedOff) scheduledTaskChangedOff()
  const scheduleRuntime = runtime
  const onScheduledTaskChanged = (scheduleId: string) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('scheduledTasks:changed', scheduleId)
  }
  scheduleRuntime.on('scheduledTasksChanged', onScheduledTaskChanged)
  scheduledTaskChangedOff = () => scheduleRuntime.removeListener('scheduledTasksChanged', onScheduledTaskChanged)

  // Stage V V2.1m — the 8 chat-persistence + file-picker channels
  // (chat:getConversations, chat:getMessages, chat:deleteConversation,
  // chat:saveMessage, chat:createConversation, chat:updateConversationTitle,
  // chat:pickFiles, chat:readFileForAI) moved into `chatPersistenceGroup`.
  // The group pre-clears internally; we hold the dispose handle so
  // `cleanupAgentRuntime` can drop the handlers on shutdown. Re-binding on
  // dev reload first calls `dispose()` on the prior handle so listener slots
  // stay clean.
  //
  // Per-handler closures (mainWindow-bound dialog, lazy mammoth/xlsx loaders,
  // node fs primitives, the `<tool_call>` scrubber, runtime methods) are
  // passed in as bound dep methods — keeps the group decoupled from electron
  // composition-root types and from `AgentControlRuntime`.
  if (chatPersistenceGroupDispose) {
    try { chatPersistenceGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    chatPersistenceGroupDispose = null
  }
  chatPersistenceGroupDispose = chatPersistenceGroup.register(ipcMain, {
    getConversations: (agent) => chatRepository.getConversations(agent),
    getMessages: (conversationId) => chatRepository.getMessages(conversationId),
    // Must be `runtime!.deleteConversation` (not `chatRepository.deleteConversation`):
    // runtime piggybacks on the delete to drop in-memory scope state and emit
    // detached-task cancellations. The pre-extraction handler made this same
    // explicit choice.
    deleteConversation: (conversationId) => runtime!.deleteConversation(conversationId),
    saveMessage: (payload) => chatRepository.saveMessage(payload),
    createConversation: (payload) => chatRepository.createConversation(payload),
    updateConversationTitle: (payload) => chatRepository.updateConversationTitle(payload),
    sanitizeAssistantText: (text, options) => sanitizeAssistantText(text, options),
    // `runtime` may be uninitialized when the chat panel is somehow racing
    // setupAgentIPC; mirror the pre-extraction `runtime?.persist…` no-op via
    // the `??` short-circuit so the group dep stays a non-optional function.
    persistReferenceHintAfterAssistantMessage: (scopeId, role) => {
      runtime?.persistReferenceHintAfterAssistantMessage(scopeId, role)
    },
    pickFiles: async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: 'All Supported',
            extensions: [
              'png', 'jpg', 'jpeg', 'gif', 'webp',
              'mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v',
              'txt', 'md', 'csv', 'json', 'html',
              'docx', 'doc', 'rtf', 'odt',
              'xlsx', 'xls', 'pdf',
            ],
          }
        ]
      })
      if (result.canceled || result.filePaths.length === 0) return []
      return result.filePaths.map(filePath => {
        const ext = extname(filePath).toLowerCase()
        const stat = statSync(filePath)
        const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp']
        const videoExts = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']
        const textExts = ['.txt', '.md', '.csv', '.json', '.html', '.pdf', '.docx', '.doc', '.rtf', '.odt']
        const spreadExts = ['.xlsx', '.xls']
        let type: string = 'other'
        if (imageExts.includes(ext)) type = 'image'
        else if (videoExts.includes(ext)) type = 'video'
        else if (textExts.includes(ext)) type = 'text'
        else if (spreadExts.includes(ext)) type = 'spreadsheet'

        return {
          name: basename(filePath),
          path: filePath,
          type,
          size: stat.size,
          ext
        }
      })
    },
    readFileForAI: async (filePath) => {
      const MAX_INLINE_VIDEO_BYTES = 40 * 1024 * 1024 // 40MB
      const ext = extname(filePath).toLowerCase()
      const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.tif', '.ico', '.avif']
      const videoExts = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']
      const audioExts = ['.mp3', '.wav', '.aac', '.ogg', '.flac', '.m4a', '.wma', '.opus']
      const textExts = ['.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx', '.html', '.css', '.csv', '.xml', '.yml', '.yaml', '.log']
      const spreadsheetExts = ['.xlsx', '.xls']

      if (imageExts.includes(ext)) {
        // Return base64 encoded image
        const buffer = readFileSync(filePath)
        const base64 = buffer.toString('base64')
        const mimeMap: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
          '.svg': 'image/svg+xml', '.tiff': 'image/tiff', '.tif': 'image/tiff',
          '.ico': 'image/x-icon', '.avif': 'image/avif',
        }
        return { type: 'image', base64, mimeType: mimeMap[ext] || 'image/png' }
      }

      if (videoExts.includes(ext)) {
        const stat = statSync(filePath)
        if (stat.size > MAX_INLINE_VIDEO_BYTES) {
          return {
            type: 'text',
            content: `[视频文件过大，已降级为描述: ${basename(filePath)}, ${(stat.size / 1024 / 1024).toFixed(1)}MB。当前内联上传上限 ${(MAX_INLINE_VIDEO_BYTES / 1024 / 1024).toFixed(0)}MB]`,
            name: basename(filePath)
          }
        }

        const buffer = readFileSync(filePath)
        const base64 = buffer.toString('base64')
        const mimeMap: Record<string, string> = {
          '.mp4': 'video/mp4',
          '.mov': 'video/quicktime',
          '.webm': 'video/webm',
          '.mkv': 'video/x-matroska',
          '.avi': 'video/x-msvideo',
          '.m4v': 'video/x-m4v',
        }
        return {
          type: 'video',
          base64,
          mimeType: mimeMap[ext] || 'video/mp4',
          name: basename(filePath),
        }
      }

      if (audioExts.includes(ext)) {
        const stat = statSync(filePath)
        return { type: 'text', content: `[音频文件: ${basename(filePath)}, 大小: ${(stat.size / 1024 / 1024).toFixed(1)}MB]`, name: basename(filePath) }
      }

      if (ext === '.docx') {
        const mammoth = await getMammoth()
        if (!mammoth) {
          return {
            type: 'text',
            content: `[DOCX 文件: ${basename(filePath)}。未检测到 mammoth 解析库，暂无法提取正文内容。]`,
            name: basename(filePath),
          }
        }

        const buffer = readFileSync(filePath)
        const mammothMod = (mammoth as unknown as { default?: typeof import('mammoth') }).default || mammoth
        try {
          const textResult = await mammothMod.extractRawText({ buffer })
          const raw = (textResult.value || '').trim()
          const clipped = raw.slice(0, 20_000)
          const suffix = raw.length > 20_000 ? '\n...[DOCX 内容已截断]' : ''
          return {
            type: 'text',
            content: `--- DOCX: ${basename(filePath)} ---\n${clipped}${suffix}`,
            name: basename(filePath),
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (/end of central directory|zip file/i.test(message)) {
            const fallbackText = readFileSync(filePath, 'utf-8')
            if (looksLikeReadableText(fallbackText)) {
              const clipped = fallbackText.slice(0, 20_000)
              const suffix = fallbackText.length > 20_000 ? '\n...[DOCX 回退文本已截断]' : ''
              return {
                type: 'text',
                content: `--- DOCX(结构损坏回退文本): ${basename(filePath)} ---\n${clipped}${suffix}`,
                name: basename(filePath),
              }
            }
          }
          throw error
        }
      }

      if (spreadsheetExts.includes(ext)) {
        const xlsx = await getXlsx()
        if (!xlsx) {
          return {
            type: 'text',
            content: `[表格文件: ${basename(filePath)}。未检测到 xlsx 解析库，暂无法提取内容。]`,
            name: basename(filePath),
          }
        }

        const xlsxMod = (xlsx as unknown as { default?: typeof import('xlsx') }).default || xlsx
        const workbook = xlsxMod.read(readFileSync(filePath), { type: 'buffer' })
        const sheetSummaries: string[] = []

        for (const sheetName of workbook.SheetNames.slice(0, 6)) {
          const sheet = workbook.Sheets[sheetName]
          const rows = xlsxMod.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][]
          const previewRows = rows.slice(0, 40).map((row) =>
            (Array.isArray(row) ? row : [row]).slice(0, 20).map(normalizeCell).join(' | '),
          )
          sheetSummaries.push(
            `### Sheet: ${sheetName}\n${previewRows.length > 0 ? previewRows.join('\n') : '(空表)'}`
          )
        }

        const content = `--- 表格文件: ${basename(filePath)} ---\n${sheetSummaries.join('\n\n')}`.slice(0, 20_000)
        return { type: 'text', content, name: basename(filePath) }
      }

      if (textExts.includes(ext)) {
        const content = readFileSync(filePath, 'utf-8')
        return { type: 'text', content, name: basename(filePath) }
      }

      const stat = statSync(filePath)
      return {
        type: 'text',
        content: `[文件附件: ${basename(filePath)}, 扩展名: ${ext || 'unknown'}, 大小: ${(stat.size / 1024 / 1024).toFixed(2)}MB]`,
        name: basename(filePath),
      }
    },
  })

  orchestrator.on('output', (data) => {
    if (!mainWindow.isDestroyed()) {
      // Stage V V3.2 — normalize undefined sessionId to null so the
      // push payload type is `string | null` (not optional). Orchestrator
      // sets sessionId from descriptor.sessionId which is `string | undefined`.
      emitRunTimelineEvent(mainWindow, 'agent:stream', {
        ...data,
        sessionId: data.sessionId ?? null,
      })
      if (data.sessionId) {
        const timestamp = new Date().toISOString()
        if (data.type === 'tool_use' || data.type === 'tool_result') {
          const structured = data.projectionPatch && typeof data.projectionPatch === 'object'
            ? data.projectionPatch as Record<string, unknown>
            : null
          const structuredText = typeof structured?.message === 'string' && structured.message.trim()
            ? structured.message.trim()
            : typeof structured?.taskSummary === 'string' && structured.taskSummary.trim()
              ? structured.taskSummary.trim()
              : typeof structured?.taskTitle === 'string' && structured.taskTitle.trim()
                ? structured.taskTitle.trim()
                : ''
          const toolText = structured ? (structuredText || '状态已更新') : (data.chunk || '')
          const structuredHas = (key: string): boolean => Boolean(
            structured
            && Object.prototype.hasOwnProperty.call(structured, key)
            && structured[key] !== undefined,
          )
          const payload = {
            type: 'updated',
            scopeId: data.sessionId,
            // Stage V V3.2 — explicit per-session sessionId on the push so
            // multi-session renderer wiring doesn't depend on the scopeId alias.
            sessionId: data.sessionId,
            agent: data.agent,
            runId: data.runId,
            taskId: typeof data.taskId === 'string'
              ? data.taskId
              : structured?.taskContinuation && typeof structured.taskContinuation === 'object' && typeof (structured.taskContinuation as Record<string, unknown>).taskId === 'string'
                ? (structured.taskContinuation as Record<string, unknown>).taskId as string
                : undefined,
            phase: 'tool_running',
            latestText: toolText,
            module: structured?.module === 'browser' || structured?.module === 'document' || structured?.module === 'design' || structured?.module === 'skill'
              ? structured.module as ScopeRunEventPayload['module']
              : undefined,
            taskTitle: typeof structured?.taskTitle === 'string' ? structured.taskTitle : undefined,
            taskSummary: typeof structured?.taskSummary === 'string' ? structured.taskSummary : undefined,
            steps: Array.isArray(structured?.steps) ? structured.steps : undefined,
            currentStepId: typeof structured?.currentStepId === 'string' ? structured.currentStepId : undefined,
            waitingFor: typeof structured?.waitingFor === 'string' ? structured.waitingFor as ScopeRunEventPayload['waitingFor'] : undefined,
            resumableActions: Array.isArray(structured?.resumableActions) ? structured.resumableActions as ScopeRunEventPayload['resumableActions'] : undefined,
            ...(structuredHas('blockedReason') && (typeof structured?.blockedReason === 'string' || structured?.blockedReason === null)
              ? { blockedReason: typeof structured.blockedReason === 'string' ? structured.blockedReason : null }
              : {}),
            ...(structuredHas('taskContinuation') && (structured?.taskContinuation === null || (structured?.taskContinuation && typeof structured.taskContinuation === 'object'))
              ? { taskContinuation: structured.taskContinuation && typeof structured.taskContinuation === 'object' ? structured.taskContinuation as ScopeRunEventPayload['taskContinuation'] : null }
              : {}),
            ...(structuredHas('progress') && (structured?.progress === null || (structured?.progress && typeof structured.progress === 'object'))
              ? { progress: structured.progress && typeof structured.progress === 'object' ? structured.progress as ScopeRunEventPayload['progress'] : null }
              : {}),
            recentArtifacts: Array.isArray(structured?.recentArtifacts) ? structured.recentArtifacts : undefined,
            toolEvent: {
              id: `${data.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              kind: data.type === 'tool_use' ? 'call' : 'result',
              text: toolText,
              timestamp,
            },
            timestamp,
          } as const
          runtime?.recordScopeRunEvent(
            payload,
            structured
              ? {
                projectionPatch: structured,
                transcriptEvents: [{ kind: 'structured_payload', projectionPatch: structured }],
              }
              : null,
          )
          emitRunTimelineEvent(mainWindow, 'agent:scopeRunEvent', payload)
        } else if (data.type === 'done') {
          const structured = data.projectionPatch && typeof data.projectionPatch === 'object'
            ? data.projectionPatch as Record<string, unknown>
            : null
          const structuredHas = (key: string): boolean => Boolean(
            structured
            && Object.prototype.hasOwnProperty.call(structured, key)
            && structured[key] !== undefined,
          )
          const payload = {
            type: 'finished',
            scopeId: data.sessionId,
            sessionId: data.sessionId, // Stage V V3.2
            agent: data.agent,
            runId: data.runId,
            taskId: typeof data.taskId === 'string'
              ? data.taskId
              : structured?.taskContinuation && typeof structured.taskContinuation === 'object' && typeof (structured.taskContinuation as Record<string, unknown>).taskId === 'string'
                ? (structured.taskContinuation as Record<string, unknown>).taskId as string
                : undefined,
            phase: 'done',
            taskTitle: typeof structured?.taskTitle === 'string' ? structured.taskTitle : undefined,
            taskSummary: typeof structured?.taskSummary === 'string' ? structured.taskSummary : undefined,
            steps: Array.isArray(structured?.steps) ? structured.steps : undefined,
            currentStepId: typeof structured?.currentStepId === 'string' ? structured.currentStepId : undefined,
            waitingFor: typeof structured?.waitingFor === 'string' ? structured.waitingFor as ScopeRunEventPayload['waitingFor'] : undefined,
            resumableActions: Array.isArray(structured?.resumableActions) ? structured.resumableActions as ScopeRunEventPayload['resumableActions'] : undefined,
            ...(structuredHas('blockedReason') && (typeof structured?.blockedReason === 'string' || structured?.blockedReason === null)
              ? { blockedReason: typeof structured.blockedReason === 'string' ? structured.blockedReason : null }
              : {}),
            ...(structuredHas('taskContinuation') && (structured?.taskContinuation === null || (structured?.taskContinuation && typeof structured.taskContinuation === 'object'))
              ? { taskContinuation: structured.taskContinuation && typeof structured.taskContinuation === 'object' ? structured.taskContinuation as ScopeRunEventPayload['taskContinuation'] : null }
              : {}),
            ...(structuredHas('progress') && (structured?.progress === null || (structured?.progress && typeof structured.progress === 'object'))
              ? { progress: structured.progress && typeof structured.progress === 'object' ? structured.progress as ScopeRunEventPayload['progress'] : null }
              : {}),
            recentArtifacts: Array.isArray(structured?.recentArtifacts) ? structured.recentArtifacts : undefined,
            timestamp,
          } as const
          runtime?.recordScopeRunEvent(
            payload,
            structured
              ? {
                projectionPatch: structured,
                transcriptEvents: [{ kind: 'structured_payload', projectionPatch: structured }],
              }
              : null,
          )
          emitRunTimelineEvent(mainWindow, 'agent:scopeRunEvent', payload)
        } else if (data.type === 'text') {
          const payload = {
            type: 'updated',
            scopeId: data.sessionId,
            sessionId: data.sessionId, // Stage V V3.2
            agent: data.agent,
            runId: data.runId,
            phase: 'responding',
            latestText: data.chunk || '',
            timestamp,
          } as const
          runtime?.recordScopeRunEvent(payload)
          emitRunTimelineEvent(mainWindow, 'agent:scopeRunEvent', payload)
        }
      }
    }
  })

  orchestrator.on('status', (data) => {
    if (!mainWindow.isDestroyed()) {
      // Stage V V3.2 — normalize undefined sessionId to null on the push.
      emitRunTimelineEvent(mainWindow, 'agent:status', {
        ...data,
        sessionId: data.sessionId ?? null,
      })
      if (data.sessionId) {
        const phase = mapAgentStatusToScopeRunPhase(data.status)
        if (!phase) {
          log(`Ignoring unknown agent status for scope run event: status=${String(data.status || '')} agent=${data.agent || ''}`)
          return
        }
        const terminalReason = normalizeScopeRunTerminalReason((data as { terminalReason?: unknown }).terminalReason)
        const payload: ScopeRunEventPayload = {
          type: mapAgentStatusToScopeRunEventType(data.status),
          scopeId: data.sessionId,
          agent: data.agent,
          runId: data.runId,
          phase,
          terminalReason,
          latestText: typeof data.status === 'string' ? `状态：${data.status}` : undefined,
          timestamp: new Date().toISOString(),
        }
        runtime?.recordScopeRunEvent(payload)
        // Stage V V3.2 — mirror scopeId to sessionId on the wire so renderer
        // listeners can route per-session without aliasing knowledge.
        emitRunTimelineEvent(mainWindow, 'agent:scopeRunEvent', {
          ...payload,
          sessionId: data.sessionId,
        })
      }
    }
  })

  orchestrator.on('error', (data) => {
    if (!mainWindow.isDestroyed()) {
      // Phase 3: agent:error payload already carries errorKind/recoverable/toolName
      // via orchestrator spread — forward as-is so the renderer can route
      // recoverable errors to the soft-failure capsule.
      // Stage V V3.2 — normalize undefined sessionId to null on the push.
      emitRunTimelineEvent(mainWindow, 'agent:error', {
        ...data,
        sessionId: data.sessionId ?? null,
      })
      if (data.sessionId) {
        const payload = {
          type: 'finished',
          scopeId: data.sessionId,
          sessionId: data.sessionId, // Stage V V3.2
          agent: data.agent,
          runId: data.runId,
          phase: 'error',
          error: data.error,
          latestText: data.error,
          timestamp: new Date().toISOString(),
          errorKind: data.errorKind,
          recoverable: data.recoverable,
          toolName: data.toolName,
        } as const
        runtime?.recordScopeRunEvent(payload)
        emitRunTimelineEvent(mainWindow, 'agent:scopeRunEvent', payload)
      }
    }
  })

  orchestrator.on('toolAction', (data: { tool: string; args: Record<string, unknown>; agent?: string; sessionId?: string; runId?: string }) => {
    if (!mainWindow.isDestroyed()) {
      // Stage V V3.2 — normalize undefined sessionId to null on the push.
      mainWindow.webContents.send('agent:toolAction', {
        ...data,
        sessionId: data.sessionId ?? null,
      })
    }
  })

  runtime.on('conversationEvent', (data) => {
    if (!mainWindow.isDestroyed()) {
      // Stage V V3.2 — surface sessionId at the push payload top level.
      // The underlying ConversationEventPayload addresses scope via
      // `scope.id`; we mirror that to a top-level sessionId so consumers
      // don't have to reach into the nested scope object.
      const sessionId = data && typeof data === 'object' && data.scope && typeof data.scope.id === 'string'
        ? data.scope.id
        : null
      emitRunTimelineEvent(mainWindow, 'agent:conversationEvent', {
        ...data,
        sessionId,
      })
    }
  })

  runtime.on('scopeRunEvent', (data) => {
    if (!mainWindow.isDestroyed()) {
      // Stage V V3.2 — mirror scopeId to sessionId on the wire payload.
      const sessionId = data && typeof data === 'object' && typeof data.scopeId === 'string'
        ? data.scopeId
        : null
      emitRunTimelineEvent(mainWindow, 'agent:scopeRunEvent', {
        ...data,
        sessionId,
      })
    }
  })

  // Stage U PR U2.1 — surface projection sync failures so the renderer
  // diagnose UI can show that a fire-and-forget sync failed instead of
  // silently displaying stale ScopeRunSummary state.
  runtime.on('projectionSyncFailed', (data) => {
    if (!mainWindow.isDestroyed()) {
      // Stage V V3.2 — projection failure is per-session; mirror scopeId.
      const sessionId = data && typeof data === 'object' && typeof data.scopeId === 'string'
        ? data.scopeId
        : null
      mainWindow.webContents.send('agent:projectionSyncFailed', {
        ...data,
        sessionId,
      })
    }
  })

  // Stage U PR U1.3 — legacy AgentManager event forwards removed.
  // The pre-SDK-runtime EventEmitter forwards for output/status/error
  // channels are gone. The renderer-facing agent:stream / agent:status /
  // agent:error channels are now exclusively driven by the orchestrator
  // bindings above. Keeping the legacy forwards meant the same channel
  // could receive two payload shapes: new (with recoverable/errorKind/
  // softError) and old (raw without those fields), polluting renderer
  // error display. The SDK runtime path is the single producer now.
  // See plan §2 U1.3 / audit §1.1 / U1.1 tool error shape.

  // Stage U0.1 — legacy tool_execute bridge removed. The previous handler
  // used EventEmitter#emit on ipcMain to dispatch calendar create requests
  // and ORed the boolean result with a synthetic success payload, so every
  // call appeared to succeed regardless of whether the event was written.
  // The Agent SDK runtime now owns every tool execution; see
  // docs/superpowers/audits/2026-05-20-ready-deep-review-and-refactor-plan.md
  // section 1.1 for the audit entry.

  // ===================== Memory System IPC =====================

  // Stage V V2.1n — the 8 agent-memory channels (agent:memory:query,
  // agent:memory:create, agent:memory:update, agent:memory:delete,
  // agent:memory:stats, agent:memory:lifecycle:status,
  // agent:memory:lifecycle:runMaintenance, agent:memory:createFromConversation)
  // moved into `memoryGroup`. The group pre-clears internally; we hold the
  // dispose handle so `cleanupAgentRuntime` can drop the handlers on
  // shutdown. Re-binding on dev reload first calls `dispose()` on the prior
  // handle so listener slots stay clean.
  //
  // Per-handler closures are passed in as bound dep methods (lazy accessors
  // returning `null` while the runtime is not yet up — matches the
  // pre-extraction `runtime?.getMemoryRepository()` null-path). The
  // `agent:trigger:*` channels stay inline here: they live on the same
  // `memoryRepository` instance but are a separate Settings tab and a
  // future V2.1 sub-step (see `memory-group.ts` header for the boundary
  // rationale).
  if (memoryGroupDispose) {
    try { memoryGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    memoryGroupDispose = null
  }
  memoryGroupDispose = memoryGroup.register(ipcMain, {
    getMemoryRepository: () => runtime?.getMemoryRepository() ?? null,
    getMemoryLifecycleManager: () => runtime?.getMemoryLifecycleManager() ?? null,
    getPromptAssembly: () => runtime?.getPromptAssembly() ?? null,
    listConversationScopes: () => runtime?.listConversationScopes() ?? null,
  })

  // Stage V V2.1o — the 4 `agent:trigger:*` channels (list / create / update
  // / createWithMemories) moved into `triggerGroup`. The group pre-clears
  // internally; we hold the dispose handle so `cleanupAgentRuntime` can drop
  // the handlers on shutdown. Re-binding on dev reload first calls
  // `dispose()` on the prior handle so listener slots stay clean.
  //
  // Per-handler closures are passed in as bound dep methods (lazy accessors
  // returning `null` while the runtime is not yet up — matches the
  // pre-extraction `runtime?.getMemoryRepository()` / `getPromptAssembly()`
  // null-path).
  //
  // This is the FINAL claude-bridge channel group. With V2.1o landed,
  // `ipc-handler.ts` no longer registers any inline `ipcMain.handle` calls
  // of its own — every surface lives in an extracted group (15 total:
  // askUser / toolEvent / agentLifecycle / agentRuntime / conversation /
  // taskProjection / recall / detachedTask / runControl / telemetry /
  // channelManagement / schedule / chatPersistence / memory / trigger).
  if (triggerGroupDispose) {
    try { triggerGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    triggerGroupDispose = null
  }
  triggerGroupDispose = triggerGroup.register(ipcMain, {
    getMemoryRepository: () => runtime?.getMemoryRepository() ?? null,
    getPromptAssembly: () => runtime?.getPromptAssembly() ?? null,
  })
}
