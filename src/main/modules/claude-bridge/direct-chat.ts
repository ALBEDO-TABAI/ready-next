/**
 * Direct HTTP chat engine.
 * Bypasses Claude CLI — calls AI provider APIs directly for fast response.
 * Supports tool calling for browser control and other integrations.
 */

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { appendFileSync, existsSync } from 'fs'
import { AIModelConfig, getProviderDef, normalizeAIConfig, resolveAIConfigCapabilities } from '../../../shared/ai-providers'
import { BrowserController } from '../browser-engine/ipc-handler'
import type { SidecarManager } from '../agent-control/sidecar-manager'
import { BrowserDomainOrchestrator } from '../agent-control/browser-domain-orchestrator'
import { BrowserTaskPlanner } from '../agent-control/browser-task-planner'
import { DesignToolLoopOrchestrator } from '../agent-control/design-tool-loop-orchestrator'
import { DocumentDomainOrchestrator } from '../agent-control/document-domain-orchestrator'
import { DocumentToolLoopOrchestrator } from '../agent-control/document-tool-loop-orchestrator'
import { ExecutionLoopOrchestrator } from '../agent-control/execution-loop-orchestrator'
import { SkillContextOrchestrator } from '../agent-control/skill-context-orchestrator'
import { buildToolRuntimeContext } from '../agent-control/tool-runtime-context-builder'
import {
  applyRunBudgetHint,
  consumeIterationBudget,
  consumeParallelGroupBudget,
  consumeToolCallBudget,
  createRunBudgetSeed,
  getRemainingToolCallBudget,
} from '../agent-control/run-budget-policy'
import {
  buildTextToolBridgeCorrectionMessage,
  buildToolGuidance,
  type ToolPolicy,
} from '../agent-control/execution-tool-config'
import type { RunBudgetSeed, RunBudgetUsage } from '../agent-control/run-contracts'
import type {
  BrowserTaskAttachmentResource,
  BrowserTaskDecision,
  BrowserTaskPlan,
  BrowserTaskPlanContinuity,
} from '../../../shared/browser-agent-task'
import {
  domainsLikelyMatch,
  getBrowserWorkflowState,
  getLatestSkillRun,
  getRecentBrowserActions,
  type BrowserActionRecord,
  type BrowserWorkflowState,
  type SkillRunRecord,
} from '../agent-control/session-continuity'
import { getSkillsRuntimeManager } from '../skills-runtime/runtime-manager'
import { executeToolCall } from '../tools'
import { findSkillToolBySkillAction } from '../tools/skills-tools'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import {
  buildTextToolResultMessage,
  looksLikeMissingNativeToolsReply,
} from './tool-bridge'
import { buildExecutionFallbackState, type ExecutionFallbackInfo } from './execution-fallback-policy'
import {
  extractPrimaryUserInstruction as extractPrimaryUserInstructionFromText,
} from './tool-policy-heuristics'
import {
  inspectDocumentToolCall,
} from './document-tool-flow'
import { compactToolPolicyHistory } from './tool-policy-context'
import { DEFAULT_API_REQUEST_TIMEOUT_MS } from './request-timeout-policy'
import { ChatRepository } from '../repositories/chat-repository'
import type { ConversationScope } from '../agent-control/types'
import { buildToolVisibilityPlan } from '../agent-control/execution-tool-policy'
import { buildExecutionToolState, resolveExecutionIntentContext } from '../agent-control/execution-intent-resolver'
import { AnthropicExecutionClient } from './anthropic-execution-client'
import { KimiCodingClient } from './kimi-coding-client'
import { OpenAIExecutionClient } from './openai-execution-client'
import { VideoFallbackService } from './video-fallback-service'
import { getLogPath } from '../../utils/platform'

const LOG = getLogPath('ready-directchat.log')
const settingsRepository = new AppSettingsRepository()
const chatRepository = new ChatRepository()

function log(msg: string) {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`) } catch { /* */ }
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | Array<Record<string, unknown>>
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

interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

interface APIResponse {
  text: string
  toolCalls: ToolCall[]
  stopReason: string
  reasoningContent?: unknown
  providerResponseId?: string
  rawText?: string
  toolTransport?: 'native' | 'text'
  fallback?: ExecutionFallbackInfo
}

export interface MultimodalBlock {
  type: 'text' | 'image' | 'video'
  text?: string
  base64?: string
  mimeType?: string
}

const TOOL_SYSTEM_PROMPT = `
你可以使用浏览器工具来帮助用户：导航网页、搜索信息、阅读页面内容、点击元素、输入文字和执行JavaScript。
当用户需要网页操作时，主动使用这些工具。搜索信息时，优先用 browser_search（支持多引擎回退）；如果是多步骤复杂任务，优先用 browser_run_workflow 一次执行多个步骤。
当任务是“读网页结构化内容”“滚动采集整页”“批量下载”“长时间后台任务”时，优先用 browser_extract_structured、browser_scroll_collect、browser_wait_for_condition、browser_start_task、browser_get_task，而不是把所有逻辑都塞进 browser_execute_js 或 browser_run_workflow。
如果任务本质上是“整页图集/画板下载”，优先用 browser_download_gallery；如果任务本质上是“围绕一个主题跨网页研究”，优先用 browser_research_topic。
当 selector 不稳定或你不确定 DOM 结构时，优先用 browser_click_text / browser_type_smart，而不是盲猜 CSS 选择器。
在聊天类网页中，优先验证“是否真实提交并出现响应内容”，不要只把文本写入输入框就结束。
若一次提交未成功，按“DOM 定位 -> 可编辑区探测 -> 坐标输入 -> 键盘提交 -> 等待并复核”的顺序回退；每一步都要读取页面证据后再继续。
如果同一输入框中已经存在与目标完全相同的文本，不要重复输入，优先直接提交并验证响应。
如果系统上下文说明“当前页可复用”，先读取当前页并继续，不要默认重新搜索或重新打开站点。
若短时间内已经执行过相同的搜索或导航，先验证当前页证据，再决定是否重复动作。
当任务包含“找图并下载到本地”时，优先用 browser_collect_images 收集候选，再用 browser_download_urls 一次批量下载，减少工具来回调用次数。
如果页面很长、需要持续滚动才能收全内容，先用 browser_scroll_collect、browser_download_gallery 或 browser_start_task，不要只截当前视口就结束。
如果用户要求跨多个网页汇总资料，优先用 browser_research_topic；若需要更细控制，再用 browser_extract_structured 把来源页内容结构化，再基于结构化结果总结，并保留来源链接。
当用户提到“刚发的图 / 这张附件 / 飞书里的图片 / 上传这张图 / 用附件继续操作”时，优先使用 browser_upload_scope_attachment，把当前会话里的附件上传到网页，再继续输入提示词和点击发送。
如果你不确定页面上哪个是上传入口，先用 browser_list_upload_targets 探测，再执行上传。
当 upload/send/close/back 这类动作的 selector 不稳定时，优先用 browser_locate_action_targets 查候选；当需要定位提示词或消息输入区时，优先用 browser_locate_input_targets；DOM/A11y 仍然不够时，再用 browser_analyze_viewport 做视觉兜底。
在点击发送/生成前，先确认当前焦点或已选输入区确实是目标 prompt 输入区；如果 browser_locate_input_targets 已返回 active_target 或 nearby_send_targets，优先复用这些结果，减少额外工具调用。
如果还没有稳定的输入区锚点，不要先点发送/生成按钮；先让光标进入正确输入框、输入并复核，再提交。
如果多个可疑按钮都无法和当前输入区建立明显关联，应停止继续误点，优先重新读页或向用户澄清。
如果当前页出现像“Agent 模式 / 图片生成 / 视频生成 / 灵感 / 画布”这类可疑模式按钮、标签或可能带下拉的控件，不要立刻离开当前站点；先把它当作候选入口，优先定位候选控件，必要时点击一次并立即重新读取页面，检查是否展开了合适选项。
如果点开一层后仍不能判断该选哪个模式或入口，应尽早向用户澄清，而不是在同站点或不同页面之间来回跳转。
网页操作要按阶段执行：先检查页面状态，再定位控件，再动作，再验证。如果误点或弹出错误弹层，先恢复页面状态（Escape/关闭/返回）再继续。
上传类网页任务优先走“定位上传入口 -> 打开上传路径 -> 上传当前会话附件 -> 定位提示词输入框 -> 输入 -> 提交 -> 验证”的顺序，不要把上传、输入、提交混成一次盲操作。
执行动作后可用 browser_wait 等待页面稳定，再用 browser_read_page 读取内容，最后总结给用户。
当消息中包含 [🌐 标题](url) 格式的网页引用时，请主动使用 browser_read_page 工具读取该 URL 的内容，然后基于页面内容回答用户。
你可以直接使用文档工具来编辑文稿，优先使用 document_* 工具而不是只给文字建议：
- document_new_tab / document_open_tab / document_switch_tab / document_rename_tab
- document_set_content / document_append_content / document_insert_widget / document_list_widgets / document_update_widget / document_remove_widget / document_replace_text / document_replace_exact / document_format_section / document_rewrite_section / document_save_tab
当用户要求“直接改文档”“帮我写入并保存”时，请先基于用户语义做简短执行计划，再调用这些 document_* 工具执行真实操作。
如果用户给出了明确的原文片段、句子、选区或精确引用，优先使用 document_replace_exact，避免整篇覆盖或误改重复片段。
如果用户明确要求在文档里生成图表、交互组件、可视化说明、小工具或生成式 UI，优先使用 document_insert_widget，把 show-widget 围栏写入原文档。
如果用户要求“看看现在有哪些 widget / 更新这个 widget / 删除这个 widget”，优先使用 document_list_widgets / document_update_widget / document_remove_widget，不要退回整篇覆盖。
show-widget 规则：
- 使用 \`\`\`show-widget 围栏
- JSON 结构为 {"title":"snake_case_id","widget_code":"<div>...</div>"}
- 如能表达为结构化组件规格，优先使用 document_insert_widget / document_update_widget 的 componentSpec 参数，不要总是自由编写原始 HTML
- widget_code 可使用本地内联事件（如 oninput / onclick）完成简单交互
- 复杂本地交互可追加小型内联 <script>，但不要依赖网络
- 如需把 widget 内交互结果发回 agent，可使用 \`window.__readyWidgetSendMessage("...")\` 或 \`data-ready-agent-message="..."\` 触发
- 单个 widget 控制在 3000 字以内
- 仅允许白名单 CDN：cdnjs.cloudflare.com / cdn.jsdelivr.net / unpkg.com / esm.sh
- 禁止 iframe 嵌套、fetch / XMLHttpRequest / WebSocket、form 提交、任意外链脚本、全局样式污染
- 默认优先 SVG 图解、简单 HTML+CSS、Chart.js 图表
如果用户只要求“优化格式/排版/可读性”，请保持原意，不要总结、删减或改写观点。
请根据上下文自主决定操作顺序与工具组合，不要输出模板化固定回复。
你还可以使用技能工具：
- skill_video_expert_pipeline / skill_video_expert_ai_analyze：视频场景分析与评分
- skill_video_copy_analyze：视频文案/字幕提取
- skill_rss_add / skill_rss_update / skill_rss_status / skill_rss_list / skill_rss_stats：RSS 订阅管理与更新
如果工具列表里出现新的自定义 skill_* 工具，也把它们视为可直接执行的技能能力。
当用户明确提出这些任务时，优先调用对应 skill_* 工具，不要只给口头建议；若已有匹配 skill，则优先复用它而不是改走手工网页路径。
当用户明确点名某个 skill（例如“使用 lifepho skill”）时，必须先调用对应的 skill_* 工具或读取其说明，再把 skill 的方法真正用到后续浏览器/文档任务里。
不要把 /skill ... 命令当成普通文本回复给用户；如果你决定执行 skill，就直接调用真实 skill_* 工具或 execution 管理工具。
如果用户只提到站点名（例如“即梦”）但没有给 URL，且当前页也不能明确复用，先搜索该站点的官方入口并确认，再继续；若搜索结果仍不唯一，先向用户澄清，不要在无关页面反复进出。
当用户要求执行 openclaw 插件配对、批准飞书配对码、或明确给出类似”openclaw pairing approve feishu CODE”的命令时，优先调用 system_run_openclaw 工具真实执行本地命令，不要只复述命令文本。

如果系统当前未启用工具，请不要伪造工具调用，直接给出文本回答。
`

export class DirectChatEngine extends EventEmitter {
  private sessions = new Map<string, DirectChatSession>()
  private browserController: BrowserController | null = null
  private readonly browserDomainOrchestrator: BrowserDomainOrchestrator
  private readonly skillContextOrchestrator: SkillContextOrchestrator
  private readonly anthropicExecutionClient: AnthropicExecutionClient
  private readonly kimiCodingClient: KimiCodingClient
  private readonly openAIExecutionClient: OpenAIExecutionClient
  private readonly videoFallbackService: VideoFallbackService
  private readonly designToolLoopOrchestrator: DesignToolLoopOrchestrator
  private readonly documentToolLoopOrchestrator: DocumentToolLoopOrchestrator
  private readonly documentDomainOrchestrator: DocumentDomainOrchestrator
  private readonly executionLoopOrchestrator: ExecutionLoopOrchestrator
  private sidecarManager: SidecarManager | null = null
  private runtime: import('../agent-control/runtime').AgentControlRuntime | null = null
  private rendererToolActionRequester: ((payload: {
    agent?: string
    sessionId?: string
    runId?: string
    tool: string
    args: Record<string, unknown>
    }) => Promise<Record<string, unknown>>) | null = null
  private maxToolIterations = 24

  constructor() {
    super()
    const browserTaskPlanner = new BrowserTaskPlanner({
      getSessionAttachmentHints: (sessionId) => this.getSessionAttachmentHints(sessionId),
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
    this.browserDomainOrchestrator = new BrowserDomainOrchestrator(browserTaskPlanner)
    this.skillContextOrchestrator = new SkillContextOrchestrator({
      extractPrimaryUserInstruction: (raw) => this.extractPrimaryUserInstruction(raw),
      listSkills: () => getSkillsRuntimeManager().listSkills(),
      listExecutions: (limit, sessionId, activeOnly) => getSkillsRuntimeManager().listExecutions(limit, sessionId, activeOnly),
      resolveSkillToolByAction: (skillId, actionName) => findSkillToolBySkillAction(skillId, actionName),
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
    this.videoFallbackService = new VideoFallbackService({ log })
    this.designToolLoopOrchestrator = new DesignToolLoopOrchestrator()
    this.documentToolLoopOrchestrator = new DocumentToolLoopOrchestrator()
    this.documentDomainOrchestrator = new DocumentDomainOrchestrator({
      log,
      executeToolCall: (name, input, context) => executeToolCall(name, input, context as any),
      emitOutput: (payload) => this.emit('output', payload),
      emitToolAction: (payload) => this.emit('toolAction', payload),
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
    this.executionLoopOrchestrator = new ExecutionLoopOrchestrator({ log })
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
    log('BrowserController set on DirectChatEngine')
  }

  setSidecarManager(manager: SidecarManager): void {
    this.sidecarManager = manager
    log('SidecarManager set on DirectChatEngine')
  }

  setRuntime(runtime: import('../agent-control/runtime').AgentControlRuntime): void {
    this.runtime = runtime
    log('Runtime set on DirectChatEngine')
  }

  setRendererToolActionRequester(
    requester: ((payload: {
      agent?: string
      sessionId?: string
      runId?: string
      tool: string
      args: Record<string, unknown>
    }) => Promise<Record<string, unknown>>) | null,
  ): void {
    this.rendererToolActionRequester = requester
  }

  getAIConfig(): AIModelConfig | null {
    try {
      const raw = settingsRepository.getSetting('ai_model_config')
      if (raw) return normalizeAIConfig(JSON.parse(raw) as AIModelConfig)
    } catch { /* ignore */ }
    return null
  }

  private isBrowserAgentV3Enabled(): boolean {
    const envRaw = process.env.READY_BROWSER_AGENT_V3
    if (typeof envRaw === 'string' && envRaw.trim()) {
      const normalizedEnv = envRaw.trim().toLowerCase()
      return !(normalizedEnv === 'false' || normalizedEnv === '0' || normalizedEnv === 'off')
    }
    try {
      const raw = settingsRepository.getSetting('browser_agent_v3_enabled')
      if (raw == null || raw === '') return true
      const normalized = String(raw).trim().toLowerCase()
      return !(normalized === 'false' || normalized === '0' || normalized === 'off')
    } catch {
      return true
    }
  }

  private extractSessionIdFromInternalName(name: string): string | undefined {
    const marker = name.indexOf('::')
    if (marker === -1) return undefined
    const value = name.slice(marker + 2).trim()
    return value || undefined
  }

  private getSessionAttachmentHints(sessionId?: string): { count: number; latestName?: string } {
    if (!sessionId) return { count: 0 }
    try {
      const visible = this.getSessionAttachmentResources(sessionId)
      return {
        count: visible.length,
        latestName: visible[0]?.name || undefined,
      }
    } catch {
      return { count: 0 }
    }
  }

  private getSessionAttachmentResources(sessionId?: string): BrowserTaskAttachmentResource[] {
    if (!sessionId) return []
    try {
      return chatRepository
        .listConversationAttachments(sessionId)
        .filter((item) => item.path && existsSync(item.path))
        .map((item) => ({
          attachmentId: String(item.attachment_id || '').trim(),
          name: String(item.name || '').trim(),
          type: String(item.type || 'other'),
          mimeType: item.mime_type || undefined,
          path: item.path,
          createdAt: item.created_at,
        }))
        .filter((item) => item.attachmentId && item.name && item.path)
    } catch {
      return []
    }
  }

  private getIncomingAttachmentHints(content: string | MultimodalBlock[]): { count: number; latestName?: string } {
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

  private extractLinks(text: string): string[] {
    const urlRegex = /https?:\/\/[^\s一-龥]+/gi
    return Array.from(text.matchAll(urlRegex)).map(m => m[0])
  }

  /**
   * Extract pure user input (remove auto-injected environment context and assistant messages)
   */
  private extractPureUserInput(userText: string): string {
    // First, check if there's a "用户:" prefix - extract only user's input
    const userPrefixMatch = userText.match(/用户:\s*(.+?)(?:\n|$)/s)
    if (userPrefixMatch) {
      return userPrefixMatch[1].trim()
    }

    // Remove environment information blocks
    const envMarkers = [
      '## 环境信息',
      '### Widget 更新上下文',
      '### 当前设计画布上下文',
      '### 设计项目引用',
      '### 当前文档上下文',
      '--- 引用设计项目:',
      '--- 文档内容开始 ---',
    ]

    let pureInput = userText
    for (const marker of envMarkers) {
      const index = pureInput.indexOf(marker)
      if (index >= 0) {
        pureInput = pureInput.slice(0, index).trim()
      }
    }

    return pureInput
  }

  private collectRecentPureUserInputs(messages: ChatMessage[], limit = 6): string[] {
    const extractedInputs = messages
      .filter((message) => message.role === 'user')
      .map((message) => this.extractPureUserInput(this.extractIncomingText(message.content)))
      .filter((input) => input.trim().length > 0)

    return compactToolPolicyHistory(extractedInputs, limit)
  }

  newSession(name: string, systemPrompt?: string): void {
    this.stopGeneration(name)
    const basePrompt = systemPrompt ||
      '你是 Ready 应用中的 AI 助手，面向自媒体创作者。你擅长内容策划、文案写作、数据分析和创意建议。请使用简洁清晰的中文回答。'
    this.sessions.set(name, {
      messages: [],
      abortController: null,
      systemPrompt: `${basePrompt}\n${TOOL_SYSTEM_PROMPT}`,
      generation: 0,
      activeRunId: null,
      preferTextToolBridge: false,
      lastDocumentContextInput: null,
    })
  }

  setSystemPrompt(name: string, systemPrompt?: string): void {
    const basePrompt = systemPrompt ||
      '你是 Ready 应用中的 AI 助手，面向自媒体创作者。你擅长内容策划、文案写作、数据分析和创意建议。请使用简洁清晰的中文回答。'
    if (!this.sessions.has(name)) {
      this.newSession(name, basePrompt)
      return
    }
    const session = this.sessions.get(name)!
    session.systemPrompt = `${basePrompt}\n${TOOL_SYSTEM_PROMPT}`
  }

  stopGeneration(name: string): void {
    const session = this.sessions.get(name)
    if (!session) return
    const runId = session.activeRunId
    session.generation += 1
    if (session.abortController) {
      session.abortController.abort()
      session.abortController = null
    }
    if (runId) {
      this.emit('status', { agent: name, runId, status: 'cancelled', isMock: false })
      session.activeRunId = null
    }
  }

  async sendMessage(
    name: string,
    content: string | MultimodalBlock[],
    requestId?: string,
    executionOptions?: {
      budget?: RunBudgetSeed
      budgetState?: RunBudgetUsage
    },
  ): Promise<{ success: boolean; error?: string; executionDiagnostics?: { budget?: Partial<RunBudgetSeed & RunBudgetUsage> | null; fallback?: { happened: boolean; kind: string; attempts: number } | null } | null }> {
    const contentPreview = typeof content === 'string' ? content.slice(0, 80) : `[${content.length} blocks]`
    log(`sendMessage called: agent=${name}, content=${contentPreview}`)
    const runId = requestId || randomUUID()
    if (!this.sessions.has(name)) {
      this.newSession(name)
    }
    const session = this.sessions.get(name)!
    let effectiveRunBudget = executionOptions?.budget ? { ...executionOptions.budget } : null
    const runBudgetState = executionOptions?.budgetState
    let latestFallback: ExecutionFallbackInfo | null = null
    const buildExecutionDiagnostics = () => ({
      budget: effectiveRunBudget || runBudgetState
        ? {
          ...(effectiveRunBudget || {}),
          ...(runBudgetState || {}),
        }
        : null,
      fallback: buildExecutionFallbackState(latestFallback),
    })
    if (session.abortController) {
      session.generation += 1
      session.abortController.abort()
      session.abortController = null
      log(`sendMessage preempted previous in-flight run for agent=${name}`)
    }
    session.generation += 1
    const runGeneration = session.generation
    session.activeRunId = runId
    const isCurrentRun = (): boolean => {
      const latest = this.sessions.get(name)
      return !!latest && latest.generation === runGeneration && latest.activeRunId === runId
    }

    const emitOutput = (chunk: string, type: string): void => {
      if (!isCurrentRun()) return
      this.emit('output', { agent: name, runId, chunk, type })
    }
    const emitStatus = (status: string): void => {
      if (!isCurrentRun()) return
      this.emit('status', { agent: name, runId, status, isMock: false })
    }
    const emitRuntimeError = (error: string): void => {
      if (!isCurrentRun()) return
      this.emit('error', { agent: name, runId, error, type: 'runtime' })
    }
    const emitToolAction = (tool: string, args: Record<string, unknown>): void => {
      if (!isCurrentRun()) return
      this.emit('toolAction', { agent: name, runId, tool, args })
    }

    const config = this.getAIConfig()
    if (!config || !config.apiKey) {
      session.activeRunId = null
      emitOutput('未配置 API Key，请前往设置页配置', 'error')
      emitOutput('', 'done')
      emitStatus('error')
      return { success: false, error: '未配置 API Key', executionDiagnostics: buildExecutionDiagnostics() }
    }

    const capabilities = resolveAIConfigCapabilities(config)
    const normalizedBaseUrl = capabilities?.baseUrl || config.baseUrl.replace(/\/+$/, '')
    const isKimiCoding = !!capabilities?.isKimiCoding
    const useAnthropicProtocol = capabilities?.agentProtocol === 'anthropic'
    const supportsVideoBlock = capabilities?.supportsNativeVideo ?? (!normalizedBaseUrl.includes('/coding'))
    const hasRawVideoInIncoming = Array.isArray(content) && content.some((block) => block.type === 'video')

    // Build message content — support multimodal blocks
    if (Array.isArray(content)) {
      // Convert MultimodalBlock[] to provider-internal format.
      const blocks: Array<Record<string, unknown>> = []
      for (const b of content) {
        if (b.type === 'image') {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: b.mimeType || 'image/png', data: b.base64 || '' } })
          continue
        }
        if (b.type === 'video') {
          if (!supportsVideoBlock) {
            log(`video block downgraded to text for provider=${config.provider}, baseUrl=${config.baseUrl}`)
            blocks.push({ type: 'text', text: '[视频附件已接收，但当前模型接口不支持原生视频输入。]' })
            continue
          }
          blocks.push({ type: 'video', source: { type: 'base64', media_type: b.mimeType || 'video/mp4', data: b.base64 || '' } })
          continue
        }
        blocks.push({ type: 'text', text: b.text || '' })
      }
      const imageCount = blocks.filter((b) => b.type === 'image').length
      const videoCount = blocks.filter((b) => b.type === 'video').length
      log(`normalized multimodal blocks: text=${blocks.length - imageCount - videoCount}, image=${imageCount}, video=${videoCount}`)
      session.messages.push({ role: 'user', content: blocks })
    } else {
      session.messages.push({ role: 'user', content })
    }

    const abortController = new AbortController()
    session.abortController = abortController
    const ensureNotAborted = (): void => {
      if (abortController.signal.aborted || !isCurrentRun()) {
        const error = new Error('Operation aborted')
        error.name = 'AbortError'
        throw error
      }
    }

    emitStatus('working')

    try {
      const provider = capabilities?.provider || getProviderDef(config.provider, normalizedBaseUrl)
      const baseUrl = normalizedBaseUrl
      // isKimi: Kimi's own OpenAI-protocol endpoint (provider=moonshot). Uses $web_search, not browser tools.
      // Note: api.kimi.com/coding with provider=anthropic is Anthropic-compatible and DOES support tools.
      const isKimi = isKimiCoding || (!useAnthropicProtocol && (baseUrl.includes('kimi') || baseUrl.includes('moonshot')))
      const sessionId = this.extractSessionIdFromInternalName(name)
      const userText = this.extractIncomingText(content)
      const pureUserInput = this.extractPureUserInput(userText)
      const executionIntentContext = resolveExecutionIntentContext({
        userText,
        pureUserInput,
        previousInputs: this.collectRecentPureUserInputs(session.messages.slice(0, -1), 40),
        lastDocumentContextInput: session.lastDocumentContextInput,
      })
      const contextualUserInput = executionIntentContext.contextualUserInput
      if (contextualUserInput !== pureUserInput) {
        log(`tool policy context reused previous user input: ${this.extractPrimaryUserInstruction(contextualUserInput).slice(0, 120)}`)
      }
      const userInstructionText = executionIntentContext.userInstructionText
      const hasVideoInputs = this.sessionHasVideoInputs(session.messages)
      const keepToolsWithVideo = this.skillContextOrchestrator.shouldKeepToolsWithVideo(contextualUserInput, sessionId)
      const baseToolVisibilityPlan = buildToolVisibilityPlan({
        supportsToolCalls: capabilities?.supportsToolCalls ?? true,
        hasVideoInputs,
        hasIncomingVideo: hasRawVideoInIncoming,
        keepToolsWithVideo,
        allowBrowserTools: false,
      })
      // Avoid tools when video exists, so simple media tasks don't get routed into skill/tool loops.
      // Keep tools enabled when the user is explicitly controlling skill execution or embedded Python.
      const hasTools = baseToolVisibilityPlan.hasTools
      const publicAgentName = name.includes('::') ? name.slice(0, name.indexOf('::')) : name
      const requestModuleToolAction = this.rendererToolActionRequester
        ? (tool: string, args: Record<string, unknown>) => this.rendererToolActionRequester!({
          agent: publicAgentName,
          sessionId,
          runId,
          tool,
          args,
        })
        : undefined
      const emitStructuredTaskPayload = (payload: unknown): void => {
        emitOutput(JSON.stringify(payload), 'tool_result')
      }
      const incomingAttachmentHints = this.getIncomingAttachmentHints(content)
      let browserDecision = ({ mode: 'free_tool_loop', reason: 'browser_disabled' } as BrowserTaskDecision)

      const hasDocumentEnvironment = executionIntentContext.hasDocumentEnvironment

      // Judge intent based on pure input (not polluted by environment context)
      const preferredSkillToolNames = hasTools && (
        this.skillContextOrchestrator.findExplicitlyRequestedSkills(contextualUserInput).length > 0
        || this.skillContextOrchestrator.hasActiveSkillExecution(sessionId)
      )
        ? this.skillContextOrchestrator.buildPreferredSkillToolNames(contextualUserInput, sessionId)
        : null
      let { visibilityPlan: resolvedToolVisibilityPlan, toolPolicy } = buildExecutionToolState({
        supportsToolCalls: capabilities?.supportsToolCalls ?? true,
        hasVideoInputs,
        hasIncomingVideo: hasRawVideoInIncoming,
        keepToolsWithVideo,
        preferredSkillToolNames,
        contextualUserInput,
        userInstructionText,
        hasWidgetTargetContext: executionIntentContext.hasWidgetTargetContext,
        explicitWidgetCreateIntent: executionIntentContext.explicitWidgetCreateIntent,
        documentWidgetTaskKind: executionIntentContext.documentWidgetTaskKind,
        documentWidgetProfile: executionIntentContext.documentWidgetProfile,
        browserDecisionMode: browserDecision.mode,
      })
      if (toolPolicy.forceDocumentTool) {
        session.lastDocumentContextInput = contextualUserInput
      }

      log(`provider=${config.provider}, baseUrl=${baseUrl}, model=${config.model}, agentProtocol=${capabilities?.agentProtocol || (useAnthropicProtocol ? 'anthropic' : 'openai')}, wireApi=${capabilities?.wireApi || 'n/a'}, toolCallTransport=${capabilities?.toolCallTransport || 'native'}, hasTools=${resolvedToolVisibilityPlan.hasTools}, supportsVision=${capabilities?.supportsVision ?? true}, supportsNativeVideo=${capabilities?.supportsNativeVideo ?? supportsVideoBlock}, forceDocumentTool=${toolPolicy.forceDocumentTool}, forceDesignTool=${toolPolicy.forceDesignTool}, preferredDesignTool=${toolPolicy.preferredDesignTool || 'none'}, allowMultipleDesignArtifacts=${toolPolicy.allowMultipleDesignArtifacts}, preferSectionRewrite=${toolPolicy.preferSectionRewrite}, preferFormatOnly=${toolPolicy.preferFormatOnly}, documentWidgetTaskKind=${toolPolicy.documentWidgetTaskKind || 'none'}, allowBrowserTools=${toolPolicy.allowBrowserTools}, preferredSkillTools=${toolPolicy.preferredSkillToolNames?.join('|') || 'all'}, hasVideoInputs=${hasVideoInputs}, incomingVideo=${hasRawVideoInIncoming}, keepToolsWithVideo=${resolvedToolVisibilityPlan.keepToolsWithVideo}, isKimi=${isKimi}, isKimiCoding=${isKimiCoding}, anthropicProtocol=${useAnthropicProtocol}`)

      if (hasTools) {
        await this.skillContextOrchestrator.maybeInjectExplicitSkillContext({
          userText,
          session,
          sessionId,
          emitOutput,
          emitToolAction,
          executeTool: async (tool, args) => executeToolCall(tool, args, {
            browserController: this.browserController,
            sidecarManager: this.sidecarManager,
            emitToolAction,
            requestModuleToolAction,
            abortSignal: abortController.signal,
            sessionId,
          }),
        })
      }

      const preparedBrowserExecution = await this.browserDomainOrchestrator.prepareBrowserExecution({
        hasTools,
        browserControllerAvailable: Boolean(this.browserController),
        browserAgentEnabled: this.isBrowserAgentV3Enabled(),
        userText,
        pureUserInput,
        sessionMessages: session.messages,
        sessionId,
        refineDecision: async (decision) => this.browserDomainOrchestrator.refineUploadDecision({
          decision,
          sessionId,
          userText,
          explicitSkillRequested: this.skillContextOrchestrator.findExplicitlyRequestedSkills(userText).length > 0,
          requestPromptDraft: async (planningPrompt) => {
            const planningSession: DirectChatSession = {
              ...session,
              messages: [...session.messages, { role: 'user', content: planningPrompt }],
              abortController: null,
            }
            return isKimiCoding
              ? this.kimiCodingClient.requestSimple({
                session: planningSession,
                config,
                baseUrl,
                signal: abortController.signal,
              }).then((result) => result.text)
              : useAnthropicProtocol
                ? this.anthropicExecutionClient.requestSimple({
                  session: planningSession,
                  config,
                  baseUrl,
                  signal: abortController.signal,
                }).then((result) => result.text)
                : this.openAIExecutionClient.requestSimple({
                  session: planningSession,
                  config,
                  baseUrl,
                  provider,
                  signal: abortController.signal,
                  isKimi,
                  enableKimiWebSearch: false,
                }).then((result) => result.text)
          },
          onRefineSkipped: (reason) => {
            log(`browser prompt refiner skipped: ${reason}`)
          },
        }),
      })
      browserDecision = preparedBrowserExecution.browserDecision
      ;({ visibilityPlan: resolvedToolVisibilityPlan, toolPolicy } = buildExecutionToolState({
        supportsToolCalls: capabilities?.supportsToolCalls ?? true,
        hasVideoInputs,
        hasIncomingVideo: hasRawVideoInIncoming,
        keepToolsWithVideo,
        preferredSkillToolNames,
        contextualUserInput,
        userInstructionText,
        hasWidgetTargetContext: executionIntentContext.hasWidgetTargetContext,
        explicitWidgetCreateIntent: executionIntentContext.explicitWidgetCreateIntent,
        documentWidgetTaskKind: executionIntentContext.documentWidgetTaskKind,
        documentWidgetProfile: executionIntentContext.documentWidgetProfile,
        browserDecisionMode: browserDecision.mode,
      }))
      log(
        `browserDecision mode=${browserDecision.mode} reason=${browserDecision.reason} ` +
        `sessionId=${sessionId || 'none'} attachmentCount=${browserDecision.attachmentSelection?.count || 0} ` +
        `incomingAttachmentCount=${incomingAttachmentHints.count || 0} ` +
        `promptConfidence=${browserDecision.promptIntent?.confidence || 'none'} ` +
        `targetUrl=${browserDecision.plan?.targetUrl || browserDecision.plan?.resources?.links?.[0]?.url || 'none'} ` +
        `stepCount=${browserDecision.plan?.steps?.length || 0}`,
      )

      const browserExecutionDispatch = this.browserDomainOrchestrator.resolveExecutionDispatch({
        hasTools,
        browserControllerAvailable: Boolean(this.browserController),
        browserDecision,
        browserContinuityInstruction: preparedBrowserExecution.browserContinuityInstruction,
        clarifyText: preparedBrowserExecution.clarifyText,
        canUseDeterministicBrowserRunner: preparedBrowserExecution.canUseDeterministicBrowserRunner,
        shouldInspectAmbiguousModeEntry: preparedBrowserExecution.shouldInspectAmbiguousModeEntry,
      })

      if (browserExecutionDispatch.continuityInstruction) {
        session.messages.push({ role: 'user', content: browserExecutionDispatch.continuityInstruction })
        log('Injected browser continuity instruction')
      }

      if (browserExecutionDispatch.kind === 'clarify' && browserExecutionDispatch.responseText) {
        emitOutput(browserExecutionDispatch.responseText, 'text')
        session.messages.push({ role: 'assistant', content: browserExecutionDispatch.responseText })
        emitOutput('', 'done')
        emitStatus('done')
        return { success: true, executionDiagnostics: buildExecutionDiagnostics() }
      }

      if (browserExecutionDispatch.fallbackLog) {
        log(browserExecutionDispatch.fallbackLog)
      }

      if (browserExecutionDispatch.kind === 'deterministic' && this.browserController) {
        log(`browserDecision mode=${browserDecision.mode} handled by deterministic runner`)
        const browserResult = await this.browserDomainOrchestrator.runDeterministicExecution({
          browserController: this.browserController,
          abortSignal: abortController.signal,
          sessionId,
          decision: browserDecision,
          userText,
          emitToolEvent: (type, text) => {
            emitOutput(text, type)
          },
        })
        if (browserResult.handled) {
          emitOutput(browserResult.message, 'text')
          session.messages.push({ role: 'assistant', content: browserResult.message })
          emitOutput('', 'done')
          emitStatus(browserResult.state === 'cancelled' ? 'cancelled' : browserResult.state === 'failed' ? 'error' : 'done')
          return { success: true, executionDiagnostics: buildExecutionDiagnostics() }
        }
      }

      if (browserExecutionDispatch.kind === 'tool_loop' && browserExecutionDispatch.toolLoopMessage) {
        session.messages.push({ role: 'user', content: browserExecutionDispatch.toolLoopMessage })
        log(`Injected structured browser plan with ${browserDecision.plan?.steps?.length || 0} steps`)
      }

      const openclawCommand = this.extractOpenclawPairingCommand(userText)
      if (hasTools && openclawCommand) {
        const toolContext = buildToolRuntimeContext({
          browserController: this.browserController,
          sidecarManager: this.sidecarManager,
          runtime: this.runtime,
          emitToolAction: (tool, args) => {
            emitToolAction(tool, args)
          },
          requestModuleToolAction,
          abortSignal: abortController.signal,
          sessionId,
        })
        emitOutput(`system_run_openclaw(${JSON.stringify({ command: openclawCommand }).slice(0, 120)})`, 'tool_use')
        const result = await executeToolCall('system_run_openclaw', { command: openclawCommand }, toolContext)
        emitOutput(result.slice(0, 300), 'tool_result')
        emitOutput(result, 'text')
        session.messages.push({ role: 'assistant', content: result })
        emitOutput('', 'done')
        emitStatus('done')
        return { success: true, executionDiagnostics: buildExecutionDiagnostics() }
      }

      if (
        hasTools &&
        hasDocumentEnvironment &&
        toolPolicy.forceDocumentTool &&
        (toolPolicy.preferFormatOnly || toolPolicy.preferSectionRewrite)
      ) {
        const deterministicDocumentToolContext = buildToolRuntimeContext({
          browserController: this.browserController,
          sidecarManager: this.sidecarManager,
          runtime: this.runtime,
          emitToolAction: (tool, args) => {
            emitToolAction(tool, args)
          },
          requestModuleToolAction,
          abortSignal: abortController.signal,
          sessionId,
        })

        const deterministicHandled = toolPolicy.preferFormatOnly
          ? await this.documentDomainOrchestrator.tryDeterministicSectionFormatFlow({
            agentName: name,
            userText,
            toolContext: deterministicDocumentToolContext,
            onAssistantSummary: (summary) => {
              session.messages.push({ role: 'assistant', content: summary })
            },
          })
          : await this.documentDomainOrchestrator.tryDeterministicSectionRewriteFlow({
            agentName: name,
            session,
            config,
            baseUrl,
            provider,
            signal: abortController.signal,
            isKimi,
            isKimiCoding,
            useAnthropicProtocol,
            userText,
            toolContext: deterministicDocumentToolContext,
            onAssistantSummary: (summary) => {
              session.messages.push({ role: 'assistant', content: summary })
            },
          })

        if (deterministicHandled) {
          emitOutput('', 'done')
          emitStatus('done')
          return { success: true, executionDiagnostics: buildExecutionDiagnostics() }
        }
      }

      if (!hasTools) {
        // No tool calling — original simple path
        let simpleResponse: { text: string; fallback?: ExecutionFallbackInfo }
        const hasMediaInputs = this.sessionHasMediaInputs(session.messages)
        if (isKimiCoding) {
          simpleResponse = await this.kimiCodingClient.requestSimple({
            session,
            config,
            baseUrl,
            signal: abortController.signal,
            hasVideoInputs,
            buildVideoFrameFallbackMessages: hasVideoInputs
              ? () => this.videoFallbackService.buildVideoFrameFallbackMessages(session.messages)
              : undefined,
            assignFallbackMessages: (fallbackMessages) => {
              session.messages = fallbackMessages as ChatMessage[]
            },
            fallbackToAnthropic: ({ messagesOverride }) => this.anthropicExecutionClient.requestSimple({
              session,
              config,
              baseUrl,
              signal: abortController.signal,
              messagesOverride: messagesOverride as ChatMessage[] | undefined,
            }),
          })
        } else if (useAnthropicProtocol) {
          simpleResponse = await this.anthropicExecutionClient.requestSimple({
            session,
            config,
            baseUrl,
            signal: abortController.signal,
            hasVideoInputs,
            buildVideoFrameFallbackMessages: hasVideoInputs
              ? () => this.videoFallbackService.buildVideoFrameFallbackMessages(session.messages)
              : undefined,
            onFallbackApplied: (fallbackMessages) => {
              session.messages = fallbackMessages
            },
          })
        } else {
          simpleResponse = await this.openAIExecutionClient.requestSimple({
            session,
            config,
            baseUrl,
            provider,
            signal: abortController.signal,
            isKimi,
            enableKimiWebSearch: !hasMediaInputs,
          })
        }

        if (simpleResponse.fallback) {
          latestFallback = simpleResponse.fallback
        }
        const text = simpleResponse.text
        if (text) {
          emitOutput(text, 'text')
          session.messages.push({ role: 'assistant', content: text })
        }
      } else {
        // Tool calling loop
        const envRaw = process.env.READY_MAX_TOOL_ITERATIONS
        const envValue = Number(envRaw)
        const configuredMaxToolIterations = Number.isFinite(envValue) && envValue > 0
          ? Math.min(80, Math.max(8, Math.round(envValue)))
          : this.maxToolIterations
        let documentToolLoopState = this.documentToolLoopOrchestrator.createState()
        let designToolLoopState = this.designToolLoopOrchestrator.createState()
        effectiveRunBudget = applyRunBudgetHint(
          effectiveRunBudget || createRunBudgetSeed(),
          this.browserDomainOrchestrator.getBudgetHint({
            userText,
            decision: browserDecision,
            baseMaxToolIterations: configuredMaxToolIterations,
          }),
        )
        effectiveRunBudget = applyRunBudgetHint(
          effectiveRunBudget,
          this.documentToolLoopOrchestrator.getBudgetHint({
            forceDocumentTool: toolPolicy.forceDocumentTool,
            state: documentToolLoopState,
          }),
        )
        effectiveRunBudget = applyRunBudgetHint(
          effectiveRunBudget,
          this.designToolLoopOrchestrator.getBudgetHint({
            forceDesignTool: toolPolicy.forceDesignTool,
            primaryArtifactProduced: designToolLoopState.primaryArtifactProduced,
          }),
        )
        const baseMaxToolIterations = effectiveRunBudget.maxIterations > 0
          ? effectiveRunBudget.maxIterations
          : configuredMaxToolIterations
        const recommendedMaxToolIterations = this.browserDomainOrchestrator.getRecommendedToolLoopIterations(
          userText,
          browserDecision,
          baseMaxToolIterations,
        )
        const effectiveMaxToolIterations = effectiveRunBudget.maxIterations > 0
          ? Math.min(recommendedMaxToolIterations, effectiveRunBudget.maxIterations)
          : recommendedMaxToolIterations
        let iterations = 0
        let finishedBeforeLimit = false
        let textToolBridgeNudges = 0
        let budgetLimitedBeforeCompletion = false

        // Inject tool guidance into system prompt based on intent
        const toolGuidance = buildToolGuidance(toolPolicy)
        if (toolGuidance) {
          session.systemPrompt = `${session.systemPrompt}\n\n${toolGuidance}`
          log('Injected tool guidance into system prompt')
        }

        // 浏览器步骤追踪
        let browserToolLoopState = this.browserDomainOrchestrator.createToolLoopState(browserDecision)

        while (iterations < effectiveMaxToolIterations) {
          ensureNotAborted()
          iterations++
          if (runBudgetState) {
            Object.assign(runBudgetState, consumeIterationBudget(runBudgetState))
          }
          log(`Tool loop iteration ${iterations}`)

          // Get scope from runtime if available
          let scope: ConversationScope | undefined
          if (sessionId && this.runtime) {
            try {
              const result = this.runtime.getConversationScope(sessionId)
              scope = result || undefined
            } catch {
              scope = undefined
            }
          }

          const toolContext = buildToolRuntimeContext({
            browserController: this.browserController,
            sidecarManager: this.sidecarManager,
            runtime: this.runtime,
            scope,
            emitToolAction: (tool, args) => {
              emitToolAction(tool, args)
            },
            requestModuleToolAction,
            abortSignal: abortController.signal,
            sessionId,
          })

          let response: APIResponse
          ensureNotAborted()
          response = await this.executionLoopOrchestrator.requestToolLoopResponse({
            useAnthropicProtocol,
            hasVideoInputs,
            session,
            config,
            baseUrl,
            provider,
            signal: abortController.signal,
            policy: toolPolicy,
            callAnthropicWithTools: () => this.anthropicExecutionClient.requestWithTools({
              session,
              config,
              baseUrl,
              signal: abortController.signal,
              policy: toolPolicy,
            }),
            callOpenAIWithTools: () => this.openAIExecutionClient.requestWithTools({
              session,
              config,
              baseUrl,
              provider: provider!,
              signal: abortController.signal,
              policy: toolPolicy,
            }),
            buildVideoFrameFallbackMessages: () => this.videoFallbackService.buildVideoFrameFallbackMessages(session.messages),
            assignFallbackMessages: (messages) => {
              session.messages = messages as ChatMessage[]
            },
          })
          if (response.fallback) {
            latestFallback = response.fallback
          }

          // No tool calls — done
          if (response.toolCalls.length === 0) {
            if (response.toolTransport === 'text' && response.rawText) {
              session.messages.push({ role: 'assistant', content: response.rawText })
              if (looksLikeMissingNativeToolsReply(response.text || response.rawText) && textToolBridgeNudges < 2) {
                textToolBridgeNudges += 1
                session.messages.push({
                  role: 'user',
                  content: buildTextToolBridgeCorrectionMessage(toolPolicy),
                })
                log(`Text tool bridge correction injected, nudge=${textToolBridgeNudges}`)
                continue
              }
            }
            const documentNoToolDecision = this.documentToolLoopOrchestrator.handleNoToolCall({
              state: documentToolLoopState,
              forceDocumentTool: toolPolicy.forceDocumentTool,
              responseText: response.text,
              toolTransport: response.toolTransport,
            })
            documentToolLoopState = documentNoToolDecision.state
            if (documentNoToolDecision.nextUserMessage) {
              emitStructuredTaskPayload(this.documentToolLoopOrchestrator.buildStructuredTaskPayload({
                taskTitle: toolPolicy.documentWidgetTaskKind
                  ? '文档组件操作'
                  : toolPolicy.preferFormatOnly
                    ? '文档格式优化'
                    : toolPolicy.preferSectionRewrite
                      ? '章节改写'
                      : '文档修改',
                taskSummary: documentNoToolDecision.nextUserMessage,
                state: documentToolLoopState,
                phase: 'blocked',
              }))
              if (documentNoToolDecision.preserveAssistantText && response.text && response.toolTransport !== 'text') {
                session.messages.push({ role: 'assistant', content: response.text })
              }
              session.messages.push({
                role: 'user',
                content: documentNoToolDecision.nextUserMessage,
              })
              continue
            }
            if (documentNoToolDecision.finalText) {
              emitStructuredTaskPayload(this.documentToolLoopOrchestrator.buildStructuredTaskPayload({
                taskTitle: toolPolicy.documentWidgetTaskKind
                  ? '文档组件操作'
                  : toolPolicy.preferFormatOnly
                    ? '文档格式优化'
                    : toolPolicy.preferSectionRewrite
                      ? '章节改写'
                      : '文档修改',
                taskSummary: documentNoToolDecision.finalText,
                state: documentToolLoopState,
                phase: 'done',
              }))
              emitOutput(documentNoToolDecision.finalText, 'text')
              session.messages.push({ role: 'assistant', content: documentNoToolDecision.finalText })
              finishedBeforeLimit = true
              break
            }
            // REMOVED: forceDesignTool nudge mechanism
            // If LLM decides not to use tools, respect that decision
            if (response.text) {
              emitOutput(response.text, 'text')
            }
            if (response.text && response.toolTransport !== 'text') {
              session.messages.push({ role: 'assistant', content: response.text })
            }
            finishedBeforeLimit = true
            break
          }

          const designToolFilter = this.designToolLoopOrchestrator.filterToolCalls({
            toolCalls: response.toolCalls,
            policy: toolPolicy,
            primaryArtifactProduced: designToolLoopState.primaryArtifactProduced,
          })
          if (designToolFilter.droppedCount > 0) {
            log(`Single-artifact design guard dropped ${designToolFilter.droppedCount} extra design tool call(s)`)
          }
          if (designToolFilter.nextUserMessage) {
            emitStructuredTaskPayload(this.designToolLoopOrchestrator.buildStructuredTaskPayload({
              taskTitle: '设计任务',
              taskSummary: designToolFilter.nextUserMessage,
              state: designToolLoopState,
              phase: 'blocked',
            }))
            session.messages.push({
              role: 'user',
              content: designToolFilter.nextUserMessage,
            })
            log('Dropped repeated primary design artifact call after artifact already existed')
            continue
          }

          const toolCallsForIteration = designToolFilter.toolCalls
            .map((toolCall) => this.designToolLoopOrchestrator.applySourceInput(toolCall, toolPolicy))
          if (runBudgetState) {
            const remainingToolCallBudget = getRemainingToolCallBudget(effectiveRunBudget, runBudgetState)
            if (remainingToolCallBudget < toolCallsForIteration.length) {
              log(`Tool loop hit tool-call budget (${runBudgetState.toolCallsUsed}/${effectiveRunBudget.maxToolCalls})`)
              budgetLimitedBeforeCompletion = true
              break
            }
          }

          // Execute tool calls
          let executedDocActionCount = 0
          let executedMutatingDocActionCount = 0
          let executedInspectionDocActionCount = 0
          let executedSaveDocActionCount = 0
          let executedBrowserToolsThisIteration = 0
          let executedPrimaryDesignToolThisIteration = false
          const documentToolResultsThisIteration: string[] = []
          if (useAnthropicProtocol) {
            // For Anthropic: assistant message contains both text + tool_use blocks
            const assistantContent: Array<Record<string, unknown>> = []
            if (response.text) {
              emitOutput(response.text, 'text')
              assistantContent.push({ type: 'text', text: response.text })
            }
            for (const tc of toolCallsForIteration) {
              assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
            }
            session.messages.push({ role: 'assistant', content: assistantContent })

            // Execute each tool and collect results
            const toolResults: Array<Record<string, unknown>> = []
            const executedToolBatch = await this.executionLoopOrchestrator.executeToolCalls({
              toolCalls: toolCallsForIteration,
              budget: effectiveRunBudget,
              budgetState: runBudgetState,
              onGroupStart: (group) => {
                if (runBudgetState && group.mode === 'parallel') {
                  Object.assign(runBudgetState, consumeParallelGroupBudget(runBudgetState))
                }
              },
              executeTool: async (toolCall) => {
                ensureNotAborted()
                emitOutput(`${toolCall.name}(${JSON.stringify(toolCall.input).slice(0, 100)})`, 'tool_use')
                const result = await executeToolCall(toolCall.name, toolCall.input, toolContext)
                ensureNotAborted()
                log(`tool execute: ${toolCall.name}, result=${result.slice(0, 140)}`)
                return result
              },
            })
            const executedToolResults = executedToolBatch.results
            if (runBudgetState) {
              Object.assign(runBudgetState, consumeToolCallBudget(runBudgetState, executedToolResults.length))
              if (executedToolBatch.budgetLimited || getRemainingToolCallBudget(effectiveRunBudget, runBudgetState) <= 0) {
                budgetLimitedBeforeCompletion = true
              }
            } else if (executedToolBatch.budgetLimited) {
              budgetLimitedBeforeCompletion = true
            }
            for (const executedTool of executedToolResults) {
              const result = executedTool.result
              const toolName = executedTool.name
              const documentToolInspection = inspectDocumentToolCall(toolName, result)
              if (documentToolInspection.isDocumentTool) {
                documentToolResultsThisIteration.push(result)
                executedDocActionCount += documentToolInspection.executedDocActionCount
                executedMutatingDocActionCount += documentToolInspection.executedMutatingDocActionCount
                executedInspectionDocActionCount += documentToolInspection.executedInspectionDocActionCount
                executedSaveDocActionCount += documentToolInspection.executedSaveDocActionCount
                documentToolLoopState = this.documentToolLoopOrchestrator.applyToolInspection(
                  documentToolLoopState,
                  documentToolInspection,
                )
              }
              if (toolName.startsWith('browser_')) {
                executedBrowserToolsThisIteration += 1
              }
              const designResult = this.designToolLoopOrchestrator.recordToolResult({
                state: designToolLoopState,
                toolName,
                rawResult: result,
                policy: toolPolicy,
              })
              if (designResult.isPrimaryArtifact) {
                executedPrimaryDesignToolThisIteration = true
                designToolLoopState = designResult.state
              }
              emitOutput(result.slice(0, 200), 'tool_result')
              toolResults.push({ type: 'tool_result', tool_use_id: executedTool.id, content: result })
            }
            session.messages.push({ role: 'user', content: toolResults })
          } else {
            if (response.toolTransport === 'text') {
              const historyText = response.rawText || response.text
              if (historyText) {
                session.messages.push({ role: 'assistant', content: historyText })
              }
              if (response.text) {
                emitOutput(response.text, 'text')
              }

              const textBridgeResults: Array<{ id: string; name: string; result: string }> = []
              const executedToolBatch = await this.executionLoopOrchestrator.executeToolCalls({
                toolCalls: toolCallsForIteration,
                budget: effectiveRunBudget,
                budgetState: runBudgetState,
                onGroupStart: (group) => {
                  if (runBudgetState && group.mode === 'parallel') {
                    Object.assign(runBudgetState, consumeParallelGroupBudget(runBudgetState))
                  }
                },
                executeTool: async (toolCall) => {
                  ensureNotAborted()
                  emitOutput(`${toolCall.name}(${JSON.stringify(toolCall.input).slice(0, 100)})`, 'tool_use')
                  const result = await executeToolCall(toolCall.name, toolCall.input, toolContext)
                  ensureNotAborted()
                  log(`tool execute: ${toolCall.name}, result=${result.slice(0, 140)}`)
                  return result
                },
              })
              const executedToolResults = executedToolBatch.results
              if (runBudgetState) {
                Object.assign(runBudgetState, consumeToolCallBudget(runBudgetState, executedToolResults.length))
                if (executedToolBatch.budgetLimited || getRemainingToolCallBudget(effectiveRunBudget, runBudgetState) <= 0) {
                  budgetLimitedBeforeCompletion = true
                }
              } else if (executedToolBatch.budgetLimited) {
                budgetLimitedBeforeCompletion = true
              }
              for (const executedTool of executedToolResults) {
                const result = executedTool.result
                const toolName = executedTool.name
                const documentToolInspection = inspectDocumentToolCall(toolName, result)
                if (documentToolInspection.isDocumentTool) {
                  documentToolResultsThisIteration.push(result)
                  executedDocActionCount += documentToolInspection.executedDocActionCount
                  executedMutatingDocActionCount += documentToolInspection.executedMutatingDocActionCount
                  executedInspectionDocActionCount += documentToolInspection.executedInspectionDocActionCount
                  executedSaveDocActionCount += documentToolInspection.executedSaveDocActionCount
                  documentToolLoopState = this.documentToolLoopOrchestrator.applyToolInspection(
                    documentToolLoopState,
                    documentToolInspection,
                  )
                }
                if (toolName.startsWith('browser_')) {
                  executedBrowserToolsThisIteration += 1
                }
                const designResult = this.designToolLoopOrchestrator.recordToolResult({
                  state: designToolLoopState,
                  toolName,
                  rawResult: result,
                  policy: toolPolicy,
                })
                if (designResult.isPrimaryArtifact) {
                  executedPrimaryDesignToolThisIteration = true
                  designToolLoopState = designResult.state
                }
                emitOutput(result.slice(0, 200), 'tool_result')
                textBridgeResults.push({ id: executedTool.id, name: toolName, result })
              }
              if (textBridgeResults.length > 0) {
                session.messages.push({ role: 'user', content: buildTextToolResultMessage(textBridgeResults) })
              }
            } else {
              // For OpenAI: assistant message with tool_calls, then separate tool messages
              const assistantMsg: Record<string, unknown> = {
                role: 'assistant',
                content: response.text || null,
                  tool_calls: toolCallsForIteration.map(tc => ({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: JSON.stringify(tc.input) }
                }))
              }
              if (response.providerResponseId) {
                assistantMsg.response_id = response.providerResponseId
              }
              if (response.reasoningContent !== undefined || isKimiCoding) {
                assistantMsg.reasoning_content = response.reasoningContent ?? ''
              }
              session.messages.push(assistantMsg as unknown as ChatMessage)
              if (response.text) {
                emitOutput(response.text, 'text')
              }

              const executedToolBatch = await this.executionLoopOrchestrator.executeToolCalls({
                toolCalls: toolCallsForIteration,
                budget: effectiveRunBudget,
                budgetState: runBudgetState,
                onGroupStart: (group) => {
                  if (runBudgetState && group.mode === 'parallel') {
                    Object.assign(runBudgetState, consumeParallelGroupBudget(runBudgetState))
                  }
                },
                executeTool: async (toolCall) => {
                  ensureNotAborted()
                  emitOutput(`${toolCall.name}(${JSON.stringify(toolCall.input).slice(0, 100)})`, 'tool_use')
                  const result = await executeToolCall(toolCall.name, toolCall.input, toolContext)
                  ensureNotAborted()
                  log(`tool execute: ${toolCall.name}, result=${result.slice(0, 140)}`)
                  return result
                },
              })
              const executedToolResults = executedToolBatch.results
              if (runBudgetState) {
                Object.assign(runBudgetState, consumeToolCallBudget(runBudgetState, executedToolResults.length))
                if (executedToolBatch.budgetLimited || getRemainingToolCallBudget(effectiveRunBudget, runBudgetState) <= 0) {
                  budgetLimitedBeforeCompletion = true
                }
              } else if (executedToolBatch.budgetLimited) {
                budgetLimitedBeforeCompletion = true
              }
              for (const executedTool of executedToolResults) {
                const result = executedTool.result
                const toolName = executedTool.name
                const documentToolInspection = inspectDocumentToolCall(toolName, result)
                if (documentToolInspection.isDocumentTool) {
                  documentToolResultsThisIteration.push(result)
                  executedDocActionCount += documentToolInspection.executedDocActionCount
                  executedMutatingDocActionCount += documentToolInspection.executedMutatingDocActionCount
                  executedInspectionDocActionCount += documentToolInspection.executedInspectionDocActionCount
                  executedSaveDocActionCount += documentToolInspection.executedSaveDocActionCount
                  documentToolLoopState = this.documentToolLoopOrchestrator.applyToolInspection(
                    documentToolLoopState,
                    documentToolInspection,
                  )
                }
                if (toolName.startsWith('browser_')) {
                  executedBrowserToolsThisIteration += 1
                }
                const designResult = this.designToolLoopOrchestrator.recordToolResult({
                  state: designToolLoopState,
                  toolName,
                  rawResult: result,
                  policy: toolPolicy,
                })
                if (designResult.isPrimaryArtifact) {
                  executedPrimaryDesignToolThisIteration = true
                  designToolLoopState = designResult.state
                }
                emitOutput(result.slice(0, 200), 'tool_result')
                session.messages.push({ role: 'tool' as 'system', content: result, ...({ tool_call_id: executedTool.id } as Record<string, unknown>) } as ChatMessage)
              }
            }
          }

          // 浏览器步骤追踪：检测 AI 声明完成当前步骤，并注入检查点提醒
          if (browserToolLoopState.isBrowserTask && executedBrowserToolsThisIteration > 0) {
            const progress = this.browserDomainOrchestrator.recordToolLoopProgress({
              state: browserToolLoopState,
              responseText: response.text,
              executedBrowserToolsThisIteration,
            })
            browserToolLoopState = progress.state
            if (progress.advancedStepIndex !== null) {
              log(`Browser step advanced to ${progress.advancedStepIndex}/${browserToolLoopState.steps.length}`)
            }
            if (progress.checkpointMessage) {
              session.messages.push({ role: 'user', content: progress.checkpointMessage })
              log(`Injected browser checkpoint at step ${browserToolLoopState.stepIndex + 1}/${browserToolLoopState.steps.length}`)
            }
          }

          const documentIterationDecision = this.documentToolLoopOrchestrator.handleIterationResult({
            state: documentToolLoopState,
            forceDocumentTool: toolPolicy.forceDocumentTool,
            documentWidgetTaskKind: toolPolicy.documentWidgetTaskKind,
            executedDocActionCount,
            executedMutatingDocActionCount,
            executedInspectionDocActionCount,
            executedSaveDocActionCount,
            documentToolResultsThisIteration,
          })
          documentToolLoopState = documentIterationDecision.state
          if (documentIterationDecision.nextUserMessage) {
            if (!budgetLimitedBeforeCompletion) {
              emitStructuredTaskPayload(this.documentToolLoopOrchestrator.buildStructuredTaskPayload({
                taskTitle: toolPolicy.documentWidgetTaskKind
                  ? '文档组件操作'
                  : toolPolicy.preferFormatOnly
                    ? '文档格式优化'
                    : toolPolicy.preferSectionRewrite
                      ? '章节改写'
                      : '文档修改',
                taskSummary: documentIterationDecision.nextUserMessage,
                state: documentToolLoopState,
                phase: 'blocked',
              }))
              session.messages.push({
                role: 'user',
                content: documentIterationDecision.nextUserMessage,
              })
              continue
            }
          }

          if (documentIterationDecision.completionText) {
            emitStructuredTaskPayload(this.documentToolLoopOrchestrator.buildStructuredTaskPayload({
              taskTitle: toolPolicy.documentWidgetTaskKind
                ? '文档组件操作'
                : toolPolicy.preferFormatOnly
                  ? '文档格式优化'
                  : toolPolicy.preferSectionRewrite
                    ? '章节改写'
                    : '文档修改',
              taskSummary: documentIterationDecision.completionText,
              state: documentToolLoopState,
              phase: 'done',
            }))
            emitOutput(documentIterationDecision.completionText, 'text')
            session.messages.push({ role: 'assistant', content: documentIterationDecision.completionText })
            finishedBeforeLimit = true
            break
          }

          if (
            toolPolicy.forceDesignTool &&
            !toolPolicy.allowMultipleDesignArtifacts &&
            executedPrimaryDesignToolThisIteration
          ) {
            const completionText = this.designToolLoopOrchestrator.buildCompletionText(designToolLoopState)
            if (completionText) {
              emitStructuredTaskPayload(this.designToolLoopOrchestrator.buildStructuredTaskPayload({
                taskTitle: '设计任务',
                taskSummary: completionText,
                state: designToolLoopState,
                phase: 'done',
              }))
              emitOutput(completionText, 'text')
              session.messages.push({ role: 'assistant', content: completionText })
            }
            finishedBeforeLimit = true
            log(`Completed single-artifact design run after primary design tool with status=${String(designToolLoopState.lastPrimaryDesignToolPayload?.status || 'unknown')}`)
            break
          }

          if (budgetLimitedBeforeCompletion) {
            break
          }

        }

        if (!finishedBeforeLimit && (iterations >= effectiveMaxToolIterations || budgetLimitedBeforeCompletion)) {
          log(
            budgetLimitedBeforeCompletion
              ? 'Tool loop hit tool budget before completion'
              : `Tool loop hit max iterations (${effectiveMaxToolIterations})`,
          )
          const browserLimitMessage = this.browserDomainOrchestrator.buildToolLoopLimitMessage(browserToolLoopState)
          if (browserLimitMessage) {
            log(`Browser task incomplete: step ${browserToolLoopState.stepIndex + 1}/${browserToolLoopState.steps.length}`)
            session.messages.push({
              role: 'user',
              content: browserLimitMessage,
            })
          }
          emitOutput(
            budgetLimitedBeforeCompletion
              ? '\n[已达到本轮工具预算上限，请总结当前进度并建议下一步重试方式]'
              : '\n[已达到最大工具调用次数，请尝试让助手使用 browser_run_workflow 或 browser_download_urls 批量执行后重试]',
            'text',
          )
        }
      }

      emitOutput('', 'done')
      emitStatus('done')
      return { success: true, executionDiagnostics: buildExecutionDiagnostics() }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        emitOutput('', 'done')
        emitStatus('cancelled')
        return { success: true, executionDiagnostics: buildExecutionDiagnostics() }
      }
      const msg = error instanceof Error ? error.message : String(error)
      log(`Error: ${msg}`)
      emitOutput(`API 请求失败: ${msg}`, 'error')
      emitOutput('', 'done')
      emitRuntimeError(msg)
      emitStatus('error')
      return { success: false, error: msg, executionDiagnostics: buildExecutionDiagnostics() }
    } finally {
      if (session.abortController === abortController) {
        session.abortController = null
      }
      if (session.activeRunId === runId) {
        session.activeRunId = null
      }
    }
  }

  private extractIncomingText(content: string | MultimodalBlock[] | Array<Record<string, unknown>>): string {
    if (typeof content === 'string') return content
    return content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => String(block.text || ''))
      .join('\n')
  }

  private extractPrimaryUserInstruction(raw: string): string {
    return extractPrimaryUserInstructionFromText(raw)
  }

  private extractOpenclawPairingCommand(userText: string): string | null {
    const text = String(userText || '').trim()
    if (!text) return null
    const direct = text.match(/^\s*(openclaw\s+pairing\s+[^\n\r]+)\s*$/i)
    if (direct) return direct[1].trim()
    const embedded = text.match(/\b(openclaw\s+pairing\s+approve\s+\S+\s+\S+)\b/i)
    if (embedded) return embedded[1].trim()
    return null
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
        return { role: m.role, content: parts }
      }
      // OpenAI format — pass through as-is (handles tool role, tool_call_id etc.)
      return { ...m } as Record<string, unknown>
    })
  }

  private sessionHasMediaInputs(messages: ChatMessage[]): boolean {
    return messages.some((msg) => {
      if (!Array.isArray(msg.content)) return false
      return msg.content.some((block) => {
        if (!block || typeof block !== 'object') return false
        return block.type === 'image' || block.type === 'video'
      })
    })
  }

  private sessionHasVideoInputs(messages: ChatMessage[]): boolean {
    return messages.some((msg) => {
      if (!Array.isArray(msg.content)) return false
      return msg.content.some((block) => block?.type === 'video')
    })
  }

  cleanup(): void {
    for (const [name] of this.sessions) {
      this.stopGeneration(name)
    }
    this.sessions.clear()
  }
}
