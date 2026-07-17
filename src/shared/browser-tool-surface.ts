import type { BrowserPowerEffect } from './browser-power'

export type BrowserToolLayer = 'read' | 'interaction' | 'long_task' | 'advanced'
export type BrowserToolAccess = 'read' | 'write'
export type BrowserToolIntent =
  | 'reading'
  | 'interaction'
  | 'observation'
  | 'site_research'
  | 'collection'
  | 'batch_collection'
  | 'advanced'

export interface BrowserToolSurfaceEntry {
  name: string
  layer: BrowserToolLayer
  defaultAccess: BrowserToolAccess
  effects: readonly BrowserPowerEffect[]
  intents: readonly BrowserToolIntent[]
  requiresAttachment?: boolean
}

const READ = ['reading', 'interaction', 'observation', 'site_research', 'collection'] as const
const OBSERVE_AND_COLLECT = ['observation', 'collection'] as const

/**
 * The only model-visible browser tool manifest. Schema, exposure, lease and
 * documentation checks derive from this list so a new tool cannot be added to
 * one surface while silently missing the others.
 */
export const BROWSER_TOOL_SURFACE_MANIFEST = [
  { name: 'browser_tabs', layer: 'read', defaultAccess: 'read', effects: ['observe'], intents: READ },
  { name: 'browser_navigate', layer: 'read', defaultAccess: 'write', effects: ['navigate'], intents: READ },
  { name: 'browser_search', layer: 'read', defaultAccess: 'write', effects: ['navigate'], intents: ['reading', 'interaction', 'observation', 'site_research', 'collection'] },
  { name: 'browser_snapshot', layer: 'read', defaultAccess: 'read', effects: ['observe'], intents: READ },
  { name: 'browser_find', layer: 'read', defaultAccess: 'read', effects: ['observe'], intents: READ },
  { name: 'browser_read', layer: 'read', defaultAccess: 'read', effects: ['observe'], intents: READ },
  { name: 'browser_screenshot', layer: 'read', defaultAccess: 'read', effects: ['observe'], intents: ['reading', 'interaction', 'observation', 'site_research', 'collection'] },
  { name: 'browser_wait', layer: 'read', defaultAccess: 'read', effects: ['observe'], intents: READ },

  { name: 'browser_click', layer: 'interaction', defaultAccess: 'write', effects: ['page_mutation'], intents: ['interaction', 'site_research'] },
  { name: 'browser_type', layer: 'interaction', defaultAccess: 'write', effects: ['page_mutation'], intents: ['interaction', 'site_research'] },
  { name: 'browser_fill_form', layer: 'interaction', defaultAccess: 'write', effects: ['page_mutation'], intents: ['interaction'] },
  { name: 'browser_select', layer: 'interaction', defaultAccess: 'write', effects: ['page_mutation'], intents: [] },
  { name: 'browser_hover', layer: 'interaction', defaultAccess: 'write', effects: ['page_mutation'], intents: [] },
  { name: 'browser_scroll', layer: 'interaction', defaultAccess: 'write', effects: ['page_mutation'], intents: ['interaction', 'observation', 'site_research', 'collection'] },
  { name: 'browser_press_key', layer: 'interaction', defaultAccess: 'write', effects: ['page_mutation'], intents: ['interaction', 'site_research'] },
  { name: 'browser_drag', layer: 'interaction', defaultAccess: 'write', effects: ['page_mutation'], intents: [] },
  { name: 'browser_upload', layer: 'interaction', defaultAccess: 'write', effects: ['upload'], intents: [], requiresAttachment: true },
  { name: 'browser_dialog', layer: 'interaction', defaultAccess: 'read', effects: ['observe'], intents: ['interaction'] },
  { name: 'browser_request_takeover', layer: 'interaction', defaultAccess: 'write', effects: ['challenge_interaction'], intents: ['interaction', 'observation', 'site_research', 'collection', 'batch_collection'] },

  { name: 'browser_research', layer: 'long_task', defaultAccess: 'write', effects: ['observe', 'navigate'], intents: ['site_research'] },
  { name: 'browser_collect', layer: 'long_task', defaultAccess: 'write', effects: ['observe', 'navigate', 'download'], intents: ['collection', 'batch_collection'] },
  { name: 'browser_download', layer: 'long_task', defaultAccess: 'write', effects: ['download'], intents: ['collection', 'batch_collection'] },
  { name: 'browser_archive', layer: 'long_task', defaultAccess: 'write', effects: ['download'], intents: [] },
  { name: 'browser_task', layer: 'long_task', defaultAccess: 'read', effects: ['observe'], intents: ['site_research', 'collection', 'batch_collection'] },

  { name: 'browser_status', layer: 'advanced', defaultAccess: 'read', effects: ['observe'], intents: ['observation', 'site_research', 'collection'] },
  { name: 'browser_console', layer: 'advanced', defaultAccess: 'read', effects: ['observe'], intents: ['advanced'] },
  { name: 'browser_network', layer: 'advanced', defaultAccess: 'read', effects: ['observe'], intents: ['advanced'] },
  { name: 'browser_resources', layer: 'advanced', defaultAccess: 'read', effects: ['observe'], intents: ['observation', 'collection', 'advanced'] },
  { name: 'browser_eval', layer: 'advanced', defaultAccess: 'write', effects: ['observe', 'page_mutation'], intents: ['advanced'] },
  { name: 'browser_cdp', layer: 'advanced', defaultAccess: 'write', effects: ['observe', 'page_mutation'], intents: ['advanced'] },
  { name: 'browser_session', layer: 'advanced', defaultAccess: 'read', effects: ['observe'], intents: ['advanced'] },
  { name: 'browser_permission', layer: 'advanced', defaultAccess: 'read', effects: ['observe'], intents: ['advanced'] },
] as const satisfies readonly BrowserToolSurfaceEntry[]

export type BrowserPublicToolName = (typeof BROWSER_TOOL_SURFACE_MANIFEST)[number]['name']

export const BROWSER_PUBLIC_TOOL_NAMES = BROWSER_TOOL_SURFACE_MANIFEST.map((entry) => entry.name) as BrowserPublicToolName[]

const MANIFEST_BY_NAME = new Map<BrowserPublicToolName, (typeof BROWSER_TOOL_SURFACE_MANIFEST)[number]>(
  BROWSER_TOOL_SURFACE_MANIFEST.map((entry) => [entry.name, entry]),
)

export function browserToolSurfaceEntry(name: string): BrowserToolSurfaceEntry | null {
  return MANIFEST_BY_NAME.get(name as BrowserPublicToolName) || null
}

export function isBrowserPublicToolName(name: string): name is BrowserPublicToolName {
  return MANIFEST_BY_NAME.has(name as BrowserPublicToolName)
}

export function browserToolNamesForIntent(intent: BrowserToolIntent): BrowserPublicToolName[] {
  return BROWSER_TOOL_SURFACE_MANIFEST
    .filter((entry) => (entry.intents as readonly BrowserToolIntent[]).includes(intent))
    .map((entry) => entry.name)
}

/** Decide only the common 8-tool reading surface versus the common interaction
 * surface. Specialist primitives remain independently on-demand. */
export function browserBaseIntentForInstruction(userText: string): 'reading' | 'interaction' {
  return /(?:点击|点开|双击|输入|填写|填表|提交|发布|发送|上传|登录|注册|勾选|取消勾选|按下|快捷键|滚动|翻页|切换标签|关闭标签|click|type|fill|submit|publish|send|upload|log\s*in|sign\s*in|press|scroll)/i.test(
    String(userText || ''),
  )
    ? 'interaction'
    : 'reading'
}

/** Rare primitives and specialist tools are added only when the current user
 * instruction names the matching operation. Callers must pass the canonical
 * primary instruction, never recalled context or page text. */
export function browserOnDemandToolNames(userText: string): BrowserPublicToolName[] {
  const text = String(userText || '')
  const names: BrowserPublicToolName[] = []
  if (/(下拉|选择[^\n]{0,12}选项|dropdown|\bselect\b)/i.test(text)) names.push('browser_select')
  if (/(悬停|鼠标移到|mouseover|\bhover\b)/i.test(text)) names.push('browser_hover')
  if (/(拖拽|拖动|排序|\bdrag\b)/i.test(text)) names.push('browser_drag')
  if (/(alert|confirm|prompt|网页弹窗|javascript 弹窗|离开页面提示)/i.test(text)) names.push('browser_dialog')
  if (/(归档|存成\s*(?:pdf|mhtml|html|markdown)|网页快照文件|\barchive\b)/i.test(text)) names.push('browser_archive')
  if (/(?:下载|保存).{0,20}(?:网页资源|视频|音频|媒体|文件)|\bdownload\b/i.test(text)) names.push('browser_download')
  if (/(?:后台|长时|继续|恢复|取消).{0,12}(?:采集|浏览器任务)|浏览器任务.{0,12}(?:状态|结果)|\bresume\b.{0,12}\bbrowser/i.test(text)) names.push('browser_task')
  if (/(?:浏览器|网页).{0,12}(?:状态|最近动作|恢复建议)|\bbrowser[_ -]?status\b/i.test(text)) names.push('browser_status')
  if (/(?:控制台|console).{0,12}(?:日志|报错|错误|清空|查看)|(?:查看|读取|清空).{0,12}(?:控制台|console)/i.test(text)) names.push('browser_console')
  if (/(?:网络|network).{0,12}(?:请求|响应|瀑布|时间线|追踪|监听)|(?:抓包|网络追踪|监听网络)/i.test(text)) names.push('browser_network')
  if (/(?:发现|检查|嗅探|列出|下载).{0,16}(?:页面资源|视频资源|音频资源|媒体资源|流媒体)|资源嗅探|resource\s*(?:inspect|forensic)/i.test(text)) names.push('browser_resources')
  if (/(?:执行|运行|用).{0,12}(?:javascript|js\s*脚本|页面脚本)|\b(?:browser_)?eval\b/i.test(text)) names.push('browser_eval')
  if (/(?:调用|使用|通过).{0,12}(?:cdp|devtools protocol|chrome devtools)|\bcdp\b/i.test(text)) names.push('browser_cdp')
  if (/(?:浏览器|站点|登录).{0,12}(?:会话|session|cookie|站点数据|配置档案)|(?:切换|清理|查看).{0,12}(?:会话|session|cookie|站点数据)/i.test(text)) names.push('browser_session')
  if (/(?:浏览器|站点|网页).{0,12}(?:权限|permission)|(?:设置|重置|查看).{0,12}(?:摄像头|麦克风|定位|通知).{0,8}权限/i.test(text)) names.push('browser_permission')
  return names
}
