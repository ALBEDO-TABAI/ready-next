// B8-D R5 — RemoteChannelService: the inbound remote-IM pipeline (coalesce
// window + queue, slash-command handling, agent dispatch via
// `runCoordinator.runInboundChannel`, calendar-suggestion side channel) and
// the outbound reply path (long-text chunking, WeChat attachment collection
// from projection artifact proofs, delivery-result bookkeeping), extracted
// from AgentControlRuntime (runtime.ts) as a delegated sub-service.
// Method bodies are mechanical moves; the only substitutions are
// `this.db` / `this.sidecar` / `this.settingsRepository` /
// `this.runCoordinator` → `this.deps.*` and the runtime hub calls
// (`ensureChannelScope` / `createConversationMessage` / `refreshScope` /
// `emitConversationEvent` / `recordChannelDeliveryResult` /
// `getTaskProjection` / `getRuntimeStatus` / `getDomainAdapters`) becoming
// injected callbacks bound to the owning services (ConversationScopeStore /
// ProjectionSyncCoordinator / ChannelConfigService) or runtime stay-behinds.
// The `pendingInboundChannels` map is cluster-exclusive and migrates in; the
// coalesce-timer semantics, the outbound-attachment triple gate
// (WeChat-only channel + explicit inbound send intent + delivery-tool proof
// on the projection), and the slash-command parse rules are unchanged.
// `mimeTypeFromExt` / `splitLongText` are zero-`this` pure helpers exclusive
// to this cluster, so they ride along as private methods instead of being
// downgraded into runtime-helpers. The runtime keeps one-line delegates for
// `handleInboundChannel` / `getScopedRemoteThreadKey` /
// `getRemoteChannelSessionSettingKey` (so the R4 SidecarPollService /
// ConversationScopeStore injection closures re-bind through it automatically)
// and for `sendLongTextToChannel` (called from the stay-behind `sendScoped`
// channel ack path).
import { BrowserWindow } from 'electron'
import { createHash, randomUUID } from 'crypto'
// L5-C-Universal: channel-agnostic remote-message → calendar-event detector.
// Imported here so the inbound-channel pipeline can opportunistically push
// suggestions to the renderer without each adapter implementing detection.
import { detectRemoteChannelEventSuggestions } from '../../calendar-engine/remote-channel-event-detector'
import {
  REMOTE_CHANNEL_CALENDAR_POLICY_KEY,
  type RemoteChannelKind,
  type RemoteChannelMessage,
} from '../../../../shared/calendar-remote-channel'
import { hasRemoteFileDeliveryIntent } from '../../../../shared/remote-im-file-intent'
import { existsSync, readFileSync, statSync } from 'fs'
import { basename, extname, isAbsolute } from 'path'
import {
  getDefaultConfig,
  normalizeAIConfig,
  type AIModelConfig
} from '../../../../shared/ai-providers'
import type { MultimodalBlock } from '../../claude-bridge/direct-chat'
import type { DatabaseManager } from '../../database'
import { normalizeChannelDeliveryResult } from './channel-delivery-result'
import { logAgentMetric } from '../metrics'
import type { SidecarManager } from '../sidecar-manager'
import type { AppSettingsRepository } from '../../repositories/app-settings-repository'
import type { RunCoordinator } from '../task-projection/run-coordinator'
import type { DomainAdapter } from '../domain-adapters/domain-adapter'
import type { ExecutionHostResult, TaskProjectionRecord } from '../contracts/run-contracts'
import type {
  AgentRuntimeStatus,
  ChannelAttachment,
  ConversationEventPayload,
  ConversationScope,
  ConversationScopeMessage,
} from '../contracts/types'
import type { PendingInboundChannel } from './runtime-helpers'

export interface RemoteChannelServiceDeps {
  db: DatabaseManager
  sidecar: SidecarManager
  settingsRepository: AppSettingsRepository
  /** Narrowed lazy face over the constructor-assigned RunCoordinator hub
   *  (the wiring closure defers the `this.runCoordinator` read to call
   *  time, so the field-initializer declaration order stays safe). */
  runCoordinator: Pick<RunCoordinator, 'runInboundChannel'>
  /** Bound to the runtime `getDomainAdapters()` (orchestrator-backed). */
  getDomainAdapters: () => ReadonlyArray<DomainAdapter>
  /** Bound to the runtime public `getTaskProjection` so outbound attachment
   *  collection sees the same canResume-derived record as IPC readers. */
  getTaskProjection: (taskId: string) => TaskProjectionRecord | null
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
  createConversationMessage: (
    scopeId: string,
    payload: {
      role: string
      content: string
      meta?: Record<string, unknown>
    }
  ) => ConversationScopeMessage
  refreshScope: (scopeId: string) => ConversationScope
}

export class RemoteChannelService {
  private readonly pendingInboundChannels = new Map<
    string,
    PendingInboundChannel
  >()

  constructor(private readonly deps: RemoteChannelServiceDeps) {}

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
      this.deps.db.upsertAgentChannelEvent({
        eventId,
        channelId,
        status,
        error: error || null
      })
    }
  }

  private describeInboundChannelFailure(
    errorText: string,
    result: ExecutionHostResult,
    inboundText: string
  ): { reason: string; reply: string } {
    const terminalReason = String(result.terminalReason || '')
    const rawError = String(errorText || result.error || '').trim()
    let reason = rawError && rawError !== 'Agent execution failed'
      ? rawError
      : 'Agent execution failed'

    if (terminalReason === 'adjudication_degraded') {
      reason = hasRemoteFileDeliveryIntent(inboundText)
        ? '这轮生成了内容，但没有找到可发送的文件，或文件附件发送没有完成。'
        : '这轮已经生成回复，但完成判定没有通过。'
    } else if (reason === 'Agent execution failed' && terminalReason) {
      reason = `执行没有正常收口：${terminalReason}`
    } else if (reason === 'Agent execution failed') {
      reason = 'Agent 执行没有正常收口。'
    }

    const finalText = String(result.finalText || '').trim()
    if (!finalText) return { reason, reply: `处理失败：${reason}` }

    return {
      reason,
      reply: `处理未完全完成：${reason}\n\n本轮已经生成的内容：\n${finalText}`,
    }
  }

  private collectOutboundChannelAttachments(
    result: ExecutionHostResult,
    inboundText: string,
    channelId: string
  ): ChannelAttachment[] {
    if (!this.channelSupportsOutboundAttachments(channelId)) return []
    if (!hasRemoteFileDeliveryIntent(inboundText)) return []
    const taskIds = [result.taskProjectionId, result.taskId]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
    const projections = taskIds
      .map((taskId) => this.deps.getTaskProjection(taskId))
      .filter(Boolean) as TaskProjectionRecord[]
    if (projections.length === 0) return []

    const paths = new Set<string>()
    for (const projection of projections) {
      const proofRefs = Array.isArray(projection.proofRefs) ? projection.proofRefs : []
      const hasDeliveryToolProof = proofRefs.some((proof) => {
        if (!proof || typeof proof !== 'object') return false
        const record = proof as Record<string, unknown>
        return record.kind === 'tool_result'
          && (record.ref === 'present_file' || record.ref === 'document_save_tab')
      })
      if (!hasDeliveryToolProof) continue
      for (const proof of proofRefs) {
        if (!proof || typeof proof !== 'object') continue
        const record = proof as Record<string, unknown>
        if (record.kind !== 'artifact') continue
        const candidate = String(record.ref || '').trim()
        if (candidate) paths.add(candidate)
      }
    }

    const attachments: ChannelAttachment[] = []
    for (const candidate of paths) {
      if (!isAbsolute(candidate) || !existsSync(candidate)) continue
      const name = basename(candidate)
      if (!name || name === 'run_state.json' || name === 'delivery_report.json') continue
      const stat = statSync(candidate)
      if (!stat.isFile() || stat.size <= 0 || stat.size > 100 * 1024 * 1024) continue
      const ext = extname(candidate).toLowerCase()
      const mimeType = this.mimeTypeFromExt(ext, 'application/octet-stream')
      attachments.push({
        name,
        path: candidate,
        ext,
        size: stat.size,
        mimeType,
        type: this.channelAttachmentTypeFromPath(candidate, mimeType),
      })
    }
    if (attachments.length > 0) {
      logAgentMetric('remote_channel_outbound_attachments_collected', {
        taskIds,
        count: attachments.length,
        names: attachments.map((attachment) => attachment.name),
      })
    }
    return attachments.slice(0, 5)
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

  /**
   * L5-C-Universal — channel-agnostic calendar-event detection on
   * inbound messages.
   *
   * Wired by `flushInboundChannel`. Best-effort by design:
   *   - Reads channel kind + per-channel policy override from
   *     `agent_channels` (a malformed `config_json` is treated as "no
   *     override" — registry default wins).
   *   - Runs the universal detector (chrono inside; channel kind is just
   *     the dispatch label, not feishu-specific).
   *   - Pushes each suggestion to the renderer via
   *     `calendar:remoteEventSuggested`. The renderer dedupes by
   *     `suggestionId` and shows a "create event?" prompt.
   *
   * Any thrown error is swallowed + logged: this enhancement must NEVER
   * block the inbound conversation pipeline. If detection or IPC push
   * fails, the user simply doesn't see a suggestion — the agent loop
   * proceeds normally.
   */
  private maybeEmitRemoteCalendarSuggestions(
    pending: {
      channelId: string
      thread: string
      sender: string | null
      eventIds: string[]
    },
    inboundText: string,
  ): void {
    try {
      const channel = this.deps.db.getAgentChannel(pending.channelId)
      if (!channel) return
      const channelKind = (channel.type ?? 'generic-webhook') as RemoteChannelKind
      let autoDetectOverride: boolean | null = null
      const rawConfig = (channel as { config_json?: string | null }).config_json
      if (typeof rawConfig === 'string' && rawConfig.length > 0) {
        try {
          const parsed = JSON.parse(rawConfig) as Record<string, unknown>
          const policy = parsed[REMOTE_CHANNEL_CALENDAR_POLICY_KEY]
          if (policy && typeof policy === 'object') {
            const v = (policy as Record<string, unknown>).autoDetectCalendarEvents
            if (v === true || v === false) autoDetectOverride = v
          }
        } catch {
          // Malformed config — treat as "no override"; registry default wins.
        }
      }
      const message: RemoteChannelMessage = {
        messageId: pending.eventIds[pending.eventIds.length - 1] ?? `channel-${Date.now()}`,
        channelKind,
        channelId: pending.channelId,
        threadKey: pending.thread,
        sender: pending.sender,
        text: inboundText,
        receivedAtUnix: Math.floor(Date.now() / 1000),
      }
      const suggestions = detectRemoteChannelEventSuggestions(message, { autoDetectOverride })
      if (suggestions.length === 0) return
      const mainWin = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (!mainWin) return
      for (const suggestion of suggestions) {
        mainWin.webContents.send('calendar:remoteEventSuggested', suggestion)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[runtime] remote-channel calendar detection swallowed:', message)
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
    const commandHandled = await this.handleInboundChannelCommand(pending, inboundText, agent)
    if (commandHandled) return

    const scope = this.deps.ensureChannelScope(pending.channelId, pending.thread, agent, pending.sender)
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
        attachments: pending.attachments
      }
    })
    this.deps.emitConversationEvent({
      type: 'message_added',
      scope: this.deps.refreshScope(scope.id),
      message: inboundMessage
    })

    // L5-C-Universal: opportunistically detect calendar events in this
    // inbound message. Channel-agnostic — works for any
    // `RemoteChannelKind` declared in the registry. Per-channel policy
    // (registry default OR user override stored in
    // `agent_channels.config_json.calendar.autoDetectCalendarEvents`)
    // decides whether to scan at all. Failures are swallowed; this is a
    // best-effort enhancement, not part of the conversation contract.
    this.maybeEmitRemoteCalendarSuggestions(pending, inboundText)

    let typingIndicatorShown = false
    let typingIndicatorActive = false
    let typingIndicatorStopped = false
    let typingIndicatorStart: Promise<void> | null = null
    const typingIndicatorTimer = setTimeout(() => {
      // Cosmetic native IM typing state; it must not create a visible chat message.
      typingIndicatorStart = this.deps.sidecar
        .sendChannelTyping({
          id: pending.channelId,
          thread: pending.thread,
          typing: true
        })
        .then((response) => {
          if (response.success !== false) {
            typingIndicatorShown = true
            typingIndicatorActive = true
          }
        })
        .catch(() => undefined)
    }, 2500)
    const stopTypingIndicator = async (): Promise<void> => {
      if (typingIndicatorStopped) return
      typingIndicatorStopped = true
      clearTimeout(typingIndicatorTimer)
      if (typingIndicatorStart) {
        await typingIndicatorStart.catch(() => undefined)
      }
      if (!typingIndicatorActive) return
      await this.deps.sidecar
        .sendChannelTyping({
          id: pending.channelId,
          thread: pending.thread,
          typing: false
        })
        .catch(() => undefined)
      typingIndicatorActive = false
    }

    const promptPayload = this.buildInboundChannelPayload(inboundText, pending.attachments)
    const requestId = `channel-${pending.eventIds[pending.eventIds.length - 1]}`
    const result = await this.deps.runCoordinator.runInboundChannel(
      {
        scope,
        message: promptPayload as
          | string
          | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>,
        requestId,
        coordinators: this.deps.getDomainAdapters()
      },
      {
        onFailure: async (errorText, executionResult) => {
          await stopTypingIndicator()
          const failure = this.describeInboundChannelFailure(errorText, executionResult, inboundText)
          this.markInboundChannelEvents(pending.eventIds, pending.channelId, 'failed', failure.reason)
          const errorMessage = this.deps.createConversationMessage(scope.id, {
            role: 'system',
            content: failure.reply,
            meta: {
              source: 'channel',
              channelId: pending.channelId,
              threadKey: pending.thread,
              direction: 'outbound',
              error: true
            }
          })
          this.deps.emitConversationEvent({
            type: 'message_added',
            scope: this.deps.refreshScope(scope.id),
            message: errorMessage
          })
          const failureAttachments = this.collectOutboundChannelAttachments(
            executionResult,
            inboundText,
            pending.channelId
          )
          await this.sendChannelReply(
            pending.channelId,
            pending.thread,
            failure.reply,
            failureAttachments
          ).catch(() => undefined)
        },
        onSuccess: async (executionResult) => {
          await stopTypingIndicator()
          const finalText =
            executionResult.finalText.trim() || '任务已完成，但本次没有产生可发送的文本结果。'
          const assistantMessage = this.deps.createConversationMessage(scope.id, {
            role: 'assistant',
            content: finalText,
            meta: {
              source: 'channel',
              channelId: pending.channelId,
              threadKey: pending.thread,
              sender: agent,
              direction: 'outbound',
              typingIndicatorSent: typingIndicatorShown
            }
          })
          this.deps.emitConversationEvent({
            type: 'message_added',
            scope: this.deps.refreshScope(scope.id),
            message: assistantMessage
          })
          const outboundAttachments = this.collectOutboundChannelAttachments(
            executionResult,
            inboundText,
            pending.channelId
          )
          const delivery = await this.sendChannelReply(
            pending.channelId,
            pending.thread,
            finalText,
            outboundAttachments
          )
          if (!delivery.success) {
            const reason = delivery.error || '远程 IM 回复发送失败'
            this.markInboundChannelEvents(pending.eventIds, pending.channelId, 'failed', reason)
            const notice = this.deps.createConversationMessage(scope.id, {
              role: 'system',
              content: `处理未完全完成：${reason}`,
              meta: {
                source: 'channel',
                channelId: pending.channelId,
                threadKey: pending.thread,
                direction: 'outbound',
                error: true
              }
            })
            this.deps.emitConversationEvent({
              type: 'message_added',
              scope: this.deps.refreshScope(scope.id),
              message: notice
            })
            await this.sendLongTextToChannel(
              pending.channelId,
              pending.thread,
              `处理未完全完成：${reason}`
            ).catch(() => undefined)
            return
          }
          this.markInboundChannelEvents(pending.eventIds, pending.channelId, 'done', null)
          this.deps.db.markAgentChannelSeen(pending.channelId)
        }
      }
    )
    await stopTypingIndicator()
    if (!result.success) return
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
    })
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
