---
title: Ready Next M7-A/B 结构化资源与只读能力
status: complete
enforce: true
---

# M7-A/B 合同

范围只含读取；M7-C～F 不在本合同内。验收以行为测试及实际产品桥接线为准，合同存在、类型通过或底层函数通过均不代表产品交付。

## 实施边界（2026-10-31 续作）

已获准在 tool-executor 增加新工具分发、在 action-confirmation-policy 登记新只读规则。
资源 schema、冻结记录和工具参数由同一组可执行定义约束。资料库身份为规范根目录的 SHA-256，不向模型暴露根路径。
文档资源另声明 text/database/highlights 读取目的；数据库查询的行必须是同轮独立选择的完整页面。数据库定义不授权整库行。
日历当天冻结显式条目 ID、ReadyRef 和类别；Main 读取后签发内容版本。窗口沿用已有结构事实，不依赖资料库或本地会话。
打开缓冲不得借用写入同步协议（prepare 会获取保存锁）。现有只读 Renderer 桥只支持当前焦点文档的格式化摘录，不提供任意标签的原始范围/实例读回；未接通这项验证前，对带 buffer 的资源明确拒绝，不退回磁盘旧正文。持久草稿可独立按 ID 和数据库内容版本读取。

## 资源与信任边界

1. Renderer 发送结构化选择，不能携带正文。Main 先解析严格 schema，再检查当前资料库、对象登记、唯一身份、版本、范围及打开缓冲身份。ReadyRef 只定位，不产生授权；正文中的 URI 不参与准入。远程消息不得借此取得本机资料库授权。
2. 文档选区：资源 ID、名称、资料库身份、page/file ReadyRef 或持久草稿 ID、内容版本、零基半开 UTF-16 范围、选区摘要（字符数和摘要哈希）；打开缓冲另绑定标签实例和缓冲版本。无身份草稿、已关闭标签、版本不符、歧义定位、范围越界均拒绝。全文读取也必须由显式选择的完整范围授权。
3. 画板选区：资源 ID、名称、资料库身份、canvas ReadyRef、内容版本、显式节点 ID 集。群组不自动展开；内部连接仅返回两端均在选区中的边。文件卡和链接卡不得隐式读取目标。
4. 书籍位置：资源 ID、名称、资料库身份、book-location ReadyRef、资产哈希版本、章节、零基半开 UTF-16 范围。来源页与书籍资产分别授权。仅在来源页被独立选择时可读取其正文和标注。
5. 日历当天：资源 ID、名称、日期、IANA 显示时区、汇总类别和对象范围。日期不是 UTC 时间戳；窗口按显示时区计算。日历窗口保留既有结构资源，但读取必须受冻结窗口限制。
6. Main 生成只含名称、身份、范围、版本、读取工具名的模型输入。旧 quoted_text 正文通道删除，迁移消费者，禁止兼容回退。资料库单项准入失败返回 unavailable 与重新选择提示，不包含正文或主机路径，也不签发该项读取授权。
7. 准入记录与版本引用一起持久冻结；恢复时验证二者绑定。执行时只接受该记录内资源 ID，重新读取并核对版本和范围。读到的关系、引用、材料指令都不能修改冻结授权。

## 只读产品工具

所有工具均走现有产品动作桥的精确工具→动作映射、同轮身份及行动确认入口。新增只读分支在读取前后检查本轮资格，不写产品副作用账本、不重放旧读取回执；既有写工具账本逻辑不变。以下名称是本合同的固定入口。确认规则逐个登记为只读、无需确认；不得命中未知工具的默认放行。公共参数 `resourceId` 是本轮冻结资源；`expectedVersion` 必须等于冻结版本。列表参数 `offset` 为非负整数，`limit` 为 1–100；文本参数 `offset`/`length` 为选区内部的相对范围，`length` 最大 12000。未知字段、非法数值和越界请求拒绝。

| 工具 | 额外参数 | 授权和返回 |
| --- | --- | --- |
| library_list_pages | offset, limit | 只列本轮明确选择的页面，不枚举资料库或递归子页；返回对象 ID、名称、版本，无正文 |
| library_read_page | offset, length | 只读冻结 Markdown/纯文本页面范围；可用完整范围读正文、用局部范围读区段/选区；来源页同此入口 |
| library_read_database | 无 | 定义及定义版本；数据库对象必须显式选中，未授权行不返回 |
| library_query_database | viewId, offset, limit | 复用视图规则，仅对已授权行计算；关联字段不追读外部对象，依赖未授权关系的计算必须标明不可用，不伪报完整 |
| library_read_board | offset, limit | 选中节点的内容、布局和内部连接；只读指定版本，群组不隐式扩大范围 |
| library_read_book | offset, length | 指定 EPUB/TXT/Markdown 章节和引用范围，返回资产版本；不运行扫描、升级、ensure 或阅读记录写入 |
| library_read_highlights | offset, limit | 单独授权来源页中的标注；返回来源页版本，不顺带打开书籍 |
| library_query_links | direction, offset, limit | direction 只允许 outgoing/incoming；只返回授权资料库中已登记且已解析的对象端点，另带关系快照版本；关系查询不授予目标正文权限 |
| library_read_calendar | offset, limit | 冻结窗口/当天/时区/类别/对象范围内结果；不写提醒送达、足迹或图层缓存 |

统一回执：`version`、`scope`、`items` 或 `text`、`offset`、`nextOffset`（结束为 null）、`complete`、`total`。`complete` 只说明授权范围是否全部返回，不表示全库完整。部分授权的视图必须另说明 `coverage: selected_objects`。页间版本变化直接拒绝，不能继续旧分页。文本不得静默截断；返回长度与下一偏移必须一致。空集合是完整空结果。

## 读取不得产生写入

禁止调用 ObjectRegistry.reconcile/locate 注册、页面 tree 登记、DocumentDatabaseService.read 的修复逻辑、LibraryEngine.get/findBook 的升级扫描、SourceDocumentService.ensure、CanvasService.open 的句柄/登记副作用、任何 mutate/save/write/index。复用纯解析/视图算法；需要时新增仅 SELECT 和文件读取的入口。Main 先检查已登记身份和真实路径边界，再读取；链接越出当前资料库拒绝。磁盘改变导致旧索引失效时报告变化，不修复索引。

## 工具面

显式资源只产生对应只读地板；资料库 advisory 技能不产生工具或对象授权。加性组合保留其他已授权能力，但不得通过资源增加写权限、shell、任意路径访问。线程冻结面缺少读取地板、排他技能不容纳该地板时在准入阶段拒绝；执行中不补工具、不启动第二模型循环。

第 9 项续作合同：已获准修改 `codex-tool-surface.ts`。`resolveReadyToolTurnSnapshot` 仅在 Main 准入后的 requestEnvelope 含 `kind: library_resource, canRead: true` 时保留资料库只读候选工具；失效资源和普通文字不产生地板。过滤同时发生在本轮比较面与新线程冻结面，既有线程冻结面不修改，最终逐资源授权仍由既有组合入口负责。行为验收覆盖无资源 → 有资源 → 无资源：两次无资源轮次均可继续；中间轮次若旧线程缺地板则明确拒绝扩权，仅新上下文可冻结所需工具；返回无资源时撤销资料库调用权限，不因撤销要求再次开启上下文。工具不存在与本轮未授权的错误仍由现有执行桥区分。

## 可执行验收及 gate

- `ready-ref-agent-resources.test.ts`：伪造 URI、歧义对象、跨库、旧版本、无身份草稿、越界和未授权对象拒绝；缺少工具地板拒绝。拒绝没有正文/路径泄漏和写入调用；检查真正送入模型的 input 无正文。
- 只读工具行为测试：每个工具的允许/拒绝、分页边界、完整性、版本变化；临时目录和真实 SQLite 对比前后文件字节、目录条目、数据库快照及写入调用次数。
- 关系查询结果再用于正文读取仍须独立授权；引用卡不能读取目标；数据库关系计算不得读取范围外行。
- 回归 codex-explicit-resources、codex-product-resource-envelope、codex-tool-surface；`verify:codex-workbench-surface`。
- `typecheck`、`skills:lint`、`check-ipc-contract`、改动文件 eslint、`verify:native`。tsx 管道受限时用 node/Electron 的 `--import tsx --test` 运行相同文件，skip 不算通过。
- 本任务不启动 Electron 窗口。四类附件、切换标签、人工编辑后旧版本拒绝的真实界面验收由 Claude 承接。

## 当前交付状态与待接线边界

已落地四种发送资源、Main ReadyRef/资料库/版本/选区校验、冻结与恢复绑定、九个只读工具、明确确认规则、资料库 advisory 技能、摘录及当天发送迁移。入口为 `npm run verify:ready-next-m7-read`。行为测试使用隔离临时目录和真实 SQLite，不依赖源码文本匹配，不把 ABI skip 当通过。

本合同的命令行交付范围之外仍未覆盖（complete 不代表以下产品验收已完成）：

- 打开的未保存文档选区仍拒绝。已核对现有 Renderer 工具桥要求 live run（`runtimeDriver.ts`），不能用伪造 run ID 在准入前取证；写入同步的 prepare 会拿保存锁，不能借来做只读。持久 `document_drafts.tab_id` 也不能证明标签仍打开（关闭标签不清除该历史绑定）。需要扩充只读快照合同及接收端，涉及允许范围外的 `src/shared/document-operations.ts`、`src/renderer/modules/document/documentOperationSync.ts`、`src/renderer/stores/useDocTabs.ts`；这些文件未修改。
- 已存文档摘录在加入附件时冻结身份、版本与范围，历史无身份摘录拒绝，不恢复正文直塞路径。画板/书籍/数据库选择尚需相应组件把选择元数据放入 `ChatAttachment.libraryResource`；本任务没有修改组件或添加按钮，不能把类型和 Main 接线当成这些界面已接通。
- 真实 Electron 窗口由 Claude 验收，且需要真实模型调用，命令行通过不能替代该验收。当前代码行数台账不在允许范围，因此超 1000 行的净增文件列入最终报告，不改台账。

只读回执的 `complete` 是本次分页是否走到授权结果末尾。数据库视图的关联/汇总依赖不追读目标；缺失目标明确为 incomplete。画板边按起点所在分页返回，仅包含两端均选中的边。图关系另冻结 `linksVersion`，后续分页遇到关系变化拒绝。

上次 M7-A/B 命令行记录（不是本轮修复验收）：完整 native 同批测试 474 项，471 通过、3 失败、0 跳过；三个失败在范围外的文件监听测试，均报 `EMFILE: too many open files, watch`。执行保留既有原生模块，先做 ABI 检查，再用 Electron `--import tsx --test` 跑 package.json 中同一列表，没有运行 install-app-deps。工作台脚本的 tsx 管道报 `listen EPERM`，改用 node/Electron `--import tsx --test` 跑原列表；其中两个 Node ABI guard 另用 Electron 补跑同文件，34 项通过、0 跳过。其余本次检查结果见最终交付消息。

## M7-AB-FIX 修复合同（先于实现）

- 日历窗口保留原发送语义；资料库准入失败逐项返回不可用标记，不授予该项读取权限，不阻断其他资源和用户消息。
- 资料库失效归附件错误，缺少冻结工具归新上下文恢复，不进入服务故障自动重试。
- 发送准备失败返回现有 attachment_unavailable；引用及“这一天”的异步失败必须显示在已有错误位置。
- 源码编辑引用消费精确 UTF-16 范围；页面引用消费 DOM 选区及块源码行号，经 Markdown 位置映射生成源码范围。不能证明映射时明确拒绝，不能按首个同名词猜测。
- .md 使用 page，.txt/.markdown 使用 file，与对象登记种类一致。
- 日汇总逐项解析身份；移动后读当前位置，删除或无法读取仅该项 unavailable；日记日期采用 calendarDate。
- 回归测试在现有 M7 测试文件中补充：上述失败、逐工具内容和分页、卡片不追读、关系字段、文档/待办/足迹/活动、关闭标签。未保存缓冲的 Main 只读验证仍受下述范围限制，不能把所有 buffer 拒绝冒充关闭验证。
- 第 9 项初次修复时冻结入口不在允许范围，先保留失败复现；本次范围已批准，按上文续作合同直接修复冻结入口。


修复落位说明：第 1–8 项已落位。calendar_window 已移回原有日历结构上下文，不再进入 LibraryReadResources；calendar_day 仍是显式资料库读取。library_resource_unavailable 分类为 attachment_unavailable；library_read_tool_surface_missing 分类为 native_tool_surface_extension_required，复用现有开启新上下文回执签发路径。编辑器使用实际区间和源文本，页面模式的 DOM 范围映射以块源码行号为边界；不支持或过期映射显示原有错误栏，其他菜单仍保留原渲染选中文字。

缓冲验收边界：新增 Renderer 行为测试先证明打开的持久草稿能生成 buffer 资源，再移除真实 store 中的标签并验证同一次选择被拒绝；Main 仍不接受任何 buffer，不能把前述 Renderer 检查当成 Main 已接通读取证明。

第 9 项已修：`resolveReadyToolTurnSnapshot` 在创建和比较冻结面之前，根据本轮 Main 准入资源保留资料库只读候选；无可读资料库资源时排除新增工具。既有冻结面不改写，具体资源地板仍由原有组合入口校验。普通会话复现及三轮切换行为测试均通过。ToolRegistry 列表、执行查找和错误分类未改动。

第 9 项续作验收：typecheck 通过；`verify:ready-next-m7-read` 为 Electron 18/18、Node 66/66；工具面、执行桥、显式重试和产品资源回归 89/89；`verify:codex-workbench-surface` 原清单 27 个文件全部用 Electron `--import tsx --test --test-concurrency=1` 直接运行，234/234，零跳过。`native:check` 通过（Electron 42.3.0、ABI 146）；`verify:native` 原清单 87 个文件用相同 Electron 方式运行，474 项中 471 通过、3 失败、零跳过，失败仍为范围外 calendar-layers-native、library-engine、ready-object-identity-native 的 `EMFILE: too many open files, watch`。未执行 rebuild/install-app-deps。两份改动代码 eslint、diff --check 通过；总行数分别为 796、283，无本轮新增的超 1000 行文件。合同 complete 仅表示本次批准的 M7-A/B 命令行实施范围已完成；未保存缓冲读取仍未覆盖，真实窗口须由 Claude 使用真实模型调用验收，完整 native 未全绿。


第 1–8 项历史验收（第 9 项续作前）：typecheck 通过；verify:ready-next-m7-read 的 Electron 读取测试 18/18、其余 64/65，唯一失败为第 9 项保留的工具冻结回归。工作台原脚本遇到 tsx listen EPERM 后按同一清单直接运行，Node 222 通过、同一回归失败、2 项 ABI guard；这两个文件已用 Electron 补跑 34/34，工作台原生段 8/8。额外 Codex 回归 40/40，新增验收脚本资源解析测试所在文件 3/3。完整 native 清单用现有 Electron 依赖直接运行（先 native:check，未执行 rebuild/install-app-deps），474 项中 471 通过、3 失败、0 跳过，失败来自范围外 calendar-layers-native、library-engine、ready-object-identity-native 的 EMFILE 文件监听。library-reference skills:lint、check-ipc-contract、改动文件 eslint（0 errors，4 个既有 warnings）及 diff --check 通过。额外 silent-catch 检查中，本范围已处理，仍有 59 处范围外告警；未修改那些文件。实际窗口和 installed-proof 整段运行仍由 Claude 验收。
