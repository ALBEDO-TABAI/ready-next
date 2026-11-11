# M5-C 对象界面合同（C1 / C3 / C14）

本文件补充 M5 合同 §5/§6；范围外的阶段计划和公共快捷键入口不修改。

- 查询：GlobalSearchPanel 与快速切换共用查询与草稿匹配。新输入立即撤销旧请求的展示资格；未保存内容覆盖磁盘命中，包括草稿已不再匹配的情况。
- 入口：关联项和快速切换结果有速览按钮；Alt 点击同样速览。引用胶囊由全局宿主捕获 Alt 点击有效 ready:// 链接。普通打开只经 openReadyRef。
- 速览：只读，不写草稿、不保存。文档存在性先确认，再采用当前标签草稿。缺失/回收/删除明确失效；读取失败与失效分开。其他 ReadyRef 显示其服务可确认的摘要或明确的不可用说明，不伪造内容。
- 遮罩：请求隐藏前锁定恢复；只有匹配 hide-all 确认才展示。超时、异常不展示；关闭、卸载及迟到确认均释放本次锁，恢复仍由原生协调层负责。
- 关联：Main 按对象 id 查询 object_links，返回出链、反链、未解析原因、全量反链计数和截断标志。标题/路径由当前对象登记读取；移动改名不改变关系身份。不猜测同日/同来源。
- 挂载：文档模式只挂关联面板。ObjectUIHost 必须由工作台公共入口挂一次；同时移除日历的旧 ⌘K 抢占。两处公共文件不在本任务允许范围，由整合负责人处理，不能把未接线组件算全局快捷键已完成。
- 命令：新建页面经现有页面服务确认落盘后打开；四种现有模式及设置。未接通的画板保存等命令不展示。
- 验证：ready-next-object-ui.test.tsx 验证真实 store、键盘和过期响应；ready-next-object-relations-native.test.ts 在真实 SQLite 验证关系及移动改名；遮罩测试证明无确认不显示。verify-ready-next-object-ui.cjs 负责真实窗口，不能用命令行测试代替。


## W6 数据接口（T2–T4，2026-11-12）

- 打开仍只走 `openReadyRef(ref)`。FastCard 保持当前模式；`useFastCard.revealTarget = { id, requestId }` 同时供内容抽屉和网页层上方的现有浮窗消费。对话保持模式、打开助手，`useConversationReveal.target = { scopeId, messageId, requestId }` 由消息列表滚动后消费。资讯查询先校验保存的版本，进入资讯后整体替换条件，不能合并旧条件。
- 速览仍调用 `loadObjectPreview(ref)`，返回 `ObjectPreview`：`state: ready` 时有 `title/body/markdown/unsaved`；对象缺失返回 `invalid`，服务读取错误保留失败，不能当作空内容。未保存正文仍优先于磁盘。新增 `data` 的类型见同目录 `preview.ts` 的 `ObjectPreviewData`，文件内容由 Main 读取，UI 不解析文件或自行计算业务数据。
- `data.kind = database`：`definition/view/rows/total`，默认视图过滤、排序和计算后的前 5 行；行含 `id/title/version/values/cells`。`cells` 保留值、错误或不完整状态。接口为 `electronAPI.databasePreview(databaseId)`。
- `data.kind = canvas`：`title/nodes[]`，节点含 `id/x/y/width/height/title`，不包含已回收节点。`book`：`book {id,title,author,coverPath?,format}` 与 `passage {text,prefix,suffix,chapterTitle,note?,located} | null`。划线保留来源页原文，不能唯一重定位时 `located=false`，不猜上下文。`web`：`title/url/excerpts[{id,text,note}]`；没有来源页时摘录为空，标题优先取书签。这三类使用 `electronAPI.objects.preview(ref)`，共享形状在 `src/shared/object-preview.ts`。
- `day`：`summary {date,timeZone,items[]}` 直接来自“这一天”；`event`：`event/start/end` 保留实例时间；`rss-item`：`article {id,title,source,link,summary?}`、`relevance {reason,score,because,workRef,summaryOnly,workKind?} | null`，片段另有 `excerpt`；未分析或理由版本失效返回 `relevance=null`，不触发模型。`rss-query`：`total/items[]`；`rss-digest`：`report/entries[]`；`conversation`：`scopeId/run?/messageId/question/answer`（回答前 1200 字符）；`fastcard`：完整 `card`。普通页面和文本文件沿用正文 `body`；非文本文件为 `kind=file`，`file {type:binary,category,localUrl,extension,bytes?,size?,kind?}` 来自现有文件读取服务，供 PDF、媒体等视图取内容，不再只返回路径。
- 搜索结果保留 `name/path/sourceType`，新增必有的 `title/typeLabel`；类型名来自 `src/shared/search-presentation.ts`。文档文件名去扩展名，frontmatter 标题和文章标题不按小数点截断。草稿与磁盘命中使用同一展示规则。
- 书和划线按资料库来源页重建（`book`、`highlight`），FastCard 按 ready.db 重建（`fastcard`）；划线搜索结果以来源页 `^hl-id` 为稳定落点。书的默认入口为 `c0:0+1`；PDF 等非段落阅读格式在该入口打开书文件，其他段落位置仍明确拒绝。C5 重建只清投影。
- 书源 `bookSources.manualLink(id)` 返回 Main 校验的网址；渲染层经 `openWebpageInBrowser` 打开。资讯原文同路，日历加入会议既有接线已核对。Ready 浏览器创建失败不得自动外开。
- `scripts/check-external-open.cjs` 随 `verify` 检查 Renderer 的 `window.open` 与 Main 的 `shell.openExternal`；只允许脚本内具名调用点及数量，注释和字符串不算调用。白名单仅记录现有认证/外部协议、明确外开菜单和其 Main 承接入口。

## W6 引用胶囊、速览呈现与 ⌘K（T1–T3 界面，2026-11-12）

- 胶囊：`components/ui/RefCapsule.tsx`（行为 `ref-capsule-actions.tsx`，类型与图标 `ref-capsule-kinds.ts`）。点击经 `openReadyRef`；⌥ 点击、悬停后按空格、键盘焦点在胶囊上按空格，都发 `ready:open-quick-look`（`requestQuickLook`），只由 ObjectUIHost 承接，不另建预览面；⌘ 点击（及中键）为 `openReadyRef(ref, from, { newTab: true })`：页面、文件、画板在新标签打开。文档模式没有分屏，资讯、日历、对话、收集没有标签，这些去向 ⌘ 点击与点击相同。拖动写 `writeReadyRefTransfer`：`application/x-ready-ref` + `text/uri-list` + 标题。右键：打开 / 速览 / 复制引用 / 在文件视角中显示（只给页面、数据库、划线、画板、文件）。打开失败一律 toast。可访问名称为“类型 标题”。
- 可编辑正文：胶囊就是 `dom-inline` 画出的同一个链接，只加 class 与 data（图标是遮罩生成框，不是文本节点），文本、光标、输入法与 Markdown 源不变。`[[wiki]]` 引用悬停时解析一次，拖动时用已解析的引用。日期胶囊点击仍打开日期与提醒（C9），右键多一项“修改日期与提醒…”，⌥、⌘、拖动与其他胶囊一致。普通网页链接不是胶囊。
- 速览：`QuickLookContent.tsx` 按 `data.kind` 画内容——数据库前几行、画板缩略图（卡片位置与标题）、书与划线（封面、书名、作者；划线与段落另有原文、前后各约 60 字的上下文与批注；书的默认入口 `c0:0+1` 只显示书）、资讯（出处胶囊、摘要或片段、筛子理由）、这一天（按类分组的胶囊）、日程（时间、地点、说明）、网页（网址与摘录）、对话（问题与回答开头）、收集（卡片与出处）、媒体文件（图像、音视频，其他文件给类型与大小）。页面与文本文件沿用原正文预览（页面按 GFM 显示表格与任务，去掉重复的标题行，`[[wiki]]` 显示为页面名，只影响显示）；失效与不可用仍明确写出。速览里的胶囊打开时速览让开。
- ⌘K：显示 `title` 与中文 `typeLabel`（图标随类型）；↵ 打开，⌥↵ 速览，⌘↵ 新标签打开；点击读同样的修饰键。空输入的“最近打开”仍是现有的文档列表，跨模式历史属 T7。
- 验证：`ready-ref-capsule.test.tsx`（四种操作、菜单、键盘与悬停）、`ready-block-editor-capsule.test.tsx`（可编辑正文）、`ready-quick-look-content.test.tsx`（速览内容与 ⌘K）；真实窗口 `npm run verify:ready-next-capsule`。
