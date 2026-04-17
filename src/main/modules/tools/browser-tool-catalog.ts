import {
  buildToolParamSchema,
  normalizeAnthropicToolSchema,
  normalizeOpenAIToolSchema,
  type ToolParamSchemaSpec,
} from './tool-schema'

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
  'browser_click',
  'browser_click_text',
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
] as const

export const BROWSER_TOOLS: BrowserToolDef[] = [
  {
    name: 'browser_navigate',
    description: '导航到指定 URL。如果没有打开的标签页，会自动创建一个新标签页。',
    params: [
      { name: 'url', type: 'string', description: '要导航到的完整 URL (http/https)', required: true },
    ],
  },
  {
    name: 'browser_search',
    description: '使用搜索引擎搜索关键词。默认自动选择引擎并在失败时回退（duckduckgo/google/bing/baidu）。',
    params: [
      { name: 'query', type: 'string', description: '搜索关键词', required: true },
      { name: 'engine', type: 'string', description: '搜索引擎：auto/google/duckduckgo/bing/baidu，默认 auto', required: false, enum: ['auto', 'google', 'duckduckgo', 'bing', 'baidu'] },
    ],
  },
  {
    name: 'browser_get_tabs',
    description: '列出当前所有打开的浏览器标签页，包括 URL、标题和活跃状态。',
    params: [],
  },
  {
    name: 'browser_read_page',
    description: '读取当前页面的纯文本内容（document.body.innerText），用于理解页面信息。',
    params: [
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ],
  },
  {
    name: 'browser_click',
    description: '点击页面上匹配 CSS 选择器的第一个元素。',
    params: [
      { name: 'selector', type: 'string', description: 'CSS 选择器，例如 "button.submit" 或 "#search-btn"', required: true },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ],
  },
  {
    name: 'browser_click_text',
    description: '按可见文本智能点击元素（按钮/链接/可点击项），比纯 selector 更稳健。',
    params: [
      { name: 'text', type: 'string', description: '要点击的可见文本（支持部分匹配）', required: true },
      { name: 'exact', type: 'boolean', description: '是否精确匹配文本，默认 false', required: false },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ],
  },
  {
    name: 'browser_type',
    description: '在页面上匹配 CSS 选择器的输入框中输入文字。',
    params: [
      { name: 'selector', type: 'string', description: 'CSS 选择器，定位输入框元素', required: true },
      { name: 'text', type: 'string', description: '要输入的文字', required: true },
      { name: 'clear_first', type: 'boolean', description: '是否先清空输入框（默认 true）', required: false },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ],
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
    ],
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
    ],
  },
  {
    name: 'browser_capture_viewport',
    description: '捕获浏览器截图（默认视口），用于坐标点击前后校验。',
    params: [
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
      { name: 'mode', type: 'string', description: '截图模式：viewport/clip/full_page，默认 viewport', required: false, enum: ['viewport', 'clip', 'full_page'] },
      { name: 'clip', type: 'object', description: '可选裁剪区域：{x,y,width,height}（像素）', required: false },
    ],
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
    ],
  },
  {
    name: 'browser_locate_action_targets',
    description: '定位当前页面中与上传/发送/关闭/返回相关的候选控件，返回结构化候选列表；当 action=send 时会优先关联当前焦点输入区附近的控件，减少误点无关按钮。',
    params: [
      { name: 'action', type: 'string', description: '动作类型：upload/send/close/back', required: true, enum: ['upload', 'send', 'close', 'back'] },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ],
  },
  {
    name: 'browser_locate_input_targets',
    description: '定位当前页面可能用于输入提示词/消息/描述的输入区域，返回结构化候选列表；会额外给出当前已聚焦输入区 active_target，以及与该输入区相邻的发送/生成控件 nearby_send_targets，便于先确认焦点再提交。',
    params: [
      { name: 'target', type: 'string', description: '可选目标描述，如“提示词输入框”“消息输入框”', required: false },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ],
  },
  {
    name: 'browser_analyze_viewport',
    description: '当 DOM/A11y 候选不足时，使用当前模型的视觉能力分析截图并返回结构化控件候选。',
    params: [
      { name: 'action', type: 'string', description: '动作类型：upload/send/close/back/input', required: true, enum: ['upload', 'send', 'close', 'back', 'input'] },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
      { name: 'include_dom_candidates', type: 'boolean', description: '是否附带 DOM 候选作为视觉分析参考，默认 true', required: false },
    ],
  },
  {
    name: 'browser_list_upload_targets',
    description: '枚举当前页面可能的文件上传入口和 file input，适合上传前探测。',
    params: [
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ],
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
    ],
  },
  {
    name: 'browser_collect_images',
    description: '收集当前页面可见图片候选（URL/尺寸/alt），适合后续批量下载。',
    params: [
      { name: 'keyword', type: 'string', description: '可选关键词，按图片 URL/alt/title 过滤', required: false },
      { name: 'limit', type: 'number', description: '最多返回条数，默认 20，最大 60', required: false },
      { name: 'min_width', type: 'number', description: '最小宽度像素过滤，默认 120', required: false },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ],
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
    ],
  },
  {
    name: 'browser_click_at',
    description: '按归一化坐标（0-999）执行低层点击，适用于复杂页面和 shadow/editor 场景。',
    params: [
      { name: 'x', type: 'number', description: '归一化横坐标 0-999', required: true },
      { name: 'y', type: 'number', description: '归一化纵坐标 0-999', required: true },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ],
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
    ],
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
    ],
  },
  {
    name: 'browser_send_keys',
    description: '发送低层按键事件（例如 Enter、Escape、Tab）。',
    params: [
      { name: 'key', type: 'string', description: '键名，如 Enter/Escape/Tab/a', required: true },
      { name: 'modifiers', type: 'array', description: '可选组合键数组：ctrl/shift/alt/meta', required: false, items: { type: 'string' } },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ],
  },
  {
    name: 'browser_ask_user_takeover',
    description: '当页面出现登录/验证码等人工步骤时请求用户接管。',
    params: [
      { name: 'call_to_action', type: 'string', description: '给用户的动作提示', required: true },
      { name: 'details', type: 'string', description: '补充说明', required: false },
      { name: 'timeout_sec', type: 'number', description: '等待超时秒数，默认 300', required: false },
    ],
  },
  {
    name: 'browser_query_gemini',
    description: '在 Gemini 页面自动执行“输入并发送”，并检测响应；失败时自动回退到坐标输入。',
    params: [
      { name: 'text', type: 'string', description: '提问内容', required: true },
      { name: 'tab_id', type: 'string', description: '可选标签页 ID', required: false },
      { name: 'wait_response_ms', type: 'number', description: '等待响应时间，默认 35000ms', required: false },
    ],
  },
  {
    name: 'browser_wait',
    description: '等待页面进入可交互状态，可选等待 selector 出现。',
    params: [
      { name: 'timeout_ms', type: 'number', description: '超时时间，默认 8000ms', required: false },
      { name: 'selector', type: 'string', description: '可选：等待该 selector 出现', required: false },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ],
  },
  {
    name: 'browser_wait_for_condition',
    description: '等待复杂条件满足，如页面可读、selector 出现、网络趋稳、内容稳定或自定义 JS 条件。',
    params: [
      { name: 'condition', type: 'string', description: '等待条件：page_readable/selector/network_idle/content_stable/custom_js', required: true, enum: ['page_readable', 'selector', 'network_idle', 'content_stable', 'custom_js'] },
      { name: 'selector', type: 'string', description: 'condition=selector 时使用', required: false },
      { name: 'custom_js', type: 'string', description: 'condition=custom_js 时返回 truthy 视为满足', required: false },
      { name: 'timeout_ms', type: 'number', description: '超时时间，默认 8000ms', required: false },
      { name: 'check_interval_ms', type: 'number', description: '轮询间隔，默认 250ms', required: false },
      { name: 'stable_iterations', type: 'number', description: 'network_idle/content_stable 需要连续稳定次数', required: false },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ],
  },
  {
    name: 'browser_extract_structured',
    description: '按模板提取当前页或目标页的结构化内容，适合文章列表、图片列表、链接列表和通用卡片。',
    params: [
      { name: 'template', type: 'string', description: '提取模板：article_list/image_gallery/link_list/card_list/custom', required: true, enum: ['article_list', 'image_gallery', 'link_list', 'card_list', 'custom'] },
      { name: 'url', type: 'string', description: '可选：先打开或复用该 URL 再提取', required: false },
      { name: 'tab_id', type: 'string', description: '当前标签页 ID，留空则使用当前活跃页', required: false },
      { name: 'item_selector', type: 'string', description: '可选：限定提取项选择器', required: false },
      { name: 'fields', type: 'array', description: 'template=custom 时的字段映射', required: false, items: { type: 'object', additionalProperties: true } },
      { name: 'limit', type: 'number', description: '最多提取条数', required: false },
      { name: 'min_width', type: 'number', description: '图片提取最小宽度', required: false },
      { name: 'custom_script', type: 'string', description: '可选：直接执行自定义提取脚本', required: false },
    ],
  },
  {
    name: 'browser_scroll_collect',
    description: '自动滚动页面并持续收集结构化内容，适合长列表、图集和无限滚动页面。',
    params: [
      { name: 'template', type: 'string', description: '提取模板：article_list/image_gallery/link_list/card_list/custom', required: true, enum: ['article_list', 'image_gallery', 'link_list', 'card_list', 'custom'] },
      { name: 'url', type: 'string', description: '可选：先打开或复用该 URL 再滚动采集', required: false },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃页', required: false },
      { name: 'item_selector', type: 'string', description: '可选：限定采集项选择器', required: false },
      { name: 'limit', type: 'number', description: '最多采集条数', required: false },
      { name: 'max_scrolls', type: 'number', description: '最大滚动次数', required: false },
      { name: 'scroll_delay_ms', type: 'number', description: '每次滚动后的等待时间', required: false },
      { name: 'custom_script', type: 'string', description: '可选：直接执行自定义提取脚本', required: false },
    ],
  },
  {
    name: 'browser_start_task',
    description: '启动后台浏览器任务，适合批量下载、长页面采集和跨页研究。',
    params: [
      { name: 'kind', type: 'string', description: '任务类型：download_urls/scroll_collect/research', required: true, enum: ['download_urls', 'scroll_collect', 'research'] },
      { name: 'payload', type: 'object', description: '任务参数对象', required: true, additionalProperties: true },
    ],
  },
  {
    name: 'browser_get_task',
    description: '读取后台浏览器任务的当前进度、状态和结果摘要。',
    params: [
      { name: 'task_id', type: 'string', description: '任务 ID', required: true },
    ],
  },
  {
    name: 'browser_resume_task',
    description: '继续一个已暂停或未完成的后台浏览器任务。',
    params: [
      { name: 'task_id', type: 'string', description: '任务 ID', required: true },
    ],
  },
  {
    name: 'browser_cancel_task',
    description: '取消一个后台浏览器任务。',
    params: [
      { name: 'task_id', type: 'string', description: '任务 ID', required: true },
    ],
  },
  {
    name: 'browser_aggregate_results',
    description: '对多页提取结果做拼接、去重和排序，便于后续总结。',
    params: [
      { name: 'items', type: 'array', description: '结构化结果数组', required: true, items: { type: 'object', additionalProperties: true } },
      { name: 'merge_strategy', type: 'string', description: 'concat 或 dedupe，默认 dedupe', required: false, enum: ['concat', 'dedupe'] },
      { name: 'sort_by', type: 'string', description: 'title/link/source', required: false, enum: ['title', 'link', 'source'] },
    ],
  },
  {
    name: 'browser_download_gallery',
    description: '面向长图集或画板的薄适配：自动按图集模式启动后台采集与批量下载任务。',
    params: [
      { name: 'url', type: 'string', description: '图集或画板链接', required: true },
      { name: 'directory', type: 'string', description: '下载目录', required: false },
      { name: 'limit', type: 'number', description: '最多采集图片数量', required: false },
      { name: 'max_scrolls', type: 'number', description: '最大滚动次数', required: false },
      { name: 'retry_failed', type: 'boolean', description: '下载失败是否重试', required: false },
    ],
  },
  {
    name: 'browser_research_topic',
    description: '面向跨页研究的薄适配：按主题启动后台研究任务，并返回任务句柄。',
    params: [
      { name: 'query', type: 'string', description: '研究主题或问题', required: true },
      { name: 'urls', type: 'array', description: '可选：直接指定来源页列表', required: false, items: { type: 'string' } },
      { name: 'max_pages', type: 'number', description: '最多访问页面数', required: false },
      { name: 'limit_per_page', type: 'number', description: '每页最多提取条数', required: false },
      { name: 'template', type: 'string', description: '提取模板，默认 article_list', required: false, enum: ['article_list', 'link_list', 'card_list', 'custom'] },
    ],
  },
  {
    name: 'browser_run_workflow',
    description: '批量执行多步骤浏览器任务（导航/搜索/点击/坐标点击/输入/坐标输入/滚动/按键/compose/等待/读取），适合复杂任务减少来回调用。',
    params: [
      { name: 'steps', type: 'array', description: '步骤数组，每项形如 { action, ... }', required: true, items: { type: 'object', additionalProperties: true } },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
      { name: 'continue_on_error', type: 'boolean', description: '遇错是否继续执行后续步骤，默认 false', required: false },
    ],
  },
  {
    name: 'browser_execute_js',
    description: '在页面中执行任意 JavaScript 代码并返回结果。代码运行在页面沙箱中，与 Node.js 隔离。',
    params: [
      { name: 'code', type: 'string', description: '要执行的 JavaScript 代码', required: true },
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ],
  },
  {
    name: 'browser_go_back',
    description: '在当前标签页中后退一页。',
    params: [
      { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃标签页', required: false },
    ],
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
