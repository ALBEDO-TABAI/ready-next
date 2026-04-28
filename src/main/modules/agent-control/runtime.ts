import { app } from 'electron'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { extname, isAbsolute, join } from 'path'
import {
  getDefaultConfig,
  normalizeAIConfig,
  type AIModelConfig
} from '../../../shared/ai-providers'
import type { BrowserController } from '../browser-engine/ipc-handler'
import type { AgentManager } from '../claude-bridge/agent-manager'
import type { MultimodalBlock } from '../claude-bridge/direct-chat'
import {
  getDatabase,
  type AgentChannelRecord,
  type AgentChannelType,
  type AgentScheduleRecord,
  type ChatConversationRecord,
  type ChatMessageRecord,
  type ConversationSourceKind,
} from '../database'
import { ClaudeSdkOrchestrator } from './orchestrator'
import { PromptAssemblyService } from './prompt-assembly'
import { RunCoordinator } from './run-coordinator'
import {
  snapshotLastReferenceSkill,
  restoreLastReferenceSkill,
  rememberLastReferenceSkill,
  getLastReferenceSkill,
  peekLastReferenceSkill,
  REFERENCE_SKILL_HINT_TTL_MS,
  type PersistedReferenceSkillHint,
} from './skill-reference-hints'
import { findSkillHintInCapsuleTexts } from './skill-hint-recovery'
import { findSkillToolByName } from '../tools/skills-tools'
import { getSkillsRuntimeManager } from '../skills-runtime/runtime-manager'
import { RunProjection } from './run-projection'
import { syncTaskProjection } from './task-projection-sync'
import type { ProjectionTruthSnapshot, TaskProjectionRecord } from './run-contracts'
import { getBudgetUsagePercent, restoreContinuationTaskBudgetRuntime } from './run-budget-policy'
import { normalizeContinuationIntent, type ContinuationIntent } from './continuation-state'
import { forgetSession } from './session-continuity'
import { isRetryOnlyTurn } from './skill-detection-inputs'
import { logAgentMetric } from './metrics'
import { TOOL_ERROR_METRICS } from './tool-error-metrics'
import { SessionRecallService } from './session-recall-service'
import { SidecarManager } from './sidecar-manager'
import { MemoryRepository } from '../repositories/memory-repository'
import { MemoryLifecycleManager } from './memory-lifecycle'
import { ReflectionService } from './reflection-service'
import { UserProfileRepository } from '../repositories/user-profile-repository'
import { AgentPersonalityRepository } from '../repositories/agent-personality-repository'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import type { CapabilityRuntimeSnapshot } from '../../../shared/ai-capability-runtime'
import { ExternalMemoryProviderSlot } from './external-memory-provider-slot'
import { decryptChannelConfig, encryptChannelConfig } from './secret-storage'
import { ToolGateway } from './tool-gateway'
import { buildCapabilityRuntimeSnapshot } from './capability-runtime-snapshot'
import { TaskProjectionRepository } from '../repositories/task-projection-repository'
import {
  DetachedSkillTaskTracker,
  registerDetachedSkillTaskTracker,
  type DetachedSkillTaskRecord,
} from './detached-skill-task-tracker'
import type {
  AgentChannelConfig,
  AgentRuntimeStatus,
  ChannelAdapterType,
  ChannelAttachment,
  ConversationAttachment,
  ConversationEventPayload,
  ConversationScope,
  ConversationScopeMessage,
  CronTask,
  HeartbeatSnapshot,
  ScopeRunMemoryCapture,
  ScopeRunEventPayload,
  ScopeRunSummary
} from './types'
import type { SessionRecallCapsule, SessionRecallHit } from '../../../shared/session-recall'

export interface UpsertChannelPayload {
  id?: string
  type: ChannelAdapterType
  name: string
  enabled?: boolean
  config?: Record<string, unknown>
}

export interface UpsertSchedulePayload {
  id?: string
  name: string
  cronExpr: string
  prompt: string
  channelId?: string | null
  enabled?: boolean
  payload?: Record<string, unknown>
}

export class AgentControlRuntime extends EventEmitter {
  private readonly db = getDatabase()
  private readonly settingsRepository = new AppSettingsRepository()
  private readonly sidecar = new SidecarManager()
  private readonly orchestrator: ClaudeSdkOrchestrator
  private readonly toolGateway = new ToolGateway()
  private readonly memoryRepository = new MemoryRepository()
  private readonly memoryLifecycle = new MemoryLifecycleManager(this.memoryRepository)
  private readonly userProfileRepository = new UserProfileRepository()
  private readonly agentPersonalityRepository = new AgentPersonalityRepository()
  private readonly externalMemoryProviderSlot = new ExternalMemoryProviderSlot()
  private readonly sessionRecallService = new SessionRecallService(this.db)
  private readonly reflectionService = new ReflectionService({
    memoryRepository: this.memoryRepository,
    userProfileRepository: this.userProfileRepository,
    knowledgeRepository: {
      set: async (key: string, value: string) => {
        const rawDb = this.db.getRawDb()
        if (!rawDb) throw new Error('Database not available')
        rawDb
          .prepare(
            `
          INSERT INTO agent_knowledge (id, agent_name, key, value, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(agent_name, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `
          )
          .run(
            `knowledge-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            'system',
            key,
            value,
            new Date().toISOString(),
            new Date().toISOString()
          )
      },
      get: async (key: string) => {
        const rawDb = this.db.getRawDb()
        if (!rawDb) return null
        const row = rawDb
          .prepare(
            `
          SELECT value FROM agent_knowledge WHERE agent_name = 'system' AND key = ?
        `
          )
          .get(key) as { value: string } | undefined
        return row?.value || null
      }
    }
  })
  private readonly promptAssembly = new PromptAssemblyService({
    getMemoryRoot: () => join(app.getPath('userData'), 'agent-memory'),
    memoryRepository: this.memoryRepository,
    userProfileRepository: this.userProfileRepository,
    agentPersonalityRepository: this.agentPersonalityRepository,
    getScopeSessionRecallCapsules: (scope) =>
      this.sessionRecallService.listAttachedSessionRecallContexts(scope.id),
    getAutoSessionRecallCapsules: ({ scope, userText }) =>
      this.sessionRecallService.getAutomaticRecallCapsules({
        query: userText,
        currentScopeId: scope.id,
        channelKey: this.toChannelKey(scope),
        sourceKind: scope.sourceKind,
        userId: scope.userId,
        limit: 2
      }),
    enableDatabaseMemory: true
  })
  private readonly agentManager: AgentManager
  private readonly runCoordinator: RunCoordinator
  private readonly runProjection: RunProjection
  private readonly taskProjectionStore = new TaskProjectionRepository(this.db)
  private readonly detachedSkillTasks: DetachedSkillTaskTracker
  private readonly pendingInboundChannels = new Map<
    string,
    {
      channelId: string
      thread: string
      sender: string
      eventIds: string[]
      texts: string[]
      attachments: ChannelAttachment[]
      timer: NodeJS.Timeout | null
    }
  >()
  private pollTimer: NodeJS.Timeout | null = null
  private readonly scopeRunSummaries = new Map<string, ScopeRunSummary>()
  private lastSidecarRestartAttemptAt = 0
  private readonly lastAdapterRestartAttemptAt = new Map<string, number>()
  private heartbeat: HeartbeatSnapshot = {
    sidecar: { status: 'stopped' },
    adapters: [],
    orchestrator: { healthy: true, activeTasks: 0, lastBeatAt: new Date().toISOString() },
    toolGateway: {
      healthy: true,
      availableTools: this.toolGateway.count(),
      lastBeatAt: new Date().toISOString()
    }
  }

  constructor(agentManager: AgentManager, browserController?: BrowserController) {
    super()
    this.agentManager = agentManager
    this.orchestrator = new ClaudeSdkOrchestrator({
      browserController,
      sidecarManager: this.sidecar
    })
    this.orchestrator.setRuntime(this)
    this.runCoordinator = new RunCoordinator({
      promptAssembly: this.promptAssembly,
      executeAndCollect: (request) => this.orchestrator.executeAndCollect(request),
      emitScopeRunEvent: (payload, projectionTruth) => this.emitScopeRunEvent(payload, projectionTruth),
      reflectOnConversation: (scope, usedTools) => this.reflectOnConversation(scope, usedTools)
    })
    this.runProjection = new RunProjection({
      getScope: (scopeId) => this.getConversationScope(scopeId),
      getPrevious: (scopeId) => this.scopeRunSummaries.get(scopeId),
      setSummary: (scopeId, summary) => {
        this.scopeRunSummaries.set(scopeId, summary)
        this.db.updateConversationRecallTaskState(scopeId, summary.taskTitle, summary.taskSummary)
      },
      toChannelKey: (scope) => this.toChannelKey(scope)
    })
    this.detachedSkillTasks = new DetachedSkillTaskTracker({
      storagePath: join(app.getPath('userData'), 'skill-runtime', 'detached-tasks.json'),
      runSkill: (request) => getSkillsRuntimeManager().runSkill(request),
      onUpdate: (record) => this.publishDetachedSkillTaskUpdate(record),
    })
    registerDetachedSkillTaskTracker(this.detachedSkillTasks)
  }

  getOrchestrator(): ClaudeSdkOrchestrator {
    return this.orchestrator
  }

  getMemoryRepository(): MemoryRepository {
    return this.memoryRepository
  }

  getMemoryLifecycleManager(): MemoryLifecycleManager {
    return this.memoryLifecycle
  }

  getPromptAssembly(): PromptAssemblyService {
    return this.promptAssembly
  }

  getExternalMemoryProviderSlot(): ExternalMemoryProviderSlot {
    return this.externalMemoryProviderSlot
  }

  async start(): Promise<void> {
    this.cleanupLegacyCopawSettings()
    this.publishRestoredDetachedSkillTasks()

    // Start memory lifecycle manager
    this.memoryLifecycle.start()

    const sidecarEnabled = this.getSettingBool('remote_channels_enabled', true)
    const autostart = this.getSettingBool('sidecar_autostart', true)
    const bindHost = this.db.getSetting('sidecar_bind_host') || '127.0.0.1'
    const bindPort = this.parsePortSetting(this.db.getSetting('sidecar_bind_port'))
    this.sidecar.setBindConfig(bindHost, bindPort)
    if (!sidecarEnabled || !autostart) return
    await this.startSidecar()
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    // Stop memory lifecycle manager
    this.memoryLifecycle.stop()
    await this.externalMemoryProviderSlot.shutdown()

    await this.sidecar.stop()
  }

  async startSidecar(): Promise<void> {
    const status = await this.sidecar.start()
    this.heartbeat.sidecar = {
      status: status.state,
      pid: status.pid || undefined,
      port: status.port || undefined,
      lastBeatAt: status.lastHeartbeatAt || undefined,
      error: status.error || undefined
    }
    if (status.state === 'running') {
      await this.syncDatabaseToSidecar()
      this.ensurePollLoop()
    }
  }

  async getRuntimeStatus(): Promise<AgentRuntimeStatus> {
    const channels = this.listChannels()
    const schedules = this.listSchedules()
    const byType: Record<string, number> = {}
    for (const channel of channels) {
      byType[channel.type] = (byType[channel.type] || 0) + 1
    }

    const sidecarStatus = this.sidecar.getStatus()
    this.heartbeat.sidecar = {
      status: sidecarStatus.state,
      pid: sidecarStatus.pid || undefined,
      port: sidecarStatus.port || undefined,
      lastBeatAt: sidecarStatus.lastHeartbeatAt || undefined,
      error: sidecarStatus.error || undefined
    }
    this.heartbeat.orchestrator = {
      healthy: true,
      activeTasks: this.orchestrator.getSessionManager().getActiveCount(),
      lastBeatAt: new Date().toISOString()
    }
    this.heartbeat.toolGateway = {
      healthy: true,
      availableTools: this.toolGateway.count(),
      lastBeatAt: new Date().toISOString()
    }

    const channelState = this.sidecar.isRunning()
      ? await this.sidecar.getChannelState().catch(() => ({}))
      : {}
    const connected = Number((channelState as { connected?: number }).connected || 0)
    const errors = Number((channelState as { errors?: number }).errors || 0)

    return {
      orchestrator: 'claude-sdk',
      sidecarEnabled: this.getSettingBool('remote_channels_enabled', true),
      sidecar: this.heartbeat.sidecar,
      channels: {
        total: channels.length,
        enabled: channels.filter((item) => item.enabled).length,
        connected,
        errors,
        byType
      },
      schedules: {
        total: schedules.length,
        enabled: schedules.filter((item) => item.enabled).length
      },
      heartbeat: this.heartbeat
    }
  }

  async getCapabilityRuntimeSnapshot(configOverride?: AIModelConfig): Promise<CapabilityRuntimeSnapshot> {
    await this.getRuntimeStatus()

    const config = normalizeAIConfig(
      configOverride || this.settingsRepository.getAIConfig() || getDefaultConfig()
    )
    const enabledChannelTypes = Array.from(
      new Set(
        this.listChannels()
          .filter((channel) => channel.enabled)
          .map((channel) => channel.type)
      )
    )
    const connectedChannelTypes = Array.from(
      new Set(
        this.heartbeat.adapters
          .filter(
            (adapter) =>
              adapter.healthy && adapter.status !== 'error' && adapter.status !== 'stopped'
          )
          .map((adapter) => adapter.type)
      )
    )
    const feishuConnected =
      connectedChannelTypes.includes('feishu-app') || this.isChannelTypeAvailable('feishu-app')

    return buildCapabilityRuntimeSnapshot({
      config,
      profile: 'local_chat',
      browserDecisionMode: 'free_tool_loop',
      runtimeAvailability: {
        browserHostAvailable: this.orchestrator.hasBrowserController(),
        feishuConnected
      },
      enabledChannelTypes,
      connectedChannelTypes
    })
  }

  listChannels(): AgentChannelConfig[] {
    const rows = this.db.listAgentChannels()
    return rows.map((row) => this.mapChannelRow(row))
  }

  isChannelTypeAvailable(type: AgentChannelType): boolean {
    const hasEnabledChannel = this.listChannels().some(
      (channel) => channel.type === type && channel.enabled
    )
    if (!hasEnabledChannel) return false

    const heartbeatAdapter = this.heartbeat.adapters.find((adapter) => adapter.type === type)
    if (!heartbeatAdapter) return true
    return (
      heartbeatAdapter.healthy &&
      heartbeatAdapter.status !== 'error' &&
      heartbeatAdapter.status !== 'stopped'
    )
  }

  listConversationScopes(agent?: string): ConversationScope[] {
    return this.db.listConversationScopes(agent).map((row) => this.mapConversationRow(row))
  }

  listScopeRuns(payload?: {
    channelKey?: string
    statuses?: Array<ScopeRunEventPayload['phase']>
    limit?: number
  }): ScopeRunSummary[] {
    const channelKey = String(payload?.channelKey || '').trim()
    const statuses = Array.isArray(payload?.statuses) ? new Set(payload?.statuses) : null
    const limit = Number.isFinite(Number(payload?.limit))
      ? Math.max(1, Math.min(100, Number(payload?.limit)))
      : 20
    return Array.from(this.scopeRunSummaries.values())
      .filter((item) => (channelKey ? item.channelKey === channelKey : true))
      .filter((item) => (statuses ? statuses.has(item.phase) : true))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, limit)
  }

  listTaskProjections(scopeId: string): TaskProjectionRecord[] {
    const normalizedScopeId = String(scopeId || '').trim()
    if (!normalizedScopeId) return []
    return this.taskProjectionStore.listByScope(normalizedScopeId) as TaskProjectionRecord[]
  }

  getTaskProjection(taskId: string): TaskProjectionRecord | null {
    const normalizedTaskId = String(taskId || '').trim()
    if (!normalizedTaskId) return null
    return this.taskProjectionStore.get(normalizedTaskId) as TaskProjectionRecord | null
  }

  searchSessionRecall(payload?: {
    query?: string
    channelKey?: string
    sourceKind?: ConversationSourceKind
    userId?: string
    hasAttachments?: boolean
    currentScopeId?: string
    limit?: number
  }): SessionRecallHit[] {
    return this.sessionRecallService.searchSessionRecall(payload || {})
  }

  listRecentSessions(payload?: {
    channelKey?: string
    sourceKind?: ConversationSourceKind
    userId?: string
    hasAttachments?: boolean
    currentScopeId?: string
    limit?: number
  }): SessionRecallHit[] {
    return this.sessionRecallService.listRecentSessions(payload || {})
  }

  getSessionRecallCapsule(conversationId: string): SessionRecallCapsule | null {
    return this.sessionRecallService.getSessionRecallCapsule({ conversationId })
  }

  listAttachedSessionRecallContexts(scopeId: string): SessionRecallCapsule[] {
    return this.sessionRecallService.listAttachedSessionRecallContexts(scopeId)
  }

  getReferenceSkillHint(scopeId: string): { id: string; name: string; at: number; expiresAt: number } | null {
    const normalizedScopeId = String(scopeId || '').trim()
    if (!normalizedScopeId) return null
    const live = peekLastReferenceSkill(normalizedScopeId)
    if (live) {
      return {
        id: live.id,
        name: live.name,
        at: live.at,
        expiresAt: live.at + REFERENCE_SKILL_HINT_TTL_MS,
      }
    }

    const scope = this.getConversationScope(normalizedScopeId)
    const meta = this.parseScopeMeta(scope)
    const persisted = meta['lastReferenceSkill']
    if (!persisted || typeof persisted !== 'object') return null
    const hint = persisted as PersistedReferenceSkillHint
    if (typeof hint.id !== 'string' || typeof hint.name !== 'string' || typeof hint.at !== 'number') return null
    if (!restoreLastReferenceSkill(normalizedScopeId, hint)) return null
    const restored = peekLastReferenceSkill(normalizedScopeId)
    if (!restored) return null
    return {
      id: restored.id,
      name: restored.name,
      at: restored.at,
      expiresAt: restored.at + REFERENCE_SKILL_HINT_TTL_MS,
    }
  }

  /**
   * Phase 1.1 — Public hook the renderer's `chat:saveMessage` IPC calls after
   * persisting a message, so a hint armed during the assistant's turn survives
   * a Ready restart for LOCAL conversations too.
   *
   * Background: assistant messages saved via `chat:saveMessage` IPC go through
   * `ChatRepository.saveMessage` (a thin wrapper over `db.addChatMessage`),
   * which bypasses `runtime.createConversationMessage` — the only path that
   * previously snapshot the in-memory hint into `meta_json.lastReferenceSkill`.
   * Result before this hook: local sessions never persisted hints, so a Ready
   * restart always re-armed `referenceSkillHintArmed=false` and the model lost
   * VEA / other typed actions mid-flow.
   *
   * No-op for non-assistant roles. Safe to call after every message; the
   * underlying `persistReferenceHintToScope` is idempotent (skips DB write
   * when the persisted snapshot equals the in-memory one).
   */
  persistReferenceHintAfterAssistantMessage(scopeId: string, role: string): void {
    if (role !== 'assistant') return
    const normalizedScopeId = String(scopeId || '').trim()
    if (!normalizedScopeId) return
    this.persistReferenceHintToScope(normalizedScopeId)
  }

  startDetachedSkillAction(payload: {
    scopeId?: string | null
    sessionId?: string | null
    agent?: string | null
    parentTaskId?: string | null
    parentStepId?: string | null
    taskProjectionId?: string | null
    skillId: string
    action: string
    params?: Record<string, unknown>
  }): DetachedSkillTaskRecord {
    return this.detachedSkillTasks.start(payload)
  }

  inspectDetachedSkillTask(taskId: string, scopeId?: string | null): DetachedSkillTaskRecord | null {
    const task = this.detachedSkillTasks.inspect(taskId)
    if (!task) return null
    const normalizedScopeId = String(scopeId || '').trim()
    if (normalizedScopeId && task.scopeId !== normalizedScopeId && task.sessionId !== normalizedScopeId) return null
    return task
  }

  listDetachedSkillTasks(payload?: { scopeId?: string | null }): DetachedSkillTaskRecord[] {
    return this.detachedSkillTasks.list(payload)
  }

  cancelDetachedSkillTask(taskId: string, scopeId?: string | null): DetachedSkillTaskRecord | null {
    const normalizedScopeId = String(scopeId || '').trim()
    const task = this.detachedSkillTasks.inspect(taskId)
    if (!task) return null
    if (normalizedScopeId && task.scopeId !== normalizedScopeId && task.sessionId !== normalizedScopeId) return null
    return this.detachedSkillTasks.cancel(taskId)
  }

  attachSessionRecallContext(
    currentScopeId: string,
    conversationId: string
  ): { scope: ConversationScope; capsule: SessionRecallCapsule } {
    const result = this.sessionRecallService.attachSessionRecallContext({
      currentScopeId,
      conversationId
    })
    const scope = this.mapConversationRow(result.scope)
    this.emitConversationEvent({
      type: 'scope_updated',
      scope
    })
    return { scope, capsule: result.capsule }
  }

  detachSessionRecallContext(
    currentScopeId: string,
    conversationId: string
  ): { scope: ConversationScope } {
    const result = this.sessionRecallService.detachSessionRecallContext({
      currentScopeId,
      conversationId
    })
    const scope = this.mapConversationRow(result.scope)
    this.emitConversationEvent({
      type: 'scope_updated',
      scope
    })
    return { scope }
  }

  resumeSessionCandidate(payload: {
    conversationId?: string
    resumeTitle?: string
  }): SessionRecallHit | null {
    return this.sessionRecallService.resumeSessionCandidate(payload)
  }

  getConversationScope(scopeId: string): ConversationScope | null {
    const row = this.db.getConversationScope(scopeId)
    return row ? this.mapConversationRow(row) : null
  }

  getConversationScopeMessages(scopeId: string): ConversationScopeMessage[] {
    return this.db.getChatMessages(scopeId).map((row) => this.mapMessageRow(row))
  }

  deleteConversation(scopeId: string): void {
    this.scopeRunSummaries.delete(scopeId)
    forgetSession(scopeId)
    this.taskProjectionStore.deleteByScope(scopeId)
    this.db.deleteConversation(scopeId)
  }

  listScopeAttachments(scopeId: string): ConversationAttachment[] {
    return this.db
      .listConversationAttachments(scopeId)
      .filter((item) => item.path && existsSync(item.path))
      .map((item) => ({
        attachmentId: item.attachment_id,
        scopeId: item.conversation_id,
        sourceMessageId: item.source_message_id,
        name: item.name,
        path: item.path,
        type: ['image', 'video', 'text', 'spreadsheet', 'other'].includes(String(item.type))
          ? (item.type as ConversationAttachment['type'])
          : 'other',
        size: item.size,
        ext: item.ext,
        url: item.url,
        mimeType: item.mime_type,
        remoteId: item.remote_id,
        channelId: item.channel_id,
        threadKey: item.thread_key,
        createdAt: item.created_at
      }))
  }

  getScopeAttachment(scopeId: string, attachmentId: string): ConversationAttachment | null {
    return (
      this.listScopeAttachments(scopeId).find((item) => item.attachmentId === attachmentId) || null
    )
  }

  getRemoteAttachmentCacheStats(channelId?: string): {
    totalFiles: number
    totalBytes: number
    targetPath: string
    channels: Array<{ channelId: string; files: number; bytes: number }>
  } {
    const basePath = join(app.getPath('userData'), 'agent-sidecar-runtime', 'channel-attachments')
    const targetPath = channelId ? join(basePath, channelId) : basePath
    let totalFiles = 0
    let totalBytes = 0
    const byChannel = new Map<string, { files: number; bytes: number }>()

    const walk = (currentPath: string, currentChannelId?: string): void => {
      if (!existsSync(currentPath)) return
      const stat = statSync(currentPath)
      if (stat.isFile()) {
        totalFiles += 1
        totalBytes += stat.size
        if (currentChannelId) {
          const current = byChannel.get(currentChannelId) || { files: 0, bytes: 0 }
          current.files += 1
          current.bytes += stat.size
          byChannel.set(currentChannelId, current)
        }
        return
      }
      if (!stat.isDirectory()) return
      for (const entry of readdirSync(currentPath)) {
        const nextPath = join(currentPath, entry)
        const nextChannelId =
          currentChannelId || (!channelId && currentPath === basePath ? entry : currentChannelId)
        walk(nextPath, nextChannelId)
      }
    }

    walk(targetPath, channelId || undefined)

    return {
      totalFiles,
      totalBytes,
      targetPath,
      channels: Array.from(byChannel.entries()).map(([itemChannelId, value]) => ({
        channelId: itemChannelId,
        files: value.files,
        bytes: value.bytes
      }))
    }
  }

  clearRemoteAttachmentCache(channelId?: string): {
    removedFiles: number
    removedBytes: number
    targetPath: string
  } {
    const basePath = join(app.getPath('userData'), 'agent-sidecar-runtime', 'channel-attachments')
    const targetPath = channelId ? join(basePath, channelId) : basePath
    let removedFiles = 0
    let removedBytes = 0

    const walk = (currentPath: string): void => {
      if (!existsSync(currentPath)) return
      const stat = statSync(currentPath)
      if (stat.isFile()) {
        removedFiles += 1
        removedBytes += stat.size
        return
      }
      if (!stat.isDirectory()) return
      for (const entry of readdirSync(currentPath)) {
        walk(join(currentPath, entry))
      }
    }

    walk(targetPath)
    rmSync(targetPath, { recursive: true, force: true })
    return { removedFiles, removedBytes, targetPath }
  }

  createLocalScope(agent: string, id?: string): ConversationScope {
    const scopeId = typeof id === 'string' && id.trim() ? id.trim() : `conv-${randomUUID()}`
    const row = this.db.upsertConversationScope({
      id: scopeId,
      agent,
      title: '新对话',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: scopeId,
      meta: { sourceLabel: '应用内', createdBy: 'app' }
    })
    const scope = this.mapConversationRow(row)
    this.emitConversationEvent({ type: 'scope_created', scope })
    return scope
  }

  async sendScoped(payload: {
    scopeId: string
    message: string | MultimodalBlock[]
    requestId?: string
    taskId?: string
    parentTaskId?: string
    parentStepId?: string
    sessionIdOverride?: string
    continuationIntent?: ContinuationIntent | null
  }): Promise<{ success: boolean; error?: string }> {
    const scopeRow = this.db.getConversationScope(payload.scopeId)
    if (!scopeRow) {
      return { success: false, error: `Conversation scope not found: ${payload.scopeId}` }
    }
    const scope = this.mapConversationRow(scopeRow)
    // skill-resume A1: restore reference-skill hint from persisted conv meta
    // before any skill detection runs, so resumed sessions don't lose context
    // after Ready restart (in-memory Map alone wouldn't survive).
    this.restoreReferenceHintFromScope(scope, payload.scopeId)
    // skill-resume E1: when the user fires a bare retry/continue intent on a
    // scope with no manually-attached recall context, auto-attach the top
    // predecessors in the same lineage so prompt assembly has prior context
    // when it runs.
    this.maybeAutoAttachSessionRecallOnResume(payload.scopeId, payload.message)
    const normalizedContinuationIntent = (() => {
      const intent = normalizeContinuationIntent(payload.continuationIntent || null)
      if (!intent) return null
      const target = this.resolveTaskControlTarget(payload.scopeId, intent.taskId)
      if (!target) return null
      return this.buildContinuationIntent({
        projection: target.projection,
        scopeRunSummary: target.scopeRunSummary,
        incoming: intent,
      })
    })()
    return this.runCoordinator.runScoped(
      {
        scope,
        message: payload.message as
          | string
          | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>,
        requestId: payload.requestId,
        taskId: payload.taskId,
        parentTaskId: payload.parentTaskId,
        parentStepId: payload.parentStepId,
        sessionIdOverride: payload.sessionIdOverride,
        continuationIntent: normalizedContinuationIntent,
      },
      {
        onSuccess: async (result) => {
          if (scope.sourceKind !== 'channel') return
          const outboundText =
            result.finalText.trim() || '任务已完成，但本次没有产生可发送的文本结果。'
          const sendOk = await this.sendLongTextToChannel(
            scope.sourceId,
            scope.threadKey,
            outboundText
          )
          if (!sendOk.success) {
            throw new Error(sendOk.error || 'Failed to send channel reply')
          }
        }
      }
    )
  }

  async suspendRun(payload: {
    scopeId: string
    taskId?: string
  }): Promise<{ success: boolean; error?: string }> {
    const target = this.resolveTaskControlTarget(payload.scopeId, payload.taskId)
    if (!target) {
      return { success: false, error: 'Conversation scope not found' }
    }
    this.orchestrator.kill(target.scope.agent, target.scope.id)

    const restored = restoreContinuationTaskBudgetRuntime({
      taskType: target.projection?.taskType || 'short_task',
      budget: target.projection?.budget || null,
    })
    const runtime = restored.runtime
      ? {
        ...restored.runtime,
        frozen: true,
      }
      : null
    const resolvedTaskId = target.projection?.taskId || target.scopeRunSummary?.taskId || payload.taskId
    const resolvedTaskType = target.projection?.taskType || target.scopeRunSummary?.taskType || 'short_task'
    const timestamp = new Date().toISOString()
    this.emitScopeRunEvent({
      type: 'updated',
      scopeId: target.scope.id,
      agent: target.scope.agent,
      runId: target.projection?.runId,
      taskId: resolvedTaskId,
      phase: 'takeover',
      taskType: resolvedTaskType,
      interactionState: 'suspended',
      taskTitle: target.projection?.taskTitle || target.scopeRunSummary?.taskTitle || undefined,
      taskSummary: target.projection?.taskSummary || target.scopeRunSummary?.taskSummary || undefined,
      steps: (target.projection?.steps || target.scopeRunSummary?.steps || []) as any,
      currentStepId: target.projection?.currentStepId || target.scopeRunSummary?.currentStepId || null,
      waitingFor: 'none',
      resumableActions: ['continue', 'cancel'],
      blockedReason: '任务已暂停，等待继续。',
      taskContinuation: target.projection?.continuationRef || target.scopeRunSummary?.taskContinuation || undefined,
      taskProjectionId: resolvedTaskId,
      executionDiagnostics: runtime
        ? {
          taskId: resolvedTaskId,
          taskBudgetRuntime: runtime,
          budget: {
            ...runtime.budget,
            ...runtime.usage,
          },
          stepBudget: runtime.stepBudget
            ? {
              stepId: runtime.stepBudget.stepId || null,
              maxIterations: runtime.stepBudget.maxIterations,
              remainingIterations: runtime.stepBudget.remainingIterations,
            }
            : null,
          budgetUsagePercent: getBudgetUsagePercent(runtime),
          budgetWarningLevel: runtime.warningLevel,
        }
        : null,
      timestamp,
    })
    return { success: true }
  }

  async resumeRun(payload: {
    scopeId: string
    taskId?: string
    requestId?: string
    responseText?: string
    continuationIntent?: ContinuationIntent | null
  }): Promise<{ success: boolean; error?: string }> {
    const target = this.resolveTaskControlTarget(payload.scopeId, payload.taskId)
    if (!target) {
      return { success: false, error: 'Conversation scope not found' }
    }
    return this.sendScoped({
      scopeId: target.scope.id,
      requestId: payload.requestId,
      message: String(payload.responseText || '').trim() || '继续当前任务。',
      continuationIntent: this.buildContinuationIntent({
        projection: target.projection,
        scopeRunSummary: target.scopeRunSummary,
        incoming: payload.continuationIntent || null,
        responseText: payload.responseText,
      }),
    })
  }

  async respondToInteraction(payload: {
    scopeId: string
    taskId?: string
    requestId?: string
    responseText: string
    continuationIntent?: ContinuationIntent | null
  }): Promise<{ success: boolean; error?: string }> {
    const responseText = String(payload.responseText || '').trim()
    if (!responseText) {
      return { success: false, error: 'Interaction response is required' }
    }
    const target = this.resolveTaskControlTarget(payload.scopeId, payload.taskId)
    if (!target) {
      return { success: false, error: 'Conversation scope not found' }
    }
    return this.sendScoped({
      scopeId: target.scope.id,
      requestId: payload.requestId,
      message: responseText,
      continuationIntent: this.buildContinuationIntent({
        projection: target.projection,
        scopeRunSummary: target.scopeRunSummary,
        incoming: payload.continuationIntent || null,
        responseText,
      }),
    })
  }

  async upsertChannel(payload: UpsertChannelPayload): Promise<AgentChannelConfig> {
    const id = payload.id || `channel-${randomUUID()}`
    const encryptedConfig = encryptChannelConfig(payload.config || {})
    const row = this.db.upsertAgentChannel({
      id,
      type: payload.type as AgentChannelType,
      name: payload.name.trim() || id,
      enabled: payload.enabled ?? true,
      configJson: JSON.stringify(encryptedConfig)
    })

    if (this.sidecar.isRunning()) {
      await this.sidecar.upsertChannel({
        id,
        type: row.type,
        name: row.name,
        enabled: Boolean(row.enabled),
        config: decryptChannelConfig(encryptedConfig)
      })
      if (row.enabled) {
        await this.sidecar.startChannel(id).catch(() => undefined)
      } else {
        await this.sidecar.stopChannel(id).catch(() => undefined)
      }
    }
    return this.mapChannelRow(row)
  }

  async deleteChannel(id: string): Promise<boolean> {
    if (this.sidecar.isRunning()) {
      await this.sidecar.stopChannel(id).catch(() => undefined)
      await this.sidecar.deleteChannel(id).catch(() => undefined)
    }
    return this.db.deleteAgentChannel(id)
  }

  async setChannelEnabled(id: string, enabled: boolean): Promise<AgentChannelConfig | null> {
    const row = this.db.setAgentChannelEnabled(id, enabled)
    if (!row) return null
    if (this.sidecar.isRunning()) {
      await this.sidecar.upsertChannel({
        id: row.id,
        type: row.type,
        name: row.name,
        enabled: Boolean(row.enabled),
        config: decryptChannelConfig(
          this.tryParseJson<Record<string, unknown>>(row.config_json, {})
        )
      })
      if (enabled) {
        await this.sidecar.startChannel(id).catch(() => undefined)
      } else {
        await this.sidecar.stopChannel(id).catch(() => undefined)
      }
    }
    return this.mapChannelRow(row)
  }

  async sendChannelProbe(id: string, text: string): Promise<{ success: boolean; error?: string }> {
    if (!this.sidecar.isRunning()) {
      await this.startSidecar()
    }
    const channel = this.db.getAgentChannel(id)
    if (!channel) return { success: false, error: `Channel not found: ${id}` }
    try {
      await this.sidecar.sendChannel({
        id,
        text: text.trim() || 'Ready 连接测试成功'
      })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async testChannel(payload: UpsertChannelPayload): Promise<{ success: boolean; error?: string }> {
    if (!this.sidecar.isRunning()) {
      await this.startSidecar()
    }
    try {
      const response = await this.sidecar.testChannel({
        id: payload.id || `temp-${randomUUID()}`,
        type: payload.type,
        name: payload.name,
        enabled: payload.enabled ?? true,
        config: payload.config || {}
      })
      if (response.success === false) {
        return { success: false, error: String(response.error || 'channel test failed') }
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  listSchedules(): CronTask[] {
    const rows = this.db.listAgentSchedules()
    return rows.map((row) => this.mapScheduleRow(row))
  }

  async upsertSchedule(payload: UpsertSchedulePayload): Promise<CronTask> {
    const id = payload.id || `cron-${randomUUID()}`
    const row = this.db.upsertAgentSchedule({
      id,
      name: payload.name.trim() || id,
      cronExpr: payload.cronExpr,
      prompt: payload.prompt,
      channelId: payload.channelId ?? null,
      enabled: payload.enabled ?? true,
      payloadJson: payload.payload ? JSON.stringify(payload.payload) : null
    })

    if (this.sidecar.isRunning()) {
      await this.sidecar.upsertSchedule({
        id,
        name: row.name,
        cronExpr: row.cron_expr,
        prompt: row.prompt,
        channelId: row.channel_id,
        enabled: Boolean(row.enabled),
        payload: payload.payload || {}
      })
    }
    return this.mapScheduleRow(row)
  }

  async pauseSchedule(id: string): Promise<CronTask | null> {
    if (this.sidecar.isRunning()) {
      await this.sidecar.pauseSchedule(id)
    }
    const row = this.db.setAgentScheduleEnabled(id, false)
    return row ? this.mapScheduleRow(row) : null
  }

  async resumeSchedule(id: string): Promise<CronTask | null> {
    if (this.sidecar.isRunning()) {
      await this.sidecar.resumeSchedule(id)
    }
    const row = this.db.setAgentScheduleEnabled(id, true)
    return row ? this.mapScheduleRow(row) : null
  }

  async deleteSchedule(id: string): Promise<boolean> {
    if (this.sidecar.isRunning()) {
      await this.sidecar.deleteSchedule(id)
    }
    return this.db.deleteAgentSchedule(id)
  }

  async runScheduleNow(id: string): Promise<{ success: boolean; error?: string }> {
    const schedule = this.db.getAgentSchedule(id)
    if (!schedule) return { success: false, error: `Schedule not found: ${id}` }
    if (this.sidecar.isRunning()) {
      await this.sidecar.runScheduleNow(id)
    }
    return await this.executeSchedule(schedule)
  }

  async syncDatabaseToSidecar(): Promise<void> {
    if (!this.sidecar.isRunning()) return
    const channels = this.listChannels()
    for (const channel of channels) {
      await this.sidecar.upsertChannel({
        id: channel.id,
        type: channel.type,
        name: channel.name,
        enabled: channel.enabled,
        config: channel.config
      })
      if (channel.enabled) {
        await this.sidecar.startChannel(channel.id).catch(() => undefined)
      } else {
        await this.sidecar.stopChannel(channel.id).catch(() => undefined)
      }
    }
    const schedules = this.listSchedules()
    for (const schedule of schedules) {
      await this.sidecar.upsertSchedule({
        id: schedule.id,
        name: schedule.name,
        cronExpr: schedule.cronExpr,
        prompt: schedule.prompt,
        channelId: schedule.channelId,
        enabled: schedule.enabled,
        payload: schedule.payload || {}
      })
    }
  }

  private ensurePollLoop(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.pollSidecarEvents()
    }, 3_000)
  }

  private async pollSidecarEvents(): Promise<void> {
    if (!this.sidecar.isRunning()) {
      const sidecarEnabled = this.getSettingBool('remote_channels_enabled', true)
      const autostart = this.getSettingBool('sidecar_autostart', true)
      const now = Date.now()
      if (sidecarEnabled && autostart && now - this.lastSidecarRestartAttemptAt > 30_000) {
        this.lastSidecarRestartAttemptAt = now
        await this.startSidecar()
      }
      return
    }
    try {
      const heart = await this.sidecar.heartbeat()
      this.heartbeat.sidecar.lastBeatAt = new Date().toISOString()
      this.heartbeat.sidecar.status = 'running'
      const adapters = Array.isArray((heart as { adapters?: unknown[] }).adapters)
        ? ((heart as { adapters?: unknown[] }).adapters as Array<Record<string, unknown>>)
        : []
      this.heartbeat.adapters = adapters.map((item) => ({
        id: String(item.id || ''),
        type: String(item.type || 'local-debug') as ChannelAdapterType,
        healthy: Boolean(item.healthy),
        status:
          typeof item.status === 'string'
            ? (item.status as 'starting' | 'running' | 'stopped' | 'error')
            : undefined,
        lastBeatAt: typeof item.lastBeatAt === 'string' ? item.lastBeatAt : undefined,
        error: typeof item.error === 'string' ? item.error : undefined
      }))
      await this.reviveErroredAdapters()

      const events = await this.sidecar.pullEvents(24)
      for (const evt of events) {
        const evtType = String(evt.type || '')
        if (evtType === 'schedule.trigger') {
          const payload = (evt.payload || {}) as Record<string, unknown>
          const scheduleId = String(payload.scheduleId || '')
          if (!scheduleId) continue
          const schedule = this.db.getAgentSchedule(scheduleId)
          if (!schedule || schedule.enabled === 0) continue
          await this.executeSchedule(schedule)
          continue
        }
        if (evtType === 'channel.inbound') {
          const payload = (evt.payload || {}) as Record<string, unknown>
          await this.handleInboundChannel(payload)
        }
      }
    } catch (error) {
      this.heartbeat.sidecar.status = 'error'
      this.heartbeat.sidecar.error = error instanceof Error ? error.message : String(error)
    }
  }

  private async reviveErroredAdapters(): Promise<void> {
    const enabledChannelIds = new Set(
      this.listChannels()
        .filter((item) => item.enabled)
        .map((item) => item.id)
    )
    const now = Date.now()
    for (const adapter of this.heartbeat.adapters) {
      if (!adapter.id || !enabledChannelIds.has(adapter.id)) continue
      const shouldRestart =
        adapter.status === 'error' ||
        adapter.status === 'stopped' ||
        (adapter.healthy === false && adapter.status !== 'starting')
      if (!shouldRestart) continue
      const lastAttempt = this.lastAdapterRestartAttemptAt.get(adapter.id) || 0
      if (now - lastAttempt < 15_000) continue
      this.lastAdapterRestartAttemptAt.set(adapter.id, now)
      await this.sidecar.stopChannel(adapter.id).catch(() => undefined)
      await this.sidecar.startChannel(adapter.id).catch(() => undefined)
    }
  }

  private async executeSchedule(
    schedule: AgentScheduleRecord
  ): Promise<{ success: boolean; error?: string }> {
    const prompt = schedule.prompt.trim()
    if (!prompt) return { success: false, error: 'Schedule prompt is empty' }
    const wrapped = `[cron:${schedule.name}] ${prompt}`
    const result = await this.orchestrator.send('butler', wrapped)
    if (result.success) {
      this.db.markAgentScheduleRun(schedule.id)
    }
    return result
  }

  private async handleInboundChannel(payload: Record<string, unknown>): Promise<void> {
    const eventId = String(payload.id || payload.idempotencyKey || '')
    const channelId = String(payload.channelId || payload.source || '')
    const thread = String(payload.thread || '')
    const sender = String(payload.sender || '')
    const text = String(payload.text || '').trim()
    const attachments = this.parseChannelAttachments(payload.attachments)
    const existingEvent = this.db.getAgentChannelEvent(eventId)
    if (existingEvent && existingEvent.status === 'done') return
    if (!eventId || !channelId || (!text && attachments.length === 0)) return
    this.enqueueInboundChannelEvent({
      eventId,
      channelId,
      thread: thread || 'default',
      sender,
      text,
      attachments
    })
  }

  private getInboundCoalesceWindowMs(): number {
    const raw = Number(this.db.getSetting('agent_message_coalesce_window_ms') || 1200)
    if (!Number.isFinite(raw)) return 1200
    return Math.min(2500, Math.max(600, Math.round(raw)))
  }

  private enqueueInboundChannelEvent(payload: {
    eventId: string
    channelId: string
    thread: string
    sender: string
    text: string
    attachments: ChannelAttachment[]
  }): void {
    const key = `${payload.channelId}::${payload.thread}`
    const pending = this.pendingInboundChannels.get(key) || {
      channelId: payload.channelId,
      thread: payload.thread,
      sender: payload.sender,
      eventIds: [],
      texts: [],
      attachments: [],
      timer: null as NodeJS.Timeout | null
    }

    if (!pending.eventIds.includes(payload.eventId)) {
      pending.eventIds.push(payload.eventId)
      this.db.upsertAgentChannelEvent({
        eventId: payload.eventId,
        channelId: payload.channelId,
        status: 'running'
      })
    }
    if (payload.text) pending.texts.push(payload.text)
    if (payload.attachments.length > 0) {
      const seen = new Set(
        pending.attachments.map((item) => `${item.remoteId || item.path}::${item.name}`)
      )
      for (const attachment of payload.attachments) {
        const dedupeKey = `${attachment.remoteId || attachment.path}::${attachment.name}`
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)
        pending.attachments.push(attachment)
      }
    }
    pending.sender = payload.sender || pending.sender
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = setTimeout(() => {
      void this.flushInboundChannel(key)
    }, this.getInboundCoalesceWindowMs())
    this.pendingInboundChannels.set(key, pending)
  }

  private markInboundChannelEvents(
    eventIds: string[],
    channelId: string,
    status: 'running' | 'done' | 'failed',
    error?: string | null
  ): void {
    for (const eventId of eventIds) {
      this.db.upsertAgentChannelEvent({
        eventId,
        channelId,
        status,
        error: error || null
      })
    }
  }

  private async flushInboundChannel(key: string): Promise<void> {
    const pending = this.pendingInboundChannels.get(key)
    if (!pending) return
    this.pendingInboundChannels.delete(key)
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
    }

    const mergedText = pending.texts
      .map((item) => item.trim())
      .filter(Boolean)
      .join('\n')
      .trim()
    const inboundText = mergedText || this.describeChannelAttachments(pending.attachments)
    if (!inboundText && pending.attachments.length === 0) {
      this.markInboundChannelEvents(pending.eventIds, pending.channelId, 'done', null)
      return
    }

    const agent = 'butler'
    const scope = this.ensureChannelScope(pending.channelId, pending.thread, agent, pending.sender)
    this.db.upsertAgentChannelThread({
      channelId: pending.channelId,
      remoteThread: pending.thread,
      sessionId: scope.id,
      conversationId: scope.id
    })

    const inboundMessage = this.createConversationMessage(scope.id, {
      role: 'user',
      content: inboundText,
      meta: {
        source: 'channel',
        channelId: pending.channelId,
        threadKey: pending.thread,
        sender: pending.sender,
        direction: 'inbound',
        attachments: pending.attachments
      }
    })
    this.emitConversationEvent({
      type: 'message_added',
      scope: this.refreshScope(scope.id),
      message: inboundMessage
    })

    if (!mergedText) {
      this.markInboundChannelEvents(pending.eventIds, pending.channelId, 'done', null)
      return
    }

    let statusSent = false
    const statusTimer = setTimeout(() => {
      void this.sidecar
        .sendChannel({
          id: pending.channelId,
          thread: pending.thread,
          text: '处理中…'
        })
        .then(() => {
          statusSent = true
        })
        .catch(() => undefined)
    }, 2500)

    const promptPayload = this.buildInboundChannelPayload(inboundText, pending.attachments)
    const requestId = `channel-${pending.eventIds[pending.eventIds.length - 1]}`
    const result = await this.runCoordinator.runInboundChannel(
      {
        scope,
        message: promptPayload as
          | string
          | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>,
        requestId
      },
      {
        onFailure: async (errorText) => {
          clearTimeout(statusTimer)
          this.markInboundChannelEvents(pending.eventIds, pending.channelId, 'failed', errorText)
          const errorMessage = this.createConversationMessage(scope.id, {
            role: 'system',
            content: `处理失败：${errorText}`,
            meta: {
              source: 'channel',
              channelId: pending.channelId,
              threadKey: pending.thread,
              direction: 'outbound',
              error: true
            }
          })
          this.emitConversationEvent({
            type: 'message_added',
            scope: this.refreshScope(scope.id),
            message: errorMessage
          })
          await this.sendLongTextToChannel(
            pending.channelId,
            pending.thread,
            `处理失败：${errorText}`
          ).catch(() => undefined)
        },
        onSuccess: async (executionResult) => {
          clearTimeout(statusTimer)
          const finalText =
            executionResult.finalText.trim() || '任务已完成，但本次没有产生可发送的文本结果。'
          const assistantMessage = this.createConversationMessage(scope.id, {
            role: 'assistant',
            content: finalText,
            meta: {
              source: 'channel',
              channelId: pending.channelId,
              threadKey: pending.thread,
              sender: agent,
              direction: 'outbound',
              delayedStatusSent: statusSent
            }
          })
          this.markInboundChannelEvents(pending.eventIds, pending.channelId, 'done', null)
          this.db.markAgentChannelSeen(pending.channelId)
          this.emitConversationEvent({
            type: 'message_added',
            scope: this.refreshScope(scope.id),
            message: assistantMessage
          })
          await this.sendLongTextToChannel(pending.channelId, pending.thread, finalText).catch(
            () => undefined
          )
        }
      }
    )
    clearTimeout(statusTimer)
    if (!result.success) return
  }

  private mapChannelRow(row: AgentChannelRecord): AgentChannelConfig {
    return {
      id: row.id,
      type: row.type as ChannelAdapterType,
      name: row.name,
      enabled: Boolean(row.enabled),
      config: decryptChannelConfig(this.tryParseJson<Record<string, unknown>>(row.config_json, {})),
      lastError: row.last_error,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private mapScheduleRow(row: AgentScheduleRecord): CronTask {
    return {
      id: row.id,
      name: row.name,
      cronExpr: row.cron_expr,
      prompt: row.prompt,
      channelId: row.channel_id,
      enabled: Boolean(row.enabled),
      payload: this.tryParseJson<Record<string, unknown>>(row.payload_json || '{}', {}),
      lastRunAt: row.last_run_at,
      nextRunAt: row.next_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private mapConversationRow(
    row: ChatConversationRecord & { last_message_at?: string | null }
  ): ConversationScope {
    return {
      id: row.id,
      agent: row.agent,
      userId: row.user_id || undefined,
      title: row.title,
      parentConversationId: row.parent_conversation_id ?? null,
      lineageRootId: row.lineage_root_id || row.id,
      resumeTitle: row.resume_title || row.title,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      threadKey: row.thread_key,
      meta: this.tryParseJson<Record<string, unknown>>(row.meta_json || '{}', {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMessageAt: row.last_message_at ?? null
    }
  }

  private mapMessageRow(row: ChatMessageRecord): ConversationScopeMessage {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      meta: this.tryParseJson<Record<string, unknown>>(row.meta_json || '{}', {})
    }
  }

  private ensureChannelScope(
    channelId: string,
    remoteThread: string,
    agent: string,
    sender: string
  ): ConversationScope {
    const channel = this.db.getAgentChannel(channelId)
    const channelMeta = channel ? this.mapChannelRow(channel) : null
    const existing = this.db.findConversationScope('channel', channelId, remoteThread, agent)
    const row = this.db.upsertConversationScope({
      id: existing?.id || `conv-${randomUUID()}`,
      agent,
      title: existing?.title || sender || channelMeta?.name || '远程会话',
      sourceKind: 'channel',
      sourceId: channelId,
      threadKey: remoteThread,
      meta: {
        ...(existing
          ? this.tryParseJson<Record<string, unknown>>(existing.meta_json || '{}', {})
          : {}),
        sourceLabel: channelMeta?.name || '远程 IM',
        channelType: channelMeta?.type || 'generic-webhook',
        sender
      }
    })
    const scope = this.mapConversationRow(row)
    // Phase 1.2 — recover any persisted lastReferenceSkill into the in-memory
    // map before the inbound message hits the orchestrator. Without this, a
    // Ready restart loses the hint until the user manually re-arms it; the
    // first remote IM turn after restart goes out with `referenceSkillHintArmed=false`
    // and the model loses access to typed skill actions. Idempotent: replay
    // checks TTL and same-value short-circuits.
    this.restoreReferenceHintFromScope(scope, scope.id)
    this.emitConversationEvent({
      type: existing ? 'scope_updated' : 'scope_created',
      scope
    })
    return scope
  }

  private refreshScope(scopeId: string): ConversationScope {
    const row = this.db.getConversationScope(scopeId)
    if (!row) throw new Error(`Conversation scope not found: ${scopeId}`)
    return this.mapConversationRow(row)
  }

  private createConversationMessage(
    scopeId: string,
    payload: {
      role: string
      content: string
      meta?: Record<string, unknown>
    }
  ): ConversationScopeMessage {
    const messageId = `msg-${randomUUID()}`
    const timestamp = new Date().toISOString()
    this.db.addChatMessage(
      messageId,
      scopeId,
      payload.role,
      payload.content,
      timestamp,
      payload.meta
    )
    // skill-resume A1: snapshot reference-skill hint after each assistant
    // message and persist it to the conversation's meta_json so a Ready
    // restart can re-arm the in-memory hint on session resume.
    if (payload.role === 'assistant') {
      this.persistReferenceHintToScope(scopeId)
    }
    return this.mapMessageRow(this.db.getChatMessages(scopeId).find((row) => row.id === messageId)!)
  }

  // ---------------------------------------------------------------------------
  // skill-resume A1: reference-skill hint persistence helpers
  // ---------------------------------------------------------------------------

  private parseScopeMeta(scope: ConversationScope | null | undefined): Record<string, unknown> {
    const raw = (scope?.meta as unknown as string | Record<string, unknown> | null | undefined)
    if (!raw) return {}
    if (typeof raw === 'object') return { ...raw } as Record<string, unknown>
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === 'object') return { ...(parsed as Record<string, unknown>) }
        // Phase 1.4 — JSON parsed but produced something that's not a record
        // (string/array/number/null). Surface this so silent meta loss has a
        // signal in the metrics log.
        logAgentMetric(TOOL_ERROR_METRICS.metaParseCorrupted, {
          scopeId: scope?.id || null,
          reason: 'not_object',
          sample: raw.slice(0, 80),
        })
      } catch (error) {
        // Phase 1.4 — JSON.parse threw. Previously the catch swallowed the
        // error and returned {}, so corruption silently nuked any
        // `lastReferenceSkill` field at the next read. Emit a metric instead.
        logAgentMetric(TOOL_ERROR_METRICS.metaParseCorrupted, {
          scopeId: scope?.id || null,
          reason: 'parse_error',
          message: error instanceof Error ? error.message : String(error),
          sample: raw.slice(0, 80),
        })
      }
    }
    return {}
  }

  private restoreReferenceHintFromScope(scope: ConversationScope, scopeId: string): void {
    try {
      const meta = this.parseScopeMeta(scope)
      const hint = meta['lastReferenceSkill']
      if (!hint || typeof hint !== 'object') return
      const persisted = hint as PersistedReferenceSkillHint
      if (typeof persisted.id !== 'string' || typeof persisted.name !== 'string' || typeof persisted.at !== 'number') return
      restoreLastReferenceSkill(scopeId, persisted)
    } catch (error) {
      console.warn('[AgentControlRuntime] restoreReferenceHintFromScope failed', error)
    }
  }

  private extractTextFromMessage(message: string | MultimodalBlock[]): string {
    if (typeof message === 'string') return message
    if (!Array.isArray(message)) return ''
    return message
      .map((block) => {
        if (!block || typeof block !== 'object') return ''
        if (typeof (block as { text?: unknown }).text === 'string') {
          return (block as { text?: string }).text || ''
        }
        return ''
      })
      .filter(Boolean)
      .join(' ')
  }

  private maybeAutoAttachSessionRecallOnResume(
    scopeId: string,
    message: string | MultimodalBlock[],
  ): void {
    try {
      const text = this.extractTextFromMessage(message)
      if (!text || !isRetryOnlyTurn(text)) return
      const result = this.sessionRecallService.autoAttachOnResume({
        currentScopeId: scopeId,
        intent: 'continue',
        limit: 3,
      })
      if (result.attached.length > 0) {
        logAgentMetric('session_recall_auto_attached', {
          scopeId,
          attachedCount: result.attached.length,
          attachedConversationIds: result.attached.map((c) => c.conversationId),
        })
        // skill-resume G4 — last-recourse hint recovery for OLD conversations.
        // If neither the meta_json restore nor the in-process lookback armed a
        // hint, scan the just-attached capsule texts for canonical skill_*
        // tool names. This is the only signal we have about prior skill usage
        // when the conversation predates A1 persistence.
        if (!getLastReferenceSkill(scopeId)) {
          this.maybeArmReferenceHintFromCapsules(scopeId, result.attached)
        }
      }
    } catch (error) {
      console.warn('[AgentControlRuntime] maybeAutoAttachSessionRecallOnResume failed', error)
    }
  }

  private maybeArmReferenceHintFromCapsules(
    scopeId: string,
    capsules: Array<{
      summary?: string | null
      latestTaskTitle?: string | null
      latestTaskSummary?: string | null
      title?: string | null
      resumeTitle?: string | null
    }>,
  ): void {
    try {
      const texts: string[] = []
      for (const capsule of capsules) {
        if (typeof capsule.summary === 'string') texts.push(capsule.summary)
        if (typeof capsule.latestTaskSummary === 'string') texts.push(capsule.latestTaskSummary)
        if (typeof capsule.latestTaskTitle === 'string') texts.push(capsule.latestTaskTitle)
        if (typeof capsule.title === 'string') texts.push(capsule.title)
        if (typeof capsule.resumeTitle === 'string') texts.push(capsule.resumeTitle)
      }
      const recovered = findSkillHintInCapsuleTexts(texts, {
        resolveToolByName: (name) => findSkillToolByName(name),
        listSkills: () => getSkillsRuntimeManager().listSkills(),
      })
      if (!recovered) return
      rememberLastReferenceSkill(scopeId, { id: recovered.skillId, name: recovered.skillName })
      logAgentMetric('skill_reference_hint_recovered_from_capsule', {
        scopeId,
        skillId: recovered.skillId,
        skillName: recovered.skillName,
      })
    } catch (error) {
      console.warn('[AgentControlRuntime] maybeArmReferenceHintFromCapsules failed', error)
    }
  }

  private persistReferenceHintToScope(scopeId: string): void {
    try {
      const hint = snapshotLastReferenceSkill(scopeId)
      if (!hint) return
      const scopeRow = this.db.getConversationScope(scopeId)
      if (!scopeRow) return
      const scope = this.mapConversationRow(scopeRow)
      const meta = this.parseScopeMeta(scope)
      const existing = meta['lastReferenceSkill'] as PersistedReferenceSkillHint | undefined
      // Avoid noisy DB writes: skip if persisted hint is identical (same id+name+at).
      if (
        existing
        && existing.id === hint.id
        && existing.name === hint.name
        && existing.at === hint.at
      ) {
        return
      }
      meta['lastReferenceSkill'] = hint
      this.db.updateConversationScopeMeta(scopeId, meta)
    } catch (error) {
      console.warn('[AgentControlRuntime] persistReferenceHintToScope failed', error)
    }
  }

  private publishRestoredDetachedSkillTasks(): void {
    for (const record of this.detachedSkillTasks.list()) {
      if (record.status === 'blocked' || record.status === 'running') {
        this.publishDetachedSkillTaskUpdate(record)
      }
    }
  }

  private buildDetachedSkillArtifacts(record: DetachedSkillTaskRecord): NonNullable<ScopeRunEventPayload['artifactRefs']> {
    const nowIso = record.updatedAt
    const entries: Array<{ key: string; path?: string | null; label: string; kind: string }> = [
      { key: 'outputDir', path: record.outputDir, label: '技能输出目录', kind: 'directory' },
      { key: 'runStatePath', path: record.runStatePath, label: 'run_state.json', kind: 'artifact' },
      { key: 'sceneScoresPath', path: record.sceneScoresPath, label: 'scene_scores.json', kind: 'artifact' },
      { key: 'deliveryReportPath', path: record.deliveryReportPath, label: '交付报告', kind: 'artifact' },
    ]
    const seen = new Set<string>()
    return entries
      .filter((entry) => {
        const path = String(entry.path || '').trim()
        if (!path || seen.has(path)) return false
        seen.add(path)
        return true
      })
      .map((entry) => ({
        id: `${record.id}:${entry.key}`,
        module: 'skill',
        kind: entry.kind,
        label: entry.label,
        path: entry.path || null,
        createdAt: nowIso,
        meta: {
          detachedTaskId: record.id,
          skillId: record.skillId,
          action: record.action,
          outputKey: entry.key,
        },
      }))
  }

  private publishDetachedSkillTaskUpdate(record: DetachedSkillTaskRecord): void {
    const scopeId = record.scopeId || record.sessionId
    if (!scopeId) return
    const phase: ScopeRunEventPayload['phase'] =
      record.status === 'running' ? 'tool_running'
        : record.status === 'done' ? 'done'
          : record.status === 'cancelled' ? 'cancelled'
            : record.status === 'blocked' ? 'checkpoint'
              : 'error'
    const stepStatus =
      record.status === 'running' ? 'running'
        : record.status === 'done' ? 'done'
          : record.status === 'blocked' ? 'blocked'
            : 'error'
    const artifacts = this.buildDetachedSkillArtifacts(record)
    const taskId = `detached:${record.id}`
    const summary =
      record.status === 'running' ? '后台技能任务正在执行'
        : record.status === 'done' ? '后台技能任务已完成'
          : record.status === 'blocked' ? (record.error || '后台技能任务需要继续')
            : record.status === 'cancelled' ? '后台技能任务已取消'
              : (record.error || '后台技能任务失败')
    this.publishScopeRunEvent({
      type: record.status === 'running' ? 'started' : record.status === 'blocked' ? 'updated' : 'finished',
      scopeId,
      agent: record.agent || 'assistant',
      runId: record.id,
      taskId,
      taskProjectionId: taskId,
      phase,
      module: 'skill',
      executionKind: 'job',
      jobId: record.id,
      taskTitle: `后台技能任务 · ${record.skillId}`,
      taskSummary: summary,
      steps: [{
        id: record.action,
        title: record.action,
        status: stepStatus,
        detail: record.error || record.outputDir || null,
        updatedAt: record.updatedAt,
      }],
      currentStepId: record.action,
      waitingFor: record.status === 'running' || record.status === 'blocked' ? 'background' : 'none',
      resumableActions: record.status === 'running'
        ? ['cancel']
        : record.status === 'blocked'
          ? ['continue', 'cancel']
          : artifacts.length > 0
            ? ['open_artifact']
            : ['none'],
      recentArtifacts: artifacts,
      artifactRefs: artifacts,
      blockedReason: record.status === 'blocked' ? record.error || '后台任务需要继续' : null,
      error: record.status === 'failed' ? record.error || '后台技能任务失败' : undefined,
      timestamp: record.updatedAt,
    })
  }

  private emitConversationEvent(payload: ConversationEventPayload): void {
    this.emit('conversationEvent', payload)
  }

  private emitScopeRunEvent(payload: ScopeRunEventPayload, projectionTruth?: ProjectionTruthSnapshot | null): void {
    this.recordScopeRunEvent(payload, projectionTruth)
    this.emit('scopeRunEvent', payload)
  }

  publishScopeRunEvent(payload: ScopeRunEventPayload, projectionTruth?: ProjectionTruthSnapshot | null): void {
    this.emitScopeRunEvent(payload, projectionTruth)
  }

  recordScopeRunEvent(payload: ScopeRunEventPayload, projectionTruth?: ProjectionTruthSnapshot | null): ScopeRunSummary | null {
    const summary = this.recordRunProjectionEvent(payload, projectionTruth)
    if (summary) {
      void syncTaskProjection(this.taskProjectionStore, summary, payload, projectionTruth).catch((error) => {
        console.error('[AgentControlRuntime] Failed to sync task projection:', error)
      })
    }
    return summary
  }

  private recordRunProjectionEvent(payload: ScopeRunEventPayload, projectionTruth?: ProjectionTruthSnapshot | null): ScopeRunSummary | null {
    return this.runProjection.recordEvent(payload, projectionTruth)
  }

  private resolveTaskControlTarget(
    scopeId: string,
    taskId?: string,
  ): {
    scope: ConversationScope
    projection: TaskProjectionRecord | null
    scopeRunSummary: ScopeRunSummary | null
  } | null {
    const scope = this.getConversationScope(scopeId)
    if (!scope) return null
    const scopeRunSummary = this.scopeRunSummaries.get(scopeId) || null
    if (taskId) {
      return {
        scope,
        projection: this.getTaskProjection(taskId),
        scopeRunSummary,
      }
    }

    const projections = this.listTaskProjections(scopeId)
    const matchedProjection = [
      scopeRunSummary?.taskId || null,
      scopeRunSummary?.taskContinuation?.taskId || null,
    ]
      .filter(Boolean)
      .map((candidateTaskId) => this.getTaskProjection(candidateTaskId as string))
      .find((item) => Boolean(item)) || null
    const activeProjection = projections.find((item) =>
      item.status === 'running' || item.status === 'blocked' || item.interactionState === 'resuming',
    ) || null

    return {
      scope,
      projection: matchedProjection || activeProjection || projections[0] || null,
      scopeRunSummary,
    }
  }

  private buildContinuationIntent(params: {
    projection: TaskProjectionRecord | null
    scopeRunSummary: ScopeRunSummary | null
    incoming?: ContinuationIntent | null
    responseText?: string
  }): ContinuationIntent | null {
    const incoming = normalizeContinuationIntent(params.incoming || null)
    const taskId =
      params.projection?.taskId
      || params.scopeRunSummary?.taskId
      || params.scopeRunSummary?.taskContinuation?.taskId
      || incoming?.taskId
      || null
    if (!taskId) return null

    const continuationRef = params.projection?.continuationRef || params.scopeRunSummary?.taskContinuation || null
    return normalizeContinuationIntent({
      taskId,
      executionId: incoming?.executionId || continuationRef?.executionId || undefined,
      stepId:
        incoming?.stepId
        || continuationRef?.stepId
        || params.projection?.currentStepId
        || params.scopeRunSummary?.currentStepId
        || undefined,
      blockedReason:
        incoming?.blockedReason
        || params.projection?.blockedReason
        || params.scopeRunSummary?.blockedReason
        || undefined,
      responseText: params.responseText || incoming?.responseText,
      todoId: incoming?.todoId || continuationRef?.todoId || undefined,
      todoTitle: incoming?.todoTitle || continuationRef?.todoTitle || undefined,
      pauseReason: incoming?.pauseReason || continuationRef?.pauseReason || undefined,
      detachedTaskId: incoming?.detachedTaskId || continuationRef?.detachedTaskId || undefined,
      taskRunId: incoming?.taskRunId || continuationRef?.taskRunId || undefined,
      jobId: incoming?.jobId || continuationRef?.jobId || undefined,
      skillId: incoming?.skillId || continuationRef?.skillId || undefined,
      action: incoming?.action || continuationRef?.action || undefined,
      runStatePath: incoming?.runStatePath || continuationRef?.runStatePath || undefined,
      outputDir: incoming?.outputDir || continuationRef?.outputDir || undefined,
      progressFingerprint: incoming?.progressFingerprint || continuationRef?.progressFingerprint || undefined,
    })
  }

  private parseChannelAttachments(raw: unknown): ChannelAttachment[] {
    if (!Array.isArray(raw)) return []
    return raw
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const record = item as Record<string, unknown>
        const name = String(record.name || '').trim()
        const path = String(record.path || '').trim()
        if (!name || !path) return null
        return {
          name,
          path,
          url: typeof record.url === 'string' ? record.url : undefined,
          mimeType: typeof record.mimeType === 'string' ? record.mimeType : undefined,
          size: Number(record.size || 0),
          type: ['image', 'video', 'text', 'spreadsheet', 'other'].includes(
            String(record.type || '')
          )
            ? (String(record.type) as ChannelAttachment['type'])
            : 'other',
          ext: typeof record.ext === 'string' ? record.ext : undefined,
          remoteId: typeof record.remoteId === 'string' ? record.remoteId : undefined
        }
      })
      .filter(Boolean) as ChannelAttachment[]
  }

  private describeChannelAttachments(attachments: ChannelAttachment[]): string {
    if (attachments.length === 0) return ''
    if (attachments.length === 1) {
      const item = attachments[0]
      const kind =
        item.type === 'image'
          ? '图片'
          : item.type === 'video'
            ? '视频'
            : item.type === 'text'
              ? '文件'
              : '附件'
      return `[收到${kind}] ${item.name}`
    }
    return `[收到 ${attachments.length} 个附件]`
  }

  private formatChannelAttachmentSummary(attachments: ChannelAttachment[]): string {
    if (attachments.length === 0) return ''
    const lines = attachments.map((attachment) => {
      const kind =
        attachment.type === 'image'
          ? '图片'
          : attachment.type === 'video'
            ? '视频'
            : attachment.type === 'text'
              ? '文件'
              : '附件'
      return `- ${kind}: ${attachment.name}`
    })
    return ['[附件]', ...lines].join('\n')
  }

  private buildInboundChannelPayload(
    inboundText: string,
    attachments: ChannelAttachment[]
  ): string | MultimodalBlock[] {
    if (attachments.length === 0) return inboundText

    const blocks: MultimodalBlock[] = []
    if (inboundText) {
      blocks.push({ type: 'text', text: inboundText })
    }

    const nonInlineAttachments: ChannelAttachment[] = []
    for (const attachment of attachments) {
      const mediaBlock = this.tryInlineChannelAttachment(attachment)
      if (mediaBlock) {
        blocks.push(mediaBlock)
      } else {
        nonInlineAttachments.push(attachment)
      }
    }

    const summary = this.formatChannelAttachmentSummary(nonInlineAttachments)
    if (summary) {
      blocks.push({ type: 'text', text: `\n\n${summary}` })
    }

    const hasMediaBlocks = blocks.some((item) => item.type === 'image' || item.type === 'video')
    if (hasMediaBlocks) return blocks
    return [inboundText, this.formatChannelAttachmentSummary(attachments)]
      .filter(Boolean)
      .join('\n\n')
  }

  private tryInlineChannelAttachment(attachment: ChannelAttachment): MultimodalBlock | null {
    const filePath = typeof attachment.path === 'string' ? attachment.path : ''
    if (!filePath || !isAbsolute(filePath) || !existsSync(filePath)) {
      return null
    }

    const ext = (attachment.ext || extname(filePath)).toLowerCase()
    const declaredType = String(attachment.type || '').toLowerCase()
    const stat = statSync(filePath)

    if (
      declaredType === 'video' ||
      ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'].includes(ext)
    ) {
      if (stat.size > 40 * 1024 * 1024) return null
      return {
        type: 'video',
        base64: readFileSync(filePath).toString('base64'),
        mimeType: attachment.mimeType || this.mimeTypeFromExt(ext, 'video/mp4')
      }
    }

    if (
      declaredType === 'image' ||
      [
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.webp',
        '.bmp',
        '.svg',
        '.tiff',
        '.tif',
        '.ico',
        '.avif'
      ].includes(ext)
    ) {
      return {
        type: 'image',
        base64: readFileSync(filePath).toString('base64'),
        mimeType: attachment.mimeType || this.mimeTypeFromExt(ext, 'image/png')
      }
    }

    return null
  }

  private mimeTypeFromExt(ext: string, fallback: string): string {
    const table: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
      '.tiff': 'image/tiff',
      '.tif': 'image/tiff',
      '.ico': 'image/x-icon',
      '.avif': 'image/avif',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo',
      '.m4v': 'video/x-m4v'
    }
    return table[ext] || fallback
  }

  private splitLongText(text: string, maxChars = 1800): string[] {
    const normalized = text.trim()
    if (!normalized) return []
    const chunks: string[] = []
    let cursor = 0
    while (cursor < normalized.length) {
      const next = normalized.slice(cursor, cursor + maxChars)
      chunks.push(next)
      cursor += next.length
    }
    return chunks
  }

  private async sendLongTextToChannel(
    channelId: string,
    thread: string,
    text: string
  ): Promise<{ success: boolean; error?: string }> {
    for (const chunk of this.splitLongText(text)) {
      const result = await this.sidecar
        .sendChannel({
          id: channelId,
          thread,
          text: chunk
        })
        .then(() => ({ success: true as const }))
        .catch((error) => ({
          success: false as const,
          error: error instanceof Error ? error.message : String(error)
        }))
      if (!result.success) {
        return result
      }
    }
    return { success: true }
  }

  private tryParseJson<T>(raw: string, fallback: T): T {
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  private getSettingBool(key: string, fallback: boolean): boolean {
    const raw = this.db.getSetting(key)
    if (!raw) return fallback
    const normalized = raw.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
    return fallback
  }

  private parsePortSetting(raw: string | undefined): number | null {
    if (!raw) return null
    const trimmed = raw.trim().toLowerCase()
    if (!trimmed || trimmed === 'auto') return null
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) return null
    const port = Math.floor(parsed)
    if (port <= 0 || port > 65535) return null
    return port
  }

  private cleanupLegacyCopawSettings(): void {
    const keys = [
      'agent_orchestrator',
      'copaw_base_url',
      'copaw_api_token',
      'copaw_user_id',
      'copaw_channel'
    ]
    for (const key of keys) {
      try {
        this.db.deleteSetting(key)
      } catch {
        // ignore cleanup failures
      }
    }
  }

  /**
   * Reflect on a completed conversation and extract learnings
   */
  private async reflectOnConversation(
    scope: ConversationScope,
    usedTools: string[]
  ): Promise<ScopeRunMemoryCapture | null> {
    try {
      // Get conversation messages
      const messages = this.db.getChatMessages(scope.id).map((msg) => ({
        role: msg.role,
        content: msg.content
      }))

      // Skip reflection for very short conversations
      if (messages.length < 2) {
        return null
      }

      // Run reflection
      const result = await this.reflectionService.reflectOnConversation({
        scope,
        messages,
        usedTools,
        success: true
      })
      return result.memoryCapture || null
    } catch (error) {
      console.error('[Runtime] Failed to reflect on conversation:', error)
      return null
    }
  }

  private toChannelKey(scope: ConversationScope): string {
    const sourceId = scope.sourceKind === 'local' ? 'app' : scope.sourceId
    return `${scope.sourceKind}:${sourceId}`
  }
}
