import { emitRunTimelineEvent } from './run-timeline-emitter'
import { app, ipcMain, BrowserWindow, dialog } from 'electron'
import { AgentManager } from './agent-manager'
// The Codex send payload is owned by the shared IPC contract and registered
// through `agentLifecycleGroup`.
// Stage V V2.1d — `AIModelConfig` import retired: the only call site
// (`agent:getCapabilityRuntimeSnapshot` payload type) moved into
// `agentRuntimeGroup`.
import { BrowserController } from '../browser-engine/ipc-handler'
import { readFileSync, statSync } from 'fs'
import { basename, extname, join } from 'path'
import { AgentControlRuntime } from '../agent-control/runtime-core/runtime'
import { normalizeTurnTerminalReason } from '../agent-control/runtime-core/turn-frame'
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
} from '../tools/builtins/ask-user-questions-store'
import { getDatabase } from '../database'
import { getSkillsRuntimeManager } from '../skills-runtime/runtime-manager'
import { cancelChildRunForIpc, listActiveChildRunsForIpc } from './active-child-run-ipc'
import { askUserGroup } from './ipc/ask-user-group'
import { toolEventGroup } from './ipc/tool-event-group'
import { agentLifecycleGroup } from './ipc/agent-lifecycle-group'
import { createCodexRuntimeComposition } from '../agent-control/codex-runtime/codex-runtime-composition'
import { agentRuntimeGroup } from './ipc/agent-runtime-group'
import { readyMemoryGroup } from './ipc/ready-memory-group'
import { mcpGroup, runMcpBoot } from './ipc/mcp-group'
import { runQualityGroup } from './ipc/run-quality-group'
import { runFeedbackGroup } from './ipc/run-feedback-group'
import { RunFeedbackRepository } from '../agent-control/task-projection/run-feedback-repository'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { emergenceFeedGroup } from './ipc/emergence-feed-group'
import { getFileEmergenceIntentCardsForFeed } from '../file-emergence/ipc-handler'
import { conversationGroup } from './ipc/conversation-group'
import { taskProjectionGroup } from './ipc/task-projection-group'
import { recallGroup } from './ipc/recall-group'
import { detachedTaskGroup } from './ipc/detached-task-group'
import { runControlGroup } from './ipc/run-control-group'
import { telemetryGroup } from './ipc/telemetry-group'
import { channelManagementGroup } from './ipc/channel-management-group'
import { chatPersistenceGroup } from './ipc/chat-persistence-group'
import { savePastedImage } from './chat-pasted-image'
import type { IpcDisposeHandle } from './ipc/types'
import { logAgentMetric } from '../agent-control/metrics'
import { isRendererAgentMetricName } from '../../../shared/renderer-agent-metrics'
// Stage V V2.1c — `SendScopedUserMessage` import retired: the only call
// site (the `agent:sendScoped` payload type) moved into `agentLifecycleGroup`.
import type { ScopeRunEventPayload } from '../agent-control/contracts/types'
import type { IngressAdmittedEvent } from '../../../shared/ipc-contracts/agent-runtime'
import type { TaskProjectionChangeEvent } from '../agent-control/contracts/run-contracts'
import { getDocumentWorker } from '../document-engine/document-worker-bridge'
import { readHeavyDocumentAttachmentForAI } from './document-attachment-text'
import { RuntimeStartupSlot } from './runtime-startup-slot'
import {
  beginAgentRuntimeRegistration,
  markAgentRuntimeUnavailable,
  publishAgentRuntimeReady,
  waitForAgentRuntimeReady,
} from './agent-runtime-readiness'
import { RendererToolActionBridge } from './ipc/renderer-tool-action-bridge'
import type { ChatGptOAuthService } from '../settings-engine/chatgpt-oauth-service'
import { createCodexProviderReadinessPort } from '../agent-control/codex-runtime/codex-provider-readiness'
import { persistAskUserQuestionsCardPending } from './ask-user-questions-card-persistence'
import { getActivePetWindowManager } from '../pet/active-pet-window-manager'
import { PetActivityProjectionService } from '../pet/pet-activity-projection-service'

const directChatLogger = createRotatingLogger('ready-directchat.log', { buffered: true })
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

export interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  mock?: boolean
  errorKind?: string
  persistence?: unknown
}

let runtime: AgentControlRuntime | null = null
let startingRuntime: RuntimeStartupSlot<AgentControlRuntime> | null = null
const chatRepository = new ChatRepository()
const rendererToolActionBridge = new RendererToolActionBridge()

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

export async function migrateAgentChannelCredentialsAfterWindowReady(): Promise<void> {
  if (!runtime) await waitForAgentRuntimeReady()
  if (!runtime) throw new Error('agent_runtime_unavailable')
  await runtime.migrateStoredChannelCredentialsOnce()
}

export function readAgentCodexRuntimeDiagnostics() {
  return runtime?.readCodexRuntimeDiagnostics() ?? null
}

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
 * Dispose handle returned by `agentLifecycleGroup.register`.
 * Owns the six exact Codex send/create/reset/stop/close/compact channels.
 * Same lifecycle pattern as the other group dispose
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
let readyMemoryGroupDispose: IpcDisposeHandle | null = null

/** EP4-A7 — dispose handle for agent registry lifecycle channels. */
let runQualityGroupDispose: IpcDisposeHandle | null = null
/** D5 后端切片 — per-run 用户反馈通道（renderer 评分控件属 D5 待做）。 */
let runFeedbackGroupDispose: IpcDisposeHandle | null = null
/** 梯队三 — emergence feed 组装通道（拉取式，fired 账本随组装打点）。 */
let emergenceFeedGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.1e — dispose handle returned by `conversationGroup.register`.
 * Owns the 7 conversation-scope + attachment channels
 * (`agent:listConversationScopes`, `agent:listScopeRuns`,
 * `agent:getConversationScopeMessages`, `agent:listScopeAttachments`,
 * `agent:getScopeAttachment`,
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
 * Owns the 3 detached-skill task channels (`agent:inspectDetachedSkillTask`,
 * `agent:listDetachedSkillTasks`,
 * `agent:cancelDetachedSkillTask`). Same lifecycle pattern as the other group
 * dispose slots: register on `setupAgentIPC`, dispose on dev-reload re-entry,
 * dispose on `cleanupAgentRuntime` shutdown.
 */
let detachedTaskGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.1i — dispose handle returned by `runControlGroup.register`.
 * Owns the supported run-control channels (`agent:listActiveChildRuns`,
 * `agent:cancelChildRun`, `agent:reportInfrastructureTimeout`). Same lifecycle pattern as the other group
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
 * Stage V V2.1m — dispose handle returned by `chatPersistenceGroup.register`.
 * Owns the 5 chat metadata/read + file-picker channels
 * (`chat:getConversations`, `chat:getMessages`, `chat:updateConversationTitle`,
 * `chat:pickFiles`, `chat:readFileForAI`). Same lifecycle pattern as the other
 * group dispose slots: register on `setupAgentIPC`, dispose on dev-reload
 * re-entry, dispose on `cleanupAgentRuntime` shutdown.
 */
let chatPersistenceGroupDispose: IpcDisposeHandle | null = null

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
      const swept = getDatabase().chat.sweepPendingAskUserQuestionsCardsBySession(sessionId, 'session_reset')
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

export async function cleanupAgentRuntime(): Promise<void> {
  markAgentRuntimeUnavailable()
  rendererToolActionBridge.cancelAll('agent_runtime_cleanup')
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
  // Symmetric release of the six Codex lifecycle channel handlers.
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
  if (readyMemoryGroupDispose) {
    try { readyMemoryGroupDispose.dispose() } catch { /* ignore */ }
    readyMemoryGroupDispose = null
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
  // Stage V V2.1h — symmetric release of the 3 detached-skill task channel
  // handlers (inspectDetachedSkillTask /
  // listDetachedSkillTasks / cancelDetachedSkillTask).
  if (detachedTaskGroupDispose) {
    try { detachedTaskGroupDispose.dispose() } catch { /* ignore */ }
    detachedTaskGroupDispose = null
  }
  // Symmetric release of the supported run-control channel handlers.
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
  // Stage V V2.1m — symmetric release of the 8 chat-persistence +
  // file-picker channel handlers (getConversations / getMessages /
  // deleteConversation / saveMessage / createConversation /
  // updateConversationTitle / pickFiles / readFileForAI).
  if (chatPersistenceGroupDispose) {
    try { chatPersistenceGroupDispose.dispose() } catch { /* ignore */ }
    chatPersistenceGroupDispose = null
  }
  const startup = startingRuntime
  if (startup) {
    await startup.cancelAndDrain()
    if (startingRuntime === startup) startingRuntime = null
  }
  if (runtime) {
    const active = runtime
    await active.stop()
    if (runtime === active) runtime = null
  }
  cleanupSkillSessionState(undefined, 'Agent runtime shut down')
  // RE-AUDIT FIX 5.4 — release the reference-skill hint emitter so its
  // closure (which captures mainWindow) doesn't pin the destroyed window
  // and prevent GC. Idempotent — safe to call when no emitter was set.
  setReferenceHintChangeEmitter(null)
  registerSkillReferenceInlinedEmitter(null)
}

export async function setupAgentIPC(
  agentManager: AgentManager,
  mainWindow: BrowserWindow,
  browserController?: BrowserController,
  chatGptOAuthService?: ChatGptOAuthService,
): Promise<void> {
  beginAgentRuntimeRegistration()
  rendererToolActionBridge.bindTarget(mainWindow.webContents)
  if (!runtime) {
    if (startingRuntime) {
      await startingRuntime.startPromise
      if (!runtime) throw new Error('agent_runtime_start_cancelled')
    }
  }
  if (!runtime) {
    if (!chatGptOAuthService) throw new Error('chatgpt_oauth_readiness_unbound')
    const candidate = new AgentControlRuntime(
      agentManager,
      browserController,
      createCodexRuntimeComposition({
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        userDataPath: app.getPath('userData'),
        isPackaged: app.isPackaged,
        database: getDatabase(),
        settings: new AppSettingsRepository(),
        requestRendererToolAction: (payload) => rendererToolActionBridge.request(payload),
        providerReadiness: createCodexProviderReadinessPort(chatGptOAuthService),
        onReadyMemoryStateChanged: (event) => {
          if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('agent:readyMemoryStateChanged', event)
          }
        },
        onCodexActionSurfaceInvalidated: (event) => {
          if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('agent:codexActionSurfaceInvalidated', event)
          }
        },
      }),
    )
    const startup = new RuntimeStartupSlot(candidate)
    startingRuntime = startup
    try {
      const started = await startup.promote()
      if (startingRuntime !== startup) throw new Error('agent_runtime_start_cancelled')
      runtime = started
    } finally {
      if (startingRuntime === startup) startingRuntime = null
    }
    // Phase 1.3 — kick off the Python venv health check immediately after the
    // runtime starts. Fire-and-forget: a stale 3.14 venv (left over from a
    // prior install) gets nuked + rebuilt in the background BEFORE the first
    // skill_run_shell hits a confused interpreter. The wrapper logs a startup
    // banner so the version is observable in `<tmp>/ready-startup.log`.
    void getSkillsRuntimeManager().ensurePythonRuntimeReady()
  } else if (browserController) {
    runtime.getOrchestrator().setBrowserController(browserController)
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
  // Production Codex boot has already settled exact pending interactions,
  // their Ready parent/Browser child and product fence before recovery. This
  // older card-only sweep stays as an idempotent fallback for standalone or
  // non-Codex wiring; it must never revive a missing Promise resolver.
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
      const { mutated, skippedLive } = getDatabase().chat.sweepPendingAskUserQuestionsCardsOnBoot({ liveCardIds })
      if (mutated > 0) {
        log(`ask_user_questions boot sweep cancelled ${mutated} stale pending card(s)`)
      }
      if (skippedLive > 0) {
        log(`ask_user_questions boot sweep skipped ${skippedLive} live card(s) (in-memory store)`)
        logAgentMetric('ask_user_questions_boot_sweep_skipped_live', { skippedLive })
      }
    } catch (sweepErr) {
      // Production Codex startup either completed its earlier canonical sweep
      // or failed closed; this fallback failure remains observable only.
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
    if (event.responsePolicy !== 'local_renderer_only') {
      void runtime?.forwardAskUserCardToRemoteChannel(event).catch(() => undefined)
    }
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
    getDatabase: () => getDatabase().settings,
    log: (line) => log(line),
    dataRoot: join(app.getPath('userData'), 'mcp-servers'),
  })
  if (!mcpBootstrapRanForBoot) {
    mcpBootstrapRanForBoot = true
    void runMcpBoot({
      getDatabase: () => getDatabase().settings,
      log: (line) => log(line),
      dataRoot: join(app.getPath('userData'), 'mcp-servers'),
    }).catch((bootstrapErr) => {
      log(`mcp bootstrap failed: ${bootstrapErr instanceof Error ? bootstrapErr.message : String(bootstrapErr)}`)
    })
  }
  // EP1-I3-2 — frozen-call confirmation store (M2/M3 action-confirmation
  // gate). Register once per main-process lifetime: a dev reload must not
  // replace a store that may hold live pending waiters. Production Codex boot
  // has already atomically settled exact rows; the constructor sweep is only
  // a fail-closed fallback for standalone/non-Codex orphan rows.
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
  const petManager = getActivePetWindowManager()
  const petActivityDb = getDatabase().getRawDb()
  const petActivity = petManager && petActivityDb
    ? new PetActivityProjectionService(projectionStore, petActivityDb, petManager)
    : null
  petActivity?.refresh()
  const onProjectionChange = (event: TaskProjectionChangeEvent): void => {
    petActivity?.refresh()
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
    pendingToolActionRequests: rendererToolActionBridge.pendingToolActionRequests,
    releasePendingRequest: (requestId) => rendererToolActionBridge.releasePendingRequest(requestId),
  })

  // The six Codex lifecycle channels are owned by `agentLifecycleGroup`.
  // The group handles dev-reload removeHandler
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
    sendScoped: (payload) => runtime!.sendScoped(payload),
    createSession: (request) => runtime!.createCodexSession(request),
    beginNewContext: (request) => runtime!.beginCodexNewContext(request),
    resetSession: (request) => runtime!.resetCodexSession(request),
    stopSession: (request) => runtime!.stopCodexSession(request),
    closeSession: (request) => runtime!.closeCodexSession(request),
    compactSession: (request) => runtime!.compactCodexSession(request),
    readLifecycleSnapshot: (request) => runtime!.readCodexLifecycleSnapshot(request),
    log,
  })

  // Stage U PR U1.2 — legacy agent IPC channels removed.
  // `agent:orchestrate`, `agent:getStatus`, `agent:getAll`, `agent:getDiagnostics`
  // were the AgentManager-era admission surface. Verified zero renderer callers
  // before deletion (see audit §1.1). Current production runs exclusively
  // through `agent:getRuntimeStatus` + `agent:getCapabilityRuntimeSnapshot` +
  // the Codex runtime channels below. Reintroduction is fenced by
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

  if (readyMemoryGroupDispose) {
    try { readyMemoryGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    readyMemoryGroupDispose = null
  }
  readyMemoryGroupDispose = readyMemoryGroup.register(ipcMain, {
    read: (request) => runtime!.readReadyMemory(request),
    setGlobalPolicy: (request) => runtime!.setReadyMemoryGlobalPolicy(request),
    setConversationPolicy: (request) => runtime!.setReadyMemoryConversationPolicy(request),
    add: (request) => runtime!.addReadyMemory(request),
    update: (request) => runtime!.updateReadyMemory(request),
    pin: (request) => runtime!.pinReadyMemory(request),
    delete: (request) => runtime!.deleteReadyMemory(request),
    reset: (request) => runtime!.resetReadyMemory(request),
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
  // follow_up）、belief 卡（crystallize：staged 资料 + 疑似重复）。
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
    listConversationScopes: () => runtime!.listConversationScopes(),
    listScopeRuns: (payload) => runtime!.listScopeRuns(payload),
    readCodexLifecycleSnapshot: (request) => runtime!.readCodexLifecycleSnapshot(request),
    readCodexHeadActionProjection: (request) => runtime!.readCodexHeadActionProjection(request),
    readCodexActionSurface: (request) => runtime!.readCodexActionSurface(request),
    readProductTurnPresentation: (readyRunId, requestedWorkbenchMode) => (
      runtime!.readProductTurnPresentation(readyRunId, requestedWorkbenchMode)
    ),
    readProductTurnPresentations: (readyRunIds, requestedWorkbenchMode) => (
      runtime!.readProductTurnPresentations(readyRunIds, requestedWorkbenchMode)
    ),
    getConversationScopeMessages: (scopeId) => runtime!.getConversationScopeMessages(scopeId),
    setProjectDirectory: (scopeId, path, epoch) => runtime!.setProjectDirectory(scopeId, path, epoch),
    setActionAuthorizationMode: (scopeId, mode, expectedMessageVisibilityEpoch) => (
      runtime!.setActionAuthorizationMode(scopeId, mode, expectedMessageVisibilityEpoch)
    ),
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
    attachSessionRecallContext: (currentScopeId, conversationId, expectedMessageVisibilityEpoch) =>
      runtime!.attachSessionRecallContext(
        currentScopeId,
        conversationId,
        expectedMessageVisibilityEpoch,
      ),
    detachSessionRecallContext: (currentScopeId, conversationId, expectedMessageVisibilityEpoch) =>
      runtime!.detachSessionRecallContext(
        currentScopeId,
        conversationId,
        expectedMessageVisibilityEpoch,
      ),
    resumeSessionCandidate: (payload) => runtime!.resumeSessionCandidate(payload),
  })

  // Stage V V2.1h — the 3 detached-skill task channels
  // (`agent:inspectDetachedSkillTask`,
  // `agent:listDetachedSkillTasks`, `agent:cancelDetachedSkillTask`) moved
  // into `detachedTaskGroup`. Symmetric dispose lives in
  // `cleanupAgentRuntime`; defensive dev-reload re-entry disposes the
  // previous handle first so `ipcMain.handle` does not double-register.
  if (detachedTaskGroupDispose) {
    try { detachedTaskGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    detachedTaskGroupDispose = null
  }
  detachedTaskGroupDispose = detachedTaskGroup.register(ipcMain, {
    inspectDetachedSkillTask: (taskId, scopeId) => runtime!.inspectDetachedSkillTask(taskId, scopeId),
    listDetachedSkillTasks: (payload) => runtime!.listDetachedSkillTasks(payload),
    cancelDetachedSkillTask: (taskId, scopeId) => runtime!.cancelDetachedSkillTask(taskId, scopeId),
  })

  // Supported run-control channels live in `runControlGroup`. Symmetric
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
  })

  // Stage V V2.1g — `agent:attachSessionRecallContext`,
  // `agent:detachSessionRecallContext` and `agent:resumeSessionCandidate`
  // moved into `recallGroup` (registered above, alongside the 5 earlier
  // session-recall read channels). See the single `recallGroup.register`
  // call above.

  // Stage V V2.1e — the 5 channels that used to live here
  // (`agent:getConversationScopeMessages`, `agent:listScopeAttachments`,
  // `agent:getScopeAttachment`,
  // `agent:clearRemoteAttachmentCache`, `agent:getRemoteAttachmentCacheStats`)
  // moved into `conversationGroup` along with the 2 earlier scope-list
  // channels. See the single `conversationGroup.register` call above.

  // `agent:sendScoped` is registered only through `agentLifecycleGroup`.

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
    startChannelPairing: (id) => runtime!.startChannelPairing(id),
    upsertChannel: (payload) => runtime!.upsertChannel(payload),
    testChannel: (payload) => runtime!.testChannel(payload),
    startWechatLogin: (payload) => runtime!.startWechatLogin(payload),
    getWechatLoginStatus: (channelId, sessionKey) => runtime!.getWechatLoginStatus(channelId, sessionKey),
    submitWechatLoginVerifyCode: (channelId, sessionKey, code) => runtime!.submitWechatLoginVerifyCode(channelId, sessionKey, code),
    deleteChannel: (id) => runtime!.deleteChannel(id),
    setChannelEnabled: (id, enabled) => runtime!.setChannelEnabled(id, enabled),
    sendChannelProbe: (id, text) => runtime!.sendChannelProbe(id, text),
  })

  // Chat metadata reads/title updates and file-picker channels live in
  // `chatPersistenceGroup`. Conversation lifecycle and message writes are
  // owned by the Codex runtime path and are not exposed to Renderer IPC.
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
    savePastedImage: (bytes) => savePastedImage(app.getPath('userData'), bytes),
    getConversations: (agent) => chatRepository.getConversations(agent),
    getMessages: (conversationId) => chatRepository.getMessages(conversationId),
    updateConversationTitle: (payload) => chatRepository.updateConversationTitle(payload),
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
              'docx',
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
        const textExts = ['.txt', '.md', '.csv', '.json', '.html', '.pdf', '.docx']
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

      const heavyDocument = await readHeavyDocumentAttachmentForAI(filePath, getDocumentWorker())
      if (heavyDocument) return heavyDocument

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
        // Tool call/result scope events are published once by
        // AgentSdkToolExecutor, where the full trace detail and frozen owner
        // identity are available. The raw agent:stream push above remains the
        // transport stream and is not a second canonical projection event.
        if (data.type === 'done') {
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
            messageVisibilityEpoch: data.messageVisibilityEpoch,
            visibilityOwnerKind: 'context_background',
            visibilityOwnerLedger: { kind: 'run_meta', id: data.runId },
            ownerAgentId: data.agent,
            taskOrigin: 'user_root',
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
          runtime?.publishScopeRunEvent(
            payload,
            structured
              ? {
                projectionPatch: structured,
                transcriptEvents: [{ kind: 'structured_payload', projectionPatch: structured }],
              }
              : null,
          )
        } else if (data.type === 'text') {
          const payload = {
            type: 'updated',
            scopeId: data.sessionId,
            messageVisibilityEpoch: data.messageVisibilityEpoch,
            visibilityOwnerKind: 'context_background',
            visibilityOwnerLedger: { kind: 'run_meta', id: data.runId },
            ownerAgentId: data.agent,
            taskOrigin: 'user_root',
            sessionId: data.sessionId, // Stage V V3.2
            agent: data.agent,
            runId: data.runId,
            phase: 'responding',
            latestText: data.chunk || '',
            timestamp,
          } as const
          runtime?.publishScopeRunEvent(payload)
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
        const terminalReason = normalizeTurnTerminalReason((data as { terminalReason?: unknown }).terminalReason)
        const payload: ScopeRunEventPayload = {
          type: mapAgentStatusToScopeRunEventType(data.status),
          scopeId: data.sessionId,
          messageVisibilityEpoch: data.messageVisibilityEpoch,
          visibilityOwnerKind: 'context_background',
          visibilityOwnerLedger: { kind: 'run_meta', id: data.runId },
          ownerAgentId: data.agent,
          taskOrigin: 'user_root',
          agent: data.agent,
          runId: data.runId,
          phase,
          terminalReason,
          latestText: typeof data.status === 'string' ? `状态：${data.status}` : undefined,
          timestamp: new Date().toISOString(),
        }
        runtime?.publishScopeRunEvent(payload)
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
          messageVisibilityEpoch: data.messageVisibilityEpoch,
          visibilityOwnerKind: 'context_background',
          visibilityOwnerLedger: { kind: 'run_meta', id: data.runId },
          ownerAgentId: data.agent,
          taskOrigin: 'user_root',
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
        runtime?.publishScopeRunEvent(payload)
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

  runtime.on('ingressAdmitted', (data: IngressAdmittedEvent) => {
    petActivity?.refresh()
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:ingressAdmitted', data)
    }
  })

  runtime.on('scopeRunEvent', (data) => {
    petActivity?.observeScopeRunEvent(data)
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
  // error display. The Codex host path is the single producer now.
  // See plan §2 U1.3 / audit §1.1 / U1.1 tool error shape.

  // Stage U0.1 — legacy tool_execute bridge removed. The previous handler
  // used EventEmitter#emit on ipcMain to dispatch calendar create requests
  // and ORed the boolean result with a synthetic success payload, so every
  // call appeared to succeed regardless of whether the event was written.
  // The Ready tool runtime owns product tool execution; see
  // docs/superpowers/audits/2026-05-20-ready-deep-review-and-refactor-plan.md
  // section 1.1 for the audit entry.

  publishAgentRuntimeReady(mainWindow.webContents)
}
