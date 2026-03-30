import { app } from 'electron'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { extname, isAbsolute, join } from 'path'
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
import { SidecarManager } from './sidecar-manager'
import { MemoryRepository } from '../repositories/memory-repository'
import { MemoryLifecycleManager } from './memory-lifecycle'
import { ReflectionService } from './reflection-service'
import { UserProfileRepository } from '../repositories/user-profile-repository'
import { AgentPersonalityRepository } from '../repositories/agent-personality-repository'
import { decryptChannelConfig, encryptChannelConfig } from './secret-storage'
import { ToolGateway } from './tool-gateway'
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
  ScopeRunSummary,
  ScopeRunTaskContinuation,
  ScopeRunTaskStep,
} from './types'

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
  private readonly sidecar = new SidecarManager()
  private readonly orchestrator: ClaudeSdkOrchestrator
  private readonly toolGateway = new ToolGateway()
  private readonly memoryRepository = new MemoryRepository()
  private readonly memoryLifecycle = new MemoryLifecycleManager(this.memoryRepository)
  private readonly userProfileRepository = new UserProfileRepository()
  private readonly agentPersonalityRepository = new AgentPersonalityRepository()
  private readonly reflectionService = new ReflectionService({
    memoryRepository: this.memoryRepository,
    userProfileRepository: this.userProfileRepository,
    knowledgeRepository: {
      set: async (key: string, value: string) => {
        const rawDb = this.db.getRawDb()
        if (!rawDb) throw new Error('Database not available')
        rawDb.prepare(`
          INSERT INTO agent_knowledge (id, agent_name, key, value, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(agent_name, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(
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
        const row = rawDb.prepare(`
          SELECT value FROM agent_knowledge WHERE agent_name = 'system' AND key = ?
        `).get(key) as { value: string } | undefined
        return row?.value || null
      },
    },
  })
  private readonly promptAssembly = new PromptAssemblyService({
    getMemoryRoot: () => join(app.getPath('userData'), 'agent-memory'),
    memoryRepository: this.memoryRepository,
    userProfileRepository: this.userProfileRepository,
    agentPersonalityRepository: this.agentPersonalityRepository,
    enableDatabaseMemory: true,
  })
  private readonly agentManager: AgentManager
  private readonly pendingInboundChannels = new Map<string, {
    channelId: string
    thread: string
    sender: string
    eventIds: string[]
    texts: string[]
    attachments: ChannelAttachment[]
    timer: NodeJS.Timeout | null
  }>()
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
      lastBeatAt: new Date().toISOString(),
    },
  }

  constructor(agentManager: AgentManager, browserController?: BrowserController) {
    super()
    this.agentManager = agentManager
    this.orchestrator = new ClaudeSdkOrchestrator({
      browserController,
      sidecarManager: this.sidecar,
    })
    this.orchestrator.setRuntime(this)
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

  async start(): Promise<void> {
    this.cleanupLegacyCopawSettings()

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

    await this.sidecar.stop()
  }

  async startSidecar(): Promise<void> {
    const status = await this.sidecar.start()
    this.heartbeat.sidecar = {
      status: status.state,
      pid: status.pid || undefined,
      port: status.port || undefined,
      lastBeatAt: status.lastHeartbeatAt || undefined,
      error: status.error || undefined,
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
      error: sidecarStatus.error || undefined,
    }
    this.heartbeat.orchestrator = {
      healthy: true,
      activeTasks: this.orchestrator.getSessionManager().getActiveCount(),
      lastBeatAt: new Date().toISOString(),
    }
    this.heartbeat.toolGateway = {
      healthy: true,
      availableTools: this.toolGateway.count(),
      lastBeatAt: new Date().toISOString(),
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
        byType,
      },
      schedules: {
        total: schedules.length,
        enabled: schedules.filter((item) => item.enabled).length,
      },
      heartbeat: this.heartbeat,
    }
  }

  listChannels(): AgentChannelConfig[] {
    const rows = this.db.listAgentChannels()
    return rows.map((row) => this.mapChannelRow(row))
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
    const limit = Number.isFinite(Number(payload?.limit)) ? Math.max(1, Math.min(100, Number(payload?.limit))) : 20
    return Array.from(this.scopeRunSummaries.values())
      .filter((item) => (channelKey ? item.channelKey === channelKey : true))
      .filter((item) => (statuses ? statuses.has(item.phase) : true))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, limit)
  }

  getConversationScope(scopeId: string): ConversationScope | null {
    const row = this.db.getConversationScope(scopeId)
    return row ? this.mapConversationRow(row) : null
  }

  getConversationScopeMessages(scopeId: string): ConversationScopeMessage[] {
    return this.db.getChatMessages(scopeId).map((row) => this.mapMessageRow(row))
  }

  listScopeAttachments(scopeId: string): ConversationAttachment[] {
    return this.db.listConversationAttachments(scopeId)
      .filter((item) => item.path && existsSync(item.path))
      .map((item) => ({
        attachmentId: item.attachment_id,
        scopeId: item.conversation_id,
        sourceMessageId: item.source_message_id,
        name: item.name,
        path: item.path,
        type: ['image', 'video', 'text', 'spreadsheet', 'other'].includes(String(item.type))
          ? item.type as ConversationAttachment['type']
          : 'other',
        size: item.size,
        ext: item.ext,
        url: item.url,
        mimeType: item.mime_type,
        remoteId: item.remote_id,
        channelId: item.channel_id,
        threadKey: item.thread_key,
        createdAt: item.created_at,
      }))
  }

  getScopeAttachment(scopeId: string, attachmentId: string): ConversationAttachment | null {
    return this.listScopeAttachments(scopeId).find((item) => item.attachmentId === attachmentId) || null
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
        const nextChannelId = currentChannelId || (!channelId && currentPath === basePath ? entry : currentChannelId)
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
        bytes: value.bytes,
      })),
    }
  }

  clearRemoteAttachmentCache(channelId?: string): { removedFiles: number; removedBytes: number; targetPath: string } {
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

  createLocalScope(agent: string): ConversationScope {
    const id = `conv-${randomUUID()}`
    const row = this.db.upsertConversationScope({
      id,
      agent,
      title: '新对话',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: id,
      meta: { sourceLabel: '应用内', createdBy: 'app' },
    })
    const scope = this.mapConversationRow(row)
    this.emitConversationEvent({ type: 'scope_created', scope })
    return scope
  }

  async sendScoped(payload: {
    scopeId: string
    message: string | MultimodalBlock[]
    requestId?: string
  }): Promise<{ success: boolean; error?: string }> {
    const scopeRow = this.db.getConversationScope(payload.scopeId)
    if (!scopeRow) {
      return { success: false, error: `Conversation scope not found: ${payload.scopeId}` }
    }
    const scope = this.mapConversationRow(scopeRow)
    const promptAssembly = await this.promptAssembly.buildForScopedRun({
      scope,
      message: payload.message as string | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>,
    })
    const messageWithBootstrap = this.promptAssembly.applyToMessage(
      payload.message as string | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>,
      promptAssembly,
    ) as string | MultimodalBlock[]
    this.emitScopeRunEvent({
      type: 'started',
      scopeId: scope.id,
      agent: scope.agent,
      runId: payload.requestId,
      phase: 'planning',
      module: promptAssembly.triggerHits[0]?.module,
      latestText: 'Prompt assembly ready',
      memoryRefs: promptAssembly.memoryRefs,
      triggerHits: promptAssembly.triggerHits,
      contextBudget: promptAssembly.contextBudget,
      timestamp: new Date().toISOString(),
    })
    const result = await this.orchestrator.sendAndCollect(
      scope.agent,
      messageWithBootstrap,
      scope.id,
      payload.requestId,
      promptAssembly.systemPrompt,
    )
    if (!result.success) {
      this.promptAssembly.recordRunOutcome({
        scope,
        finalText: result.finalText,
        usedTools: result.usedTools,
        success: false,
      })
      return { success: false, error: result.error || 'Agent execution failed' }
    }

    this.promptAssembly.recordRunOutcome({
      scope,
      finalText: result.finalText,
      usedTools: result.usedTools,
      success: true,
    })

    // Automatic reflection: extract facts and update memories
    // Run in background to avoid blocking the response
    this.reflectOnConversation(scope, result.usedTools)
      .then((memoryCapture) => {
        if (!memoryCapture || memoryCapture.items.length === 0) return
        this.emitScopeRunEvent({
          type: 'updated',
          scopeId: scope.id,
          agent: scope.agent,
          runId: payload.requestId,
          phase: 'done',
          taskSummary: `已记录 ${memoryCapture.items.length} 条长期记忆`,
          memoryCapture,
          timestamp: new Date().toISOString(),
        })
      })
      .catch((error) => {
        console.error('[Runtime] Reflection failed:', error)
      })

    if (scope.sourceKind === 'channel') {
      const outboundText = result.finalText.trim() || '任务已完成，但本次没有产生可发送的文本结果。'
      const sendOk = await this.sendLongTextToChannel(scope.sourceId, scope.threadKey, outboundText)
      if (!sendOk.success) {
        return { success: false, error: sendOk.error || 'Failed to send channel reply' }
      }
    }

    return { success: true }
  }

  async upsertChannel(payload: UpsertChannelPayload): Promise<AgentChannelConfig> {
    const id = payload.id || `channel-${randomUUID()}`
    const encryptedConfig = encryptChannelConfig(payload.config || {})
    const row = this.db.upsertAgentChannel({
      id,
      type: payload.type as AgentChannelType,
      name: payload.name.trim() || id,
      enabled: payload.enabled ?? true,
      configJson: JSON.stringify(encryptedConfig),
    })

    if (this.sidecar.isRunning()) {
      await this.sidecar.upsertChannel({
        id,
        type: row.type,
        name: row.name,
        enabled: Boolean(row.enabled),
        config: decryptChannelConfig(encryptedConfig),
      })
      if (Boolean(row.enabled)) {
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
        config: decryptChannelConfig(this.tryParseJson<Record<string, unknown>>(row.config_json, {})),
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
        text: text.trim() || 'Ready 连接测试成功',
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
        config: payload.config || {},
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
      payloadJson: payload.payload ? JSON.stringify(payload.payload) : null,
    })

    if (this.sidecar.isRunning()) {
      await this.sidecar.upsertSchedule({
        id,
        name: row.name,
        cronExpr: row.cron_expr,
        prompt: row.prompt,
        channelId: row.channel_id,
        enabled: Boolean(row.enabled),
        payload: payload.payload || {},
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
        config: channel.config,
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
        payload: schedule.payload || {},
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
        ? (heart as { adapters?: unknown[] }).adapters as Array<Record<string, unknown>>
        : []
      this.heartbeat.adapters = adapters.map((item) => ({
        id: String(item.id || ''),
        type: String(item.type || 'local-debug') as ChannelAdapterType,
        healthy: Boolean(item.healthy),
        status: typeof item.status === 'string'
          ? item.status as 'starting' | 'running' | 'stopped' | 'error'
          : undefined,
        lastBeatAt: typeof item.lastBeatAt === 'string' ? item.lastBeatAt : undefined,
        error: typeof item.error === 'string' ? item.error : undefined,
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
        .map((item) => item.id),
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

  private async executeSchedule(schedule: AgentScheduleRecord): Promise<{ success: boolean; error?: string }> {
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
      attachments,
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
      timer: null as NodeJS.Timeout | null,
    }

    if (!pending.eventIds.includes(payload.eventId)) {
      pending.eventIds.push(payload.eventId)
      this.db.upsertAgentChannelEvent({
        eventId: payload.eventId,
        channelId: payload.channelId,
        status: 'running',
      })
    }
    if (payload.text) pending.texts.push(payload.text)
    if (payload.attachments.length > 0) {
      const seen = new Set(pending.attachments.map((item) => `${item.remoteId || item.path}::${item.name}`))
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
    error?: string | null,
  ): void {
    for (const eventId of eventIds) {
      this.db.upsertAgentChannelEvent({
        eventId,
        channelId,
        status,
        error: error || null,
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
      conversationId: scope.id,
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
        attachments: pending.attachments,
      },
    })
    this.emitConversationEvent({
      type: 'message_added',
      scope: this.refreshScope(scope.id),
      message: inboundMessage,
    })

    if (!mergedText) {
      this.markInboundChannelEvents(pending.eventIds, pending.channelId, 'done', null)
      return
    }

    let statusSent = false
    const statusTimer = setTimeout(() => {
      void this.sidecar.sendChannel({
        id: pending.channelId,
        thread: pending.thread,
        text: '处理中…',
      }).then(() => {
        statusSent = true
      }).catch(() => undefined)
    }, 2500)

    const promptPayload = this.buildInboundChannelPayload(inboundText, pending.attachments)
    const requestId = `channel-${pending.eventIds[pending.eventIds.length - 1]}`
    const result = await this.orchestrator.sendAndCollect(agent, promptPayload, scope.id, requestId)
    clearTimeout(statusTimer)
    if (!result.success) {
      const err = result.error || 'Agent execution failed'
      this.markInboundChannelEvents(pending.eventIds, pending.channelId, 'failed', err)
      const errorMessage = this.createConversationMessage(scope.id, {
        role: 'system',
        content: `处理失败：${err}`,
        meta: {
          source: 'channel',
          channelId: pending.channelId,
          threadKey: pending.thread,
          direction: 'outbound',
          error: true,
        },
      })
      this.emitConversationEvent({
        type: 'message_added',
        scope: this.refreshScope(scope.id),
        message: errorMessage,
      })
      await this.sendLongTextToChannel(pending.channelId, pending.thread, `处理失败：${err}`).catch(() => undefined)
      return
    }

    const finalText = result.finalText.trim() || '任务已完成，但本次没有产生可发送的文本结果。'
    const assistantMessage = this.createConversationMessage(scope.id, {
      role: 'assistant',
      content: finalText,
      meta: {
        source: 'channel',
        channelId: pending.channelId,
        threadKey: pending.thread,
        sender: agent,
        direction: 'outbound',
        delayedStatusSent: statusSent,
      },
    })
    this.markInboundChannelEvents(pending.eventIds, pending.channelId, 'done', null)
    this.db.markAgentChannelSeen(pending.channelId)
    this.emitConversationEvent({
      type: 'message_added',
      scope: this.refreshScope(scope.id),
      message: assistantMessage,
    })
    await this.sendLongTextToChannel(pending.channelId, pending.thread, finalText).catch(() => undefined)

    // Automatic reflection: extract facts and update memories
    this.reflectOnConversation(scope, result.usedTools)
      .then((memoryCapture) => {
        if (!memoryCapture || memoryCapture.items.length === 0) return
        this.emitScopeRunEvent({
          type: 'updated',
          scopeId: scope.id,
          agent: scope.agent,
          runId: requestId,
          phase: 'done',
          taskSummary: `已记录 ${memoryCapture.items.length} 条长期记忆`,
          memoryCapture,
          timestamp: new Date().toISOString(),
        })
      })
      .catch((error) => {
        console.error('[Runtime] Channel reflection failed:', error)
      })
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
      updatedAt: row.updated_at,
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
      updatedAt: row.updated_at,
    }
  }

  private mapConversationRow(row: ChatConversationRecord & { last_message_at?: string | null }): ConversationScope {
    return {
      id: row.id,
      agent: row.agent,
      userId: row.user_id || undefined,
      title: row.title,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      threadKey: row.thread_key,
      meta: this.tryParseJson<Record<string, unknown>>(row.meta_json || '{}', {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMessageAt: row.last_message_at ?? null,
    }
  }

  private mapMessageRow(row: ChatMessageRecord): ConversationScopeMessage {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      meta: this.tryParseJson<Record<string, unknown>>(row.meta_json || '{}', {}),
    }
  }

  private ensureChannelScope(
    channelId: string,
    remoteThread: string,
    agent: string,
    sender: string,
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
        ...(existing ? this.tryParseJson<Record<string, unknown>>(existing.meta_json || '{}', {}) : {}),
        sourceLabel: channelMeta?.name || '远程 IM',
        channelType: channelMeta?.type || 'generic-webhook',
        sender,
      },
    })
    const scope = this.mapConversationRow(row)
    this.emitConversationEvent({
      type: existing ? 'scope_updated' : 'scope_created',
      scope,
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
    },
  ): ConversationScopeMessage {
    const messageId = `msg-${randomUUID()}`
    const timestamp = new Date().toISOString()
    this.db.addChatMessage(messageId, scopeId, payload.role, payload.content, timestamp, payload.meta)
    return this.mapMessageRow(this.db.getChatMessages(scopeId).find((row) => row.id === messageId)!)
  }

  private emitConversationEvent(payload: ConversationEventPayload): void {
    this.emit('conversationEvent', payload)
  }

  private emitScopeRunEvent(payload: ScopeRunEventPayload): void {
    this.recordScopeRunEvent(payload)
    this.emit('scopeRunEvent', payload)
  }

  recordScopeRunEvent(payload: ScopeRunEventPayload): void {
    const scope = this.getConversationScope(payload.scopeId)
    if (!scope) return
    const previous = this.scopeRunSummaries.get(payload.scopeId)
    const derivedTask = this.deriveTaskSummaryPayload(previous, payload)
    const recentArtifacts = (payload.recentArtifacts || payload.artifactRefs || previous?.recentArtifacts || []).slice(-4)
    this.scopeRunSummaries.set(payload.scopeId, {
      scopeId: payload.scopeId,
      agent: payload.agent,
      title: scope.title,
      sourceKind: scope.sourceKind,
      sourceId: scope.sourceId,
      channelKey: this.toChannelKey(scope),
      threadKey: scope.threadKey,
      phase: payload.phase,
      taskTitle: payload.taskTitle ?? derivedTask.taskTitle ?? previous?.taskTitle ?? null,
      taskSummary: payload.taskSummary ?? derivedTask.taskSummary ?? previous?.taskSummary ?? payload.latestText ?? null,
      steps: payload.steps ?? derivedTask.steps ?? previous?.steps ?? [],
      currentStepId: payload.currentStepId ?? derivedTask.currentStepId ?? previous?.currentStepId ?? null,
      waitingFor: payload.waitingFor ?? derivedTask.waitingFor ?? previous?.waitingFor ?? 'none',
      resumableActions: payload.resumableActions ?? derivedTask.resumableActions ?? previous?.resumableActions ?? [],
      recentArtifacts,
      taskContinuation: payload.taskContinuation ?? derivedTask.taskContinuation ?? previous?.taskContinuation ?? null,
      memoryCapture: payload.memoryCapture ?? previous?.memoryCapture ?? null,
      blockedReason: payload.blockedReason ?? previous?.blockedReason ?? null,
      error: payload.error ?? previous?.error ?? null,
      updatedAt: payload.timestamp,
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
          type: ['image', 'video', 'text', 'spreadsheet', 'other'].includes(String(record.type || ''))
            ? String(record.type) as ChannelAttachment['type']
            : 'other',
          ext: typeof record.ext === 'string' ? record.ext : undefined,
          remoteId: typeof record.remoteId === 'string' ? record.remoteId : undefined,
        }
      })
      .filter(Boolean) as ChannelAttachment[]
  }

  private describeChannelAttachments(attachments: ChannelAttachment[]): string {
    if (attachments.length === 0) return ''
    if (attachments.length === 1) {
      const item = attachments[0]
      const kind = item.type === 'image'
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
      const kind = attachment.type === 'image'
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
    attachments: ChannelAttachment[],
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
    return [inboundText, this.formatChannelAttachmentSummary(attachments)].filter(Boolean).join('\n\n')
  }

  private tryInlineChannelAttachment(attachment: ChannelAttachment): MultimodalBlock | null {
    const filePath = typeof attachment.path === 'string' ? attachment.path : ''
    if (!filePath || !isAbsolute(filePath) || !existsSync(filePath)) {
      return null
    }

    const ext = (attachment.ext || extname(filePath)).toLowerCase()
    const declaredType = String(attachment.type || '').toLowerCase()
    const stat = statSync(filePath)

    if (declaredType === 'video' || ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'].includes(ext)) {
      if (stat.size > 40 * 1024 * 1024) return null
      return {
        type: 'video',
        base64: readFileSync(filePath).toString('base64'),
        mimeType: attachment.mimeType || this.mimeTypeFromExt(ext, 'video/mp4'),
      }
    }

    if (declaredType === 'image' || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.tif', '.ico', '.avif'].includes(ext)) {
      return {
        type: 'image',
        base64: readFileSync(filePath).toString('base64'),
        mimeType: attachment.mimeType || this.mimeTypeFromExt(ext, 'image/png'),
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
      '.m4v': 'video/x-m4v',
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
    text: string,
  ): Promise<{ success: boolean; error?: string }> {
    for (const chunk of this.splitLongText(text)) {
      const result = await this.sidecar.sendChannel({
        id: channelId,
        thread,
        text: chunk,
      }).then(() => ({ success: true as const })).catch((error) => ({
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
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
      'copaw_channel',
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
  private async reflectOnConversation(scope: ConversationScope, usedTools: string[]): Promise<ScopeRunMemoryCapture | null> {
    try {
      // Get conversation messages
      const messages = this.db.getChatMessages(scope.id).map((msg) => ({
        role: msg.role,
        content: msg.content,
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
        success: true,
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

  private deriveTaskSummaryPayload(
    previous: ScopeRunSummary | undefined,
    payload: ScopeRunEventPayload,
  ): Partial<ScopeRunSummary> {
    const rawText = payload.toolEvent?.kind === 'result'
      ? payload.toolEvent.text
      : payload.latestText || ''
    if (!rawText) return {}

    const browserPlanTarget = rawText.match(/\[计划\]\s*目标：([^\n]+)/)?.[1]?.trim()
    const browserPlanOrder = rawText.match(/\[计划\]\s*顺序：([^\n]+)/)?.[1]?.trim()
    if (browserPlanTarget && browserPlanOrder) {
      const steps = browserPlanOrder
        .split('->')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((id) => ({
          id,
          title: this.browserStepTitle(id),
          status: 'pending' as const,
          updatedAt: payload.timestamp,
        }))
      return {
        taskTitle: browserPlanTarget,
        taskSummary: '准备开始浏览器任务',
        steps,
        currentStepId: null,
        waitingFor: 'none',
        resumableActions: ['cancel'],
      }
    }

    const browserStage = rawText.match(/\[阶段\]\s*步骤\s*(\d+)\/(\d+)\s*([^：:]+)[：:]\s*(.+)$/)
    if (browserStage) {
      const currentIndex = Math.max(0, Number(browserStage[1]) - 1)
      const detail = browserStage[4].trim()
      const steps = (previous?.steps || []).map((step, index) => ({
        ...step,
        status: (index < currentIndex ? 'done' : index === currentIndex ? 'running' : 'pending') as ScopeRunTaskStep['status'],
        detail: index === currentIndex ? detail : step.detail || null,
        updatedAt: index <= currentIndex ? payload.timestamp : step.updatedAt,
      }))
      return {
        taskTitle: previous?.taskTitle || '浏览器任务',
        taskSummary: `${browserStage[3].trim()}：${detail}`,
        steps,
        currentStepId: steps[currentIndex]?.id || previous?.currentStepId || null,
        waitingFor: 'none',
        resumableActions: ['cancel'],
      }
    }

    const executionId = rawText.match(/^Execution ID:\s*(.+)$/m)?.[1]?.trim()
    const skillId = rawText.match(/^Skill:\s*(.+)$/m)?.[1]?.trim()
    if (executionId && skillId) {
      const currentStepId = rawText.match(/^Current step:\s*(.+)$/m)?.[1]?.trim() || null
      const blockerMatch = rawText.match(/^Blocker:\s*([^-\n]+)-\s*(.+)$/m)
      const blockerType = blockerMatch?.[1]?.trim() || null
      const blockerMessage = blockerMatch?.[2]?.trim() || null
      const recentSteps = rawText.match(/^Recent steps:\s*(.+)$/m)?.[1]?.trim() || ''
      const recentArtifactsLine = rawText.match(/^Recent artifacts:\s*(.+)$/m)?.[1]?.trim() || ''
      const steps = recentSteps
        ? recentSteps.split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
          const match = item.match(/^(.+)\((.+)\)$/)
          const stepId = (match?.[1] || item).trim()
          return {
            id: stepId,
            title: stepId,
            status: this.skillStepStatus(match?.[2] || 'pending'),
            updatedAt: payload.timestamp,
          } satisfies ScopeRunTaskStep
        })
        : previous?.steps || []
      const parsedArtifacts = recentArtifactsLine
        ? recentArtifactsLine.split(',').map((item) => item.trim()).filter(Boolean).map((item, index) => ({
          id: `artifact-${executionId}-${index}`,
          module: 'system',
          kind: 'artifact',
          label: item,
          path: item.startsWith('/') ? item : null,
          createdAt: payload.timestamp,
        }))
        : previous?.recentArtifacts || []
      return {
        taskTitle: `技能执行 · ${skillId}`,
        taskSummary: blockerMessage || `当前步骤：${currentStepId || '进行中'}`,
        steps,
        currentStepId,
        waitingFor: blockerType === 'need_input'
          ? 'input'
          : blockerType === 'need_confirmation'
            ? 'confirmation'
            : blockerType === 'need_agent_result'
              ? 'agent_result'
              : blockerType
                ? 'background'
                : 'none',
        resumableActions: [
          ...(blockerType ? ['continue'] as const : []),
          ...(parsedArtifacts.length > 0 ? ['open_artifact'] as const : []),
          'cancel' as const,
        ],
        recentArtifacts: parsedArtifacts,
        taskContinuation: {
          executionId,
          stepId: currentStepId,
          blockerType,
        } satisfies ScopeRunTaskContinuation,
      }
    }

    return {}
  }

  private browserStepTitle(id: string): string {
    const titles: Record<string, string> = {
      resolve_target_page: '确认目标页',
      resolve_attachment: '确认附件',
      navigate_target: '进入目标页',
      ensure_upload: '上传附件',
      ensure_prompt: '填写提示词',
      submit: '提交执行',
      final_reconcile: '结果复核',
      recover: '恢复页面',
    }
    return titles[id] || id
  }

  private skillStepStatus(value: string): ScopeRunTaskStep['status'] {
    const normalized = String(value || '').trim().toLowerCase()
    if (normalized === 'done' || normalized === 'success' || normalized === 'completed') return 'done'
    if (normalized === 'running' || normalized === 'active') return 'running'
    if (normalized === 'waiting' || normalized === 'blocked') return 'blocked'
    if (normalized === 'failed' || normalized === 'cancelled' || normalized === 'error') return 'error'
    return 'pending'
  }
}
