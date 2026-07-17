/**
 * Phase C（2026-07-05，合同 docs/superpowers/plans/2026-07-05-C-directchat-retirement-implementation.md）
 * —— DomainAdapterHost：DirectChatEngine 活面平移落点。
 *
 * DirectChatEngine 执行路径已亡（P6f），残余活面只有：域适配器装配厂、
 * 技能上下文 orchestrator、浏览器控制器接线、runtime 两闭包
 * （getConversationScope/publishScopeRunEvent）、以及 newSession 的两行
 * 副作用（document pipeline 会话缓存清理 + widget 编辑租约释放，本类以
 * resetSession 承接）。暗线（sidecar、runCleanupRegistry、abort 机器、
 * sessions map、TOOL_SYSTEM_PROMPT、执行循环遗骸）按合同不迁移——
 * parity 测试 directchat-host-parity.test.ts 反向断言它们不得出现。
 *
 * 方法体自 direct-chat.ts 逐字平移；唯一许可差异=日志文案随属主更名
 * （"... set on DomainAdapterHost"），及 BrowserController 改为 type-only
 * import（本类只标注不构造，保住纯 Node 可导入性的边界纪律）。
 */

import { existsSync } from 'fs'
import { getProviderDef } from '../../../../shared/ai-providers'
import type { BrowserController } from '../../browser-engine/ipc-handler'
import { BrowserSiteExperienceStore } from '../../browser-engine/browser-site-experience-store'
import { BrowserDomainOrchestrator } from './browser-domain-orchestrator'
import { BrowserDomainAdapter } from './browser-domain-adapter'
import { loadSiteCardFragments } from './site-card-fragments'
import { BrowserTaskPlanner } from './browser-task-planner'
import type { DomainAdapter } from './domain-adapter'
import { FeishuDomainAdapter } from './feishu-domain-adapter'
import { DocumentDomainOrchestrator } from './document-domain-orchestrator'
import { DocumentDomainAdapter } from './document-domain-adapter'
import { DocumentToolLoopOrchestrator } from '../../document-engine/pipeline/document-tool-loop-orchestrator'
import { CalendarDomainAdapter } from './calendar-domain-adapter'
import { RSSDomainAdapter } from './rss-domain-adapter'
import { MapDomainAdapter } from '../map-domain-adapter'
import { ResearchDomainAdapter } from './research-domain-adapter'
import { DocumentTaskPipelineExecutor } from '../../document-engine/pipeline/document-task-pipeline-executor'
import { SkillDomainAdapter } from '../skills/skill-domain-adapter'
import { SkillContextOrchestrator } from '../skills/skill-context-orchestrator'
import { SubtaskRuntime } from '../runtime-core/subtask-runtime'
import { WidgetEditLeaseStore } from '../widget-edit-lease'
import type {
  AttachmentResourceList,
  BrowserTaskAttachmentResource,
} from '../../../../shared/browser-agent-task'
import type { RunMessage } from '../contracts/run-contracts'
import { getSkillsRuntimeManager } from '../../skills-runtime/runtime-manager'
import { executeToolCall } from '../../tools'
import { findSkillToolBySkillAction, findSkillToolByName } from '../../tools/skills-tools'
import { AnthropicExecutionClient } from '../../claude-bridge/anthropic-execution-client'
import { KimiCodingClient } from '../../claude-bridge/kimi-coding-client'
import { OpenAIExecutionClient } from '../../claude-bridge/openai-execution-client'
import { createRotatingLogger } from '../../../utils/rotating-logger'
import { AttachmentLoadFailureThrottle } from '../../claude-bridge/direct-chat-attachment-metrics'
import { ChatRepository } from '../../repositories/chat-repository'
import {
  extractPrimaryUserInstruction as extractPrimaryUserInstructionFromText,
} from '../../claude-bridge/tool-policy-heuristics'
import { DEFAULT_API_REQUEST_TIMEOUT_MS } from '../../claude-bridge/request-timeout-policy'

const directChatLogger = createRotatingLogger('ready-directchat.log', { buffered: true })
const chatRepository = new ChatRepository()

function log(msg: string) {
  try { directChatLogger.append(`[${new Date().toISOString()}] ${msg}\n`) } catch { /* */ }
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | Array<Record<string, unknown>>
  reasoningContent?: unknown
  reasoning_content?: unknown
  providerData?: Record<string, unknown>
  anthropicThinkingBlocks?: unknown
}

interface DirectChatSession {
  messages: ChatMessage[]
  abortController: AbortController | null
  systemPrompt: string
  generation: number
  activeRunId: string | null
  preferTextToolBridge: boolean
  lastDocumentContextInput?: string | null
}

export class DomainAdapterHost {
  private browserController: BrowserController | null = null
  private readonly browserDomainOrchestrator: BrowserDomainOrchestrator
  private readonly skillContextOrchestrator: SkillContextOrchestrator
  private readonly anthropicExecutionClient: AnthropicExecutionClient
  private readonly kimiCodingClient: KimiCodingClient
  private readonly openAIExecutionClient: OpenAIExecutionClient
  private readonly documentToolLoopOrchestrator: DocumentToolLoopOrchestrator
  private readonly documentDomainOrchestrator: DocumentDomainOrchestrator
  private readonly documentTaskPipelineExecutor: DocumentTaskPipelineExecutor
  private readonly domainAdapters: DomainAdapter[]
  private readonly widgetEditLeaseStore = new WidgetEditLeaseStore()
  private runtime: import('../runtime-core/runtime').AgentControlRuntime | null = null
  private attachmentLoadFailureThrottle = new AttachmentLoadFailureThrottle()

  constructor() {
    const browserTaskPlanner = new BrowserTaskPlanner({
      getSessionAttachmentHints: (sessionId) => this.getSessionAttachmentHints(sessionId),
      getSessionAttachmentResourceList: (sessionId) => this.getSessionAttachmentResourceList(sessionId),
      getSessionAttachmentResources: (sessionId) => this.getSessionAttachmentResources(sessionId),
      getIncomingAttachmentHints: (userText) => this.getIncomingAttachmentHints(userText),
      getActiveTab: () => {
        const activeTab = this.browserController?.getActiveTab()
        return activeTab
          ? {
            id: activeTab.id,
            url: activeTab.url,
            title: activeTab.title,
            domain: activeTab.domain,
            active: true,
            owner: activeTab.owner,
            required: activeTab.required,
            activity: activeTab.activity,
            lastAuditedAt: activeTab.lastAuditedAt,
            loading: activeTab.loading,
            canGoBack: activeTab.canGoBack,
            canGoForward: activeTab.canGoForward,
            error: activeTab.error,
            favicon: activeTab.favicon,
          }
          : undefined
      },
      getTabContext: async (tabId) => this.browserController?.getTabContext(tabId) || null,
      extractPrimaryUserInstruction: (raw) => this.extractPrimaryUserInstruction(raw),
    })
    let browserSiteExperienceStore: BrowserSiteExperienceStore | null = null
    try {
      browserSiteExperienceStore = new BrowserSiteExperienceStore()
    } catch {
      // silent-catch: store construction failure disables site-experience hints for this session
      browserSiteExperienceStore = null
    }
    this.browserDomainOrchestrator = new BrowserDomainOrchestrator(browserTaskPlanner, browserSiteExperienceStore)
    this.skillContextOrchestrator = new SkillContextOrchestrator({
      extractPrimaryUserInstruction: (raw) => this.extractPrimaryUserInstruction(raw),
      listSkills: () => getSkillsRuntimeManager().listSkills(),
      resolveSkillToolByAction: (skillId, actionName) => findSkillToolBySkillAction(skillId, actionName),
      // skill-resume G2 — reverse `skill_<id>_<action>` → SkillToolRef so the
      // orchestrator can re-arm the reference-skill hint from prior assistant
      // tool_use blocks even when the user typed only "继续 / 接着 ...".
      resolveSkillToolByName: (toolName) => findSkillToolByName(toolName),
    })
    this.anthropicExecutionClient = new AnthropicExecutionClient({
      fetchWithTimeout: (url, init, signal, label, timeoutMs) => this.fetchWithTimeout(url, init, signal, label, timeoutMs),
      serializeMessages: (messages, format) => this.serializeMessages(messages as ChatMessage[], format),
      log,
    })
    this.kimiCodingClient = new KimiCodingClient({
      fetchWithTimeout: (url, init, signal, label, timeoutMs) => this.fetchWithTimeout(url, init, signal, label, timeoutMs),
      log,
    })
    this.openAIExecutionClient = new OpenAIExecutionClient({
      fetchWithTimeout: (url, init, signal, label, timeoutMs) => this.fetchWithTimeout(url, init, signal, label, timeoutMs),
      log,
    })
    this.documentToolLoopOrchestrator = new DocumentToolLoopOrchestrator()
    this.documentDomainOrchestrator = new DocumentDomainOrchestrator({
      log,
      executeToolCall: (name, input, context) => executeToolCall(name, input, context as any),
      extractPrimaryUserInstruction: (raw) => this.extractPrimaryUserInstruction(raw),
      extractSectionTitleFromUserText: (raw) => this.extractSectionTitleFromUserText(raw),
      extractDocumentPathFromUserText: (raw) => this.extractDocumentPathFromUserText(raw),
      callKimiCodingSimple: (session, config, baseUrl, signal) => this.kimiCodingClient.requestSimple({
        session: session as DirectChatSession,
        config,
        baseUrl,
        signal,
      }).then((result) => result.text),
      callAnthropicSimple: (session, config, baseUrl, signal) => this.anthropicExecutionClient.requestSimple({
        session: session as DirectChatSession,
        config,
        baseUrl,
        signal,
      }).then((result) => result.text),
      callOpenAISimple: (session, config, baseUrl, provider, signal, isKimi, enableKimiWebSearch) =>
        this.openAIExecutionClient.requestSimple({
          session: session as DirectChatSession,
          config,
          baseUrl,
          provider: provider as ReturnType<typeof getProviderDef>,
          signal,
          isKimi,
          enableKimiWebSearch,
        }).then((result) => result.text),
    })
    this.documentTaskPipelineExecutor = new DocumentTaskPipelineExecutor({
      log,
      requestKimiCodingSimple: async ({ session, config, baseUrl, signal, timeoutMs }) => {
        const result = await this.kimiCodingClient.requestSimple({
          session: session as DirectChatSession,
          config,
          baseUrl,
          signal,
          timeoutMs,
        })
        return result.text
      },
      requestAnthropicSimple: async ({ session, config, baseUrl, signal, timeoutMs }) => {
        const result = await this.anthropicExecutionClient.requestSimple({
          session: session as DirectChatSession,
          config,
          baseUrl,
          signal,
          timeoutMs,
        })
        return result.text
      },
      requestOpenAISimple: async ({ session, config, baseUrl, provider, signal, isKimi, enableKimiWebSearch, timeoutMs }) => {
        const result = await this.openAIExecutionClient.requestSimple({
          session: session as DirectChatSession,
          config,
          baseUrl,
          provider,
          signal,
          isKimi,
          enableKimiWebSearch,
          timeoutMs,
        })
        return result.text
      },
      getConversationScope: (scopeId) => this.runtime?.getConversationScope(scopeId) || null,
      publishScopeRunEvent: (payload, projectionTruth) => this.runtime?.publishScopeRunEvent(payload, projectionTruth || null),
      createSubtaskRuntime: () => new SubtaskRuntime({
        publishScopeRunEvent: (payload, projectionTruth) => {
          this.runtime?.publishScopeRunEvent(payload, projectionTruth || null)
        },
      }),
      acquireWidgetEditLease: (acquireParams) => {
        this.widgetEditLeaseStore.acquire(acquireParams.agent, acquireParams.sessionId, {
          widgetId: acquireParams.widgetId,
          tabId: acquireParams.tabId,
          documentPath: acquireParams.documentPath,
          widgetTitle: acquireParams.widgetTitle,
          origin: acquireParams.origin,
          widgetFingerprint: acquireParams.widgetFingerprint ?? null,
          widgetTextSample: acquireParams.widgetTextSample ?? null,
        })
      },
      resolveWidgetEditLease: (resolveParams) =>
        this.widgetEditLeaseStore.resolve(resolveParams.agent, resolveParams.sessionId),
    })
    this.domainAdapters = [
      // Stage Y0.1.4 (plan §6.4 path a-reorder): ResearchDomainAdapter is
      // listed first to satisfy the Stage R W1.6 contract gate
      // `check-research-adapter-registered-in-host.cjs`. The order between
      // Map and Research is BEHAVIORALLY EQUIVALENT — proven by the overlap
      // fixtures in `src/__tests__/research-vs-map-overlap-fixtures.test.ts`:
      // upstream `applyMapSemanticIntentToIntentClassification`
      // (`src/main/modules/agent-control/map-semantic-intent.ts:194`)
      // overwrites `intent.primaryDomain → 'map'` when map intent is active
      // and `turn-engine.ts:1463` suppresses the continuation-research hint
      // in that case, so for any real `DomainAdapterSelectionContext` at
      // most ONE of {Map, Research} `shouldHandle` returns true.
      // MapDomainAdapter still reads the TurnEngine-precomputed
      // mapSemanticIntent synchronously; nothing about the Map dispatch
      // path changes.
      new ResearchDomainAdapter(),
      new MapDomainAdapter(),
      new BrowserDomainAdapter(this.browserDomainOrchestrator as never, loadSiteCardFragments()),
      new DocumentDomainAdapter({
        orchestrator: this.documentDomainOrchestrator as never,
        toolLoopOrchestrator: this.documentToolLoopOrchestrator as never,
        pipelineExecutor: this.documentTaskPipelineExecutor as never,
      }),
      new SkillDomainAdapter(),
      new RSSDomainAdapter(),
      new CalendarDomainAdapter(),
      new FeishuDomainAdapter(),
    ]
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    label: string,
    timeoutMs = DEFAULT_API_REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const timeoutController = new AbortController()
    const relayAbort = () => timeoutController.abort(signal.reason)
    if (signal.aborted) {
      timeoutController.abort(signal.reason)
    } else {
      signal.addEventListener('abort', relayAbort, { once: true })
    }

    const timer = setTimeout(() => {
      timeoutController.abort(new Error(`${label} timeout`))
    }, timeoutMs)

    try {
      return await fetch(url, {
        ...init,
        signal: timeoutController.signal,
      })
    } catch (error) {
      if (timeoutController.signal.aborted && !signal.aborted) {
        throw new Error(`${label} 请求超时（>${Math.floor(timeoutMs / 1000)}s）`)
      }
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', relayAbort)
    }
  }

  setBrowserController(controller: BrowserController): void {
    this.browserController = controller
    log('BrowserController set on DomainAdapterHost')
  }

  hasBrowserController(): boolean {
    return Boolean(this.browserController)
  }

  /** P1 (2026-07-03, 7/01 reliability contract D) — the active browser tab
   *  URL, so site-card prompt fragments can match the current domain instead
   *  of only user-text aliases (a mid-run turn may not repeat "小红书"). */
  getActiveBrowserUrl(): string | null {
    try {
      const url = this.browserController?.getActiveTab()?.url
      return typeof url === 'string' && url.trim() ? url : null
    } catch {
      return null
    }
  }

  setRuntime(runtime: import('../runtime-core/runtime').AgentControlRuntime): void {
    this.runtime = runtime
    log('Runtime set on DomainAdapterHost')
  }

  getDomainAdapters(): ReadonlyArray<DomainAdapter> {
    return this.domainAdapters
  }

  getSkillContextOrchestrator(): SkillContextOrchestrator {
    return this.skillContextOrchestrator
  }

  /**
   * DirectChatEngine.newSession 的活效应承接：文档 pipeline 会话缓存清理 +
   * widget 编辑租约释放。sessions map / systemPrompt / abort 机器均为暗线
   * （合同 §0 判决），不迁移。
   */
  resetSession(name: string): void {
    this.documentTaskPipelineExecutor.clearSessionCache(name)
    this.widgetEditLeaseStore.release(name)
  }

  private getSessionAttachmentHints(sessionId?: string): { count: number; latestName?: string } {
    if (!sessionId) return { count: 0 }
    const visible = this.getSessionAttachmentResourceList(sessionId)
    if (!visible.ok) return { count: 0 }
    return {
      count: visible.resources.length,
      latestName: visible.resources[0]?.name || undefined,
    }
  }

  private getSessionAttachmentResourceList(sessionId?: string): AttachmentResourceList {
    if (!sessionId) return { ok: true, resources: [] }
    try {
      const resources: BrowserTaskAttachmentResource[] = []
      for (const item of chatRepository.listConversationAttachments(sessionId)) {
        if (!item.path) continue
        try {
          if (!existsSync(item.path)) continue
        } catch (error) {
          // silent-catch: surfaced via throttled fs_error emit + structured {ok:false} return
          const message = error instanceof Error ? error.message : String(error)
          this.attachmentLoadFailureThrottle.maybeEmit(sessionId, 'fs_error', {
            message: message.slice(0, 200),
          })
          return { ok: false, reason: 'fs_error', message: message.slice(0, 200) }
        }
        const resource = {
          attachmentId: String(item.attachment_id || '').trim(),
          name: String(item.name || '').trim(),
          type: String(item.type || 'other'),
          mimeType: item.mime_type || undefined,
          path: item.path,
          createdAt: item.created_at,
        }
        if (resource.attachmentId && resource.name && resource.path) {
          resources.push(resource)
        }
      }
      return { ok: true, resources }
    } catch (error) {
      // silent-catch: Stage 2.2: previously this catch silently returned `[]`, making DB
      // load failures indistinguishable from "user has no attachments" for
      // operators. The legacy array API still returns `[]` on failure, while
      // BrowserTaskPlanner now consumes this detailed result so upload turns
      // can clarify instead of treating DB/FS failure as a true empty state.
      const message = error instanceof Error ? error.message : String(error)
      this.attachmentLoadFailureThrottle.maybeEmit(sessionId, 'db_error', {
        message: message.slice(0, 200),
      })
      return { ok: false, reason: 'db_error', message: message.slice(0, 200) }
    }
  }

  private getSessionAttachmentResources(sessionId?: string): BrowserTaskAttachmentResource[] {
    const result = this.getSessionAttachmentResourceList(sessionId)
    return result.ok ? result.resources : []
  }

  private getIncomingAttachmentHints(content: RunMessage): { count: number; latestName?: string } {
    if (!Array.isArray(content)) return { count: 0 }
    const mediaBlocks = content.filter((block) => block.type === 'image' || block.type === 'video')
    if (mediaBlocks.length === 0) return { count: 0 }
    return {
      count: mediaBlocks.length,
      latestName: mediaBlocks.length === 1
        ? mediaBlocks[0].type === 'image'
          ? '当前消息图片'
          : '当前消息视频'
        : `当前消息附件(${mediaBlocks.length})`,
    }
  }

  private extractPrimaryUserInstruction(raw: string): string {
    return extractPrimaryUserInstructionFromText(raw)
  }

  private extractSectionTitleFromUserText(raw: string): string | null {
    const patterns = [
      /(第[一二三四五六七八九十百0-9]+部分)/i,
      /(第[一二三四五六七八九十百0-9]+章)/i,
      /(引言|摘要|结论|开头|结尾|第一部分|第二部分|第三部分)/i,
    ]
    for (const pattern of patterns) {
      const match = raw.match(pattern)
      if (match?.[1]) return match[1]
    }
    return null
  }

  private normalizeDocumentTargetPath(path: string): string {
    const trimmed = path.trim()
    const autosaveMatch = trimmed.match(/^(.*\.docx)\.autosave-\d{8}-\d{6}\.bak\.docx$/i)
    if (autosaveMatch?.[1] && existsSync(autosaveMatch[1])) {
      return autosaveMatch[1]
    }
    return trimmed
  }

  private extractDocumentPathFromUserText(raw: string): string | null {
    if (!raw) return null
    const contextPathLine = raw.match(/###\s*当前文档上下文[\s\S]*?(?:^|\n)-\s*路径:\s*([^\n]+)/m)
    const fromContext = contextPathLine?.[1]?.trim()
    if (fromContext && !/未保存草稿/.test(fromContext)) {
      return this.normalizeDocumentTargetPath(fromContext)
    }

    const attachmentPath = raw.match(/---\s*附件:[\s\S]*?(?:^|\n)-\s*路径:\s*(\/[^\n]+)/m)
    if (attachmentPath?.[1]) {
      return this.normalizeDocumentTargetPath(attachmentPath[1])
    }

    return null
  }

  // ── OpenAI: simple (no tools) ─────────────────────────────────────
  private serializeMessages(
    messages: ChatMessage[],
    format: 'anthropic' | 'openai'
  ): Array<Record<string, unknown>> {
    return messages.map(m => {
      if (format === 'anthropic') {
        const rawThinkingBlocks = Array.isArray(m.anthropicThinkingBlocks)
          ? m.anthropicThinkingBlocks
          : Array.isArray(m.providerData?.anthropicThinkingBlocks)
            ? m.providerData.anthropicThinkingBlocks
            : []
        const thinkingBlocks = rawThinkingBlocks.filter((block): block is Record<string, unknown> => (
          !!block && typeof block === 'object' && (block as Record<string, unknown>).type === 'thinking'
        ))
        if (thinkingBlocks.length > 0 && m.role === 'assistant') {
          const content = Array.isArray(m.content)
            ? m.content
            : [{ type: 'text', text: String(m.content || '') }]
          return {
            role: m.role,
            content: [...thinkingBlocks, ...content],
          }
        }
        return {
          role: m.role === 'system' ? 'user' : m.role,
          content: m.content
        }
      }
      // OpenAI format — convert Anthropic-style image blocks to OpenAI vision format
      if (Array.isArray(m.content)) {
        const parts = (m.content as Array<Record<string, unknown>>).map(block => {
          if (block.type === 'image' && block.source) {
            const src = block.source as { type: string; media_type: string; data: string }
            return {
              type: 'image_url',
              image_url: { url: `data:${src.media_type};base64,${src.data}` }
            }
          }
          if (block.type === 'video' && block.source) {
            const src = block.source as { type: string; media_type: string; data: string }
            return {
              type: 'video_url',
              video_url: { url: `data:${src.media_type};base64,${src.data}` }
            }
          }
          if (block.type === 'text') return { type: 'text', text: block.text }
          return block
        })
        const out: Record<string, unknown> = { role: m.role, content: parts }
        const reasoningContent = m.reasoning_content ?? m.reasoningContent
        if (reasoningContent !== undefined) out.reasoning_content = reasoningContent
        return out
      }
      // OpenAI format — pass through as-is (handles tool role, tool_call_id etc.)
      return { ...m } as Record<string, unknown>
    })
  }
}
