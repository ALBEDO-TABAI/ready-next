import {
  buildToolParamSchema,
  normalizeAnthropicToolSchema,
  normalizeOpenAIToolSchema,
  type ToolParamSchemaSpec,
} from './tool-schema'
import { BROWSER_INTERACTION_SCHEMAS } from './schemas/browser-interaction-schemas'
import { BROWSER_CONTENT_SCHEMAS } from './schemas/browser-content-schemas'
import { zodObjectToParamList } from './zod-param-derivation'

export type BrowserToolDef = {
  name: string
  description: string
  params: ToolParamSchemaSpec[]
}

export const BROWSER_INTERACTION_TOOL_NAMES = [
  'browser_navigate',
  'browser_search',
  'browser_get_tabs',
  'browser_read_page',
  'browser_read_page_map',
  'browser_probe_readonly',
  'browser_click',
  'browser_click_text',
  'browser_act_on_target',
  'browser_type',
  'browser_type_smart',
  'browser_compose_message',
  'browser_capture_viewport',
  'browser_probe_workflow_state',
  'browser_locate_action_targets',
  'browser_locate_input_targets',
  'browser_analyze_viewport',
  'browser_list_upload_targets',
  'browser_upload_scope_attachment',
  'browser_click_at',
  'browser_type_at',
  'browser_scroll_at',
  'browser_send_keys',
  'browser_ask_user_takeover',
  'browser_query_gemini',
  'browser_wait',
  'browser_wait_for_condition',
  'browser_go_back',
] as const

export const BROWSER_CONTENT_TASK_TOOL_NAMES = [
  'browser_collect_images',
  'browser_download_urls',
  'browser_download_collected_media',
  'browser_resolve_video',
  'browser_extract_structured',
  'browser_scroll_collect',
  'browser_start_task',
  'browser_get_task',
  'browser_resume_task',
  'browser_cancel_task',
  'browser_aggregate_results',
  'browser_download_gallery',
  'browser_research_topic',
  'browser_run_workflow',
  'browser_execute_js',
  'browser_visible_collect',
  'browser_collect_notes',
  'browser_confirm_collection_consent',
] as const

export const BROWSER_TOOLS: BrowserToolDef[] = [
  {
    name: 'browser_navigate',
    description: '导航到指定 URL。如果没有打开的标签页，会自动创建一个新标签页。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_navigate) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_search',
    description: '使用搜索引擎搜索关键词。默认自动选择引擎并在失败时回退（duckduckgo/google/bing/baidu）。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_search) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_get_tabs',
    description: '列出当前所有打开的浏览器标签页，包括 URL、标题和活跃状态。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_get_tabs) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_read_page',
    description: '读取当前页面的纯文本内容（document.body.innerText）。浏览任务默认优先使用 browser_read_page_map；此工具只作为正文补充。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_read_page) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_read_page_map',
    description: '读取当前页面的结构化页面地图，返回 generation、目标 targetId、角色、名称、状态、基础风险标记和歧义组。浏览操作前优先调用。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_read_page_map) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_probe_readonly',
    description: '按固定范围执行安全只读页面探针。必须先读取 page map 并携带 fresh generation；不会执行模型脚本、导航、点击、输入或发请求。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_probe_readonly) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_click',
    description: 'Fallback：点击页面上匹配 CSS 选择器的第一个元素。默认先用 browser_read_page_map + browser_act_on_target。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_click) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_click_text',
    description: 'Fallback：按可见文本智能点击元素。默认先用 browser_read_page_map + browser_act_on_target，避免绕开 targetId/generation 校验。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_click_text) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_act_on_target',
    description: '对 browser_read_page_map 返回的唯一目标执行动作。必须携带 target_id 和 fresh generation；支持 click/expand/choose/fill/hover，并在动作后复查。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_act_on_target) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_type',
    description: 'Fallback：在页面上匹配 CSS 选择器的输入框中输入文字。默认先用 browser_read_page_map + browser_act_on_target(action=fill)。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_type) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_type_smart',
    description: 'Fallback：按输入框标签/placeholder/name/id 智能定位并输入文本。默认先用 browser_read_page_map + browser_act_on_target(action=fill)。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_type_smart) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_compose_message',
    description: 'Fallback：在聊天/搜索类页面智能定位消息输入框并输入内容。默认先用页面地图确认输入区和发送目标。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_compose_message) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_capture_viewport',
    description: '捕获浏览器截图（默认视口），用于坐标点击前后校验。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_capture_viewport) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_probe_workflow_state',
    description: '批量采集页面身份、截图、上传状态、prompt 状态、DOM 状态与关键动作候选，用于上传/填写/提交工作流，减少重复截图和 DOM 扫描。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_probe_workflow_state) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_locate_action_targets',
    description: '定位当前页面中与上传/发送/关闭/返回相关的候选控件，返回结构化候选列表；当 action=send 时会优先关联当前焦点输入区附近的控件，减少误点无关按钮。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_locate_action_targets) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_locate_input_targets',
    description: '定位当前页面可能用于输入提示词/消息/描述的输入区域，返回结构化候选列表；会额外给出当前已聚焦输入区 active_target，以及与该输入区相邻的发送/生成控件 nearby_send_targets，便于先确认焦点再提交。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_locate_input_targets) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_analyze_viewport',
    description: '当 DOM/A11y 候选不足时，使用当前模型的视觉能力分析截图并返回结构化控件候选。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_analyze_viewport) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_list_upload_targets',
    description: '枚举当前页面可能的文件上传入口和 file input，适合上传前探测。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_list_upload_targets) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_upload_scope_attachment',
    description: '把当前会话中的附件上传到页面 file input。可按 attachmentId、文件名或 latest=true 自动选择。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_upload_scope_attachment) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_collect_images',
    description: '只读取当前视口可见的图片候选（URL/尺寸/alt，默认 20、最多 60），用于轻量探查。整画板/图库/“把这些图都采集下来”这类成规模采集必须用 browser_visible_collect(image_gallery) 走结构化采集链，不要用本工具配 browser_download_urls 手工批量下载。',
    params: zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_collect_images) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_download_urls',
    description: '把一组 URL 下载到本地目录（directory 必填，不传会被拒绝）。仅用于与图片采集无关的零散下载；画板/图库的保存必须走 browser_visible_collect(image_gallery)+browser_download_collected_media，本工具会拦截图床批量下载。',
    params: zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_download_urls) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_download_collected_media',
    description: '从已完成的 browser_visible_collect(image_gallery) 来源任务下载已冻结图片到本地目录；只接受 source_task_id，不接受任意 URL 列表。',
    params: zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_download_collected_media) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_resolve_video',
    description: '解析当前页面或指定页面里的视频直链。小红书会复用内嵌 Video Expert Analyzer 的小红书解析器；下载仍交给 browser_download_urls。',
    params: zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_resolve_video) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_click_at',
    description: '按归一化坐标（0-999）执行低层点击，适用于复杂页面和 shadow/editor 场景。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_click_at) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_type_at',
    description: '按归一化坐标聚焦输入，并用 CDP 低层键盘输入文本，可选回车发送。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_type_at) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_scroll_at',
    description: '按坐标执行低层滚动（鼠标滚轮）。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_scroll_at) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_send_keys',
    description: '发送低层按键事件（例如 Enter、Escape、Tab）。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_send_keys) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_ask_user_takeover',
    description: '当页面出现登录/验证码等人工步骤时请求用户接管。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_ask_user_takeover) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_query_gemini',
    description: '在 Gemini 页面自动执行“输入并发送”，并检测响应；失败时自动回退到坐标输入。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_query_gemini) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_wait',
    description: '等待页面进入可交互状态，可选等待 selector 出现。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_wait) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_wait_for_condition',
    description: '等待复杂条件满足，如页面可读、selector 出现、网络趋稳、内容稳定或自定义 JS 条件。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_wait_for_condition) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_extract_structured',
    description: '按模板提取当前页或目标页的结构化内容，适合文章列表、图片列表、链接列表和通用卡片。',
    params: zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_extract_structured) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_scroll_collect',
    description: '自动滚动页面并持续收集结构化内容，适合长列表、图集和无限滚动页面。',
    params: zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_scroll_collect) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_start_task',
    description: '启动后台浏览器任务，适合批量下载、长页面采集和跨页研究。',
    params: zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_start_task) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_get_task',
    description: '读取后台浏览器任务的当前进度、状态和结果摘要。',
    params: zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_get_task) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_resume_task',
    description: '继续一个已暂停或未完成的后台浏览器任务。',
    params: zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_resume_task) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_cancel_task',
    description: '取消一个后台浏览器任务。',
    params: zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_cancel_task) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_aggregate_results',
    description: '对多页提取结果做拼接、去重和排序，便于后续总结。',
    params: zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_aggregate_results) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_download_gallery',
    description: '面向长图集或画板的薄适配：自动按图集模式启动后台采集与批量下载任务。',
    params: zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_download_gallery) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_research_topic',
    description: '面向跨页研究的薄适配：按主题启动后台研究任务，并返回任务句柄。',
    params: zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_research_topic) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_run_workflow',
    description: '批量执行多步骤浏览器任务（导航/搜索/点击/坐标点击/输入/坐标输入/滚动/按键/compose/等待/读取），适合复杂任务减少来回调用。',
    params: zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_run_workflow) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_execute_js',
    description: '在页面中执行任意 JavaScript 代码并返回结果。代码运行在页面沙箱中，与 Node.js 隔离。',
    params: zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_execute_js) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_visible_collect',
    description: 'Agent 右侧分屏可见页面采集器：在 Agent 标签页分轮提取条目、跨轮去重、逐屏滚动，并按轮保存进度，适合信息流/评论区/长列表。后台任务，返回任务句柄。用于逐篇保存时，这一步只负责冻结目标清单；只有 discoveryStatus=complete 且拿到 suggestedNextTool/source_task_id 后才继续调用 browser_collect_notes。若返回 partial/paused 或 suggestedContinueTool，先 browser_resume_task 继续发现。',
    params: zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_visible_collect) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_collect_notes',
    description: '后台逐篇采集子 agent：优先传 browser_visible_collect 返回的 source_task_id/expected_count 接力完整冻结清单；来源清单不是 complete 时默认拒绝，allow_partial 只会被记录为提示，不能替代持久用户确认。用户直接提供 URL 列表时必须来自当前用户消息原文，系统会先合成 source task 再接力。它在独立后台标签页逐篇打开目标，或按 strategy=card_loop 从列表页逐张点开，采集详情和图片，按“序号 - 标题”建目录，写 note.md/manifest.json/assets，并按篇保存进度。数量不一致会拒绝启动。返回后台任务句柄。',
    params: zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_collect_notes) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_confirm_collection_consent',
    description: '确认浏览器采集的 pending consent request。只接受 browser_collect_notes 返回的 requestId 和确认来源，用于写入持久确认记录；不要解析用户自然语言来替代 requestId。',
    params: zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_confirm_collection_consent) as ToolParamSchemaSpec[],
  },
  {
    name: 'browser_go_back',
    description: '在当前标签页中后退一页。',
    params: zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_go_back) as ToolParamSchemaSpec[],
  },
]

export function getBrowserAnthropicTools(): Array<Record<string, unknown>> {
  return BROWSER_TOOLS.map((tool) => normalizeAnthropicToolSchema({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map((param) => [param.name, buildToolParamSchema(param)])),
      required: tool.params.filter((param) => param.required).map((param) => param.name),
    },
  }))
}

export function getBrowserOpenAITools(): Array<Record<string, unknown>> {
  return BROWSER_TOOLS.map((tool) => normalizeOpenAIToolSchema({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(tool.params.map((param) => [param.name, buildToolParamSchema(param)])),
        required: tool.params.filter((param) => param.required).map((param) => param.name),
      },
    },
  }))
}
