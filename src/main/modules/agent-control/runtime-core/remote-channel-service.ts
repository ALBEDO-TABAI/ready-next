// Remote IM is a resource ingress, not an Agent ingress. Ordinary inbound
// text and attachments are persisted to the channel scope and settled; only
// explicit slash commands and pending ask-card answers perform additional
// work. Outbound text/file delivery remains explicit.
import { createHash, randomUUID } from 'crypto'
import { statSync } from 'fs'
import { basename, extname } from 'path'
import {
  getDefaultConfig,
  normalizeAIConfig,
  type AIModelConfig
} from '../../../../shared/ai-providers'
import type { DatabaseManager } from '../../database'
import { normalizeChannelDeliveryResult } from './channel-delivery-result'
import { logAgentMetric } from '../metrics'
import type { SidecarManager } from '../sidecar-manager'
import type { AppSettingsRepository } from '../../repositories/app-settings-repository'
import type {
  AgentRuntimeStatus,
  ChannelAttachment,
  ConversationEventPayload,
  ConversationScope,
  ConversationScopeMessage,
} from '../contracts/types'
import type { PendingInboundChannel } from './runtime-helpers'
import {
  cancelAskUserQuestionsCardCore,
  submitAskUserQuestionsAnswersCore,
  type AskUserQuestionsCardEvent,
} from '../../tools/builtins/ask-user-questions'
import { getAskUserQuestionsStore } from '../../tools/builtins/ask-user-questions-store'
import {
  formatAskCardAnswerReceipt,
  formatAskUserQuestionsCardForChannel,
  parseChannelAskCardReply,
} from './remote-confirmation-codec'

export interface RemoteChannelServiceDeps {
  db: DatabaseManager
  sidecar: SidecarManager
  settingsRepository: AppSettingsRepository
  /** Bound to the runtime lifecycle `getRuntimeStatus()` (X-level stay-behind). */
  getRuntimeStatus: () => Promise<AgentRuntimeStatus>
  /** Bound to `ProjectionSyncCoordinator.emitConversationEvent`. */
  emitConversationEvent: (payload: ConversationEventPayload) => void
  /** Bound to `ChannelConfigService.recordChannelDeliveryResult` (R3). */
  recordChannelDeliveryResult: (
    channelId: string,
    result: { success: boolean; error?: string }
  ) => void
  /** Bound to the ConversationScopeStore public face (R4). */
  ensureChannelScope: (
    channelId: string,
    remoteThread: string,
    agent: string,
    sender: string
  ) => ConversationScope
  /** Phase I P0 —— 渠道答案提交成功后与本地 IPC submit 同构地刷新 run 进度
   *  （懒闭包绑定 orchestrator，可选：缺席只影响任务卡进度时序，不影响答案落地）。 */
  refreshActiveRunProgress?: (agent: string, scopeId: string | undefined, requestId: string) => void
  createConversationMessage: (
    scopeId: string,
    payload: {
      role: string
      content: string
      meta?: Record<string, unknown>
    },
    expectedMessageVisibilityEpoch: number,
  ) => ConversationScopeMessage
  refreshScope: (scopeId: string) => ConversationScope
}

export class RemoteChannelService {
  private readonly pendingInboundChannels = new Map<
    string,
    PendingInboundChannel
  >()

  constructor(private readonly deps: RemoteChannelServiceDeps) {
    const recovered = this.deps.db.failRunningAgentChannelEventsOnBoot?.() || 0
    if (recovered > 0) {
      logAgentMetric('remote_inbound_running_recovered', { count: recovered })
    }
  }

  discardScopeContext(scopeId: string): number {
    const normalizedScopeId = String(scopeId || '').trim()
    if (!normalizedScopeId) return 0
    let discarded = 0
    for (const [key, pending] of this.pendingInboundChannels) {
      if (pending.scopeId !== normalizedScopeId) continue
      if (pending.timer) clearTimeout(pending.timer)
      this.markInboundChannelEvents(
        pending.eventIds,
        pending.channelId,
        'failed',
        'conversation_context_reset',
      )
      this.pendingInboundChannels.delete(key)
      discarded += pending.eventIds.length
    }
    return discarded
  }

  async handleInboundChannel(payload: Record<string, unknown>): Promise<void> {
    const eventId = String(payload.id || payload.idempotencyKey || '')
    const channelId = String(payload.channelId || payload.source || '')
    const thread = String(payload.thread || '')
    const sender = String(payload.sender || '')
    const text = String(payload.text || '').trim()
    const attachments = this.parseChannelAttachments(payload.attachments)
    const existingEvent = this.deps.db.getAgentChannelEvent(eventId)
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
    const raw = Number(this.deps.db.getSetting('agent_message_coalesce_window_ms') || 1200)
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
    const frozenThread = this.deps.db.getAgentChannelThread(payload.channelId, payload.thread)
    const frozenScope = frozenThread
      ? this.deps.db.getConversationScope(frozenThread.session_id)
      : null
    const pending = this.pendingInboundChannels.get(key) || {
      channelId: payload.channelId,
      thread: payload.thread,
      scopeId: frozenThread?.session_id || null,
      messageVisibilityEpoch: Number.isSafeInteger(frozenScope?.message_visibility_epoch)
        ? Number(frozenScope?.message_visibility_epoch)
        : null,
      sender: payload.sender,
      eventIds: [],
      texts: [],
      attachments: [],
      timer: null as NodeJS.Timeout | null
    }

    if (!pending.eventIds.includes(payload.eventId)) {
      pending.eventIds.push(payload.eventId)
      this.deps.db.upsertAgentChannelEvent({
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
      void this.flushInboundChannel(key).catch((error) => {
        console.warn('[runtime] remote-channel flush rejected:', error)
      })
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
      this.deps.db.upsertAgentChannelEvent({
        eventId,
        channelId,
        status,
        error: error || null
      })
    }
  }

  private isPendingInboundContextCurrent(pending: PendingInboundChannel): boolean {
    if (!pending.scopeId) return true
    const currentScope = this.deps.db.getConversationScope(pending.scopeId)
    return Boolean(
      currentScope
      && pending.messageVisibilityEpoch !== null
      && currentScope.message_visibility_epoch === pending.messageVisibilityEpoch,
    )
  }

  private isScopeContextCurrent(scope: ConversationScope): boolean {
    const currentScope = this.deps.db.getConversationScope(scope.id)
    return Boolean(
      currentScope
      && currentScope.message_visibility_epoch === scope.messageVisibilityEpoch,
    )
  }

  private channelSupportsOutboundAttachments(channelId: string): boolean {
    const channel = this.deps.db.getAgentChannel(channelId)
    return channel?.type === 'wechat-openclaw'
  }

  private channelAttachmentTypeFromPath(path: string, mimeType: string): ChannelAttachment['type'] {
    const ext = extname(path).toLowerCase()
    if (mimeType.startsWith('image/')) return 'image'
    if (mimeType.startsWith('video/')) return 'video'
    if (['.xls', '.xlsx', '.numbers'].includes(ext)) return 'spreadsheet'
    if (['.txt', '.md', '.markdown', '.json', '.csv', '.doc', '.docx', '.pdf'].includes(ext)) return 'text'
    return 'other'
  }

  private async flushInboundChannel(key: string): Promise<void> {
    const pending = this.pendingInboundChannels.get(key)
    if (!pending) return
    this.pendingInboundChannels.delete(key)
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
    }

    try {
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
      if (!this.isPendingInboundContextCurrent(pending)) {
        this.markInboundChannelEvents(
          pending.eventIds,
          pending.channelId,
          'failed',
          'conversation_context_stale',
        )
        return
      }
      const commandHandled = await this.handleInboundChannelCommand(pending, inboundText, agent)
      if (commandHandled) return

      if (!this.isPendingInboundContextCurrent(pending)) {
        this.markInboundChannelEvents(
          pending.eventIds,
          pending.channelId,
          'failed',
          'conversation_context_stale',
        )
        return
      }

      const scope = this.deps.ensureChannelScope(pending.channelId, pending.thread, agent, pending.sender)
      if (
        pending.scopeId
        && (
          scope.id !== pending.scopeId
          || scope.messageVisibilityEpoch !== pending.messageVisibilityEpoch
        )
      ) {
        this.markInboundChannelEvents(
          pending.eventIds,
          pending.channelId,
          'failed',
          'conversation_context_stale',
        )
        return
      }
      this.deps.db.upsertAgentChannelThread({
        channelId: pending.channelId,
        remoteThread: pending.thread,
        sessionId: scope.id,
        conversationId: scope.id
      })

      const inboundMessage = this.deps.createConversationMessage(scope.id, {
        role: 'user',
        content: inboundText,
        meta: {
          source: 'channel',
          channelId: pending.channelId,
          threadKey: pending.thread,
          sender: pending.sender,
          direction: 'inbound',
          eventIds: [...pending.eventIds],
          attachments: pending.attachments
        }
      }, scope.messageVisibilityEpoch)
      try {
        this.deps.emitConversationEvent({
          type: 'message_added',
          scope: this.deps.refreshScope(scope.id),
          message: inboundMessage
        })
      } catch (error) {
        logAgentMetric('remote_inbound_projection_emit_failed', {
          channelId: pending.channelId,
          thread: pending.thread,
          error: error instanceof Error ? error.message : String(error),
        })
      }

      // Phase I P0 —— 远程确认答案拦截（合同条款 3）：scope 内有 pending
      // ask/confirm 卡时，这条入站消息是对卡的回应——run 正被卡阻塞，"当新
      // 任务跑"是伪并发。提交/取消/格式指引三选一，全部回渠道回执，不派发
      // 新 run；无 pending 卡时行为与现状一致。
      const askCardHandled = await this.tryResolvePendingAskCardFromInbound(scope.id, inboundText, pending)
      if (askCardHandled) {
        this.markInboundChannelEvents(pending.eventIds, pending.channelId, 'done', null)
        return
      }

      // Ordinary inbound is a resource receipt only. It must never start an
      // Agent run, call a model, emit typing state, or send an automatic reply.
      this.markInboundChannelEvents(pending.eventIds, pending.channelId, 'done', null)
      try {
        this.deps.db.markAgentChannelSeen(pending.channelId)
      } catch (error) {
        logAgentMetric('remote_inbound_seen_update_failed', {
          channelId: pending.channelId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      logAgentMetric('remote_inbound_resource_stored', {
        channelId: pending.channelId,
        thread: pending.thread,
        eventCount: pending.eventIds.length,
        attachmentCount: pending.attachments.length,
        scopeId: scope.id,
      })
    } catch (error) {
      const reason = this.isPendingInboundContextCurrent(pending)
        ? 'remote_inbound_flush_failed'
        : 'conversation_context_stale'
      this.markInboundChannelEvents(pending.eventIds, pending.channelId, 'failed', reason)
      logAgentMetric('remote_inbound_flush_failed', {
        channelId: pending.channelId,
        thread: pending.thread,
        reason,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private parseInboundChannelCommand(text: string): { command: string; args: string } | null {
    const trimmed = text.trim()
    if (!trimmed.startsWith('/')) return null
    const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() || ''
    const match = firstLine.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+([\s\S]*))?$/)
    if (!match) return null
    return {
      command: match[1].toLowerCase(),
      args: (match[2] || '').trim()
    }
  }

  private async handleInboundChannelCommand(
    pending: PendingInboundChannel,
    inboundText: string,
    agent: string
  ): Promise<boolean> {
    const parsed = this.parseInboundChannelCommand(inboundText)
    if (!parsed) return false

    let scope = this.deps.ensureChannelScope(pending.channelId, pending.thread, agent, pending.sender)
    this.deps.db.upsertAgentChannelThread({
      channelId: pending.channelId,
      remoteThread: pending.thread,
      sessionId: scope.id,
      conversationId: scope.id
    })

    const commandLabel = `/${parsed.command}`
    let reply: string

    switch (parsed.command) {
      case 'help':
      case 'commands':
        reply = this.formatRemoteCommandHelp()
        break
      case 'status':
        reply = await this.formatRemoteCommandStatus(scope)
        break
      case 'model':
        reply = this.formatRemoteModelCommand(parsed.args)
        break
      case 'new':
      case 'reset':
        scope = this.startNewRemoteChannelSession(pending, agent)
        reply = '已开启新的 Ready 远程会话。之后这条微信聊天里的消息会进入新会话，旧会话会保留。'
        break
      default:
        reply = `暂不支持 ${commandLabel}。\n\n${this.formatRemoteCommandHelp()}`
        break
    }

    if (!this.isScopeContextCurrent(scope)) {
      this.markInboundChannelEvents(
        pending.eventIds,
        pending.channelId,
        'failed',
        'conversation_context_stale',
      )
      return true
    }
    await this.completeInboundChannelCommand(pending, scope, commandLabel, reply)
    return true
  }

  private startNewRemoteChannelSession(
    pending: PendingInboundChannel,
    agent: string
  ): ConversationScope {
    const token = randomUUID()
    this.deps.db.setSetting(
      this.getRemoteChannelSessionSettingKey(pending.channelId, pending.thread, agent),
      token
    )
    const scope = this.deps.ensureChannelScope(pending.channelId, pending.thread, agent, pending.sender)
    this.deps.db.upsertAgentChannelThread({
      channelId: pending.channelId,
      remoteThread: pending.thread,
      sessionId: scope.id,
      conversationId: scope.id
    })
    return scope
  }

  private async completeInboundChannelCommand(
    pending: PendingInboundChannel,
    scope: ConversationScope,
    command: string,
    reply: string
  ): Promise<void> {
    const message = this.deps.createConversationMessage(scope.id, {
      role: 'system',
      content: reply,
      meta: {
        source: 'channel',
        channelId: pending.channelId,
        threadKey: pending.thread,
        direction: 'outbound',
        command
      }
    }, scope.messageVisibilityEpoch)
    this.deps.emitConversationEvent({
      type: 'message_added',
      scope: this.deps.refreshScope(scope.id),
      message
    })

    const delivery = await this.sendLongTextToChannel(pending.channelId, pending.thread, reply)
    if (!delivery.success) {
      this.markInboundChannelEvents(
        pending.eventIds,
        pending.channelId,
        'failed',
        delivery.error || '远程 IM 指令回复发送失败'
      )
      return
    }
    this.markInboundChannelEvents(pending.eventIds, pending.channelId, 'done', null)
    this.deps.db.markAgentChannelSeen(pending.channelId)
  }

  private formatRemoteCommandHelp(): string {
    return [
      'Ready 远程指令',
      '/status 查看运行状态',
      '/new 开启新的 Ready 会话',
      '/model status 查看当前模型',
      '/help 查看这份指令'
    ].join('\n')
  }

  private async formatRemoteCommandStatus(scope: ConversationScope): Promise<string> {
    const status = await this.deps.getRuntimeStatus()
    const config = normalizeAIConfig(this.deps.settingsRepository.getAIConfig() || getDefaultConfig())
    const messageCount = this.deps.db.getChatMessages(scope.id).length
    const sidecarLine = status.sidecar.error
      ? `${status.sidecar.status}（${status.sidecar.error}）`
      : status.sidecar.status

    return [
      'Ready 状态',
      `Sidecar：${sidecarLine}`,
      `远程 IM：${status.channels.connected}/${status.channels.enabled} 已连接，错误 ${status.channels.errors}`,
      `当前模型：${this.formatAIModelConfig(config)}`,
      `当前会话：${scope.id}`,
      `会话消息：${messageCount} 条`,
      `活跃任务：${status.heartbeat.orchestrator.activeTasks}`,
      `可用工具：${status.heartbeat.toolGateway.availableTools}`
    ].join('\n')
  }

  private formatRemoteModelCommand(args: string): string {
    const config = normalizeAIConfig(this.deps.settingsRepository.getAIConfig() || getDefaultConfig())
    const current = this.formatAIModelConfig(config)
    if (!args || args.toLowerCase() === 'status') {
      return [
        `当前模型：${current}`,
        '远程 IM 暂不直接切换模型；请先在 Ready 设置里切换，避免微信指令误改本机全局模型。'
      ].join('\n')
    }
    return [
      `收到模型切换请求：${args}`,
      `当前模型仍是：${current}`,
      'Ready 现在只有全局模型设置，暂不通过远程 IM 修改。'
    ].join('\n')
  }

  private formatAIModelConfig(config: AIModelConfig): string {
    const name = String(config.displayName || '').trim()
    const model = String(config.model || '').trim() || '未设置'
    return name ? `${name}（${config.provider}/${model}）` : `${config.provider}/${model}`
  }

  getRemoteChannelSessionSettingKey(
    channelId: string,
    remoteThread: string,
    agent: string
  ): string {
    const threadHash = createHash('sha256').update(remoteThread).digest('hex').slice(0, 32)
    return `remote_channel_session_v1:${channelId}:${agent}:${threadHash}`
  }

  getScopedRemoteThreadKey(
    channelId: string,
    remoteThread: string,
    agent: string
  ): string {
    const token = this.deps.db.getSetting(
      this.getRemoteChannelSessionSettingKey(channelId, remoteThread, agent)
    )
    return token ? `${remoteThread}#session:${token}` : remoteThread
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
      '.md': 'text/markdown',
      '.markdown': 'text/markdown',
      '.txt': 'text/plain',
      '.json': 'application/json',
      '.csv': 'text/csv',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }
    return table[ext] || fallback
  }

  /**
   * Phase I（2026-07-05）—— channel_send_file 的发送面：scope 反查渠道线程，
   * 文件打包成 ChannelAttachment 直发当前线程。真机实锚：微信里"把报告发我"
   * 时模型没有任何发送工具，run 收口收集器又要求 present_file 证据——现在
   * 模型有显式、即时、可回读的直达路径。目标锁死当前线程（无寻址参数）。
   */
  async sendFileToScopeThread(
    scopeId: string,
    file: { path: string; caption?: string },
  ): Promise<{ success: boolean; error?: string; channelId?: string; attachmentName?: string }> {
    let thread: { channel_id: string; remote_thread: string } | null = null
    try {
      thread = this.deps.db.getAgentChannelThreadBySession(String(scopeId || '').trim())
    } catch {
      // silent-catch: 反查失败按未绑定处理，工具侧收到明确失败原因
      thread = null
    }
    if (!thread || !thread.channel_id) {
      return { success: false, error: '当前会话没有绑定远程渠道线程' }
    }
    if (!this.channelSupportsOutboundAttachments(thread.channel_id)) {
      return { success: false, error: '当前渠道类型暂不支持出站附件（现仅微信）', channelId: thread.channel_id }
    }
    const name = basename(file.path)
    const ext = extname(file.path).toLowerCase()
    const stat = statSync(file.path)
    const mimeType = this.mimeTypeFromExt(ext, 'application/octet-stream')
    const attachment: ChannelAttachment = {
      name,
      path: file.path,
      ext,
      size: stat.size,
      mimeType,
      type: this.channelAttachmentTypeFromPath(file.path, mimeType),
    }
    const delivery = await this.sendChannelReply(
      thread.channel_id,
      thread.remote_thread || 'default',
      String(file.caption || '').trim(),
      [attachment],
    )
    logAgentMetric('remote_channel_direct_send', {
      scopeId,
      channelId: thread.channel_id,
      name,
      size: stat.size,
      success: delivery.success,
      ...(delivery.success ? {} : { error: String(delivery.error || '').slice(0, 200) }),
    })
    return {
      success: delivery.success,
      ...(delivery.error ? { error: delivery.error } : {}),
      channelId: thread.channel_id,
      attachmentName: name,
    }
  }

  /**
   * Phase I P0 —— ask/confirm 卡渠道转投（合同条款 1）：卡的 scope 命中
   * agent_channel_threads 反查时，序列化成纯文本发往 (channelId, remoteThread)。
   * 本地 renderer push 由注册点保留（双出口）；非渠道 scope 返回 false 零
   * 行为变化；反查/发送失败只记 metric，不影响本地卡可答性（条款 5）。
   */
  async maybeForwardAskCardToChannel(event: AskUserQuestionsCardEvent): Promise<boolean> {
    if (event.responsePolicy === 'local_renderer_only') return false
    const scopeKey = String(event.scopeId || event.sessionId || '').trim()
    if (!scopeKey) return false
    let thread: { channel_id: string; remote_thread: string } | null = null
    try {
      thread = this.deps.db.getAgentChannelThreadBySession(scopeKey)
    } catch {
      // silent-catch: 反查失败视同非渠道 scope，本地卡照常可答
      thread = null
    }
    if (!thread || !thread.channel_id) return false
    const text = formatAskUserQuestionsCardForChannel(event.questions)
    const delivery = await this.sendChannelReply(
      thread.channel_id,
      thread.remote_thread || 'default',
      text
    )
    logAgentMetric('remote_ask_card_forwarded', {
      cardId: event.cardId,
      scopeId: scopeKey,
      channelId: thread.channel_id,
      success: delivery.success,
      ...(delivery.success ? {} : { error: String(delivery.error || '').slice(0, 200) })
    })
    return delivery.success
  }

  /**
   * Phase I P0 —— 入站消息 → pending 卡答案（合同条款 3/4）。返回 true 表示
   * 本条消息已被答案路径消费（不再派发新 run）。答案落地复用与本地 IPC /
   * frozen-call respond 完全相同的 submit/cancel core（唯一决策机）。
   * 生产唯一调用方是 flushInboundChannel；公开仅为行为测试直测该合同。
   */
  async tryResolvePendingAskCardFromInbound(
    scopeId: string,
    inboundText: string,
    pending: PendingInboundChannel
  ): Promise<boolean> {
    const store = getAskUserQuestionsStore()
    const card = store.findPendingForScope(scopeId)
    if (!card) return false
    if (card.responsePolicy === 'local_renderer_only') {
      logAgentMetric('remote_ask_card_answer_denied', {
        cardId: card.cardId,
        scopeId,
        reason: 'local_renderer_only',
      })
      await this.sendChannelReply(
        pending.channelId,
        pending.thread,
        '这项设置只能在本机 Ready 中确认，远程回复不会修改本机模型配置。',
      ).catch(() => undefined)
      return true
    }
    const parsed = parseChannelAskCardReply(inboundText, card.questions)
    if (parsed.kind === 'cancel') {
      const result = cancelAskUserQuestionsCardCore(card.cardId, 'user_cancelled', {
        store,
        db: this.deps.db,
        logMetric: (name, payload) => logAgentMetric(name, payload)
      })
      logAgentMetric('remote_ask_card_answered', {
        cardId: card.cardId,
        scopeId,
        outcome: 'cancel',
        success: result.success
      })
      await this.sendChannelReply(
        pending.channelId,
        pending.thread,
        result.success
          ? '已取消本次确认，任务将按未确认继续处理。'
          : `取消没有生效（${'error' in result ? result.error : '未知原因'}）。`
      ).catch(() => undefined)
      return true
    }
    if (parsed.kind === 'error') {
      logAgentMetric('remote_ask_card_reply_unparsed', { cardId: card.cardId, scopeId })
      await this.sendChannelReply(pending.channelId, pending.thread, parsed.guidance)
        .catch(() => undefined)
      return true
    }
    const result = submitAskUserQuestionsAnswersCore(card.cardId, parsed.answers, {
      store,
      db: this.deps.db,
      submissionSurface: 'remote_channel',
      logMetric: (name, payload) => logAgentMetric(name, payload)
    })
    logAgentMetric('remote_ask_card_answered', {
      cardId: card.cardId,
      scopeId,
      outcome: 'submit',
      success: result.success,
      ...(result.success ? {} : { errorKind: result.errorKind })
    })
    if (result.success) {
      if (card.agent && card.requestId) {
        this.deps.refreshActiveRunProgress?.(
          card.agent,
          card.scopeId || card.sessionId || undefined,
          card.requestId
        )
      }
      await this.sendChannelReply(
        pending.channelId,
        pending.thread,
        formatAskCardAnswerReceipt(card.questions, parsed.answers)
      ).catch(() => undefined)
    } else {
      await this.sendChannelReply(
        pending.channelId,
        pending.thread,
        `这次确认没有生效（${result.error}）。若原任务已超时结束，请直接重新发起。`
      ).catch(() => undefined)
    }
    return true
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

  private async sendChannelReply(
    channelId: string,
    thread: string,
    text: string,
    attachments: ChannelAttachment[] = []
  ): Promise<{ success: boolean; error?: string }> {
    const body = String(text || '').trim()
    if (body) {
      const textResult = await this.sendLongTextToChannel(channelId, thread, body)
      if (!textResult.success) return textResult
    }
    if (attachments.length === 0) return { success: true }
    try {
      const response = await this.deps.sidecar.sendChannel({
        id: channelId,
        thread,
        text: '',
        attachments: attachments.map((attachment) => ({
          name: attachment.name,
          path: attachment.path,
          mimeType: attachment.mimeType,
          size: attachment.size,
          type: attachment.type,
          ext: attachment.ext,
        })),
      })
      const result = normalizeChannelDeliveryResult(response, '远程 IM 附件发送失败')
      this.deps.recordChannelDeliveryResult(channelId, result)
      return result
    } catch (error) {
      // silent-catch: outbound attachment errors are converted into delivery results and persisted.
      const result = {
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
      }
      this.deps.recordChannelDeliveryResult(channelId, result)
      return result
    }
  }

  async sendLongTextToChannel(
    channelId: string,
    thread: string,
    text: string
  ): Promise<{ success: boolean; error?: string }> {
    for (const chunk of this.splitLongText(text)) {
      let result: { success: boolean; error?: string }
      try {
        const response = await this.deps.sidecar.sendChannel({
          id: channelId,
          thread,
          text: chunk
        })
        result = normalizeChannelDeliveryResult(response, '远程 IM 文本发送失败')
      } catch (error) {
        // silent-catch: chunk send errors are returned as delivery failures for the caller.
        result = {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
      this.deps.recordChannelDeliveryResult(channelId, result)
      if (!result.success) {
        return result
      }
    }
    return { success: true }
  }
}
