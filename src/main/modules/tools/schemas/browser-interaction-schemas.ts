/**
 * Zod schemas for the 25 browser_interaction domain tools (Phase 2.5 PR 9).
 *
 * Shape notes:
 * - `tab_id` is optional on almost every tool — shared constant.
 * - Arrays default to `z.array(z.string())` because the legacy
 *   `toSchemaParam` emits `items:{type:'string'}` for strings; the one tool
 *   with structured items is `browser_run_workflow.steps` (belongs to
 *   content-task PR 10), so for interaction we only hit string arrays.
 * - Objects use `z.record(z.string(), z.unknown())` so derivation emits
 *   `{type: 'object'}` without recursing into properties.
 *
 * Pure module — Zod only.
 */

import { z } from 'zod'

const TabIdOptional = z.string().optional().describe('标签页 ID，留空则使用当前活跃标签页')

export const BrowserNavigateSchema = z.object({
  url: z.string().describe('要导航到的完整 URL (http/https)'),
  tab_id: z.string().optional().describe('可选：在指定标签页导航（留空使用当前活跃页）'),
})

export const BrowserSearchSchema = z.object({
  query: z.string().describe('搜索关键词'),
  engine: z
    .enum(['auto', 'google', 'duckduckgo', 'bing', 'baidu'])
    .optional()
    .describe('搜索引擎：auto/google/duckduckgo/bing/baidu，默认 auto'),
  tab_id: z.string().optional().describe('可选：在指定标签页搜索（留空使用当前活跃页）'),
})

export const BrowserGetTabsSchema = z.object({})

export const BrowserReadPageSchema = z.object({
  tab_id: TabIdOptional,
})

export const BrowserClickSchema = z.object({
  selector: z.string().describe('CSS 选择器，例如 "button.submit" 或 "#search-btn"'),
  tab_id: TabIdOptional,
})

export const BrowserClickTextSchema = z.object({
  text: z.string().describe('要点击的可见文本（支持部分匹配）'),
  exact: z.boolean().optional().describe('是否精确匹配文本，默认 false'),
  tab_id: TabIdOptional,
})

export const BrowserTypeSchema = z.object({
  selector: z.string().describe('CSS 选择器，定位输入框元素'),
  text: z.string().describe('要输入的文字'),
  clear_first: z.boolean().optional().describe('是否先清空输入框（默认 true）'),
  tab_id: TabIdOptional,
})

export const BrowserTypeSmartSchema = z.object({
  target: z.string().describe('输入框目标，如 "搜索框" / "邮箱"'),
  text: z.string().describe('输入文本'),
  submit: z.boolean().optional().describe('输入后是否回车提交，默认 false'),
  clear_first: z.boolean().optional().describe('是否先清空，默认 true'),
  tab_id: TabIdOptional,
})

export const BrowserComposeMessageSchema = z.object({
  text: z.string().describe('要输入的内容'),
  target: z.string().optional().describe('可选目标描述，如“搜索框”“消息输入框”'),
  submit: z.boolean().optional().describe('输入后是否自动发送，默认 true'),
  clear_first: z.boolean().optional().describe('是否先清空输入框，默认 true'),
  tab_id: TabIdOptional,
})

export const BrowserCaptureViewportSchema = z.object({
  tab_id: TabIdOptional,
  mode: z
    .enum(['viewport', 'clip', 'full_page'])
    .optional()
    .describe('截图模式：viewport/clip/full_page，默认 viewport'),
  clip: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('可选裁剪区域：{x,y,width,height}（像素）'),
})

export const BrowserProbeWorkflowStateSchema = z.object({
  prompt: z.string().optional().describe('可选：用于校验 prompt 是否已经写入输入区'),
  attachment_name: z.string().optional().describe('可选：用于校验页面是否已显示该附件'),
  include_candidates: z
    .boolean()
    .optional()
    .describe('是否返回 upload/input/send 候选，默认 true'),
  vision_action: z
    .enum(['upload', 'input', 'send'])
    .optional()
    .describe('可选：当指定动作为 upload/input/send 且 DOM 候选不足时，顺带返回视觉候选'),
  tab_id: TabIdOptional,
})

export const BrowserLocateActionTargetsSchema = z.object({
  action: z
    .enum(['upload', 'send', 'close', 'back'])
    .describe('动作类型：upload/send/close/back'),
  tab_id: TabIdOptional,
})

export const BrowserLocateInputTargetsSchema = z.object({
  target: z.string().optional().describe('可选目标描述，如“提示词输入框”“消息输入框”'),
  tab_id: TabIdOptional,
})

export const BrowserAnalyzeViewportSchema = z.object({
  action: z
    .enum(['upload', 'send', 'close', 'back', 'input'])
    .describe('动作类型：upload/send/close/back/input'),
  tab_id: TabIdOptional,
  include_dom_candidates: z
    .boolean()
    .optional()
    .describe('是否附带 DOM 候选作为视觉分析参考，默认 true'),
})

export const BrowserListUploadTargetsSchema = z.object({
  tab_id: TabIdOptional,
})

export const BrowserUploadScopeAttachmentSchema = z.object({
  attachment_id: z.string().optional().describe('当前会话中的附件 ID'),
  attachment_name: z.string().optional().describe('当前会话中的附件文件名或其片段'),
  latest: z.boolean().optional().describe('是否优先使用当前会话最新附件，默认 true'),
  selector: z.string().optional().describe('可选：直接定位 file input 的 CSS 选择器'),
  target: z.string().optional().describe('可选：上传入口目标描述，如“上传图片”'),
  x: z.number().optional().describe('可选：归一化横坐标 0-999'),
  y: z.number().optional().describe('可选：归一化纵坐标 0-999'),
  tab_id: TabIdOptional,
})

export const BrowserClickAtSchema = z.object({
  x: z.number().describe('归一化横坐标 0-999'),
  y: z.number().describe('归一化纵坐标 0-999'),
  tab_id: TabIdOptional,
})

export const BrowserTypeAtSchema = z.object({
  x: z.number().describe('归一化横坐标 0-999'),
  y: z.number().describe('归一化纵坐标 0-999'),
  text: z.string().describe('要输入的文本'),
  press_enter: z.boolean().optional().describe('输入后按 Enter，默认 true'),
  use_shift_enter_for_newline: z
    .boolean()
    .optional()
    .describe('多行文本是否使用 Shift+Enter 断行'),
  clear_before_typing: z.boolean().optional().describe('输入前是否清空内容（全选+删除）'),
  tab_id: TabIdOptional,
})

export const BrowserScrollAtSchema = z.object({
  x: z.number().optional().describe('归一化横坐标 0-999，默认 500'),
  y: z.number().optional().describe('归一化纵坐标 0-999，默认 500'),
  direction: z
    .enum(['up', 'down', 'left', 'right'])
    .describe('滚动方向 up/down/left/right'),
  magnitude: z.number().optional().describe('滚动幅度，默认 800'),
  tab_id: TabIdOptional,
})

export const BrowserSendKeysSchema = z.object({
  key: z.string().describe('键名，如 Enter/Escape/Tab/a'),
  modifiers: z
    .array(z.string())
    .optional()
    .describe('可选组合键数组：ctrl/shift/alt/meta'),
  tab_id: TabIdOptional,
})

export const BrowserAskUserTakeoverSchema = z.object({
  call_to_action: z.string().describe('给用户的动作提示'),
  details: z.string().optional().describe('补充说明'),
  timeout_sec: z.number().optional().describe('等待超时秒数，默认 300'),
})

export const BrowserQueryGeminiSchema = z.object({
  text: z.string().describe('提问内容'),
  tab_id: z.string().optional().describe('可选标签页 ID'),
  wait_response_ms: z.number().optional().describe('等待响应时间，默认 35000ms'),
})

export const BrowserWaitSchema = z.object({
  timeout_ms: z.number().optional().describe('超时时间，默认 8000ms'),
  selector: z.string().optional().describe('可选：等待该 selector 出现'),
  tab_id: TabIdOptional,
})

export const BrowserWaitForConditionSchema = z.object({
  condition: z
    .enum(['page_readable', 'selector', 'network_idle', 'content_stable', 'custom_js'])
    .describe('等待条件：page_readable/selector/network_idle/content_stable/custom_js'),
  selector: z.string().optional().describe('condition=selector 时使用'),
  custom_js: z.string().optional().describe('condition=custom_js 时返回 truthy 视为满足'),
  timeout_ms: z.number().optional().describe('超时时间，默认 8000ms'),
  check_interval_ms: z.number().optional().describe('轮询间隔，默认 250ms'),
  stable_iterations: z
    .number()
    .optional()
    .describe('network_idle/content_stable 需要连续稳定次数'),
  tab_id: TabIdOptional,
})

export const BrowserGoBackSchema = z.object({
  tab_id: TabIdOptional,
})

export type BrowserInteractionToolName =
  | 'browser_navigate'
  | 'browser_search'
  | 'browser_get_tabs'
  | 'browser_read_page'
  | 'browser_click'
  | 'browser_click_text'
  | 'browser_type'
  | 'browser_type_smart'
  | 'browser_compose_message'
  | 'browser_capture_viewport'
  | 'browser_probe_workflow_state'
  | 'browser_locate_action_targets'
  | 'browser_locate_input_targets'
  | 'browser_analyze_viewport'
  | 'browser_list_upload_targets'
  | 'browser_upload_scope_attachment'
  | 'browser_click_at'
  | 'browser_type_at'
  | 'browser_scroll_at'
  | 'browser_send_keys'
  | 'browser_ask_user_takeover'
  | 'browser_query_gemini'
  | 'browser_wait'
  | 'browser_wait_for_condition'
  | 'browser_go_back'

export const BROWSER_INTERACTION_SCHEMAS: Record<
  BrowserInteractionToolName,
  z.ZodObject<z.ZodRawShape>
> = {
  browser_navigate: BrowserNavigateSchema,
  browser_search: BrowserSearchSchema,
  browser_get_tabs: BrowserGetTabsSchema,
  browser_read_page: BrowserReadPageSchema,
  browser_click: BrowserClickSchema,
  browser_click_text: BrowserClickTextSchema,
  browser_type: BrowserTypeSchema,
  browser_type_smart: BrowserTypeSmartSchema,
  browser_compose_message: BrowserComposeMessageSchema,
  browser_capture_viewport: BrowserCaptureViewportSchema,
  browser_probe_workflow_state: BrowserProbeWorkflowStateSchema,
  browser_locate_action_targets: BrowserLocateActionTargetsSchema,
  browser_locate_input_targets: BrowserLocateInputTargetsSchema,
  browser_analyze_viewport: BrowserAnalyzeViewportSchema,
  browser_list_upload_targets: BrowserListUploadTargetsSchema,
  browser_upload_scope_attachment: BrowserUploadScopeAttachmentSchema,
  browser_click_at: BrowserClickAtSchema,
  browser_type_at: BrowserTypeAtSchema,
  browser_scroll_at: BrowserScrollAtSchema,
  browser_send_keys: BrowserSendKeysSchema,
  browser_ask_user_takeover: BrowserAskUserTakeoverSchema,
  browser_query_gemini: BrowserQueryGeminiSchema,
  browser_wait: BrowserWaitSchema,
  browser_wait_for_condition: BrowserWaitForConditionSchema,
  browser_go_back: BrowserGoBackSchema,
}
