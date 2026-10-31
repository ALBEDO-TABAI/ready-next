---
title: Ready Next M5 Notion 层实施合同
date: 2026-10-31
status: in-progress
enforce: true
---

# Ready Next M5 Notion 层实施合同

## 1. 范围与依据

依据[整合计划](2026-10-30-ready-next-integration-implementation.md) §4、M5 及 D5 调研已采纳决定。A 交付文件模型、查询、Main 服务与书房定义升级；B–F 和真实窗口验收不能由 A 的命令行测试替代。遵守 C2/C3/C4/C5/C12/C15。

## 2. 已定决定

- `库.md` frontmatter 的 `ready_database` 必有 `version: 1`、`source`、`fields`、`views`。source 为同级目录名，默认同名 `库/`；`recursive` 默认 false，仅收直属 Markdown。书房升级明确设 true，保留嵌套来源页范围。
- fields 的键是实际存储键；每项有稳定 `id`、显示 `name` 与 `type`。显示名不改行，存储键改名保留 id，必须经可恢复迁移。视图及公式用字段 id，不用显示名。`$title`、`$id` 是只读系统列；标题改名归页面服务。
- 行身份复用对象 id；关联引用目标按现有身份服务写入 ready_id。视图有稳定 id、库内唯一名称；内联语法 `![[库#视图名]]`。不存在、重名和循环均明确失败。
- 字段、视图、筛选、排序、分组、列计算、可见列、卡片字段写库文件；列宽、当前视图和滚动位置属于 ready.db 个人状态。
- 未知 frontmatter、定义扩展、正文、注释及换行保留。已声明字段不合法返回带行 id、字段 id 的错误；不能默默变空。公式和汇总结果只在查询快照存在，禁止写回行。
- Renderer 只经 Main 服务操作，不能直接读写文件。Main 复用对象登记、页面草稿/回收站及文档写入服务；`merged_dirty` 返回 `unsaved`，不发已保存回执。

## 3. 文件格式与查询

| 类型 | 值与规则 |
| --- | --- |
| text / number | 字符串 / 有限数；缺失、null、0 分开 |
| select / multi_select | 字符串 / 不重复字符串列表；声明 options 时必须属于选项 |
| date | YYYY-MM-DD 或带时区 ISO 时间；范围 `{start,end}` 两端包含、同类且 start≤end，全天日期不转 UTC |
| checkbox / url | 布尔 / 合法 http(s) URL；缺失与 false 分开 |
| relation | 去重的 `[[页面]]` 列表；不接受别名、片段或任意对象；复用关系索引，缺失、回收、歧义明确返回错误 |
| rollup | `relation` 指关联字段 id，`target` 指目标 frontmatter 键，`operation` 为 count/sum/average/min/max/unique；关联集合被截断或未解析时返回 incomplete，不生成貌似完整的数值 |
| formula | `expression`：字面量、括号、算术/比较/逻辑、prop("字段id")、if/coalesce/abs/round/min/max；无 eval、属性访问或任意函数；语法、循环、除零分别报告 |

七类视图：table、board、calendar、timeline、gallery、list、bookshelf。视图包含 filters（全部满足）、sorts、groupBy、calculations、visibleFields、cardFields，时间视图用 dateField。先计算行派生值，再筛选、稳定排序、分组与列计算，最后分页；列计算覆盖完整筛选集合。多选按各选项入组，同值排序以对象 id 收尾。书架只投影 `类型: 书` 来源行。日期移动和看板拖动由 B 调用同一字段写入口，不创建日程。

查询缓存按对象 id、修订号、文件状态失效；目录成员和关联目标也参与重新核对。热查询不重复读取全部正文。关联查询若达到索引接口上限，必须标明不完整。热查询 1000 行 p95≤100ms；已有索引首屏≤500ms，冷读另记；真实滚动与输入延迟由 Claude 验证。

## 4. 操作、恢复与回执

- 写入请求含数据库对象 id、行对象 id（适用时）、expectedVersion；定义编辑另校验字段身份。新增行/删除行使用持久 operationId，重试复用页面服务回执。
- 存储键迁移：持久记录请求、逐文件原文/目标哈希和对象身份 → 按期望版本逐项改对应键 → 最后更新库定义 → 回读和索引确认 → committed。中断保留 prepared/recovery_required；重试只接受原版本或已写目标版本，拒绝覆盖后来修改。相同 id 不同输入拒绝；进行中禁止该库其他写入及查询，避免暴露半迁移。
- 视图改名写入持久待修复引用记录，回执明确 `pending_reference_repair`，由整合入口消费修复结果；不能声称引用已修复。
- 书房一次升级先保留原文件备份及持久计划，按同一恢复规则发布并回读。旧 `来源` 结构保持为 metadata；可编辑文本列迁至 `来源说明`（显示名仍为来源），由原 kind/ref/url 提供初值；新导入同时提供此文本列。已有字段、视图及自定义扩展保留，旧格式不进入正常查询路径。

## 5. 可执行验收合同

| 合同 | 验证 |
| --- | --- |
| DB1 格式、字段/视图/行往返、未知内容、具体错误、公式不落盘 | ready-database-roundtrip.test.ts |
| DB2 安全表达式、循环/除零、筛选排序分组/全量列计算、截断汇总、七视图与内联 | ready-database-roundtrip.test.ts |
| DB3 真实 SQLite、临时资料库、局部字段写、版本冲突、迁移中断/重试、回收站、缓存失效 | ready-database-native.test.ts，加入 verify:native；开头 skipIfSqliteUnavailable，Electron 无 skip 才算通过 |
| DB4 1000 行查询，记录 p95 | ready-database-performance.serial.test.ts（计时测试，串行运行） |
| DB5 阅读定义备份、恢复、回读及往返，自定义字段/视图和嵌套来源保留 | ready-database-native.test.ts |
| DB6 导入保真（整合计划 §4） | M5-E 的 ready-library-import.test.ts：层级、正文、字段、视图、附件逐项一致；源不变，缺失明确，中断可恢复，重试不重复；A 不宣称完成导入 |

## 6. 顺序与公共文件负责人

1. M5-A 与 M6-A 可并行，M5-C/D/F 先做独立服务。
2. A 冻结格式后 B 做七视图；A/D 合同齐备后 E 做 Notion/Inkwell 一次导入。
3. M3 T4/T6 后接编辑器、内联、评论和日期提及；M4 B–F 交接后接完整画板联动。
4. M5-F 收口来源页与 M5；M6-D 收口时间轴；M7 随功能复用当前 Codex 产品动作桥，不恢复旧 DomainAdapter。

| 范围 | 唯一负责人 |
| --- | --- |
| 格式、查询和本模块服务 | M5-A |
| 七视图及内联 | M5-B |
| 速览、⌘K、关联面板 | M5-C |
| 模板、持久块锚点、同步块、评论 | M5-D；M6-C 复用锚点 |
| Notion/Inkwell 预检与一次导入 | M5-E |
| 来源页统一及总接线 | M5-F |
| main/index、preload、electron.d.ts、migrations、package.json | 同一整合负责人串行接线；本次 A 只新增自身迁移和 verify 登记，模块导出注册函数 |
| DocumentMode、NotePreview、MarkdownEditor、块编辑挂载、快捷键公共入口 | 同一整合负责人 |
| object-links、关系抽取/重建、open-ready-ref | M4 B/F 交接后由同一整合负责人修改 |
| 阶段验收汇总和大文件台账 | 整合负责人，A 提供实际行数及风险 |

## 7. 交付状态

M5 尚未全部收口。2026-10-31 M5-F 核对结果：

- A：Main 已注册 `registerDocumentDatabaseIPC`，使用资料库授权及页面恢复屏障；preload/types 已接通。原 CRLF 关联缺陷在当前工作树已修复，`ready-database-relations.test.ts` 本次回归通过。
- B：七视图组件、`NotePreview` 内联视图及样式已存在。独立数据库页没有挂载 `Database`；需要在 `DocumentMode.tsx` 的文档路由接入。该文件未列入本次“允许改动”，故只记录，不越界修改。视图改名引用修复仍不是已完成回执。
- C：`ObjectUIHost` 在 Workbench 挂载，速览/快速切换与 DocumentMode 的关系面板已接线；Main 的 ObjectRelations 注册已存在。
- D：Main/preload 的文档标注注册、块编辑器的评论/模板/同步块入口已接线。本次修复与阅读划线缓存同名冲突：阅读定位缓存迁至 `.ready/anchors/<id>.highlights.json`；评论继续使用 `<id>.json`。阅读入口及评论准入共用一次迁移，旧缓存只移动一次，不留双读路径。
- E：当前工作树未找到 Notion/Inkwell 导入服务或 `ready-library-import.test.ts`，没有可补接的模块。等待 M5-E 交付，不能宣称导入保真完成。
- F：书、RSS、网页共用来源页生成与标注写入/合并逻辑；RSS 阅读选区与 BrowserMode 的 FastCard 来源标注入口已接通。网页捕获现存页签的真实选区、前后文和快照版本，页面换代拒绝保存。重复划线保留已有块身份；原文改写后保留旧摘录及旧版本引用。PDF 仅有来源建页适配，真实选区与页内回跳尚未接通。
- 本次命令行结果：来源及书房/引用/导入/关联专项 22 项通过、零跳过；完整 verify:native 同批替代执行 458 项，455 通过、3 项文件监听因 `EMFILE` 失败、零跳过。失败来自 `calendar-layers-native`、`library-engine`、`ready-object-identity-native` 的真实监听，未改断言或将失败记作通过。Widget 同批替代执行 163 项全部通过。类型、IPC 对应、SQLite skip 规则、CSS reset 与改动文件 ESLint 通过。
- `verify:ready-next-sources` 已提供真实窗口脚本：回环网页/订阅源、隔离 userData、realpath 临时资料库、书/RSS/网页划线、来源页预览、原文定位与高亮、重启回读。脚本仅完成语法检查，本沙箱未运行窗口验收；界面可用性与高亮效果须由 Claude 验证。
- 缓存分离后，现有 `scripts/verify-ready-next-library-electron.cjs` 的两处旧缓存路径断言也需改为 `.highlights.json`。该脚本不在本次允许范围，未修改；新来源窗口脚本不依赖旧路径。

## M5-D 格式与规则

- 锚点由共享 M3 块区间解析。已有 `^block-id`（段尾或块后的独立标记行）优先；创建同步源时显式追加标记，评论绝不追加标记。无标记评论使用 `.ready/anchors/<对象id>.json`，存原文、块类型、相邻块原文、文档版本和区间。精确唯一原文可随移动定位；改写只有显式 id 可以可靠追踪；无 id 改写、删除、无法通过上下文唯一核对的重复候选均返回 `lost`（原位置已变化），不模糊猜测。页面身份取对象登记，不以路径作键。
- 评论权威是 `.ready/comments/<对象id>.json`：格式版本 1、修订号、线程 id、锚点 id、消息及解决状态。增删改解决均核对期望修订号，Main 串行原子发布并回读。锚点先发布，评论后发布；中断最多遗留未使用锚点，不能产生悬空评论。损坏数据报错，禁止清空重建。删除正文后保留评论及原文摘录，显示失联且禁止错误跳转；恢复原块后可重新定位。
- 同步块采用 `![[页面#^id]]`。引用处只读并提供“回到原处编辑”；源编辑沿页面保存服务的 expectedVersion 检查。解析限制在已授权资料库，缺失/回收/歧义/循环显式报错。引用不保存正文副本；刷新重新读源，支持嵌套但限制深度并检测循环。
- 模板为资料库 `模板/` 的 Markdown，变量 `{{date}}`（本地 YYYY-MM-DD）、`{{time}}`（HH:mm）、`{{title}}`。展开冻结日期和标题，清除旧 ready_id，重分配显式块 id，重写同页块引用，外部引用不变；附件复制至新页 `.assets/` 并核对哈希。新建经过可恢复草稿及页面保存链；以 operationId 固定展开结果、草稿及保存参数，重试复用同一份，不重复建页，不覆盖后来编辑。插入模板走编辑缓冲的一次区间操作，一次撤销恢复原字节；异步选择期间缓冲变化拒绝插入。
- 验收：`ready-annotations.test.ts` 固定锚点移动/改写/删除与歧义；`ready-annotations-native.test.ts` 用真实 SQLite 和临时资料库验证正文字节、改名移动、评论冲突、模板中断恢复及源版本冲突；`ready-annotations-ui.test.tsx` 验证菜单和单次撤销。`verify:ready-next-annotations` 的真实窗口流程由 Claude 运行，命令行结果不代替窗口验收。

M5-D 实施补充：模板新建复用“保存到…”选择位置，再经页面服务创建可恢复草稿并定稿。`.ready/template-operations/<operationId>.json` 固定请求、展开正文、附件暂存位置与哈希；资料库服务首次接入时自动恢复未完成建页。插入模板同样固定展开结果并复制附件，但恢复绝不把旧插入操作重放到另一份编辑缓冲；正文撤销不删除已经复制的附件。附件暂存和操作记录保留用于重试核验。正文未保存时添加评论明确拒绝，要求先保存；已有评论定位即时对当前缓冲重新核对。无显式 id 的重复原文只有前后相邻原文同时唯一匹配时定位，否则失联。编辑器移动/删除代码等带独立标记行的块时，标记与源块作为一次操作处理。

命令行验收入口：`npm run verify:ready-next-annotations -- --checks`；真实窗口入口：构建当前分支后 `npm run verify:ready-next-annotations`，使用独立临时资料库和 userData，逐步保存磁盘回读与截图。窗口流程未在无窗口沙箱执行，不能据命令行结果宣称窗口验收完成。共享锚点供 M6-C 复用：`createAnchor`、`relocateAnchor`、`explicitBlockId`，存储格式以相应 Zod schema 为权威；评论、模板与同步块跨进程面为 `documentAnnotations`。

## M5-E 导入规则

- 入口：页面侧栏“更多 → 导入 Notion / Inkwell”。向导依次选择来源、只读预检、ConnectedSaveToPicker 选择目标、核对目标冲突、执行进度、结果/缺失清单及打开结果。中断记录可在向导重新打开后继续。
- Notion 支持 Markdown & CSV ZIP：按导出路径及 32 位身份匹配页面与 CSV 行，同名页面保留独立身份并确定性改名；目录映射为页面三件套 `A.md + A/ + A.assets/`。Markdown 标题、列表、引用、代码及表格保留；`<aside>` 转引用，`<details><summary>` 转带标题的列表，展开内容保留。CSV 无字段类型元数据，第一列为标题，其余列原样映射 text，编号不推断为数字；CSV 行合并对应 Markdown。默认表格视图；原视图、公式、评论等导出未提供的信息逐库列为缺失，不宣称无损恢复。
- Inkwell 选择其真实导出 `format: inkwell-backup, version: 1` JSON（`packages/app/src/app/io.ts:exportWorkspace`），不启动原应用，不读其日常目录。页面树与块位于 blocks，数据库为 collection_view(_page)，schema/views 位于 props，行值在子 page.props，附件为 props.src/url 的 data URI 或相对文件。无需读取运行中的 SQLite，避开 WAL 快照风险。支持正文、列表、引用、代码、表格、callout/toggle、内嵌附件及数据库；缺失块/附件和未知块逐项报告。同步块、评论、外部媒体、布局/交互/用户信息不假装已恢复，保留可转换内容并列不支持项。
- Inkwell 字段：title→页面标题；text/email/phone_number→text；number/checkbox/url/select/multi_select/date/relation 同类型，status→select；created_time→ISO date；person/file→保留原值的文本并报告降级；formula/rollup 保留原定义为文本并报告不支持计算。视图保留 table/board/list/gallery/calendar/timeline、顺序、可见列、卡片字段、日期字段、可映射筛选排序分组/汇总；无法映射的选项逐项列出。字段存储键统一为稳定导入键，避免与 Ready 保留字段冲突。
- 内部页面链接转换成 `[[规范相对路径|原标签]]`；关联值无别名。无法唯一匹配的链接保留原文并列缺失。附件复制到所属页面 `.assets/` 并核对大小和 SHA-256；未引用 ZIP 文件也保留在导入根页附件中。不下载远程附件。
- 预检不写文件/SQLite：扫描并返回页数、数据库数、行数、附件数、逐项路径映射、缺失/不支持/重名映射及目标冲突。选择目标后重新核对三件套冲突；冲突阻止执行，不自动覆盖。源 ZIP/JSON 限 64 MiB，最多 5000 条目，单附件/解压条目最多 16 MiB，总解压/附件最多 128 MiB，压缩比最多 200，路径深度最多 32。拒绝绝对路径、穿越、符号链接、加密/ZIP64、不支持压缩法和规范化重名；解压前核验目录大小，解压时硬限制输出长度。
- Main 为单一执行者。持久操作记录固定源内容哈希、目标、完整转换清单及附件字节；操作身份由源哈希与目标确定，重复执行复用同一记录。状态为 prepared/running/interrupted/completed/incomplete；prepared 后不再依赖源文件。逐页使用页面服务的持久 create，数据库经共享定义校验及数据库服务回读；附件使用现有写入服务的暂存/独占发布，不另写覆盖路径。每个阶段可注入中断，恢复以同一页面操作身份和发布证据继续，不重复建页，不覆盖后来修改。
- 完成前逐页、逐库、逐附件回读并核对身份和哈希；任何缺失/降级或回读差异都返回 incomplete 及明细，只有清单完全一致才 completed。源始终只读。操作日志留存以支持重试、重启回读和追踪，不把 Renderer 进度当完成真值。
- DB6/C2/C3/C12 验收：`ready-library-import.test.ts` 合成 Notion ZIP 与真实 Inkwell backup；真实 SQLite/临时资料库验证逐项往返、源不变、每阶段失败恢复、重名/冲突/目标修改与恶意 ZIP；`ready-library-import-ui.test.tsx` 验证向导。原生测试进入 verify:native；`verify:ready-next-import` 为真实窗口验收，Claude 执行，命令行通过不代替窗口通过。

## M5-F 来源页规则

- 来源包括书、RSS 文章、PDF、网页；统一文件与标注规则，不合并阅读器。书保留 `阅读/`，RSS 与独立 PDF 来源页使用 `文章/`（避免混入仅收书籍的阅读数据库），网页使用 `网页/`。来源身份与页面路径分开，重复采集复用来源身份，改名、移动或重建索引不能新建第二页。
- frontmatter 保留现有字段；新增来源页记录 `ready_id`、`类型`、`作者`、`链接`、`加入`、`来源引用`（ReadyRef URI）。书的原 `来源` 是导入元数据，不能覆盖。正文包含 `## 标注`、`## 我的笔记`。标注正文只有来源页这一份权威，`.ready/anchors/<id>.highlights.json` 只是可重建定位缓存，与文档评论锚点分开。
- 书用章节/分页位置与非空白字区间；RSS 用文章身份、版本和 reading-v1 映射区间；PDF 用文件身份、哈希、页码与文本区间；网页用原 URL、快照哈希、文本引文及前后文，回跳使用文本片段。不能只靠 XPath 猜测原位置。
- 所有标注链接使用 ReadyRef，交给现有 open-ready-ref。精确定位必须核对原文，失效不能冒充成功。保存的摘录在脱机时仍可阅读，来源页明确注明原文不可用时无法回跳。
- 同一来源写入串行，经共享文档写入服务检查版本并同步索引；未保存编辑只能返回待保存，不能发布已保存回执。重复及重叠划线沿现有区间合并规则处理，书房颜色、批注和定位行为保持不变。
- 网页划线 IPC 只读取指定的现存浏览器页签，采集前后核对页面身份。任何 DOM 覆盖面先隐藏 BrowserView；本次采用不打开覆盖面的划线按钮，保存结果显示在浏览器工具栏。
- PDF 阅读器已有文本层，但尚无导出版本绑定选区或消费页内范围的回跳入口。`PdfViewer.tsx`、`open-ready-ref.ts` 不在本次允许修改范围；本次交付 PDF 来源适配与建页，不伪造 PDF 划线/高亮。后续须同时接通真实选区与回跳消费者。

可执行合同：`ready-sources-native.test.ts` 使用真实 SQLite 与 realpath 临时资料库验证四来源、重复合并、改名移动、重建索引及关系；原有 library-engine/highlights/quote 测试验证书房不回退；`ready-sources-ui.test.tsx` 验证 RSS 和网页划线调用与失败显示。`verify:ready-next-sources` 为 Claude 的隔离真实窗口验收入口，命令行通过不等于窗口通过。
