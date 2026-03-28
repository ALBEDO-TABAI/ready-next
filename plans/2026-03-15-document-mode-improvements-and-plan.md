# 2026-03-15 Document Mode Improvements And Plan

## 当前已完成的文档模式增强

### 1. 预览从纯文本渲染升级为结构化笔记预览
- 支持 YAML frontmatter。
- 支持顶部半结构化属性块（如 `created / url / title / channel / related / published / thumbnailUrl / duration / tags`）。
- 属性字段会被整理成可扫读的属性区，而不是继续原样糊成正文。
- `tags` / `related` 会显示为 chips。
- `About` / `Description` 这类标题会继续在正文中保持 section 结构。

### 2. 媒体预览能力
- 支持 YouTube 视频卡片与内嵌播放。
- 支持正文中的图片嵌入。
- 支持 Obsidian 风格 `![[video.mp4]]` 本地视频预览。
- 支持正文中的独立标签行识别。

### 2.1 生成式 UI Widget 预览
- 支持 CodePilot 同款 `show-widget` 围栏协议：
  - ````show-widget` + JSON + `widget_code`
- 文档 preview 可在 markdown 正文之间渲染多个 widget。
- widget 运行在 `iframe srcDoc + sandbox="allow-scripts"` 的 receiver 页面里。
- 当前支持：
  - HTML + CSS widget
  - SVG 图解
  - 白名单 CDN 脚本（如 Chart.js）
- 支持主题变量桥接、动态高度同步，以及 widget 内链接回到 Ready 浏览器模式。
- 对 malformed JSON fence 会安全回退为普通代码块文本，不会炸掉整个 preview。
- 对未闭合 fence 不做激进流式解析，保持文档可读性优先。

### 3. 轻交互
- 预览中的链接可直接打开。
- 标签 chip 可点击复制。
- YouTube 卡片可内嵌播放，也可通过标题跳转浏览器模式。

### 4. 文档引用到 Agent 输入框
- 文档模式右键菜单新增“引用到输入框”。
- 现在不再向输入框里硬塞大段引用文本，而是新增一个类似 IDE 的“文档引用附件 chip”。
- 引用 chip 会携带：
  - 文档标题
  - 文件路径
  - 所在章节（可识别时）
  - 行号范围（可定位时）
  - 精确选中文本
- 聊天面板会自动展开并聚焦输入框，用户只需继续输入指令，agent 会通过附件链路读到引用内容。
- 文档引用 chip 不再进入长期 `filePool`，发送后会自动清掉，避免上一次引用内容继续混入当前输入上下文。
- 引用 chip hover 会显示章节、行号和选中摘要，点击可直接回跳到文档模式对应原文位置。
- 引用 chip 现在会直接在聊天框内显示一个小的元数据块（章节 / 行号），不再只能靠 hover 理解位置。
- 删除 skill / 文档引用 / 文件附件后，会同步从 `@` 候选池中清理对应项，避免删除后仍继续出现在引用菜单里。

### 5. Agent 精准编辑工具
- 新增 `document_replace_exact`。
- 适用于“替换某一段明确原文”这类精准编辑需求。
- 支持：
  - 指定原文片段
  - 指定替换内容
  - 当命中多处时用 `occurrence` 精准指定第几处
- 避免了整篇覆盖、模糊 section rewrite 或多处误替换的问题。

### 5.1 Agent Widget 写入工具
- 新增 `document_insert_widget`。
- 新增 `document_list_widgets` / `document_update_widget` / `document_remove_widget`。
- 适用于把生成式 UI 组件作为标准 `show-widget` 围栏写入原文档。
- 当前支持：
  - `append_end`
  - `after_section`
- 与 `document_replace_exact` 组合后，可以继续精准更新已有 widget fence。
- 现在 agent 也可以先列出当前文档已有 widget，再按标题或序号更新/删除指定 widget，而不是退回整篇覆盖。
- direct-chat 已补充 widget authoring 规则，用户明确要求“图表 / 交互组件 / 可视化说明 / 小工具”时，agent 会优先考虑该工具。
- `forceDocumentTool` 现在会真正收敛为文档工具集合，不再把 design / rss / calendar 等大量无关工具一起发给模型，降低超时和走偏概率。
- 同标题 widget 写入已升级为 upsert 语义：
  - `document_insert_widget` 命中同标题时优先更新已有围栏
  - 若历史文档里已堆出多个同标题 fence，会在更新时顺手去重
  - 即使模型误走 `document_append_content`，纯 widget 围栏/JSON 追加也会自动合并到已有同标题 widget，而不是无限堆积
- 当前还会拒绝明显残缺的背景壳 SVG widget，优先让 agent 重新生成，而不是把半成品保存下来。

### 6. 编辑体验修正
- 修正了 Tiptap 外部内容同步时的行尾标准化，降低回车后光标/段落表现发僵的概率。
- 去掉了中间空段落显示 placeholder 文案的样式，避免回车后出现“开始输入...”卡在正文里的观感问题。
- 修正“只有引用没有正文时无法正常发送”的问题，避免引用 chip 残留在输入区。
- 编辑态中的 `show-widget` code block 现在会折叠成可操作占位卡片，默认不再把整段 JSON / fence 原文直接摊在文档里。
- 占位卡片当前支持：
  - 查看 / 隐藏源码
  - 复制源码
  - 删除 widget
  - 一键切到预览模式
- 展开源码后，仍然可以直接在下方编辑原始 `show-widget` 内容，兼顾可视化和高级编辑。

## 已确认修复的问题

### 1. frontmatter 偶发“解析失败”
- 现在只有真正像 frontmatter 的区块才会进入 YAML 解析。
- 即使 YAML 不规范，也会先走宽松恢复，不会轻易把整篇笔记退回成原始观感。

### 2. YouTube 内嵌播放器变形
- 已修正 iframe 铺满 16:9 容器的样式问题。
- 同时补充了 CSP，允许 `youtube.com` / `youtube-nocookie.com` frame。

## 建议中的下一阶段细节计划

### 1. 继续提升“像 Obsidian 一样一眼读懂”
- 让更多字段自动转成语义展示：
  - `source`
  - `author`
  - `series`
  - `season`
  - `episode`
  - `status`
- 对视频型笔记增加更稳定的“信息卡布局模板”。

### 2. 文档引用与编辑联动
- 让文档引用 chip 后续支持点击高亮原文位置。
- 让 agent 能直接基于引用 chip 的位置信息优先选择 `document_replace_exact`，形成更强闭环。

### 3. 预览态与编辑态的结构对齐
- 逐步让预览识别出来的属性区与编辑态顶部 metadata 写法建立明确映射。
- 后续可考虑提供“属性区轻编辑”，但当前不建议立即做，避免把预览态复杂化。

### 4. 可补的测试
- 右键引用到输入框的 renderer 交互测试。
- `document_replace_exact` 在重复片段、多行片段、空替换内容下的行为测试。
- YouTube / 本地视频 / 图片在 preview 中的 UI 回归测试。
- Tiptap 回车创建空段落时的编辑态交互回归测试。
- `show-widget` 多 fence / malformed JSON / 未闭合 fence 的渲染回归测试。
- widget sanitizer 的白名单脚本与危险标签剥离测试。
