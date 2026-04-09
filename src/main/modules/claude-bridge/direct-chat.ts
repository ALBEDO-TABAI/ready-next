/**
 * Direct HTTP chat engine.
 * Bypasses Claude CLI — calls AI provider APIs directly for fast response.
 * Supports tool calling for browser control and other integrations.
 */

import { EventEmitter } from 'events'
import { execFile } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { AIModelConfig, type AIWireAPI, getProviderDef, normalizeAIConfig, resolveAIConfigCapabilities } from '../../../shared/ai-providers'
import { BrowserController } from '../browser-engine/ipc-handler'
import type { SidecarManager } from '../agent-control/sidecar-manager'
import { BrowserTaskPlanner } from '../agent-control/browser-task-planner'
import type {
  BrowserTaskAttachmentResource,
  BrowserTaskDecision,
  BrowserTaskPlan,
  BrowserTaskPlanContinuity,
} from '../../../shared/browser-agent-task'
import { parseJsonOrEventStreamResponse } from '../openai-responses'
import {
  domainsLikelyMatch,
  getBrowserWorkflowState,
  getLatestSkillRun,
  getRecentBrowserActions,
  type BrowserActionRecord,
  type BrowserWorkflowState,
  type SkillRunRecord,
} from '../agent-control/session-continuity'
import { BrowserAgentRunner } from '../tools/browser-agent-runner'
import { getSkillsRuntimeManager, type SkillState } from '../skills-runtime/runtime-manager'
import { readDocumentEditableText, writeDocumentEditableText } from '../document-engine/ipc-handler'
import {
  getAnthropicTools,
  getOpenAITools,
  getDocumentAnthropicTools,
  getDocumentOpenAITools,
  executeToolCall,
} from '../tools'
import { normalizeOpenAIToolSchema, normalizeToolJsonSchema } from '../tools/tool-schema'
import { findSkillToolBySkillAction } from '../tools/skills-tools'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import {
  buildTextToolBridgePrompt,
  buildTextToolResultMessage,
  looksLikeMissingNativeToolsReply,
  parseTextToolBridgeResponse,
} from './tool-bridge'
import {
  extractPrimaryUserInstruction as extractPrimaryUserInstructionFromText,
  hasExplicitDocumentWidgetCreateIntent as hasExplicitDocumentWidgetCreateIntentFromText,
  inferDocumentWidgetTaskKind as inferDocumentWidgetTaskKindFromText,
  shouldForceDocumentToolCall as shouldForceDocumentToolCallFromText,
  shouldPreferFormatOnly as shouldPreferFormatOnlyFromText,
  shouldPreferSectionRewrite as shouldPreferSectionRewriteFromText,
  type DocumentWidgetTaskKind,
} from './tool-policy-heuristics'
import {
  buildDocumentWidgetClarificationSnippet,
  buildDocumentWidgetGuidanceSnippet,
  buildDocumentWidgetOpenUIRulesSnippet,
  inferDocumentWidgetProfile,
  type DocumentWidgetProfile,
} from './widget-guidance'
import { accumulateDocumentToolProgress, buildDocumentToolCompletionText } from './document-tool-flow'
import { compactToolPolicyHistory, resolveToolPolicyInput } from './tool-policy-context'
import { DEFAULT_API_REQUEST_TIMEOUT_MS, resolveApiRequestTimeoutMs } from './request-timeout-policy'
import { ChatRepository } from '../repositories/chat-repository'
import type { ConversationScope } from '../agent-control/types'
import { getLogPath, getWhichCommand } from '../../utils/platform'

const LOG = getLogPath('ready-directchat.log')
const execFileAsync = promisify(execFile)
const DEFAULT_KIMI_CODING_USER_AGENT = 'KimiCLI/1.14.0'
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
}

interface ToolPolicy {
  forceDocumentTool: boolean
  forceDesignTool: boolean
  preferredDesignTool: string | null
  primaryDesignInstruction: string | null
  allowMultipleDesignArtifacts: boolean
  preferSectionRewrite: boolean
  preferFormatOnly: boolean
  documentWidgetTaskKind?: DocumentWidgetTaskKind
  documentWidgetProfile?: DocumentWidgetProfile | null
  documentWidgetSourceText?: string | null
  allowBrowserTools: boolean
  preferredSkillToolNames?: string[] | null
}

const PREFERRED_DESIGN_FALLBACK_TOOL_NAMES = new Set([
  'design_open_file',
  'design_capture_session',
  'design_get_editor_state',
  'design_get_style_guide',
  'design_snapshot_layout',
  'design_find_empty_space_on_canvas',
  'design_capture_canvas_screenshot',
  'design_verify_layout',
  'design_list_owned_nodes',
  'design_batch_design',
  'design_create_geo_shape',
  'design_save_project',
  'design_export_artifact',
])

interface SectionRewritePlan {
  sectionTitle: string
  content: string
}

interface DocumentSnapshot {
  path: string
  hash: string
  length: number
}

const CONTENT_MUTATING_DOCUMENT_TOOL_NAMES = new Set([
  'document_set_content',
  'document_append_content',
  'document_insert_widget',
  'document_update_widget',
  'document_remove_widget',
  'document_replace_text',
  'document_replace_exact',
  'document_format_section',
  'document_rewrite_section',
])

const DOCUMENT_INSPECTION_TOOL_NAMES = new Set([
  'document_list_widgets',
])

const FORCE_DOCUMENT_TOOL_NAMES = new Set([
  'document_open_tab',
  'document_switch_tab',
  'document_rename_tab',
  'document_list_widgets',
  ...CONTENT_MUTATING_DOCUMENT_TOOL_NAMES,
  'document_save_tab',
])

const FORMAT_SECTION_DOCUMENT_TOOL_NAMES = new Set([
  'document_open_tab',
  'document_switch_tab',
  'document_set_content',
  'document_append_content',
  'document_replace_text',
  'document_format_section',
  'document_save_tab',
])

const SECTION_REWRITE_DOCUMENT_TOOL_NAMES = new Set([
  'document_open_tab',
  'document_switch_tab',
  'document_rewrite_section',
  'document_save_tab',
])

const DOCUMENT_WIDGET_CREATE_TOOL_NAMES = new Set([
  'document_open_tab',
  'document_switch_tab',
  'document_list_widgets',
  'document_insert_widget',
  'document_update_widget',
  'document_save_tab',
])

const DOCUMENT_WIDGET_INSPECT_TOOL_NAMES = new Set([
  'document_open_tab',
  'document_switch_tab',
  'document_list_widgets',
])

const DOCUMENT_WIDGET_UPDATE_TOOL_NAMES = new Set([
  'document_open_tab',
  'document_switch_tab',
  'document_list_widgets',
  'document_update_widget',
  'document_save_tab',
])

const DOCUMENT_WIDGET_REMOVE_TOOL_NAMES = new Set([
  'document_open_tab',
  'document_switch_tab',
  'document_list_widgets',
  'document_remove_widget',
  'document_save_tab',
])

function shouldPreferDocumentInspectionResult(
  responseText: string | undefined,
  inspectionResult: string | null,
): boolean {
  if (!inspectionResult) return false
  const trimmed = (responseText || '').trim()
  if (!trimmed) return true
  if (trimmed.includes(inspectionResult)) return false
  return [
    /调用了\s*`?document_list_widgets`?/i,
    /这是一个查询操作/i,
    /任务已完成/i,
    /如果用户需要我执行其他文档修改操作/i,
  ].some((pattern) => pattern.test(trimmed))
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

interface SectionAnchor {
  line: number
  level: number
  title: string
  key: string
}

function normalizeSectionKey(value: string): string {
  const punctuationPattern = new RegExp("[`*_~#>:：,.，。!?！？;；、()\\[\\]{}'\"“”‘’\\s]+", 'g')
  return value
    .toLowerCase()
    .replace(punctuationPattern, '')
    .trim()
}

function inferPlainSectionAnchor(
  lines: string[],
  index: number,
  options?: { aggressive?: boolean },
): { level: number; title: string } | null {
  const line = lines[index]?.trim() || ''
  if (!line) return null
  if (line.length < 4 || line.length > 40) return null

  let nextIndex = index + 1
  while (nextIndex < lines.length && !lines[nextIndex].trim()) {
    nextIndex += 1
  }
  const nextLine = nextIndex < lines.length ? lines[nextIndex].trim() : ''

  if (
    !/[。！？；，,:：]/.test(line) &&
    !/[0-9]/.test(line) &&
    /[\u4e00-\u9fa5]{4,}/.test(line) &&
    /^((?:\d{1,2}\.\d{1,2}(?:\.\d{1,2})*)|(?:\d{1,2}[.、]))\s+/.test(nextLine)
  ) {
    return { level: 2, title: line }
  }

  if (!options?.aggressive) return null

  const hasText = /[\u4e00-\u9fa5A-Za-z]/.test(line)
  if (!hasText) return null

  // Aggressive heading inference for DOCX raw text:
  // prefer short, standalone lines that are likely section titles.
  const looksQuestionHeading = /[？?！!]$/.test(line) && line.length <= 22
  const shortTitleLike =
    line.length <= 24 &&
    !/[。；，,:：]/.test(line) &&
    !/^(因此|但是|然而|因为|如果|我们|他们|你们|这是|这个)/.test(line)

  const dashLeadTitle = /^[-—–]{1,2}\s*/.test(line) && line.length <= 30
  const latinOnlyTitle = /^[A-Za-z][A-Za-z0-9 _-]{1,30}$/.test(line)

  if (!(looksQuestionHeading || shortTitleLike || dashLeadTitle || latinOnlyTitle)) {
    return null
  }

  return {
    level: looksQuestionHeading ? 2 : 3,
    title: line,
  }
}

function parseSectionAnchor(rawLine: string): { level: number; title: string } | null {
  const line = rawLine.trim()
  if (!line) return null

  const markdownHeading = line.match(/^(#{1,6})\s+(.+?)\s*$/)
  if (markdownHeading) {
    return {
      level: markdownHeading[1].length,
      title: markdownHeading[2].trim(),
    }
  }

  const numericHeading = line.match(
      /^((?:\d{1,2}\.\d{1,2}(?:\.\d{1,2})*)|(?:\d{1,2}[.、]))\s+(.+)$/,
  )
  if (numericHeading && line.length <= 100) {
    const numericCore = numericHeading[1].replace(/[、.]$/, '')
    const depth = numericCore.split('.').filter(Boolean).length
    return {
      level: Math.min(6, depth + 1),
      title: `${numericCore} ${numericHeading[2].trim()}`.trim(),
    }
  }

  const chineseOrdinalHeading = line.match(
    /^(?:([一二三四五六七八九十百千]+)[、.．]\s*(.+)|[（(]([一二三四五六七八九十百千]+)[）)]\s*(.+))$/,
  )
  if (chineseOrdinalHeading && line.length <= 100) {
    const ordinal = chineseOrdinalHeading[1] || chineseOrdinalHeading[3] || ''
    const body = chineseOrdinalHeading[2] || chineseOrdinalHeading[4] || ''
    return {
      level: 2,
      title: `${ordinal} ${body.trim()}`.trim(),
    }
  }

  const plainHeading = line.match(
    /^(第[一二三四五六七八九十百千万0-9]+(?:部分|章|节)|引言|序言|前言|摘要|结语|结论|附录)\s*([：:]\s*.+)?$/,
  )
  if (!plainHeading) return null
  if (line.length > 80) return null
  const suffix = plainHeading[2] ? plainHeading[2].replace(/^[：:]\s*/, '').trim() : ''
  const title = suffix ? `${plainHeading[1]} ${suffix}` : plainHeading[1]
  return {
    level: 2,
    title: title.trim(),
  }
}

function collectSectionAnchors(lines: string[], options?: { aggressive?: boolean }): SectionAnchor[] {
  const anchors: SectionAnchor[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseSectionAnchor(lines[i]) || inferPlainSectionAnchor(lines, i, options)
    if (!parsed) continue
    anchors.push({
      line: i,
      level: parsed.level,
      title: parsed.title,
      key: normalizeSectionKey(parsed.title),
    })
  }
  return anchors
}

function parseChineseSectionNumber(raw: string): number | null {
  const token = raw.trim()
  if (!token) return null
  if (/^\d+$/.test(token)) {
    const numeric = Number(token)
    return Number.isInteger(numeric) && numeric > 0 ? numeric : null
  }

  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }

  if (token === '十') return 10
  if (token.includes('十')) {
    const [left, right] = token.split('十')
    const tens = left ? digits[left] : 1
    const units = right ? digits[right] : 0
    if (tens === undefined || units === undefined) return null
    const value = tens * 10 + units
    return value > 0 ? value : null
  }

  const direct = digits[token]
  return direct && direct > 0 ? direct : null
}

function extractSectionOrdinal(sectionTitle: string): number | null {
  const match = sectionTitle.match(/第([一二三四五六七八九十两0-9]+)(?:部分|章|节)?/i)
  if (!match?.[1]) return null
  return parseChineseSectionNumber(match[1])
}

function pickOrdinalAnchor(sectionAnchors: SectionAnchor[], ordinal: number): SectionAnchor | null {
  if (ordinal < 1) return null
  if (sectionAnchors.length === 0) return null
  const minLevel = Math.min(...sectionAnchors.map((item) => item.level))
  const topLevelAnchors = sectionAnchors.filter((item) => item.level === minLevel)
  if (topLevelAnchors.length === 0) return null
  return topLevelAnchors[ordinal - 1] || null
}

function findSectionAnchor(sectionAnchors: SectionAnchor[], sectionTitle: string): SectionAnchor | null {
  const targetKey = normalizeSectionKey(sectionTitle)
  if (!targetKey) return null
  const exact = sectionAnchors.find((item) => item.key === targetKey)
  if (exact) return exact
  const fuzzy =
    sectionAnchors.find((item) => item.key.includes(targetKey) || targetKey.includes(item.key)) || null
  if (fuzzy) return fuzzy
  const ordinal = extractSectionOrdinal(sectionTitle)
  if (ordinal) {
    const byOrdinal = pickOrdinalAnchor(sectionAnchors, ordinal)
    if (byOrdinal) return byOrdinal
  }
  return null
}

function getSectionEndLine(sectionAnchors: SectionAnchor[], current: SectionAnchor, totalLines: number): number {
  let sectionEndLine = totalLines
  for (const anchor of sectionAnchors) {
    if (anchor.line <= current.line) continue
    if (anchor.level <= current.level) {
      sectionEndLine = anchor.line
      break
    }
  }
  return sectionEndLine
}

function formatParagraphIntoReadableChunks(
  paragraph: string,
  options?: { aggressive?: boolean },
): string {
  const cleaned = paragraph.replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  if (cleaned.length < 130 || !/[。！？；!?;]/.test(cleaned)) {
    if (options?.aggressive) {
      const ordinalBulletSplit = cleaned
        .split(/(?=其[一二三四五六七八九十][，、]|第[一二三四五六七八九十百0-9]+[，、])/g)
        .map((item) => item.trim())
        .filter(Boolean)
      if (ordinalBulletSplit.length >= 3) {
        return ordinalBulletSplit.map((item) => `- ${item}`).join('\n')
      }
    }
    return cleaned
  }

  let chunks = cleaned
    .split(/(?<=[。！？；!?;])\s*/g)
    .map((item) => item.trim())
    .filter(Boolean)
  if (chunks.length <= 1) return cleaned

  if (options?.aggressive && chunks.length >= 4) {
    const ordinalBulletSplit = cleaned
      .split(/(?=其[一二三四五六七八九十][，、]|第[一二三四五六七八九十百0-9]+[，、])/g)
      .map((item) => item.trim())
      .filter(Boolean)
    if (ordinalBulletSplit.length >= 3) {
      return ordinalBulletSplit.map((item) => `- ${item}`).join('\n')
    }
  }

  const grouped: string[] = []
  let bucket: string[] = []
  for (const sentence of chunks) {
    bucket.push(sentence)
    const joinLimit = options?.aggressive ? 70 : 100
    const sentenceLimit = options?.aggressive ? 1 : 2
    if (bucket.length >= sentenceLimit || bucket.join('').length >= joinLimit) {
      grouped.push(bucket.join(''))
      bucket = []
    }
  }
  if (bucket.length > 0) grouped.push(bucket.join(''))
  return grouped.join('\n\n')
}

function formatSectionBodyPreservingMeaning(
  sourceBody: string,
  options?: { aggressive?: boolean },
): string {
  const normalized = sourceBody.replace(/\r\n/g, '\n')
  const collapsed = normalized
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!collapsed) return ''
  const paragraphs = collapsed
    .split(/\n{2,}/)
    .map((item) => item.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)
  return paragraphs.map((item) => formatParagraphIntoReadableChunks(item, options)).join('\n\n').trim()
}

function formatSectionInDocument(
  source: string,
  sectionTitle: string,
): { content: string; found: boolean; matchedTitle?: string } {
  const normalizedSource = source.replace(/\r\n/g, '\n')
  const lines = normalizedSource.split('\n')
  const sectionAnchors = collectSectionAnchors(lines)
  const target = findSectionAnchor(sectionAnchors, sectionTitle)
  if (!target) return { content: normalizedSource, found: false }

  const sectionEndLine = getSectionEndLine(sectionAnchors, target, lines.length)
  const originalBody = lines.slice(target.line + 1, sectionEndLine).join('\n')
  const formattedBody = formatSectionBodyPreservingMeaning(originalBody)
  const headingMeta = parseSectionAnchor(lines[target.line]) || inferPlainSectionAnchor(lines, target.line)
  const headingLine = lines[target.line].trim()
  const normalizedHeading = /^#{1,6}\s+/.test(headingLine)
    ? headingLine
    : headingMeta
      ? `${'#'.repeat(Math.min(Math.max(headingMeta.level, 1), 4))} ${headingLine}`
      : lines[target.line]
  const nextLines = [
    ...lines.slice(0, target.line),
    normalizedHeading,
    formattedBody,
    ...lines.slice(sectionEndLine),
  ]
  return {
    content: nextLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n',
    found: true,
    matchedTitle: target.title,
  }
}

interface FormattingMetrics {
  headingCount: number
  bulletCount: number
  paragraphCount: number
}

function computeFormattingMetrics(content: string): FormattingMetrics {
  const normalized = content.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const headingCount = lines.filter((line) => /^#{1,6}\s+/.test(line.trim())).length
  const bulletCount = lines.filter((line) => /^[-*]\s+/.test(line.trim())).length
  const paragraphCount = normalized
    .trim()
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean).length
  return {
    headingCount,
    bulletCount,
    paragraphCount,
  }
}

function normalizeForIntegrityCheck(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/\s+/g, '')
    .trim()
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a[i] === b[i]) i += 1
  return i
}

function commonSuffixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1
  return i
}

function validateFormattingIntegrity(before: string, after: string): {
  safe: boolean
  lengthDeltaRatio: number
  prefix: number
  suffix: number
} {
  const source = normalizeForIntegrityCheck(before)
  const next = normalizeForIntegrityCheck(after)
  if (!source || !next) {
    return {
      safe: false,
      lengthDeltaRatio: 1,
      prefix: 0,
      suffix: 0,
    }
  }
  const lengthDeltaRatio = Math.abs(next.length - source.length) / Math.max(1, source.length)
  const prefix = commonPrefixLength(source, next)
  const suffix = commonSuffixLength(source, next)
  const safe = lengthDeltaRatio <= 0.08 && prefix >= 20 && suffix >= 20
  return { safe, lengthDeltaRatio, prefix, suffix }
}

function formatWholeDocumentPreservingMeaning(
  source: string,
  options?: { aggressive?: boolean },
): { content: string; changed: boolean; metrics: FormattingMetrics } {
  const normalizedSource = source.replace(/\r\n/g, '\n')
  const lines = normalizedSource.split('\n')
  const nextLines: string[] = []
  const buffer: string[] = []

  const flushBuffer = () => {
    if (buffer.length === 0) return
    const formatted = formatSectionBodyPreservingMeaning(buffer.join('\n'), options)
    if (!formatted) {
      nextLines.push('')
      buffer.length = 0
      return
    }
    nextLines.push(...formatted.split('\n'))
    buffer.length = 0
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const trimmed = line.trim()
    const parsedHeading = parseSectionAnchor(line) || inferPlainSectionAnchor(lines, i, options)
    if (parsedHeading) {
      flushBuffer()
      const normalizedHeading = /^#{1,6}\s+/.test(trimmed)
        ? trimmed
        : `${'#'.repeat(Math.min(Math.max(parsedHeading.level, 1), 4))} ${trimmed}`
      if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== '') {
        nextLines.push('')
      }
      nextLines.push(normalizedHeading)
      nextLines.push('')
      continue
    }
    if (!trimmed) {
      flushBuffer()
      if (nextLines.length === 0 || nextLines[nextLines.length - 1] !== '') {
        nextLines.push('')
      }
      continue
    }
    buffer.push(line)
  }

  flushBuffer()

  const nextContent = nextLines
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd() + '\n'
  const metrics = computeFormattingMetrics(nextContent)
  return {
    content: nextContent,
    changed: nextContent !== normalizedSource,
    metrics,
  }
}

function rewriteSectionInDocument(
  source: string,
  sectionTitle: string,
  nextSectionBody: string,
): { content: string; found: boolean; matchedTitle?: string } {
  const normalizedSource = source.replace(/\r\n/g, '\n')
  const lines = normalizedSource.split('\n')
  const sectionAnchors = collectSectionAnchors(lines)
  const target = findSectionAnchor(sectionAnchors, sectionTitle)
  if (!target) return { content: normalizedSource, found: false }

  const sectionEndLine = getSectionEndLine(sectionAnchors, target, lines.length)
  const replacementBody = nextSectionBody.replace(/\r\n/g, '\n').trim()
  const replacementLines = [lines[target.line], replacementBody]
  const nextLines = [
    ...lines.slice(0, target.line),
    ...replacementLines,
    ...lines.slice(sectionEndLine),
  ]
  return {
    content: nextLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n',
    found: true,
    matchedTitle: target.title,
  }
}

export class DirectChatEngine extends EventEmitter {
  private sessions = new Map<string, DirectChatSession>()
  private browserController: BrowserController | null = null
  private readonly browserTaskPlanner: BrowserTaskPlanner
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
  private cachedFfmpegPath: string | null = null

  constructor() {
    super()
    this.browserTaskPlanner = new BrowserTaskPlanner({
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

  private normalizeLooseToken(value: string): string {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, '')
      .trim()
  }

  private findExplicitlyRequestedSkills(userText: string): SkillState[] {
    const primary = this.extractPrimaryUserInstruction(userText)
    if (!primary || !/(skill|技能|使用|调用|参考|套用|运用)/i.test(primary)) return []
    const normalizedPrimary = this.normalizeLooseToken(primary)
    const skills = getSkillsRuntimeManager().listSkills()
    return skills.filter((skill, index) => {
      const candidates = [skill.id, skill.name]
        .map((item) => this.normalizeLooseToken(item))
        .filter((item) => item.length >= 3)
      const matched = candidates.some((candidate) => normalizedPrimary.includes(candidate))
      if (!matched) return false
      return skills.findIndex((entry) => entry.id === skill.id) === index
    }).slice(0, 2)
  }

  private extractSkillReferenceContent(result: string): string {
    const text = String(result || '').trim()
    const stdoutMarker = 'STDOUT:\n'
    const stdoutIndex = text.indexOf(stdoutMarker)
    if (stdoutIndex >= 0) {
      return text.slice(stdoutIndex + stdoutMarker.length).trim()
    }
    return text
  }

  private async maybeInjectExplicitSkillContext(params: {
    userText: string
    session: DirectChatSession
    sessionId?: string
    abortSignal: AbortSignal
    emitOutput: (chunk: string, type: string) => void
    emitToolAction: (tool: string, args: Record<string, unknown>) => void
    requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  }): Promise<void> {
    const explicitSkills = this.findExplicitlyRequestedSkills(params.userText)
    if (explicitSkills.length === 0) return

    for (const skill of explicitSkills) {
      const activeExecution = params.sessionId
        ? getSkillsRuntimeManager().listExecutions(10, params.sessionId, true).find((item) => item.skillId === skill.id)
        : null
      if (activeExecution) {
        const args: Record<string, unknown> = { executionId: activeExecution.id }
        params.emitToolAction('skill_get_state', args)
        params.emitOutput(`skill_get_state(${JSON.stringify(args)})`, 'tool_use')
        const result = await executeToolCall('skill_get_state', args, {
          browserController: this.browserController,
          sidecarManager: this.sidecarManager,
          emitToolAction: params.emitToolAction,
          requestModuleToolAction: params.requestModuleToolAction,
          abortSignal: params.abortSignal,
          sessionId: params.sessionId,
        })
        params.emitOutput(result.slice(0, 600), 'tool_result')
        params.session.messages.push({
          role: 'user',
          content: [
            `系统补充：技能 "${skill.name}" 在当前会话已有活跃 execution。`,
            '必须先基于以下 execution 状态继续推进，而不是重新启动一个新的 workflow：',
            result,
          ].join('\n'),
        })
        continue
      }

      const tool = findSkillToolBySkillAction(skill.id, skill.defaultAction)
      const actionDef = skill.actions.find((action) => action.name === (tool?.action || skill.defaultAction || ''))
      if (!tool || !actionDef) continue

      if (actionDef.runtime !== 'reference' || tool.params.some((param) => param.required)) {
        params.session.messages.push({
          role: 'user',
          content: [
            `系统补充：用户明确要求优先使用 skill "${skill.name}"。`,
            `如果该 skill 对当前任务有帮助，先调用 ${tool.name}，再继续后续任务。`,
            skill.description ? `技能说明：${skill.description}` : '',
          ].filter(Boolean).join('\n'),
        })
        continue
      }

      const args: Record<string, unknown> = {}
      params.emitToolAction(tool.name, args)
      params.emitOutput(`${tool.name}(${JSON.stringify(args)})`, 'tool_use')
      const result = await executeToolCall(tool.name, args, {
        browserController: this.browserController,
        sidecarManager: this.sidecarManager,
        emitToolAction: params.emitToolAction,
        requestModuleToolAction: params.requestModuleToolAction,
        abortSignal: params.abortSignal,
        sessionId: params.sessionId,
      })
      params.emitOutput(result.slice(0, 600), 'tool_result')
      const skillContent = this.extractSkillReferenceContent(result).slice(0, 6_000)
      params.session.messages.push({
        role: 'user',
        content: [
          `系统补充：用户明确要求使用 skill "${skill.name}"。你必须先应用这个 skill 的方法，再继续后续浏览器或文档任务。`,
          skill.description ? `技能目标：${skill.description}` : '',
          '已读取的技能说明：',
          skillContent,
        ].filter(Boolean).join('\n'),
      })
      log(`Injected explicit skill context for ${skill.id} via ${tool.name}`)
    }
  }

  private hasActiveSkillExecution(sessionId?: string): boolean {
    if (!sessionId) return false
    try {
      return getSkillsRuntimeManager().listExecutions(5, sessionId, true).length > 0
    } catch {
      return false
    }
  }

  private shouldKeepToolsWithVideo(userText: string, sessionId?: string): boolean {
    const primary = this.extractPrimaryUserInstruction(userText)
    if (!primary) return this.hasActiveSkillExecution(sessionId)
    const normalized = primary.toLowerCase()
    if (normalized.includes('/skill')) return true
    if (/(skill_|skill\s+get\s+state|skill_submit_|skill_restart_|skill_cancel_|技能|重跑|重做某一步|继续执行|继续这个 skill)/i.test(primary)) {
      return true
    }
    if (/(python|py\b|脚本|运行 python|执行 python|embedded python|内置 python)/i.test(primary)) {
      return true
    }
    if (this.findExplicitlyRequestedSkills(primary).length > 0) {
      return true
    }
    return this.hasActiveSkillExecution(sessionId)
  }

  private buildPreferredSkillToolNames(userText: string, sessionId?: string): string[] {
    const toolNames = new Set<string>([
      'skill_get_state',
      'skill_submit_input',
      'skill_submit_confirmation',
      'skill_submit_agent_result',
      'skill_restart_from_step',
      'skill_cancel_execution',
      'system_run_embedded_python',
    ])

    const explicitSkills = this.findExplicitlyRequestedSkills(userText)
    for (const skill of explicitSkills) {
      for (const action of skill.actions.filter((item) => item.visibility !== 'internal')) {
        const tool = findSkillToolBySkillAction(skill.id, action.name)
        if (tool?.name) toolNames.add(tool.name)
      }
    }

    if (sessionId) {
      const activeExecutions = getSkillsRuntimeManager().listExecutions(10, sessionId, true)
      for (const execution of activeExecutions) {
        const tool = findSkillToolBySkillAction(execution.skillId, execution.entryAction)
        if (tool?.name) toolNames.add(tool.name)
      }
    }

    return Array.from(toolNames)
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

  /**
   * Build tool usage guidance based on intent (suggestion, not forcing)
   */
  private buildToolGuidance(policy: ToolPolicy): string {
    const guidance: string[] = []

    if (policy.forceDocumentTool) {
      guidance.push(`
## 工具使用建议

当前用户的请求可能涉及文档操作。如果用户明确要求编辑、修改或保存文档，请使用 document_* 工具。

**判断标准**:
- "修改第一段" → 使用 document_update_section
- "把这段原文精准改掉" → 使用 document_replace_exact
- "在文档里做一个交互图表/组件" → 使用 document_insert_widget
- "看看文档里有哪些 widget" → 使用 document_list_widgets
- "更新这个 widget / 改图表内容" → 使用 document_update_widget
- "删掉这个 widget" → 使用 document_remove_widget
- "保存文档" → 使用 document_save
- "你是谁" → 直接回答，不使用工具
- "这篇文章怎么样" → 直接回答，不使用工具
`)

      guidance.push(buildDocumentWidgetOpenUIRulesSnippet())

      const widgetGuidance = buildDocumentWidgetGuidanceSnippet(policy.documentWidgetProfile || null)
      if (widgetGuidance) {
        guidance.push(widgetGuidance)
      } else {
        const widgetClarifier = buildDocumentWidgetClarificationSnippet(policy.documentWidgetSourceText || '')
        if (widgetClarifier) {
          guidance.push(widgetClarifier)
        }
      }
    }

    return guidance.join('\n\n')
  }

  private applyDesignSourceInput(
    toolCall: ToolCall,
    policy: ToolPolicy,
  ): ToolCall {
    if (!policy.forceDesignTool) return toolCall
    if (!toolCall.name.startsWith('design_')) return toolCall
    if (!policy.primaryDesignInstruction) return toolCall

    return {
      ...toolCall,
      input: {
        ...toolCall.input,
        designDirectiveText: typeof toolCall.input.designDirectiveText === 'string' && toolCall.input.designDirectiveText.trim()
          ? toolCall.input.designDirectiveText
          : policy.primaryDesignInstruction,
      },
    }
  }

  private parseStructuredToolResult(result: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(result) as unknown
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    } catch {
      return null
    }
  }

  private buildActualDesignCompletionText(
    payload: Record<string, unknown> | null,
    rawResult?: string | null,
  ): string | null {
    const status = payload && typeof payload.status === 'string' ? payload.status : null
    const summary = payload && typeof payload.summary === 'string' && payload.summary.trim()
      ? payload.summary.trim()
      : payload && typeof payload.message === 'string' && payload.message.trim()
        ? payload.message.trim()
        : ''
    const reviewSummary = payload && payload.review && typeof payload.review === 'object' && typeof (payload.review as { summary?: unknown }).summary === 'string'
      ? String((payload.review as { summary?: unknown }).summary)
      : ''
    const parts = [
      summary,
      reviewSummary && reviewSummary !== summary ? reviewSummary : null,
      status === 'failed' ? '本轮验收未通过，已停止继续自动重做；请根据当前结果继续修订。' : null,
      status === 'cancelled' ? '本轮设计已停止。' : null,
    ].filter(Boolean)
    if (parts.length > 0) return parts.join(' ')
    if (rawResult && /\bcancel(?:led)?\b/i.test(rawResult)) return '本轮设计已停止。'
    if (rawResult) return '本轮设计已执行完成，请基于当前结果继续修订。'
    return null
  }

  private isPrimaryDesignArtifactTool(toolName: string, policy: ToolPolicy): boolean {
    if (!policy.forceDesignTool) return false
    if (!policy.preferredDesignTool) return false
    return toolName === policy.preferredDesignTool
  }

  private filterSingleArtifactDesignToolCalls(toolCalls: ToolCall[], policy: ToolPolicy): ToolCall[] {
    if (!policy.forceDesignTool || policy.allowMultipleDesignArtifacts) return toolCalls
    if (!policy.preferredDesignTool) return toolCalls

    let keptPrimary = false
    const filtered: ToolCall[] = []
    for (const toolCall of toolCalls) {
      if (toolCall.name !== policy.preferredDesignTool) {
        filtered.push(toolCall)
        continue
      }
      if (!keptPrimary) {
        filtered.push(toolCall)
        keptPrimary = true
      }
    }
    return filtered
  }

  private async maybeRefineBrowserDecision(params: {
    session: DirectChatSession
    config: AIModelConfig
    baseUrl: string
    provider: ReturnType<typeof getProviderDef>
    signal: AbortSignal
    isKimi: boolean
    isKimiCoding: boolean
    useAnthropicProtocol: boolean
    decision: BrowserTaskDecision
    sessionId?: string
    userText: string
  }): Promise<BrowserTaskDecision> {
    const { decision } = params
    const basePlan = this.browserTaskPlanner.rebuildPlan(decision, {
      sessionId: params.sessionId,
      userText: params.userText,
    })
    if (
      decision.mode !== 'browser_upload_workflow' ||
      !decision.promptIntent ||
      !decision.promptIntent.raw.trim() ||
      !this.browserTaskPlanner.promptNeedsRefinement(decision, {
        explicitSkillRequested: this.findExplicitlyRequestedSkills(params.userText).length > 0,
      })
    ) {
      return { ...decision, plan: basePlan }
    }

    try {
      const planningPrompt = this.browserTaskPlanner.buildPromptRefinementRequest(decision.attachmentSelection?.latestName)
      const planningSession: DirectChatSession = {
        ...params.session,
        messages: [...params.session.messages, { role: 'user', content: planningPrompt }],
        abortController: null,
      }
      const draft = params.isKimiCoding
        ? await this.callKimiCodingSimple(planningSession, params.config, params.baseUrl, params.signal)
        : params.useAnthropicProtocol
          ? await this.callAnthropicSimple(planningSession, params.config, params.baseUrl, params.signal)
          : await this.callOpenAISimple(
            planningSession,
            params.config,
            params.baseUrl,
            params.provider,
            params.signal,
            params.isKimi,
            false,
          )
      const parsed = this.browserTaskPlanner.parsePromptDraft(draft)
      if (!parsed) {
        if (this.browserTaskPlanner.promptNeedsRefinement(decision)) {
          const clarifiedDecision: BrowserTaskDecision = {
            ...decision,
            promptIntent: {
              ...decision.promptIntent,
              refined: '',
              confidence: 'low',
              source: decision.promptIntent.source || 'none',
            },
          }
          return { ...clarifiedDecision, plan: this.browserTaskPlanner.rebuildPlan(clarifiedDecision, { sessionId: params.sessionId, userText: params.userText }) }
        }
        return { ...decision, plan: basePlan }
      }
      const refinedDecision: BrowserTaskDecision = {
        ...decision,
        promptIntent: {
          raw: decision.promptIntent.raw,
          refined: parsed.prompt,
          confidence: parsed.confidence,
          source: 'model_refiner',
        },
      }
      return {
        ...refinedDecision,
        plan: this.browserTaskPlanner.rebuildPlan(refinedDecision, {
          sessionId: params.sessionId,
          userText: params.userText,
        }),
      }
    } catch (error) {
      log(`browser prompt refiner skipped: ${error instanceof Error ? error.message : String(error)}`)
      return { ...decision, plan: basePlan }
    }
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
  ): Promise<{ success: boolean; error?: string }> {
    const contentPreview = typeof content === 'string' ? content.slice(0, 80) : `[${content.length} blocks]`
    log(`sendMessage called: agent=${name}, content=${contentPreview}`)
    const runId = requestId || randomUUID()
    if (!this.sessions.has(name)) {
      this.newSession(name)
    }
    const session = this.sessions.get(name)!
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
      return { success: false, error: '未配置 API Key' }
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
      const hasWidgetTargetContext = userText.includes('### Widget 更新上下文')
      const pureUserInput = this.extractPureUserInput(userText)
      const contextualUserInput = resolveToolPolicyInput(
        pureUserInput,
        session.lastDocumentContextInput ? [session.lastDocumentContextInput, ...this.collectRecentPureUserInputs(session.messages.slice(0, -1), 40)] : this.collectRecentPureUserInputs(session.messages.slice(0, -1), 40),
      )
      if (contextualUserInput !== pureUserInput) {
        log(`tool policy context reused previous user input: ${this.extractPrimaryUserInstruction(contextualUserInput).slice(0, 120)}`)
      }
      const userInstructionText = this.extractPrimaryUserInstruction(contextualUserInput)
      const explicitWidgetCreateIntent = this.hasExplicitDocumentWidgetCreateIntent(contextualUserInput)
      const documentWidgetTaskKind = hasWidgetTargetContext && !explicitWidgetCreateIntent ? 'update' : this.inferDocumentWidgetTaskKind(contextualUserInput)
      const documentWidgetProfile = inferDocumentWidgetProfile(contextualUserInput)
      const hasVideoInputs = this.sessionHasVideoInputs(session.messages)
      const keepToolsWithVideo = this.shouldKeepToolsWithVideo(contextualUserInput, sessionId)
      // Avoid tools when video exists, so simple media tasks don't get routed into skill/tool loops.
      // Keep tools enabled when the user is explicitly controlling skill execution or embedded Python.
      const hasTools = (capabilities?.supportsToolCalls ?? true) && (
        (!hasVideoInputs && !hasRawVideoInIncoming) ||
        keepToolsWithVideo
      )
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
      const incomingAttachmentHints = this.getIncomingAttachmentHints(content)
      let browserDecision = hasTools && this.browserController && this.isBrowserAgentV3Enabled()
        ? this.browserTaskPlanner.decideTask({
          userText: pureUserInput,
          sessionMessages: session.messages,
          sessionId,
        }) as unknown as BrowserTaskDecision
        : ({ mode: 'free_tool_loop', reason: 'browser_disabled' } as BrowserTaskDecision)

      // Judge intent based on pure input (not polluted by environment context)
      const preferredSkillToolNames = hasTools && (this.findExplicitlyRequestedSkills(contextualUserInput).length > 0 || this.hasActiveSkillExecution(sessionId))
        ? this.buildPreferredSkillToolNames(contextualUserInput, sessionId)
        : null
      const toolPolicy: ToolPolicy = {
        forceDocumentTool: hasTools && ((hasWidgetTargetContext && !explicitWidgetCreateIntent) || this.shouldForceDocumentToolCall(contextualUserInput)),
        forceDesignTool: false,
        preferredDesignTool: null,
        primaryDesignInstruction: null,
        allowMultipleDesignArtifacts: false,
        preferSectionRewrite: hasTools && this.shouldPreferSectionRewrite(userInstructionText),
        preferFormatOnly: hasTools && this.shouldPreferFormatOnly(userInstructionText),
        documentWidgetTaskKind,
        documentWidgetProfile,
        documentWidgetSourceText: contextualUserInput,
        allowBrowserTools: hasTools && (
          browserDecision.mode === 'browser_workflow' ||
          browserDecision.mode === 'browser_upload_workflow'
        ),
        preferredSkillToolNames,
      }
      if (toolPolicy.forceDocumentTool) {
        session.lastDocumentContextInput = contextualUserInput
      }

      log(`provider=${config.provider}, baseUrl=${baseUrl}, model=${config.model}, agentProtocol=${capabilities?.agentProtocol || (useAnthropicProtocol ? 'anthropic' : 'openai')}, wireApi=${capabilities?.wireApi || 'n/a'}, toolCallTransport=${capabilities?.toolCallTransport || 'native'}, hasTools=${hasTools}, supportsVision=${capabilities?.supportsVision ?? true}, supportsNativeVideo=${capabilities?.supportsNativeVideo ?? supportsVideoBlock}, forceDocumentTool=${toolPolicy.forceDocumentTool}, forceDesignTool=${toolPolicy.forceDesignTool}, preferredDesignTool=${toolPolicy.preferredDesignTool || 'none'}, allowMultipleDesignArtifacts=${toolPolicy.allowMultipleDesignArtifacts}, preferSectionRewrite=${toolPolicy.preferSectionRewrite}, preferFormatOnly=${toolPolicy.preferFormatOnly}, documentWidgetTaskKind=${toolPolicy.documentWidgetTaskKind || 'none'}, allowBrowserTools=${toolPolicy.allowBrowserTools}, preferredSkillTools=${toolPolicy.preferredSkillToolNames?.join('|') || 'all'}, hasVideoInputs=${hasVideoInputs}, incomingVideo=${hasRawVideoInIncoming}, keepToolsWithVideo=${keepToolsWithVideo}, isKimi=${isKimi}, isKimiCoding=${isKimiCoding}, anthropicProtocol=${useAnthropicProtocol}`)

      if (hasTools) {
        await this.maybeInjectExplicitSkillContext({
          userText,
          session,
          sessionId,
          abortSignal: abortController.signal,
          emitOutput,
          emitToolAction,
          requestModuleToolAction,
        })
      }

      if (hasTools && browserDecision.mode === 'browser_upload_workflow') {
        browserDecision = await this.maybeRefineBrowserDecision({
          session,
          config,
          baseUrl,
          provider,
          signal: abortController.signal,
          isKimi,
          isKimiCoding,
          useAnthropicProtocol,
          decision: browserDecision,
          sessionId,
          userText,
        })
      }
      const browserContinuity = hasTools && this.browserController && (browserDecision.mode === 'browser_upload_workflow' || browserDecision.mode === 'browser_workflow')
        ? await this.browserTaskPlanner.buildContinuityContext({
          userText,
          sessionId,
          decision: browserDecision as unknown as any,
        }) as unknown as BrowserTaskPlanContinuity
        : null
      if (browserContinuity) {
        browserDecision = this.browserTaskPlanner.applyContinuityToDecision(browserDecision as unknown as any, browserContinuity as unknown as any) as unknown as BrowserTaskDecision
      }
      log(
        `browserDecision mode=${browserDecision.mode} reason=${browserDecision.reason} ` +
        `sessionId=${sessionId || 'none'} attachmentCount=${browserDecision.attachmentSelection?.count || 0} ` +
        `incomingAttachmentCount=${incomingAttachmentHints.count || 0} ` +
        `promptConfidence=${browserDecision.promptIntent?.confidence || 'none'} ` +
        `targetUrl=${browserDecision.plan?.targetUrl || browserDecision.plan?.resources?.links?.[0]?.url || 'none'} ` +
        `stepCount=${browserDecision.plan?.steps?.length || 0}`,
      )

      const browserContinuityInstruction = this.browserTaskPlanner.buildContinuityInstruction(browserContinuity)
      if (browserContinuityInstruction) {
        session.messages.push({ role: 'user', content: browserContinuityInstruction })
        log('Injected browser continuity instruction')
      }

      if (hasTools && this.browserController && browserDecision.mode === 'clarify_first') {
        const clarifyText = this.browserTaskPlanner.buildClarifyMessage(browserDecision)
        emitOutput(clarifyText, 'text')
        session.messages.push({ role: 'assistant', content: clarifyText })
        emitOutput('', 'done')
        emitStatus('done')
        return { success: true }
      }

      const shouldInspectAmbiguousModeEntry = this.browserTaskPlanner.shouldInspectAmbiguousCreativeEntry(browserDecision.plan)
      const canUseDeterministicBrowserRunner =
        hasTools &&
        this.browserController &&
        this.browserTaskPlanner.shouldUseDeterministicRunner(browserDecision)

      if (hasTools && this.browserController && browserDecision.mode === 'browser_upload_workflow' && !canUseDeterministicBrowserRunner) {
        log(
          shouldInspectAmbiguousModeEntry
            ? 'browserDecision mode=browser_upload_workflow fallback to tool loop because current page looks like a mode-selection entry'
            : 'browserDecision mode=browser_upload_workflow fallback to tool loop because target page is unresolved',
        )
      }

      if (canUseDeterministicBrowserRunner && this.browserController) {
        log(`browserDecision mode=${browserDecision.mode} handled by deterministic runner`)
        const browserRunner = new BrowserAgentRunner(this.browserController, {
          abortSignal: abortController.signal,
          sessionId,
          decision: browserDecision,
          emitToolEvent: (type, text) => {
            emitOutput(text, type)
          },
        })
        const browserResult = await browserRunner.run(userText)
        if (browserResult.handled) {
          emitOutput(browserResult.message, 'text')
          session.messages.push({ role: 'assistant', content: browserResult.message })
          emitOutput('', 'done')
          emitStatus(browserResult.state === 'cancelled' ? 'cancelled' : browserResult.state === 'failed' ? 'error' : 'done')
          return { success: true }
        }
      }

      // 浏览器任务通过 tool loop 让 AI 自己规划和执行
      if (
        hasTools &&
        this.browserController &&
        (browserDecision.mode === 'browser_upload_workflow' || browserDecision.mode === 'browser_workflow')
      ) {
        const planText = this.browserTaskPlanner.buildToolLoopInstruction(browserDecision)
        if (planText) {
          session.messages.push({ role: 'user', content: planText })
          log(`Injected structured browser plan with ${browserDecision.plan?.steps?.length || 0} steps`)
        } else {
          // 没有计划时的回退：保留基本指引
          session.messages.push({
            role: 'user',
            content: [
              `系统任务提示：当前任务已判定为浏览器操作任务。`,
              `任务目标：${browserDecision.plan?.taskGoal || '完成用户要求的网页操作'}`,
              `预期结果：${browserDecision.plan?.expectedOutcome || '页面操作完成'}`,
              '',
              '重要原则：',
              '- 不要看到链接就立即导航，先确认是否需要',
              '- 上传附件前，先检查页面是否已有附件',
              '- 填写 prompt 前，先确认当前焦点或目标输入框确实正确',
              '- 提交前，确保附件和 prompt 都已就位，并优先复用与输入区相邻的发送控件',
              '- 如果没有稳定输入锚点，不要先点发送按钮',
              '- 不要点击历史记录的"重新生成"按钮',
            ].join('\n'),
          })
        }
      }

      const openclawCommand = this.extractOpenclawPairingCommand(userText)
      if (hasTools && openclawCommand) {
        const toolContext = {
          browserController: this.browserController,
          sidecarManager: this.sidecarManager,
          runtime: this.runtime,
          scope: undefined,
          emitToolAction: (tool: string, args: Record<string, unknown>) => {
            emitToolAction(tool, args)
          },
          requestModuleToolAction,
          abortSignal: abortController.signal,
          sessionId,
        }
        emitOutput(`system_run_openclaw(${JSON.stringify({ command: openclawCommand }).slice(0, 120)})`, 'tool_use')
        const result = await executeToolCall('system_run_openclaw', { command: openclawCommand }, toolContext)
        emitOutput(result.slice(0, 300), 'tool_result')
        emitOutput(result, 'text')
        session.messages.push({ role: 'assistant', content: result })
        emitOutput('', 'done')
        emitStatus('done')
        return { success: true }
      }

      if (!hasTools) {
        // No tool calling — original simple path
        let text: string
        const hasMediaInputs = this.sessionHasMediaInputs(session.messages)
        if (isKimiCoding) {
          try {
            text = await this.callKimiCodingSimple(session, config, baseUrl, abortController.signal)
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            log(`Kimi coding OpenAI path failed, fallback to Anthropic-compatible path: ${msg}`)
            let fallbackMessages: ChatMessage[] | undefined
            if (hasVideoInputs) {
              fallbackMessages = await this.buildVideoFrameFallbackMessages(session.messages)
              session.messages = fallbackMessages
            }
            text = await this.callAnthropicSimple(
              session,
              config,
              baseUrl,
              abortController.signal,
              fallbackMessages,
            )
          }
        } else if (useAnthropicProtocol) {
          try {
            text = await this.callAnthropicSimple(session, config, baseUrl, abortController.signal)
          } catch (error) {
            if (!hasVideoInputs || !this.shouldRetryWithVideoFallback(error)) {
              throw error
            }
            log('Anthropic request with video blocks failed, retrying with extracted image frames fallback')
            const fallbackMessages = await this.buildVideoFrameFallbackMessages(session.messages)
            session.messages = fallbackMessages
            text = await this.callAnthropicSimple(session, config, baseUrl, abortController.signal, fallbackMessages)
          }
        } else {
          text = await this.callOpenAISimple(
            session,
            config,
            baseUrl,
            provider,
            abortController.signal,
            isKimi,
            !hasMediaInputs,
          )
        }

        if (text) {
          emitOutput(text, 'text')
          session.messages.push({ role: 'assistant', content: text })
        }
      } else {
        // Tool calling loop
        const envRaw = process.env.READY_MAX_TOOL_ITERATIONS
        const envValue = Number(envRaw)
        const baseMaxToolIterations = Number.isFinite(envValue) && envValue > 0
          ? Math.min(80, Math.max(8, Math.round(envValue)))
          : this.maxToolIterations
        const effectiveMaxToolIterations = this.browserTaskPlanner.getRecommendedMaxToolIterations(userText, browserDecision, baseMaxToolIterations)
        let iterations = 0
        let finishedBeforeLimit = false
        let forceDocNudges = 0
        let forceDocMutationNudges = 0
        let forceDocSaveNudges = 0
        let forceDocInspectionResultNudges = 0
        let forceDocWidgetRecoveryNudges = 0
        let textToolBridgeNudges = 0
        let documentToolTaskCompleted = false
        let documentToolProgress: {
          executedMutatingDocActionCount: number
          executedSaveDocActionCount: number
          toolResults: string[]
        } | null = null
        let lastDocumentInspectionResult: string | null = null
        let lastWidgetValidationError: string | null = null

        // Inject tool guidance into system prompt based on intent
        const toolGuidance = this.buildToolGuidance(toolPolicy)
        if (toolGuidance) {
          session.systemPrompt = `${session.systemPrompt}\n\n${toolGuidance}`
          log('Injected tool guidance into system prompt')
        }

        // 浏览器步骤追踪
        const isBrowserTask = browserDecision.mode === 'browser_workflow' || browserDecision.mode === 'browser_upload_workflow'
        const browserSteps = browserDecision.plan?.steps || []
        let browserStepIndex = 0
        let browserToolCallCount = 0
        let primaryDesignArtifactProduced = false

        while (iterations < effectiveMaxToolIterations) {
          ensureNotAborted()
          iterations++
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

          const toolContext = {
            browserController: this.browserController,
            sidecarManager: this.sidecarManager,
            runtime: this.runtime,
            scope,
            emitToolAction: (tool: string, args: Record<string, unknown>) => {
              emitToolAction(tool, args)
            },
            requestModuleToolAction,
            abortSignal: abortController.signal,
            sessionId,
          }

          let response: APIResponse
          ensureNotAborted()
          if (useAnthropicProtocol) {
            try {
              response = await this.callAnthropicWithTools(session, config, baseUrl, abortController.signal, toolPolicy)
            } catch (error) {
              if (!hasVideoInputs || !this.shouldRetryWithVideoFallback(error)) {
                throw error
              }
              log('Anthropic tool request with video blocks failed, retrying with extracted image frames fallback')
              const fallbackMessages = await this.buildVideoFrameFallbackMessages(session.messages)
              session.messages = fallbackMessages
              response = await this.callAnthropicWithTools(session, config, baseUrl, abortController.signal, toolPolicy)
            }
          } else {
            try {
              response = await this.callOpenAIWithTools(session, config, baseUrl, provider!, abortController.signal, toolPolicy)
            } catch (error) {
              if (!hasVideoInputs || !this.shouldRetryWithVideoFallback(error)) {
                throw error
              }
              log('OpenAI tool request with video blocks failed, retrying with extracted image frames fallback')
              const fallbackMessages = await this.buildVideoFrameFallbackMessages(session.messages)
              session.messages = fallbackMessages
              response = await this.callOpenAIWithTools(session, config, baseUrl, provider!, abortController.signal, toolPolicy)
            }
          }

          // No tool calls — done
          if (response.toolCalls.length === 0) {
            if (response.toolTransport === 'text' && response.rawText) {
              session.messages.push({ role: 'assistant', content: response.rawText })
              if (looksLikeMissingNativeToolsReply(response.text || response.rawText) && textToolBridgeNudges < 2) {
                textToolBridgeNudges += 1
                session.messages.push({
                  role: 'user',
                  content: this.buildTextToolBridgeCorrectionMessage(toolPolicy),
                })
                log(`Text tool bridge correction injected, nudge=${textToolBridgeNudges}`)
                continue
              }
            }
            if (
              toolPolicy.forceDocumentTool &&
              lastDocumentInspectionResult &&
              shouldPreferDocumentInspectionResult(response.text, lastDocumentInspectionResult)
            ) {
              if (forceDocInspectionResultNudges < 1) {
                forceDocInspectionResultNudges += 1
                if (response.text && response.toolTransport !== 'text') {
                  session.messages.push({ role: 'assistant', content: response.text })
                }
                session.messages.push({
                  role: 'user',
                  content: '系统检查：你刚执行了 document_list_widgets。请直接把工具返回的列表结果交付给用户，不要解释过程，也不要只描述你调用了工具。',
                })
                log(`forceDocumentTool inspection result nudge=${forceDocInspectionResultNudges}`)
                continue
              }
              emitOutput(lastDocumentInspectionResult, 'text')
              session.messages.push({ role: 'assistant', content: lastDocumentInspectionResult })
              finishedBeforeLimit = true
              log('forceDocumentTool inspection result fallback emitted directly')
              break
            }
            if (toolPolicy.forceDocumentTool && !documentToolTaskCompleted && forceDocNudges < 2) {
              forceDocNudges += 1
              if (response.text && response.toolTransport !== 'text') {
                session.messages.push({ role: 'assistant', content: response.text })
              }
              session.messages.push({
                role: 'user',
                content: '系统检查：你还没有执行真实文档修改。请按你自己的计划调用 document_* 工具完成编辑，而不是仅给文字说明。',
              })
              log(`No tool call under forceDocumentTool, nudge=${forceDocNudges}`)
              continue
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

          const firstPassFilteredToolCalls = this.filterSingleArtifactDesignToolCalls(response.toolCalls, toolPolicy)
          if (firstPassFilteredToolCalls.length !== response.toolCalls.length) {
            log(`Single-artifact design guard dropped ${response.toolCalls.length - firstPassFilteredToolCalls.length} extra design tool call(s)`)
          }
          const rawToolCallsForIteration = (
            toolPolicy.forceDesignTool &&
            !toolPolicy.allowMultipleDesignArtifacts &&
            primaryDesignArtifactProduced &&
            toolPolicy.preferredDesignTool
          )
            ? firstPassFilteredToolCalls.filter((toolCall) => toolCall.name !== toolPolicy.preferredDesignTool)
            : firstPassFilteredToolCalls

          if (rawToolCallsForIteration.length === 0 && response.toolCalls.length > 0) {
            session.messages.push({
              role: 'user',
              content: '系统检查：本轮已经生成过主版式，不要再次新建额外版面。请基于当前真实设计结果总结，或只调用 design_verify_layout / design_list_owned_nodes 这类复查工具。',
            })
            log('Dropped repeated primary design artifact call after artifact already existed')
            continue
          }

          const toolCallsForIteration = rawToolCallsForIteration
            .map((toolCall) => this.applyDesignSourceInput(toolCall, toolPolicy))

          // Execute tool calls
          let executedDocActionCount = 0
          let executedMutatingDocActionCount = 0
          let executedInspectionDocActionCount = 0
          let executedSaveDocActionCount = 0
          let executedBrowserToolsThisIteration = 0
          let executedPrimaryDesignToolThisIteration = false
          let lastPrimaryDesignToolPayload: Record<string, unknown> | null = null
          let lastPrimaryDesignToolRawResult: string | null = null
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
            for (const tc of toolCallsForIteration) {
              ensureNotAborted()
              emitOutput(`${tc.name}(${JSON.stringify(tc.input).slice(0, 100)})`, 'tool_use')
              const result = await executeToolCall(tc.name, tc.input, toolContext)
              ensureNotAborted()
              log(`tool execute: ${tc.name}, result=${result.slice(0, 140)}`)
              if (tc.name.startsWith('document_')) {
                documentToolResultsThisIteration.push(result)
                executedDocActionCount += 1
                if (CONTENT_MUTATING_DOCUMENT_TOOL_NAMES.has(tc.name)) {
                  executedMutatingDocActionCount += 1
                  lastDocumentInspectionResult = null
                  if (/widget (写入已拒绝|更新失败|删除失败)/.test(result)) {
                    lastWidgetValidationError = result
                  } else {
                    lastWidgetValidationError = null
                  }
                }
                if (DOCUMENT_INSPECTION_TOOL_NAMES.has(tc.name)) {
                  executedInspectionDocActionCount += 1
                  lastDocumentInspectionResult = result
                }
                if (tc.name === 'document_save_tab') {
                  executedSaveDocActionCount += 1
                }
              }
              if (tc.name.startsWith('browser_')) {
                executedBrowserToolsThisIteration += 1
              }
              if (this.isPrimaryDesignArtifactTool(tc.name, toolPolicy)) {
                executedPrimaryDesignToolThisIteration = true
                primaryDesignArtifactProduced = true
                lastPrimaryDesignToolPayload = this.parseStructuredToolResult(result)
                lastPrimaryDesignToolRawResult = result
              }
              emitOutput(result.slice(0, 200), 'tool_result')
              toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result })
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
              for (const tc of toolCallsForIteration) {
                ensureNotAborted()
                emitOutput(`${tc.name}(${JSON.stringify(tc.input).slice(0, 100)})`, 'tool_use')
                const result = await executeToolCall(tc.name, tc.input, toolContext)
                ensureNotAborted()
                log(`tool execute: ${tc.name}, result=${result.slice(0, 140)}`)
                if (tc.name.startsWith('document_')) {
                  documentToolResultsThisIteration.push(result)
                  executedDocActionCount += 1
                  if (CONTENT_MUTATING_DOCUMENT_TOOL_NAMES.has(tc.name)) {
                    executedMutatingDocActionCount += 1
                    lastDocumentInspectionResult = null
                    if (/widget (写入已拒绝|更新失败|删除失败)/.test(result)) {
                      lastWidgetValidationError = result
                    } else {
                      lastWidgetValidationError = null
                    }
                  }
                  if (DOCUMENT_INSPECTION_TOOL_NAMES.has(tc.name)) {
                    executedInspectionDocActionCount += 1
                    lastDocumentInspectionResult = result
                  }
                  if (tc.name === 'document_save_tab') {
                    executedSaveDocActionCount += 1
                  }
                }
                if (tc.name.startsWith('browser_')) {
                  executedBrowserToolsThisIteration += 1
                }
                if (this.isPrimaryDesignArtifactTool(tc.name, toolPolicy)) {
                  executedPrimaryDesignToolThisIteration = true
                  primaryDesignArtifactProduced = true
                  lastPrimaryDesignToolPayload = this.parseStructuredToolResult(result)
                  lastPrimaryDesignToolRawResult = result
                }
                emitOutput(result.slice(0, 200), 'tool_result')
                textBridgeResults.push({ id: tc.id, name: tc.name, result })
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

              for (const tc of toolCallsForIteration) {
                ensureNotAborted()
                emitOutput(`${tc.name}(${JSON.stringify(tc.input).slice(0, 100)})`, 'tool_use')
                const result = await executeToolCall(tc.name, tc.input, toolContext)
                ensureNotAborted()
                log(`tool execute: ${tc.name}, result=${result.slice(0, 140)}`)
                if (tc.name.startsWith('document_')) {
                  documentToolResultsThisIteration.push(result)
                  executedDocActionCount += 1
                  if (CONTENT_MUTATING_DOCUMENT_TOOL_NAMES.has(tc.name)) {
                    executedMutatingDocActionCount += 1
                    lastDocumentInspectionResult = null
                    if (/widget (写入已拒绝|更新失败|删除失败)/.test(result)) {
                      lastWidgetValidationError = result
                    } else {
                      lastWidgetValidationError = null
                    }
                  }
                  if (DOCUMENT_INSPECTION_TOOL_NAMES.has(tc.name)) {
                    executedInspectionDocActionCount += 1
                    lastDocumentInspectionResult = result
                  }
                  if (tc.name === 'document_save_tab') {
                    executedSaveDocActionCount += 1
                  }
                }
                if (tc.name.startsWith('browser_')) {
                  executedBrowserToolsThisIteration += 1
                }
                if (this.isPrimaryDesignArtifactTool(tc.name, toolPolicy)) {
                  executedPrimaryDesignToolThisIteration = true
                  primaryDesignArtifactProduced = true
                  lastPrimaryDesignToolPayload = this.parseStructuredToolResult(result)
                  lastPrimaryDesignToolRawResult = result
                }
                emitOutput(result.slice(0, 200), 'tool_result')
                session.messages.push({ role: 'tool' as 'system', content: result, ...({ tool_call_id: tc.id } as Record<string, unknown>) } as ChatMessage)
              }
            }
          }

          // 浏览器步骤追踪：检测 AI 声明完成当前步骤，并注入检查点提醒
          if (isBrowserTask && executedBrowserToolsThisIteration > 0) {
            // 检测 AI 是否声明完成了当前步骤
            if (response.text) {
              const stepCompleteMatch = response.text.match(/步骤\s*(\d+)\s*完成/)
              if (stepCompleteMatch) {
                const completedStep = parseInt(stepCompleteMatch[1], 10) - 1
                if (completedStep >= browserStepIndex && completedStep < browserSteps.length) {
                  browserStepIndex = completedStep + 1
                  log(`Browser step advanced to ${browserStepIndex}/${browserSteps.length}`)
                }
              }
            }

            browserToolCallCount += executedBrowserToolsThisIteration
            // 每 2 次浏览器工具调用后，注入检查点提醒
            if (browserToolCallCount >= 2 && browserStepIndex < browserSteps.length) {
              browserToolCallCount = 0
              const currentStep = browserSteps[browserStepIndex]
              const nextStep = browserSteps[browserStepIndex + 1]

              const checkpoint = [
                `[系统检查点] 当前进度：`,
                currentStep ? `当前步骤: ${browserStepIndex + 1}/${browserSteps.length} — ${currentStep.id}: ${currentStep.goal}` : '',
                currentStep ? `验证条件: ${currentStep.verify.join('；')}` : '',
                nextStep ? `下一步骤: ${nextStep.id}: ${nextStep.goal}` : '已是最后步骤',
                ``,
                `请确认当前步骤的验证条件是否已满足。如果满足，明确说"步骤 ${browserStepIndex + 1} 完成"并继续下一步。`,
                `如果未满足且还有重试机会，继续尝试。`,
                `如果未满足且无法继续，报告失败原因。`,
              ].filter(Boolean).join('\n')

              session.messages.push({ role: 'user', content: checkpoint })
              log(`Injected browser checkpoint at step ${browserStepIndex + 1}/${browserSteps.length}`)
            }
          }

          if (
            toolPolicy.forceDocumentTool &&
            toolPolicy.documentWidgetTaskKind &&
            lastWidgetValidationError &&
            forceDocWidgetRecoveryNudges < 1
          ) {
            forceDocWidgetRecoveryNudges += 1
            session.messages.push({
              role: 'user',
              content: `系统检查：你刚生成的 widget 结果不合格：${lastWidgetValidationError}。请不要结束，改用更稳妥的实现方式重新生成并再次调用正确的 widget 工具。优先保留简洁结构，避免继续使用 document_append_content。`,
            })
            log(`forceDocumentTool widget recovery nudge=${forceDocWidgetRecoveryNudges}`)
            continue
          }

          if (
            toolPolicy.forceDocumentTool &&
            executedDocActionCount > 0 &&
            executedMutatingDocActionCount === 0 &&
            executedInspectionDocActionCount === 0 &&
            forceDocMutationNudges < 2
          ) {
            forceDocMutationNudges += 1
            session.messages.push({
                role: 'user',
                content:
                '系统检查：你目前只完成了文档定位/切换，还没有执行内容修改。请继续调用合适的 document_* 编辑工具落实你的方案。',
              })
            log(`forceDocumentTool non-mutating tools only, nudge=${forceDocMutationNudges}`)
            continue
          }

          if (
            toolPolicy.forceDocumentTool &&
            executedMutatingDocActionCount > 0 &&
            executedSaveDocActionCount === 0 &&
            forceDocSaveNudges < 2
          ) {
            forceDocSaveNudges += 1
            session.messages.push({
              role: 'user',
              content:
                '系统检查：你已执行内容修改但尚未保存。请调用 document_save_tab 完成保存，再给出最终结论。',
            })
            log(`forceDocumentTool mutating tools without save, nudge=${forceDocSaveNudges}`)
            continue
          }

          if (toolPolicy.forceDocumentTool && (executedMutatingDocActionCount > 0 || executedInspectionDocActionCount > 0)) {
            documentToolTaskCompleted = true
          }

          if (toolPolicy.forceDocumentTool) {
            documentToolProgress = accumulateDocumentToolProgress(documentToolProgress, {
              executedMutatingDocActionCount,
              executedSaveDocActionCount,
              toolResults: documentToolResultsThisIteration,
            })
          }

          const documentToolCompletionText = buildDocumentToolCompletionText({
            forceDocumentTool: toolPolicy.forceDocumentTool,
            executedMutatingDocActionCount: documentToolProgress?.executedMutatingDocActionCount || 0,
            executedSaveDocActionCount: documentToolProgress?.executedSaveDocActionCount || 0,
            lastWidgetValidationError,
            toolResults: documentToolProgress?.toolResults || [],
          })
          if (documentToolCompletionText) {
            emitOutput(documentToolCompletionText, 'text')
            session.messages.push({ role: 'assistant', content: documentToolCompletionText })
            finishedBeforeLimit = true
            log('Completed forceDocumentTool loop from host-side save+mutation result')
            break
          }

          if (
            toolPolicy.forceDesignTool &&
            !toolPolicy.allowMultipleDesignArtifacts &&
            executedPrimaryDesignToolThisIteration
          ) {
            const completionText = this.buildActualDesignCompletionText(
              lastPrimaryDesignToolPayload,
              lastPrimaryDesignToolRawResult,
            )
            if (completionText) {
              emitOutput(completionText, 'text')
              session.messages.push({ role: 'assistant', content: completionText })
            }
            finishedBeforeLimit = true
            log(`Completed single-artifact design run after primary design tool with status=${String(lastPrimaryDesignToolPayload?.status || 'unknown')}`)
            break
          }

        }

        if (!finishedBeforeLimit && iterations >= effectiveMaxToolIterations) {
          log(`Tool loop hit max iterations (${effectiveMaxToolIterations})`)
          if (isBrowserTask && browserStepIndex < browserSteps.length) {
            log(`Browser task incomplete: step ${browserStepIndex + 1}/${browserSteps.length}`)
            session.messages.push({
              role: 'user',
              content: `[系统] 工具调用次数已达上限，但任务计划尚未完成到最后一步（当前在步骤 ${browserStepIndex + 1}/${browserSteps.length}）。请总结当前进度和未完成的步骤。`,
            })
          }
          emitOutput('\n[已达到最大工具调用次数，请尝试让助手使用 browser_run_workflow 或 browser_download_urls 批量执行后重试]', 'text')
        }
      }

      emitOutput('', 'done')
      emitStatus('done')
      return { success: true }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        emitOutput('', 'done')
        emitStatus('cancelled')
        return { success: true }
      }
      const msg = error instanceof Error ? error.message : String(error)
      log(`Error: ${msg}`)
      emitOutput(`API 请求失败: ${msg}`, 'error')
      emitOutput('', 'done')
      emitRuntimeError(msg)
      emitStatus('error')
      return { success: false, error: msg }
    } finally {
      if (session.abortController === abortController) {
        session.abortController = null
      }
      if (session.activeRunId === runId) {
        session.activeRunId = null
      }
    }
  }

  private shouldUseKimiCodingDefaults(baseUrl: string): boolean {
    return baseUrl.replace(/\/+$/, '').includes('api.kimi.com/coding')
  }

  private filterPreferredDesignAnthropicTools(
    tools: Array<Record<string, unknown>>,
    preferredDesignTool: string | null,
  ): Array<Record<string, unknown>> {
    if (!preferredDesignTool) return tools
    return tools.filter((tool) => {
      const name = typeof tool.name === 'string' ? tool.name : ''
      return name === preferredDesignTool || PREFERRED_DESIGN_FALLBACK_TOOL_NAMES.has(name)
    })
  }

  private filterPreferredDesignOpenAITools(
    tools: Array<Record<string, unknown>>,
    preferredDesignTool: string | null,
  ): Array<Record<string, unknown>> {
    if (!preferredDesignTool) return tools
    return tools.filter((tool) => {
      const fn = (tool.function as { name?: unknown } | undefined)?.name
      return typeof fn === 'string'
        ? fn === preferredDesignTool || PREFERRED_DESIGN_FALLBACK_TOOL_NAMES.has(fn)
        : false
    })
  }

  private filterAnthropicToolsByAllowedNames(
    tools: Array<Record<string, unknown>>,
    allowedNames: Set<string>,
  ): Array<Record<string, unknown>> {
    return tools.filter((tool) => {
      const name = typeof tool.name === 'string' ? tool.name : ''
      return allowedNames.has(name)
    })
  }

  private filterOpenAIToolsByAllowedNames(
    tools: Array<Record<string, unknown>>,
    allowedNames: Set<string>,
  ): Array<Record<string, unknown>> {
    return tools.filter((tool) => {
      const fn = (tool.function as { name?: unknown } | undefined)?.name
      return typeof fn === 'string' ? allowedNames.has(fn) : false
    })
  }

  private getPolicyAnthropicTools(policy?: ToolPolicy): Array<Record<string, unknown>> {
    let tools = policy?.forceDocumentTool ? getDocumentAnthropicTools() : getAnthropicTools()
    if (policy?.forceDocumentTool) {
      const allowedNames = policy.documentWidgetTaskKind === 'create'
        ? DOCUMENT_WIDGET_CREATE_TOOL_NAMES
        : policy.documentWidgetTaskKind === 'inspect'
          ? DOCUMENT_WIDGET_INSPECT_TOOL_NAMES
          : policy.documentWidgetTaskKind === 'update'
            ? DOCUMENT_WIDGET_UPDATE_TOOL_NAMES
            : policy.documentWidgetTaskKind === 'remove'
              ? DOCUMENT_WIDGET_REMOVE_TOOL_NAMES
              : policy.preferSectionRewrite
                ? SECTION_REWRITE_DOCUMENT_TOOL_NAMES
                : policy.preferFormatOnly
                  ? FORMAT_SECTION_DOCUMENT_TOOL_NAMES
                  : FORCE_DOCUMENT_TOOL_NAMES
      tools = this.filterAnthropicToolsByAllowedNames(tools, allowedNames)
    }
    if (policy?.forceDesignTool) {
      tools = this.filterPreferredDesignAnthropicTools(tools, policy.preferredDesignTool)
    }
    if (policy?.allowBrowserTools === false) {
      tools = tools.filter((tool) => {
        const name = typeof tool.name === 'string' ? tool.name : ''
        return !name.startsWith('browser_')
      })
    }
    if (policy?.preferredSkillToolNames && policy.preferredSkillToolNames.length > 0) {
      const allowed = new Set(policy.preferredSkillToolNames)
      tools = tools.filter((tool) => {
        const name = typeof tool.name === 'string' ? tool.name : ''
        return allowed.has(name)
      })
    }
    return tools
  }

  private getPolicyOpenAITools(policy?: ToolPolicy): Array<Record<string, unknown>> {
    let tools = policy?.forceDocumentTool ? getDocumentOpenAITools() : getOpenAITools()
    if (policy?.forceDocumentTool) {
      const allowedNames = policy.documentWidgetTaskKind === 'create'
        ? DOCUMENT_WIDGET_CREATE_TOOL_NAMES
        : policy.documentWidgetTaskKind === 'inspect'
          ? DOCUMENT_WIDGET_INSPECT_TOOL_NAMES
          : policy.documentWidgetTaskKind === 'update'
            ? DOCUMENT_WIDGET_UPDATE_TOOL_NAMES
            : policy.documentWidgetTaskKind === 'remove'
              ? DOCUMENT_WIDGET_REMOVE_TOOL_NAMES
              : policy.preferSectionRewrite
                ? SECTION_REWRITE_DOCUMENT_TOOL_NAMES
                : policy.preferFormatOnly
                  ? FORMAT_SECTION_DOCUMENT_TOOL_NAMES
                  : FORCE_DOCUMENT_TOOL_NAMES
      tools = this.filterOpenAIToolsByAllowedNames(tools, allowedNames)
    }
    if (policy?.forceDesignTool) {
      tools = this.filterPreferredDesignOpenAITools(tools, policy.preferredDesignTool)
    }
    if (policy?.allowBrowserTools === false) {
      tools = tools.filter((tool) => {
        const fn = (tool.function as { name?: unknown } | undefined)?.name
        return typeof fn === 'string' ? !fn.startsWith('browser_') : true
      })
    }
    if (policy?.preferredSkillToolNames && policy.preferredSkillToolNames.length > 0) {
      const allowed = new Set(policy.preferredSkillToolNames)
      tools = tools.filter((tool) => {
        const fn = (tool.function as { name?: unknown } | undefined)?.name
        return typeof fn === 'string' ? allowed.has(fn) : false
      })
    }
    return tools.map((tool) => normalizeOpenAIToolSchema(tool))
  }

  private collectToolNames(
    tools: Array<Record<string, unknown>>,
    format: 'anthropic' | 'openai',
  ): string[] {
    return tools
      .map((tool) => {
        if (format === 'anthropic') {
          return typeof tool.name === 'string' ? tool.name : ''
        }
        const fn = (tool.function as { name?: unknown } | undefined)?.name
        return typeof fn === 'string' ? fn : ''
      })
      .filter((name) => name.length > 0)
  }

  private buildTextToolBridgeSystemPrompt(policy?: ToolPolicy): string {
    return buildTextToolBridgePrompt(this.getPolicyOpenAITools(policy), {
      forceDocumentTool: !!policy?.forceDocumentTool,
    })
  }

  private buildTextToolBridgeCorrectionMessage(policy?: ToolPolicy): string {
    const toolNames = this.collectToolNames(this.getPolicyOpenAITools(policy), 'openai')
    return [
      '系统纠正：当前会话已经启用文本工具桥接，下面这些 Ready 工具都可以真实执行。',
      `可用工具：${toolNames.join(', ') || '无'}`,
      '如果你需要浏览器/技能/文档操作，请直接输出 :::tool_call JSON ::: 块，不要再回答“当前通道没有工具”。',
      '如果你不确定该用哪个浏览器动作，优先先读页、定位输入框、定位按钮或读取 skill 说明，再继续。',
      '如果信息确实不足，可以提一个澄清问题，但不要伪造工具不可用。',
    ].join('\n')
  }

  private toTextToolBridgeResponse(
    rawText: string,
    reasoningContent?: unknown,
    providerResponseId?: string,
  ): APIResponse {
    const parsed = parseTextToolBridgeResponse(rawText)
    return {
      text: parsed.visibleText,
      rawText,
      toolCalls: parsed.toolCalls.map((call) => ({
        id: `texttc_${randomUUID().replace(/-/g, '')}`,
        name: call.name,
        input: call.args,
      })),
      stopReason: 'text_tool_bridge',
      reasoningContent,
      providerResponseId,
      toolTransport: 'text',
    }
  }

  private shouldUseTextToolBridge(
    session: DirectChatSession,
    config: AIModelConfig,
  ): boolean {
    if (session.preferTextToolBridge) return true
    const capabilities = resolveAIConfigCapabilities(config)
    return capabilities?.toolCallTransport === 'text'
  }

  private shouldRetryWithTextToolBridge(
    text: string,
    session: DirectChatSession,
    config: AIModelConfig,
  ): boolean {
    if (session.preferTextToolBridge) return false
    const capabilities = resolveAIConfigCapabilities(config)
    if (!capabilities?.supportsToolCalls) return false
    return looksLikeMissingNativeToolsReply(text)
  }

  private resolveAnthropicLikeModel(config: AIModelConfig, baseUrl: string): string {
    const rawModel = (config.model || '').trim()
    if (rawModel && rawModel !== '__custom__' && rawModel !== 'custom') {
      return rawModel
    }
    if (this.shouldUseKimiCodingDefaults(baseUrl)) {
      return 'kimi-for-coding'
    }
    return 'claude-haiku-3-5-20241022'
  }

  private buildAnthropicLikeHeaders(config: AIModelConfig, baseUrl: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if ((config.provider === 'anthropic' && !config.agentProtocol) || this.shouldUseKimiCodingDefaults(baseUrl)) {
      headers['x-api-key'] = config.apiKey
      return headers
    }
    const provider = getProviderDef(config.provider, baseUrl)
    const authHeader = provider?.authHeader || 'Authorization'
    const authPrefix = provider?.authPrefix ?? 'Bearer '
    headers[authHeader] = `${authPrefix}${config.apiKey}`
    if (provider?.extraHeaders) {
      Object.assign(headers, provider.extraHeaders)
    }
    return headers
  }

  // ── Anthropic: simple (no tools) ──────────────────────────────────
  private async callAnthropicSimple(
    session: DirectChatSession,
    config: AIModelConfig,
    baseUrl: string,
    signal: AbortSignal,
    messagesOverride?: ChatMessage[],
  ): Promise<string> {
    const headers = this.buildAnthropicLikeHeaders(config, baseUrl)
    const model = this.resolveAnthropicLikeModel(config, baseUrl)

    const url = `${baseUrl}/v1/messages`
    log(`POST ${url}, model=${model}, stream=false (simple)`)

    const reqBody: Record<string, unknown> = {
      model,
      max_tokens: 4096,
      system: session.systemPrompt,
      messages: this.serializeMessages(messagesOverride ?? session.messages, 'anthropic'),
    }

    const resp = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
      signal,
    }, signal, 'anthropic simple')

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
    }

    const json = await resp.json() as {
      content?: Array<{ type: string; text?: string }>
    }

    return json.content?.filter(b => b.type === 'text').map(b => b.text).join('') || ''
  }

  // ── Anthropic: with tools ─────────────────────────────────────────
  private async callAnthropicWithTools(
    session: DirectChatSession,
    config: AIModelConfig,
    baseUrl: string,
    signal: AbortSignal,
    policy?: ToolPolicy,
  ): Promise<APIResponse> {
    const headers = this.buildAnthropicLikeHeaders(config, baseUrl)
    const model = this.resolveAnthropicLikeModel(config, baseUrl)
    const timeoutMs = resolveApiRequestTimeoutMs(policy)

    const url = `${baseUrl}/v1/messages`
    log(`POST ${url}, model=${model}, with tools, timeout=${timeoutMs}`)

    const tools = this.getPolicyAnthropicTools(policy)
    if (policy?.forceDocumentTool) {
      log(`forceDocumentTool anthropic tools=${this.collectToolNames(tools, 'anthropic').join(',')}`)
    }
    if (policy?.forceDesignTool) {
      log(`forceDesignTool anthropic tools=${this.collectToolNames(tools, 'anthropic').join(',')}`)
    }
    const reqBody: Record<string, unknown> = {
      model,
      max_tokens: 4096,
      system: session.systemPrompt,
      messages: this.serializeMessages(session.messages, 'anthropic'),
      tools,
    }
    // 不再强制工具调用，改为让 LLM 自主判断
    // if (policy?.forceDocumentTool || policy?.forceDesignTool) {
    //   reqBody.tool_choice = { type: 'any' }
    // }

    const resp = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
      signal,
    }, signal, 'anthropic tools', timeoutMs)

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
    }

    const json = await resp.json() as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>
      stop_reason?: string
    }

    const text = json.content?.filter(b => b.type === 'text').map(b => b.text).join('') || ''
    const toolCalls: ToolCall[] = (json.content || [])
      .filter(b => b.type === 'tool_use')
      .map(b => ({
        id: b.id!,
        name: b.name!,
        input: b.input || {}
      }))

    log(`Anthropic response: text=${text.length}chars, toolCalls=${toolCalls.length}, stop=${json.stop_reason}`)
    return { text, toolCalls, stopReason: json.stop_reason || 'end_turn' }
  }

  private getKimiCodingUserAgent(): string {
    const envUA = process.env.READY_KIMI_CODING_USER_AGENT?.trim()
    return envUA || DEFAULT_KIMI_CODING_USER_AGENT
  }

  private resolveKimiCodingV1Base(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/+$/, '')
    return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
  }

  private async callKimiCodingSimple(
    session: DirectChatSession,
    config: AIModelConfig,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<string> {
    const v1Base = this.resolveKimiCodingV1Base(baseUrl)
    const url = `${v1Base}/chat/completions`
    const model = this.resolveAnthropicLikeModel(config, baseUrl)
    const messages = await this.serializeMessagesForKimiCoding(session.messages, v1Base, config.apiKey, signal)

    log(`POST ${url}, model=${model}, stream=false, kimiCoding=true`)

    const resp = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        'x-api-key': config.apiKey,
        'User-Agent': this.getKimiCodingUserAgent(),
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
      }),
      signal,
    }, signal, 'kimi coding simple')

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
    }

    const json = await resp.json() as {
      choices?: Array<{
        message?: {
          content?: string | Array<Record<string, unknown>>
        }
      }>
    }

    return this.extractOpenAIMessageText(json.choices?.[0]?.message?.content)
  }

  private async serializeMessagesForKimiCoding(
    messages: ChatMessage[],
    v1Base: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    const serialized: Array<Record<string, unknown>> = []

    for (const msg of messages) {
      const raw = msg as unknown as Record<string, unknown>
      const role = typeof raw.role === 'string' ? raw.role : 'user'

      if (!Array.isArray(msg.content)) {
        serialized.push({
          ...raw,
          role,
          content: msg.content,
        })
        continue
      }

      const contentParts: Array<Record<string, unknown>> = []
      const uploadedVideoUrls: string[] = []
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue

        if (block.type === 'text') {
          contentParts.push({ type: 'text', text: typeof block.text === 'string' ? block.text : '' })
          continue
        }

        if (block.type === 'image' && block.source) {
          const source = block.source as { media_type?: string; data?: string }
          if (typeof source.data === 'string' && source.data.length > 0) {
            const mediaType = source.media_type || 'image/png'
            contentParts.push({
              type: 'image_url',
              image_url: { url: `data:${mediaType};base64,${source.data}` },
            })
          }
          continue
        }

        if (block.type === 'video' && block.source) {
          const source = block.source as Record<string, unknown>
          let videoUrl = ''

          if (source.type === 'url' && typeof source.url === 'string' && source.url.startsWith('ms://')) {
            videoUrl = source.url
          } else if (typeof source.data === 'string' && source.data.length > 0) {
            const mediaType = typeof source.media_type === 'string' ? source.media_type : 'video/mp4'
            videoUrl = await this.uploadVideoToKimiFiles(v1Base, apiKey, source.data, mediaType, signal)
            source.type = 'url'
            source.url = videoUrl
            delete source.data
          }

          if (videoUrl) {
            uploadedVideoUrls.push(videoUrl)
          } else {
            contentParts.push({ type: 'text', text: '[视频附件已接收，但上传失败。]' })
          }
          continue
        }

        contentParts.push(block)
      }

      serialized.push({
        ...raw,
        role,
        content: contentParts.length > 0 ? contentParts : [{ type: 'text', text: '' }],
      })

      for (const videoUrl of uploadedVideoUrls) {
        const toolCallId = `tool_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        serialized.push({
          role: 'assistant',
          content: '我先读取视频附件。',
          reasoning_content: '需要先读取用户上传的视频附件并理解其内容。',
          tool_calls: [
            {
              id: toolCallId,
              type: 'function',
              function: {
                name: 'ReadMediaFile',
                arguments: JSON.stringify({ video_url: videoUrl }),
              },
            },
          ],
        })
        serialized.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: [
            { type: 'text', text: '<video path="upload.mp4">' },
            { type: 'video_url', video_url: { url: videoUrl } },
            { type: 'text', text: '</video>' },
          ],
        })
      }
    }

    return serialized
  }

  private async uploadVideoToKimiFiles(
    v1Base: string,
    apiKey: string,
    videoBase64: string,
    mediaType: string,
    signal: AbortSignal,
  ): Promise<string> {
    const url = `${v1Base}/files`
    const binary = Buffer.from(videoBase64, 'base64')
    if (binary.length === 0) {
      throw new Error('video payload is empty')
    }

    const filename = `upload.${this.extensionFromVideoMediaType(mediaType)}`
    const boundary = `----ready-${randomUUID().replace(/-/g, '')}`
    const prefix = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="purpose"\r\n\r\n` +
      `video\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mediaType}\r\n\r\n`,
      'utf-8',
    )
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8')
    const body = Buffer.concat([prefix, binary, suffix])

    log(`POST ${url}, purpose=video, bytes=${binary.length}`)
    const resp = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'User-Agent': this.getKimiCodingUserAgent(),
      },
      body,
      signal,
    }, signal, 'kimi file upload')

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      throw new Error(`upload video failed: HTTP ${resp.status}: ${errBody.slice(0, 240)}`)
    }

    const json = await resp.json() as { id?: string }
    if (!json.id) {
      throw new Error('upload video failed: missing file id')
    }
    const msUrl = `ms://${json.id}`
    log(`uploaded video to kimi files: ${msUrl}`)
    return msUrl
  }

  private extractOpenAIMessageText(content: unknown): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''

    const texts: string[] = []
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const block = item as Record<string, unknown>
      if (block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text)
      }
    }
    return texts.join('')
  }

  private resolveOpenAIWireApi(
    config: AIModelConfig,
    provider: ReturnType<typeof getProviderDef>,
    baseUrl: string,
  ): AIWireAPI {
    const capabilities = resolveAIConfigCapabilities(config)
    if (capabilities?.wireApi === 'responses' || capabilities?.wireApi === 'chat/completions') return capabilities.wireApi
    const explicit = config.wireApi || provider?.wireApi
    if (explicit === 'responses' || explicit === 'chat/completions') return explicit
    return baseUrl.includes('/codex/v1') ? 'responses' : 'chat/completions'
  }

  private resolveReasoningEffort(
    config: AIModelConfig,
    provider: ReturnType<typeof getProviderDef>,
  ): 'minimal' | 'low' | 'medium' | 'high' | undefined {
    const effort = config.reasoningEffort || provider?.defaultReasoningEffort
    return effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high'
      ? effort
      : undefined
  }

  private serializeMessagesForResponses(messages: ChatMessage[]): Array<Record<string, unknown>> {
    return messages
      .map((message) => message as unknown as Record<string, unknown>)
      .filter((message) => message.role !== 'tool')
      .map((message) => {
        const role = message.role === 'assistant' ? 'assistant' : 'user'
        const textType = role === 'assistant' ? 'output_text' : 'input_text'
        if (!Array.isArray(message.content)) {
          return {
            role,
            content: [{ type: textType, text: String(message.content || '') }],
          }
        }
        const content = (message.content as Array<Record<string, unknown>>)
          .map((block) => {
            if (!block || typeof block !== 'object') return null
            if (block.type === 'text') {
              return { type: textType, text: typeof block.text === 'string' ? block.text : '' }
            }
            if (role !== 'assistant' && block.type === 'image' && block.source) {
              const source = block.source as { media_type?: string; data?: string }
              if (typeof source.data === 'string' && source.data.length > 0) {
                return {
                  type: 'input_image',
                  image_url: `data:${source.media_type || 'image/png'};base64,${source.data}`,
                }
              }
            }
            if (block.type === 'video') {
              return { type: textType, text: '[视频附件已附带，但当前 Responses 通道未直接发送视频数据。]' }
            }
            if (role === 'assistant') {
              return { type: textType, text: '[上一轮助手消息包含非文本内容，已省略原始结构。]' }
            }
            return null
          })
          .filter(Boolean)
        return {
          role,
          content: content.length > 0 ? content : [{ type: textType, text: '' }],
        }
      })
  }

  private convertOpenAIToolsToResponses(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return tools
      .map((tool) => {
        const normalizedTool = normalizeOpenAIToolSchema(tool)
        if (normalizedTool.type !== 'function') return null
        const fn = normalizedTool.function as Record<string, unknown> | undefined
        if (!fn) return null
        return {
          type: 'function',
          name: String(fn.name || ''),
          description: typeof fn.description === 'string' ? fn.description : '',
          parameters: normalizeToolJsonSchema((fn.parameters && typeof fn.parameters === 'object') ? fn.parameters : { type: 'object', properties: {} }),
        }
      })
      .filter(Boolean) as Array<Record<string, unknown>>
  }

  private extractResponsesText(payload: unknown): string {
    if (!payload || typeof payload !== 'object') return ''
    const direct = (payload as { output_text?: unknown }).output_text
    if (typeof direct === 'string' && direct.trim()) return direct.trim()
    const output = Array.isArray((payload as { output?: unknown[] }).output)
      ? (payload as { output: unknown[] }).output
      : []
    const chunks: string[] = []
    for (const item of output) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      if (record.type !== 'message') continue
      const content = Array.isArray(record.content) ? record.content : []
      for (const part of content) {
        if (!part || typeof part !== 'object') continue
        const block = part as Record<string, unknown>
        if ((block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string') {
          chunks.push(block.text)
        }
      }
    }
    return chunks.join('').trim()
  }

  private extractResponsesToolCalls(payload: unknown): ToolCall[] {
    if (!payload || typeof payload !== 'object') return []
    const output = Array.isArray((payload as { output?: unknown[] }).output)
      ? (payload as { output: unknown[] }).output
      : []
    const calls: ToolCall[] = []
    for (const item of output) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      if (record.type !== 'function_call') continue
      const rawArgs = typeof record.arguments === 'string' ? record.arguments : '{}'
      let input: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(rawArgs)
        if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>
      } catch {
        input = {}
      }
      const id = String(record.call_id || record.id || randomUUID())
      calls.push({
        id,
        name: String(record.name || ''),
        input,
      })
    }
    return calls
  }

  private getResponsesContinuationState(session: DirectChatSession): {
    previousResponseId: string
    input: Array<Record<string, unknown>>
  } | null {
    const rawMessages = this.repairOpenAIToolMessageHistory(session.messages)
    let assistantIndex = -1
    for (let i = rawMessages.length - 1; i >= 0; i -= 1) {
      const item = rawMessages[i]
      if (item?.role === 'assistant' && typeof item.response_id === 'string' && item.response_id) {
        assistantIndex = i
        break
      }
    }
    if (assistantIndex < 0) return null
    const assistant = rawMessages[assistantIndex]
    const previousResponseId = String(assistant.response_id || '')
    if (!previousResponseId) return null

    const input: Array<Record<string, unknown>> = []
    for (const item of rawMessages.slice(assistantIndex + 1)) {
      if (item?.role !== 'tool') continue
      if (typeof item.tool_call_id !== 'string' || typeof item.content !== 'string') continue
      input.push({
        type: 'function_call_output',
        call_id: item.tool_call_id,
        output: item.content,
      })
    }
    if (input.length === 0) return null
    return { previousResponseId, input }
  }

  private repairOpenAIToolMessageHistory(messages: ChatMessage[]): Array<Record<string, unknown>> {
    const rawMessages = messages.map((message) => ({ ...(message as unknown as Record<string, unknown>) }))
    const repaired: Array<Record<string, unknown>> = []
    let index = 0
    while (index < rawMessages.length) {
      const current = rawMessages[index]
      repaired.push(current)
      const toolCalls = Array.isArray(current?.tool_calls) ? current.tool_calls as Array<Record<string, unknown>> : []
      if (current?.role !== 'assistant' || toolCalls.length === 0) {
        index += 1
        continue
      }

      const expectedIds = toolCalls
        .map((call) => typeof call.id === 'string' ? call.id : '')
        .filter(Boolean)
      const seenIds = new Set<string>()
      let nextIndex = index + 1
      while (nextIndex < rawMessages.length) {
        const next = rawMessages[nextIndex]
        if (next?.role !== 'tool') break
        repaired.push(next)
        if (typeof next.tool_call_id === 'string') {
          seenIds.add(next.tool_call_id)
        }
        nextIndex += 1
      }

      for (const toolCallId of expectedIds) {
        if (seenIds.has(toolCallId)) continue
        repaired.push({
          role: 'tool',
          content: '[missing tool output repaired by host]',
          tool_call_id: toolCallId,
        })
      }
      index = nextIndex
    }
    return repaired
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

  private shouldForceDocumentToolCall(userText: string): boolean {
    return shouldForceDocumentToolCallFromText(userText)
  }

  private inferDocumentWidgetTaskKind(userText: string): DocumentWidgetTaskKind {
    return inferDocumentWidgetTaskKindFromText(userText)
  }

  private hasExplicitDocumentWidgetCreateIntent(userText: string): boolean {
    return hasExplicitDocumentWidgetCreateIntentFromText(userText)
  }

  private shouldPreferFormatOnly(userText: string): boolean {
    return shouldPreferFormatOnlyFromText(userText)
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

  private shouldPreferSectionRewrite(userText: string): boolean {
    return shouldPreferSectionRewriteFromText(userText)
  }

  private parseSectionRewritePlan(raw: string): SectionRewritePlan | null {
    if (!raw) return null
    const candidates: string[] = []
    const fencedRegex = /```(?:json|ready-section-rewrite)?\s*([\s\S]*?)```/gi
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
        const parsed = JSON.parse(candidate) as Record<string, unknown>
        const sectionTitle = typeof parsed.sectionTitle === 'string' ? parsed.sectionTitle.trim() : ''
        const content = typeof parsed.content === 'string' ? parsed.content.trim() : ''
        if (sectionTitle && content) {
          return { sectionTitle, content }
        }
      } catch {
        // Try next candidate.
      }
    }
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

  private stripCodeFence(raw: string): string {
    return raw
      .replace(/```[\w-]*\n?/g, '')
      .replace(/```/g, '')
      .trim()
  }

  private async captureDocumentSnapshot(path: string | null): Promise<DocumentSnapshot | null> {
    if (!path || !path.startsWith('/')) return null
    const readResult = await readDocumentEditableText(path)
    if (!readResult.success) return null
    const normalized = readResult.content.replace(/\r\n/g, '\n')
    const hash = createHash('sha1').update(normalized, 'utf8').digest('hex')
    return {
      path,
      hash,
      length: normalized.length,
    }
  }

  private async hasDocumentSnapshotChanged(snapshot: DocumentSnapshot): Promise<boolean | null> {
    const readResult = await readDocumentEditableText(snapshot.path)
    if (!readResult.success) return null
    const normalized = readResult.content.replace(/\r\n/g, '\n')
    const nextHash = createHash('sha1').update(normalized, 'utf8').digest('hex')
    return nextHash !== snapshot.hash || normalized.length !== snapshot.length
  }

  private async applyFormatSectionByPath(
    path: string,
    sectionTitle: string | null,
  ): Promise<{ success: boolean; changed: boolean; message: string }> {
    const readResult = await readDocumentEditableText(path)
    if (!readResult.success) {
      return {
        success: false,
        changed: false,
        message: `读取失败：${readResult.error || path}`,
      }
    }

    if (!sectionTitle) {
      const basic = formatWholeDocumentPreservingMeaning(readResult.content, { aggressive: false })
      const aggressive = formatWholeDocumentPreservingMeaning(readResult.content, { aggressive: true })

      let whole = basic
      const basicScore = basic.metrics.headingCount * 3 + basic.metrics.bulletCount * 2 + basic.metrics.paragraphCount
      const aggressiveScore =
        aggressive.metrics.headingCount * 3 + aggressive.metrics.bulletCount * 2 + aggressive.metrics.paragraphCount

      if (aggressive.changed && (!basic.changed || aggressiveScore > basicScore + 8)) {
        whole = aggressive
      }

      if (!whole.changed) {
        return {
          success: true,
          changed: false,
          message: '整篇文档排版已是目标状态',
        }
      }

      const integrity = validateFormattingIntegrity(readResult.content, whole.content)
      if (!integrity.safe) {
        return {
          success: false,
          changed: false,
          message:
            `排版安全校验未通过（lengthDelta=${(integrity.lengthDeltaRatio * 100).toFixed(2)}%），已取消写入`,
        }
      }

      const writeWholeResult = await writeDocumentEditableText(path, whole.content)
      if (!writeWholeResult.success) {
        return {
          success: false,
          changed: false,
          message: `保存失败：${writeWholeResult.error || path}`,
        }
      }

      const verifyResult = await readDocumentEditableText(path)
      if (!verifyResult.success) {
        return {
          success: false,
          changed: false,
          message: `保存后校验失败：${verifyResult.error || path}`,
        }
      }
      const verifyIntegrity = validateFormattingIntegrity(whole.content, verifyResult.content)
      if (!verifyIntegrity.safe) {
        return {
          success: false,
          changed: false,
          message: '保存后校验失败：写入结果与预期不一致，已中止后续动作',
        }
      }

      return {
        success: true,
        changed: true,
        message: [
          '已优化整篇文档格式并保存',
          `结构指标: heading=${whole.metrics.headingCount}, bullet=${whole.metrics.bulletCount}, paragraph=${whole.metrics.paragraphCount}`,
          `保真校验: Δlen=${(integrity.lengthDeltaRatio * 100).toFixed(2)}%, prefix=${integrity.prefix}, suffix=${integrity.suffix}`,
        ].join('；'),
      }
    }

    const formatted = formatSectionInDocument(readResult.content, sectionTitle)
    if (!formatted.found) {
      return {
        success: false,
        changed: false,
        message: `未找到章节“${sectionTitle}”`,
      }
    }

    if (formatted.content === readResult.content.replace(/\r\n/g, '\n')) {
      return {
        success: true,
        changed: false,
        message: `章节“${formatted.matchedTitle || sectionTitle}”排版已是目标状态`,
      }
    }

    const integrity = validateFormattingIntegrity(readResult.content, formatted.content)
    if (!integrity.safe) {
      return {
        success: false,
        changed: false,
        message:
          `章节排版安全校验未通过（lengthDelta=${(integrity.lengthDeltaRatio * 100).toFixed(2)}%），已取消写入`,
      }
    }

    const writeResult = await writeDocumentEditableText(path, formatted.content)
    if (!writeResult.success) {
      return {
        success: false,
        changed: false,
        message: `保存失败：${writeResult.error || path}`,
      }
    }

    return {
      success: true,
      changed: true,
      message: `已优化章节格式（${formatted.matchedTitle || sectionTitle}）并保存；保真校验Δlen=${(integrity.lengthDeltaRatio * 100).toFixed(2)}%`,
    }
  }

  private async applyRewriteSectionByPath(
    path: string,
    sectionTitle: string,
    nextContent: string,
  ): Promise<{ success: boolean; changed: boolean; message: string }> {
    const readResult = await readDocumentEditableText(path)
    if (!readResult.success) {
      return {
        success: false,
        changed: false,
        message: `读取失败：${readResult.error || path}`,
      }
    }

    const rewritten = rewriteSectionInDocument(readResult.content, sectionTitle, nextContent)
    if (!rewritten.found) {
      return {
        success: false,
        changed: false,
        message: `未找到章节“${sectionTitle}”`,
      }
    }

    if (rewritten.content === readResult.content.replace(/\r\n/g, '\n')) {
      return {
        success: true,
        changed: false,
        message: `章节“${rewritten.matchedTitle || sectionTitle}”内容未发生变化`,
      }
    }

    const writeResult = await writeDocumentEditableText(path, rewritten.content)
    if (!writeResult.success) {
      return {
        success: false,
        changed: false,
        message: `保存失败：${writeResult.error || path}`,
      }
    }

    return {
      success: true,
      changed: true,
      message: `已重写章节（${rewritten.matchedTitle || sectionTitle}）并保存`,
    }
  }

  private async buildSectionRewriteDraft(
    session: DirectChatSession,
    config: AIModelConfig,
    baseUrl: string,
    provider: ReturnType<typeof getProviderDef>,
    signal: AbortSignal,
    isKimi: boolean,
    isKimiCoding: boolean,
    useAnthropicProtocol: boolean,
  ): Promise<string> {
    const planningPrompt = [
      '系统任务：你正在执行 Ready 的文档章节编辑流程。',
      '请基于当前对话中最后一条用户请求和文档上下文，只返回一个 JSON 对象，不能有任何额外文本：',
      '{"sectionTitle":"要修改的章节标题","content":"该章节的新内容（不含标题行）"}',
      '要求：',
      '1) sectionTitle 要精确指向用户要求修改的章节（例如“第一部分”）。',
      '2) content 只给章节正文，不要解释。',
      '3) 若无法判断标题，sectionTitle 填写“第一部分”。',
    ].join('\n')

    const planningSession: DirectChatSession = {
      ...session,
      messages: [...session.messages, { role: 'user', content: planningPrompt }],
      abortController: null,
    }

    if (isKimiCoding) {
      return this.callKimiCodingSimple(planningSession, config, baseUrl, signal)
    }
    if (useAnthropicProtocol) {
      return this.callAnthropicSimple(planningSession, config, baseUrl, signal)
    }
    return this.callOpenAISimple(
      planningSession,
      config,
      baseUrl,
      provider,
      signal,
      isKimi,
      false,
    )
  }

  private async tryDeterministicSectionFormatFlow(params: {
    agentName: string
    userText: string
  }): Promise<boolean> {
    const { agentName, userText } = params
    try {
      const instructionText = this.extractPrimaryUserInstruction(userText)
      const sectionTitle = this.extractSectionTitleFromUserText(instructionText)
      const targetScope = sectionTitle ? `章节 ${sectionTitle}` : '整篇文档'
      const targetPath = this.extractDocumentPathFromUserText(userText)
      const toolContext = {
        browserController: this.browserController,
        sidecarManager: this.sidecarManager,
        runtime: this.runtime,
        scope: undefined,
        emitToolAction: (tool: string, args: Record<string, unknown>) => {
          this.emit('toolAction', { agent: agentName, tool, args })
        },
        sessionId: agentName.includes('::') ? agentName.slice(agentName.indexOf('::') + 2) : undefined,
      }

      log(`deterministic section format flow start, scope=${targetScope}, path=${targetPath || '(active-tab)'}`)

      if (targetPath && targetPath.startsWith('/')) {
        const directResult = await this.applyFormatSectionByPath(targetPath, sectionTitle)
        log(`deterministic section format direct result=${directResult.message}`)
        if (directResult.success) {
          this.emit('toolAction', { agent: agentName, tool: 'document.openFile', args: { path: targetPath } })
          const summary = [
            `已执行格式优化：${targetScope}`,
            `- 文件: ${targetPath}`,
            `- ${directResult.message}`,
          ].join('\n')
          this.emit('output', { agent: agentName, chunk: summary, type: 'text' })
          return true
        }
        log(`deterministic section format fallback to tool chain: ${directResult.message}`)
      }

      if (targetPath) {
        this.emit('output', {
          agent: agentName,
          chunk: `document_open_tab(${JSON.stringify({ path: targetPath }).slice(0, 180)})`,
          type: 'tool_use',
        })
        const openResult = await executeToolCall('document_open_tab', { path: targetPath }, toolContext)
        this.emit('output', { agent: agentName, chunk: openResult.slice(0, 200), type: 'tool_result' })
        log(`deterministic section format open result=${openResult.slice(0, 180)}`)
      }

      const formatArgs = { sectionTitle: sectionTitle || '第一部分', style: 'readable' }
      this.emit('output', {
        agent: agentName,
        chunk: `document_format_section(${JSON.stringify(formatArgs).slice(0, 180)})`,
        type: 'tool_use',
      })
      const formatResult = await executeToolCall('document_format_section', formatArgs, toolContext)
      this.emit('output', { agent: agentName, chunk: formatResult.slice(0, 200), type: 'tool_result' })
      log(`deterministic section format result=${formatResult.slice(0, 180)}`)

      this.emit('output', {
        agent: agentName,
        chunk: 'document_save_tab({})',
        type: 'tool_use',
      })
      const saveResult = await executeToolCall('document_save_tab', {}, toolContext)
      this.emit('output', { agent: agentName, chunk: saveResult.slice(0, 200), type: 'tool_result' })
      log(`deterministic section format save result=${saveResult.slice(0, 180)}`)

      const summary = [
        `已执行格式优化：${targetScope}`,
        '- 已保持原意，仅调整排版结构',
        `- ${formatResult}`,
        `- ${saveResult}`,
      ].join('\n')
      this.emit('output', { agent: agentName, chunk: summary, type: 'text' })
      return true
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      log(`deterministic section format failed: ${msg}`)
      return false
    }
  }

  private async tryDeterministicSectionRewriteFlow(params: {
    agentName: string
    session: DirectChatSession
    config: AIModelConfig
    baseUrl: string
    provider: ReturnType<typeof getProviderDef>
    signal: AbortSignal
    isKimi: boolean
    isKimiCoding: boolean
    useAnthropicProtocol: boolean
    userText: string
  }): Promise<boolean> {
    const {
      agentName,
      session,
      config,
      baseUrl,
      provider,
      signal,
      isKimi,
      isKimiCoding,
      useAnthropicProtocol,
      userText,
    } = params

    try {
      log('deterministic section rewrite flow start')
      const instructionText = this.extractPrimaryUserInstruction(userText)
      const draft = await this.buildSectionRewriteDraft(
        session,
        config,
        baseUrl,
        provider,
        signal,
        isKimi,
        isKimiCoding,
        useAnthropicProtocol,
      )
      log(`deterministic section rewrite draft chars=${draft.length}`)

      const plan = this.parseSectionRewritePlan(draft)
      const fallbackTitle = this.extractSectionTitleFromUserText(instructionText) || '第一部分'
      const finalPlan: SectionRewritePlan = plan || {
        sectionTitle: fallbackTitle,
        content: this.stripCodeFence(draft),
      }

      if (!finalPlan.content || finalPlan.content.length < 8) {
        log('deterministic section rewrite skipped: empty draft content')
        return false
      }

      const toolContext = {
        browserController: this.browserController,
        sidecarManager: this.sidecarManager,
        runtime: this.runtime,
        scope: undefined,
        emitToolAction: (tool: string, args: Record<string, unknown>) => {
          this.emit('toolAction', { agent: agentName, tool, args })
        },
        sessionId: agentName.includes('::') ? agentName.slice(agentName.indexOf('::') + 2) : undefined,
      }

      const targetPath = this.extractDocumentPathFromUserText(userText)
      if (targetPath && targetPath.startsWith('/')) {
        const directResult = await this.applyRewriteSectionByPath(
          targetPath,
          finalPlan.sectionTitle,
          finalPlan.content,
        )
        log(`deterministic section rewrite direct result=${directResult.message}`)
        if (directResult.success) {
          this.emit('toolAction', { agent: agentName, tool: 'document.openFile', args: { path: targetPath } })
          const summary = [
            `已执行章节改写：${finalPlan.sectionTitle}`,
            `- 文件: ${targetPath}`,
            `- ${directResult.message}`,
          ].join('\n')
          this.emit('output', { agent: agentName, chunk: summary, type: 'text' })
          session.messages.push({ role: 'assistant', content: summary })
          return true
        }
        log(`deterministic section rewrite fallback to tool chain: ${directResult.message}`)
      }

      if (targetPath) {
        this.emit('output', {
          agent: agentName,
          chunk: `document_open_tab(${JSON.stringify({ path: targetPath }).slice(0, 180)})`,
          type: 'tool_use',
        })
        const openResult = await executeToolCall('document_open_tab', { path: targetPath }, toolContext)
        this.emit('output', { agent: agentName, chunk: openResult.slice(0, 200), type: 'tool_result' })
        log(`deterministic section rewrite open result=${openResult.slice(0, 180)}`)
      }

      const rewriteArgs: Record<string, unknown> = {
        sectionTitle: finalPlan.sectionTitle,
        content: finalPlan.content,
      }
      this.emit('output', {
        agent: agentName,
        chunk: `document_rewrite_section(${JSON.stringify(rewriteArgs).slice(0, 180)})`,
        type: 'tool_use',
      })
      const rewriteResult = await executeToolCall('document_rewrite_section', rewriteArgs, toolContext)
      this.emit('output', { agent: agentName, chunk: rewriteResult.slice(0, 200), type: 'tool_result' })
      log(`deterministic section rewrite tool result=${rewriteResult.slice(0, 180)}`)

      this.emit('output', {
        agent: agentName,
        chunk: 'document_save_tab({})',
        type: 'tool_use',
      })
      const saveResult = await executeToolCall('document_save_tab', {}, toolContext)
      this.emit('output', { agent: agentName, chunk: saveResult.slice(0, 200), type: 'tool_result' })
      log(`deterministic section rewrite save result=${saveResult.slice(0, 180)}`)

      const summary = [
        `已执行章节改写：${finalPlan.sectionTitle}`,
        `- ${rewriteResult}`,
        `- ${saveResult}`,
      ].join('\n')
      this.emit('output', { agent: agentName, chunk: summary, type: 'text' })
      session.messages.push({ role: 'assistant', content: summary })
      return true
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      log(`deterministic section rewrite failed: ${msg}`)
      return false
    }
  }

  // ── OpenAI: simple (no tools) ─────────────────────────────────────
  private async callOpenAISimple(
    session: DirectChatSession,
    config: AIModelConfig,
    baseUrl: string,
    provider: ReturnType<typeof getProviderDef>,
    signal: AbortSignal,
    isKimi = false,
    enableKimiWebSearch = true,
  ): Promise<string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    const authHeader = provider?.authHeader || 'Authorization'
    const authPrefix = provider?.authPrefix ?? 'Bearer '
    headers[authHeader] = `${authPrefix}${config.apiKey}`

    if (provider?.extraHeaders) {
      Object.assign(headers, provider.extraHeaders)
    }

    let model = config.model
    if (config.provider === 'volcengine' && config.endpointId) {
      model = config.endpointId
    }

    const wireApi = this.resolveOpenAIWireApi(config, provider, baseUrl)
    const reasoningEffort = this.resolveReasoningEffort(config, provider)
    const repairedMessages = this.repairOpenAIToolMessageHistory(session.messages) as unknown as ChatMessage[]
    if (wireApi === 'responses') {
      const url = `${baseUrl}/responses`
      log(`POST ${url}, model=${model}, wireApi=responses, stream=false`)
      const reqBody: Record<string, unknown> = {
        model,
        instructions: session.systemPrompt,
        input: this.serializeMessagesForResponses(repairedMessages),
        stream: false,
      }
      if (reasoningEffort) {
        reqBody.reasoning = { effort: reasoningEffort }
      }
      const resp = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        signal,
      }, signal, 'openai simple responses')

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '')
        throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
      }

      return this.extractResponsesText(await parseJsonOrEventStreamResponse(resp))
    }

    const messages = [
      { role: 'system' as const, content: session.systemPrompt },
      ...this.serializeMessages(repairedMessages, 'openai')
    ]

    const url = `${baseUrl}/chat/completions`
    log(`POST ${url}, model=${model}, stream=false, kimi=${isKimi} (simple)`)

    const reqBody: Record<string, unknown> = { model, messages }

    if (isKimi && enableKimiWebSearch) {
      reqBody.tools = [{
        type: 'builtin_function',
        function: { name: '$web_search' }
      }]
    }

    const resp = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
      signal,
    }, signal, 'openai simple')

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
    }

    const json = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>
    }

    return json.choices?.[0]?.message?.content || ''
  }

  private async callOpenAIWithTextToolBridge(
    session: DirectChatSession,
    config: AIModelConfig,
    baseUrl: string,
    provider: ReturnType<typeof getProviderDef>,
    signal: AbortSignal,
    policy?: ToolPolicy,
  ): Promise<APIResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    const authHeader = provider?.authHeader || 'Authorization'
    const authPrefix = provider?.authPrefix ?? 'Bearer '
    headers[authHeader] = `${authPrefix}${config.apiKey}`

    if (provider?.extraHeaders) {
      Object.assign(headers, provider.extraHeaders)
    }

    let model = config.model
    if (config.provider === 'volcengine' && config.endpointId) {
      model = config.endpointId
    }

    const wireApi = this.resolveOpenAIWireApi(config, provider, baseUrl)
    const reasoningEffort = this.resolveReasoningEffort(config, provider)
    const systemPrompt = `${session.systemPrompt}

${this.buildTextToolBridgeSystemPrompt(policy)}`
    const repairedMessages = this.repairOpenAIToolMessageHistory(session.messages) as unknown as ChatMessage[]

    if (wireApi === 'responses') {
      const url = `${baseUrl}/responses`
      log(`POST ${url}, model=${model}, tool bridge=text, wireApi=responses`)
      const reqBody: Record<string, unknown> = {
        model,
        instructions: systemPrompt,
        input: this.serializeMessagesForResponses(repairedMessages),
        stream: false,
      }
      if (reasoningEffort) {
        reqBody.reasoning = { effort: reasoningEffort }
      }

      const resp = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        signal,
      }, signal, 'openai text tool bridge responses')

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '')
        throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
      }

      const json = await parseJsonOrEventStreamResponse(resp) as Record<string, unknown>
      return this.toTextToolBridgeResponse(
        this.extractResponsesText(json),
        (json as { reasoning?: unknown }).reasoning,
        typeof json.id === 'string' ? json.id : undefined,
      )
    }

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...this.serializeMessages(repairedMessages, 'openai'),
    ]

    const url = `${baseUrl}/chat/completions`
    log(`POST ${url}, model=${model}, tool bridge=text`)

    const reqBody: Record<string, unknown> = { model, messages }
    const resp = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
      signal,
    }, signal, 'openai text tool bridge')

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
    }

    const json = await resp.json() as {
      choices?: Array<{
        message?: {
          content?: string
          reasoning_content?: unknown
        }
      }>
    }
    const choice = json.choices?.[0]
    return this.toTextToolBridgeResponse(
      this.extractOpenAIMessageText(choice?.message?.content),
      choice?.message?.reasoning_content,
    )
  }

  // ── OpenAI: with tools ────────────────────────────────────────────
  private async callOpenAIWithTools(
    session: DirectChatSession,
    config: AIModelConfig,
    baseUrl: string,
    provider: ReturnType<typeof getProviderDef>,
    signal: AbortSignal,
    policy?: ToolPolicy,
  ): Promise<APIResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    const isKimiCodingBase = baseUrl.replace(/\/+$/, '').includes('api.kimi.com/coding')

    const authHeader = provider?.authHeader || 'Authorization'
    const authPrefix = provider?.authPrefix ?? 'Bearer '
    headers[authHeader] = `${authPrefix}${config.apiKey}`

    if (provider?.extraHeaders) {
      Object.assign(headers, provider.extraHeaders)
    }
    if (isKimiCodingBase) {
      headers['Authorization'] = `Bearer ${config.apiKey}`
      headers['x-api-key'] = config.apiKey
      headers['User-Agent'] = this.getKimiCodingUserAgent()
    }

    let model = config.model
    if (config.provider === 'volcengine' && config.endpointId) {
      model = config.endpointId
    }

    const openAIBase = isKimiCodingBase ? this.resolveKimiCodingV1Base(baseUrl) : baseUrl
    const wireApi = this.resolveOpenAIWireApi(config, provider, openAIBase)
    const reasoningEffort = this.resolveReasoningEffort(config, provider)
    const timeoutMs = resolveApiRequestTimeoutMs(policy)
    const tools = this.getPolicyOpenAITools(policy)
    const repairedMessages = this.repairOpenAIToolMessageHistory(session.messages) as unknown as ChatMessage[]
    if (policy?.forceDocumentTool) {
      log(`forceDocumentTool openai tools=${this.collectToolNames(tools, 'openai').join(',')}`)
    }
    if (policy?.forceDesignTool) {
      log(`forceDesignTool openai tools=${this.collectToolNames(tools, 'openai').join(',')}`)
    }

    if (this.shouldUseTextToolBridge(session, config)) {
      session.preferTextToolBridge = true
      log(`OpenAI tool transport fallback engaged before request, provider=${config.provider}, baseUrl=${openAIBase}`)
      return this.callOpenAIWithTextToolBridge(session, config, openAIBase, provider, signal, policy)
    }

    if (wireApi === 'responses') {
      const continuation = this.getResponsesContinuationState(session)
      const url = `${openAIBase}/responses`
      log(`POST ${url}, model=${model}, with tools, wireApi=responses${policy?.forceDocumentTool ? ' (force document)' : policy?.forceDesignTool ? ' (force design)' : ''}, timeout=${timeoutMs}`)
      const reqBody: Record<string, unknown> = {
        model,
        tools: this.convertOpenAIToolsToResponses(tools),
        stream: false,
      }
      if (reasoningEffort) {
        reqBody.reasoning = { effort: reasoningEffort }
      }
      if (continuation) {
        reqBody.previous_response_id = continuation.previousResponseId
        reqBody.input = continuation.input
      } else {
        reqBody.instructions = session.systemPrompt
        reqBody.input = this.serializeMessagesForResponses(repairedMessages)
      }

      const resp = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        signal,
      }, signal, 'openai responses tools', timeoutMs)

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '')
        throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
      }

      const json = await parseJsonOrEventStreamResponse(resp) as Record<string, unknown>
      const nativeResponse: APIResponse = {
        text: this.extractResponsesText(json),
        toolCalls: this.extractResponsesToolCalls(json),
        stopReason: String(json.status || 'completed'),
        reasoningContent: (json as { reasoning?: unknown }).reasoning,
        providerResponseId: typeof json.id === 'string' ? json.id : undefined,
        toolTransport: 'native',
      }
      if (nativeResponse.toolCalls.length === 0 && this.shouldRetryWithTextToolBridge(nativeResponse.text, session, config)) {
        session.preferTextToolBridge = true
        log(`OpenAI native tools unavailable after responses reply; retrying with text bridge, provider=${config.provider}, baseUrl=${openAIBase}`)
        return this.callOpenAIWithTextToolBridge(session, config, openAIBase, provider, signal, policy)
      }
      return nativeResponse
    }

    const messages = [
      { role: 'system' as const, content: session.systemPrompt },
      ...this.serializeMessages(repairedMessages, 'openai')
    ]

    const url = `${openAIBase}/chat/completions`
    log(`POST ${url}, model=${model}, with tools${policy?.forceDocumentTool ? ' (force document)' : policy?.forceDesignTool ? ' (force design)' : ''}, timeout=${timeoutMs}`)

    const reqBody: Record<string, unknown> = {
      model,
      messages,
      tools,
    }
    // 不再强制工具调用，改为让 LLM 自主判断
    // if ((policy?.forceDocumentTool || policy?.forceDesignTool) && !isKimiCodingBase) {
    //   reqBody.tool_choice = 'required'
    // }

    let resp = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
      signal,
    }, signal, 'openai tools', timeoutMs)

    // 移除了 tool_choice 相关的错误处理，因为我们不再强制工具调用

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
    }

    const json = await resp.json() as {
      choices?: Array<{
        message?: {
          content?: string
          reasoning_content?: unknown
          tool_calls?: Array<{
            id: string
            function?: { name?: string; arguments?: string }
          }>
        }
        finish_reason?: string
      }>
    }
    const choice = json.choices?.[0]
    const text = this.extractOpenAIMessageText(choice?.message?.content)
    const reasoningContent = choice?.message?.reasoning_content
    const toolCalls: ToolCall[] = (choice?.message?.tool_calls || []).map(tc => ({
      id: tc.id,
      name: tc.function?.name || '',
      input: (() => {
        try { return JSON.parse(tc.function?.arguments || '{}') } catch { return {} }
      })(),
    }))
    log(`OpenAI response: text=${text.length}chars, toolCalls=${toolCalls.length}, reasoning=${reasoningContent !== undefined}, finish=${choice?.finish_reason}`)
    const nativeResponse: APIResponse = {
      text,
      toolCalls,
      stopReason: choice?.finish_reason || 'stop',
      reasoningContent,
      toolTransport: 'native',
    }
    if (nativeResponse.toolCalls.length === 0 && this.shouldRetryWithTextToolBridge(nativeResponse.text, session, config)) {
      session.preferTextToolBridge = true
      log(`OpenAI native tools unavailable after chat completion reply; retrying with text bridge, provider=${config.provider}, baseUrl=${openAIBase}`)
      return this.callOpenAIWithTextToolBridge(session, config, openAIBase, provider, signal, policy)
    }
    return nativeResponse
  }

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

  private shouldRetryWithVideoFallback(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error)
    return msg.includes('HTTP 400')
  }

  private async getFfmpegPath(): Promise<string> {
    if (this.cachedFfmpegPath && existsSync(this.cachedFfmpegPath)) {
      return this.cachedFfmpegPath
    }

    try {
      const { stdout } = await execFileAsync(getWhichCommand(), ['ffmpeg'])
      // Windows 'where' may return multiple lines, take the first one
      const candidate = stdout.trim().split('\n')[0]
      if (candidate && existsSync(candidate)) {
        this.cachedFfmpegPath = candidate
        return candidate
      }
    } catch {
      // Ignore and continue to common paths fallback.
    }

    const commonPaths = [
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      '/usr/bin/ffmpeg',
    ]
    for (const candidate of commonPaths) {
      if (existsSync(candidate)) {
        this.cachedFfmpegPath = candidate
        return candidate
      }
    }

    throw new Error('ffmpeg not found')
  }

  private async buildVideoFrameFallbackMessages(messages: ChatMessage[]): Promise<ChatMessage[]> {
    const fallbackMessages: ChatMessage[] = []

    for (const message of messages) {
      if (!Array.isArray(message.content)) {
        fallbackMessages.push(message)
        continue
      }

      const convertedBlocks: Array<Record<string, unknown>> = []
      for (const block of message.content) {
        if (block?.type !== 'video') {
          convertedBlocks.push(block)
          continue
        }

        const source = block.source as { data?: string; media_type?: string } | undefined
        const data = typeof source?.data === 'string' ? source.data : ''
        const mediaType = typeof source?.media_type === 'string' ? source.media_type : 'video/mp4'
        if (!data) {
          convertedBlocks.push({ type: 'text', text: '[视频附件存在，但无法读取二进制内容。]' })
          continue
        }

        const frameImages = await this.extractFramesFromVideoBase64(data, mediaType)
        if (frameImages.length === 0) {
          convertedBlocks.push({ type: 'text', text: '[当前接口暂不可直接解析视频块，自动提帧失败。请提供视频关键信息或简述需要分析的片段。]' })
          continue
        }

        convertedBlocks.push({ type: 'text', text: `[已自动提取 ${frameImages.length} 帧供模型理解视频内容]` })
        for (const frameBase64 of frameImages) {
          convertedBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: frameBase64,
            },
          })
        }
      }

      fallbackMessages.push({ ...message, content: convertedBlocks })
    }

    return fallbackMessages
  }

  private async extractFramesFromVideoBase64(videoBase64: string, mediaType: string): Promise<string[]> {
    const ffmpeg = await this.getFfmpegPath().catch(() => null)
    if (!ffmpeg) {
      log('ffmpeg not found, cannot extract frames for video fallback')
      return []
    }

    const inputExt = this.extensionFromVideoMediaType(mediaType)
    const tempDir = mkdtempSync(join(tmpdir(), 'ready-video-fallback-'))
    const inputPath = join(tempDir, `input.${inputExt}`)
    const framePattern = join(tempDir, 'frame-%02d.jpg')
    try {
      const buffer = Buffer.from(videoBase64, 'base64')
      writeFileSync(inputPath, buffer)
      await execFileAsync(ffmpeg, [
        '-y',
        '-i', inputPath,
        '-vf', 'fps=1,scale=960:-2',
        '-frames:v', '3',
        framePattern,
      ], { timeout: 120_000 })

      const frames: string[] = []
      for (let i = 1; i <= 3; i++) {
        const framePath = join(tempDir, `frame-0${i}.jpg`)
        if (!existsSync(framePath)) continue
        const frame = readFileSync(framePath)
        frames.push(frame.toString('base64'))
      }
      return frames
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      log(`extractFramesFromVideoBase64 failed: ${msg}`)
      return []
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }

  private extensionFromVideoMediaType(mediaType: string): string {
    const value = mediaType.toLowerCase()
    if (value.includes('webm')) return 'webm'
    if (value.includes('quicktime')) return 'mov'
    if (value.includes('x-matroska') || value.includes('mkv')) return 'mkv'
    if (value.includes('x-msvideo') || value.includes('avi')) return 'avi'
    if (value.includes('x-m4v') || value.includes('m4v')) return 'm4v'
    return 'mp4'
  }

  cleanup(): void {
    for (const [name] of this.sessions) {
      this.stopGeneration(name)
    }
    this.sessions.clear()
  }
}
