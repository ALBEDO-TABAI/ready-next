/**
 * Browser tool definitions + executor for AI tool calling.
 * Provides browser control tools in both Anthropic and OpenAI formats.
 */

import { BrowserController } from '../browser-engine/ipc-handler'
import { appendFileSync } from 'fs'
import { access, mkdir, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { constants as fsConstants, existsSync, statSync } from 'fs'
import { basename, extname, join } from 'path'
import { homedir } from 'os'
import { analyzeViewportWithVision } from './browser-vision'
import { domainsLikelyMatch, findRecentBrowserAction, rememberBrowserAction } from '../agent-control/session-continuity'
import { AgentRepository } from '../repositories/agent-repository'
import { getLogPath } from '../../utils/platform'
import { buildToolParamSchema, normalizeAnthropicToolSchema, normalizeOpenAIToolSchema, type ToolParamSchemaSpec } from './tool-schema'

const LOG = getLogPath('ready-tools.log')
function log(msg: string) {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`) } catch { /* */ }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function activePageLikelyMatchesTarget(activeUrl: string | undefined, target: string): boolean {
  if (!activeUrl || !target) return false
  try {
    const active = new URL(activeUrl)
    const next = new URL(target)
    if (active.origin === next.origin && active.pathname === next.pathname && active.search === next.search) return true
    return domainsLikelyMatch(activeUrl, target)
  } catch {
    return String(activeUrl).trim().toLowerCase() === String(target).trim().toLowerCase()
  }
}

// ── Tool Definitions ────────────────────────────────────────────────

type ToolParam = ToolParamSchemaSpec

interface ToolDef {
  name: string
  description: string
  params: ToolParam[]
}

type SearchEngine = 'auto' | 'google' | 'duckduckgo' | 'bing' | 'baidu'

const BROWSER_TOOLS: ToolDef[] = [
  {
    name: 'browser_navigate',
    description: '导航到指定 URL。如果没有打开的标签页，会自动创建一个新标签页。',
    params: [
      { name: 'url', type: 'string', description: '要导航到的完整 URL (http/https)', required: true },
    ]
  },
  {
    name: 'browser_search',
    description: '使用搜索引擎搜索关键词。默认自动选择引擎并在失败时回退（duckduckgo/google/bing/baidu）。',
    params: [
      { name: 'query', type: 'string', description: '搜索关键词', required: true },
      { name: 'engine', type: 'string', description: '搜索引擎：auto/google/duckduckgo/bing/baidu，默认 auto', required: false, enum: ['auto', 'google', 'duckduckgo', 'bing', 'baidu'] },
    ]
  },
  {
    name: 'browser_get_tabs',
    description: '列出当前所有打开的浏览器标签页，包括 URL、标题和活跃状态。',
    params: []
  },
  {
    name: 'browser_read_page',
    description: '读取当前页面的纯文本内容（document.body.innerText），用于理解页面信息。',
    params: [
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
  {
    name: 'browser_click',
    description: '点击页面上匹配 CSS 选择器的第一个元素。',
    params: [
      { name: 'selector', type: 'string', description: 'CSS 选择器，例如 "button.submit" 或 "#search-btn"', required: true },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
  {
    name: 'browser_click_text',
    description: '按可见文本智能点击元素（按钮/链接/可点击项），比纯 selector 更稳健。',
    params: [
      { name: 'text', type: 'string', description: '要点击的可见文本（支持部分匹配）', required: true },
      { name: 'exact', type: 'boolean', description: '是否精确匹配文本，默认 false', required: false },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
  {
    name: 'browser_type',
    description: '在页面上匹配 CSS 选择器的输入框中输入文字。',
    params: [
      { name: 'selector', type: 'string', description: 'CSS 选择器，定位输入框元素', required: true },
      { name: 'text', type: 'string', description: '要输入的文字', required: true },
      { name: 'clear_first', type: 'boolean', description: '是否先清空输入框（默认 true）', required: false },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
  {
    name: 'browser_type_smart',
    description: '按输入框标签/placeholder/name/id 智能定位并输入文本；会优先复用当前已聚焦的可编辑输入区，避免把内容输到无关控件里，可选择回车提交。',
    params: [
      { name: 'target', type: 'string', description: '输入框目标，如 "搜索框" / "邮箱"', required: true },
      { name: 'text', type: 'string', description: '输入文本', required: true },
      { name: 'submit', type: 'boolean', description: '输入后是否回车提交，默认 false', required: false },
      { name: 'clear_first', type: 'boolean', description: '是否先清空，默认 true', required: false },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
  {
    name: 'browser_compose_message',
    description: '在聊天/搜索类页面智能定位消息输入框并输入内容，可选自动发送。',
    params: [
      { name: 'text', type: 'string', description: '要输入的内容', required: true },
      { name: 'target', type: 'string', description: '可选目标描述，如“搜索框”“消息输入框”', required: false },
      { name: 'submit', type: 'boolean', description: '输入后是否自动发送，默认 true', required: false },
      { name: 'clear_first', type: 'boolean', description: '是否先清空输入框，默认 true', required: false },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
  {
    name: 'browser_capture_viewport',
    description: '捕获浏览器截图（默认视口），用于坐标点击前后校验。',
    params: [
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
      { name: 'mode', type: 'string', description: '截图模式：viewport/clip/full_page，默认 viewport', required: false, enum: ['viewport', 'clip', 'full_page'] },
      { name: 'clip', type: 'object', description: '可选裁剪区域：{x,y,width,height}（像素）', required: false },
    ]
  },
  {
    name: 'browser_probe_workflow_state',
    description: '批量采集页面身份、截图、上传状态、prompt 状态、DOM 状态与关键动作候选，用于上传/填写/提交工作流，减少重复截图和 DOM 扫描。',
    params: [
      { name: 'prompt', type: 'string', description: '可选：用于校验 prompt 是否已经写入输入区', required: false },
      { name: 'attachment_name', type: 'string', description: '可选：用于校验页面是否已显示该附件', required: false },
      { name: 'include_candidates', type: 'boolean', description: '是否返回 upload/input/send 候选，默认 true', required: false },
      { name: 'vision_action', type: 'string', description: '可选：当指定动作为 upload/input/send 且 DOM 候选不足时，顺带返回视觉候选', required: false, enum: ['upload', 'input', 'send'] },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
  {
    name: 'browser_locate_action_targets',
    description: '定位当前页面中与上传/发送/关闭/返回相关的候选控件，返回结构化候选列表；当 action=send 时会优先关联当前焦点输入区附近的控件，减少误点无关按钮。',
    params: [
      { name: 'action', type: 'string', description: '动作类型：upload/send/close/back', required: true, enum: ['upload', 'send', 'close', 'back'] },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
  {
    name: 'browser_locate_input_targets',
    description: '定位当前页面可能用于输入提示词/消息/描述的输入区域，返回结构化候选列表；会额外给出当前已聚焦输入区 active_target，以及与该输入区相邻的发送/生成控件 nearby_send_targets，便于先确认焦点再提交。',
    params: [
      { name: 'target', type: 'string', description: '可选目标描述，如“提示词输入框”“消息输入框”', required: false },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
  {
    name: 'browser_analyze_viewport',
    description: '当 DOM/A11y 候选不足时，使用当前模型的视觉能力分析截图并返回结构化控件候选。',
    params: [
      { name: 'action', type: 'string', description: '动作类型：upload/send/close/back/input', required: true, enum: ['upload', 'send', 'close', 'back', 'input'] },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
      { name: 'include_dom_candidates', type: 'boolean', description: '是否附带 DOM 候选作为视觉分析参考，默认 true', required: false },
    ]
  },
  {
    name: 'browser_list_upload_targets',
    description: '枚举当前页面可能的文件上传入口和 file input，适合上传前探测。',
    params: [
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
  {
    name: 'browser_upload_scope_attachment',
    description: '把当前会话中的附件上传到页面 file input。可按 attachmentId、文件名或 latest=true 自动选择。',
    params: [
      { name: 'attachment_id', type: 'string', description: '当前会话中的附件 ID', required: false },
      { name: 'attachment_name', type: 'string', description: '当前会话中的附件文件名或其片段', required: false },
      { name: 'latest', type: 'boolean', description: '是否优先使用当前会话最新附件，默认 true', required: false },
      { name: 'selector', type: 'string', description: '可选：直接定位 file input 的 CSS 选择器', required: false },
      { name: 'target', type: 'string', description: '可选：上传入口目标描述，如“上传图片”', required: false },
      { name: 'x', type: 'number', description: '可选：归一化横坐标 0-999', required: false },
      { name: 'y', type: 'number', description: '可选：归一化纵坐标 0-999', required: false },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
  {
    name: 'browser_collect_images',
    description: '收集当前页面可见图片候选（URL/尺寸/alt），适合后续批量下载。',
    params: [
      { name: 'keyword', type: 'string', description: '可选关键词，按图片 URL/alt/title 过滤', required: false },
      { name: 'limit', type: 'number', description: '最多返回条数，默认 20，最大 60', required: false },
      { name: 'min_width', type: 'number', description: '最小宽度像素过滤，默认 120', required: false },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
  {
    name: 'browser_download_urls',
    description: '批量下载 URL 到本地目录（默认 ~/Documents），可用于一次性保存多张图片。',
    params: [
      { name: 'urls', type: 'array', description: '要下载的 URL 数组（http/https）', required: true, items: { type: 'string' } },
      { name: 'directory', type: 'string', description: '目标目录，默认 ~/Documents', required: false },
      { name: 'filename_prefix', type: 'string', description: '文件名前缀（可选）', required: false },
      { name: 'overwrite', type: 'boolean', description: '同名是否覆盖，默认 false', required: false },
      { name: 'tab_id', type: 'string', description: '可选标签页 ID（用于带 Referer 下载）', required: false },
    ]
  },
  {
    name: 'browser_click_at',
    description: '按归一化坐标（0-999）执行低层点击，适用于复杂页面和 shadow/editor 场景。',
    params: [
      { name: 'x', type: 'number', description: '归一化横坐标 0-999', required: true },
      { name: 'y', type: 'number', description: '归一化纵坐标 0-999', required: true },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
  {
    name: 'browser_type_at',
    description: '按归一化坐标聚焦输入，并用 CDP 低层键盘输入文本，可选回车发送。',
    params: [
      { name: 'x', type: 'number', description: '归一化横坐标 0-999', required: true },
      { name: 'y', type: 'number', description: '归一化纵坐标 0-999', required: true },
      { name: 'text', type: 'string', description: '要输入的文本', required: true },
      { name: 'press_enter', type: 'boolean', description: '输入后按 Enter，默认 true', required: false },
      { name: 'use_shift_enter_for_newline', type: 'boolean', description: '多行文本是否使用 Shift+Enter 断行', required: false },
      { name: 'clear_before_typing', type: 'boolean', description: '输入前是否清空内容（全选+删除）', required: false },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
  {
    name: 'browser_scroll_at',
    description: '按坐标执行低层滚动（鼠标滚轮）。',
    params: [
      { name: 'x', type: 'number', description: '归一化横坐标 0-999，默认 500', required: false },
      { name: 'y', type: 'number', description: '归一化纵坐标 0-999，默认 500', required: false },
      { name: 'direction', type: 'string', description: '滚动方向 up/down/left/right', required: true, enum: ['up', 'down', 'left', 'right'] },
      { name: 'magnitude', type: 'number', description: '滚动幅度，默认 800', required: false },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
  {
    name: 'browser_send_keys',
    description: '发送低层按键事件（例如 Enter、Escape、Tab）。',
    params: [
      { name: 'key', type: 'string', description: '键名，如 Enter/Escape/Tab/a', required: true },
      { name: 'modifiers', type: 'array', description: '可选组合键数组：ctrl/shift/alt/meta', required: false, items: { type: 'string' } },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
  {
    name: 'browser_ask_user_takeover',
    description: '当页面出现登录/验证码等人工步骤时请求用户接管。',
    params: [
      { name: 'call_to_action', type: 'string', description: '给用户的动作提示', required: true },
      { name: 'details', type: 'string', description: '补充说明', required: false },
      { name: 'timeout_sec', type: 'number', description: '等待超时秒数，默认 300', required: false },
    ]
  },
  {
    name: 'browser_query_gemini',
    description: '在 Gemini 页面自动执行“输入并发送”，并检测响应；失败时自动回退到坐标输入。',
    params: [
      { name: 'text', type: 'string', description: '提问内容', required: true },
      { name: 'tab_id', type: 'string', description: '可选标签页 ID', required: false },
      { name: 'wait_response_ms', type: 'number', description: '等待响应时间，默认 35000ms', required: false },
    ]
  },
  {
    name: 'browser_wait',
    description: '等待页面进入可交互状态，可选等待 selector 出现。',
    params: [
      { name: 'timeout_ms', type: 'number', description: '超时时间，默认 8000ms', required: false },
      { name: 'selector', type: 'string', description: '可选：等待该 selector 出现', required: false },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
  {
    name: 'browser_run_workflow',
    description: '批量执行多步骤浏览器任务（导航/搜索/点击/坐标点击/输入/坐标输入/滚动/按键/compose/等待/读取），适合复杂任务减少来回调用。',
    params: [
      { name: 'steps', type: 'array', description: '步骤数组，每项形如 { action, ... }', required: true, items: { type: 'object', additionalProperties: true } },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
      { name: 'continue_on_error', type: 'boolean', description: '遇错是否继续执行后续步骤，默认 false', required: false },
    ]
  },
  {
    name: 'browser_execute_js',
    description: '在页面中执行任意 JavaScript 代码并返回结果。代码运行在页面沙箱中，与 Node.js 隔离。',
    params: [
      { name: 'code', type: 'string', description: '要执行的 JavaScript 代码', required: true },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
  {
    name: 'browser_go_back',
    description: '在当前标签页中后退一页。',
    params: [
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ]
  },
]

// ── Format converters ───────────────────────────────────────────────

export function getAnthropicTools(): Array<Record<string, unknown>> {
  return BROWSER_TOOLS.map(tool => normalizeAnthropicToolSchema({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map(p => [p.name, buildToolParamSchema(p)])),
      required: tool.params.filter(p => p.required).map(p => p.name),
    }
  }))
}

export function getOpenAITools(): Array<Record<string, unknown>> {
  return BROWSER_TOOLS.map(tool => normalizeOpenAIToolSchema({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(tool.params.map(p => [p.name, buildToolParamSchema(p)])),
        required: tool.params.filter(p => p.required).map(p => p.name),
      }
    }
  }))
}

// ── Browser Tool Executor ───────────────────────────────────────────

const MAX_RESULT_LENGTH = 20_000
const BROWSER_V2_WAIT_AFTER_NAV_MS = 250
const BROWSER_V2_STOP_LOADING_TIMEOUT_MS = 15_000
const BROWSER_V3_ACTION_SETTLE_MS = 220
const TOOL_CONTROLLER_ID = 'primary-browser-controller'

const screenshotCache = new Map<string, { base64: string; width: number; height: number; createdAt: number }>()
const SCREENSHOT_CACHE_MAX = 30

function resolveToolContextMeta(
  controller: BrowserController,
  tabId: string | null,
): { controllerId: string; tabRole: 'current' | 'owned' | 'required' | 'background' | 'unknown' } {
  const tabs = controller.getTabList()
  const resolved = tabId
    ? tabs.find((tab) => tab.id === tabId) || tabs.find((tab) => tab.active)
    : tabs.find((tab) => tab.active)
  if (!resolved) {
    return { controllerId: TOOL_CONTROLLER_ID, tabRole: 'unknown' }
  }
  if (resolved.required) {
    return { controllerId: TOOL_CONTROLLER_ID, tabRole: 'required' }
  }
  if (resolved.owner === 'agent') {
    return { controllerId: TOOL_CONTROLLER_ID, tabRole: 'owned' }
  }
  if (resolved.active) {
    return { controllerId: TOOL_CONTROLLER_ID, tabRole: 'current' }
  }
  return { controllerId: TOOL_CONTROLLER_ID, tabRole: 'background' }
}

function truncate(s: string, max = MAX_RESULT_LENGTH): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n... (truncated, ${s.length} total chars)`
}

function searchUrl(engine: SearchEngine, query: string): string {
  const q = encodeURIComponent(query)
  switch (engine) {
    case 'google':
      return `https://www.google.com/search?q=${q}`
    case 'duckduckgo':
      return `https://duckduckgo.com/?q=${q}`
    case 'bing':
      return `https://www.bing.com/search?q=${q}`
    case 'baidu':
      return `https://www.baidu.com/s?wd=${q}`
    default:
      return `https://duckduckgo.com/?q=${q}`
  }
}

function expandHomePath(input: string): string {
  const raw = String(input || '').trim()
  if (!raw) return join(homedir(), 'Documents')
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  return raw
}

function sanitizeFilename(input: string, fallback = 'download'): string {
  const cleaned = String(input || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  if (!cleaned) return fallback
  return cleaned.slice(0, 120)
}

function extensionFromContentType(contentType: string): string {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim()
  const table: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'image/avif': '.avif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'application/pdf': '.pdf',
    'text/html': '.html',
    'text/plain': '.txt',
    'application/json': '.json',
  }
  return table[type] || ''
}

function inferFilenameParts(
  url: string,
  fallbackBase: string,
  contentType: string,
): { base: string; ext: string } {
  let pathnameBase = ''
  let pathnameExt = ''
  try {
    const parsed = new URL(url)
    pathnameBase = basename(parsed.pathname || '')
    pathnameExt = extname(pathnameBase || '')
  } catch {
    pathnameBase = ''
    pathnameExt = ''
  }

  const contentExt = extensionFromContentType(contentType)
  const ext = pathnameExt || contentExt || '.bin'
  const rawBase = pathnameBase ? pathnameBase.slice(0, pathnameBase.length - pathnameExt.length) : fallbackBase
  const base = sanitizeFilename(rawBase || fallbackBase, fallbackBase)
  return { base, ext: ext.startsWith('.') ? ext : `.${ext}` }
}

async function writeFileSmart(
  directory: string,
  base: string,
  ext: string,
  data: Buffer,
  overwrite: boolean,
): Promise<string> {
  const safeBase = sanitizeFilename(base, 'download')
  const safeExt = ext.startsWith('.') ? ext : `.${ext}`
  const defaultPath = join(directory, `${safeBase}${safeExt}`)

  if (overwrite) {
    await writeFile(defaultPath, data)
    return defaultPath
  }

  for (let i = 0; i < 200; i += 1) {
    const candidate = i === 0 ? defaultPath : join(directory, `${safeBase}-${i}${safeExt}`)
    try {
      await writeFile(candidate, data, { flag: 'wx' })
      return candidate
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'EEXIST') continue
      throw error
    }
  }

  throw new Error(`无法在目录中写入文件：${directory}`)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function createAbortError(): Error {
  const error = new Error('Operation aborted')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw createAbortError()
  }
}

async function sleepWithAbort(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return
  if (!signal) {
    await sleep(ms)
    return
  }
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(createAbortError())
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function clampNormalized(value: number, fallback = 500): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(999, Math.round(value)))
}

function normalizeErrorCode(error: unknown): string {
  const maybeCode = (error as { code?: string })?.code
  if (typeof maybeCode === 'string' && maybeCode.trim()) return maybeCode
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('No active tab')) return 'NO_ACTIVE_TAB'
  if (message.includes('Tab not found')) return 'TAB_NOT_FOUND'
  if (message.includes('Debugger attach failed')) return 'DEBUGGER_ATTACH_FAILED'
  return 'CDP_COMMAND_FAILED'
}

async function resolveCssPoint(
  controller: BrowserController,
  tabId: string | null,
  x: number,
  y: number,
): Promise<{ cssX: number; cssY: number; width: number; height: number; nx: number; ny: number }> {
  const nx = clampNormalized(x)
  const ny = clampNormalized(y)
  const mapped = await controller.normalizedToCss(tabId, nx, ny)
  return {
    cssX: mapped.x,
    cssY: mapped.y,
    width: mapped.width,
    height: mapped.height,
    nx,
    ny,
  }
}

function modifiersToMask(value: unknown): number {
  if (!value) return 0
  const input = Array.isArray(value) ? value : [value]
  let mask = 0
  for (const raw of input) {
    const token = String(raw || '').toLowerCase()
    if (token === 'alt' || token === 'option') mask |= 1
    if (token === 'ctrl' || token === 'control') mask |= 2
    if (token === 'meta' || token === 'cmd' || token === 'command') mask |= 4
    if (token === 'shift') mask |= 8
  }
  return mask
}

function keyToCode(key: string): string {
  if (!key) return ''
  if (key.length === 1) {
    const upper = key.toUpperCase()
    if (/^[A-Z]$/.test(upper)) return `Key${upper}`
    if (/^[0-9]$/.test(upper)) return `Digit${upper}`
  }
  const table: Record<string, string> = {
    enter: 'Enter',
    escape: 'Escape',
    esc: 'Escape',
    tab: 'Tab',
    backspace: 'Backspace',
    delete: 'Delete',
    space: 'Space',
    arrowup: 'ArrowUp',
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
  }
  const resolved = table[key.toLowerCase()]
  return resolved || key
}

function keyToVirtualCode(key: string): number {
  const normalized = key.toLowerCase()
  const table: Record<string, number> = {
    enter: 13,
    tab: 9,
    escape: 27,
    esc: 27,
    backspace: 8,
    delete: 46,
    arrowup: 38,
    arrowdown: 40,
    arrowleft: 37,
    arrowright: 39,
    home: 36,
    end: 35,
    pageup: 33,
    pagedown: 34,
    shift: 16,
    control: 17,
    ctrl: 17,
    alt: 18,
    meta: 91,
    cmd: 91,
    command: 91,
    space: 32,
  }
  if (table[normalized]) return table[normalized]
  if (key.length === 1) {
    const code = key.toUpperCase().charCodeAt(0)
    if (Number.isFinite(code)) return code
  }
  return 0
}

function normalizeKeyLabel(key: string): string {
  const normalized = key.toLowerCase()
  if (normalized === 'ctrl') return 'Control'
  if (normalized === 'cmd' || normalized === 'command') return 'Meta'
  if (normalized === 'esc') return 'Escape'
  if (key.length === 1) return key
  return key.charAt(0).toUpperCase() + key.slice(1)
}

async function dispatchClickAt(
  controller: BrowserController,
  tabId: string | null,
  x: number,
  y: number,
): Promise<{ nx: number; ny: number; cssX: number; cssY: number; width: number; height: number }> {
  const point = await resolveCssPoint(controller, tabId, x, y)
  await controller.dispatchMouse(tabId, { type: 'mouseMoved', x: point.cssX, y: point.cssY, button: 'none', buttons: 0 })
  await controller.dispatchMouse(tabId, { type: 'mousePressed', x: point.cssX, y: point.cssY, button: 'left', buttons: 1, clickCount: 1 })
  await controller.dispatchMouse(tabId, { type: 'mouseReleased', x: point.cssX, y: point.cssY, button: 'left', buttons: 0, clickCount: 1 })
  return point
}

async function sendKeyStroke(
  controller: BrowserController,
  tabId: string | null,
  key: string,
  modifiers?: unknown,
): Promise<void> {
  const keyLabel = normalizeKeyLabel(key)
  const code = keyToCode(key)
  const vk = keyToVirtualCode(keyLabel)
  const mask = modifiersToMask(modifiers)
  const text = keyLabel.length === 1 ? keyLabel : keyLabel.toLowerCase() === 'enter' ? '\r' : undefined

  const modifierTriples: Array<{ key: string; code: string; vk: number; bit: number }> = [
    { key: 'Alt', code: 'AltLeft', vk: 18, bit: 1 },
    { key: 'Control', code: 'ControlLeft', vk: 17, bit: 2 },
    { key: 'Meta', code: 'MetaLeft', vk: 91, bit: 4 },
    { key: 'Shift', code: 'ShiftLeft', vk: 16, bit: 8 },
  ]

  for (const modifier of modifierTriples) {
    if ((mask & modifier.bit) !== modifier.bit) continue
    await controller.dispatchKey(tabId, {
      type: 'keyDown',
      key: modifier.key,
      code: modifier.code,
      windowsVirtualKeyCode: modifier.vk,
      nativeVirtualKeyCode: modifier.vk,
      isKeypad: false,
    })
  }

  await controller.dispatchKey(tabId, {
    type: 'keyDown',
    key: keyLabel,
    code,
    windowsVirtualKeyCode: vk || undefined,
    nativeVirtualKeyCode: vk || undefined,
    text,
    modifiers: mask,
    isKeypad: false,
    unmodifiedText: text,
  })
  await controller.dispatchKey(tabId, {
    type: 'keyUp',
    key: keyLabel,
    code,
    windowsVirtualKeyCode: vk || undefined,
    nativeVirtualKeyCode: vk || undefined,
    modifiers: mask,
    isKeypad: false,
  })

  for (let i = modifierTriples.length - 1; i >= 0; i -= 1) {
    const modifier = modifierTriples[i]
    if ((mask & modifier.bit) !== modifier.bit) continue
    await controller.dispatchKey(tabId, {
      type: 'keyUp',
      key: modifier.key,
      code: modifier.code,
      windowsVirtualKeyCode: modifier.vk,
      nativeVirtualKeyCode: modifier.vk,
      isKeypad: false,
    })
  }
}

async function clearFocusedInput(controller: BrowserController, tabId: string | null): Promise<void> {
  const selectAllMask = process.platform === 'darwin' ? 4 : 2
  await controller.dispatchKey(tabId, {
    type: 'rawKeyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: selectAllMask,
  })
  await controller.dispatchKey(tabId, {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: selectAllMask,
  })
  await sendKeyStroke(controller, tabId, 'Backspace')
}

async function waitForLoadingStop(
  controller: BrowserController,
  tabId: string | null,
  timeoutMs = BROWSER_V2_STOP_LOADING_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    throwIfAborted(signal)
    try {
      const done = await controller.executeJS(
        tabId,
        `(() => (document.readyState === 'interactive' || document.readyState === 'complete'))()`,
      ) as boolean
      if (done) return true
    } catch {
      // ignore polling errors
    }
    await sleepWithAbort(200, signal)
  }
  return false
}

async function settleAfterAction(
  controller: BrowserController,
  tabId: string | null,
  signal?: AbortSignal,
): Promise<void> {
  await sleepWithAbort(BROWSER_V3_ACTION_SETTLE_MS, signal)
  await waitForLoadingStop(controller, tabId, 8_000, signal)
  await waitForReady(controller, tabId, 6_000, undefined, signal)
}

interface GeminiResponseProbe {
  responseDetected: boolean
  responseText: string
  loginRequired: boolean
  captchaRequired: boolean
  editableCount: number
  thinking: boolean
}

async function probeGeminiResponse(
  controller: BrowserController,
  tabId: string | null,
  userText: string,
): Promise<GeminiResponseProbe> {
  const userSnippet = userText.trim().replace(/\s+/g, ' ').slice(0, 24)
  const result = await controller.executeJS(
    tabId,
    `
      (() => {
        const text = (document.body?.innerText || '')
        const loginRequired = /登录|登入|Sign in|Log in|Choose an account/i.test(text)
        const captchaRequired = /captcha|验证|人机|I am not a robot/i.test(text)
        const selectors = [
          '[data-message-author-role="model"]',
          '[data-test-id*="model"]',
          '.model-response',
          'message-content',
        ]
        let responseText = ''
        const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
        const clean = (s) =>
          normalize(s)
            .replace(/^Gemini\\s*PRO?/i, '')
            .replace(/Gemini 是一款 AI 工具，其回答未必正确无误。?/g, '')
            .replace(/Pro\\s*$/g, '')
            .trim()
        for (const selector of selectors) {
          const nodes = Array.from(document.querySelectorAll(selector))
          for (let i = nodes.length - 1; i >= 0; i -= 1) {
            const t = clean(nodes[i].textContent || '')
            if (t.length > 20) {
              responseText = t.slice(0, 500)
              break
            }
          }
          if (responseText) break
        }
        const userSnippet = ${JSON.stringify(userSnippet)}
        if (!responseText) {
          const lines = text
            .split('\\n')
            .map((line) => clean(line))
            .filter((line) => line.length > 14)
            .filter((line) => !/需要我为你做些什么|制作图片|创作音乐|创作视频|给我的一天注入活力|帮我学习|随便写点什么/.test(line))
            .filter((line) => !userSnippet || !line.includes(userSnippet))
          const maybe = lines.slice(-8).join('\\n').trim()
          responseText = maybe.slice(0, 500)
        }
        const editableCount = document.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"],[role="combobox"]').length
        const thinking = /thinking|正在思考|思考中|生成中|generating|回答中|撰写中|loading/i.test(text)
        const cleanedResponse = clean(responseText)
        const userEcho = userSnippet && cleanedResponse.includes(userSnippet)
        const weakResponse = cleanedResponse.length < 40
        return {
          responseDetected: Boolean(cleanedResponse && !weakResponse && !thinking && !userEcho),
          responseText: cleanedResponse,
          loginRequired,
          captchaRequired,
          editableCount,
          thinking,
        }
      })()
    `,
  ) as GeminiResponseProbe

  return {
    responseDetected: Boolean(result?.responseDetected),
    responseText: String(result?.responseText || ''),
    loginRequired: Boolean(result?.loginRequired),
    captchaRequired: Boolean(result?.captchaRequired),
    editableCount: Number(result?.editableCount || 0),
    thinking: Boolean(result?.thinking),
  }
}

interface GeminiEditableCandidate {
  x: number
  y: number
  score: number
  reason: string
}

async function probeGeminiEditableCandidates(
  controller: BrowserController,
  tabId: string | null,
): Promise<GeminiEditableCandidate[]> {
  const result = await controller.executeJS(
    tabId,
    `
      (() => {
        const isVisible = (el) => {
          const rect = el.getBoundingClientRect()
          if (!rect || rect.width < 12 || rect.height < 12) return false
          const style = getComputedStyle(el)
          if (!style) return false
          return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0
        }
        const nodes = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"],[role="combobox"]'))
        const out = []
        for (const el of nodes) {
          if (!(el instanceof HTMLElement) || !isVisible(el)) continue
          const rect = el.getBoundingClientRect()
          const centerX = rect.left + rect.width / 2
          const centerY = rect.top + rect.height / 2
          let score = 10
          const meta = [
            el.getAttribute('placeholder') || '',
            el.getAttribute('aria-label') || '',
            el.getAttribute('name') || '',
            el.getAttribute('id') || '',
            el.getAttribute('data-testid') || '',
            el.getAttribute('role') || '',
          ].join(' ').toLowerCase()
          if (/gemini|chat|message|prompt|ask|输入|提问/.test(meta)) score += 80
          if (rect.width > window.innerWidth * 0.35) score += 18
          if (rect.bottom > window.innerHeight * 0.6) score += 14
          if (el.tagName.toLowerCase() === 'textarea') score += 20
          out.push({
            x: Math.max(0, Math.min(999, Math.round((centerX / Math.max(1, window.innerWidth)) * 999))),
            y: Math.max(0, Math.min(999, Math.round((centerY / Math.max(1, window.innerHeight)) * 999))),
            score,
            reason: meta.slice(0, 120) || el.tagName.toLowerCase(),
          })
        }
        return out.sort((a, b) => b.score - a.score).slice(0, 6)
      })()
    `,
  ) as GeminiEditableCandidate[]

  if (!Array.isArray(result)) return []
  return result
}

interface GeminiSubmissionProbe {
  inputHasText: boolean
  inputLength: number
  sendButtonEnabled: boolean
  userEchoDetected: boolean
  thinking: boolean
}

async function probeGeminiSubmissionState(
  controller: BrowserController,
  tabId: string | null,
  text: string,
): Promise<GeminiSubmissionProbe> {
  const previewToken = text.trim().replace(/\s+/g, ' ').slice(0, 22)
  const result = await controller.executeJS(
    tabId,
    `
      (() => {
        const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
        const getEditableText = (el) => {
          if (!el) return ''
          const tag = String(el.tagName || '').toLowerCase()
          if (tag === 'textarea' || tag === 'input') return String(el.value || '')
          return String(el.innerText || el.textContent || '')
        }
        const editables = Array.from(document.querySelectorAll('textarea,input,[contenteditable=\"true\"],[contenteditable=\"\"],[role=\"textbox\"],[role=\"combobox\"]'))
        let best = ''
        const active = document.activeElement
        if (active instanceof HTMLElement) {
          const activeRect = active.getBoundingClientRect()
          const activeStyle = window.getComputedStyle(active)
          const activeVisible =
            activeRect.width >= 20 &&
            activeRect.height >= 20 &&
            activeStyle &&
            activeStyle.display !== 'none' &&
            activeStyle.visibility !== 'hidden' &&
            Number(activeStyle.opacity || '1') > 0
          const activeTag = String(active.tagName || '').toLowerCase()
          const activeRole = (active.getAttribute('role') || '').toLowerCase()
          const activeEditable =
            activeVisible &&
            (activeTag === 'textarea' ||
              activeTag === 'input' ||
              active.isContentEditable ||
              activeRole === 'textbox' ||
              activeRole === 'combobox' ||
              activeRole === 'searchbox')
          if (activeEditable) {
            best = getEditableText(active)
          }
        }
        for (const el of editables) {
          if (!(el instanceof HTMLElement)) continue
          const rect = el.getBoundingClientRect()
          if (rect.width < 20 || rect.height < 20) continue
          const style = window.getComputedStyle(el)
          if (!style || style.display === 'none' || style.visibility === 'hidden') continue
          const value = getEditableText(el)
          if (value.length > best.length) best = value
        }
        const sendSelectors = [
          'button[aria-label*=\"send\" i]',
          'button[aria-label*=\"发送\" i]',
          'button[aria-label*=\"提交\" i]',
          'button[aria-label*=\"发布\" i]',
          'button[aria-label*=\"继续\" i]',
          'button[aria-label*=\"search\" i]',
          'button[aria-label*=\"回车\" i]',
          'button[aria-label*=\"ask\" i]',
          'button[aria-label*=\"发送消息\" i]',
          'button[data-testid*=\"send\" i]',
          'button[data-testid*=\"submit\" i]',
          'button[data-testid*=\"publish\" i]',
          'button[data-testid*=\"continue\" i]',
          '[role=\"button\"][aria-label*=\"send\" i]',
          '[role=\"button\"][aria-label*=\"发送\" i]',
          'button[title*=\"send\" i]',
          'button[title*=\"发送\" i]',
          'button[title*=\"提交\" i]',
          'button[title*=\"发布\" i]',
          'button[title*=\"继续\" i]',
          'button[mattooltip*=\"send\" i]',
        ]
        const sendButtons = sendSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        const sendButtonEnabled = sendButtons.some((node) => {
          if (!(node instanceof HTMLElement)) return false
          const ariaDisabled = (node.getAttribute('aria-disabled') || '').toLowerCase() === 'true'
          const disabled =
            (node instanceof HTMLButtonElement && node.disabled === true) ||
            node.hasAttribute('disabled')
          const style = window.getComputedStyle(node)
          const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0
          return visible && !ariaDisabled && !disabled
        })
        const userSelectors = [
          '[data-message-author-role=\"user\"]',
          '[data-author-role=\"user\"]',
          '[data-role=\"user\"]',
          '.message-user',
          '.user-message',
          '[class*=\"userMessage\"]',
          '[class*=\"chat-user\"]',
          '.user-query',
        ]
        const userNodes = userSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        const userEchoDetected = userNodes.some((node) => normalize(node.textContent || '').includes(${JSON.stringify(previewToken)}))
        const inputHasText = normalize(best).length > 0
        const bodyText = normalize(document.body?.innerText || '')
        const thinking = /thinking|正在思考|思考中|生成中|回答中|撰写中|responding|loading|写作中|处理中/.test(bodyText)
        return {
          inputHasText,
          inputLength: normalize(best).length,
          sendButtonEnabled,
          userEchoDetected,
          thinking,
        }
      })()
    `,
  ) as GeminiSubmissionProbe

  return {
    inputHasText: Boolean(result?.inputHasText),
    inputLength: Number(result?.inputLength || 0),
    sendButtonEnabled: Boolean(result?.sendButtonEnabled),
    userEchoDetected: Boolean(result?.userEchoDetected),
    thinking: Boolean(result?.thinking),
  }
}

function isSubmissionLikelyAccepted(probe: GeminiSubmissionProbe): boolean {
  if (probe.userEchoDetected) return true
  if (probe.thinking) return true
  if (!probe.inputHasText && !probe.sendButtonEnabled) return true
  if (probe.inputLength <= 2 && !probe.sendButtonEnabled) return true
  return false
}

async function clickGeminiSendButton(
  controller: BrowserController,
  tabId: string | null,
): Promise<{ clicked: boolean; reason: string }> {
  const result = await controller.executeJS(
    tabId,
    `
      (() => {
        const selectors = [
          'button[aria-label*=\"send\" i]',
          'button[aria-label*=\"发送\" i]',
          'button[aria-label*=\"提交\" i]',
          'button[aria-label*=\"发布\" i]',
          'button[aria-label*=\"继续\" i]',
          'button[aria-label*=\"search\" i]',
          'button[data-testid*=\"send\" i]',
          'button[data-testid*=\"submit\" i]',
          'button[data-testid*=\"publish\" i]',
          'button[data-testid*=\"continue\" i]',
          '[role=\"button\"][aria-label*=\"send\" i]',
          '[role=\"button\"][aria-label*=\"发送\" i]',
          '[role=\"button\"][aria-label*=\"提交\" i]',
          '[role=\"button\"][aria-label*=\"发布\" i]',
          '[role=\"button\"][aria-label*=\"继续\" i]',
          'button[mattooltip*=\"send\" i]',
          'button[title*=\"send\" i]',
          'button[title*=\"发送\" i]',
          'button[title*=\"提交\" i]',
          'button[title*=\"发布\" i]',
          'button[title*=\"继续\" i]',
          'input[type=\"submit\"]',
          'button',
          '[role=\"button\"]',
          '[tabindex]',
        ]
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const rect = el.getBoundingClientRect()
          if (rect.width < 8 || rect.height < 8) return false
          const style = getComputedStyle(el)
          if (!style) return false
          if (style.display === 'none' || style.visibility === 'hidden') return false
          if (Number(style.opacity || '1') <= 0) return false
          return true
        }
        const getActiveEditable = () => {
          const nodes = Array.from(document.querySelectorAll('textarea,input,[contenteditable=\"true\"],[contenteditable=\"\"],[role=\"textbox\"],[role=\"combobox\"],[role=\"searchbox\"]'))
          const active = document.activeElement
          if (active instanceof HTMLElement && visible(active)) {
            return active
          }
          let best = null
          let bestScore = -1
          for (const node of nodes) {
            if (!(node instanceof HTMLElement) || !visible(node)) continue
            const rect = node.getBoundingClientRect()
            let score = 0
            if (rect.bottom > window.innerHeight * 0.55) score += 8
            if (rect.width > window.innerWidth * 0.3) score += 6
            if (node.tagName.toLowerCase() === 'textarea') score += 4
            if (score > bestScore) {
              best = node
              bestScore = score
            }
          }
          return best
        }
        const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
          .filter((el) => visible(el))
          .filter((el) => {
            const element = el
            const ariaDisabled = (element.getAttribute('aria-disabled') || '').toLowerCase() === 'true'
            const disabled = element instanceof HTMLButtonElement && element.disabled
            return !ariaDisabled && !disabled
          })
        if (candidates.length === 0) {
          return { clicked: false, reason: 'send_button_not_found' }
        }
        const activeEditable = getActiveEditable()
        const activeRect = activeEditable instanceof HTMLElement ? activeEditable.getBoundingClientRect() : null
        const activeParent = activeEditable instanceof HTMLElement ? activeEditable.parentElement : null
        const activeGrandParent = activeParent?.parentElement || null
        let best = candidates[0]
        let bestScore = -1
        for (const el of candidates) {
          const rect = el.getBoundingClientRect()
          let score = 0
          if (rect.bottom > window.innerHeight * 0.5) score += 4
          if (rect.right > window.innerWidth * 0.5) score += 4
          if (rect.width <= 64 && rect.height <= 64) score += 3
          const meta = (
            (el.getAttribute('aria-label') || '') + ' ' +
            (el.getAttribute('title') || '') + ' ' +
            (el.getAttribute('data-testid') || '') + ' ' +
            (el.getAttribute('class') || '') + ' ' +
            (el.textContent || '')
          ).toLowerCase()
          if (/send|发送|提交|发布|继续|search|搜索|ask|生成|go/.test(meta)) score += 10
          if (/icon|arrow|submit/.test(meta)) score += 2
          if (activeRect) {
            const dx = Math.abs(rect.left - activeRect.right)
            const dy = Math.abs((rect.top + rect.height / 2) - (activeRect.top + activeRect.height / 2))
            if (dx <= 180) score += 8
            if (dy <= 120) score += 6
            if (rect.left >= activeRect.left && rect.top >= activeRect.top - 60) score += 5
            if (rect.bottom >= activeRect.top && rect.top <= activeRect.bottom + 120) score += 4
          }
          if (activeParent && activeParent.contains(el) && el !== activeEditable) score += 7
          if (activeGrandParent && activeGrandParent.contains(el) && el !== activeEditable) score += 3
          if (score > bestScore) {
            best = el
            bestScore = score
          }
        }
        best.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
        best.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
        if (typeof best.click === 'function') {
          best.click()
        } else {
          best.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
          best.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
          best.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        }
        return { clicked: true, reason: 'send_button_clicked' }
      })()
    `,
  ) as { clicked?: boolean; reason?: string }

  return {
    clicked: Boolean(result?.clicked),
    reason: String(result?.reason || 'unknown'),
  }
}

async function submitClosestFormOrContainer(
  controller: BrowserController,
  tabId: string | null,
): Promise<{ submitted: boolean; reason: string }> {
  const result = await controller.executeJS(
    tabId,
    `
      (() => {
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const rect = el.getBoundingClientRect()
          if (rect.width < 8 || rect.height < 8) return false
          const style = getComputedStyle(el)
          if (!style) return false
          if (style.display === 'none' || style.visibility === 'hidden') return false
          if (Number(style.opacity || '1') <= 0) return false
          return true
        }
        const editables = Array.from(document.querySelectorAll('textarea,input,[contenteditable=\"true\"],[contenteditable=\"\"],[role=\"textbox\"],[role=\"combobox\"],[role=\"searchbox\"]'))
        let active = document.activeElement instanceof HTMLElement && visible(document.activeElement)
          ? document.activeElement
          : null
        if (!active) {
          let best = null
          let bestScore = -1
          for (const node of editables) {
            if (!(node instanceof HTMLElement) || !visible(node)) continue
            const rect = node.getBoundingClientRect()
            let score = 0
            if (rect.bottom > window.innerHeight * 0.55) score += 8
            if (rect.width > window.innerWidth * 0.25) score += 5
            if (node.tagName.toLowerCase() === 'textarea') score += 4
            if (score > bestScore) {
              best = node
              bestScore = score
            }
          }
          active = best
        }
        if (!(active instanceof HTMLElement)) {
          return { submitted: false, reason: 'no_active_editable' }
        }
        const form = active.closest('form')
        if (form instanceof HTMLFormElement) {
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit()
          } else {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
          }
          return { submitted: true, reason: 'closest_form_submit' }
        }
        const containers = [
          active.parentElement,
          active.parentElement?.parentElement,
          active.closest('[role=\"group\"]'),
          active.closest('[role=\"dialog\"]'),
          active.closest('section'),
        ].filter(Boolean)
        const activeRect = active.getBoundingClientRect()
        for (const container of containers) {
          if (!(container instanceof HTMLElement)) continue
          const buttons = Array.from(container.querySelectorAll('button,[role=\"button\"],input[type=\"submit\"]'))
            .filter((node) => visible(node) && node !== active)
          let best = null
          let bestScore = -1
          for (const button of buttons) {
            if (!(button instanceof HTMLElement)) continue
            const rect = button.getBoundingClientRect()
            let score = 0
            const meta = (
              (button.getAttribute('aria-label') || '') + ' ' +
              (button.getAttribute('title') || '') + ' ' +
              (button.getAttribute('data-testid') || '') + ' ' +
              (button.getAttribute('class') || '') + ' ' +
              (button.textContent || '')
            ).toLowerCase()
            if (/send|发送|提交|发布|继续|search|搜索|ask|生成|go/.test(meta)) score += 10
            if (Math.abs((rect.top + rect.height / 2) - (activeRect.top + activeRect.height / 2)) <= 120) score += 5
            if (rect.left >= activeRect.left - 32) score += 4
            if (rect.right >= activeRect.right - 24) score += 3
            if (score > bestScore) {
              best = button
              bestScore = score
            }
          }
          if (best instanceof HTMLElement) {
            if (typeof best.click === 'function') {
              best.click()
            } else {
              best.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
              best.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
              best.dispatchEvent(new MouseEvent('click', { bubbles: true }))
            }
            return { submitted: true, reason: 'closest_container_button' }
          }
        }
        return { submitted: false, reason: 'no_form_or_container_submit' }
      })()
    `,
  ) as { submitted?: boolean; reason?: string }

  return {
    submitted: Boolean(result?.submitted),
    reason: String(result?.reason || 'unknown'),
  }
}

async function ensureGeminiSubmitted(
  controller: BrowserController,
  tabId: string | null,
  text: string,
  attempted: string[],
  signal?: AbortSignal,
): Promise<{ submitted: boolean; method: string; probe: GeminiSubmissionProbe }> {
  throwIfAborted(signal)
  let probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'already_submitted', probe }
  }

  attempted.push('submit-precheck-wait')
  await sleepWithAbort(320, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'already_submitted_pending', probe }
  }

  attempted.push('submit-enter')
  await sendKeyStroke(controller, tabId, 'Enter')
  await sleepWithAbort(160, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'enter', probe }
  }

  attempted.push('submit-meta-enter')
  await sendKeyStroke(controller, tabId, 'Enter', ['meta'])
  await sleepWithAbort(160, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'meta_enter', probe }
  }

  attempted.push('submit-ctrl-enter')
  await sendKeyStroke(controller, tabId, 'Enter', ['ctrl'])
  await sleepWithAbort(160, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'ctrl_enter', probe }
  }

  attempted.push('submit-closest-form')
  const formSubmitted = await submitClosestFormOrContainer(controller, tabId)
  if (formSubmitted.submitted) {
    await sleepWithAbort(180, signal)
    probe = await probeGeminiSubmissionState(controller, tabId, text)
    if (isSubmissionLikelyAccepted(probe)) {
      return { submitted: true, method: formSubmitted.reason, probe }
    }
  }

  attempted.push('submit-send-button')
  const clicked = await clickGeminiSendButton(controller, tabId)
  await sleepWithAbort(220, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (clicked.clicked && isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: clicked.reason, probe }
  }

  attempted.push('submit-bottom-right-click')
  try {
    await dispatchClickAt(controller, tabId, 945, 930)
    await sleepWithAbort(140, signal)
    await sendKeyStroke(controller, tabId, 'Enter')
  } catch {
    // ignore and keep probing
  }
  await sleepWithAbort(240, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'bottom_right_click_enter', probe }
  }

  attempted.push('submit-send-key-fallback')
  await sendKeyStroke(controller, tabId, 'Enter')
  await sleepWithAbort(180, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'send_key_fallback_enter', probe }
  }

  return { submitted: false, method: clicked.reason, probe }
}

function cacheScreenshot(base64: string, width: number, height: number): string {
  const id = `browser-shot-${randomUUID()}`
  screenshotCache.set(id, { base64, width, height, createdAt: Date.now() })
  if (screenshotCache.size > SCREENSHOT_CACHE_MAX) {
    const stale = Array.from(screenshotCache.entries())
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, screenshotCache.size - SCREENSHOT_CACHE_MAX)
    stale.forEach(([key]) => screenshotCache.delete(key))
  }
  return id
}

async function waitForReady(
  controller: BrowserController,
  tabId: string | null,
  timeoutMs = 8000,
  selector?: string,
  signal?: AbortSignal,
): Promise<{ ready: boolean; matchedSelector: boolean; elapsedMs: number }> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    throwIfAborted(signal)
    try {
      const state = await controller.executeJS(tabId, `
        (() => {
          const hasSelectorDeep = (selector) => {
            const queue = [document]
            const visited = new Set()
            while (queue.length) {
              const root = queue.shift()
              if (!root || visited.has(root)) continue
              visited.add(root)
              try {
                if (root.querySelector?.(selector)) return true
              } catch {
                // ignore invalid selector in a specific root
              }
              let nodes = []
              try {
                nodes = Array.from(root.querySelectorAll?.('*') || [])
              } catch {
                nodes = []
              }
              for (const node of nodes) {
                const shadow = node?.shadowRoot
                if (shadow && !visited.has(shadow)) queue.push(shadow)
              }
            }
            return false
          }
          const readyState = document.readyState || 'loading'
          const bodyTextLen = (document.body?.innerText || '').trim().length
          const matched = ${selector ? `hasSelectorDeep(${JSON.stringify(selector)})` : 'false'}
          return { readyState, bodyTextLen, matched }
        })()
      `) as { readyState?: string; bodyTextLen?: number; matched?: boolean }
      const readyState = state?.readyState || 'loading'
      const bodyTextLen = Number(state?.bodyTextLen || 0)
      const matched = Boolean(state?.matched)
      const baseReady = readyState === 'interactive' || readyState === 'complete'
      if (selector) {
        if (baseReady && matched) {
          return { ready: true, matchedSelector: true, elapsedMs: Date.now() - started }
        }
      } else if (baseReady && bodyTextLen > 0) {
        return { ready: true, matchedSelector: false, elapsedMs: Date.now() - started }
      }
    } catch {
      // ignore polling errors, keep retrying
    }
    await sleepWithAbort(250, signal)
  }
  return { ready: false, matchedSelector: false, elapsedMs: Date.now() - started }
}

async function extractSearchResults(
  controller: BrowserController,
  tabId: string | null,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const js = `
    (() => {
      const selectors = [
        'a h3',
        'h3 a',
        'article h2 a',
        '.result__a',
        '.b_algo h2 a',
        '.c-container h3 a',
      ]
      const links = new Map()
      for (const sel of selectors) {
        for (const node of Array.from(document.querySelectorAll(sel))) {
          const anchor = node.closest('a') || node
          if (!(anchor instanceof HTMLAnchorElement)) continue
          const href = anchor.href || ''
          const title = (node.textContent || anchor.textContent || '').trim()
          if (!href || !title) continue
          if (!/^https?:/i.test(href)) continue
          if (/google\\.com\\/search\\?|duckduckgo\\.com\\/\\?|bing\\.com\\/search\\?|baidu\\.com\\/s\\?/i.test(href)) continue
          if (!links.has(href)) {
            const block = anchor.closest('article,li,div') || anchor.parentElement || anchor
            const snippetNode = block.querySelector('p, .snippet, .result__snippet, .b_caption p, .c-abstract, .content')
            const snippet = (snippetNode?.textContent || '').trim().slice(0, 280)
            links.set(href, { title: title.slice(0, 120), url: href, snippet })
          }
          if (links.size >= 8) break
        }
        if (links.size >= 8) break
      }
      return Array.from(links.values())
    })()
  `
  const result = await controller.executeJS(tabId, js)
  if (!Array.isArray(result)) return []
  return result
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const row = item as Record<string, unknown>
      return {
        title: String(row.title || ''),
        url: String(row.url || ''),
        snippet: String(row.snippet || ''),
      }
    })
    .filter((row) => row.title && row.url)
}

function buildClickByTextJs(text: string, exact: boolean): string {
  return `
    (() => {
      const target = ${JSON.stringify(text)}
      const exact = ${exact ? 'true' : 'false'}
      const normalize = (s) => (s || '').replace(/\\s+/g, ' ').trim()
      const queue = [document]
      const visited = new Set()
      const all = []
      while (queue.length) {
        const root = queue.shift()
        if (!root || visited.has(root)) continue
        visited.add(root)
        let nodes = []
        try {
          nodes = Array.from(root.querySelectorAll('*'))
        } catch {
          nodes = []
        }
        for (const node of nodes) {
          all.push(node)
          const shadow = node?.shadowRoot
          if (shadow && !visited.has(shadow)) queue.push(shadow)
        }
      }

      const visible = (el) => {
        try {
          const rect = el.getBoundingClientRect()
          if (!rect || rect.width <= 0 || rect.height <= 0) return false
          const style = window.getComputedStyle(el)
          if (!style || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') <= 0) return false
          return true
        } catch {
          return false
        }
      }

      const isClickable = (el) => {
        const tag = (el.tagName || '').toLowerCase()
        if (['a', 'button', 'summary'].includes(tag)) return true
        if (el instanceof HTMLInputElement && ['button', 'submit'].includes((el.type || '').toLowerCase())) return true
        const role = (el.getAttribute('role') || '').toLowerCase()
        if (['button', 'link', 'menuitem', 'option', 'tab'].includes(role)) return true
        if (typeof el.onclick === 'function') return true
        if (el.hasAttribute('onclick') || el.hasAttribute('data-testid')) return true
        return false
      }

      const candidates = all.filter((el) => el instanceof HTMLElement && visible(el) && isClickable(el))
      let matched = null
      for (const el of candidates) {
        const txt = normalize(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('value') || '')
        if (!txt) continue
        if ((exact && txt === target) || (!exact && txt.includes(target))) {
          matched = el
          break
        }
      }
      if (!matched) return 'Element by text not found: ' + target
      matched.scrollIntoView({ block: 'center', behavior: 'instant' })
      matched.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
      matched.click()
      return 'Clicked by text: ' + normalize(matched.textContent || matched.getAttribute('aria-label') || matched.getAttribute('title') || matched.tagName)
    })()
  `
}

function buildSmartTypeJs(options: {
  target: string
  text: string
  clearFirst: boolean
  submit: boolean
}): string {
  const normalizedTarget = options.target.trim().toLowerCase()
  return `
    (() => {
      const target = ${JSON.stringify(normalizedTarget)}
      const text = ${JSON.stringify(options.text)}
      const clearFirst = ${options.clearFirst ? 'true' : 'false'}
      const submit = ${options.submit ? 'true' : 'false'}
      const normalize = (s) => (s || '').toLowerCase().replace(/\\s+/g, ' ').trim()

      const queue = [document]
      const visited = new Set()
      const all = []
      while (queue.length) {
        const root = queue.shift()
        if (!root || visited.has(root)) continue
        visited.add(root)
        let nodes = []
        try {
          nodes = Array.from(root.querySelectorAll('*'))
        } catch {
          nodes = []
        }
        for (const node of nodes) {
          all.push(node)
          const shadow = node?.shadowRoot
          if (shadow && !visited.has(shadow)) queue.push(shadow)
        }
      }

      const visible = (el) => {
        try {
          const rect = el.getBoundingClientRect()
          if (!rect || rect.width <= 0 || rect.height <= 0) return false
          const style = window.getComputedStyle(el)
          if (!style || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') <= 0) return false
          return true
        } catch {
          return false
        }
      }

      const blockedInputTypes = new Set(['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'date', 'time', 'month', 'week'])
      const isEditable = (el) => {
        if (!(el instanceof HTMLElement)) return false
        const isTextInput = el instanceof HTMLInputElement && !blockedInputTypes.has((el.type || 'text').toLowerCase())
        const isTextarea = el instanceof HTMLTextAreaElement
        const role = (el.getAttribute('role') || '').toLowerCase()
          const roleTextbox = role === 'textbox' || role === 'searchbox'
        const hasContentEditableAttr = el.hasAttribute('contenteditable')
        const editableAttr = String(el.getAttribute('contenteditable') || '').toLowerCase()
        const isContentEditable =
          el.isContentEditable ||
          (hasContentEditableAttr && (editableAttr === '' || editableAttr === 'true' || editableAttr === 'plaintext-only'))
        if (!(isTextInput || isTextarea || roleTextbox || isContentEditable)) return false
        const tag = (el.tagName || '').toLowerCase()
        if ((tag === 'html' || tag === 'body') && !hasContentEditableAttr) return false
        if (el.getAttribute('aria-disabled') === 'true') return false
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          if (el.disabled || el.readOnly) return false
        }
        return visible(el)
      }

      const candidates = all.filter(isEditable)
      if (candidates.length === 0) return 'Smart target not found: no editable element'

      const targetTokens = target.split(' ').filter(Boolean)
      const textFields = (el) => {
        const attrs = [
          el.getAttribute('placeholder') || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('name') || '',
          el.getAttribute('id') || '',
          el.getAttribute('title') || '',
          el.getAttribute('data-placeholder') || '',
          el.getAttribute('data-testid') || '',
          el.getAttribute('role') || '',
        ]
        const label = (() => {
          const id = el.getAttribute('id')
          if (id) {
            try {
              const l = document.querySelector('label[for="' + id.replace(/"/g, '\\\\"') + '"]')
              if (l) return l.textContent || ''
            } catch { /* ignore */ }
          }
          const p = el.closest('label')
          return p ? (p.textContent || '') : ''
        })()
        attrs.push(label)
        return normalize(attrs.join(' | '))
      }

      const score = (el) => {
        const merged = textFields(el)
        const rect = el.getBoundingClientRect()
        let s = 0

        if (target) {
          if (merged === target) s += 120
          if (merged.includes(target)) s += 70
          let tokenHit = 0
          for (const t of targetTokens) {
            if (merged.includes(t)) tokenHit += 1
          }
          s += tokenHit * 12
        } else {
          s += 20
        }

        if (/search|message|ask|prompt|chat|gemini|输入|搜索|提问|发送/.test(merged)) s += 30
        if (el instanceof HTMLTextAreaElement) s += 18
        if (el.isContentEditable) s += 14
        if ((el.getAttribute('role') || '').toLowerCase() === 'searchbox') s += 18

        const area = Math.max(1, rect.width * rect.height)
        s += Math.min(28, area / 18000)
        const fromBottom = Math.max(0, window.innerHeight - rect.bottom)
        s += Math.max(0, 10 - Math.min(10, fromBottom / 70))
        return s
      }

      let best = null
      let bestScore = -1
      for (const el of candidates) {
        const sc = score(el)
        if (sc > bestScore) {
          best = el
          bestScore = sc
        }
      }

      if (!best) return 'Smart target not found: score failed'

      const focusAndClick = (el) => {
        try { el.scrollIntoView({ block: 'center', behavior: 'instant' }) } catch { /* ignore */ }
        try { el.focus({ preventScroll: true }) } catch { /* ignore */ }
        try { el.click?.() } catch { /* ignore */ }
      }

      const readText = (el) => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          return String(el.value || '')
        }
        return String(el.innerText || el.textContent || '')
      }

      const setText = (el, value) => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const current = String(el.value || '')
          if (normalize(current) === normalize(value)) return
          if (clearFirst) el.value = ''
          el.value = value
          return
        }
        if (el.isContentEditable) {
          const current = String(el.innerText || el.textContent || '')
          if (normalize(current) === normalize(value)) return
          if (clearFirst) el.textContent = ''
          let inserted = false
          try {
            const selection = window.getSelection()
            if (selection) {
              const range = document.createRange()
              range.selectNodeContents(el)
              range.collapse(false)
              selection.removeAllRanges()
              selection.addRange(range)
            }
            inserted = document.execCommand('insertText', false, value)
          } catch {
            inserted = false
          }
          if (!inserted) {
            el.textContent = (clearFirst ? '' : (el.textContent || '')) + value
          }
          return
        }
        el.textContent = value
      }

      focusAndClick(best)
      const currentText = normalize(readText(best))
      const normalizedText = normalize(text)
      const alreadyHasSameText = Boolean(currentText && normalizedText && currentText === normalizedText)
      if (!alreadyHasSameText) {
        setText(best, text)
        try {
          best.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
        } catch {
          best.dispatchEvent(new Event('input', { bubbles: true }))
        }
        best.dispatchEvent(new Event('change', { bubbles: true }))
      }

      if (submit) {
        const keyOpts = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }
        const down = new KeyboardEvent('keydown', keyOpts)
        const notCanceled = best.dispatchEvent(down)
        best.dispatchEvent(new KeyboardEvent('keypress', keyOpts))
        best.dispatchEvent(new KeyboardEvent('keyup', keyOpts))
        if (notCanceled) {
          const form = best.closest('form')
          if (form && typeof form.requestSubmit === 'function') {
            form.requestSubmit()
          }
        }
      }

      const idName = best.getAttribute('name') || best.getAttribute('id') || best.getAttribute('aria-label') || best.tagName
      if (alreadyHasSameText) {
        return 'Smart target already has same text: ' + idName
      }
      return 'Typed into smart target: ' + idName + ' (score=' + bestScore.toFixed(2) + ')'
    })()
  `
}

async function runWorkflowStep(
  controller: BrowserController,
  step: Record<string, unknown>,
  fallbackTabId: string | null,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal)
  const action = String(step.action || '').trim().toLowerCase()
  const tabId = typeof step.tab_id === 'string' && step.tab_id.trim() ? step.tab_id : fallbackTabId
  if (!action) return 'Error: workflow step missing action'

  if (action === 'navigate') {
    const url = String(step.url || '').trim()
    if (!url) return 'Error: workflow navigate missing url'
    const result = await controller.navigate(tabId, url)
    if (!result.success) return `Error: ${result.error || 'navigate failed'}`
    const waitResult = await waitForReady(controller, tabId, Number(step.timeout_ms || 8000), undefined, signal)
    return `Navigated: ${url} (ready=${waitResult.ready}, elapsed=${waitResult.elapsedMs}ms)`
  }

  if (action === 'search') {
    const query = String(step.query || '').trim()
    if (!query) return 'Error: workflow search missing query'
    const engine = (String(step.engine || 'auto') as SearchEngine)
    const selected = engine === 'auto' ? 'duckduckgo' : engine
    const nav = await controller.navigate(tabId, searchUrl(selected as SearchEngine, query))
    if (!nav.success) return `Error: ${nav.error || 'search navigate failed'}`
    await waitForReady(controller, tabId, Number(step.timeout_ms || 9000), undefined, signal)
    const rows = await extractSearchResults(controller, tabId)
    if (rows.length === 0) return `Search ${selected}: no parsed results for "${query}"`
    return `Search ${selected}: ${rows.map((r, i) => `${i + 1}. ${r.title} - ${r.url}`).join('\n')}`
  }

  if (action === 'wait') {
    const timeoutMs = Number(step.timeout_ms || 8000)
    const selector = typeof step.selector === 'string' ? step.selector : undefined
    const ready = await waitForReady(controller, tabId, timeoutMs, selector, signal)
    return `Wait done: ready=${ready.ready}, selectorMatched=${ready.matchedSelector}, elapsed=${ready.elapsedMs}ms`
  }

  if (action === 'click') {
    const selector = String(step.selector || '').trim()
    if (!selector) return 'Error: workflow click missing selector'
    const clickJs = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return 'Element not found'
        ;(el).click()
        return 'Clicked ' + (el.tagName || 'element')
      })()
    `
    return String(await controller.executeJS(tabId, clickJs))
  }

  if (action === 'click_text') {
    const text = String(step.text || '').trim()
    if (!text) return 'Error: workflow click_text missing text'
    const exact = step.exact === true
    return String(await controller.executeJS(tabId, buildClickByTextJs(text, exact)))
  }

  if (action === 'click_at') {
    const x = Number(step.x)
    const y = Number(step.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Error: workflow click_at requires numeric x and y'
    const point = await dispatchClickAt(controller, tabId, x, y)
    await settleAfterAction(controller, tabId, signal)
    return `Clicked at normalized(${point.nx},${point.ny}) css(${point.cssX},${point.cssY})`
  }

  if (action === 'type') {
    const selector = String(step.selector || '').trim()
    const text = String(step.text || '')
    if (!selector) return 'Error: workflow type missing selector'
    const clearFirst = step.clear_first !== false
    const submit = step.submit === true
    const typeJs = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return 'Element not found'
        el.focus()
        ${clearFirst ? 'if ("value" in el) el.value = ""' : ''}
        if ("value" in el) {
          el.value = ${JSON.stringify(text)}
        } else {
          el.textContent = ${JSON.stringify(text)}
        }
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        ${submit ? `
          const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })
          el.dispatchEvent(ev)
          const form = el.closest('form')
          if (form) form.requestSubmit?.()
        ` : ''}
        return 'Typed'
      })()
    `
    return String(await controller.executeJS(tabId, typeJs))
  }

  if (action === 'type_at') {
    const x = Number(step.x)
    const y = Number(step.y)
    const text = String(step.text || '')
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Error: workflow type_at requires numeric x and y'
    if (!text) return 'Error: workflow type_at missing text'
    const clearBefore = step.clear_before_typing !== false
    const pressEnter = step.press_enter !== false
    const useShiftEnter = step.use_shift_enter_for_newline === true
    const point = await dispatchClickAt(controller, tabId, x, y)
    if (clearBefore) {
      await clearFocusedInput(controller, tabId)
    }
    await controller.typeTextDirectly(tabId, text, { useShiftEnterForNewline: useShiftEnter })
    if (pressEnter) {
      await sendKeyStroke(controller, tabId, 'Enter')
    }
    await settleAfterAction(controller, tabId, signal)
    return `Typed at normalized(${point.nx},${point.ny}) css(${point.cssX},${point.cssY})`
  }

  if (action === 'scroll_at') {
    const x = Number(step.x ?? 500)
    const y = Number(step.y ?? 500)
    const direction = String(step.direction || '').toLowerCase()
    const magnitude = Math.max(40, Math.min(4000, Number(step.magnitude || 800)))
    if (!['up', 'down', 'left', 'right'].includes(direction)) {
      return 'Error: workflow scroll_at direction must be up/down/left/right'
    }
    const point = await resolveCssPoint(controller, tabId, x, y)
    const deltaY = direction === 'up' ? -magnitude : direction === 'down' ? magnitude : 0
    const deltaX = direction === 'left' ? -magnitude : direction === 'right' ? magnitude : 0
    await controller.dispatchMouse(tabId, {
      type: 'mouseWheel',
      x: point.cssX,
      y: point.cssY,
      deltaX,
      deltaY,
      button: 'none',
      buttons: 0,
    })
    return `Scrolled ${direction} at normalized(${point.nx},${point.ny})`
  }

  if (action === 'send_keys') {
    const key = String(step.key || '').trim()
    if (!key) return 'Error: workflow send_keys missing key'
    await sendKeyStroke(controller, tabId, key, step.modifiers)
    return `Sent key: ${key}`
  }

  if (action === 'read') {
    const text = await controller.getPageContent(tabId)
    return truncate(text, Number(step.max_chars || 6000))
  }

  if (action === 'execute_js') {
    const code = String(step.code || '')
    if (!code) return 'Error: workflow execute_js missing code'
    return String(await controller.executeJS(tabId, code))
  }

  if (action === 'compose') {
    const text = String(step.text || '')
    if (!text) return 'Error: workflow compose missing text'
    const target = String(step.target || '')
    const clearFirst = step.clear_first !== false
    const submit = step.submit !== false
    return String(await controller.executeJS(tabId, buildSmartTypeJs({ target, text, clearFirst, submit })))
  }

  return `Error: unknown workflow action "${action}"`
}

function formatBrowserV2Error(prefix: string, error: unknown, attempted: string[]): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = normalizeErrorCode(error)
  return `${prefix}\nerror_code=${code}\nerror=${message}\nattempted=${attempted.join(' -> ')}`
}

async function runGeminiQuery(
  controller: BrowserController,
  text: string,
  tabId: string | null,
  waitResponseMs: number,
  signal?: AbortSignal,
): Promise<string> {
  log(`[browser-v3][phase] browser_query_gemini start wait=${waitResponseMs}`)
  const attempted: string[] = []
  let activeTabId = tabId
  let submitted = false
  let responseDetected = false
  let evidence: Record<string, unknown> = {}

  try {
    throwIfAborted(signal)
    attempted.push('ensure-tab')
    if (!activeTabId) {
      const tabs = controller.getTabList()
      activeTabId = tabs.find((tab) => tab.active)?.id || null
      if (!activeTabId) {
        const created = await controller.createTab('https://gemini.google.com')
        if (!created.success || !created.tabId) {
          return formatBrowserV2Error('[browser-v3][phase] create-tab failed', new Error(created.error || 'create tab failed'), attempted)
        }
        activeTabId = created.tabId
      }
    }

    attempted.push('navigate-gemini')
    const currentUrl = String(await controller.executeJS(activeTabId, 'window.location.href') || '')
    if (!/gemini\.google\.com/i.test(currentUrl)) {
      const navResult = await controller.navigate(activeTabId, 'https://gemini.google.com')
      if (!navResult.success) {
        return formatBrowserV2Error('[browser-v3][phase] navigate failed', new Error(navResult.error || 'navigate failed'), attempted)
      }
    }

    await sleepWithAbort(BROWSER_V2_WAIT_AFTER_NAV_MS, signal)
    await waitForLoadingStop(controller, activeTabId, BROWSER_V2_STOP_LOADING_TIMEOUT_MS, signal)

    attempted.push('compose-dom')
    const domResult = String(
      await controller.executeJS(
        activeTabId,
        buildSmartTypeJs({
          target: 'Gemini message input prompt 输入 提问 搜索',
          text,
          clearFirst: true,
          submit: false,
        }),
      ),
    )
    submitted = /^typed into smart target:/i.test(domResult)
    evidence.domResult = domResult

    if (submitted) {
      attempted.push('verify-submit-after-dom')
      const submitState = await ensureGeminiSubmitted(controller, activeTabId, text, attempted, signal)
      submitted = submitState.submitted
      evidence.submitMethod = submitState.method
      evidence.submitProbe = submitState.probe
    }

    if (!submitted) {
      attempted.push('probe-editables')
      const candidates = await probeGeminiEditableCandidates(controller, activeTabId)
      evidence.candidateCount = candidates.length
      if (candidates.length > 0) {
        attempted.push('type-at-top-candidate')
        const top = candidates[0]
        const point = await dispatchClickAt(controller, activeTabId, top.x, top.y)
        await clearFocusedInput(controller, activeTabId)
        await controller.typeTextDirectly(activeTabId, text, { useShiftEnterForNewline: false })
        const submitState = await ensureGeminiSubmitted(controller, activeTabId, text, attempted, signal)
        submitted = submitState.submitted
        evidence.submitMethod = submitState.method
        evidence.submitProbe = submitState.probe
        evidence.coordinate = {
          normalized: { x: point.nx, y: point.ny },
          css: { x: point.cssX, y: point.cssY },
          reason: top.reason,
        }
      }
    }

    if (!submitted) {
      attempted.push('fallback-bottom-center')
      const point = await dispatchClickAt(controller, activeTabId, 500, 920)
      await clearFocusedInput(controller, activeTabId)
      await controller.typeTextDirectly(activeTabId, text, { useShiftEnterForNewline: false })
      const submitState = await ensureGeminiSubmitted(controller, activeTabId, text, attempted, signal)
      submitted = submitState.submitted
      evidence.submitMethod = submitState.method
      evidence.submitProbe = submitState.probe
      evidence.coordinate = {
        normalized: { x: point.nx, y: point.ny },
        css: { x: point.cssX, y: point.cssY },
        reason: 'fallback-bottom-center',
      }
    }

    if (!submitted) {
      return JSON.stringify({
        phase: 'submit_failed',
        submitted: false,
        response_detected: false,
        evidence,
        attempted,
        next_step: 'retry with browser_type_at + browser_send_keys or browser_ask_user_takeover',
      }, null, 2)
    }

    attempted.push('detect-response')
    const startedAt = Date.now()
    const initialWindowMs = Math.max(8_000, waitResponseMs)
    const hardTimeoutMs = Math.min(180_000, initialWindowMs + 90_000)
    const hardDeadline = startedAt + hardTimeoutMs
    let deadline = startedAt + initialWindowMs
    let inExtendedWait = false
    let stableResponseHits = 0
    let lastProbe: GeminiResponseProbe | null = null
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      lastProbe = await probeGeminiResponse(controller, activeTabId, text)
      if (lastProbe.loginRequired || lastProbe.captchaRequired) {
        const phase = 'human_required'
        return JSON.stringify({
          phase,
          submitted,
          response_detected: false,
          evidence: {
            ...evidence,
            reason: lastProbe.loginRequired ? 'login_required' : 'captcha_required',
            editableCount: lastProbe.editableCount,
          },
          next_step: 'use browser_ask_user_takeover',
        }, null, 2)
      }
      if (lastProbe.responseDetected) {
        stableResponseHits += 1
        if (stableResponseHits >= 2) {
          responseDetected = true
          evidence = {
            ...evidence,
            responseSnippet: lastProbe.responseText.slice(0, 300),
            editableCount: lastProbe.editableCount,
            thinking: false,
          }
          break
        }
      } else {
        stableResponseHits = 0
      }

      if (lastProbe.thinking && Date.now() + 8_000 >= deadline && deadline < hardDeadline) {
        inExtendedWait = true
        const nextDeadline = Math.min(hardDeadline, Date.now() + 22_000)
        if (nextDeadline > deadline) {
          deadline = nextDeadline
          attempted.push('extended-wait-thinking')
        }
      } else if (!lastProbe.thinking && !lastProbe.responseDetected && Date.now() + 4_000 >= deadline && deadline < hardDeadline) {
        const nextDeadline = Math.min(hardDeadline, Date.now() + 12_000)
        if (nextDeadline > deadline) {
          deadline = nextDeadline
          attempted.push('extended-wait-probe')
        }
      }
      await sleepWithAbort(900, signal)
    }

    const phase = responseDetected ? 'done' : 'submitted_waiting'
    log(`[browser-v3][phase] browser_query_gemini phase=${phase} submitted=${submitted} response=${responseDetected} submitMethod=${String(evidence.submitMethod || 'unknown')} extended=${inExtendedWait}`)
    if (!responseDetected && lastProbe) {
      evidence = {
        ...evidence,
        editableCount: lastProbe.editableCount,
        thinking: lastProbe.thinking,
        probe: 'response_not_detected_within_timeout',
        elapsedMs: Date.now() - startedAt,
      }
    }
    return JSON.stringify({
      phase,
      submitted,
      response_detected: responseDetected,
      evidence,
      attempted,
    }, null, 2)
  } catch (error) {
    log(`[browser-v3][fallback] browser_query_gemini error=${error instanceof Error ? error.message : String(error)}`)
    return formatBrowserV2Error('[browser-v3][fallback] browser_query_gemini failed', error, attempted)
  }
}

async function isLikelyChatPage(controller: BrowserController, tabId: string | null): Promise<boolean> {
  try {
    const url = String(await controller.executeJS(tabId, 'window.location.href') || '')
    if (/(^https?:\/\/)?([^/]*\.)?(gemini\.google\.com|kimi\.moonshot\.cn|chatgpt\.com|claude\.ai|perplexity\.ai|doubao\.com|yuanbao\.tencent\.com|deepseek\.com)/i.test(url)) {
      return true
    }
    const probe = await controller.executeJS(
      tabId,
      `
        (() => {
          const hasEditable = document.querySelector('textarea,input,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"]') !== null
          const hasSendButton = document.querySelector('button[aria-label*="send" i],button[aria-label*="发送" i],button[title*="send" i],button[title*="发送" i],button[data-testid*="send" i]') !== null
          const text = String(document.body?.innerText || '').toLowerCase()
          const hasChatKeyword = /chat|message|assistant|提问|对话|发送|输入/.test(text)
          return hasEditable && (hasSendButton || hasChatKeyword)
        })()
      `,
    )
    return Boolean(probe)
  } catch {
    return false
  }
}

interface ScopeAttachmentCandidate {
  attachmentId: string
  name: string
  path: string
  type: string
  size: number
  ext: string
  createdAt: string
}

interface ActionTargetCandidate {
  kind: 'input' | 'launcher' | 'dropzone' | 'text_button' | 'icon_button' | 'send_button' | 'close_button' | 'back_button' | 'prompt_input'
  label: string
  selectorHint?: string
  x?: number
  y?: number
  confidence: number
  evidence: string[]
  associatedInputSelector?: string
  hidden?: boolean
  accepts?: string
  multiple?: boolean
  focused?: boolean
  textLength?: number
  valuePreview?: string
  nearActiveInput?: boolean
  distanceToActiveInput?: number
}

interface ScopeUploadMemory {
  attachmentId: string
  attachmentPath: string
  pageKey: string
  uploadedAt: number
}

const recentScopeUploads = new Map<string, ScopeUploadMemory>()
const RECENT_SCOPE_UPLOAD_TTL_MS = 2 * 60 * 1000

async function listScopeAttachmentsForTool(sessionId?: string): Promise<ScopeAttachmentCandidate[]> {
  const scopeId = String(sessionId || '').trim()
  if (!scopeId) return []
  const repository = new AgentRepository()
  return repository
    .listConversationAttachments(scopeId)
    .then((items) => items
    .filter((item) => item.path && existsSync(item.path))
    .map((item) => ({
      attachmentId: item.attachment_id,
      name: item.name,
      path: item.path,
      type: String(item.type || 'other'),
      size: Number(item.size || 0),
      ext: String(item.ext || ''),
      createdAt: item.created_at,
    })))
}

function selectScopeAttachment(
  attachments: ScopeAttachmentCandidate[],
  args: Record<string, unknown>,
): { attachment?: ScopeAttachmentCandidate; ambiguous?: ScopeAttachmentCandidate[]; reason?: string } {
  if (attachments.length === 0) {
    return { reason: '当前会话没有可用附件。' }
  }
  const attachmentId = String(args.attachment_id || '').trim()
  const attachmentName = String(args.attachment_name || '').trim().toLowerCase()
  const latest = args.latest !== false

  if (attachmentId) {
    const match = attachments.find((item) => item.attachmentId === attachmentId)
    return match ? { attachment: match } : { reason: `未找到附件: ${attachmentId}` }
  }

  if (attachmentName) {
    const matches = attachments.filter((item) => item.name.toLowerCase().includes(attachmentName))
    if (matches.length === 1) return { attachment: matches[0] }
    if (matches.length > 1) return { ambiguous: matches }
    return { reason: `未找到名称匹配的附件: ${attachmentName}` }
  }

  if (latest) return { attachment: attachments[0] }
  return { ambiguous: attachments.slice(0, 6) }
}

async function getPageIdentity(
  controller: BrowserController,
  tabId: string | null,
): Promise<{ title: string; url: string; activeElement: string }> {
  const result = await controller.executeJS(
    tabId,
    `(() => ({
      title: document.title || '',
      url: location.href || '',
      activeElement:
        String(document.activeElement?.tagName || '').toLowerCase() +
        ':' +
        String(
          document.activeElement?.getAttribute?.('aria-label') ||
          document.activeElement?.getAttribute?.('placeholder') ||
          document.activeElement?.id ||
          ''
        ),
    }))()`,
  ) as { title?: string; url?: string; activeElement?: string } | null
  return {
    title: String(result?.title || ''),
    url: String(result?.url || ''),
    activeElement: String(result?.activeElement || ''),
  }
}

interface WorkflowUploadProbe {
  complete: boolean
  evidence: string[]
  inputHasFiles: boolean
  previewVisible: boolean
  attachmentNameMatched: boolean
  removeActionVisible: boolean
}

interface WorkflowDomStateProbe {
  inputCandidateCount: number
  sendCandidateCount: number
  uploadCandidateCount: number
  modalVisible: boolean
  bodyStateText: string
}

interface WorkflowPromptSubmissionProbe {
  promptMatched: boolean
  promptFilled: boolean
  promptText: string
  generating: boolean
  submitEvidence: string[]
  sendButtonCount: number
  sendButtonDisabled: boolean
  uploadChipVisible: boolean
}

async function probeWorkflowUploadState(
  controller: BrowserController,
  tabId: string | null,
  attachmentName?: string,
): Promise<WorkflowUploadProbe> {
  const safeName = String(attachmentName || '').trim()
  const basename = safeName.replace(/\.[a-z0-9]{1,8}$/i, '').toLowerCase()
  const result = await controller.executeJS(
    tabId,
    `(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase()
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        if (rect.width < 12 || rect.height < 12) return false
        const style = getComputedStyle(el)
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false
        return Number(style.opacity || '1') > 0
      }
      const attachmentNeedle = ${JSON.stringify(basename)}
      const bodyText = normalize(document.body?.innerText || '')
      const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'))
        .filter((node) => node instanceof HTMLInputElement)
      const inputHasFiles = fileInputs.some((node) => node.files && node.files.length > 0)
      const viewportW = Math.max(1, window.innerWidth || 0)
      const viewportH = Math.max(1, window.innerHeight || 0)
      const previewNodes = Array.from(document.querySelectorAll('img,video,[role="img"],canvas,.thumbnail,[class*="thumb"],[class*="preview"],[data-testid*="upload" i],[data-testid*="preview" i]'))
        .filter((node) => visible(node))
      const removeNodes = Array.from(document.querySelectorAll('button,[role="button"],span,div,a'))
        .filter((node) => visible(node))
        .map((node) => normalize(node.textContent || node.getAttribute?.('aria-label') || node.getAttribute?.('title') || ''))
        .filter((text) => /remove|delete|clear|close|移除|删除|清除|取消|×|x/.test(text))
      const uploadMarkers = /upload|uploaded|preview|thumbnail|附件|参考图|素材|已上传|原图|参考/.test(bodyText)
      const attachmentNameMatched = Boolean(attachmentNeedle && bodyText.includes(attachmentNeedle))
      const previewVisible = previewNodes.some((node) => {
        if (!(node instanceof HTMLElement)) return false
        const rect = node.getBoundingClientRect()
        const meta = normalize([
          node.getAttribute?.('aria-label'),
          node.getAttribute?.('title'),
          node.getAttribute?.('data-testid'),
          node.getAttribute?.('class'),
          node.textContent,
        ].filter(Boolean).join(' '))
        const looksLikeNamedPreview = !attachmentNeedle || meta.includes(attachmentNeedle) || /preview|thumbnail|附件|已上传|upload|参考图|素材/.test(meta)
        const smallPreviewCluster =
          rect.width >= 24 &&
          rect.height >= 24 &&
          rect.width <= Math.min(220, viewportW * 0.28) &&
          rect.height <= Math.min(220, viewportH * 0.28) &&
          rect.top >= viewportH * 0.55
        return looksLikeNamedPreview || smallPreviewCluster || uploadMarkers || removeNodes.length > 0
      })
      const evidence = []
      if (inputHasFiles) evidence.push('file_input_has_files')
      if (attachmentNameMatched) evidence.push('attachment_name_visible')
      if (previewVisible) evidence.push('preview_or_chip_visible')
      if (removeNodes.length > 0) evidence.push('remove_action_visible')
      return {
        complete: Boolean(inputHasFiles || attachmentNameMatched || previewVisible),
        evidence,
        inputHasFiles,
        previewVisible,
        attachmentNameMatched,
        removeActionVisible: removeNodes.length > 0,
      }
    })()`,
  ) as WorkflowUploadProbe | null

  return {
    complete: Boolean(result?.complete),
    evidence: Array.isArray(result?.evidence) ? result.evidence : [],
    inputHasFiles: Boolean(result?.inputHasFiles),
    previewVisible: Boolean(result?.previewVisible),
    attachmentNameMatched: Boolean(result?.attachmentNameMatched),
    removeActionVisible: Boolean(result?.removeActionVisible),
  }
}

async function probeWorkflowDomState(
  controller: BrowserController,
  tabId: string | null,
): Promise<WorkflowDomStateProbe> {
  const result = await controller.executeJS(
    tabId,
    `(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase()
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        if (rect.width < 10 || rect.height < 10) return false
        const style = getComputedStyle(el)
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false
        return Number(style.opacity || '1') > 0
      }
      const editables = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"],[role="searchbox"]'))
        .filter((node) => visible(node))
      const buttons = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"],label,[tabindex]'))
        .filter((node) => visible(node))
      const sendCandidateCount = buttons.filter((node) => {
        const meta = normalize(node.textContent || node.getAttribute?.('aria-label') || node.getAttribute?.('title') || node.getAttribute?.('data-testid') || node.getAttribute?.('class') || '')
        return /send|提交|发送|继续|generate|生成|创作|run|go|发布/.test(meta)
      }).length
      const uploadCandidateCount = buttons.filter((node) => {
        const meta = normalize(node.textContent || node.getAttribute?.('aria-label') || node.getAttribute?.('title') || node.getAttribute?.('data-testid') || node.getAttribute?.('class') || '')
        return /upload|上传|附件|图片|素材|参考图|file|image|plus|add|导入|拖拽/.test(meta)
      }).length
      const modalVisible = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog,.modal,.drawer,.popup'))
        .some((node) => visible(node))
      const bodyStateText = normalize(document.body?.innerText || '').slice(0, 1200)
      return {
        inputCandidateCount: editables.length,
        sendCandidateCount,
        uploadCandidateCount,
        modalVisible,
        bodyStateText,
      }
    })()`,
  ) as WorkflowDomStateProbe | null

  return {
    inputCandidateCount: Number(result?.inputCandidateCount || 0),
    sendCandidateCount: Number(result?.sendCandidateCount || 0),
    uploadCandidateCount: Number(result?.uploadCandidateCount || 0),
    modalVisible: Boolean(result?.modalVisible),
    bodyStateText: String(result?.bodyStateText || ''),
  }
}

async function probeWorkflowPromptSubmissionState(
  controller: BrowserController,
  tabId: string | null,
  expectedPrompt: string,
): Promise<WorkflowPromptSubmissionProbe> {
  const result = await controller.executeJS(
    tabId,
    `(() => {
      const expected = ${JSON.stringify(String(expectedPrompt || '').trim().toLowerCase())}
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase()
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        if (!rect || rect.width <= 0 || rect.height <= 0) return false
        const style = getComputedStyle(el)
        if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0) return false
        return true
      }
      const blockedInputTypes = new Set(['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'date', 'time', 'month', 'week'])
      const isEditable = (el) => {
        if (!(el instanceof HTMLElement)) return false
        const isTextInput = el instanceof HTMLInputElement && !blockedInputTypes.has((el.type || 'text').toLowerCase())
        const isTextarea = el instanceof HTMLTextAreaElement
        const role = (el.getAttribute('role') || '').toLowerCase()
        const roleTextbox = role === 'textbox' || role === 'searchbox'
        const hasContentEditableAttr = el.hasAttribute('contenteditable')
        const editableAttr = String(el.getAttribute('contenteditable') || '').toLowerCase()
        const isContentEditable =
          el.isContentEditable ||
          (hasContentEditableAttr && (editableAttr === '' || editableAttr === 'true' || editableAttr === 'plaintext-only'))
        if (!(isTextInput || isTextarea || roleTextbox || isContentEditable)) return false
        if (el.getAttribute('aria-disabled') === 'true') return false
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          if (el.disabled || el.readOnly) return false
        }
        return visible(el)
      }
      const editableText = (el) => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return String(el.value || '')
        return String(el.innerText || el.textContent || '')
      }
      const editables = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="searchbox"]'))
        .filter(isEditable)
      const promptCandidate = editables
        .map((el) => {
          const meta = normalize([
            el.getAttribute('placeholder'),
            el.getAttribute('aria-label'),
            el.getAttribute('name'),
            el.getAttribute('id'),
            el.getAttribute('title'),
            el.getAttribute('data-testid'),
            el.getAttribute('class'),
          ].filter(Boolean).join(' '))
          const rect = el.getBoundingClientRect()
          let score = 0
          if (/prompt|提示|文案|描述|输入|message|chat|ask|生成|创作|内容/.test(meta)) score += 12
          if (el.tagName.toLowerCase() === 'textarea') score += 4
          if ((el instanceof HTMLElement) && el.isContentEditable) score += 3
          if (rect.bottom > window.innerHeight * 0.45) score += 3
          if (rect.width > window.innerWidth * 0.25) score += 2
          if (/时间|生成类型|操作类型|筛选|排序|search|搜索/.test(meta)) score -= 14
          if (rect.top < window.innerHeight * 0.38) score -= 8
          return { text: editableText(el), score }
        })
        .filter((item) => item.score >= 2)
        .sort((a, b) => b.score - a.score || b.text.length - a.text.length)[0]

      const promptText = normalize(promptCandidate?.text || '')
      const promptMatched =
        Boolean(expected) &&
        promptText.length >= Math.min(Math.max(12, Math.floor(expected.length * 0.4)), expected.length) &&
        (promptText === expected || promptText.includes(expected) || expected.includes(promptText))
      const promptFilled = Boolean(promptText)
      const buttons = Array.from(document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]'))
        .filter(visible)
        .map((el) => {
          const meta = normalize([
            el.textContent,
            el.getAttribute('aria-label'),
            el.getAttribute('title'),
            el.getAttribute('data-testid'),
            el.getAttribute('class'),
          ].filter(Boolean).join(' '))
          const disabled =
            (el instanceof HTMLButtonElement && el.disabled) ||
            (el instanceof HTMLInputElement && el.disabled) ||
            el.getAttribute('aria-disabled') === 'true'
          return { meta, disabled }
        })
      const sendButtons = buttons.filter((item) => /send|发送|提交|发布|继续|go|run|submit|generate|generating|生成|创作|开始/.test(item.meta))
      const sendButtonCount = sendButtons.length
      const sendButtonDisabled = sendButtons.length > 0 && sendButtons.every((item) => item.disabled)
      const bodyText = normalize(document.body?.innerText || '')
      const uploadChipVisible = /已上传|upload|preview|thumbnail|附件/.test(bodyText) && /remove|delete|移除|删除|清除/.test(bodyText)
      const submitEvidence = []
      if (/thinking|正在思考|思考中|生成中|creating|generating|uploading|上传中|处理中|responding|排队中/.test(bodyText)) {
        submitEvidence.push('page_processing_state')
      }
      return {
        promptMatched,
        promptFilled,
        promptText,
        generating: submitEvidence.length > 0,
        submitEvidence,
        sendButtonCount,
        sendButtonDisabled,
        uploadChipVisible,
      }
    })()`,
  ) as WorkflowPromptSubmissionProbe | null

  return {
    promptMatched: Boolean(result?.promptMatched),
    promptFilled: Boolean(result?.promptFilled),
    promptText: String(result?.promptText || ''),
    generating: Boolean(result?.generating),
    submitEvidence: Array.isArray(result?.submitEvidence) ? result.submitEvidence : [],
    sendButtonCount: Number(result?.sendButtonCount || 0),
    sendButtonDisabled: Boolean(result?.sendButtonDisabled),
    uploadChipVisible: Boolean(result?.uploadChipVisible),
  }
}

function buildScopeUploadKey(sessionId: string | undefined, pageIdentity: { title: string; url: string }): string {
  let normalizedPage = pageIdentity.title || 'unknown'
  try {
    const parsed = new URL(pageIdentity.url)
    normalizedPage = `${parsed.origin}${parsed.pathname}` || normalizedPage
  } catch {
    normalizedPage = pageIdentity.url || normalizedPage
  }
  return `${sessionId || 'global'}::${normalizedPage}`
}

async function locateActionTargets(
  controller: BrowserController,
  tabId: string | null,
  action: 'upload' | 'send' | 'close' | 'back' | 'input',
): Promise<ActionTargetCandidate[]> {
  if (action === 'upload') {
    const targets = await controller.findUploadTargets(tabId)
    return targets.map((item) => ({
      kind: item.kind,
      label: item.label,
      selectorHint: item.selectorHint,
      x: item.x,
      y: item.y,
      confidence: Number(item.confidence || 0),
      evidence: Array.isArray(item.evidence) ? item.evidence : [],
      associatedInputSelector: item.associatedInputSelector,
      hidden: item.hidden,
      accepts: item.accepts,
      multiple: item.multiple,
    }))
  }

  if (action === 'input') {
    const targets = await controller.executeJS(
      tabId,
      `
        (() => {
          const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
          const visible = (el) => {
            if (!(el instanceof HTMLElement)) return false
            const rect = el.getBoundingClientRect()
            if (!rect || rect.width < 10 || rect.height < 10) return false
            const style = getComputedStyle(el)
            if (!style || style.display === 'none' || style.visibility === 'hidden') return false
            if (Number(style.opacity || '1') <= 0) return false
            return true
          }
          const blockedInputTypes = new Set(['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'date', 'time', 'month', 'week'])
          const isEditable = (el) => {
            if (!(el instanceof HTMLElement)) return false
            const isTextInput = el instanceof HTMLInputElement && !blockedInputTypes.has((el.type || 'text').toLowerCase())
            const isTextarea = el instanceof HTMLTextAreaElement
            const role = (el.getAttribute('role') || '').toLowerCase()
            const roleTextbox = role === 'textbox' || role === 'combobox' || role === 'searchbox'
            const hasContentEditableAttr = el.hasAttribute('contenteditable')
            const editableAttr = String(el.getAttribute('contenteditable') || '').toLowerCase()
            const isContentEditable =
              el.isContentEditable ||
              (hasContentEditableAttr && (editableAttr === '' || editableAttr === 'true' || editableAttr === 'plaintext-only'))
            if (!(isTextInput || isTextarea || roleTextbox || isContentEditable)) return false
            if (el.getAttribute('aria-disabled') === 'true') return false
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              if (el.disabled || el.readOnly) return false
            }
            return visible(el)
          }
          const extractLabel = (el) => {
            const attrs = [
              el.getAttribute('placeholder'),
              el.getAttribute('aria-label'),
              el.getAttribute('name'),
              el.getAttribute('id'),
              el.getAttribute('title'),
              el.getAttribute('data-testid'),
              el.getAttribute('class'),
            ].filter(Boolean)
            const id = el.getAttribute('id')
            if (id) {
              try {
                const linked = document.querySelector('label[for="' + CSS.escape(id) + '"]')
                if (linked?.textContent) attrs.push(linked.textContent)
              } catch {
                // ignore
              }
            }
            const parentLabel = el.closest('label')
            if (parentLabel?.textContent) attrs.push(parentLabel.textContent)
            return normalize(attrs.join(' '))
          }
          const active = document.activeElement instanceof HTMLElement && isEditable(document.activeElement)
            ? document.activeElement
            : null
          const readValue = (el) => {
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              return String(el.value || '')
            }
            return String(el.innerText || el.textContent || '')
          }
          const nodes = Array.from(document.querySelectorAll('textarea,input,[role="textbox"],[role="combobox"],[role="searchbox"],[contenteditable]'))
            .filter((node) => node instanceof HTMLElement)
            .filter((node) => isEditable(node))
          const out = nodes.map((node) => {
            const rect = node.getBoundingClientRect()
            const label = extractLabel(node)
            const value = normalize(readValue(node))
            const focused = !!active && active === node
            let score = 0
            if (/prompt|提示|描述|文案|内容|输入|message|chat|ask|search|搜索|生成|创作|正文/.test(label)) score += 14
            if (node.tagName.toLowerCase() === 'textarea') score += 6
            if ((node instanceof HTMLElement) && node.isContentEditable) score += 5
            if (rect.bottom > window.innerHeight * 0.4) score += 4
            if (rect.width > window.innerWidth * 0.22) score += 4
            if (rect.height >= 32) score += 2
            if (focused) score += 18
            if (value.length > 0) score += Math.min(6, value.length / 24)
            if (/时间|生成类型|操作类型|筛选|排序/.test(label)) score -= 16
            if (rect.top < window.innerHeight * 0.38) score -= 8
            return {
              kind: 'prompt_input',
              label,
              selectorHint: node.id ? ('#' + CSS.escape(node.id)) : String(node.tagName || '').toLowerCase(),
              x: Math.max(0, Math.min(999, Math.round(((rect.left + rect.width / 2) / Math.max(1, window.innerWidth)) * 999))),
              y: Math.max(0, Math.min(999, Math.round(((rect.top + rect.height / 2) / Math.max(1, window.innerHeight)) * 999))),
              confidence: Math.min(0.99, 0.35 + score / 22),
              evidence: [label ? 'editable_label_match' : 'editable_visible', focused ? 'active_input' : '', value.length > 0 ? 'has_text' : ''].filter(Boolean),
              focused,
              textLength: value.length,
              valuePreview: value.slice(0, 80),
            }
          })
          return out
            .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
            .slice(0, 10)
        })()
      `,
    ) as ActionTargetCandidate[] | null

    return Array.isArray(targets) ? targets : []
  }

  const keywordMap: Record<'upload' | 'send' | 'close' | 'back', string[]> = {
    upload: ['upload'],
    send: ['send', '发送', '提交', '发布', '继续', '生成', 'go', 'ask', 'submit'],
    close: ['close', '关闭', '取消', '退出', 'dismiss', '×', 'x'],
    back: ['back', '返回', '上一步', '撤销', 'go back', '返回上一页'],
  }

  const targets = await controller.executeJS(
    tabId,
    `
      (() => {
        const action = ${JSON.stringify(action)}
        const keywords = ${JSON.stringify(keywordMap[action])}
        const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const rect = el.getBoundingClientRect()
          if (rect.width < 8 || rect.height < 8) return false
          const style = getComputedStyle(el)
          if (!style) return false
          if (style.display === 'none' || style.visibility === 'hidden') return false
          if (Number(style.opacity || '1') <= 0) return false
          return true
        }
        const isClickable = (el) => {
          const tag = String(el.tagName || '').toLowerCase()
          if (['button', 'a', 'summary'].includes(tag)) return true
          const role = (el.getAttribute('role') || '').toLowerCase()
          if (['button', 'link', 'tab', 'menuitem'].includes(role)) return true
          if (el instanceof HTMLInputElement && ['button', 'submit'].includes((el.type || '').toLowerCase())) return true
          return el.hasAttribute('onclick') || typeof el.onclick === 'function'
        }
        const blockedInputTypes = new Set(['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'date', 'time', 'month', 'week'])
        const isEditable = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const isTextInput = el instanceof HTMLInputElement && !blockedInputTypes.has((el.type || 'text').toLowerCase())
          const isTextarea = el instanceof HTMLTextAreaElement
          const role = (el.getAttribute('role') || '').toLowerCase()
          const roleTextbox = role === 'textbox' || role === 'combobox' || role === 'searchbox'
          const editableAttr = String(el.getAttribute('contenteditable') || '').toLowerCase()
          const isContentEditable =
            el.isContentEditable ||
            (el.hasAttribute('contenteditable') && (editableAttr === '' || editableAttr === 'true' || editableAttr === 'plaintext-only'))
          if (!(isTextInput || isTextarea || roleTextbox || isContentEditable)) return false
          if (el.getAttribute('aria-disabled') === 'true') return false
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            if (el.disabled || el.readOnly) return false
          }
          return visible(el)
        }
        const activeInput = action === 'send' && document.activeElement instanceof HTMLElement && isEditable(document.activeElement)
          ? document.activeElement
          : null
        const activeRect = activeInput ? activeInput.getBoundingClientRect() : null
        const activeForm = activeInput ? activeInput.closest('form') : null
        const out = []
        for (const node of Array.from(document.querySelectorAll('button,a,[role="button"],[role="link"],summary,input[type="submit"],div,span'))) {
          if (!(node instanceof HTMLElement) || !visible(node)) continue
          const rect = node.getBoundingClientRect()
          const centerX = rect.left + rect.width / 2
          const centerY = rect.top + rect.height / 2
          const explicitClickable = isClickable(node)
          const meta = normalize([
            node.textContent,
            node.getAttribute('aria-label'),
            node.getAttribute('title'),
            node.getAttribute('data-testid'),
            node.getAttribute('class'),
          ].filter(Boolean).join(' ')).toLowerCase()
          if (!explicitClickable && !meta) continue
          const distanceToActiveInput = activeRect
            ? Math.round(Math.hypot(
              centerX - (activeRect.left + activeRect.width / 2),
              centerY - (activeRect.top + activeRect.height / 2),
            ))
            : undefined
          const nearActiveInput = action === 'send' && !!activeRect
            ? (
              (centerX >= activeRect.left - 160 && centerX <= activeRect.right + 260 && centerY >= activeRect.top - 90 && centerY <= activeRect.bottom + 220) ||
              Number(distanceToActiveInput || 0) <= Math.max(240, Math.min(window.innerWidth * 0.28, 360))
            )
            : false
          const sameFormAsActiveInput = action === 'send' && !!activeForm && activeForm.contains(node)
          const inNavigationLikeRegion = !!node.closest('nav,aside,[role="navigation"],header,[data-testid*="nav" i],[class*="sidebar" i],[class*="sider" i]')
          if (action === 'send') {
            const hugeSurface = rect.width > window.innerWidth * 0.42 || rect.height > window.innerHeight * 0.14
            const hugeText = meta.length > 42
            if (hugeSurface || hugeText) continue
            const likelyLeftNav = rect.left < window.innerWidth * 0.18 && rect.top < window.innerHeight * 0.72
            const weakGenerateOnly = /^生成$/.test(meta) || /(^|\s)生成(\s|$)/.test(meta)
            if (likelyLeftNav && weakGenerateOnly) continue
            const browserChromeLike = rect.top < window.innerHeight * 0.14 && rect.height <= 72
            if (browserChromeLike) continue
          }
          let score = 0
          let keywordHits = 0
          for (const keyword of keywords) {
            if (meta.includes(String(keyword).toLowerCase())) {
              score += 10
              keywordHits += 1
            }
          }
          if (!score && !explicitClickable) continue
          if (action === 'send') {
            if (rect.right > window.innerWidth * 0.68) score += 4
            if (rect.bottom > window.innerHeight * 0.62) score += 4
            if (rect.width <= 88 && rect.height <= 88) score += 3
            if (nearActiveInput) score += 18
            else if (activeRect) score -= 10
            if (sameFormAsActiveInput) score += 12
            if (inNavigationLikeRegion && !nearActiveInput) score -= 16
            if (/(灵感|资产|画布|会员|首页|模板|导航)/.test(meta)) score -= 12
            if (/(重新生成|再次生成|再试一次|try again|retry|历史|history)/.test(meta)) score -= 18
            if (rect.left < window.innerWidth * 0.2) score -= 10
            if (rect.top < window.innerHeight * 0.48 && rect.left < window.innerWidth * 0.35) score -= 10
            if (activeRect && rect.top < activeRect.top - 120) score -= 8
            if (activeRect && rect.left < activeRect.left - 220) score -= 6
            if (rect.bottom < window.innerHeight * 0.45 && !/(send|发送|提交|发布|go|run|submit)/.test(meta)) score -= 8
            if (!keywordHits && !nearActiveInput && !sameFormAsActiveInput) score -= 6
          }
          if (action === 'close') {
            const topRight = rect.right > window.innerWidth * 0.62 && rect.top < window.innerHeight * 0.35
            const explicitClose = /(close|关闭|取消|退出|dismiss|×|\bx\b)/.test(meta)
            if ((!topRight && !explicitClose) || rect.width > 120 || rect.height > 120) continue
          }
          if (action === 'send' && rect.bottom > window.innerHeight * 0.55) score += 4
          if (action === 'close' && rect.top < window.innerHeight * 0.35) score += 4
          if (action === 'back' && rect.left < window.innerWidth * 0.35) score += 4
          if (/icon|arrow|chevron|close|send|upload|attach|paperclip|plus|返回|关闭|发送|上传/.test(meta)) score += 2
          if (score <= 0) continue
          out.push({
            kind: action === 'send' ? 'send_button' : action === 'close' ? 'close_button' : action === 'back' ? 'back_button' : 'icon_button',
            label: normalize(node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || ''),
            selectorHint: node.id ? ('#' + CSS.escape(node.id)) : String(node.tagName || '').toLowerCase(),
            x: Math.max(0, Math.min(999, Math.round((centerX / Math.max(1, window.innerWidth)) * 999))),
            y: Math.max(0, Math.min(999, Math.round((centerY / Math.max(1, window.innerHeight)) * 999))),
            confidence: Math.min(0.98, 0.28 + Math.max(0, score) / 28),
            evidence: [
              keywordHits > 0 ? 'keyword_match' : '',
              explicitClickable ? 'explicit_clickable' : '',
              nearActiveInput ? 'near_active_input' : '',
              sameFormAsActiveInput ? 'same_form_as_active_input' : '',
            ].filter(Boolean),
            nearActiveInput: nearActiveInput || undefined,
            distanceToActiveInput,
          })
        }
        return out
          .sort((a, b) =>
            Number(Boolean(b.nearActiveInput)) - Number(Boolean(a.nearActiveInput)) ||
            Number(b.confidence || 0) - Number(a.confidence || 0) ||
            Number(a.distanceToActiveInput ?? Number.POSITIVE_INFINITY) - Number(b.distanceToActiveInput ?? Number.POSITIVE_INFINITY)
          )
          .slice(0, 12)
      })()
    `,
  ) as ActionTargetCandidate[] | null

  return Array.isArray(targets) ? targets : []
}

function pickActiveInputTarget(targets: ActionTargetCandidate[]): ActionTargetCandidate | null {
  const focusedTargets = targets.filter((item) => item.focused)
  if (focusedTargets.length === 0) return null
  return [...focusedTargets].sort((a, b) =>
    Number(b.confidence || 0) - Number(a.confidence || 0) ||
    Number(b.textLength || 0) - Number(a.textLength || 0)
  )[0] || null
}

function rankTargetsNearAnchor(
  targets: ActionTargetCandidate[],
  anchor: ActionTargetCandidate | null,
): ActionTargetCandidate[] {
  const anchorX = Number(anchor?.x)
  const anchorY = Number(anchor?.y)
  if (!Number.isFinite(anchorX) || !Number.isFinite(anchorY)) {
    return [...targets].sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
  }

  return [...targets]
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y))
    .map((item) => {
      const dx = Number(item.x) - anchorX
      const dy = Number(item.y) - anchorY
      const distance = Math.round(Math.hypot(dx, dy))
      const nearAnchor =
        Boolean(item.nearActiveInput) ||
        (dx >= -140 && dx <= 260 && dy >= -80 && dy <= 220) ||
        distance <= 280 ||
        (Number(item.x) >= 760 && Number(item.y) >= 700)
      return {
        ...item,
        nearActiveInput: nearAnchor,
        distanceToActiveInput: Number.isFinite(item.distanceToActiveInput)
          ? Number(item.distanceToActiveInput)
          : distance,
      }
    })
    .sort((a, b) =>
      Number(Boolean(b.nearActiveInput)) - Number(Boolean(a.nearActiveInput)) ||
      Number(b.confidence || 0) - Number(a.confidence || 0) ||
      Number(a.distanceToActiveInput ?? Number.POSITIVE_INFINITY) - Number(b.distanceToActiveInput ?? Number.POSITIVE_INFINITY)
    )
}

function pickBestActionTarget(
  targets: ActionTargetCandidate[],
  preferredKinds: ActionTargetCandidate['kind'][],
): ActionTargetCandidate | null {
  if (targets.length === 0) return null
  const ranked = [...targets].sort((a, b) => {
    const aKind = preferredKinds.includes(a.kind) ? 1 : 0
    const bKind = preferredKinds.includes(b.kind) ? 1 : 0
    if (aKind !== bKind) return bKind - aKind
    return Number(b.confidence || 0) - Number(a.confidence || 0)
  })
  return ranked[0] || null
}

async function clickActionTarget(
  controller: BrowserController,
  tabId: string | null,
  target: ActionTargetCandidate,
  abortSignal?: AbortSignal,
): Promise<{ ok: boolean; method: string }> {
  const canUseSelector = typeof target.selectorHint === 'string' &&
    target.selectorHint.length > 0 &&
    (target.selectorHint.startsWith('#') || target.selectorHint.includes('['))
  if (canUseSelector) {
    const result = await controller.executeJS(
      tabId,
      `
        (() => {
          const selector = ${JSON.stringify(target.selectorHint)}
          try {
            const node = document.querySelector(selector)
            if (!(node instanceof HTMLElement)) return { ok: false, method: 'selector_not_found' }
            node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
            node.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
            if (typeof node.click === 'function') node.click()
            else {
              node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
              node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
              node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
            }
            return { ok: true, method: 'selector_click' }
          } catch (error) {
            return { ok: false, method: String(error || 'selector_click_failed') }
          }
        })()
      `,
    ) as { ok?: boolean; method?: string } | null
    if (result?.ok) {
      await settleAfterAction(controller, tabId, abortSignal)
      return { ok: true, method: String(result.method || 'selector_click') }
    }
  }
  if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
    await dispatchClickAt(controller, tabId, Number(target.x), Number(target.y))
    await settleAfterAction(controller, tabId, abortSignal)
    return { ok: true, method: 'coordinate_click' }
  }
  return { ok: false, method: 'no_clickable_target' }
}

async function attemptRecoverPageState(
  controller: BrowserController,
  tabId: string | null,
  signal?: AbortSignal,
): Promise<{ recovered: boolean; method: string }> {
  try {
    await sendKeyStroke(controller, tabId, 'Escape')
    await sleepWithAbort(160, signal)
    return { recovered: true, method: 'escape' }
  } catch {
    // continue
  }

  const closeTargets = await locateActionTargets(controller, tabId, 'close')
  const closeTarget = pickBestActionTarget(closeTargets, ['close_button', 'icon_button'])
  if (closeTarget) {
    const clicked = await clickActionTarget(controller, tabId, closeTarget, signal)
    if (clicked.ok) return { recovered: true, method: clicked.method }
  }

  const backTargets = await locateActionTargets(controller, tabId, 'back')
  const backTarget = pickBestActionTarget(backTargets, ['back_button', 'icon_button'])
  if (backTarget) {
    const clicked = await clickActionTarget(controller, tabId, backTarget, signal)
    if (clicked.ok) return { recovered: true, method: clicked.method }
  }

  const goBack = controller.goBack(tabId)
  if (goBack.success) {
    await settleAfterAction(controller, tabId, signal)
    return { recovered: true, method: 'browser_go_back' }
  }

  return { recovered: false, method: 'recover_failed' }
}

function chooseUploadTarget(
  targets: ActionTargetCandidate[],
  args: Record<string, unknown>,
): ActionTargetCandidate | null {
  if (targets.length === 0) return null
  const selector = String(args.selector || '').trim()
  const targetText = String(args.target || '').trim().toLowerCase()
  if (selector) {
    const bySelector = targets.find((item) => item.selectorHint === selector || item.associatedInputSelector === selector)
    if (bySelector) return bySelector
  }
  if (targetText) {
    const byLabel = targets
      .filter((item) => item.label.toLowerCase().includes(targetText))
      .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
    if (byLabel[0]) return byLabel[0]
  }
  return pickBestActionTarget(targets, ['input', 'launcher', 'dropzone'])
}

async function verifyUploadState(
  controller: BrowserController,
  tabId: string | null,
  fileName: string,
): Promise<{ success: boolean; reason: string; evidence?: string[] }> {
  const result = await controller.executeJS(
    tabId,
    `
      (() => {
        const wanted = ${JSON.stringify(fileName.toLowerCase())}
        const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase()
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
        const hasSelectedFile = inputs.some((input) => {
          if (!(input instanceof HTMLInputElement)) return false
          const files = Array.from(input.files || [])
          return files.some((file) => normalize(file.name).includes(wanted))
        })
        const pageText = normalize(document.body?.innerText || '')
        const hasMention = wanted ? pageText.includes(wanted) : false
        const viewportW = Math.max(1, window.innerWidth || 0)
        const viewportH = Math.max(1, window.innerHeight || 0)
        const previewLike = Array.from(document.querySelectorAll('img,video,[role="img"],canvas,.thumbnail,[class*="thumb"],[class*="preview"],[data-testid*="upload" i],[data-testid*="preview" i]'))
          .some((node) => {
            if (!(node instanceof HTMLElement)) return false
            const rect = node.getBoundingClientRect()
            const style = getComputedStyle(node)
            if (rect.width < 16 || rect.height < 16) return false
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0) return false
            const meta = normalize([
              node.getAttribute('aria-label'),
              node.getAttribute('title'),
              node.getAttribute('data-testid'),
              node.getAttribute('class'),
              node.textContent,
            ].filter(Boolean).join(' '))
            const looksLikeNamedPreview = !wanted || meta.includes(wanted) || /preview|thumbnail|附件|已上传|upload/.test(meta)
            const smallPreviewCluster =
              rect.width >= 24 &&
              rect.height >= 24 &&
              rect.width <= Math.min(220, viewportW * 0.28) &&
              rect.height <= Math.min(220, viewportH * 0.28) &&
              rect.top >= viewportH * 0.55
            return looksLikeNamedPreview || smallPreviewCluster
          })
        const removeChip = Array.from(document.querySelectorAll('button,[role="button"],span,div'))
          .some((node) => {
            if (!(node instanceof HTMLElement)) return false
            const meta = normalize([
              node.textContent,
              node.getAttribute('aria-label'),
              node.getAttribute('title'),
              node.getAttribute('data-testid'),
              node.getAttribute('class'),
            ].filter(Boolean).join(' '))
            return /remove|delete|删除|移除|clear|close/.test(meta) && (!wanted || pageText.includes(wanted))
          })
        const evidence = [
          hasSelectedFile ? 'input_files_changed' : '',
          hasMention ? 'page_text_updated' : '',
          previewLike ? 'preview_detected' : '',
          removeChip ? 'remove_chip_detected' : '',
        ].filter(Boolean)
        return {
          success: evidence.length > 0,
          reason:
            hasSelectedFile ? 'input_files_changed'
              : previewLike ? 'preview_detected'
                : removeChip ? 'remove_chip_detected'
                  : hasMention ? 'page_text_updated'
                    : 'no_upload_evidence',
          evidence,
        }
      })()
    `,
  ) as { success?: boolean; reason?: string; evidence?: string[] } | null
  return {
    success: Boolean(result?.success),
    reason: String(result?.reason || 'unknown'),
    evidence: Array.isArray(result?.evidence) ? result?.evidence : [],
  }
}

export async function executeBrowserTool(
  toolName: string,
  args: Record<string, unknown>,
  controller: BrowserController,
  abortSignal?: AbortSignal,
  sessionId?: string,
): Promise<string> {
  log(`executeBrowserTool: ${toolName} args=${JSON.stringify(args).slice(0, 200)}`)

  try {
    throwIfAborted(abortSignal)
    switch (toolName) {
      case 'browser_navigate': {
        const url = args.url as string
        if (!url) return 'Error: url is required'
        const allowRepeat = args.allow_repeat === true
        const duplicate = !allowRepeat ? findRecentBrowserAction(sessionId, 'navigate', url) : null
        const activeBefore = controller.getActiveTab()
        if (duplicate && activePageLikelyMatchesTarget(activeBefore?.url, url)) {
          const secondsAgo = Math.max(1, Math.round((Date.now() - duplicate.updatedAt) / 1000))
          return `Skipped duplicate navigation to ${url}. The same navigation already succeeded ${secondsAgo}s ago and the current page still matches it. Read or verify the current page before navigating again.`
        }
        const result = await controller.navigate(null, url)
        if (!result.success) return `Error: ${result.error}`
        rememberBrowserAction(sessionId, 'navigate', url)
        // Wait a moment for page to start loading
        await sleepWithAbort(1500, abortSignal)
        const tabs = controller.getTabList()
        const active = tabs.find(t => t.active)
        return `Navigated to ${url}\nCurrent page: ${active?.title || 'Loading...'} (${active?.url || url})`
      }

      case 'browser_search': {
        const query = args.query as string
        if (!query) return 'Error: query is required'
        const allowRepeat = args.allow_repeat === true
        const duplicate = !allowRepeat ? findRecentBrowserAction(sessionId, 'search', query) : null
        const activeBefore = controller.getActiveTab()
        if (duplicate && /search|google|bing|duckduckgo|baidu/i.test(String(activeBefore?.url || ''))) {
          const secondsAgo = Math.max(1, Math.round((Date.now() - duplicate.updatedAt) / 1000))
          return `Skipped duplicate search for "${query}". The same search already ran ${secondsAgo}s ago. Reuse the current results page or read it before searching again.`
        }
        const preferred = String(args.engine || 'auto').toLowerCase() as SearchEngine
        const engines: SearchEngine[] = preferred === 'auto'
          ? ['duckduckgo', 'google', 'bing', 'baidu']
          : [preferred, 'duckduckgo', 'google', 'bing', 'baidu']
        const uniq = Array.from(new Set(engines))

        const errors: string[] = []
        for (const engine of uniq) {
          const targetUrl = searchUrl(engine, query)
          const result = await controller.navigate(null, targetUrl)
          if (!result.success) {
            errors.push(`${engine}: ${result.error || 'navigate failed'}`)
            continue
          }
          rememberBrowserAction(sessionId, 'search', query)
          const waitResult = await waitForReady(controller, null, 10_000, undefined, abortSignal)
          const rows = await extractSearchResults(controller, null)
          if (rows.length > 0) {
            return [
              `Searched "${query}" via ${engine}`,
              `Page ready: ${waitResult.ready} (${waitResult.elapsedMs}ms)`,
              '',
              ...rows.map((row, index) => `${index + 1}. ${row.title}\n   ${row.url}${row.snippet ? `\n   ${row.snippet}` : ''}`),
            ].join('\n')
          }
          const content = await controller.getPageContent(null).catch(() => '')
          if (content.trim().length > 0) {
            return `Searched "${query}" via ${engine}\nNo structured results parsed, fallback page text:\n${truncate(content, 6000)}`
          }
          errors.push(`${engine}: no content`)
        }
        return `Search failed for "${query}". Tried: ${uniq.join(', ')}.\n${errors.join('\n')}`
      }

      case 'browser_get_tabs': {
        const tabs = controller.getTabList()
        if (tabs.length === 0) return 'No tabs open.'
        return tabs.map(t =>
          `${t.active ? '▶ ' : '  '}[${t.id}] ${t.title}\n    ${t.url}`
        ).join('\n')
      }

      case 'browser_read_page': {
        const tabId = (args.tab_id as string) || null
        const content = await controller.getPageContent(tabId)
        if (!content || content.trim().length === 0) {
          return 'Page content is empty or still loading.'
        }
        return truncate(content)
      }

      case 'browser_click': {
        const selector = args.selector as string
        if (!selector) return 'Error: selector is required'
        const tabId = (args.tab_id as string) || null
        const clickJs = `
          (function() {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return 'Element not found: ${selector.replace(/'/g, "\\'")}';
            el.click();
            return 'Clicked: ' + (el.tagName || '') + (el.textContent ? ' "' + el.textContent.slice(0, 50) + '"' : '');
          })()
        `
        const result = await controller.executeJS(tabId, clickJs)
        return String(result)
      }

      case 'browser_click_text': {
        const text = String(args.text || '').trim()
        if (!text) return 'Error: text is required'
        const exact = args.exact === true
        const tabId = (args.tab_id as string) || null
        const result = await controller.executeJS(tabId, buildClickByTextJs(text, exact))
        return String(result)
      }

      case 'browser_type': {
        const selector = args.selector as string
        const text = args.text as string
        if (!selector || text === undefined) return 'Error: selector and text are required'
        const clearFirst = args.clear_first !== false // default true
        const tabId = (args.tab_id as string) || null
        const typeJs = `
          (function() {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return 'Element not found: ${selector.replace(/'/g, "\\'")}';
            el.focus();
            ${clearFirst ? 'el.value = "";' : ''}
            el.value = ${JSON.stringify(text)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return 'Typed "${text.slice(0, 50)}" into ' + el.tagName + (el.name ? '[name=' + el.name + ']' : '');
          })()
        `
        const result = await controller.executeJS(tabId, typeJs)
        return String(result)
      }

      case 'browser_type_smart': {
        const target = String(args.target || '').trim()
        const text = String(args.text || '')
        if (!target || text === undefined) return 'Error: target and text are required'
        const clearFirst = args.clear_first !== false
        const submit = args.submit === true
        const tabId = (args.tab_id as string) || null
        const shouldGuardSubmit = submit && await isLikelyChatPage(controller, tabId)
        const result = String(await controller.executeJS(tabId, buildSmartTypeJs({
          target,
          text,
          clearFirst,
          submit: submit && !shouldGuardSubmit,
        })))
        if (shouldGuardSubmit) {
          const attempted: string[] = ['type_smart_submit_guard']
          const submitState = await ensureGeminiSubmitted(controller, tabId, text, attempted, abortSignal)
          return `${result}\n[chat-submit-guard] submitted=${submitState.submitted} method=${submitState.method}`
        }
        return result
      }

      case 'browser_compose_message': {
        const text = String(args.text || '')
        if (!text) return 'Error: text is required'
        const target = String(args.target || '')
        const clearFirst = args.clear_first !== false
        const submit = args.submit !== false
        const tabId = (args.tab_id as string) || null
        const shouldGuardSubmit = submit && await isLikelyChatPage(controller, tabId)
        const result = String(await controller.executeJS(tabId, buildSmartTypeJs({
          target,
          text,
          clearFirst,
          submit: submit && !shouldGuardSubmit,
        })))
        if (shouldGuardSubmit) {
          const attempted: string[] = ['compose_submit_guard']
          const submitState = await ensureGeminiSubmitted(controller, tabId, text, attempted, abortSignal)
          return `${result}\n[chat-submit-guard] submitted=${submitState.submitted} method=${submitState.method}`
        }
        return result
      }

      case 'browser_capture_viewport': {
        const tabId = (args.tab_id as string) || null
        const mode = String(args.mode || 'viewport') as 'viewport' | 'clip' | 'full_page'
        const clipRaw = args.clip
        const clip = clipRaw && typeof clipRaw === 'object'
          ? {
            x: Number((clipRaw as Record<string, unknown>).x || 0),
            y: Number((clipRaw as Record<string, unknown>).y || 0),
            width: Number((clipRaw as Record<string, unknown>).width || 0),
            height: Number((clipRaw as Record<string, unknown>).height || 0),
          }
          : undefined
        const base64 = await controller.screenshotAdvanced(tabId, { mode, clip })
        const metrics = await controller.getViewportMetrics(tabId)
        const imageId = cacheScreenshot(base64, Math.round(metrics.width), Math.round(metrics.height))
        return JSON.stringify({
          image_id: imageId,
          width: Math.round(metrics.width),
          height: Math.round(metrics.height),
          mode,
        }, null, 2)
      }

      case 'browser_probe_workflow_state': {
        const startedAt = Date.now()
        const tabId = (args.tab_id as string) || null
        const prompt = String(args.prompt || '')
        const attachmentName = String(args.attachment_name || '')
        const includeCandidates = args.include_candidates !== false
        const visionAction = String(args.vision_action || '').trim() as '' | 'upload' | 'input' | 'send'
        const toolMeta = resolveToolContextMeta(controller, tabId)
        const [identity, uploadState, promptState, domState] = await Promise.all([
          getPageIdentity(controller, tabId),
          probeWorkflowUploadState(controller, tabId, attachmentName),
          probeWorkflowPromptSubmissionState(controller, tabId, prompt),
          probeWorkflowDomState(controller, tabId),
        ])

        const base64 = await controller.screenshotAdvanced(tabId, { mode: 'viewport' })
        const metrics = await controller.getViewportMetrics(tabId)
        const imageId = cacheScreenshot(base64, Math.round(metrics.width), Math.round(metrics.height))

        let uploadTargets: ActionTargetCandidate[] = []
        let inputTargets: ActionTargetCandidate[] = []
        let sendTargets: ActionTargetCandidate[] = []
        let activeInputTarget: ActionTargetCandidate | null = null
        let nearbySendTargets: ActionTargetCandidate[] = []

        if (includeCandidates) {
          ;[uploadTargets, inputTargets] = await Promise.all([
            locateActionTargets(controller, tabId, 'upload'),
            locateActionTargets(controller, tabId, 'input'),
          ])
          activeInputTarget = pickActiveInputTarget(inputTargets)
          if (activeInputTarget) {
            sendTargets = rankTargetsNearAnchor(await locateActionTargets(controller, tabId, 'send'), activeInputTarget)
            nearbySendTargets = sendTargets.some((item) => Boolean(item.nearActiveInput))
              ? sendTargets.filter((item) => Boolean(item.nearActiveInput)).slice(0, 4)
              : sendTargets.slice(0, 2)
          } else {
            sendTargets = await locateActionTargets(controller, tabId, 'send')
          }
        }

        let visionCandidates: ActionTargetCandidate[] = []
        if (
          visionAction &&
          ['upload', 'input', 'send'].includes(visionAction) &&
          (
            (visionAction === 'upload' && !uploadState.complete && uploadTargets.length === 0) ||
            (visionAction === 'input' && !promptState.promptFilled && inputTargets.length === 0) ||
            (visionAction === 'send' && !promptState.generating && sendTargets.length === 0)
          )
        ) {
          const domCandidates =
            visionAction === 'upload'
              ? uploadTargets
              : visionAction === 'input'
                ? inputTargets
                : sendTargets
          const analysis = await analyzeViewportWithVision({
            action: visionAction,
            title: identity.title,
            url: identity.url,
            screenshotBase64: base64,
            domCandidates,
          })
          visionCandidates = Array.isArray(analysis.analysis?.targets)
            ? analysis.analysis.targets
                .filter((target) => Number.isFinite(target.x) && Number.isFinite(target.y))
                .map((target) => ({
                  kind: target.kind === 'upload_launcher' ? 'launcher' : target.kind === 'prompt_input' ? 'prompt_input' : 'icon_button',
                  label: target.label,
                  x: target.x,
                  y: target.y,
                  confidence: target.confidence,
                  evidence: [target.reason || 'vision_candidate'],
                }))
            : []
        }

        return JSON.stringify({
          ok: true,
          ...toolMeta,
          latencyMs: Date.now() - startedAt,
          screenshot: {
            image_id: imageId,
            width: Math.round(metrics.width),
            height: Math.round(metrics.height),
            mode: 'viewport',
          },
          page: identity,
          uploadState,
          promptState,
          domState,
          candidates: includeCandidates
            ? {
                uploadTargets: uploadTargets.slice(0, 6),
                inputTargets: inputTargets.slice(0, 6),
                activeInputTarget,
                nearbySendTargets,
                sendTargets: sendTargets.slice(0, 6),
              }
            : undefined,
          visionCandidates,
          evidenceIds: uniqueStrings([
            ...uploadState.evidence,
            ...promptState.submitEvidence,
            ...(domState.bodyStateText ? ['body_state_observed'] : []),
            ...visionCandidates.flatMap((item) => item.evidence || []),
          ]),
        }, null, 2)
      }

      case 'browser_locate_action_targets': {
        const startedAt = Date.now()
        const tabId = (args.tab_id as string) || null
        const action = String(args.action || '').trim() as 'upload' | 'send' | 'close' | 'back'
        if (!['upload', 'send', 'close', 'back'].includes(action)) {
          return JSON.stringify({ ok: false, reason: 'invalid_action' }, null, 2)
        }
        const targets = await locateActionTargets(controller, tabId, action)
        const toolMeta = resolveToolContextMeta(controller, tabId)
        return JSON.stringify({
          ok: true,
          ...toolMeta,
          action,
          latencyMs: Date.now() - startedAt,
          count: targets.length,
          targets,
          evidenceIds: uniqueStrings(targets.flatMap((item) => item.evidence || [])),
        }, null, 2)
      }

      case 'browser_locate_input_targets': {
        const startedAt = Date.now()
        const tabId = (args.tab_id as string) || null
        const target = String(args.target || '').trim().toLowerCase()
        const ranked = await locateActionTargets(controller, tabId, 'input')
        const targets = target
          ? [...ranked].sort((a, b) => {
            const aMatch = String(a.label || '').toLowerCase().includes(target) ? 1 : 0
            const bMatch = String(b.label || '').toLowerCase().includes(target) ? 1 : 0
            if (aMatch !== bMatch) return bMatch - aMatch
            return Number(b.confidence || 0) - Number(a.confidence || 0)
          })
          : ranked
        const activeTarget = pickActiveInputTarget(targets) || pickActiveInputTarget(ranked)
        const anchorTarget = activeTarget || targets[0] || null
        const rankedSendTargets = anchorTarget
          ? rankTargetsNearAnchor(await locateActionTargets(controller, tabId, 'send'), anchorTarget)
          : []
        const nearbySendTargets = rankedSendTargets.some((item) => Boolean(item.nearActiveInput))
          ? rankedSendTargets.filter((item) => Boolean(item.nearActiveInput)).slice(0, 4)
          : rankedSendTargets.slice(0, 2)
        const toolMeta = resolveToolContextMeta(controller, tabId)
        return JSON.stringify({
          ok: true,
          ...toolMeta,
          latencyMs: Date.now() - startedAt,
          count: targets.length,
          targets,
          active_target: activeTarget,
          nearby_send_targets: nearbySendTargets,
          evidenceIds: uniqueStrings([
            ...targets.flatMap((item) => item.evidence || []),
            ...nearbySendTargets.flatMap((item) => item.evidence || []),
          ]),
        }, null, 2)
      }

      case 'browser_analyze_viewport': {
        const startedAt = Date.now()
        const tabId = (args.tab_id as string) || null
        const action = String(args.action || '').trim() as 'upload' | 'send' | 'close' | 'back' | 'input'
        if (!['upload', 'send', 'close', 'back', 'input'].includes(action)) {
          return JSON.stringify({ ok: false, reason: 'invalid_action' }, null, 2)
        }
        const includeDomCandidates = args.include_dom_candidates !== false
        const domCandidates = includeDomCandidates
          ? await locateActionTargets(controller, tabId, action)
          : []
        const screenshot = await controller.screenshotAdvanced(tabId, { mode: 'viewport' })
        const identity = await getPageIdentity(controller, tabId)
        const analysis = await analyzeViewportWithVision({
          action,
          title: identity.title,
          url: identity.url,
          screenshotBase64: screenshot,
          domCandidates,
        })
        const toolMeta = resolveToolContextMeta(controller, tabId)
        return JSON.stringify({
          ok: analysis.ok,
          ...toolMeta,
          action,
          latencyMs: Date.now() - startedAt,
          reason: analysis.reason,
          analysis: analysis.analysis || null,
          domCandidates,
          evidenceIds: uniqueStrings([
            ...domCandidates.flatMap((item) => item.evidence || []),
            ...((analysis.analysis?.targets || []).map((item) => String(item.reason || ''))),
          ]),
        }, null, 2)
      }

      case 'browser_list_upload_targets': {
        const tabId = (args.tab_id as string) || null
        const targets = await controller.findUploadTargets(tabId)
        return JSON.stringify({
          count: targets.length,
          targets,
        }, null, 2)
      }

      case 'browser_upload_scope_attachment': {
        const startedAt = Date.now()
        const uploadMetaFor = (effectiveTabId: string | null) => ({
          ...resolveToolContextMeta(controller, effectiveTabId),
          latencyMs: Date.now() - startedAt,
        })
        const attachments = await listScopeAttachmentsForTool(sessionId)
        const selected = selectScopeAttachment(attachments, args)
        if (selected.reason) {
          return JSON.stringify({
            ok: false,
            ...uploadMetaFor(null),
            reason: selected.reason,
            candidates: attachments.slice(0, 6),
          }, null, 2)
        }
        if (selected.ambiguous && selected.ambiguous.length > 0) {
          return JSON.stringify({
            ok: false,
            ...uploadMetaFor(null),
            reason: '存在多个候选附件，请补充 attachment_id 或 attachment_name。',
            candidates: selected.ambiguous,
          }, null, 2)
        }
        const attachment = selected.attachment
        if (!attachment) {
          return JSON.stringify({ ok: false, ...uploadMetaFor(null), reason: '未能选择附件。' }, null, 2)
        }
        if (!existsSync(attachment.path)) {
          return JSON.stringify({
            ok: false,
            ...uploadMetaFor(null),
            reason: `附件文件不存在: ${attachment.path}`,
            attachment,
          }, null, 2)
        }

        const tabId = (args.tab_id as string) || null
        const pageIdentity = await getPageIdentity(controller, tabId)
        const uploadMemoryKey = buildScopeUploadKey(sessionId, pageIdentity)
        const rememberedUpload = recentScopeUploads.get(uploadMemoryKey)
        if (
          rememberedUpload &&
          rememberedUpload.attachmentId === attachment.attachmentId &&
          rememberedUpload.attachmentPath === attachment.path &&
          Date.now() - rememberedUpload.uploadedAt <= RECENT_SCOPE_UPLOAD_TTL_MS
        ) {
          const rememberedVerification = await verifyUploadState(controller, tabId, attachment.name)
          if (rememberedVerification.success) {
            return JSON.stringify({
              ok: true,
              ...uploadMetaFor(tabId),
              skipped: true,
              reason: 'attachment_already_uploaded_on_current_page',
              attachment: {
                attachmentId: attachment.attachmentId,
                name: attachment.name,
                path: attachment.path,
              },
              verification: rememberedVerification,
              evidenceIds: uniqueStrings(rememberedVerification.evidence || []),
            }, null, 2)
          }
        }
        const selector = typeof args.selector === 'string' ? args.selector : undefined
        const targetText = typeof args.target === 'string' ? args.target : undefined
        const hasCoords = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))
        const mappedCoords = hasCoords
          ? await resolveCssPoint(controller, tabId, Number(args.x), Number(args.y))
          : null

        let targets = await locateActionTargets(controller, tabId, 'upload')
        let chosenTarget = chooseUploadTarget(targets, args)

        if (!chosenTarget && !selector && !targetText && !mappedCoords) {
          const identity = await getPageIdentity(controller, tabId)
          const screenshot = await controller.screenshotAdvanced(tabId, { mode: 'viewport' })
          const analyzed = await analyzeViewportWithVision({
            action: 'upload',
            title: identity.title,
            url: identity.url,
            screenshotBase64: screenshot,
            domCandidates: targets,
          })
          const visionTarget = analyzed.analysis?.targets?.[0]
          if (visionTarget && Number.isFinite(visionTarget.x) && Number.isFinite(visionTarget.y)) {
            chosenTarget = {
              kind: visionTarget.kind === 'upload_launcher' ? 'launcher' : 'icon_button',
              label: visionTarget.label,
              x: visionTarget.x,
              y: visionTarget.y,
              confidence: visionTarget.confidence,
              evidence: [visionTarget.reason || 'vision_candidate'],
            }
          }
        }

        if (chosenTarget && chosenTarget.kind !== 'input') {
          const openResult = await clickActionTarget(controller, tabId, chosenTarget, abortSignal)
          if (!openResult.ok) {
            const recovered = await attemptRecoverPageState(controller, tabId, abortSignal)
            return JSON.stringify({
              ok: false,
              ...uploadMetaFor(tabId),
              reason: 'failed_to_open_upload_path',
              attachment,
              target: chosenTarget,
              recovery: recovered,
              evidenceIds: uniqueStrings(chosenTarget?.evidence || []),
            }, null, 2)
          }
          await sleepWithAbort(220, abortSignal)
          targets = await locateActionTargets(controller, tabId, 'upload')
          const inputTarget = pickBestActionTarget(targets.filter((item) => item.kind === 'input'), ['input'])
          if (inputTarget) {
            chosenTarget = inputTarget
          }
        }

        const effectiveSelector = selector
          || chosenTarget?.associatedInputSelector
          || (chosenTarget?.kind === 'input' ? chosenTarget.selectorHint : undefined)

        const effectiveCoords = chosenTarget && Number.isFinite(chosenTarget.x) && Number.isFinite(chosenTarget.y)
          ? await resolveCssPoint(controller, tabId, Number(chosenTarget.x), Number(chosenTarget.y))
          : mappedCoords

        const setResult = await controller.setFileInputFiles(tabId, {
          files: [attachment.path],
          selector: effectiveSelector,
          target: targetText,
          x: effectiveCoords?.cssX,
          y: effectiveCoords?.cssY,
        })
        if (!setResult.ok) {
          return JSON.stringify({
            ok: false,
            ...uploadMetaFor(tabId),
            reason: '未找到可用的上传入口。',
            attachment,
            candidates: targets.slice(0, 8),
            target: setResult.targetDescription,
            evidenceIds: uniqueStrings(targets.flatMap((item) => item.evidence || [])),
          }, null, 2)
        }

        await settleAfterAction(controller, tabId, abortSignal)
        const verification = await verifyUploadState(controller, tabId, attachment.name)
        const assignedNames = Array.isArray(setResult.assignedFileNames) ? setResult.assignedFileNames : []
        const fileAssigned = Boolean(setResult.filesAssigned) &&
          assignedNames.some((name) => String(name || '').toLowerCase().includes(attachment.name.toLowerCase()))
        const effectiveVerification = verification.success
          ? verification
          : fileAssigned
            ? {
              success: false,
              reason: 'input_files_assigned_pending_page_verification',
              evidence: uniqueStrings([...(verification.evidence || []), 'input_files_assigned']),
            }
            : verification
        if (effectiveVerification.success) {
          recentScopeUploads.set(uploadMemoryKey, {
            attachmentId: attachment.attachmentId,
            attachmentPath: attachment.path,
            pageKey: uploadMemoryKey,
            uploadedAt: Date.now(),
          })
        }
        return JSON.stringify({
          ok: effectiveVerification.success,
          ...uploadMetaFor(tabId),
          attachment: {
            attachmentId: attachment.attachmentId,
            name: attachment.name,
            path: attachment.path,
          },
          chosenTarget,
          target: setResult.targetDescription,
          setResult: {
            filesAssigned: Boolean(setResult.filesAssigned),
            assignedFileNames: assignedNames,
          },
          verification: effectiveVerification,
          evidenceIds: uniqueStrings([
            ...(effectiveVerification.evidence || []),
            ...(chosenTarget?.evidence || []),
          ]),
        }, null, 2)
      }

      case 'browser_collect_images': {
        const tabId = (args.tab_id as string) || null
        const keyword = String(args.keyword || '').trim().toLowerCase()
        const limit = Math.max(1, Math.min(60, Number(args.limit || 20)))
        const minWidth = Math.max(1, Math.min(4000, Number(args.min_width || 120)))
        const rows = await controller.executeJS(
          tabId,
          `
            (() => {
              const keyword = ${JSON.stringify(keyword)}
              const maxCount = ${JSON.stringify(limit)}
              const minWidth = ${JSON.stringify(minWidth)}
              const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
              const isVisible = (el) => {
                if (!(el instanceof Element)) return false
                const rect = el.getBoundingClientRect()
                if (!rect || rect.width < minWidth || rect.height < 40) return false
                const style = getComputedStyle(el)
                if (!style) return false
                return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0
              }
              const items = []
              const seen = new Set()
              const imgs = Array.from(document.querySelectorAll('img'))
              for (const img of imgs) {
                if (!(img instanceof HTMLImageElement)) continue
                if (!isVisible(img)) continue
                const src = normalize(img.currentSrc || img.src || img.getAttribute('data-src') || '')
                if (!src || !/^https?:\\/\\//i.test(src)) continue
                if (seen.has(src)) continue
                const alt = normalize(img.alt || img.getAttribute('title') || '')
                const scoreText = (src + ' ' + alt).toLowerCase()
                if (keyword && !scoreText.includes(keyword)) continue
                seen.add(src)
                items.push({
                  url: src,
                  alt,
                  width: Math.round(img.naturalWidth || img.width || img.getBoundingClientRect().width || 0),
                  height: Math.round(img.naturalHeight || img.height || img.getBoundingClientRect().height || 0),
                })
                if (items.length >= maxCount) break
              }
              return items
            })()
          `,
        ) as Array<{ url?: string; alt?: string; width?: number; height?: number }> | null

        const images = (Array.isArray(rows) ? rows : [])
          .map((item) => ({
            url: String(item.url || ''),
            alt: String(item.alt || ''),
            width: Number(item.width || 0),
            height: Number(item.height || 0),
          }))
          .filter((item) => item.url.length > 0)

        return JSON.stringify({
          count: images.length,
          images,
        }, null, 2)
      }

      case 'browser_download_urls': {
        const rawUrls = Array.isArray(args.urls) ? args.urls : []
        const urls = rawUrls
          .map((item) => String(item || '').trim())
          .filter((item) => item.length > 0)
          .slice(0, 20)
        if (urls.length === 0) return 'Error: urls is required and must be a non-empty array'

        const tabId = (args.tab_id as string) || null
        const overwrite = args.overwrite === true
        const directory = expandHomePath(String(args.directory || '~/Documents'))
        const filenamePrefix = sanitizeFilename(String(args.filename_prefix || '').trim(), 'download')

        await mkdir(directory, { recursive: true })
        try {
          await access(directory, fsConstants.W_OK)
        } catch {
          return `Error: target directory is not writable: ${directory}`
        }

        let referer = ''
        try {
          referer = String(await controller.executeJS(tabId, 'window.location.href') || '')
        } catch {
          referer = ''
        }

        const results: Array<Record<string, unknown>> = []
        for (let index = 0; index < urls.length; index += 1) {
          const url = urls[index]
          if (!/^https?:\/\//i.test(url)) {
            results.push({ url, success: false, error: 'unsupported_protocol' })
            continue
          }

          try {
            const response = await fetch(url, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Ready Browser Agent)',
                ...(referer ? { Referer: referer } : {}),
              },
            })
            if (!response.ok) {
              results.push({
                url,
                success: false,
                error: `http_${response.status}`,
              })
              continue
            }

            const contentType = response.headers.get('content-type') || ''
            const buffer = Buffer.from(await response.arrayBuffer())
            const fallbackBase = filenamePrefix
              ? `${filenamePrefix}-${index + 1}`
              : `download-${index + 1}`
            const parts = inferFilenameParts(url, fallbackBase, contentType)
            const filePath = await writeFileSmart(directory, parts.base, parts.ext, buffer, overwrite)
            results.push({
              url,
              success: true,
              path: filePath,
              size: buffer.byteLength,
              content_type: contentType,
            })
          } catch (error) {
            results.push({
              url,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }

        const successCount = results.filter((item) => item.success === true).length
        return JSON.stringify({
          directory,
          total: results.length,
          success: successCount,
          failed: results.length - successCount,
          results,
        }, null, 2)
      }

      case 'browser_click_at': {
        const x = Number(args.x)
        const y = Number(args.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Error: x and y are required numbers'
        const tabId = (args.tab_id as string) || null
        const point = await dispatchClickAt(controller, tabId, x, y)
        await settleAfterAction(controller, tabId, abortSignal)
        return JSON.stringify({
          ok: true,
          normalized: { x: point.nx, y: point.ny },
          css: { x: point.cssX, y: point.cssY },
          viewport: { width: point.width, height: point.height },
        }, null, 2)
      }

      case 'browser_type_at': {
        const x = Number(args.x)
        const y = Number(args.y)
        const text = String(args.text || '')
        if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Error: x and y are required numbers'
        if (!text) return 'Error: text is required'
        const tabId = (args.tab_id as string) || null
        const pressEnter = args.press_enter !== false
        const clearBeforeTyping = args.clear_before_typing !== false
        const useShiftEnter = args.use_shift_enter_for_newline === true
        const point = await dispatchClickAt(controller, tabId, x, y)
        if (clearBeforeTyping) {
          await clearFocusedInput(controller, tabId)
        }
        await controller.typeTextDirectly(tabId, text, { useShiftEnterForNewline: useShiftEnter })
        if (pressEnter) {
          await sendKeyStroke(controller, tabId, 'Enter')
        }
        await settleAfterAction(controller, tabId, abortSignal)
        return JSON.stringify({
          ok: true,
          normalized: { x: point.nx, y: point.ny },
          css: { x: point.cssX, y: point.cssY },
          submitted: pressEnter,
          text_length: text.length,
        }, null, 2)
      }

      case 'browser_scroll_at': {
        const tabId = (args.tab_id as string) || null
        const x = Number(args.x ?? 500)
        const y = Number(args.y ?? 500)
        const direction = String(args.direction || '').toLowerCase()
        if (!['up', 'down', 'left', 'right'].includes(direction)) {
          return 'Error: direction must be up/down/left/right'
        }
        const magnitude = Math.max(40, Math.min(4000, Number(args.magnitude || 800)))
        const point = await resolveCssPoint(controller, tabId, x, y)
        const deltaY = direction === 'up' ? -magnitude : direction === 'down' ? magnitude : 0
        const deltaX = direction === 'left' ? -magnitude : direction === 'right' ? magnitude : 0
        await controller.dispatchMouse(tabId, {
          type: 'mouseWheel',
          x: point.cssX,
          y: point.cssY,
          deltaX,
          deltaY,
          button: 'none',
          buttons: 0,
        })
        return `Scrolled ${direction} at normalized(${point.nx},${point.ny})`
      }

      case 'browser_send_keys': {
        const tabId = (args.tab_id as string) || null
        const key = String(args.key || '').trim()
        if (!key) return 'Error: key is required'
        await sendKeyStroke(controller, tabId, key, args.modifiers)
        return `Sent key: ${key}`
      }

      case 'browser_ask_user_takeover': {
        const callToAction = String(args.call_to_action || '').trim()
        if (!callToAction) return 'Error: call_to_action is required'
        const details = String(args.details || '')
        const timeoutSec = Math.max(30, Math.min(1200, Number(args.timeout_sec || 300)))
        log(`[browser-v3][human-required] action=${callToAction} timeout=${timeoutSec}s`)
        return JSON.stringify({
          phase: 'human_required',
          takeover_state: 'submitted',
          call_to_action: callToAction,
          details,
          timeout_sec: timeoutSec,
          next_step: 'wait for user takeover result: submitted|skipped|timeout',
        }, null, 2)
      }

      case 'browser_query_gemini': {
        const text = String(args.text || '').trim()
        if (!text) return 'Error: text is required'
        const tabId = (args.tab_id as string) || null
        const waitResponseMs = Math.max(6000, Math.min(120_000, Number(args.wait_response_ms || 35_000)))
        return await runGeminiQuery(controller, text, tabId, waitResponseMs, abortSignal)
      }

      case 'browser_wait': {
        const timeoutMs = Number(args.timeout_ms || 8000)
        const selector = typeof args.selector === 'string' ? args.selector : undefined
        const tabId = (args.tab_id as string) || null
        const ready = await waitForReady(controller, tabId, Math.max(500, Math.min(timeoutMs, 30_000)), selector, abortSignal)
        return `Wait result: ready=${ready.ready}, selectorMatched=${ready.matchedSelector}, elapsed=${ready.elapsedMs}ms`
      }

      case 'browser_run_workflow': {
        const stepsRaw = args.steps
        if (!Array.isArray(stepsRaw)) return 'Error: steps must be an array'
        const tabId = (args.tab_id as string) || null
        const continueOnError = args.continue_on_error === true
        const lines: string[] = []
        for (let index = 0; index < stepsRaw.length; index += 1) {
          const step = stepsRaw[index]
          if (!step || typeof step !== 'object') {
            lines.push(`Step ${index + 1}: Error: invalid step`)
            if (!continueOnError) break
            continue
          }
          const result = await runWorkflowStep(controller, step as Record<string, unknown>, tabId, abortSignal)
          lines.push(`Step ${index + 1}: ${result}`)
          if (!continueOnError && result.startsWith('Error:')) {
            break
          }
        }
        return truncate(lines.join('\n'))
      }

      case 'browser_execute_js': {
        const code = args.code as string
        if (!code) return 'Error: code is required'
        const tabId = (args.tab_id as string) || null
        log(`Executing JS: ${code.slice(0, 100)}`)
        const result = await controller.executeJS(tabId, code)
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        return truncate(resultStr ?? 'undefined')
      }

      case 'browser_go_back': {
        const tabId = (args.tab_id as string) || null
        const result = controller.goBack(tabId)
        if (!result.success) return `Error: ${result.error}`
        return 'Navigated back.'
      }

      default:
        return `Unknown browser tool: ${toolName}`
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log(`Browser tool error: ${msg}`)
    return `Error executing ${toolName}: ${msg}`
  }
}
