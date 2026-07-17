import { z } from 'zod'

const tabId = z.string().optional().describe('目标标签页 ID；省略时使用当前活动标签页')
const targetFields = {
  target_id: z.string().optional().describe('browser_snapshot 或 browser_find 返回的目标引用'),
  document_epoch: z.number().optional().describe('目标引用绑定的文档版本'),
  snapshot_revision: z.number().optional().describe('目标引用绑定的快照版本'),
  selector: z.string().optional().describe('CSS 选择器兜底'),
  text: z.string().optional().describe('可见文本或输入内容，具体含义见工具说明'),
  exact: z.boolean().optional().describe('可见文本是否精确匹配'),
  x: z.number().optional().describe('归一化横坐标 0-999，仅作最后兜底'),
  y: z.number().optional().describe('归一化纵坐标 0-999，仅作最后兜底'),
  tab_id: tabId,
}

const arbitraryObject = z.record(z.string(), z.unknown()).meta({ additionalProperties: true })

export const BROWSER_TOOL_SCHEMAS = {
  browser_tabs: z.object({
    action: z.enum(['list', 'open', 'switch', 'close']).optional().describe('标签动作，默认 list'),
    url: z.string().optional().describe('open 时的地址'),
    tab_id: tabId,
    background: z.boolean().optional().describe('open 时是否在后台创建'),
    opener_tab_id: z.string().optional().describe('open 时绑定的来源标签页 ID'),
  }).superRefine((value, ctx) => {
    if ((value.action === 'switch' || value.action === 'close') && !value.tab_id?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['tab_id'], message: `tab_id is required when action is ${value.action}` })
    }
  }),
  browser_navigate: z.object({
    action: z.enum(['open', 'back', 'forward', 'reload']).optional().describe('导航动作，默认 open'),
    url: z.string().optional().describe('open 时必填的 URL'),
    tab_id: tabId,
    allow_repeat: z.boolean().optional().describe('是否允许短时间内重复导航到同一地址'),
  }).superRefine((value, ctx) => {
    if ((value.action === undefined || value.action === 'open') && !value.url?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'url is required when action is open' })
    }
  }),
  browser_search: z.object({
    query: z.string().describe('搜索关键词'),
    engine: z.enum(['auto', 'duckduckgo', 'google', 'bing', 'baidu']).optional().describe('搜索引擎，默认 auto'),
    scope: z.enum(['web', 'current_site']).optional().describe('搜索范围；current_site 只在当前站点内搜索且不回退外部引擎'),
    tab_id: tabId,
    allow_repeat: z.boolean().optional().describe('是否允许短时间内重复执行同一搜索'),
  }),
  browser_snapshot: z.object({
    tab_id: tabId,
    max_bytes: z.number().optional().describe('紧凑快照最大字节数'),
  }),
  browser_find: z.object({
    query: z.string().optional().describe('要查找的文本、名称或描述'),
    role: z.string().optional().describe('可访问角色过滤'),
    purpose: z.enum(['any', 'action', 'input', 'upload', 'send']).optional().describe('目标用途，默认 any'),
    cursor: z.string().optional().describe('上一页返回的分页游标'),
    limit: z.number().optional().describe('最多返回的候选数'),
    tab_id: tabId,
  }),
  browser_read: z.object({
    tab_id: tabId,
    target_id: z.string().optional().describe('可选目标引用'),
    selector: z.string().optional().describe('可选区域选择器'),
    max_chars: z.number().optional().describe('最大正文字符数'),
  }),
  browser_screenshot: z.object({
    tab_id: tabId,
    mode: z.enum(['viewport', 'clip', 'full_page']).optional().describe('截图模式，默认 viewport'),
    clip: arbitraryObject.optional().describe('裁剪区域 {x,y,width,height}'),
    analyze: z.boolean().optional().describe('是否同时返回内部视觉分析'),
    action: z.enum(['upload', 'send', 'close', 'back', 'input']).optional().describe('视觉分析关注的动作'),
  }),
  browser_wait: z.object({
    tab_id: tabId,
    timeout_ms: z.number().optional().describe('最长等待时间'),
    duration_ms: z.number().optional().describe('固定等待时长'),
    condition: z.enum(['ready', 'selector', 'text', 'url', 'network_idle', 'content_stable']).optional().describe('等待条件'),
    selector: z.string().optional().describe('等待出现的选择器'),
    text: z.string().optional().describe('等待出现的文本'),
    url: z.string().optional().describe('等待匹配的 URL 片段'),
    check_interval_ms: z.number().optional().describe('条件检查间隔'),
    stable_iterations: z.number().optional().describe('内容稳定所需连续命中次数'),
  }).superRefine((value, ctx) => {
    const requiredField = value.condition === 'selector' ? 'selector' : value.condition === 'text' ? 'text' : value.condition === 'url' ? 'url' : null
    if (requiredField && !value[requiredField]?.trim()) {
      ctx.addIssue({ code: 'custom', path: [requiredField], message: `${requiredField} is required when condition is ${value.condition}` })
    }
  }),

  browser_click: z.object({
    ...targetFields,
    button: z.enum(['left', 'right', 'middle']).optional().describe('鼠标按钮，默认 left'),
    click_count: z.number().optional().describe('点击次数，默认 1'),
  }),
  browser_type: z.object({
    ...targetFields,
    text: z.string().describe('要输入的文字'),
    target: z.string().optional().describe('输入框语义描述'),
    clear_first: z.boolean().optional().describe('是否先清空，默认 true'),
    submit: z.boolean().optional().describe('输入后是否提交'),
    mode: z.enum(['auto', 'fast_fill', 'key_by_key']).optional().describe('输入模式，默认 auto'),
  }),
  browser_fill_form: z.object({
    fields: z.array(z.object({
      target_id: z.string().optional(),
      selector: z.string().optional(),
      label: z.string().optional(),
      value: z.union([z.string(), z.number(), z.boolean()]),
    })).describe('表单字段列表'),
    submit: z.boolean().optional().describe('填完后是否提交'),
    tab_id: tabId,
  }),
  browser_select: z.object({
    ...targetFields,
    value: z.string().optional().describe('单个选项值'),
    values: z.array(z.string()).optional().describe('多个选项值'),
  }),
  browser_hover: z.object(targetFields),
  browser_scroll: z.object({
    tab_id: tabId,
    target_id: z.string().optional().describe('滚动容器引用'),
    selector: z.string().optional().describe('滚动容器选择器'),
    x: z.number().optional().describe('归一化横坐标 0-999'),
    y: z.number().optional().describe('归一化纵坐标 0-999'),
    delta_x: z.number().optional().describe('横向滚动像素'),
    delta_y: z.number().optional().describe('纵向滚动像素'),
    direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('滚动方向'),
    amount: z.number().optional().describe('滚动量'),
  }),
  browser_press_key: z.object({
    key: z.string().describe('按键名或组合键，例如 Enter、Meta+L'),
    modifiers: z.array(z.enum(['alt', 'ctrl', 'control', 'meta', 'cmd', 'command', 'shift'])).optional().describe('需要同时按下的修饰键'),
    tab_id: tabId,
  }),
  browser_drag: z.object({
    source_target_id: z.string().optional().describe('起点引用'),
    target_target_id: z.string().optional().describe('终点引用'),
    source_x: z.number().optional().describe('起点归一化横坐标'),
    source_y: z.number().optional().describe('起点归一化纵坐标'),
    target_x: z.number().optional().describe('终点归一化横坐标'),
    target_y: z.number().optional().describe('终点归一化纵坐标'),
    tab_id: tabId,
  }),
  browser_upload: z.object({
    attachment_id: z.string().optional().describe('会话附件 ID'),
    attachment_ids: z.array(z.string()).optional().describe('多个会话附件 ID'),
    attachment_name: z.string().optional().describe('附件文件名或片段'),
    latest: z.boolean().optional().describe('是否使用最新附件'),
    selector: z.string().optional().describe('file input 选择器'),
    target_id: z.string().optional().describe('上传入口引用'),
    target: z.string().optional().describe('上传入口描述'),
    x: z.number().optional().describe('归一化横坐标'),
    y: z.number().optional().describe('归一化纵坐标'),
    tab_id: tabId,
  }),
  browser_dialog: z.object({
    action: z.enum(['get', 'accept', 'dismiss']).optional().describe('对话框动作，默认 get'),
    prompt_text: z.string().optional().describe('prompt 对话框的输入'),
    tab_id: tabId,
  }),
  browser_request_takeover: z.object({
    action: z.enum(['request', 'complete']).optional().describe('请求用户接管，或在用户明确表示已完成后确认接管结束'),
    reason: z.string().describe('需要用户接管的原因'),
    instruction: z.string().optional().describe('用户需要完成的步骤'),
    tab_id: tabId,
  }),

  browser_research: z.object({
    scope: z.enum(['current_site', 'url_set']).describe('研究范围；不允许静默改用外部搜索引擎'),
    queries: z.array(z.string().min(1)).min(1).optional().describe('current_site 的非空查询列表，保序去重'),
    site_tab_id: z.string().optional().describe('当前站点的绑定标签页 ID；已有明确页面引用时可省略'),
    urls: z.array(z.string().url()).min(1).optional().describe('url_set 的完整 URL 列表'),
    per_query_limit: z.number().int().min(1).max(50).optional().describe('每个查询冻结的结果卡上限'),
    detail_limit_per_query: z.number().int().min(0).max(20).optional().describe('每个查询深读详情上限'),
    fields: z.array(z.enum(['title', 'url', 'author', 'engagement', 'published_at', 'body'])).optional().describe('需要返回的受控字段'),
    preserve_source_tab: z.boolean().optional().describe('是否保留用户来源页，默认 true'),
  }),
  browser_collect: z.object({
    mode: z.enum(['images', 'structured', 'scroll', 'visible', 'notes']).optional().describe('采集模式，默认按参数和页面选择'),
    url: z.string().optional().describe('目标 URL'),
    urls: z.array(z.string()).optional().describe('目标 URL 列表'),
    source_task_id: z.string().optional().describe('上游冻结清单任务 ID'),
    output_dir: z.string().optional().describe('绑定到任务资源的输出目录'),
    output_root_dir: z.string().optional().describe('逐篇采集的授权输出根目录'),
    template: z.enum(['article_list', 'image_gallery', 'link_list', 'card_list']).optional().describe('结构提取模板'),
    limit: z.number().optional().describe('采集上限'),
    expected_count: z.number().optional().describe('预期条目数'),
    keyword: z.string().optional().describe('图片过滤关键词'),
    min_width: z.number().optional().describe('图片最小宽度'),
    include_hidden: z.boolean().optional().describe('是否包含隐藏图片'),
    item_selector: z.string().optional().describe('结构化条目选择器'),
    fields: z.array(z.object({
      name: z.string(),
      selector: z.string().optional(),
      attr: z.string().optional(),
      type: z.enum(['text', 'html', 'href', 'src', 'attr']).optional(),
    })).optional().describe('结构化字段映射'),
    max_scrolls: z.number().optional().describe('最大滚动轮数'),
    scroll_delay_ms: z.number().optional().describe('滚动后等待时间'),
    max_items: z.number().optional().describe('可见采集最大条目数'),
    max_rounds: z.number().optional().describe('可见采集最大轮数'),
    max_duration_ms: z.number().optional().describe('单段最大运行时长'),
    user_expected_total: z.number().optional().describe('用户明确给出的预期总数'),
    target_profile_url: z.string().optional().describe('逐篇采集的来源主页'),
    notes: z.array(arbitraryObject).optional().describe('用户明确提供的冻结笔记清单'),
    max_notes: z.number().optional().describe('逐篇采集最大笔记数'),
    max_consecutive_failures: z.number().optional().describe('连续失败保护上限'),
    tab_id: tabId,
  }),
  browser_download: z.object({
    mode: z.enum(['urls', 'collected', 'page', 'media', 'resolve', 'gallery']).describe('下载来源'),
    urls: z.array(z.string().url()).min(1).optional().describe('下载 URL 列表'),
    url: z.string().url().optional().describe('单个页面或资源 URL'),
    page_url: z.string().url().optional().describe('resolve 时的来源页面 URL'),
    video_url: z.string().url().optional().describe('resolve 时已知的视频 URL'),
    poster_url: z.string().url().optional().describe('resolve 时已知的封面 URL'),
    title: z.string().optional().describe('resolve 时的页面或视频标题'),
    sources: z.array(z.string().url()).min(1).optional().describe('resolve 时的候选媒体 URL'),
    source_task_id: z.string().optional().describe('已完成采集任务 ID'),
    directory: z.string().optional().describe('由用户指令、任务资源或当前工作区绑定的目录；省略时使用 Ready 默认下载目录'),
    max_total_bytes: z.number().optional().describe('本次任务允许写入的总字节预算'),
    filename_prefix: z.string().optional().describe('输出文件名前缀'),
    overwrite: z.boolean().optional().describe('是否覆盖同名文件'),
    expected_total: z.number().optional().describe('预期下载总数'),
    limit: z.number().optional().describe('最多处理的候选数'),
    max_scrolls: z.number().optional().describe('图库发现最大滚动轮数'),
    retry_failed: z.boolean().optional().describe('是否只重试失败项'),
    tab_id: tabId,
  }),
  browser_archive: z.object({
    format: z.enum(['pdf', 'mhtml', 'html', 'markdown']).describe('归档格式'),
    path: z.string().describe('绑定到用户任务资源的输出路径'),
    tab_id: tabId,
  }),
  browser_task: z.object({
    action: z.enum(['get', 'resume', 'cancel', 'result']).optional().describe('任务动作，默认 get'),
    task_id: z.string().describe('后台浏览器任务 ID'),
  }),

  browser_status: z.object({
    tab_id: tabId,
    include_candidates: z.boolean().optional().describe('是否包含当前动作候选'),
    prompt: z.string().optional().describe('可选的输入内容核验'),
    attachment_name: z.string().optional().describe('可选的附件核验'),
  }),
  browser_console: z.object({
    action: z.enum(['list', 'clear']).optional().describe('控制台动作，默认 list'),
    levels: z.array(z.enum(['debug', 'info', 'warning', 'error'])).optional().describe('日志级别过滤'),
    limit: z.number().optional().describe('最多返回条数'),
    duration_ms: z.number().optional().describe('list 前采集控制台日志的时长'),
    tab_id: tabId,
  }),
  browser_network: z.object({
    action: z.enum(['start', 'stop', 'list', 'details']).optional().describe('网络诊断动作，默认 list'),
    request_id: z.string().optional().describe('查看详情的请求 ID'),
    duration_ms: z.number().optional().describe('采集时长'),
    limit: z.number().optional().describe('最多返回条数'),
    tab_id: tabId,
  }),
  browser_resources: z.object({
    url: z.string().optional().describe('可选目标页 URL'),
    kinds: z.array(z.enum(['video', 'audio', 'image', 'document', 'json', 'stream', 'unknown'])).optional().describe('资源类型过滤'),
    include_response_bodies: z.boolean().optional().describe('是否读取受限的小型响应正文'),
    wait_ms: z.number().optional().describe('等待资源出现的最长时间'),
    max_candidates: z.number().optional().describe('最多返回的资源候选数'),
    tab_id: tabId,
  }),
  browser_eval: z.object({
    code: z.string().describe('要执行的 JavaScript'),
    purpose: z.string().describe('本次执行目的'),
    world: z.enum(['isolated', 'main']).optional().describe('执行 world，默认 isolated'),
    frame_id: z.string().optional().describe('可选的目标 frame ID'),
    timeout_ms: z.number().optional().describe('单次执行时限，默认 5000ms'),
    max_result_bytes: z.number().optional().describe('返回结果字节上限'),
    grant_id: z.string().optional().describe('仅高风险效果需要的确认凭据'),
    tab_id: tabId,
  }),
  browser_cdp: z.object({
    method: z.string().describe('Chrome DevTools Protocol 方法'),
    params: arbitraryObject.optional().describe('CDP 参数'),
    purpose: z.string().describe('本次调用目的'),
    frame_id: z.string().optional().describe('可选的目标 frame ID'),
    timeout_ms: z.number().optional().describe('单次执行时限，默认 15000ms'),
    grant_id: z.string().optional().describe('仅高风险效果需要的确认凭据'),
    tab_id: tabId,
  }),
  browser_session: z.object({
    action: z.enum(['status', 'clear_origin', 'clear_site_data', 'switch_profile']).optional().describe('会话动作，默认 status'),
    origin: z.string().optional().describe('目标 origin'),
    data_types: z.array(z.enum(['cookies', 'cache', 'storage', 'service_workers'])).optional().describe('要清理的数据类型'),
    profile: z.string().optional().describe('新建或复用的受控会话配置名；不同名称隔离站点登录态'),
    tab_id: tabId,
  }),
  browser_permission: z.object({
    action: z.enum(['status', 'set', 'reset']).optional().describe('权限动作，默认 status'),
    permission: z.enum(['geolocation', 'notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write']).optional().describe('站点权限'),
    decision: z.enum(['allow', 'deny', 'ask']).optional().describe('set 时的决定'),
    origin: z.string().optional().describe('目标 origin；省略时使用当前页'),
    tab_id: tabId,
  }),
} as const

export type BrowserToolSchemaName = keyof typeof BROWSER_TOOL_SCHEMAS
