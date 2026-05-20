/**
 * Direct HTTP chat engine.
 * Bypasses Claude CLI — calls AI provider APIs directly for fast response.
 * Supports tool calling for browser control and other integrations.
 */

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
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
import { ResearchDomainAdapter } from '../agent-control/research-domain-adapter'
import { DocumentTaskPipelineExecutor } from '../agent-control/document-task-pipeline-executor'
import type { DocumentInsight, DocumentInsightMetrics, DocumentWidgetDraft } from '../agent-control/document-task-pipeline'
import {
  applyContinuationIntentToState,
  buildContinuationStateFromProjection,
  normalizeContinuationIntent,
  parseContinuationControlText,
  sanitizeContinuationRequest,
  selectContinuationProjection,
  type ContinuationIntent,
  type ContinuationState,
} from '../agent-control/continuation-state'
import { prepareInitialRun, reconcileAfterBrowserDecision } from '../agent-control/run-capability-controller'
import { SkillDomainAdapter } from '../agent-control/skills/skill-domain-adapter'
import { SkillContextOrchestrator } from '../agent-control/skills/skill-context-orchestrator'
import { SubtaskRuntime } from '../agent-control/subtask-runtime'
import { WidgetEditLeaseStore, type ActiveWidgetEditLease } from '../agent-control/widget-edit-lease'
import { buildToolRuntimeContext } from '../agent-control/tool-runtime-context-builder'
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
} from '../agent-control/task-projection/run-budget-policy'
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
  TurnSimpleResponse,
} from '../agent-control/run-contracts'
import type { TurnTerminalReason } from '../agent-control/turn-frame'
import type {
  AttachmentResourceList,
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
import { findSkillToolBySkillAction, findSkillToolByName } from '../tools/skills-tools'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import {
  buildTextToolResultMessage,
  looksLikeMissingNativeToolsReply,
  shouldEnforceBrowserToolRetry,
} from './tool-bridge'
import { deriveAgentErrorContract } from './error-contract'
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
import type { RequestEnvelope } from '../agent-control/request-envelope'
import { buildRequestEnvelope, extractPureUserInput as extractPureUserInputFromEnvelope } from '../agent-control/request-envelope'
import { recoverLatestSkillRunFromTaskProjections } from '../agent-control/skills/skill-run-recovery'
import { getLatestRecoverableSkillTaskRun } from '../agent-control/skills/skill-task-tracker'
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
import { createRotatingLogger } from '../../utils/rotating-logger'
import { readAIConfigDetailed, type AIConfigLoad } from './direct-chat-ai-config'
import { AttachmentLoadFailureThrottle } from './direct-chat-attachment-metrics'
import { assertCurrentMessageCapability } from '../agent-control/message-capability-filter'
import { logAgentMetric } from '../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../agent-control/tool-error-metrics'

const directChatLogger = createRotatingLogger('ready-directchat.log')
const settingsRepository = new AppSettingsRepository()
const chatRepository = new ChatRepository()

function log(msg: string) {
  try { directChatLogger.append(`[${new Date().toISOString()}] ${msg}\n`) } catch { /* */ }
}

function toContinuationUpdatedAt(value?: string | null): number {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : Date.now()
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
  toolSnapshots?: import('../agent-control/run-contracts').ToolSnapshot[]
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
如果用户要求“看看现在有哪些 widget / 更新这个 widget / 删除这个 widget”，优先使用 document_list_widgets / document_update_widget / document_remove_widget，不要退回整篇覆盖，也不要用 document_replace_text / document_replace_exact 修改 show-widget 围栏内部。
show-widget 规则：
- 使用 \`\`\`show-widget 围栏
- JSON 结构为 {"title":"snake_case_id","widget_code":"<div>...</div>"}
- 如能表达为结构化组件规格，优先使用 document_insert_widget / document_update_widget 的 componentSpec 参数，不要总是自由编写原始 HTML
- 人物关系图/关系网络优先用 componentSpec.component="relationship_graph"，只提供 groups/nodes/edges，不要手写 SVG 坐标
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
不要把 /skill ... 命令当成普通文本回复给用户；如果你决定执行 skill，就直接调用当前工具列表里真实存在的 skill_* 工具。
如果用户只提到站点名（例如“即梦”）但没有给 URL，且当前页也不能明确复用，先搜索该站点的官方入口并确认，再继续；若搜索结果仍不唯一，先向用户澄清，不要在无关页面反复进出。
当用户要求执行 openclaw 插件配对、批准飞书配对码、或明确给出类似”openclaw pairing approve feishu CODE”的命令时，优先调用 system_run_openclaw 工具真实执行本地命令，不要只复述命令文本。
当用户提到“上次那轮对话 / 之前讨论过 / 历史会话 / 旧会话里怎么说的 / 找找以前那次”时，优先使用 session_search 检索历史会话，再基于返回的会话摘要继续回答或引用，不要把 memory_search 当成历史聊天检索。

如果系统当前未启用工具，请不要伪造工具调用，直接给出文本回答。
`

export class DirectChatEngine extends EventEmitter {
  private sessions = new Map<string, DirectChatSession>()
  private readonly widgetEditLeaseStore = new WidgetEditLeaseStore()
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
  private readonly documentTaskPipelineExecutor: DocumentTaskPipelineExecutor
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
  private cancelPendingToolActions: ((agent: string, sessionId?: string) => void) | null = null
  private maxToolIterations = 24
  private attachmentLoadFailureThrottle = new AttachmentLoadFailureThrottle()

  constructor() {
    super()
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
    this.browserDomainOrchestrator = new BrowserDomainOrchestrator(browserTaskPlanner)
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
    this.executionLoopOrchestrator = new ExecutionLoopOrchestrator({ log })
    this.hostCapabilityDispatcher = new HostCapabilityDispatcher({
      executeHostTool: (toolName, args, toolContext) => executeToolCall(toolName, args, toolContext as any),
    })
    this.domainAdapters = [
      // Stage R W1.6: research adapter goes first so primaryDomain==='research'
      // intents are routed before browser/document can grab them.
      new ResearchDomainAdapter(),
      new BrowserDomainAdapter(this.browserDomainOrchestrator as never),
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

  getDomainAdapters(): ReadonlyArray<DomainAdapter> {
    return this.domainAdapters
  }

  getSkillContextOrchestrator(): SkillContextOrchestrator {
    return this.skillContextOrchestrator
  }

  private registerSessionAbortSource(
    name: string,
    sessionId: string | undefined,
    controller: AbortController,
  ): void {
    const normalizedSessionId = sessionId || null
    const scopeId = normalizedSessionId || name || null
    this.runtime?.registerSessionAbortController(scopeId, normalizedSessionId, controller)
    if (scopeId !== name || normalizedSessionId !== null) {
      this.runtime?.registerSessionAbortController(name, null, controller)
    }
  }

  private unregisterSessionAbortSource(
    name: string,
    sessionId: string | undefined,
    controller: AbortController,
  ): void {
    const normalizedSessionId = sessionId || null
    const scopeId = normalizedSessionId || name || null
    this.runtime?.unregisterSessionAbortController(scopeId, normalizedSessionId, controller)
    if (scopeId !== name || normalizedSessionId !== null) {
      this.runtime?.unregisterSessionAbortController(name, null, controller)
    }
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

  setCancelPendingToolActions(
    canceller: ((agent: string, sessionId?: string) => void) | null,
  ): void {
    this.cancelPendingToolActions = canceller
  }

  getAIConfigDetailed(): AIConfigLoad {
    return readAIConfigDetailed(() => settingsRepository.getSetting('ai_model_config'))
  }

  getAIConfig(): AIModelConfig | null {
    const detail = this.getAIConfigDetailed()
    if (!detail.ok) return null
    return detail.config
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
      // Stage 2.2: previously this catch silently returned `[]`, making DB
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
    })
    this.documentTaskPipelineExecutor.clearSessionCache(name)
    this.widgetEditLeaseStore.release(name)
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
      const previousAbortController = session.abortController
      this.unregisterSessionAbortSource(name, undefined, previousAbortController)
      previousAbortController.abort(new Error('cancelled_user'))
      session.abortController = null
    }
    if (runId) {
      this.emit('status', { agent: name, runId, status: 'cancelled', terminalReason: 'cancelled_user', isMock: false })
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
      continuationIntent?: ContinuationIntent | null
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
    const normalizedContinuationIntent = normalizeContinuationIntent(executionOptions?.continuationIntent || null)
    const parsedContinuationControl = typeof rawContinuationUserText === 'string'
      ? parseContinuationControlText(rawContinuationUserText)
      : null
    const resolvedContinuationState = executionOptions?.continuationState
      || this.resolveContinuationStateFromIntent(sessionId, normalizedContinuationIntent)
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
      const previousAbortController = session.abortController
      try {
        this.cancelPendingToolActions?.(name, sessionId)
      } catch (cancelError) {
        log(`sendMessage cancelPendingToolActions failed: ${(cancelError as Error)?.message || cancelError}`)
      }
      session.generation += 1
      this.unregisterSessionAbortSource(name, sessionId, previousAbortController)
      previousAbortController.abort(new Error('process_restarted'))
      session.abortController = null
      log(`sendMessage preempted previous in-flight run for agent=${name}`)
    }
    try {
      const lease = this.widgetEditLeaseStore.resolve(name, sessionId)
      if (lease && lease.expireAt - Date.now() < 30_000) {
        this.widgetEditLeaseStore.refresh(name, sessionId)
        log(`sendMessage refreshed widget-edit lease for agent=${name} sessionId=${sessionId || ''}`)
      }
    } catch (leaseRefreshError) {
      log(`sendMessage refresh lease failed: ${(leaseRefreshError as Error)?.message || leaseRefreshError}`)
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
        sessionId,
        runId,
        taskId,
        chunk,
        type,
        projectionPatch: options?.projectionPatch || null,
      })
    }
    const emitStatus = (status: string, terminalReason?: TurnTerminalReason | null): void => {
      if (!isCurrentRun()) return
      this.emit('status', {
        agent: name,
        sessionId,
        runId,
        status,
        ...(typeof terminalReason === 'undefined' ? {} : { terminalReason }),
        isMock: false,
      })
    }
    const emitRuntimeError = (error: unknown, options?: { toolName?: string }): void => {
      if (!isCurrentRun()) return
      const contract = deriveAgentErrorContract(error, options)
      const message = error instanceof Error ? error.message : String(error)
      this.emit('error', {
        agent: name,
        sessionId,
        runId,
        error: message,
        type: 'runtime',
        ...contract,
      })
    }
    const emitToolAction = (tool: string, args: Record<string, unknown>): void => {
      if (!isCurrentRun()) return
      this.emit('toolAction', { agent: name, sessionId, runId, tool, args })
    }

    const configDetail = this.getAIConfigDetailed()
    if (!configDetail.ok) {
      // Stage 2.4a: distinguish corrupt JSON from DB error rather than
      // collapsing both into "no config". Each gets a different user
      // message and a more honest terminalReason so the failure mode is
      // visible to both the user and the renderer's task projection.
      session.activeRunId = null
      const userMsg =
        configDetail.reason === 'json_corrupt'
          ? 'AI 配置已损坏（JSON 解析失败），请前往设置页重置'
          : 'AI 配置读取失败（数据库错误），请稍后重试或检查日志'
      emitOutput(userMsg, 'error')
      emitOutput('', 'done')
      emitStatus(
        'error',
        configDetail.reason === 'json_corrupt' ? 'blocked_config' : 'persistence_failed',
      )
      return {
        success: false,
        error: userMsg,
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
    const config = configDetail.config
    if (!config || !config.apiKey) {
      session.activeRunId = null
      emitOutput('未配置 API Key，请前往设置页配置', 'error')
      emitOutput('', 'done')
      emitStatus('error', 'persistence_failed')
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

    // PR 2 Phase C.3 — current-turn capability pre-check at the legacy
    // DirectChatEngine entry. Vision-off + image attachment → throw a
    // `ToolDomainError('provider_request_failed')` BEFORE history sanitize
    // could mask it; that way history-side stripping (in execution clients)
    // can safely treat any remaining image residue as prior-turn data.
    // Video is left to the existing `supportsVideoBlock` text-downgrade
    // path above because legacy code has historically tolerated it; the
    // hard image gate is the regression fix.
    if (Array.isArray(normalizedContent)) {
      try {
        assertCurrentMessageCapability(
          normalizedContent
            .filter((b) => b && typeof b === 'object')
            .map((b) => ({ ...(b as unknown as Record<string, unknown>) })) as Array<{ type: string; [key: string]: unknown }>,
          {
            supportsVision: capabilities?.supportsVision === true,
            // Anthropic / kimi-coding video path already has its own
            // downgrade; we only enforce image here.
            supportsVideo: true,
          },
        )
      } catch (capErr) {
        log(`direct-chat current-turn capability rejected: ${capErr instanceof Error ? capErr.message : String(capErr)}`)
        logAgentMetric(TOOL_ERROR_METRICS.providerRequestImageBlockedAtAttach, {
          sessionId,
          provider: config.provider,
          model: config.model,
          errorMessage: capErr instanceof Error ? capErr.message.slice(0, 200) : String(capErr).slice(0, 200),
        })
        throw capErr
      }
    }

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
    this.registerSessionAbortSource(name, sessionId, abortController)
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
        emitStatus('cancelled', 'cancelled_runtime')
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
      // Phase 3: recoverable runtime errors skip the red transcript line so the
      // soft-failure capsule carries the only surface. Terminal errors keep the
      // transcript line for the system-message fallback path.
      const contract = deriveAgentErrorContract(error)
      if (!contract.recoverable) {
        emitOutput(`API 请求失败: ${msg}`, 'error')
      }
      emitOutput('', 'done')
      emitRuntimeError(error)
      emitStatus('error', 'persistence_failed')
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
      this.unregisterSessionAbortSource(name, sessionId, abortController)
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
        getMemoryRepository: () => this.runtime?.getMemoryRepository() || null,
        getPromptAssembly: () => this.runtime?.getPromptAssembly() || null,
        searchSessionRecall: (payload?: Record<string, unknown>) =>
          this.runtime?.searchSessionRecall(payload as any) ?? [],
        listRecentSessions: (payload?: Record<string, unknown>) =>
          this.runtime?.listRecentSessions(payload as any) ?? [],
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
      resolveRecentSkillRun: (sessionId: string | undefined) =>
        this.resolveRecentSkillRunFromTaskProjections(sessionId),
      resolveRecentSkillTaskRun: (sessionId: string | undefined) =>
        this.resolveRecentSkillRunFromTaskRuns(sessionId),
      getIncomingAttachmentHints: (turnContent: RunMessage) => this.getIncomingAttachmentHints(turnContent),
      collectRecentPureUserInputs: (messages: ChatMessage[], limit?: number) => this.collectRecentPureUserInputs(messages, limit),
      sessionHasMediaInputs: (messages: ChatMessage[]) => this.sessionHasMediaInputs(messages),
      sessionHasVideoInputs: (messages: ChatMessage[]) => this.sessionHasVideoInputs(messages),
      resolveActiveWidgetEditLease: () => this.widgetEditLeaseStore.resolve(params.name, params.sessionId),
      refreshActiveWidgetEditLease: (ttlMs?: number) =>
        this.widgetEditLeaseStore.refresh(params.name, params.sessionId, ttlMs ? { ttlMs } : undefined),
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
        allowedToolNames?: string[] | null
        hasTools?: boolean
        allowBrowserTools?: boolean
        providerContext: TurnProviderContext
        hasVideoInputs: boolean
        browserDecisionMode?: string | null
        runtimeSnapshot?: {
          browserHostAvailable?: boolean
          groups?: Record<string, { status: string }>
        } | null
        visibleCapabilityGroupIds?: import('../../../shared/ai-capability-groups').CapabilityGroupId[]
        suppressedCapabilityGroupIds?: import('../../../shared/ai-capability-groups').CapabilityGroupId[]
        capabilityLogLine?: string | null
        iteration?: number
        requestedTransport?: 'native' | 'text' | 'none'
        supportsNativeTools?: boolean
        preferTextToolBridgeOnce?: boolean
        compressContext?: () => Promise<boolean> | boolean
        onBeforeRetry?: (result: unknown, attempt: number) => Promise<void> | void
      }) => this.requestToolLoopResponse(raw),
      executeToolBatch: async (raw: {
        toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>
        context: import('../agent-control/tool-runtime').ToolRuntimeContext
        executeTool?: (toolCall: { id: string; name: string; input: Record<string, unknown> }) => Promise<unknown>
        hooks?: import('../agent-control/tool-execution-hooks').ToolExecutionHooks
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
    allowedToolNames?: string[] | null
    hasTools?: boolean
    allowBrowserTools?: boolean
    providerContext: TurnProviderContext
    hasVideoInputs: boolean
    browserDecisionMode?: string | null
    runtimeSnapshot?: {
      browserHostAvailable?: boolean
      groups?: Record<string, { status: string }>
    } | null
    visibleCapabilityGroupIds?: import('../../../shared/ai-capability-groups').CapabilityGroupId[]
    suppressedCapabilityGroupIds?: import('../../../shared/ai-capability-groups').CapabilityGroupId[]
    capabilityLogLine?: string | null
    iteration?: number
    requestedTransport?: 'native' | 'text' | 'none'
    supportsNativeTools?: boolean
    preferTextToolBridgeOnce?: boolean
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
        preferTextToolBridgeOnce: params.preferTextToolBridgeOnce,
        toolSnapshotContext: {
          iteration: Math.max(0, Number(params.iteration || 0)),
          browserDecisionMode: params.browserDecisionMode || null,
          browserHostAvailable: typeof params.runtimeSnapshot?.browserHostAvailable === 'boolean'
            ? params.runtimeSnapshot.browserHostAvailable
            : null,
          hasTools: params.hasTools ?? Boolean(params.allowedToolNames && params.allowedToolNames.length > 0),
          allowBrowserTools: params.allowBrowserTools ?? Boolean((params.toolPolicy as { allowBrowserTools?: boolean } | null | undefined)?.allowBrowserTools),
          visibleCapabilityGroupIds: [...(params.visibleCapabilityGroupIds || [])],
          suppressedCapabilityGroupIds: [...(params.suppressedCapabilityGroupIds || [])],
          requestedTransport: params.requestedTransport || (params.preferTextToolBridgeOnce ? 'text' : 'native'),
          supportsNativeTools: params.supportsNativeTools ?? true,
          preferTextToolBridge: Boolean(params.preferTextToolBridgeOnce),
          expectedAllowedToolNames: params.allowedToolNames || [],
        },
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

  private resolveRecentSkillRunFromTaskProjections(sessionId: string | undefined): SkillRunRecord | null {
    const runtime = this.runtime
    if (!runtime || !sessionId) return null
    return recoverLatestSkillRunFromTaskProjections({
      projections: runtime.listTaskProjections(sessionId),
      skills: getSkillsRuntimeManager().listSkills(),
      resolveSkillToolByAction: (skillId, actionName) => findSkillToolBySkillAction(skillId, actionName),
    })
  }

  private resolveRecentSkillRunFromTaskRuns(sessionId: string | undefined): SkillRunRecord | null {
    if (!sessionId) return null
    const record = getLatestRecoverableSkillTaskRun(sessionId)
    if (!record?.skillId) return null
    const action = record.action || record.toolName || ''
    const toolName = record.toolName
      || (action ? findSkillToolBySkillAction(record.skillId, action)?.name || '' : '')
    const resourceSummary = record.resourceRefs && record.resourceRefs.length > 0
      ? JSON.stringify(record.resourceRefs).slice(0, 240)
      : ''
    const summary = [
      `技能：${record.skillName || record.skillId}`,
      record.goalText ? `上次目标：${record.goalText}` : '',
      record.outputDir ? `输出目录：${record.outputDir}` : '',
      record.runStatePath ? `run_state：${record.runStatePath}` : '',
      record.sceneScoresPath ? `scene_scores：${record.sceneScoresPath}` : '',
      record.failureDetail ? `失败原因：${record.failureDetail}` : '',
      resourceSummary ? `资源：${resourceSummary}` : '',
    ].filter((item) => item.trim().length > 0).join('；')

    return {
      toolName,
      skillId: record.skillId,
      action,
      success: record.status === 'done',
      status: record.status,
      runKind: 'skill_task_run',
      taskRunId: record.id,
      detachedTaskId: record.detachedTaskId || undefined,
      jobId: record.jobId || undefined,
      outputDir: record.outputDir || undefined,
      runStatePath: record.runStatePath || undefined,
      pauseReason: record.status === 'blocked' ? 'background_running' : undefined,
      resumePayload: record.resumePayload || undefined,
      summary,
      updatedAt: toContinuationUpdatedAt(record.updatedAt),
    }
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
        projectionBudget: projection.budget || null,
        projectionBudgetRuntime: null,
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
      projectionBudget: null,
      projectionBudgetRuntime: null,
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

  private resolveContinuationStateFromIntent(
    sessionId: string | undefined,
    intent: ContinuationIntent | null | undefined,
  ): ContinuationState | null {
    const normalizedIntent = normalizeContinuationIntent(intent)
    if (!normalizedIntent) return null

    const projection = this.resolveContinuationProjection(sessionId, '', {
      explicitTaskId: normalizedIntent.taskId,
      allowImplicitContinuation: true,
    })

    if (projection) {
      const baseState = buildContinuationStateFromProjection(projection, {
        executionId: normalizedIntent.executionId ?? null,
        stepId: normalizedIntent.stepId ?? null,
        blockedReason: normalizedIntent.blockedReason ?? projection.blockedReason ?? null,
      })
      const intentState = applyContinuationIntentToState(baseState, normalizedIntent)
      const restoredBudget = restoreContinuationTaskBudgetRuntime({
        taskType: 'continuation',
        projectionBudget: projection.budget || null,
        projectionBudgetRuntime: null,
        continuationState: intentState,
      })
      const resolvedState: ContinuationState = {
        ...intentState,
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

    const persistedState = getContinuationState(sessionId, { taskId: normalizedIntent.taskId })
    if (!persistedState) return null

    const intentState = applyContinuationIntentToState(persistedState, normalizedIntent)
    const restoredBudget = restoreContinuationTaskBudgetRuntime({
      taskType: 'continuation',
      projectionBudget: null,
      projectionBudgetRuntime: null,
      continuationState: intentState,
    })
    const resolvedState: ContinuationState = {
      ...intentState,
      budgetRuntime: restoredBudget.runtime || intentState.budgetRuntime || null,
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
      this.documentTaskPipelineExecutor.clearSessionCache(name)
      this.widgetEditLeaseStore.release(name)
    }
    this.sessions.clear()
    this.widgetEditLeaseStore.clear()
  }
}
