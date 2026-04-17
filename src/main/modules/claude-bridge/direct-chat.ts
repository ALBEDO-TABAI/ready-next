/**
 * Direct HTTP chat engine.
 * Bypasses Claude CLI — calls AI provider APIs directly for fast response.
 * Supports tool calling for browser control and other integrations.
 */

import { EventEmitter } from 'events'
import { createHash, randomUUID } from 'crypto'
import { appendFileSync, existsSync } from 'fs'
import { AIModelConfig, getProviderDef, normalizeAIConfig, resolveAIConfigCapabilities } from '../../../shared/ai-providers'
import { BrowserController } from '../browser-engine/ipc-handler'
import type { SidecarManager } from '../agent-control/sidecar-manager'
import { BrowserDomainOrchestrator } from '../agent-control/browser-domain-orchestrator'
import { BrowserDomainAdapter } from '../agent-control/browser-domain-adapter'
import { BrowserTaskPlanner } from '../agent-control/browser-task-planner'
import type { DomainAdapter } from '../agent-control/domain-adapter'
import { DesignToolLoopOrchestrator } from '../agent-control/design-tool-loop-orchestrator'
import { FeishuDomainAdapter } from '../agent-control/feishu-domain-adapter'
import { DocumentDomainOrchestrator } from '../agent-control/document-domain-orchestrator'
import { DocumentDomainAdapter } from '../agent-control/document-domain-adapter'
import { DocumentToolLoopOrchestrator } from '../agent-control/document-tool-loop-orchestrator'
import { ExecutionLoopOrchestrator } from '../agent-control/execution-loop-orchestrator'
import { HostCapabilityDispatcher } from '../agent-control/host-capability-dispatcher'
import { CalendarDomainAdapter } from '../agent-control/calendar-domain-adapter'
import { RSSDomainAdapter } from '../agent-control/rss-domain-adapter'
import {
  DocumentTaskPipeline,
  type ActiveDocumentSnapshot,
  type DocumentInsight,
  type DocumentInsightMetrics,
  type DocumentInsightStageResult,
  type DocumentTaskPipelinePhaseUpdate,
  type DocumentWidgetDraft,
} from '../agent-control/document-task-pipeline'
import { DocumentInsightCache } from '../agent-control/document-insight-cache'
import { buildDocumentInsightSourceMaterial } from '../agent-control/document-source-materials'
import { runDocumentTaskPlanWithSubtasks } from '../agent-control/document-task-subtask-runner'
import { buildDocumentTaskStepCacheKey } from '../agent-control/document-task-cache-key'
import type { DocumentTaskJob, DocumentTaskPlan, DocumentTaskStep } from '../agent-control/document-task-plan'
import {
  buildContinuationStateFromProjection,
  parseContinuationControlText,
  sanitizeContinuationRequest,
  selectContinuationProjection,
  type ContinuationState,
} from '../agent-control/continuation-state'
import { prepareInitialRun, reconcileAfterBrowserDecision } from '../agent-control/run-capability-controller'
import { SkillDomainAdapter } from '../agent-control/skill-domain-adapter'
import { SkillContextOrchestrator } from '../agent-control/skill-context-orchestrator'
import { buildToolRuntimeContext } from '../agent-control/tool-runtime-context-builder'
import { SubtaskRuntime } from '../agent-control/subtask-runtime'
import { TurnEngine } from '../agent-control/turn-engine'
import {
  createToolExecutionOutput,
  serializeToolExecutionOutput,
  type ToolExecutionOutput,
} from '../agent-control/tool-result-types'
import { getToolResourceTag } from '../agent-control/tool-parallelism-policy'
import {
  applyRunBudgetHint,
  createStepBudgetState,
  createTaskBudgetRuntime,
  getBudgetWarningLevel,
  consumeIterationBudget,
  consumeParallelGroupBudget,
  consumeToolCallBudget,
  createRunBudgetSeed,
  refundIterationBudget,
  getBudgetUsagePercent,
  getRemainingToolCallBudget,
  rebindTaskBudgetRuntime,
  restoreContinuationTaskBudgetRuntime,
} from '../agent-control/run-budget-policy'
import {
  buildTextToolBridgeCorrectionMessage,
  buildToolGuidance,
} from '../agent-control/execution-tool-config'
import type {
  BudgetWarningLevel,
  RecoveryRecord,
  RunBudgetSeed,
  RunMessage,
  RunBudgetUsage,
  TaskBudgetRuntime,
  TaskProjectionRecord,
  TaskInteractionState,
  TaskType,
  ExecutionTurnResult,
  TurnModelResponse,
  TurnProviderContext,
  TurnShortcutResult,
  TurnSimpleResponse,
} from '../agent-control/run-contracts'
import type {
  BrowserTaskAttachmentResource,
  BrowserTaskDecision,
  BrowserTaskPlan,
  BrowserTaskPlanContinuity,
} from '../../../shared/browser-agent-task'
import {
  getContinuationState,
  domainsLikelyMatch,
  getBrowserWorkflowState,
  getLatestSkillRun,
  getRecentBrowserActions,
  rememberContinuationState,
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
  shouldEnforceBrowserToolRetry,
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
import { compressHistoryForPrompt } from '../agent-control/context-compression'
import { resolveExecutionIntentContext } from '../agent-control/execution-intent-resolver'
import type { IntentClassification } from '../agent-control/intent-classifier'
import { classifyIntent } from '../agent-control/intent-classifier'
import { detectGenericInteractionState } from '../agent-control/interaction-state-detector'
import type { RequestEnvelope, RequestEnvelopeResource } from '../agent-control/request-envelope'
import { buildRequestEnvelope, extractPureUserInput as extractPureUserInputFromEnvelope } from '../agent-control/request-envelope'
import {
  advanceTaskStepProgress,
  detectTaskStepCompletionCue,
  initializeTaskStepProgress,
} from '../agent-control/task-step-runtime'
import { resolveTaskType } from '../agent-control/task-type-resolver'
import { AnthropicExecutionClient } from './anthropic-execution-client'
import { KimiCodingClient } from './kimi-coding-client'
import { OpenAIExecutionClient } from './openai-execution-client'
import { VideoFallbackService } from './video-fallback-service'
import { getLogPath } from '../../utils/platform'
import { readDocumentEditableText } from '../document-engine/ipc-handler'
import type { DocumentWidgetComponentSpec } from '../../../shared/document-widget-openui'
import { buildFocusedDocumentContext } from '../../../shared/document-sectioning'

const LOG = getLogPath('ready-directchat.log')
const settingsRepository = new AppSettingsRepository()
const chatRepository = new ChatRepository()

function log(msg: string) {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`) } catch { /* */ }
}

function toContinuationUpdatedAt(value?: string | null): number {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : Date.now()
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
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
  documentInsightCache: Array<{
    key: string
    insight: DocumentInsight
    metrics?: DocumentInsightMetrics
    createdAt: string
  }>
  documentWidgetDraftCache: Array<{
    key: string
    draft: DocumentWidgetDraft
    createdAt: string
  }>
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
  recoveryHistory?: RecoveryRecord[]
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
当用户提到“上次那轮对话 / 之前讨论过 / 历史会话 / 旧会话里怎么说的 / 找找以前那次”时，优先使用 session_search 检索历史会话，再基于返回的会话摘要继续回答或引用，不要把 memory_search 当成历史聊天检索。

如果系统当前未启用工具，请不要伪造工具调用，直接给出文本回答。
`

export class DirectChatEngine extends EventEmitter {
  private sessions = new Map<string, DirectChatSession>()
  private readonly documentInsightCache = new DocumentInsightCache()
  private readonly documentWidgetDraftCache = new Map<string, DocumentWidgetDraft>()
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
  private readonly hostCapabilityDispatcher: HostCapabilityDispatcher
  private readonly domainAdapters: DomainAdapter[]
  private readonly turnEngine: TurnEngine
  private sidecarManager: SidecarManager | null = null
  private runtime: import('../agent-control/runtime').AgentControlRuntime | null = null
  private runCleanupRegistry: {
    registerRunCleanup: (runId: string, cleanup: () => void | Promise<void>) => void
  } | null = null
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
    this.hostCapabilityDispatcher = new HostCapabilityDispatcher({
      executeHostTool: (toolName, args, toolContext) => executeToolCall(toolName, args, toolContext as any),
    })
    this.domainAdapters = [
      new BrowserDomainAdapter(this.browserDomainOrchestrator as never),
      new DocumentDomainAdapter({
        orchestrator: this.documentDomainOrchestrator as never,
        toolLoopOrchestrator: this.documentToolLoopOrchestrator as never,
      }),
      new SkillDomainAdapter(),
      new RSSDomainAdapter(),
      new CalendarDomainAdapter(),
      new FeishuDomainAdapter(),
    ]
    this.turnEngine = new TurnEngine()
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

  hasBrowserController(): boolean {
    return Boolean(this.browserController)
  }

  setSidecarManager(manager: SidecarManager): void {
    this.sidecarManager = manager
    log('SidecarManager set on DirectChatEngine')
  }

  setRuntime(runtime: import('../agent-control/runtime').AgentControlRuntime): void {
    this.runtime = runtime
    log('Runtime set on DirectChatEngine')
  }

  setRunCleanupRegistry(registry: {
    registerRunCleanup: (runId: string, cleanup: () => void | Promise<void>) => void
  } | null): void {
    this.runCleanupRegistry = registry
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

  private extractLinks(text: string): string[] {
    const urlRegex = /https?:\/\/[^\s一-龥]+/gi
    return Array.from(text.matchAll(urlRegex)).map(m => m[0])
  }

  /**
   * Extract pure user input (remove auto-injected environment context and assistant messages)
   */
  private extractPureUserInput(userText: string): string {
    return extractPureUserInputFromEnvelope(userText)
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
      documentInsightCache: [],
      documentWidgetDraftCache: [],
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
      taskId?: string
      publicSessionId?: string
      requestEnvelope?: RequestEnvelope
      intentClassification?: IntentClassification
      budget?: RunBudgetSeed
      budgetState?: RunBudgetUsage
      taskBudgetRuntime?: TaskBudgetRuntime
      continuationState?: ContinuationState | null
    },
  ): Promise<ExecutionTurnResult> {
    const contentPreview = typeof content === 'string' ? content.slice(0, 80) : `[${content.length} blocks]`
    log(`sendMessage called: agent=${name}, content=${contentPreview}`)
    const runId = requestId || randomUUID()
    if (!this.sessions.has(name)) {
      this.newSession(name)
    }
    const session = this.sessions.get(name)!
    const taskId = executionOptions?.taskId || `task-${runId}`
    const executionSessionId = this.extractSessionIdFromInternalName(name)
    const sessionId = executionOptions?.publicSessionId || executionSessionId
    const rawContinuationUserText = typeof content === 'string'
      ? executionOptions?.requestEnvelope?.rawUserText || content
      : null
    const parsedContinuationControl = typeof rawContinuationUserText === 'string'
      ? parseContinuationControlText(rawContinuationUserText)
      : null
    const resolvedContinuationState = executionOptions?.continuationState
      || (
        typeof rawContinuationUserText === 'string'
          ? this.resolveContinuationState(sessionId, rawContinuationUserText, {
            parsedControl: parsedContinuationControl || undefined,
            explicitTaskId: parsedContinuationControl?.explicitTaskId || null,
            allowImplicitContinuation: parsedContinuationControl?.shouldResolveContinuation,
          })
          : null
      )
    const sanitizedContinuationRequest = typeof content === 'string' && parsedContinuationControl?.hasControlLines
      ? sanitizeContinuationRequest({
        content,
        rawUserText: rawContinuationUserText,
        requestEnvelope: executionOptions?.requestEnvelope || null,
      })
      : null
    const normalizedContent: string | MultimodalBlock[] = sanitizedContinuationRequest
      ? sanitizedContinuationRequest.content
      : content
    const normalizedRequestEnvelope = sanitizedContinuationRequest
      ? sanitizedContinuationRequest.requestEnvelope
      : executionOptions?.requestEnvelope
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

    const emitOutput = (
      chunk: string,
      type: string,
      options?: {
        projectionPatch?: Record<string, unknown> | null
      },
    ): void => {
      if (!isCurrentRun()) return
      this.emit('output', {
        agent: name,
        runId,
        taskId,
        chunk,
        type,
        projectionPatch: options?.projectionPatch || null,
      })
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
      return {
        success: false,
        error: '未配置 API Key',
        finalText: '',
        usedTools: [],
        cancelled: false,
        taskId,
        taskProjectionId: taskId,
        executionDiagnostics: {
          taskId,
          taskBudgetRuntime: executionOptions?.taskBudgetRuntime || null,
          fallback: buildExecutionFallbackState(null),
        },
      }
    }

    const capabilities = resolveAIConfigCapabilities(config)
    const normalizedBaseUrl = capabilities?.baseUrl || config.baseUrl.replace(/\/+$/, '')
    const isKimiCoding = !!capabilities?.isKimiCoding
    const useAnthropicProtocol = capabilities?.agentProtocol === 'anthropic'
    const supportsVideoBlock = capabilities?.supportsNativeVideo ?? (!normalizedBaseUrl.includes('/coding'))
    const hasRawVideoInIncoming = Array.isArray(normalizedContent) && normalizedContent.some((block) => block.type === 'video')

    // Build message content — support multimodal blocks
    if (Array.isArray(normalizedContent)) {
      // Convert MultimodalBlock[] to provider-internal format.
      const blocks: Array<Record<string, unknown>> = []
      for (const b of normalizedContent) {
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
      session.messages.push({ role: 'user', content: normalizedContent })
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
      const isKimi = isKimiCoding || (!useAnthropicProtocol && (baseUrl.includes('kimi') || baseUrl.includes('moonshot')))
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

      return await this.turnEngine.execute({
        runId,
        taskId,
        agentName: name,
        sessionId,
        session,
        content: normalizedContent,
        requestEnvelope: normalizedRequestEnvelope,
        intentClassification: executionOptions?.intentClassification,
        budget: executionOptions?.budget,
        budgetState: executionOptions?.budgetState,
        taskBudgetRuntime: executionOptions?.taskBudgetRuntime || null,
        continuationState: resolvedContinuationState,
        abortSignal: abortController.signal,
        ensureNotAborted,
        emitters: {
          emitOutput,
          emitStatus,
          emitRuntimeError,
          emitToolAction,
        },
        host: this.buildTurnEngineHost({
          name,
          runId,
          sessionId,
          requestModuleToolAction,
          providerContext: {
            config,
            baseUrl,
            provider,
            isKimi,
            isKimiCoding,
            useAnthropicProtocol,
            supportsToolCalls: capabilities?.supportsToolCalls ?? true,
            supportsVideoBlock,
            hasRawVideoInIncoming,
          },
        }),
      })
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        emitOutput('', 'done')
        emitStatus('cancelled')
        return {
          success: true,
          finalText: '',
          usedTools: [],
          cancelled: true,
          taskId,
          taskProjectionId: taskId,
        }
      }
      const msg = error instanceof Error ? error.message : String(error)
      log(`Error: ${msg}`)
      emitOutput(`API 请求失败: ${msg}`, 'error')
      emitOutput('', 'done')
      emitRuntimeError(msg)
      emitStatus('error')
      return {
        success: false,
        error: msg,
        finalText: '',
        usedTools: [],
        cancelled: false,
        taskId,
        taskProjectionId: taskId,
      }
    } finally {
      if (session.abortController === abortController) {
        session.abortController = null
      }
      if (session.activeRunId === runId) {
        session.activeRunId = null
      }
    }
  }

  private buildTurnEngineHost(params: {
    name: string
    runId: string
    sessionId?: string
    requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
    providerContext: {
      config: AIModelConfig
      baseUrl: string
      provider?: ReturnType<typeof getProviderDef>
      isKimi: boolean
      isKimiCoding: boolean
      useAnthropicProtocol: boolean
      supportsToolCalls: boolean
      supportsVideoBlock: boolean
      hasRawVideoInIncoming: boolean
    }
  }) {
    return {
      log,
      maxToolIterations: this.maxToolIterations,
      browserController: this.browserController,
      sidecarManager: this.sidecarManager,
      runtime: {
        isChannelTypeAvailable: (channelType: string) =>
          this.runtime?.isChannelTypeAvailable(channelType as any) ?? false,
        getConversationScope: (sessionId: string) => this.runtime?.getConversationScope(sessionId) || null,
      },
      requestModuleToolAction: params.requestModuleToolAction,
      registerRunCleanup: (cleanup: () => void | Promise<void>) => {
        this.runCleanupRegistry?.registerRunCleanup(params.runId, cleanup)
      },
      providerContext: params.providerContext,
      isBrowserAgentV3Enabled: () => this.isBrowserAgentV3Enabled(),
      resolveContinuationProjection: (
        sessionId: string | undefined,
        userText: string,
        options?: {
          explicitTaskId?: string | null
          allowImplicitContinuation?: boolean
        },
      ) => this.resolveContinuationProjection(sessionId, userText, options),
      getIncomingAttachmentHints: (turnContent: RunMessage) => this.getIncomingAttachmentHints(turnContent),
      collectRecentPureUserInputs: (messages: ChatMessage[], limit?: number) => this.collectRecentPureUserInputs(messages, limit),
      sessionHasMediaInputs: (messages: ChatMessage[]) => this.sessionHasMediaInputs(messages),
      sessionHasVideoInputs: (messages: ChatMessage[]) => this.sessionHasVideoInputs(messages),
      maybeRunDocumentTaskPlan: async (raw: Record<string, unknown>) => this.maybeRunDocumentTaskPlanShortcut(raw as any),
      maybeRunDocumentWidgetPipeline: async (raw: Record<string, unknown>) => this.maybeRunDocumentWidgetPipelineShortcut(raw as any),
      domainAdapters: this.domainAdapters,
      skillContextOrchestrator: this.skillContextOrchestrator,
      browserDomainOrchestrator: this.browserDomainOrchestrator,
      documentToolLoopOrchestrator: this.documentToolLoopOrchestrator,
      designToolLoopOrchestrator: this.designToolLoopOrchestrator,
      hostCapabilityDispatcher: this.hostCapabilityDispatcher,
      executeToolCall: (toolName: string, args: Record<string, unknown>, context: unknown) =>
        executeToolCall(toolName, args, context as any),
      requestSimpleText: async (raw: {
        session: DirectChatSession
        signal: AbortSignal
        providerContext: TurnProviderContext
        enableKimiWebSearch?: boolean
        timeoutMs?: number
      }) => this.requestSimpleText(raw),
      requestToolLoopResponse: async (raw: {
        session: DirectChatSession
        signal: AbortSignal
        toolPolicy: unknown
        providerContext: TurnProviderContext
        hasVideoInputs: boolean
        compressContext?: () => Promise<boolean> | boolean
        onBeforeRetry?: (result: unknown, attempt: number) => Promise<void> | void
      }) => this.requestToolLoopResponse(raw),
      executeToolBatch: async (raw: {
        toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>
        executeTool: (toolCall: { id: string; name: string; input: Record<string, unknown> }) => Promise<unknown>
        onGroupStart?: (group: { mode: 'parallel' | 'serial'; toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> }) => void
        budget?: RunBudgetSeed
        budgetState?: RunBudgetUsage
        signal?: AbortSignal
      }) => this.executionLoopOrchestrator.executeToolCalls(raw as any),
    }
  }

  private async requestSimpleText(params: {
    session: DirectChatSession
    signal: AbortSignal
    providerContext: TurnProviderContext
    enableKimiWebSearch?: boolean
    timeoutMs?: number
  }): Promise<TurnSimpleResponse> {
    const hasVideoInputs = this.sessionHasVideoInputs(params.session.messages)
    if (params.providerContext.isKimiCoding) {
      const response = await this.kimiCodingClient.requestSimple({
        session: params.session,
        config: params.providerContext.config,
        baseUrl: params.providerContext.baseUrl,
        signal: params.signal,
        hasVideoInputs,
        timeoutMs: params.timeoutMs,
        buildVideoFrameFallbackMessages: hasVideoInputs
          ? () => this.videoFallbackService.buildVideoFrameFallbackMessages(params.session.messages)
          : undefined,
        assignFallbackMessages: (fallbackMessages) => {
          params.session.messages = fallbackMessages as ChatMessage[]
        },
        fallbackToAnthropic: ({ messagesOverride }) => this.anthropicExecutionClient.requestSimple({
          session: params.session,
          config: params.providerContext.config,
          baseUrl: params.providerContext.baseUrl,
          signal: params.signal,
          messagesOverride: messagesOverride as ChatMessage[] | undefined,
          timeoutMs: params.timeoutMs,
        }),
      })
      return {
        text: response.text,
        fallback: buildExecutionFallbackState(response.fallback),
      }
    }
    if (params.providerContext.useAnthropicProtocol) {
      const response = await this.anthropicExecutionClient.requestSimple({
        session: params.session,
        config: params.providerContext.config,
        baseUrl: params.providerContext.baseUrl,
        signal: params.signal,
        hasVideoInputs,
        timeoutMs: params.timeoutMs,
        buildVideoFrameFallbackMessages: hasVideoInputs
          ? () => this.videoFallbackService.buildVideoFrameFallbackMessages(params.session.messages)
          : undefined,
        onFallbackApplied: (fallbackMessages) => {
          params.session.messages = fallbackMessages
        },
      })
      return {
        text: response.text,
        fallback: buildExecutionFallbackState(response.fallback),
      }
    }
    const response = await this.openAIExecutionClient.requestSimple({
      session: params.session,
      config: params.providerContext.config,
      baseUrl: params.providerContext.baseUrl,
      provider: params.providerContext.provider as ReturnType<typeof getProviderDef> | undefined,
      signal: params.signal,
      isKimi: params.providerContext.isKimi,
      enableKimiWebSearch: params.enableKimiWebSearch,
      timeoutMs: params.timeoutMs,
    })
    return {
      text: response.text,
      fallback: buildExecutionFallbackState(response.fallback),
    }
  }

  private async requestToolLoopResponse(params: {
    session: DirectChatSession
    signal: AbortSignal
    toolPolicy: unknown
    providerContext: TurnProviderContext
    hasVideoInputs: boolean
    compressContext?: () => Promise<boolean> | boolean
    onBeforeRetry?: (result: unknown, attempt: number) => Promise<void> | void
  }): Promise<TurnModelResponse> {
    const response = await this.executionLoopOrchestrator.requestToolLoopResponse({
      useAnthropicProtocol: params.providerContext.useAnthropicProtocol,
      hasVideoInputs: params.hasVideoInputs,
      session: params.session,
      config: params.providerContext.config,
      baseUrl: params.providerContext.baseUrl,
      provider: params.providerContext.provider as ReturnType<typeof getProviderDef> | undefined,
      signal: params.signal,
      policy: params.toolPolicy,
      callAnthropicWithTools: () => this.anthropicExecutionClient.requestWithTools({
        session: params.session,
        config: params.providerContext.config,
        baseUrl: params.providerContext.baseUrl,
        signal: params.signal,
        policy: params.toolPolicy as any,
      }),
      callOpenAIWithTools: () => this.openAIExecutionClient.requestWithTools({
        session: params.session,
        config: params.providerContext.config,
        baseUrl: params.providerContext.baseUrl,
        provider: params.providerContext.provider as ReturnType<typeof getProviderDef>,
        signal: params.signal,
        policy: params.toolPolicy as any,
      }),
      compressContext: params.compressContext,
      onBeforeRetry: params.onBeforeRetry as any,
      buildVideoFrameFallbackMessages: () => this.videoFallbackService.buildVideoFrameFallbackMessages(params.session.messages),
      assignFallbackMessages: (messages) => {
        params.session.messages = messages as ChatMessage[]
      },
    })
    return {
      ...response,
      fallback: buildExecutionFallbackState(response.fallback),
    }
  }

  private async maybeRunDocumentTaskPlanShortcut(params: {
    scopeId?: string
    parentTaskId?: string
    parentRunId?: string
    initialTaskExecutionRoute: import('../agent-control/run-contracts').TaskExecutionRoute
    executionIntentContext: ReturnType<typeof resolveExecutionIntentContext>
    hasTools: boolean
    requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
    signal: AbortSignal
    session: DirectChatSession
    providerContext: {
      config: AIModelConfig
      baseUrl: string
      provider?: ReturnType<typeof getProviderDef>
      isKimi: boolean
      isKimiCoding: boolean
      useAnthropicProtocol: boolean
    }
    emitStructuredTaskPayload: (payload: unknown) => void
  }): Promise<TurnShortcutResult | null> {
    const preferredSkillToolNames = this.skillContextOrchestrator.buildPreferredSkillToolNames(
      params.executionIntentContext.contextualUserInput,
      undefined,
    )
    if (
      params.initialTaskExecutionRoute.executor !== 'document'
      || params.initialTaskExecutionRoute.chain !== 'domain_executor'
      || !params.executionIntentContext.shouldUseDocumentTaskPlan
      || !params.executionIntentContext.documentTaskPlan
      || !params.hasTools
      || !params.requestModuleToolAction
      || (preferredSkillToolNames && preferredSkillToolNames.length > 0)
    ) {
      return null
    }

    const planResult = await this.runDocumentTaskPlan({
      plan: params.executionIntentContext.documentTaskPlan,
      requestEnvelope: params.executionIntentContext.requestEnvelope,
      session: params.session,
      scopeId: params.scopeId,
      parentTaskId: params.parentTaskId || params.initialTaskExecutionRoute.taskId,
      parentRunId: params.parentRunId || params.session.activeRunId || null,
      requestModuleToolAction: params.requestModuleToolAction,
      signal: params.signal,
      config: params.providerContext.config,
      baseUrl: params.providerContext.baseUrl,
      provider: params.providerContext.provider,
      isKimi: params.providerContext.isKimi,
      isKimiCoding: params.providerContext.isKimiCoding,
      useAnthropicProtocol: params.providerContext.useAnthropicProtocol,
      emitStructuredTaskPayload: params.emitStructuredTaskPayload,
    })

    if (!planResult.success && !planResult.finalText) {
      throw new Error(planResult.error || '文档任务计划执行失败')
    }

    return {
      finalText: planResult.finalText || null,
      error: planResult.error,
      status: planResult.success ? 'done' : 'error',
      success: planResult.success,
      interactionState: 'running' as TaskInteractionState,
    }
  }

  private async maybeRunDocumentWidgetPipelineShortcut(params: {
    initialTaskExecutionRoute: import('../agent-control/run-contracts').TaskExecutionRoute
    executionIntentContext: ReturnType<typeof resolveExecutionIntentContext>
    hasTools: boolean
    requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
    signal: AbortSignal
    session: DirectChatSession
    providerContext: {
      config: AIModelConfig
      baseUrl: string
      provider?: ReturnType<typeof getProviderDef>
      isKimi: boolean
      isKimiCoding: boolean
      useAnthropicProtocol: boolean
    }
    emitStructuredTaskPayload: (payload: unknown) => void
    setPipelineDiagnostics?: (pipeline: unknown) => void
  }): Promise<TurnShortcutResult | null> {
    const preferredSkillToolNames = this.skillContextOrchestrator.buildPreferredSkillToolNames(
      params.executionIntentContext.contextualUserInput,
      undefined,
    )
    if (
      params.initialTaskExecutionRoute.executor !== 'document'
      || params.initialTaskExecutionRoute.chain !== 'domain_executor'
      || params.executionIntentContext.structuredDocumentIntent !== 'document_read_then_widget_create'
      || !params.hasTools
      || !params.requestModuleToolAction
      || (preferredSkillToolNames && preferredSkillToolNames.length > 0)
    ) {
      return null
    }

    const sourceMaterial = buildDocumentInsightSourceMaterial({
      requestEnvelope: params.executionIntentContext.requestEnvelope,
      snapshotContent: '',
    })
    const pipelinePhaseOrder: Array<DocumentTaskPipelinePhaseUpdate['phase']> = [
      'loading_document',
      'building_insight',
      'generating_widget_spec',
      'writing_widget',
      'saving_document',
    ]
    const pipelinePhaseTitles: Record<DocumentTaskPipelinePhaseUpdate['phase'], string> = {
      loading_document: '读取文档',
      building_insight: '提炼重点',
      generating_widget_spec: '生成卡片草稿',
      writing_widget: '写入卡片',
      saving_document: '保存文档',
      completed: '完成',
      failed: '失败',
    }
    const pipelinePhaseStatus = new Map<string, 'running' | 'done' | 'error'>()
    let documentPipelineDiagnostics: {
      phase?: string
      chunkCount?: number
      selectedChunkCount?: number
      promptChars?: number
      cacheHit?: boolean
      usedSectionAnchors?: boolean
    } | null = null
    const emitDocumentPipelinePhase = (update: DocumentTaskPipelinePhaseUpdate): void => {
      if (update.phase === 'completed') {
        pipelinePhaseStatus.forEach((value, key) => {
          if (value === 'running') pipelinePhaseStatus.set(key, 'done')
        })
      } else if (update.phase === 'failed') {
        const lastRunning = pipelinePhaseOrder.find((phase) => pipelinePhaseStatus.get(phase) === 'running')
        if (lastRunning) pipelinePhaseStatus.set(lastRunning, 'error')
      } else if (update.status === 'running') {
        pipelinePhaseStatus.set(update.phase, 'running')
      } else if (update.status === 'completed') {
        pipelinePhaseStatus.set(update.phase, 'done')
      } else if (update.status === 'failed') {
        pipelinePhaseStatus.set(update.phase, 'error')
      }
      documentPipelineDiagnostics = {
        ...(documentPipelineDiagnostics || {}),
        ...(update.metrics || {}),
        phase: update.phase === 'completed' || update.phase === 'failed'
          ? documentPipelineDiagnostics?.phase || update.phase
          : update.phase,
      }

      params.setPipelineDiagnostics?.({
        document: documentPipelineDiagnostics,
      })
      params.emitStructuredTaskPayload({
        module: 'document',
        message: update.summary,
        taskTitle: '文档信息卡',
        taskSummary: update.summary,
        executionDiagnostics: {
          pipeline: {
            document: documentPipelineDiagnostics,
          },
        },
        steps: pipelinePhaseOrder.map((phase) => ({
          id: phase,
          title: pipelinePhaseTitles[phase],
          status: pipelinePhaseStatus.get(phase) === 'done'
            ? 'done'
            : pipelinePhaseStatus.get(phase) === 'error'
              ? 'blocked'
              : pipelinePhaseStatus.get(phase) === 'running'
                ? 'running'
                : 'pending',
          updatedAt: update.endedAt || update.startedAt,
        })),
        currentStepId:
          update.phase === 'completed' || update.phase === 'failed'
            ? pipelinePhaseOrder.find((phase) => pipelinePhaseStatus.get(phase) === 'running' || pipelinePhaseStatus.get(phase) === 'error') || pipelinePhaseOrder[pipelinePhaseOrder.length - 1]
            : update.phase,
        waitingFor: 'none',
        resumableActions: update.phase === 'failed' ? ['retry', 'cancel'] : ['cancel'],
        blockedReason: update.phase === 'failed' ? (update.error || update.summary) : null,
      })
    }

    const pipeline = new DocumentTaskPipeline({
      now: () => new Date(),
      log: (message) => log(message),
      loadDocumentSnapshot: async ({ question, signal }) => await this.loadDocumentPipelineSnapshot({
        userText: question,
        requestModuleToolAction: params.requestModuleToolAction!,
        signal,
      }),
      getCachedInsight: ({ question, snapshot }) => this.getCachedDocumentInsight(
        params.session,
        question,
        snapshot,
      ),
      buildInsight: async ({ question, snapshot, signal }) => await this.buildDocumentPipelineInsight({
        question,
        snapshot,
        sourceText: sourceMaterial.kind === 'snapshot' ? snapshot.content : sourceMaterial.text,
        sourceKind: sourceMaterial.kind === 'snapshot' && sourceMaterial.text.trim()
          ? 'snapshot'
          : sourceMaterial.kind,
        sourceDocumentTitle: sourceMaterial.sourceDocumentTitle || snapshot.title,
        sourceDocumentPath: sourceMaterial.sourceDocumentPath ?? snapshot.path,
        timeoutMs: 60_000,
        config: params.providerContext.config,
        baseUrl: params.providerContext.baseUrl,
        provider: params.providerContext.provider,
        signal,
        isKimi: params.providerContext.isKimi,
        isKimiCoding: params.providerContext.isKimiCoding,
        useAnthropicProtocol: params.providerContext.useAnthropicProtocol,
      }),
      storeCachedInsight: ({ question, snapshot, insight, metrics }) => {
        this.storeCachedDocumentInsight(params.session, question, snapshot, insight, metrics)
      },
      buildWidgetDraft: async ({ question, snapshot, insight, signal }) => await this.buildDocumentPipelineWidgetDraft({
        question,
        snapshot,
        insight,
        timeoutMs: 60_000,
        config: params.providerContext.config,
        baseUrl: params.providerContext.baseUrl,
        provider: params.providerContext.provider,
        signal,
        isKimi: params.providerContext.isKimi,
        isKimiCoding: params.providerContext.isKimiCoding,
        useAnthropicProtocol: params.providerContext.useAnthropicProtocol,
      }),
      insertWidget: async ({ draft, signal }) => {
        void signal
        const payload = await params.requestModuleToolAction!('document.insertWidget', {
          title: draft.title,
          componentSpec: draft.componentSpec,
          widgetCode: draft.widgetCode,
          position: draft.insertionMode === 'after_section' ? 'after_section' : 'append_end',
          sectionTitle: draft.targetSectionTitle,
        })
        return typeof payload.summary === 'string' ? payload.summary : '已写入信息卡'
      },
      saveDocument: async ({ signal }) => {
        void signal
        const payload = await params.requestModuleToolAction!('document.saveTab', {})
        return typeof payload.summary === 'string' ? payload.summary : '已保存文档'
      },
      emitPhase: emitDocumentPipelinePhase,
    })

    const pipelineResult = await pipeline.run({
      question: params.executionIntentContext.userInstructionText || this.extractIncomingText(params.executionIntentContext.requestEnvelope.pureUserText),
      signal: params.signal,
    })
    if (!pipelineResult.success && !pipelineResult.finalText) {
      throw new Error(pipelineResult.error || '文档信息卡 pipeline 失败')
    }
    return {
      finalText: pipelineResult.finalText || null,
      error: pipelineResult.error,
      status: pipelineResult.success ? 'done' : 'error',
      success: pipelineResult.success,
      interactionState: 'running' as TaskInteractionState,
    }
  }

  private extractIncomingText(content: string | MultimodalBlock[] | Array<Record<string, unknown>>): string {
    if (typeof content === 'string') return content
    return content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => String(block.text || ''))
      .join('\n')
  }

  private compressSessionMessagesForRetry(session: DirectChatSession): boolean {
    if (session.messages.length <= 6) return false
    const earlierMessages = session.messages
      .slice(0, -6)
      .map((message) => ({
        role: message.role,
        content: this.extractIncomingText(message.content).trim(),
      }))
      .filter((message) => message.content.length > 0)
    if (earlierMessages.length === 0) return false

    const compressed = compressHistoryForPrompt(earlierMessages, {
      keepRecent: 2,
      maxChars: 900,
    })
    if (!compressed.compressed) return false

    session.messages = [
      { role: 'system', content: `更早对话已压缩以继续执行：\n${compressed.text}` },
      ...session.messages.slice(-6),
    ]
    return true
  }

  private extractTaskIdFromText(text: string): string | null {
    const matched = String(text || '').match(/^Task ID:\s*(.+)$/m)?.[1]?.trim()
    return matched || null
  }

  private resolveContinuationProjection(
    sessionId: string | undefined,
    userText: string,
    options?: {
      explicitTaskId?: string | null
      allowImplicitContinuation?: boolean
    },
  ): TaskProjectionRecord | null {
    const runtime = this.runtime
    if (!runtime || !sessionId) return null
    const projections = runtime.listTaskProjections(sessionId)
    return selectContinuationProjection({
      projections,
      userText,
      explicitTaskId: options?.explicitTaskId ?? this.extractTaskIdFromText(userText),
      allowImplicitContinuation: options?.allowImplicitContinuation,
    })
  }

  private resolveContinuationState(
    sessionId: string | undefined,
    userText: string,
    options?: {
      parsedControl?: ReturnType<typeof parseContinuationControlText>
      explicitTaskId?: string | null
      allowImplicitContinuation?: boolean
    },
  ): ContinuationState | null {
    const parsedControl = options?.parsedControl || parseContinuationControlText(userText)
    const projection = this.resolveContinuationProjection(sessionId, userText, {
      explicitTaskId: options?.explicitTaskId ?? parsedControl.explicitTaskId,
      allowImplicitContinuation: options?.allowImplicitContinuation ?? parsedControl.shouldResolveContinuation,
    })

    if (projection) {
      const baseState = buildContinuationStateFromProjection(projection, {
        executionId: parsedControl.executionId,
        stepId: parsedControl.stepId,
        blockedReason: parsedControl.blockedReason ?? projection.blockedReason ?? null,
      })
      const restoredBudget = restoreContinuationTaskBudgetRuntime({
        taskType: 'continuation',
        continuationState: baseState,
      })
      const resolvedState: ContinuationState = {
        ...baseState,
        budgetRuntime: restoredBudget.runtime || null,
        restoreDiagnostics: restoredBudget.diagnostics,
      }
      if (sessionId) {
        rememberContinuationState(sessionId, resolvedState, {
          updatedAt: toContinuationUpdatedAt(projection.updatedAt),
        })
      }
      return resolvedState
    }

    const explicitTaskId = options?.explicitTaskId ?? parsedControl.explicitTaskId
    const persistedState = getContinuationState(sessionId, explicitTaskId ? { taskId: explicitTaskId } : undefined)
    if (!persistedState) return null
    if (!(options?.allowImplicitContinuation ?? parsedControl.shouldResolveContinuation)) {
      return null
    }

    const restoredBudget = restoreContinuationTaskBudgetRuntime({
      taskType: 'continuation',
      continuationState: {
        ...persistedState,
        currentStepId: parsedControl.stepId || persistedState.currentStepId || null,
        blockedReason: parsedControl.blockedReason ?? persistedState.blockedReason ?? null,
        continuationRef: persistedState.continuationRef
          ? {
            ...persistedState.continuationRef,
            taskId: persistedState.taskId,
            executionId: parsedControl.executionId || persistedState.continuationRef.executionId,
            stepId: parsedControl.stepId || persistedState.continuationRef.stepId || persistedState.currentStepId || null,
          }
          : persistedState.continuationRef,
      },
    })
    const resolvedState: ContinuationState = {
      ...persistedState,
      currentStepId: parsedControl.stepId || persistedState.currentStepId || null,
      blockedReason: parsedControl.blockedReason ?? persistedState.blockedReason ?? null,
      continuationRef: persistedState.continuationRef
        ? {
          ...persistedState.continuationRef,
          taskId: persistedState.taskId,
          executionId: parsedControl.executionId || persistedState.continuationRef.executionId,
          stepId: parsedControl.stepId || persistedState.continuationRef.stepId || persistedState.currentStepId || null,
        }
        : persistedState.continuationRef,
      budgetRuntime: restoredBudget.runtime || persistedState.budgetRuntime || null,
      restoreDiagnostics: restoredBudget.diagnostics,
    }
    if (sessionId) {
      rememberContinuationState(sessionId, resolvedState)
    }
    return resolvedState
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

  private clipDocumentForInsight(content: string, maxChars: number): string {
    const normalized = String(content || '').trim()
    if (normalized.length <= maxChars) return normalized
    const segmentSize = Math.max(800, Math.floor((maxChars - 64) / 3))
    const head = normalized.slice(0, segmentSize)
    const middleStart = Math.max(0, Math.floor((normalized.length - segmentSize) / 2))
    const middle = normalized.slice(middleStart, middleStart + segmentSize)
    const tail = normalized.slice(-segmentSize)
    return [
      head,
      '...[文档中间内容已截断]...',
      middle,
      '...[文档尾部内容已截断]...',
      tail,
    ].join('\n')
  }

  private createPipelineSession(systemPrompt: string, userPrompt: string, options?: { includeSystemMessage?: boolean }): DirectChatSession {
    const messages: ChatMessage[] = options?.includeSystemMessage
      ? [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]
      : [{ role: 'user', content: userPrompt }]
    return {
      messages,
      abortController: null,
      systemPrompt,
      generation: 0,
      activeRunId: null,
      preferTextToolBridge: false,
      lastDocumentContextInput: null,
      documentInsightCache: [],
      documentWidgetDraftCache: [],
    }
  }

  private async requestDocumentPipelineSimpleText(params: {
    systemPrompt: string
    userPrompt: string
    config: AIModelConfig
    baseUrl: string
    provider: ReturnType<typeof getProviderDef> | undefined
    signal: AbortSignal
    isKimi: boolean
    isKimiCoding: boolean
    useAnthropicProtocol: boolean
    timeoutMs: number
  }): Promise<string> {
    if (params.isKimiCoding) {
      const session = this.createPipelineSession(params.systemPrompt, params.userPrompt, { includeSystemMessage: true })
      const result = await this.kimiCodingClient.requestSimple({
        session,
        config: params.config,
        baseUrl: params.baseUrl,
        signal: params.signal,
        timeoutMs: params.timeoutMs,
      })
      return result.text
    }

    if (params.useAnthropicProtocol) {
      const session = this.createPipelineSession(params.systemPrompt, params.userPrompt)
      const result = await this.anthropicExecutionClient.requestSimple({
        session,
        config: params.config,
        baseUrl: params.baseUrl,
        signal: params.signal,
        timeoutMs: params.timeoutMs,
      })
      return result.text
    }

    const session = this.createPipelineSession(params.systemPrompt, params.userPrompt)
    const result = await this.openAIExecutionClient.requestSimple({
      session,
      config: params.config,
      baseUrl: params.baseUrl,
      provider: params.provider,
      signal: params.signal,
      isKimi: params.isKimi,
      enableKimiWebSearch: false,
      timeoutMs: params.timeoutMs,
    })
    return result.text
  }

  private parsePipelineJson<T extends Record<string, unknown>>(raw: string): T | null {
    if (!raw) return null
    const candidates: string[] = []
    const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/gi
    let fencedMatch: RegExpExecArray | null = fencedRegex.exec(raw)
    while (fencedMatch) {
      if (fencedMatch[1]?.trim()) candidates.push(fencedMatch[1].trim())
      fencedMatch = fencedRegex.exec(raw)
    }
    const firstBrace = raw.indexOf('{')
    const lastBrace = raw.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(raw.slice(firstBrace, lastBrace + 1))
    }
    candidates.push(raw.trim())

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as T
        if (parsed && typeof parsed === 'object') return parsed
      } catch {
        // Try next candidate.
      }
    }
    return null
  }

  private normalizePipelineInsight(
    raw: Record<string, unknown>,
    question: string,
    sourceDocument: {
      title: string
      path: string | null
    },
  ): DocumentInsight {
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
    const keyPoints = Array.isArray(raw.keyPoints)
      ? raw.keyPoints.map((item) => String(item || '').trim()).filter(Boolean)
      : []
    const evidence = Array.isArray(raw.evidence)
      ? raw.evidence
        .map((item) => {
          if (!item || typeof item !== 'object') return null
          const quote = typeof (item as { quote?: unknown }).quote === 'string'
            ? (item as { quote: string }).quote.trim()
            : ''
          if (!quote) return null
          const sectionTitle = typeof (item as { sectionTitle?: unknown }).sectionTitle === 'string'
            ? String((item as { sectionTitle: string }).sectionTitle).trim()
            : undefined
          return { quote, sectionTitle }
        })
        .filter(Boolean) as Array<{ sectionTitle?: string; quote: string }>
      : []
    const recommendedWidget = (() => {
      const value = typeof raw.recommendedWidget === 'string' ? raw.recommendedWidget.trim() : ''
      switch (value) {
        case 'stats_card':
        case 'comparison_grid':
        case 'callout_block':
        case 'data_table':
          return value
        default:
          return 'info_card'
      }
    })()
    const warnings = Array.isArray(raw.warnings)
      ? raw.warnings.map((item) => String(item || '').trim()).filter(Boolean)
      : undefined

    if (!summary || keyPoints.length === 0) {
      throw new Error('Document insight JSON 缺少 summary 或 keyPoints')
    }

    return {
      question,
      documentPath: sourceDocument.path,
      documentTitle: sourceDocument.title,
      summary,
      keyPoints,
      evidence,
      recommendedWidget,
      warnings,
    }
  }

  private slugifyWidgetTitle(value: string): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'document_summary_card'
  }

  private buildFallbackDocumentWidgetDraft(params: {
    insight: DocumentInsight
    snapshot: ActiveDocumentSnapshot
  }): DocumentWidgetDraft {
    const heading = params.snapshot.title.replace(/\.[^.]+$/, '') || '文档摘要'
    return {
      title: this.slugifyWidgetTitle(`${heading}_summary_card`),
      insertionMode: 'append_end',
      componentSpec: {
        component: 'info_card',
        props: {
          heading,
          body: params.insight.summary,
          points: params.insight.keyPoints.slice(0, 4),
          tone: 'info',
        },
      },
    }
  }

  private getDocumentTaskJobTarget(job: DocumentTaskJob): RequestEnvelopeResource | null {
    return job.bindings.find((binding) => binding.role === 'target_document')?.resource || null
  }

  private getDocumentTaskJobSources(job: DocumentTaskJob): RequestEnvelopeResource[] {
    return job.bindings
      .filter((binding) => binding.role === 'primary_source' || binding.role === 'secondary_source')
      .map((binding) => binding.resource)
  }

  private buildDocumentTaskStepTitle(job: DocumentTaskJob, step: DocumentTaskStep, jobIndex: number, totalJobs: number): string {
    const sources = this.getDocumentTaskJobSources(job)
    const target = this.getDocumentTaskJobTarget(job)
    const sourceLabel = sources.map((resource) => resource.name).join(' + ') || '材料'
    const targetLabel = target?.name || '目标文档'
    const jobPrefix = totalJobs > 1 ? `${jobIndex + 1}. ` : ''

    switch (step) {
      case 'collect_materials':
        return `${jobPrefix}读取 ${sourceLabel}`
      case 'build_insight':
        return `${jobPrefix}提炼 ${sourceLabel}`
      case 'compose_widget':
        return `${jobPrefix}生成卡片草稿`
      case 'write_target':
        return `${jobPrefix}写入 ${targetLabel}`
      case 'save_target':
        return `${jobPrefix}保存 ${targetLabel}`
      case 'verify_result':
        return `${jobPrefix}核对 ${targetLabel}`
      default:
        return `${jobPrefix}${step}`
    }
  }

  private buildDocumentTaskStepId(job: DocumentTaskJob, step: DocumentTaskStep): string {
    return `${job.id}:${step}`
  }

  private buildDocumentWidgetDraftCacheKey(
    question: string,
    job: DocumentTaskJob,
    snapshot: ActiveDocumentSnapshot,
  ): string {
    return buildDocumentTaskStepCacheKey({
      question,
      step: 'compose_widget',
      job,
      targetSnapshot: snapshot,
    })
  }

  private normalizePipelineWidgetDraft(
    raw: Record<string, unknown> | null,
    params: {
      insight: DocumentInsight
      snapshot: ActiveDocumentSnapshot
    },
  ): DocumentWidgetDraft {
    const fallback = this.buildFallbackDocumentWidgetDraft(params)
    if (!raw) return fallback

    const title = typeof raw.title === 'string' ? raw.title.trim() : fallback.title
    const insertionMode = raw.insertionMode === 'after_section' || raw.insertionMode === 'update_existing'
      ? raw.insertionMode
      : 'append_end'
    const componentSpec = raw.componentSpec && typeof raw.componentSpec === 'object'
      ? raw.componentSpec as Record<string, unknown>
      : null
    if (!componentSpec) {
      return fallback
    }
    if (typeof componentSpec.component !== 'string' || !componentSpec.component.trim()) {
      return fallback
    }
    const normalizedComponentSpec: DocumentWidgetComponentSpec = {
      component: componentSpec.component.trim(),
      props: componentSpec.props && typeof componentSpec.props === 'object'
        ? componentSpec.props as Record<string, unknown>
        : undefined,
      dataSource: componentSpec.dataSource && typeof componentSpec.dataSource === 'object'
        ? componentSpec.dataSource as DocumentWidgetComponentSpec['dataSource']
        : undefined,
    }

    return {
      title: this.slugifyWidgetTitle(title),
      insertionMode,
      targetSectionTitle: typeof raw.targetSectionTitle === 'string' ? raw.targetSectionTitle.trim() : undefined,
      targetWidgetTitle: typeof raw.targetWidgetTitle === 'string' ? raw.targetWidgetTitle.trim() : undefined,
      componentSpec: normalizedComponentSpec,
    }
  }

  private async buildDocumentPipelineInsight(params: {
    question: string
    snapshot: ActiveDocumentSnapshot
    sourceText: string
    sourceKind: 'attachment_body' | 'document_excerpt' | 'snapshot' | 'task_plan'
    sourceDocumentTitle: string
    sourceDocumentPath: string | null
    timeoutMs: number
    config: AIModelConfig
    baseUrl: string
    provider: ReturnType<typeof getProviderDef> | undefined
    signal: AbortSignal
    isKimi: boolean
    isKimiCoding: boolean
    useAnthropicProtocol: boolean
  }): Promise<DocumentInsightStageResult> {
    const focusedContext = buildFocusedDocumentContext({
      question: params.question,
      content: params.sourceText,
      maxCharsPerChunk: 2200,
      maxSelectedChunks: params.sourceText.length > 4000 ? 4 : 6,
      maxPromptChars: 12_000,
    })
    const promptBody = focusedContext.promptText || this.clipDocumentForInsight(params.snapshot.content, 12_000)
    const systemPrompt = [
      '你是 Ready 的文档 insight 阶段。',
      '你只负责阅读文档并提炼和问题最相关的结构化结果，不要生成 widget，不要写回文档。',
      '必须只输出 JSON，对象字段为 summary、keyPoints、evidence、recommendedWidget、warnings。',
      'recommendedWidget 只能是 info_card、stats_card、comparison_grid、callout_block、data_table 之一。',
      'keyPoints 保持 3 到 6 条，evidence 至少给 1 条简短引文。',
    ].join('\n')
    const userPrompt = [
      `问题：${params.question}`,
      `来源标题：${params.sourceDocumentTitle}`,
      `来源路径：${params.sourceDocumentPath || '(未保存草稿)'}`,
      `写入目标：${params.snapshot.title}`,
      `来源类型：${params.sourceKind}`,
      `来源字数：${params.sourceText.length}`,
      `文档片段数：${focusedContext.chunks.length}`,
      `本次使用片段数：${focusedContext.selectedChunks.length}`,
      '',
      '请围绕这个问题提炼可直接用于制作信息卡的 insight。',
      '只返回 JSON。',
      '',
      focusedContext.warnings.length > 0
        ? `系统提示：${focusedContext.warnings.join(' ')}`
        : '系统提示：当前已挑选与问题最相关的文档片段。',
      '',
      '相关文档片段：',
      promptBody,
    ].join('\n')
    log(
      `document insight focused read chunks=${focusedContext.chunks.length}, selected=${focusedContext.selectedChunks.length}, sectioned=${focusedContext.usedSectionAnchors}`,
    )
    const raw = await this.requestDocumentPipelineSimpleText({
      systemPrompt,
      userPrompt,
      config: params.config,
      baseUrl: params.baseUrl,
      provider: params.provider,
      signal: params.signal,
      isKimi: params.isKimi,
      isKimiCoding: params.isKimiCoding,
      useAnthropicProtocol: params.useAnthropicProtocol,
      timeoutMs: params.timeoutMs,
    })
    const parsed = this.parsePipelineJson<Record<string, unknown>>(raw)
    if (!parsed) {
      throw new Error('Document insight 阶段未返回可解析 JSON')
    }
    const insight = this.normalizePipelineInsight(parsed, params.question, {
      title: params.sourceDocumentTitle,
      path: params.sourceDocumentPath,
    })
    const warningSet = new Set([
      ...(insight.warnings || []),
      ...focusedContext.warnings,
    ])
    if (warningSet.size > 0) {
      insight.warnings = Array.from(warningSet)
    }
    return {
      insight,
      metrics: {
        chunkCount: focusedContext.chunks.length,
        selectedChunkCount: focusedContext.selectedChunks.length,
        promptChars: promptBody.length,
        usedSectionAnchors: focusedContext.usedSectionAnchors,
      },
    }
  }

  private async buildDocumentPipelineWidgetDraft(params: {
    question: string
    snapshot: ActiveDocumentSnapshot
    insight: DocumentInsight
    timeoutMs: number
    config: AIModelConfig
    baseUrl: string
    provider: ReturnType<typeof getProviderDef> | undefined
    signal: AbortSignal
    isKimi: boolean
    isKimiCoding: boolean
    useAnthropicProtocol: boolean
  }): Promise<DocumentWidgetDraft> {
    const systemPrompt = [
      '你是 Ready 的 widget 草稿阶段。',
      '你只负责根据给定 insight 生成一个可写入文档的 componentSpec 草稿。',
      '必须只输出 JSON。',
      '字段为 title、insertionMode、componentSpec、targetSectionTitle、targetWidgetTitle。',
      '默认 insertionMode 使用 append_end。',
      'componentSpec.component 只能是 info_card、stats_card、comparison_grid、callout_block、data_table。',
      '优先选择简单稳定的组件，不要发明 catalog 外的新组件。',
    ].join('\n')
    const userPrompt = [
      `用户问题：${params.question}`,
      `文档标题：${params.snapshot.title}`,
      `推荐组件：${params.insight.recommendedWidget}`,
      '',
      'insight JSON：',
      JSON.stringify(params.insight, null, 2),
    ].join('\n')
    const raw = await this.requestDocumentPipelineSimpleText({
      systemPrompt,
      userPrompt,
      config: params.config,
      baseUrl: params.baseUrl,
      provider: params.provider,
      signal: params.signal,
      isKimi: params.isKimi,
      isKimiCoding: params.isKimiCoding,
      useAnthropicProtocol: params.useAnthropicProtocol,
      timeoutMs: params.timeoutMs,
    })
    const parsed = this.parsePipelineJson<Record<string, unknown>>(raw)
    return this.normalizePipelineWidgetDraft(parsed, {
      insight: params.insight,
      snapshot: params.snapshot,
    })
  }

  private async verifyDocumentTaskPlanWrite(params: {
    draft: DocumentWidgetDraft
    targetResource: RequestEnvelopeResource
    requestModuleToolAction: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
    signal: AbortSignal
  }): Promise<string> {
    void params.signal
    const payload = await params.requestModuleToolAction('document.listWidgets', {})
    const summary = typeof payload.summary === 'string' ? payload.summary : ''
    if (params.draft.title && summary && !summary.includes(params.draft.title) && !/当前文档共有\s+\d+\s+个 widget/.test(summary)) {
      throw new Error(`写入后未在 ${params.targetResource.name} 中确认到目标信息卡`)
    }
    return summary || `已核对 ${params.targetResource.name}`
  }

  private buildDocumentTaskPlanFailureText(params: {
    job: DocumentTaskJob
    step: DocumentTaskStep
    error: string
    insight?: DocumentInsight
    draft?: DocumentWidgetDraft
  }): string {
    const target = this.getDocumentTaskJobTarget(params.job)
    const sources = this.getDocumentTaskJobSources(params.job)
    const sourceLabel = sources.map((resource) => resource.name).join(' + ') || '材料'
    const targetLabel = target?.name || '目标文档'

    if (params.step === 'collect_materials' || params.step === 'build_insight') {
      return `读取 ${sourceLabel} 失败，暂时没法继续写入 ${targetLabel}。原因：${params.error}`
    }

    const lines = [
      `已先完成对 ${sourceLabel} 的重点提炼，但在写入 ${targetLabel} 时中断。`,
      params.insight?.summary ? `提炼结果：${params.insight.summary}` : null,
      params.insight?.keyPoints?.length
        ? `重点：${params.insight.keyPoints.slice(0, 3).join('；')}`
        : null,
      params.draft?.title ? `卡片草稿：${params.draft.title}` : null,
      `失败原因：${params.error}`,
    ].filter(Boolean)

    return lines.join('\n')
  }

  private buildDocumentTaskPlanSuccessText(results: Array<{
    job: DocumentTaskJob
    writeSummary: string
    saveSummary: string
    verifySummary: string
  }>): string {
    if (results.length === 1) {
      const item = results[0]
      const target = this.getDocumentTaskJobTarget(item.job)
      const sources = this.getDocumentTaskJobSources(item.job)
      return [
        `已根据 ${sources.map((resource) => resource.name).join(' + ')} 在 ${target?.name || '目标文档'} 中生成信息卡。`,
        item.writeSummary,
        item.saveSummary,
      ].join('\n')
    }

    return [
      `本次共完成 ${results.length} 个文档任务：`,
      ...results.map((item, index) => {
        const target = this.getDocumentTaskJobTarget(item.job)
        const sources = this.getDocumentTaskJobSources(item.job)
        return `${index + 1}. ${sources.map((resource) => resource.name).join(' + ')} -> ${target?.name || '目标文档'}`
      }),
    ].join('\n')
  }

  private async executeDocumentTaskPlanJob(params: {
    job: DocumentTaskJob
    jobIndex: number
    totalJobs: number
    requestEnvelope: RequestEnvelope
    session: DirectChatSession
    requestModuleToolAction: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
    signal: AbortSignal
    config: AIModelConfig
    baseUrl: string
    provider: ReturnType<typeof getProviderDef> | undefined
    isKimi: boolean
    isKimiCoding: boolean
    useAnthropicProtocol: boolean
    onStepUpdate?: (payload: {
      job: DocumentTaskJob
      jobIndex: number
      step: DocumentTaskStep
      status: 'running' | 'completed' | 'failed'
      summary: string
      error?: string
    }) => void
  }): Promise<
    | {
      success: true
      writeSummary: string
      saveSummary: string
      verifySummary: string
    }
    | {
      success: false
      step: DocumentTaskStep
      error: string
      insight?: DocumentInsight
      draft?: DocumentWidgetDraft
    }
  > {
    const emitStepUpdate = params.onStepUpdate || (() => {})
    const targetResource = this.getDocumentTaskJobTarget(params.job)
    const sourceResources = this.getDocumentTaskJobSources(params.job)
    const sourceLabel = sourceResources.map((resource) => resource.name).join(' + ') || '材料'
    const targetLabel = targetResource?.name || '目标文档'

    let currentStep: DocumentTaskStep = 'collect_materials'
    let currentInsight: DocumentInsight | undefined
    let currentDraft: DocumentWidgetDraft | undefined

    try {
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'collect_materials',
        status: 'running',
        summary: `正在读取 ${sourceLabel}，准备写入 ${targetLabel}`,
      })
      if (!targetResource) {
        throw new Error('缺少明确的目标文档')
      }
      const targetSnapshot = await this.loadDocumentPipelineSnapshot({
        userText: params.job.instruction,
        requestModuleToolAction: params.requestModuleToolAction,
        signal: params.signal,
        targetPathOverride: targetResource.path,
      })
      const sourceMaterial = buildDocumentInsightSourceMaterial({
        requestEnvelope: params.requestEnvelope,
        snapshotContent: targetSnapshot.content,
        job: params.job,
      })
      if (!sourceMaterial.text.trim()) {
        throw new Error('没有拿到可用的来源材料')
      }
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'collect_materials',
        status: 'completed',
        summary: `已读取 ${sourceLabel}，目标是 ${targetLabel}`,
      })

      currentStep = 'build_insight'
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'build_insight',
        status: 'running',
        summary: `正在提炼 ${sourceLabel} 的重点`,
      })
      const insightCacheKey = buildDocumentTaskStepCacheKey({
        question: params.job.instruction,
        step: 'build_insight',
        job: params.job,
        targetSnapshot,
      })
      const cachedInsight = this.getCachedDocumentInsight(
        params.session,
        params.job.instruction,
        targetSnapshot,
        {
          job: params.job,
          cacheKeyOverride: insightCacheKey,
        },
      )
      const insightResult = cachedInsight || await this.buildDocumentPipelineInsight({
        question: params.job.instruction,
        snapshot: targetSnapshot,
        sourceText: sourceMaterial.text,
        sourceKind: sourceMaterial.kind,
        sourceDocumentTitle: sourceMaterial.sourceDocumentTitle || sourceResources[0]?.name || targetSnapshot.title,
        sourceDocumentPath: sourceMaterial.sourceDocumentPath ?? sourceResources[0]?.path ?? null,
        timeoutMs: 60_000,
        config: params.config,
        baseUrl: params.baseUrl,
        provider: params.provider,
        signal: params.signal,
        isKimi: params.isKimi,
        isKimiCoding: params.isKimiCoding,
        useAnthropicProtocol: params.useAnthropicProtocol,
      })
      currentInsight = ('insight' in insightResult ? insightResult.insight : insightResult)
      if (!cachedInsight) {
        this.storeCachedDocumentInsight(
          params.session,
          params.job.instruction,
          targetSnapshot,
          currentInsight,
          'metrics' in insightResult ? insightResult.metrics : undefined,
          {
            job: params.job,
            cacheKeyOverride: insightCacheKey,
          },
        )
      }
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'build_insight',
        status: 'completed',
        summary: cachedInsight
          ? `已复用 ${sourceLabel} 的提炼结果`
          : `已完成 ${sourceLabel} 的重点提炼`,
      })

      currentStep = 'compose_widget'
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'compose_widget',
        status: 'running',
        summary: `正在为 ${targetLabel} 生成卡片草稿`,
      })
      const cachedDraft = this.getCachedDocumentWidgetDraft(
        params.session,
        params.job.instruction,
        params.job,
        targetSnapshot,
      )
      currentDraft = cachedDraft || await this.buildDocumentPipelineWidgetDraft({
        question: params.job.instruction,
        snapshot: targetSnapshot,
        insight: currentInsight,
        timeoutMs: 60_000,
        config: params.config,
        baseUrl: params.baseUrl,
        provider: params.provider,
        signal: params.signal,
        isKimi: params.isKimi,
        isKimiCoding: params.isKimiCoding,
        useAnthropicProtocol: params.useAnthropicProtocol,
      })
      if (!cachedDraft) {
        this.storeCachedDocumentWidgetDraft(
          params.session,
          params.job.instruction,
          params.job,
          targetSnapshot,
          currentDraft,
        )
      }
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'compose_widget',
        status: 'completed',
        summary: cachedDraft
          ? `已复用 ${targetLabel} 的卡片草稿`
          : `已生成写入 ${targetLabel} 的卡片草稿`,
      })

      currentStep = 'write_target'
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'write_target',
        status: 'running',
        summary: `正在把卡片写入 ${targetLabel}`,
      })
      const writePayload = await params.requestModuleToolAction('document.insertWidget', {
        title: currentDraft.title,
        componentSpec: currentDraft.componentSpec,
        widgetCode: currentDraft.widgetCode,
        position: currentDraft.insertionMode === 'after_section' ? 'after_section' : 'append_end',
        sectionTitle: currentDraft.targetSectionTitle,
      })
      const writeSummary = typeof writePayload.summary === 'string' ? writePayload.summary : `已写入 ${targetLabel}`
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'write_target',
        status: 'completed',
        summary: writeSummary,
      })

      currentStep = 'save_target'
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'save_target',
        status: 'running',
        summary: `正在保存 ${targetLabel}`,
      })
      const savePayload = await params.requestModuleToolAction('document.saveTab', {})
      const saveSummary = typeof savePayload.summary === 'string' ? savePayload.summary : `已保存 ${targetLabel}`
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'save_target',
        status: 'completed',
        summary: saveSummary,
      })

      currentStep = 'verify_result'
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'verify_result',
        status: 'running',
        summary: `正在核对 ${targetLabel}`,
      })
      const verifySummary = await this.verifyDocumentTaskPlanWrite({
        draft: currentDraft,
        targetResource,
        requestModuleToolAction: params.requestModuleToolAction,
        signal: params.signal,
      })
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: 'verify_result',
        status: 'completed',
        summary: verifySummary,
      })

      return {
        success: true,
        writeSummary,
        saveSummary,
        verifySummary,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emitStepUpdate({
        job: params.job,
        jobIndex: params.jobIndex,
        step: currentStep,
        status: 'failed',
        summary: message,
        error: message,
      })
      return {
        success: false,
        step: currentStep,
        error: message,
        insight: currentInsight,
        draft: currentDraft,
      }
    }
  }

  private async runDocumentTaskPlan(params: {
    plan: DocumentTaskPlan
    requestEnvelope: RequestEnvelope
    session: DirectChatSession
    scopeId?: string
    parentTaskId?: string
    parentRunId?: string | null
    requestModuleToolAction: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
    signal: AbortSignal
    config: AIModelConfig
    baseUrl: string
    provider: ReturnType<typeof getProviderDef> | undefined
    isKimi: boolean
    isKimiCoding: boolean
    useAnthropicProtocol: boolean
    emitStructuredTaskPayload: (payload: unknown) => void
  }): Promise<{ success: boolean; finalText?: string; error?: string }> {
    if (params.plan.blockedReason) {
      params.emitStructuredTaskPayload({
        module: 'document',
        taskTitle: '文档信息卡',
        taskSummary: params.plan.blockedReason,
        steps: [{
          id: 'clarify_resource_mapping',
          title: '确认材料与目标映射',
          status: 'blocked',
          updatedAt: new Date().toISOString(),
        }],
        currentStepId: 'clarify_resource_mapping',
        waitingFor: 'confirmation',
        resumableActions: ['continue', 'cancel'],
        blockedReason: params.plan.blockedReason,
      })
      return {
        success: false,
        finalText: params.plan.blockedReason,
        error: params.plan.blockedReason,
      }
    }

    if (params.plan.jobs.length === 0) {
      return {
        success: false,
        error: '当前没有可执行的文档任务计划',
      }
    }

    const scope = params.scopeId ? this.runtime?.getConversationScope(params.scopeId) || null : null
    if (scope && params.parentTaskId && params.plan.jobs.length > 1 && this.runtime) {
      let latestFailureText: string | null = null
      const subtaskRuntime = new SubtaskRuntime({
        publishScopeRunEvent: (payload, projectionTruth) => {
          this.runtime?.publishScopeRunEvent(payload, projectionTruth || null)
        },
        runScopedTurn: async ({ scope, message, identity, requestId }) => {
          if (!message) {
            return { success: false, error: '子任务缺少消息内容' }
          }
          return this.runtime?.sendScoped({
            scopeId: scope.id,
            message: message as string | MultimodalBlock[],
            requestId: requestId || identity?.workerSessionId,
            taskId: identity?.taskId,
            parentTaskId: identity?.parentTaskId || params.parentTaskId,
            parentStepId: identity?.parentStepId,
            sessionIdOverride: identity?.workerSessionId,
          }) || { success: false, error: 'Agent runtime unavailable' }
        },
      })

      const multiJobResult = await runDocumentTaskPlanWithSubtasks({
        plan: params.plan,
        scope,
        parentTaskId: params.parentTaskId,
        parentRunId: params.parentRunId || null,
        subtaskRuntime,
        publishParentScopeRunEvent: (payload) => {
          this.runtime?.publishScopeRunEvent(payload)
        },
        emitStructuredTaskPayload: (payload) => params.emitStructuredTaskPayload(payload),
        runJob: async ({ job, jobIndex, totalJobs, emitChildUpdate }) => {
          const childStepStates = new Map<DocumentTaskStep, 'pending' | 'running' | 'done' | 'blocked'>()
          const buildChildSteps = () => job.steps.map((step) => ({
            id: step,
            title: this.buildDocumentTaskStepTitle(job, step, jobIndex, totalJobs),
            status: childStepStates.get(step) || 'pending',
            updatedAt: new Date().toISOString(),
          }))
          const jobResult = await this.executeDocumentTaskPlanJob({
            job,
            jobIndex,
            totalJobs,
            requestEnvelope: params.requestEnvelope,
            session: params.session,
            requestModuleToolAction: params.requestModuleToolAction,
            signal: params.signal,
            config: params.config,
            baseUrl: params.baseUrl,
            provider: params.provider,
            isKimi: params.isKimi,
            isKimiCoding: params.isKimiCoding,
            useAnthropicProtocol: params.useAnthropicProtocol,
            onStepUpdate: ({ step, status, summary, error }) => {
              childStepStates.set(
                step,
                status === 'running'
                  ? 'running'
                  : status === 'completed'
                    ? 'done'
                    : 'blocked',
              )
              emitChildUpdate({
                phase: status === 'failed' ? 'tool_running' : 'tool_running',
                taskSummary: summary,
                steps: buildChildSteps(),
                currentStepId: step,
                waitingFor: status === 'failed' ? 'confirmation' : 'none',
                resumableActions: status === 'failed' ? ['retry', 'cancel'] : ['cancel'],
                blockedReason: status === 'failed' ? (error || summary) : null,
              })
            },
          })
          if (!jobResult.success) {
            latestFailureText = this.buildDocumentTaskPlanFailureText({
              job,
              step: jobResult.step,
              error: jobResult.error,
              insight: jobResult.insight,
              draft: jobResult.draft,
            })
            throw new Error(jobResult.error)
          }
          return {
            finalText: jobResult.verifySummary,
            taskSummary: jobResult.verifySummary,
            steps: buildChildSteps(),
            currentStepId: 'verify_result',
            resumableActions: ['none'],
            waitingFor: 'none',
            writeSummary: jobResult.writeSummary,
            saveSummary: jobResult.saveSummary,
            verifySummary: jobResult.verifySummary,
          }
        },
      })

      if (!multiJobResult.success) {
        return {
          success: false,
          finalText: latestFailureText || multiJobResult.error,
          error: multiJobResult.error,
        }
      }

      return {
        success: true,
        finalText: this.buildDocumentTaskPlanSuccessText(multiJobResult.results || []),
      }
    }

    const stepStates = new Map<string, 'pending' | 'running' | 'done' | 'blocked'>()
    const allSteps = params.plan.jobs.flatMap((job, jobIndex) => job.steps.map((step) => ({
      id: this.buildDocumentTaskStepId(job, step),
      title: this.buildDocumentTaskStepTitle(job, step, jobIndex, params.plan.jobs.length),
    })))

    const emitPlanStep = (payload: {
      job: DocumentTaskJob
      jobIndex: number
      step: DocumentTaskStep
      status: 'running' | 'completed' | 'failed'
      summary: string
      error?: string
    }): void => {
      const stepId = this.buildDocumentTaskStepId(payload.job, payload.step)
      stepStates.set(
        stepId,
        payload.status === 'running'
          ? 'running'
          : payload.status === 'completed'
            ? 'done'
            : 'blocked',
      )

      params.emitStructuredTaskPayload({
        module: 'document',
        taskTitle: '文档信息卡',
        taskSummary: payload.summary,
        message: payload.summary,
        steps: allSteps.map((step) => ({
          id: step.id,
          title: step.title,
          status: stepStates.get(step.id) || 'pending',
          updatedAt: new Date().toISOString(),
        })),
        currentStepId: stepId,
        waitingFor: payload.status === 'failed' ? 'confirmation' : 'none',
        resumableActions: payload.status === 'failed' ? ['retry', 'cancel'] : ['cancel'],
        blockedReason: payload.status === 'failed' ? (payload.error || payload.summary) : null,
      })
    }

    const results: Array<{
      job: DocumentTaskJob
      writeSummary: string
      saveSummary: string
      verifySummary: string
    }> = []

    for (const [jobIndex, job] of params.plan.jobs.entries()) {
      const jobResult = await this.executeDocumentTaskPlanJob({
        job,
        jobIndex,
        totalJobs: params.plan.jobs.length,
        requestEnvelope: params.requestEnvelope,
        session: params.session,
        requestModuleToolAction: params.requestModuleToolAction,
        signal: params.signal,
        config: params.config,
        baseUrl: params.baseUrl,
        provider: params.provider,
        isKimi: params.isKimi,
        isKimiCoding: params.isKimiCoding,
        useAnthropicProtocol: params.useAnthropicProtocol,
        onStepUpdate: emitPlanStep,
      })
      if (!jobResult.success) {
        return {
          success: false,
          finalText: this.buildDocumentTaskPlanFailureText({
            job,
            step: jobResult.step,
            error: jobResult.error,
            insight: jobResult.insight,
            draft: jobResult.draft,
          }),
          error: jobResult.error,
        }
      }
      results.push({
        job,
        writeSummary: jobResult.writeSummary,
        saveSummary: jobResult.saveSummary,
        verifySummary: jobResult.verifySummary,
      })
    }

    return {
      success: true,
      finalText: this.buildDocumentTaskPlanSuccessText(results),
    }
  }

  private normalizeActiveDocumentSnapshot(raw: unknown): ActiveDocumentSnapshot | null {
    if (!raw || typeof raw !== 'object') return null
    const title = typeof (raw as { title?: unknown }).title === 'string' ? String((raw as { title: string }).title).trim() : ''
    const content = typeof (raw as { content?: unknown }).content === 'string' ? String((raw as { content: string }).content) : ''
    if (!title || !content) return null
    return {
      title,
      path: typeof (raw as { path?: unknown }).path === 'string' && (raw as { path: string }).path.trim()
        ? String((raw as { path: string }).path).trim()
        : null,
      content,
      isDirty: Boolean((raw as { isDirty?: unknown }).isDirty),
      charCount: typeof (raw as { charCount?: unknown }).charCount === 'number'
        ? Number((raw as { charCount: number }).charCount)
        : content.length,
    }
  }

  private buildDocumentInsightCacheKey(
    question: string,
    snapshot: ActiveDocumentSnapshot,
    options?: {
      job?: DocumentTaskJob | null
      cacheKeyOverride?: string | null
    },
  ): string {
    if (options?.cacheKeyOverride) return options.cacheKeyOverride
    if (options?.job) {
      return buildDocumentTaskStepCacheKey({
        question,
        step: 'build_insight',
        job: options.job,
        targetSnapshot: snapshot,
      })
    }
    const normalizedQuestion = String(question || '').trim().toLowerCase().replace(/\s+/g, ' ')
    const documentIdentity = snapshot.path || snapshot.title || 'active-document'
    const contentHash = createHash('sha1')
      .update(snapshot.content)
      .digest('hex')
      .slice(0, 12)
    return `${documentIdentity}::${contentHash}::${normalizedQuestion}`
  }

  private getCachedDocumentInsight(
    session: DirectChatSession,
    question: string,
    snapshot: ActiveDocumentSnapshot,
    options?: {
      job?: DocumentTaskJob | null
      cacheKeyOverride?: string | null
    },
  ): DocumentInsightStageResult | null {
    const key = this.buildDocumentInsightCacheKey(question, snapshot, options)
    const hit = session.documentInsightCache.find((entry) => entry.key === key)
    if (hit) {
      log(`document insight session cache hit key=${key}`)
      return {
        insight: hit.insight,
        metrics: {
          ...(hit.metrics || {}),
          cacheHit: true,
        },
      }
    }

    const sharedHit = this.documentInsightCache.get(key)
    if (!sharedHit) return null
    log(`document insight shared cache hit key=${key}`)
    return {
      insight: sharedHit.insight,
      metrics: {
        ...(sharedHit.metrics || {}),
        cacheHit: true,
      },
    }
  }

  private storeCachedDocumentInsight(
    session: DirectChatSession,
    question: string,
    snapshot: ActiveDocumentSnapshot,
    insight: DocumentInsight,
    metrics?: DocumentInsightMetrics,
    options?: {
      job?: DocumentTaskJob | null
      cacheKeyOverride?: string | null
    },
  ): void {
    const key = this.buildDocumentInsightCacheKey(question, snapshot, options)
    const nextEntry = {
      key,
      insight,
      metrics,
      createdAt: new Date().toISOString(),
    }
    session.documentInsightCache = [
      nextEntry,
      ...session.documentInsightCache.filter((entry) => entry.key !== key),
    ].slice(0, 6)
    this.documentInsightCache.set(key, { insight, metrics })
    log(`document insight cache store key=${key}`)
  }

  private getCachedDocumentWidgetDraft(
    session: DirectChatSession,
    question: string,
    job: DocumentTaskJob,
    snapshot: ActiveDocumentSnapshot,
  ): DocumentWidgetDraft | null {
    const key = this.buildDocumentWidgetDraftCacheKey(question, job, snapshot)
    const sessionHit = session.documentWidgetDraftCache.find((entry) => entry.key === key)
    if (sessionHit) {
      log(`document widget draft session cache hit key=${key}`)
      return sessionHit.draft
    }

    const sharedHit = this.documentWidgetDraftCache.get(key)
    if (!sharedHit) return null
    log(`document widget draft shared cache hit key=${key}`)
    return sharedHit
  }

  private storeCachedDocumentWidgetDraft(
    session: DirectChatSession,
    question: string,
    job: DocumentTaskJob,
    snapshot: ActiveDocumentSnapshot,
    draft: DocumentWidgetDraft,
  ): void {
    const key = this.buildDocumentWidgetDraftCacheKey(question, job, snapshot)
    const nextEntry = {
      key,
      draft,
      createdAt: new Date().toISOString(),
    }
    session.documentWidgetDraftCache = [
      nextEntry,
      ...session.documentWidgetDraftCache.filter((entry) => entry.key !== key),
    ].slice(0, 6)
    this.documentWidgetDraftCache.set(key, draft)
    log(`document widget draft cache store key=${key}`)
  }

  private async loadDocumentPipelineSnapshot(params: {
    userText: string
    requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
    signal: AbortSignal
    targetPathOverride?: string | null
  }): Promise<ActiveDocumentSnapshot> {
    const targetPath = params.targetPathOverride?.trim() || this.extractDocumentPathFromUserText(params.userText)
    const requestSnapshot = async (): Promise<ActiveDocumentSnapshot | null> => {
      if (!params.requestModuleToolAction) return null
      const payload = await params.requestModuleToolAction('document.inspectActive', {})
      return this.normalizeActiveDocumentSnapshot((payload as { snapshot?: unknown }).snapshot)
    }

    if (params.requestModuleToolAction && targetPath) {
      const activeSnapshot = await requestSnapshot()
      if (!activeSnapshot || activeSnapshot.path !== targetPath) {
        await params.requestModuleToolAction('document.openTab', { path: targetPath })
      }
    }

    const activeSnapshot = await requestSnapshot()
    if (activeSnapshot) {
      if (!targetPath || activeSnapshot.path === targetPath || activeSnapshot.path === null) {
        return activeSnapshot
      }
    }

    if (targetPath) {
      const readResult = await readDocumentEditableText(targetPath)
      if (readResult.success) {
        return {
          title: targetPath.split('/').pop() || targetPath,
          path: targetPath,
          content: readResult.content,
          isDirty: false,
          charCount: readResult.content.length,
        }
      }
      throw new Error(`文档读取失败：${readResult.error || targetPath}`)
    }

    throw new Error('当前没有可读取的活动文档')
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
