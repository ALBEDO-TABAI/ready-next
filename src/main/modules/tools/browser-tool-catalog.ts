import {
  normalizeAnthropicToolSchema,
  normalizeOpenAIToolSchema,
  type ToolParamSchemaSpec,
} from './tool-schema'
import { z } from 'zod'
import { BROWSER_TOOL_SCHEMAS, type BrowserToolSchemaName } from './schemas/browser-tool-schemas'
import { zodObjectToParamList } from './zod-param-derivation'
import type { BrowserPowerEffect } from '../../../shared/browser-power'
import {
  BROWSER_PUBLIC_TOOL_NAMES,
  BROWSER_TOOL_SURFACE_MANIFEST,
  type BrowserPublicToolName,
} from '../../../shared/browser-tool-surface'

export type BrowserToolDef = {
  name: BrowserPublicToolName
  description: string
  params: ToolParamSchemaSpec[]
  effectProfile: {
    effects: BrowserPowerEffect[]
    destructive?: boolean
  }
}

const DESCRIPTIONS: Record<BrowserPublicToolName, string> = {
  browser_tabs: '列出、打开、切换或关闭浏览器标签页；返回标签、来源页和当前任务绑定。',
  browser_navigate: '在绑定标签页打开地址、后退、前进或刷新，并保留任务与标签绑定。',
  browser_search: '在外部搜索引擎或当前站点内搜索，并在绑定标签页打开结果页。',
  browser_snapshot: '读取当前文档的紧凑可访问结构与稳定目标引用；后续定位优先使用这些引用。',
  browser_find: '在当前页面快照中按文本、角色或用途查找目标，不重复扫描整页。',
  browser_read: '读取当前页正文、指定区域或目标引用对应的内容。',
  browser_screenshot: '返回当前页面的真实截图；可按需附加内部视觉分析。',
  browser_wait: '等待页面就绪、选择器、文本、URL、网络安静或内容稳定。',
  browser_click: '按目标引用、语义、选择器或坐标点击；动作后返回可核验结果。',
  browser_type: '在目标输入区输入内容；自动选择快速填充或逐键输入，可按要求提交。',
  browser_fill_form: '一次填写多个表单字段，并逐项核验写入结果。',
  browser_select: '在下拉框、列表框或可选择控件中选择一个或多个值。',
  browser_hover: '把可信鼠标移动到目标上，触发展开或提示状态。',
  browser_scroll: '滚动页面或指定容器，并核验滚动是否生效。',
  browser_press_key: '发送按键或组合键，例如 Enter、Escape、Tab、Meta+L。',
  browser_drag: '在两个目标或坐标之间执行可信拖拽并核验结果。',
  browser_upload: '把当前任务明确提供的一个或多个附件上传到页面。',
  browser_dialog: '读取并处理当前页面的 alert、confirm、prompt 或离开页面提示。',
  browser_request_takeover: '验证码、安全验证、Passkey 或需要人工判断时请求用户接管，并保留续跑点。',
  browser_research: '在当前登录站点或指定 URL 集中逐项研究，保留查询覆盖、来源证据、详情正文与续跑断点；调用后不得逐关键词另开标签页回退。',
  browser_collect: '采集图片、结构化内容、长列表或逐篇详情；长任务返回可续跑句柄。',
  browser_download: '通过当前浏览器会话流式下载 URL、页面资源或采集结果，并校验文件。',
  browser_archive: '把当前页面归档为 PDF、MHTML、HTML 或 Markdown。',
  browser_task: '查询、继续、取消后台浏览器任务或读取完整/部分结果。',
  browser_status: '读取当前页面、标签绑定、动作结果、上传/提交状态与恢复建议。',
  browser_console: '读取或清空当前页面的受限控制台日志。',
  browser_network: '采集或读取当前页面的受限网络请求、响应摘要与时间线。',
  browser_resources: '发现当前页的图片、音视频、文档和流媒体资源及其证据。',
  browser_eval: '在绑定页面执行高级 JavaScript；效果由代码和输出通道推导，不接受模型自报。',
  browser_cdp: '调用受控 Chrome DevTools Protocol 方法；权限由方法和参数推导。',
  browser_session: '查看登录态，清理当前站点数据，或切换已配置的受控会话配置。',
  browser_permission: '查看、设置或重置当前站点的受控浏览器权限。',
}

export const BROWSER_INTERACTION_TOOL_NAMES = BROWSER_TOOL_SURFACE_MANIFEST
  .filter((entry) => entry.layer === 'read' || entry.layer === 'interaction')
  .map((entry) => entry.name)

export const BROWSER_CONTENT_TASK_TOOL_NAMES = BROWSER_TOOL_SURFACE_MANIFEST
  .filter((entry) => entry.layer === 'long_task' || entry.layer === 'advanced')
  .map((entry) => entry.name)

export const BROWSER_TOOLS: BrowserToolDef[] = BROWSER_PUBLIC_TOOL_NAMES.map((name) => {
  const surface = BROWSER_TOOL_SURFACE_MANIFEST.find((entry) => entry.name === name)
  if (!surface) throw new Error(`Browser tool surface metadata missing: ${name}`)
  const schema = BROWSER_TOOL_SCHEMAS[name as BrowserToolSchemaName]
  if (!schema) throw new Error(`Browser tool schema missing: ${name}`)
  return {
    name,
    description: DESCRIPTIONS[name],
    params: zodObjectToParamList(schema) as ToolParamSchemaSpec[],
    effectProfile: {
      effects: [...surface.effects],
      destructive: surface.effects.some((effect) => ['payment', 'remote_delete', 'account_delete', 'credential_change', 'secret_export', 'access_control_circumvention'].includes(effect)),
    },
  }
})

function browserWireSchema(name: BrowserPublicToolName): Record<string, unknown> {
  const schema = z.toJSONSchema(BROWSER_TOOL_SCHEMAS[name as BrowserToolSchemaName]) as Record<string, unknown>
  const { $schema: _schema, ...wire } = schema
  if (name === 'browser_research') {
    wire.allOf = [
      {
        if: { properties: { scope: { const: 'current_site' } }, required: ['scope'] },
        then: { required: ['queries'] },
      },
      {
        if: { properties: { scope: { const: 'url_set' } }, required: ['scope'] },
        then: { required: ['urls'] },
      },
    ]
  }
  if (name === 'browser_navigate') {
    wire.allOf = [{
      if: {
        anyOf: [
          { properties: { action: { const: 'open' } }, required: ['action'] },
          { not: { required: ['action'] } },
        ],
      },
      then: { required: ['url'] },
    }]
  }
  if (name === 'browser_tabs') {
    wire.allOf = [{
      if: { properties: { action: { enum: ['switch', 'close'] } }, required: ['action'] },
      then: { required: ['tab_id'] },
    }]
  }
  if (name === 'browser_wait') {
    wire.allOf = [
      { if: { properties: { condition: { const: 'selector' } }, required: ['condition'] }, then: { required: ['selector'] } },
      { if: { properties: { condition: { const: 'text' } }, required: ['condition'] }, then: { required: ['text'] } },
      { if: { properties: { condition: { const: 'url' } }, required: ['condition'] }, then: { required: ['url'] } },
    ]
  }
  if (name === 'browser_download') {
    wire.allOf = [
      { if: { properties: { mode: { const: 'urls' } }, required: ['mode'] }, then: { required: ['urls'] } },
      { if: { properties: { mode: { const: 'collected' } }, required: ['mode'] }, then: { required: ['source_task_id'] } },
      { if: { properties: { mode: { enum: ['page', 'media', 'gallery'] } }, required: ['mode'] }, then: { required: ['url'] } },
      {
        if: { properties: { mode: { const: 'resolve' } }, required: ['mode'] },
        then: {
          anyOf: [
            { required: ['page_url'] },
            { required: ['url'] },
            { required: ['video_url'] },
            { required: ['sources'] },
          ],
        },
      },
    ]
  }
  return wire
}

export function getBrowserAnthropicTools(): Array<Record<string, unknown>> {
  return BROWSER_TOOLS.map((tool) => normalizeAnthropicToolSchema({
    name: tool.name,
    description: tool.description,
    input_schema: browserWireSchema(tool.name),
  }))
}

export function getBrowserOpenAITools(): Array<Record<string, unknown>> {
  return BROWSER_TOOLS.map((tool) => normalizeOpenAIToolSchema({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: browserWireSchema(tool.name),
    },
  }))
}
