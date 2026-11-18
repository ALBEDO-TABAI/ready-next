---
title: Ready Next M4 画板与 FastCard 实施合同
date: 2026-10-31
status: in-progress
enforce: true
---

# Ready Next M4 画板与 FastCard 实施合同

## 1. 范围与依据

依据整合计划 M4、C10/C13 及 2026-10-31 D4 调研（已采纳全部推荐）。M4 交付画板、FastCard 转存、卡片编辑、成文、快记与一次性导入。本文先冻结格式与纯转换；Main 发布、持久恢复及真实窗口分别由 B–F 验收，不能用 A 的通过替代整个 C10/C13。

## 2. 已定决定

1. JSON Canvas 1.0 标准层加 Ready 扩展；标准节点只有 text/file/link/group，层次顺序由 nodes 数组承担。
2. `.readyboard` 只做一次导入，生产不再创建或保存旧格式；最终退役由 F 负责。源文件保持不变。
3. Main 画板句柄是唯一写入口；永久对象 id 与临时句柄分开，节点身份为“画板对象 id + 节点 id”。文件版本是最终字节的 SHA-256，不另存递增版本。
4. 链接预览服务由画板、FastCard、页面书签共用；逐跳地址检查、超时、解压后大小限制由 D 负责。
5. Stillroom 完整导入只接受完整空间 ZIP。自动保存 JSON 即便配有媒体导出也标明不完整；缺媒体不能算成功。A 接收已解包的数据与附件描述，不读取 ZIP、文件或网络。
6. 文档卡只预览和打开原文；文字卡消费 M3 编辑器。草稿卡只存名称及草稿定位，不复制草稿正文。
7. 千节点先测量：固定机器、窗口及混合夹具，记录拖动/缩放帧时间和长任务，以 60fps 为目标但不预先宣称达标。
8. 视口、选区、悬停、播放位置、磁吸偏好属于本机状态；转换报告单独返回，不写入 `.canvas`。

## 3. 文件格式

标准字段按 JSON Canvas 1.0；nodes/edges 可在普通导入时缺省，Ready 写出时必有 nodes、edges、ready。坐标为安全整数，宽高为正安全整数；导入小数时取整并报告。边的 side 为 top/right/bottom/left，end 为 none/arrow；颜色为 #RRGGBB 或预设 1–6。subpath 以 # 开头。

| 位置 | 字段与约束 |
| --- | --- |
| 根 ready | 必填 schemaVersion: 1、id（非空、无空白/控制符/路径分隔符的对象 ID）；title?: string |
| 节点 ready | 必填 kind: text/note/image/video/audio/document/link/group/subcanvas/graphic/draft；text/note/draft 对应 text，媒体/document/subcanvas/graphic 对应 file，link/group 对应同名标准类型 |
| ref | 现有 ReadyRef；document 只接受 page/file/canvas（普通画板引用不产生所属关系），subcanvas 必填 canvas 且不带 node。file/subpath 与 ref 的目标一致；跨文件目标检查用资料库对象快照，不能凭文件名猜身份 |
| sources | 数组 { uri, title?, capturedAt?, method, fastCardId? }；uri 经现有 ReadyRef/网页地址解析；时间为 ISO 日期时间，method 非空 |
| fastCard | { id, kind, createdAt, originalText?, targetLanguage? }；kind 沿用共享 FastCard 类型；不保存 tabId 或绝对缓存路径 |
| media | { mime, sha256, originalName?, durationMs?, transcript?, poster? }；sha256 为 64 位小写十六进制，时长非负有限数，poster 为附件相对路径 |
| preview | { title?, description?, site?, image?, fetchedAt? }；image 为 .assets 内相对路径 |
| appearance | fontScale: (0,16]（相对 24px，Stillroom 的 18px/12px 标题换算后保存）、align: left/center/right、weight: light/regular/medium/bold、color/background: 安全文字颜色、radius: [0,4096]、collapsed: boolean、rotation: [-360,360]、crop 分为 {mode: rect,x,y,w,h}（归一化、不越出 [0,1]）与 {mode: position,x,y}（0–100 的图片显示位置百分比）；Stillroom 的 crop 是后者，不可冒充裁剪矩形；均可选 |
| dock / groupId | dock: {left?,top?} 指本画板节点；groupId 指 group；禁止自指、悬空、归属环（包括 dock/groupId 混合环） |
| graphic | rect: {fill,stroke,strokeWidth}；arrow: {x2,y2,stroke,strokeWidth}；path: {points:[{x,y},…],stroke,strokeWidth}。参数为有限数；路径至少两点；图形 file 为 SVG。SVG 只由固定元素/数值/转义颜色生成，不容纳 HTML、脚本、外部引用 |
| draftId / draftLibraryId | draft 必填两个非空 ID；其他 kind 禁止这些字段，正文仅为名称；跨机器不可假称已携带正文 |
| 节点/边 trash | {operationId,deletedAt}；回收保留内容和 ID，恢复保留 ID；节点回收时关联边按端点状态一并隐藏；边的独立回收标记不被改变 |

第三方扩展在根、节点、边及其嵌套 JSON 中原样保留。Ready v1 未声明字段拒绝；未知 Ready schemaVersion 返回只读原对象及版本，不套用 v1 默认值、不序列化写回、不执行操作。标准层仍检查结构、路径、重复 ID 与悬空边。

路径是 POSIX 资料库相对路径；画板 `目录/X.canvas` 的附件为 `目录/X.assets/...`，子画板为 `目录/X/...canvas`。禁止绝对路径、盘符、反斜线、空/点/父目录段、控制符和编码后的穿越。纯函数只做词法检查；B 必须以 realpath 再检查符号链接和实际资料库边界。

子画板由父节点 kind=subcanvas + ref 表达所属关系。普通 document/file 引用另一个 canvas 不产生所属关系。单文件拒绝指向自身；集合检查拒绝多父归属和跨画板环。对象快照同时检查 ref/file/subpath 及同名子目录，外部对象不在本文件中时不得假装已完成验证。

## 4. 操作、状态、回执与冲突

- 请求包含 objectId、handleId、expectedVersion（磁盘 SHA-256）、operationId、结构化操作数组；Main 在信任边界验证请求并冻结输入指纹。
- 纯操作含节点/边增删替换、几何修改、成员调整、外观/图形修改、文字区间、回收/恢复。建组/解组用同一批节点及成员操作；批量只在最终结构有效时返回结果，输入不变。
- 图形修改必须同时提供新参数和已准备的 SVG 路径；B 用 graphicSvg 生成、验证并发布附件后才可提交，不能只改参数却保留旧派生图。自由箭头的可见框由 graphicFrame 包含负向端点和边距，保留原向量参数及旋转。
- 区间复用 M3 的 UTF-16 半开区间、expectedText、代理对边界与冲突检查，并校验节点正文指纹。逆操作绑定操作后的完整结构，拒绝覆盖后来编辑；Main 撤销仍校验文件版本。
- 导入附件、创建子画板属于带外部效果的命令，与纯操作区分；必须由 B 准备附件/子文件后转成节点操作，纯函数拒绝直接假装完成这些命令。
- 回收节点及其关联边保留内容；关联边可见性统一由 activeCanvasContent 按两个端点状态及边的独立回收标记计算；分别回收两个端点后任意顺序恢复也正确。永久删除必须显式清除引用/边，不自动删除附件。
- 状态为 prepared / awaiting-buffer / published / indexed / completed / conflict / recovery-required。Renderer 编辑缓冲归 Renderer；可恢复副本及持久操作账本归 Main。
- 提交：校验 → 按对象串行记录意图 → 缓冲协商 → 暂存/校验/原子发布 → 最终位置回读附件与身份 → 索引核验 → 持久回执 → 成功通知。文件已发布后失败留恢复记录，不能覆盖后续编辑。
- 成功回执含 operationId、objectId、beforeVersion、afterVersion、affectedNodeIds、attachments（path/sha256/verified）。merged_dirty 与 completed 不混同；只有最终回读及索引确认才 completed。
- 同操作 ID 同输入返回原回执，换输入拒绝。冲突区分版本、正文、删除对编辑、分组归属、身份、操作 ID 重用、缓冲确认过期。不同节点/不交叉字段才可合并；同正文重叠拒绝。缓冲确认绑定 tabId、bufferVersion、openGeneration。

## 5. 一次性转换

输出主画板、子画板、附件清单、身份映射、来源指纹、不完整项目、几何变换及本机视图。身份由调用方预先分配并持久化，纯转换不随机生成。来源指纹为来源 UTF-8 字节和附件 SHA-256 清单的稳定 SHA-256；B 另保存原 ZIP/HTML 字节哈希。附件描述是待复制/生成计划，不是落盘成功回执。

| 来源 | 映射 |
| --- | --- |
| readyboard text/note | Markdown text，原 ID/顺序、字号（相对 24px）、颜色、背景、旋转保留 |
| readyboard image/video/markdown | 文件节点；附件复制进目标 .assets。markdown 引用实际保存副本，不猜原页面；保留标题/摘录为 preview |
| readyboard rect/arrow/path | graphic file + 安全派生 SVG，保留参数/点列/旋转/绘制顺序；自由箭头不造隐藏端点 |
| readyboard 外部素材回执 | 根据 externalReceiptId/素材路径去重；有图无节点生成一次稳定 ID 节点；viewport 单独返回 |
| Stillroom text/link | HTML 经已有 turndown + GFM 依赖转 Markdown，保留标题/来源/预览/时间/外观；无法表达的 HTML 与瞬态状态在不完整清单中报告 |
| Stillroom image/audio/video | idb:key 对应解包 media/key；媒体及 poster/预览图加入附件计划，转写保留；缺文件明确报告 |
| Stillroom folder | 每个 folder 创建独立子画板；parentId 分流成员，原 notes 顺序在各画板内保留；回收时间保留；非法父关系拒绝 |
| 普通 JSON Canvas | 保留标准字段及第三方扩展，补 Ready 根身份及匹配 kind；不猜对象引用/子画板归属；已有 Ready 身份沿用，未知版本只读拒绝导入写回 |

B 先持久记录来源哈希、目标、身份、附件，再生成/校验/发布/回读/登记；同名异内容不覆盖，重试/重启不重复。媒体缺失保留转换材料供补齐，不能登记完整导入。

## 6. 验收合同

| 合同 | 可观察验收 | 负责人/入口 |
| --- | --- | --- |
| C10-A 格式 | 全类型/边/分组/子画板/回收/自由图形夹具通过；重复 ID、悬空、错误组合、非法数值、路径和环拒绝；未知版本只读；三来源内容/身份/顺序/来源/外观保留；操作逆转及稳定字节 | A：ready-canvas-schema.test.ts、ready-canvas-conversion.test.ts、ready-canvas-operations.test.ts；verify:canvas-format；check-ready-canvas-schema.cjs |
| C10 完整 | 实际保存/关闭重开/三种导入后从磁盘校验并打开附件；注入附件、发布、回读失败保持源文件可读且不假报完成；重试重启不重复；旧文件编辑另产 .canvas 且旧字节不变 | B：ready-canvas-format.test.ts、ready-canvas-write-native.test.ts、ready-canvas-import-native.test.ts；F 窗口 |
| C13 | 不开画板，从 FastCard/右键存指定/新建/默认《灵感》；文件、出处、附件、暂存移出与撤销可回读；失败保留暂存；重试不重复，撤销不删除后续编辑 | D/B：ready-fastcard-to-canvas.test.ts；F 窗口 |
| M4 回归 | C3 脏缓冲冲突；C5 重建两次关系无重复且回收不入索引；C7 收图确认后断网重启仍可转存；C12 草稿定稿及文档卡回读；C14 四模式样式/BrowserView 恢复；C15 数据隔离 | B–F 原生测试及 Claude 真实窗口 |
| 交互/性能 | 拖动 DOM 快路径、松手一次提交、取消恢复；帧合并、可见区裁剪、按需编辑/媒体；P/L/R 重试使用既定坐标；千节点实测 | C/F，不由纯函数测试代替 |

所有 A 检查只用合成夹具，不碰日常 Ready 数据。代码改动需 typecheck、新增测试及 eslint。A 无数据库及窗口改动，不声称原生持久化和界面通过。

## 7. 任务与唯一负责人

| 任务 | 独占职责 | 顺序 |
| --- | --- | --- |
| A | shared/ready-canvas、格式/转换/操作合同、夹具和格式检查 | 最先完成；本次仅获准给 package.json 加 verify:canvas-format |
| B | board-engine、canvas-import、对象/关系/画板层级、shared/object-links；持久恢复 | A 后；公共对象/页面文件等 M3 T2 交接 |
| C | canvas interaction/surface 与局部样式、白板工具 | A 后独立部分可并行；真实保存等 B |
| D | FastCard 类型/缓存/转存/快记、Main link-preview、BrowserMode | A 后，转存等 B，目标选择消费 M3 |
| E | 卡片正文/成文、document-drafts service/runtime/ipc 与共享草稿类型 | A/B 后；编辑器等 M3 T4，选择器等 T5 |
| F | main/index、preload、electron.d.ts、migrations、DocumentMode、package.json 后续登记、验收脚本、旧入口退役 | M3 T6 与 A–E 全部后串行接线 |

F 同时负责旧 BoardEditor/BoardContextMenu/boardInteraction、board-engine 旧保存入口、ready-board-tab、文件树、documentSelectionOpen/documentPaneDrop/bookTabEligibility、localHtmlFileOpen、boardTransfer、document-export-target、browser-ipc-channels、shared/ready-board、board/engine、build-board-template，以及 open-ready-ref 的节点定位；只改画板分支。B 独占期间 F 不并发改 board-engine。

M3 编辑器、SaveToPicker 归原负责人；M4 只消费公开接口。其他任务若需公共文件变动先交给上述唯一负责人。

## 8. 交付状态

2026-10-31：合同冻结；A 格式、转换、纯操作与命令行入口已完成：34 项行为测试、2 个合法夹具、13 个非法夹具；类型和 eslint 检查通过。B–F、完整 C10/C13、原生持久化和窗口验收尚未完成。

### E3 文字卡链接合同（实施前冻结）

- 块编辑器公开 `linkBase: { filePath: string | null; parentPath: string | null }`。文档宿主从标签提供两条路径；未保存文档仍允许选择 Wiki 链接，创建子页面时提示先保存。画板宿主从 `canvasPath` 提供两条路径，不伪装文档标签；没有路径则隐藏 Wiki 选择、子页面和复制引用并说明原因。
- `wikiTarget`、引用打开和子页面创建只消费链接基准，不自行查询文档标签。Wiki 插入目标是规范文件路径之间相对于当前文件所在文件夹的路径，省略 `.md`；打开先当前文件夹、后资料库根。`项目/X.canvas` 引用 `资料/某页.md` 写作 `[[../资料/某页]]`。
- 新建子页面把 `parentPath=X.canvas` 交给现有页面服务，由服务负责创建 `X/标题.md`；成功后插入 `[[X/标题]]`。插入沿用原选区和正文版本，经 NodeBuffer → textRanges → 画板句柄确认；页面创建期间正文变化则拒绝插入，错误提示保留已创建的页面位置，重试复用 operationId。
- 有画板路径和稳定 nodeId 的文字卡开放“复制块引用”，复制 `ready://canvas/<objectId>#node=<nodeId>`（由 ReadyRef 编码）。该地址定位整张文字卡，不承诺卡内段落定位，不往正文添加页面块标记；画板身份由对象服务解析后才能复制。文档块引用仍为 `[[页面#^块ID]]`。
- 画板链接抽取保留 sourceNodeId，关系解析以画板所在文件夹优先、资料库根其次。CLI 合同：canvas-text-editor 验证真实卡片选择/创建/打开/复制和区间提交；ready-canvas-write-native 验证页面服务落盘、句柄写入与关系回读；既有块编辑器交互、Wiki 打开与保存测试保持通过。窗口验收由 Claude 执行。

### E3 CLI 交付边界（2026-10-31）

- 已接公开链接基准、文字卡 Wiki/子页面/整卡引用，未保存文档保持原行为。新增卡片行为测试先失败后通过；编辑器共 96 项通过，Widget 163 项、文档性能 152 项通过，类型检查及改动文件 eslint 通过。
- 原生定向检查 14 项：13 通过、1 失败、0 跳过。子页面服务真实落盘、重试复用回执及 NodeBuffer 经句柄保存已通过；唯一失败是画板文字 Wiki 的关系解析。
- `verify:native` 原测试清单使用已安装 Electron 执行：454 项，450 通过、4 失败、0 跳过。除上述关系解析失败，另三项范围外失败为 calendar-layers-native、library-engine、ready-object-identity-native 的文件监听 EMFILE/通知超时；未改实现或断言。日志 `/tmp/m4e3-native.log`，定向日志 `/tmp/m4e3-native-focused-final.log`。
- 阻碍位于允许范围外的 `src/main/modules/search-engine/object-links.ts`：`source_node_id` 让文字 Wiki 与画板 file 节点一样从资料库根解析。需要区分文字引用和资料库相对的 file 节点路径；不能直接改变所有画板节点的基准。抽取器无路径基准，未在其中制造补偿规则；保留原生失败回归，E3 不标整体完成。实际窗口验收仍交 Claude。
- Widget/性能 npm 入口因 `tsx` 管道 `listen EPERM` 失败，改用已安装 `node --import tsx --test` 执行原清单，性能夹具也用 `node --import tsx` 生成。原生使用已安装 Electron Node 模式，不安装或重编依赖。

### F 接线验收合同（实施前冻结）

- `ready-canvas-ipc.test.ts` 调用真实注册函数与资料库解析器：未配置拒绝、恢复完成前不执行、每次请求读取当前库、恢复失败不放行；恢复期间切库不得返回旧实例。
- 生产画板只有 CanvasService 写入；打开 `.readyboard` 只提供一次性导入，旧文件字节保留。CLI 回归使用现有导入、写入、成文与 FastCard 原生行为测试。
- preload 和声明覆盖画板、成文、FastCard、link-preview，IPC 合同检查不得缺项。新增持久化测试全部纳入 verify:native。
- 文档画板操作等待 Main 成功回执；外部转存完成通知刷新已打开画板。节点引用进入文档画板并选中居中。
- `verify:ready-next-canvas` 仅操作独立 userData 与规范化临时资料库，磁盘回读及截图逐步取证；窗口验收由 Claude 执行，CLI 不代替窗口结论。

### F 交付记录（2026-10-31，窗口验收待 Claude）

- 已接 Main/preload/声明、当前库解析及恢复屏障、FastCard 目标适配、成文回写、link-preview、快记启动与退出；文档画板、旧格式转换、节点定位、`.canvas` 路径预览接通。旧编辑器/保存/素材接收/HTML 构建入口及旧拖拽消费者删除；共享 Widget/文档路径只移除旧画板分支。
- 先增加真实注册函数/解析器测试，首次因缺少解析器失败，再实施。新增生产 FastCard→CanvasService 原生测试，覆盖未打开画板、默认/新建/已有、磁盘回读、撤销、重试不重复及刷新通知；窗口脚本使用的旧格式夹具由真实导入服务验证源字节不变。
- `typecheck` 通过；IPC invoke 462/462、send 9/9、push 66/70（4 项已有白名单）、methods 38/38，全部检查项通过；SQLite skip/CSS reset/迁移连续性检查通过（1–151，无新增迁移）。格式测试 34 项与合法/非法夹具通过；Widget 163/163；文档性能 152/152；相关子集 64/64；最后界面改动复测 33/33；画板原生复测 13/13；上述行为测试均 skipped 0。
- 原生完整批使用已安装 Electron 的 `--import tsx --test --test-concurrency=1` 执行同一清单（不安装或重编依赖）：432 项中 428 通过、4 失败。范围内一项为注册函数签名更新后的旧测试，已修正并包含于 13/13 复测；剩余 3 项范围外分别为 calendar-layers-native、library-engine、ready-object-identity-native 的文件监听 EMFILE/超时，不改其实现或断言。日志 `/tmp/m4f-native.log`、`/tmp/m4f-native-recheck.log`。新增原生测试已全部登记 verify:native。
- `verify:ready-next-canvas` 已提供六步窗口脚本、逐步磁盘/暂存回读与截图、SIGKILL 重启及旧文件字节比较；这里只校验脚本语法和夹具，未启动窗口。浏览器收集步骤目前调用生产 browser FastCard 接口注入文本，原生右键与网页层遮挡/恢复仍须 Claude 实际验收。
- 未完成边界：`[[` 选择与子页面创建需修改 M3 的 `block-editor/EditorTools.tsx`、`references.ts` 及公开路径传递接口；这些不在 F 可改范围，未改。卡片插槽已提供 canvasPath，未伪装文档标签。旧静态模板的打包条目位于 `electron-builder.yml` 和 `scripts/verify-release-structural-package.cjs`，不在明确许可清单；保留资产以免破坏打包，待负责人将两处条目与 assets/board/board-template.html 一并删除。C10/C13 及 M4 整体尚不能标为最终验收通过。

## 9. 子画板：收进、移入、移出、删除与 Stillroom 导入（2026-11-14，实施前冻结）

来源是 Stillroom 的文件夹交互（`src/canvas/folders.ts`、`selection.ts`、`Canvas.tsx`、`store.ts`）。Ready 的子画板是独立 `.canvas` 文件（§3：单一父画板，文件在父画板同名文件夹内），所以“卡片换画板”是两份文件的一次改动，必须由 Main 一条命令完成。同画板内的 分组（⌘G，JSON Canvas group）保持不变，与子画板是两回事。

### 9.1 跨画板移动命令 `canvas:moveCards`

- 请求：`{ operationId, objectId, handleId, expectedVersion, nodeIds, target }`。`target` 为 `{ kind: 'new', path, title, card }`（收进子画板：新建子文件并在来源画板放一张子画板卡）或 `{ kind: 'existing', objectId }`（目标必须是来源画板的直接子画板——来源上有未回收的子画板卡指向它；或来源画板的父画板——父画板上有未回收的子画板卡指向来源）。其他关系拒绝。
- 移动集合由 Main 用纯函数 `planCardMove` 计算：选中分组时带上成员（递归）；已回收、子画板卡、草稿卡不移动并在回执 `skipped` 中列出原因（子画板卡换父需要移动文件，草稿卡绑定原画板回写，本期不做）。
- 连线：两端都在移动集合内的随卡片移动；只有一端在集合内的从来源画板移除并计入 `droppedEdgeIds`（界面在提示里说明，可撤销）。分组归属和 dock 指向集合外节点的引用在两侧清除。
- 位置：新建子画板时整体平移到原点起排；移入已有子画板时排在已有内容右侧（空画板从原点起）；移出时排在父画板子画板卡右侧，遇到已有卡片向右让开。相对布局与层次顺序保留，移动的节点排在目标 nodes 末尾。
- 附件跟卡片走：节点的 file、preview.image、media.poster 与正文内本地媒体引用若位于来源画板 `.assets/` 下，复制到目标画板 `.assets/`（同名同内容复用，同名异内容加哈希前缀），路径改写；来源附件保留（§4：不自动删除附件）。图形 SVG 由目标画板下一次写入照常重新派生。
- 写入顺序复用页面移动的多文件发布（`publishBundle`）：按对象 id 排序串行加锁 → 持久记录计划（两份文件的原文与新内容、附件、移动明细）→ 校验集合 → 先发布附件与**目标**文件，再发布**来源**文件 → 回读 → 两个对象登记与关系索引 → 回执。中断在两次发布之间时磁盘上是“两边都有”而不是“两边都没有”；`recover()` 按记录的计划重放到完成，不产生重复。
- 冲突：来源 `expectedVersion` 与磁盘不符返回 `version_conflict`；任一画板有未保存的恢复缓冲（与磁盘不同）返回 `version_conflict`，不做合并（移动不允许 `merged_dirty`）；目标文件在计划后被改动返回 `version_conflict`；目标已有同 id 节点返回 `identity_conflict`。冲突时两份文件都不改。
- 回执在 `CanvasReceipt` 之外带 `move: { targetObjectId, movedNodeIds, movedEdgeIds, droppedEdgeIds, skipped, createdNodeId? }`。同 operationId 同输入返回原回执。

### 9.2 撤销：显式逆命令 `canvas:undoMove`

- 请求 `{ operationId, moveOperationId }`。Main 从已完成的移动记录取出移动明细，在**当前磁盘内容**上按规则做逆移动，而不是恢复旧快照：当时移动且仍在目标画板的节点（保留之后对它们的编辑，回到原坐标、原分组/dock 归属——前提是被引用节点仍在）移回来源；当时随行和被丢弃的连线在两端都存在时恢复；目标画板里连到这些节点的新连线移除。已被永久删除的节点跳过。
- 若该次移动新建了子画板，逆移动后子画板内没有任何节点且来源画板上那张卡还在，则卡片从来源画板移除，子画板文件经资料库回收站后彻底删除（空文件，不留垃圾）；子画板里还有别的内容则保留卡片与文件。
- 逆命令走同一发布顺序与冲突规则，有自己的 operationId 与回执；没有节点可移回时返回 `nothing_to_undo`。因此撤销不会留下重复卡片或没有卡片指向的子文件。
- 界面：移动后的提示带“撤销”；画板自己的撤销栈在权威内容被外部替换时已清空，栈空时 ⌘Z 与撤销按钮落到这条逆命令（先撤销移动之后的本地编辑，再撤销移动本身）。离开这两个画板或做了新的跨画板移动后，这条撤销不再提供。跨画板移动不提供重做。

### 9.3 子画板卡与文件同进同出

- 规则：子画板文件跟着它的卡片。卡片进画板回收站（或被撤销新建等操作从画板移除）时，子画板文件（连同其子文件夹与 `.assets`）经页面服务进资料库回收站；卡片恢复（含撤销删除）时文件先恢复到原位置再写画板；原位置被占用时恢复失败，画板不改。卡片被永久删除后文件留在资料库回收站，可在那里恢复成独立画板或彻底删除。Stillroom“删除文件夹把内容交还上级”的做法不采用：Ready 的回收站是可恢复的，内容跟着走才能原样恢复。
- 实现：`canvas:write` 由 `SubBoardCoordinator` 包一层。写入前用纯函数 `subBoardEffects(before, after)` 算出需要恢复和需要回收的子画板；先恢复、再写画板、写入完成后回收。回收清单随写入计划持久保存（`plan.subBoards`），页面操作 id 由写入 operationId 派生；启动恢复时补做“画板已写完但文件还没进回收站”的操作。恢复在写入前中断时只是文件已回到原位而卡片仍在回收站，不丢内容。
- 校验放宽：已回收的子画板卡不参与集合校验的引用/归属检查，也不检查文件存在（文件此时在回收站）。
- 反方向（实施中发现的既有缺口）：从侧栏把子画板文件回收、而它的卡片还在父画板上时，原先父画板的任何写入都会因“引用无法解析”落入 recovery-required。现在这样的卡片同样不参与上述检查，父画板保持可写，卡片显示“在资料库回收站”，文件恢复后照常可用。卡片不会被自动放进画板回收站。

### 9.4 子画板卡、快捷键与 Stillroom 导入

- 子画板卡显示子画板标题、卡片数和至多四张图片缩略图；数据来自只读查询 `canvas:subBoards(parentObjectId)`（标题、未回收卡片数、图片路径、是否可用），不为每个子画板开句柄。
- 选中子画板卡按 Enter 进入；⌥↑ 回到上一级。两者登记在 `src/shared/app-shortcuts.ts`（canvas 范围）。
- 导入 Stillroom 空间：画板“更多”菜单 →“导入 Stillroom 空间…”。Main 的 `canvas:importStillroom` 弹系统文件选择（完整空间 ZIP，或自动保存 JSON——后者按 §2.5 标为不完整），用既有 `stillroom-zip` / `stillroom-json` 导入服务写到当前画板文件夹下，再在当前画板放一张子画板卡；回执沿用导入回执并带卡片 id。导入成功而放卡失败时如实返回已导入的位置。

### 9.5 验收

| 合同 | 入口 |
| --- | --- |
| 纯规划：成员展开、连线去留、归属清理、位置、逆移动 | `ready-canvas-card-move.test.ts` |
| 两文件发布、附件跟随、冲突、重放、撤销、空子画板清理 | `ready-canvas-card-move-native.test.ts` |
| 卡片与文件同进同出、撤销删除、原位被占、启动补做 | `ready-canvas-subboard-native.test.ts` |
| 真实窗口：选区→收进子画板→进入→移出→撤销；拖卡到子画板卡；删除子画板卡并恢复；导入 Stillroom | `scripts/verify-ready-next-canvas.cjs` 新增步骤（隐藏窗口） |

### 9.6 交付记录（2026-11-14）

- 已实现 9.1–9.4。Main：`board-engine/card-moves.ts`（移动与逆移动）、`sub-boards.ts`（`SubBoardCoordinator`：写入包装、回收/恢复、启动补做、卡片摘要）、`stillroom-entry.ts`；纯规划在 `shared/ready-canvas/card-move.ts`。IPC：`canvas:moveCards`、`canvas:undoMove`、`canvas:subBoards`、`canvas:importStillroom`，`canvas:write` 改经协调器。界面：`components/canvas/SubBoardCard.tsx`、`useSubBoards.tsx`、`surface/sub-board-actions.tsx`、`modules/canvas/folders.ts`、`drop-into-board.ts`；拖拽管线只加了 `dropTarget` / `dropInto` 两个回调。
- 检查：`ready-canvas-card-move.test.ts` 6 项；原生 `ready-canvas-card-move-native.test.ts` 3 项、`ready-canvas-subboard-native.test.ts` 4 项（已登记 verify:native），其余画板原生测试与页面服务原生测试保持通过；隐藏窗口 `verify-ready-next-canvas.cjs` 全部步骤通过（新增 07–11）。该脚本现在固定以 `READY_START_HIDDEN=1` 启动。
- 未做：~~选区 / 子画板单独下载 ZIP~~（2026-11-14 已做，见 §11.2）；子画板卡与草稿卡跨画板移动；跨画板移动的重做；子画板在卡片上改名（仍在侧栏改名）；Stillroom 自动保存 JSON 的媒体文件夹选择（只选一个文件，JSON 按不完整导入）。

## 10. 交互层对齐 Stillroom（2026-11-14，合同先于实现）

起因：用户在真实窗口里看到画板没有 Stillroom 的对齐与自适应缩放，连线不能删除也不能撤销。只读审计确认后，本节冻结交互层要守的规则；实现与验收记录在 §10.4。范围只有交互层（`modules/canvas/interaction/`、`components/canvas/surface/`），不新增写入通道、IPC、schema 字段。

### 10.1 数据规则

1. **图形素材路径只有一个来源**：`graphicAssetPath(画板路径, 图形, 宽, 高)`（`shared/ready-canvas/graphics.ts`），内容是 `画板名.assets/<SVG 字节的 SHA-256>.svg`。界面预测的路径必须与 Main 保存后的路径逐字节相同，否则界面会把自己的修改当成外部更新、清空撤销记录。验收：`ready-canvas-write-native.test.ts` 用真实 `CanvasService` 比较“界面预测的画板”与“Main 保存后读回的画板”。
2. **连线不进回收站**：删除连线发 `deleteEdge`，是一步撤销；卡片仍进回收站。两端卡片同时被回收的连线不删，随卡片隐藏、随卡片恢复（`activeCanvasContent` 的既有推导）。旧数据里已带 `ready.trash` 的连线由“全部恢复”“清空”一并处理。理由：连线没有正文，回收站里列“连线”只是噪音；卡片与连线一起删时，一次撤销两者都回来。
3. **节点与连线共用一个选区**：两者的 id 在格式层已保证不重复，选区是一组 id；选区不写入 `.canvas`。
4. **几何必须是整数**：缩放后的 `x/y/width/height` 四舍五入；停靠判定容差 1px。一次手势只提交一次（M4 §6“松手一次提交”不变），一次提交是一步撤销。
5. **文字随卡片缩放**用现有的 `appearance.fontScale`（卡片字号 = `fontScale × 24px`，未设置时是 13px，即 13/24）；按比例缩放文字卡时 `fontScale` 乘同一个系数（保留 4 位小数，上限 16）。不加 schema 字段。
6. **不写 `ready.dock`**：Stillroom 只写不读这条记录；这里没有消费者，而只更新被拖动卡片的做法会留下过期记录，过期记录可能拼成 schema 拒绝的归属环。导入带来的 `dock` 原样保留，排版与解组照旧清除。
7. **“还原排版”就是撤销**：P / L / R 排版、自适应缩放、成组缩放都是一步撤销，不为“排版前”另存字段（`NodeReadySchema` 是严格模式，旧版本会拒绝新字段）。
8. **视图偏好与镜头是本机状态**（M4 §2.8）：智能参考线、磁吸、间距、自适应缩放、图片圆角存 `localStorage` 的 `ready-next.canvas.view`；每张画板的镜头存 `ready-next.canvas.camera`（按画板对象 id，最多 200 张，最久未用的先丢）。两者都不进 `.canvas`，随 profile 隔离。

### 10.2 行为规则

| 行为 | 规则 |
| --- | --- |
| 磁吸 | 拖动时被拖的整体外框吸向邻近卡片：相隔“间距”贴边（默认 12）、左右上下边对齐、中线对齐；吸附半径 26 屏幕像素（随缩放换算）。按住 ⇧ 拖动不吸附。关掉“磁吸”后不吸附也不停靠 |
| 智能参考线 | 对齐吸附时画一条虚线（墨色三级）；关掉后仍吸附，只是不画线 |
| 自适应停靠 | 被拖整体朝外的一条边进入邻居的吸附范围、且两者在另一轴上有重叠时，出现停靠标记（信号橙短线，表示“正在进行”）；松手后被拖的卡片整体缩放到与邻居等高（左右停靠）或等宽（上下停靠），贴边相隔“间距”。目标有粘性（保持范围 ×1.6）。缩放系数超出 0.25–4 的候选不停靠，退回普通磁吸。分组框与图形不作为停靠的源边或目标，但随选区一起缩放 |
| 落位动画 | 松手、P / L / R、撤销 / 重做后卡片从原位滑到新位（200ms，`--rn-ease-std`）；系统开了“减少动态效果”时直接到位 |
| 缩放手柄 | 悬停或选中一张卡片时四角出现弧形手柄：卡片按比例缩放，文字随之缩放；左右边改宽、上下边改高。图形与分组框四角自由缩放。最小宽 80、高 36 |
| 成组缩放 | 选中多张时画一圈选区外廓，四角是弧形手柄，整体按比例缩放（含其中的图形） |
| 聚簇外廓 | 相距不超过 24 的卡片是一簇；外廓只在指针悬停其中一张时出现，手势进行中与被选区外廓覆盖时不画 |
| 连线 | 点选、⇧ / ⌘ 点加减、框选包含、Delete / Backspace 删除、右键“删除连线”；选中是墨色加粗，不用信号橙 |
| 画完回到选择 | 画完一个矩形、箭头或一条连线后回到“选择”工具并选中刚画的；手绘保持，直到按 V 或 Esc |
| 键盘 | ⌘ 点切换选中；⌘C / ⌘X / ⌘V 复制、剪切、粘贴卡片（剪贴板里没有卡片时 ⌘V 仍粘贴文字或网址）；⌘D 原地偏移复制；方向键在卡片间移动焦点，Enter 打开；⌥⌘] / ⌥⌘[ 上移 / 下移一层（⌘] / ⌘[ 已是全局的前进 / 后退）。⌥ 拖动仍是把卡片的 Ready 引用拖出去，不是复制 |
| 滚轮 | 捏合与 ⌘ / Ctrl 滚轮缩放；触控板双指平移；带格的鼠标滚轮缩放。判定比 Stillroom 保守：一串滚轮事件按第一个事件定性并保持（间隔超过 180ms 才重新判定），只有 `deltaMode` 为行、或无横向分量且旧式 `wheelDeltaY` 是 120 的整数倍时才算滚轮格；触控板起手只有几个像素，所以快速双指滑动不会中途变成缩放 |

### 10.3 实现时定下的取舍

- **连线硬删除**（见 9.1-2）；选中连线时选区条只显示“N 条连线”和“删除连线”。
- **画完回到选择**：不做“再按一次键锁定工具”，规则只有一条（手绘除外）。
- **Electron 的“编辑”菜单与 ⌘Z**：菜单用的是 `role: 'editMenu'`，按键先到页面，画板在 `keydown` 里 `preventDefault` 后菜单不再处理。复制、剪切、粘贴走页面的 `copy` / `cut` / `paste` 事件，所以无论由按键还是菜单触发都进同一个处理函数。这一条只按 Chromium 的既有行为推断，隐藏窗口里无法用真实的系统按键验证（Playwright 的按键不经过系统菜单）。
- **卡片剪贴板**：卡片以 `application/vnd.ready.canvas-cards+json` 放进剪贴板，同时放一份纯文字；粘贴时有这个类型就落成卡片（同一画板上每次多偏移 24，别的画板上落在视口中间），没有就按文字或网址处理，剪贴板里有文件时本层不处理（留给媒体层）。子画板卡与草稿卡不可复制（子画板只能有一个归属，草稿身份唯一）；副本不带 `dock`、`trash`、`fastCard`。
- **缩放手柄画在卡片外侧**：Stillroom 的弧在卡片内 3px；这里卡片圆角是 16，内容贴边，弧画在外侧 6px、与圆角同心，选中是墨色、悬停是墨色四级。选中的单张卡片另有 1.5px 墨色描边；多选时卡片不描边，由选区外廓代表。
- **停靠时多画一个落位虚框**：Stillroom 只画标记；这里卡片的宽高是显式的，缩放幅度可能很大，虚框先告诉人松手后会变成多大。
- **拖动时不画聚簇外廓**：Stillroom 拖动时也亮起所在簇的外廓；这里拖动走 DOM 快路径，外廓来自已提交的状态，拖动中会停在旧位置，所以手势进行中一律不画。
- **落位先于回执**：松手后卡片立即停在最终位置并播放动画，同时发出唯一一次提交；提交被拒绝或被外部更新顶掉时退回画板当前状态。以前是先弹回原位、等写入返回再跳过去。
- **视图设置里没有“吸附半径”滑杆**：半径固定 26（Stillroom 的默认值），设置只有智能参考线、磁吸、间距（0–24）、自适应缩放、图片圆角五项。“图片圆角”只作用于图片与视频卡，与 Stillroom 相同。
- **文字样式**：`appearance` 里已有的字号、粗细、对齐在选区条的“文字”菜单里可改（只在选中的全是文字卡或便签时出现）；字号三档 13 / 18 / 26px。编辑状态下的块编辑器仍按自己的字号显示，没有跟随 `fontScale`。
- **层级**：选区条的“置顶 / 置底”两个按钮并成一个“层级”菜单，加“上移一层 / 下移一层”。

### 10.4 交付记录（2026-11-14）

- **根因**：`CanvasDocument` 拼图形素材路径时没有等待哈希（`sha256` 是异步的），路径成了 `X.assets/[object Promise].svg`；Main 保存时按真实哈希改写，界面发现保存结果与自己的预期不同，按“外部更新”处理——清空撤销记录并提示“画板已被更新”。所以矩形、箭头、手绘都无法撤销，而且每画一次都会清掉之前的撤销记录（包括刚画的连线）。连线本身没有任何选中与删除入口。
- **改动**：`interaction/` 新增 `adaptive.ts`（停靠判定、按比例落位、落位操作）、`preferences.ts`（本机偏好与镜头）、`settle.ts`（落位动画）、`clipboard.ts`、`navigate.ts`；`gestures.ts` 重写移动与缩放两种手势并加连线点选、滚轮判定；`surface/` 新增 `CanvasHandles.tsx`、`CanvasViewSettings.tsx`、`view-settings-float.tsx`，`CanvasSurface` / `CanvasCard` / `CanvasChrome` / `useCanvasBuffer` / `surface.css` 相应接线；`shared/ready-canvas/graphics.ts` 新增 `graphicAssetPath`；`app-shortcuts.ts` 登记 ⌘D、⌥⌘]、⌥⌘[、Enter。没有改 Main、preload、IPC 与 schema。
- **测试**：`canvas-surface.test.tsx` 20 项（新增连线点选 / 删除 / 撤销、画完回到选择、停靠缩放与偏好、选区外廓成组缩放与悬停、键盘与剪贴板、镜头记忆与滚轮；按设计改了两处旧断言：框选现在连同被划过的连线一起选中，角手柄按比例缩放）；`canvas-surface-alignment.test.ts` 6 项纯函数；`ready-canvas-write-native.test.ts` 新增“界面预测的画板 = Main 保存的画板”（真实 `CanvasService`）。全部画板测试文件普通 Node 113 过 / 36 因 ABI 跳过，Electron 下原生 33 / 33。
- **真实窗口**（隐藏窗口，HOME / TMPDIR / profile / 资料库全在临时目录）：`scripts/verify-ready-next-canvas.cjs` 新增并通过——画矩形 → 撤销 → 消失；画连线 → 移动卡片后连线仍在 → 点选 → Delete → 撤销回来（键盘、工具条按钮、右键“删除连线”各一遍）；磁吸对齐并出现参考线；停靠后相隔 12、与邻居等高、`fontScale` 同步、坐标全为整数，一次撤销复原；选区外廓的弧成组缩放并一次撤销；视图设置关掉磁吸后卡片不再吸附，偏好只在 `localStorage`、不在 `.canvas`。原有六步（含中文输入撤销、强退重启、旧格式转换）仍通过。脚本现在自己强制隐藏窗口并隔离 HOME / TMPDIR。
- **没做 / 没验证**：① 落位动画、聚簇外廓淡入、手柄悬停这些动效只在隐藏窗口里截了静帧，手感要在可见窗口里确认。② 滚轮判定没有用真实触控板和带格鼠标验证，只有合成事件的测试。③ 系统“编辑”菜单与 ⌘Z 的先后只是推断（见 9.3）。④ 不写 `ready.dock`（见 9.1-6）。⑤ 文字卡放大后，进入编辑时块编辑器不跟随字号。⑥ 选区条仍固定在选区上方 52px，卡片贴着上方邻居（现在很常见）时会压住邻居。⑦ 旋转过的卡片按外接矩形参与吸附，不作为停靠对象的特殊处理。⑧ 千节点帧时间没有重测；`1000 mixed nodes` 测试仍通过（每帧只查邻近卡片）。⑨ Stillroom 的“摇一摇调层级”、⌥ 拖动复制、拖进文件夹、旋转手柄没有搬（裁剪已在 §11.1 补上）（⌥ 拖动在 Ready 里是拖出引用；文件夹归子画板那一路）。

## 11. 画板媒体合同与交付（2026-11-14）

对照 Stillroom 补齐画板上的语音、文件与媒体卡。先定 Main 合同，再做界面。

**Main 新增两条命令（`canvasMedia:*`，`board-engine/media-ipc.ts`；preload `electronAPI.canvasMedia`）**

| 命令 | 输入 → 输出 | 约束 |
| --- | --- | --- |
| `canvasMedia:stage` | `{ name, mime, bytes: Uint8Array }` → `{ token, kind, mime, sha256, size }` | 只收字节，不收路径：Renderer 只能交出用户拖入、粘贴、选取或录下的内容，Main 不读其他位置。类型由 Main 按文件头判定（PNG/JPEG/GIF/WebP；WAV/MP3/FLAC/Ogg/M4A；MP4/MOV；WebM 与 MP4 容器按声明的 audio/ 或 video/ 归类），声明的 MIME 不作凭据；上限图片 20 MB、音频 50 MB、视频 50 MB；文件名只留字母数字并换成真实扩展名。须已配置资料库。暂存在内存：十分钟过期、合计不超过 256 MB、用一次即清 |
| `canvasMedia:linkPreview` | `{ objectId, url }` → `ready.preview`（标题、摘要、站点、`image`、`fetchedAt`） | 画板位置由对象身份解析，Renderer 不传路径。抓取走共用 link-preview（防内网、大小与超时限制不变）；封面经 FastCard 媒体缓存校验后写入该画板的 `.assets`；封面取不到时只少封面 |

写入不另开通道：媒体卡用既有的 `importAttachment`（`canvas:write`），附件落在 `画板名.assets/<sha256>-<文件名>`，节点带 `media.{mime, sha256, originalName, durationMs}`，发布后按哈希回读。链接预览由 Renderer 用普通 `replaceNode` 写到卡片上。格式（§3）没有改动。

**约定**

- 媒体卡的“取得时间”记在 `preview.fetchedAt`：录音是停止的时刻，拖入的文件是文件的修改时间；从 FastCard 转入的录音仍读 `sources[].capturedAt`。没有为此新增字段。
- 录音不另起一条管线：麦克风的申请方式与快记相同（首次点击时 `getUserMedia`，同样的两种 Opus 容器），停止后就是一个普通音频文件，走上面的暂存与 `importAttachment`。没有绕道 FastCard 暂存栏（那样卡片会先进暂存再被移出，转写状态也带不过来）。快记自己的录音代码未改。
- 链接卡的预览以卡片上的 `ready.preview` 为缓存：有 `fetchedAt` 就不再抓取；没有时每个地址每次会话只问一次（失败也只问一次），成功后在画板空闲时（没有按下的指针、没有进行中的写入）作为一次可撤销的修改写回卡片，每张卡每次会话至多一次；“刷新预览”重新抓取并覆盖。
- `.md`、`.txt` 落成文字卡（内容即 Markdown 原文，上限 1 MB），不产生附件。

**界面**

- 工具条多一个“录音”：按下开始，按钮变成计时加停止方块（这里用信号橙，表示进行中），再按一次在视野中央落一张语音卡；保存失败时留着这段录音可重试，离开画板则丢弃。
- 语音卡：播放 / 暂停、按真实波峰画的波形（已播部分为墨色，不用信号橙；超过 12 MB 的音频不解码，改为一条进度线）、时长、取得时间。画板只录音、不转写（见下）：没有转写的卡片不出现“未转写”或任何原因；卡片自带转写（从 Stillroom 导入、从快记转入）时照常显示并可搜索。整张画板共用一个播放器。新录音的卡片高 96（原为 132，那一行说明去掉后不再留空）。
- 图片卡铺满卡片（cover），按已存的裁切显示（position 与 rect 两种，rect 的显示规则见 §11.1）；双击进入幻灯片：盖住画板区域的浮层（共用浮层宿主），← → 或空格按阅读顺序切换画板上的图片，Esc 或点空白处关闭。
- 视频卡：标题条加 `preload="metadata"` 的首帧。
  - 2026-11-18 改（用户在真实窗口里发现视频拖不动）：画板上的视频不再用浏览器自带的控件。那套控件会接走落在画面上的每一次按下，只剩很窄的标题条能拖。现在画面是卡片的一部分，按下即选中、拖动即移动，和图片卡一样；播放由卡片自己的控件承担：正中的圆形标记（按下不移动 = 播放 / 暂停，从它拖起仍是移动卡片）和底部一条（播放 / 暂停、进度、时间、静音、放大），指针移上、键盘聚焦或播放中途暂停时出现；未播放时右下角标出时长。墨色，不用信号橙。
  - 双击或“放大”进入幻灯片：视频与图片同排，按阅读顺序切换；视频在那里用浏览器自带的控件（音量、倍速、全屏），按它自己的比例撑到最大，空格播放 / 暂停；被打开的那一段接着卡片的进度播放，卡片上的视频同时停下。
  - 手势层的约定：只有带 `controls` 的 `video` 才让出按下；带 `data-canvas-press` 的标记在一次没有移动的按下之后收到 `canvas:press`（画板在按下期间持有指针，标记收不到自己的点击）。真实窗口验收是 `verify:ready-next-canvas` 的 13-video-card。
- 链接卡有封面时上图下文；右键菜单有“刷新预览”。
- 从 Finder 拖入、⌘V 粘贴带图片或文件的剪贴板、右键“新建 › 文件…”（系统选择框）。一次放入多个时按每行四个排开，一次写入。
- 画板内搜索包含转写文字。

**转写：画板不提供（用户 2026-11-14 决定：“那就不转写，只录音先”）**

录音在画板上是一项完整的功能：录下、落卡、播放、波形、时长、时间。画板不提供转写入口，也不查询“能否转写”：`canvasMedia:transcription` 这条命令、preload 入口和卡片上的“未转写 · 还没有接入能转写音频的模型”已删除，没有保留开关或旧分支。`ready.media.transcript` 字段不变：带着转写来的卡片照常显示、参与画板内搜索、随 ZIP 下载。快记自己的转写服务（`quick-note-service`、`fastcard:transcribe`）未改；W4 §2.2“录音卡”里“如实显示未转写”说的是快记，不是画板。以后要在画板上接转写，需要重新定合同（接口类型、触发与费用、按“画板 + 节点”写回的命令）。

**未做**

- 图片的旋转（⇧ 角）手势：未做，只按已存数据显示。裁剪见 §11.1。
- 图片圆角偏好、视频的独立封面文件与时长角标、富文本粘贴（HTML 转 Markdown）、跨画板搜索。
- 文字与网址的 ⌘V 由交互层负责：`onPasteMedia(at, data)` 先处理剪贴板里的文件与图片并返回是否已处理。
- 打包配置里没有 `NSMicrophoneUsageDescription`（快记的录音同样受影响），打包版首次录音前需补上；本次未改发布配置。
- 画板写入账本（`canvas_operations.plan_json`）会长期保留附件的 base64，这是既有设计；视频上限因此定得保守。

**验收**

- 行为测试：`ready-canvas-media.test.ts`（类型判定、上限、命名、三条命令、放入文件、剪贴板、预览只问一次、波峰、幻灯片顺序、裁切）、`ready-canvas-media-cards.test.tsx`（语音卡、链接卡、图片卡、录音工具、画板表面的接入点、画板文档的拖入 / 粘贴 / 选取 / 幻灯片 / 刷新预览）。
- 原生（已登记 `verify:native`）：`ready-canvas-media-native.test.ts`（暂存字节经句柄落成资料库里的附件并回读、令牌一次有效与过期、总量上限、伪造哈希被拒、预览封面写入 `.assets` 后随卡片保存）；`ready-fastcard-quick-note.test.ts` 增加“不凭模型名或 OpenAI 兼容判定可转写”。
- 真实窗口（隐藏启动、临时 HOME / TMPDIR / profile 与测试资料库，录音用 Chromium 的假采集设备并静音播放，不联网）：`verify:ready-next-canvas` 新增“媒体”画板的步骤 `07a-recording`、`07-media-cards`、`07b-slideshow`、`08-media-search`：拖入图片后资料库里的附件与原字节一致；粘贴图片；录音落成带时长的语音卡、附件是 WebM、能播放到结束；幻灯片只盖住画板并可切换、关闭；搜索按转写命中；已存封面不再抓取；“文件…”与“刷新预览”在菜单里。原有链接卡步骤改用内网字面地址（Main 在连接前拒绝），整个脚本不再访问外网。浅色与深色各跑一遍通过。

### 11.1 图片裁剪（2026-11-14，合同先于实现）

Stillroom 是 ⌥ 拖动改 `position`；Ready 里 ⌥ 拖动是把卡片的引用拖出去，所以裁剪是一个明确的模式。

- **数据**：不新增字段、操作或命令。裁剪结果是既有的 `appearance.crop`（`mode: 'rect'`，x / y / w / h 是整张图片的比例，保留 6 位小数）加卡片几何，一次提交 `[appearance, geometry]`，即一步撤销；Main 的校验是既有的 `AppearanceSchema`。附件文件不读不写，`file`、`media` 不变。取景框包含整张图片时不写 `crop`（`appearance` 因此为空时整项删除）。Stillroom 的 `position` 裁切只读：进入裁剪后不动就保持原样，动了就写成 `rect`。
- **卡片取裁剪的比例**：应用时卡片的宽高取取景框的宽高（取整，位置是取景框所在的位置；旋转过的卡片按自己的轴换算，取景框在画板上不跳动），所以卡片比例 = 裁剪区域比例（整数几何，误差不超过 1px）。图片的显示比例不变：裁剪是“框变小”，不是“图变大”。
- **显示不拉伸**：`rect` 裁切显示在一个“裁剪区域比例”的盒子里，盒子居中盖满卡片（CSS 容器单位，随实时缩放更新）。四角弧按比例缩放，比例保持；左右 / 上下边只改一个方向时，卡片比例与裁剪不同，盒子多裁掉一点而不是把图片拉变形。图片自身尺寸来自已加载的图片；未加载前用卡片比例代替（刚裁完时两者相同）。
- **入口**：选中一张图片卡时——右键菜单“裁剪”、选区条“裁剪”、键 `K`（已登记 `canvas.crop`；`C` 是连线工具，`K` 取自“预览”的 ⌘K）。只对单张、附件可用的图片卡提供。
- **模式内**：整张图片按当前比例铺开并压暗，取景框内是保留的部分；四角与四边的墨色手柄改取景框（不出图片范围，最小 36），在框内拖动是让图片在框下滑动（不露空）。选区条换成裁剪条：保留部分的原图像素尺寸、“还原整张图片”、取消、完成。Enter 或在裁剪范围外按下 = 应用；Esc = 取消；模式内其他按键不到画板，右键菜单不出现，滚轮缩放与平移照常。卡片在模式中被外部更新（几何、裁切、文件变化）、进回收站或画板切换时，模式直接退出、不写入。
- **没做**：按住 ⇧ 锁定比例、预设比例、旋转；裁剪模式里没有方向键微调。

### 11.2 下载为 ZIP（2026-11-14，合同先于实现）

对照 Stillroom 的 `selectionZip`：交出文件本身，不是一份合成的文档。与“导出为 Markdown”的区别写在菜单里：“更多”菜单分两组——“导出 · 合成一份”（PNG / Markdown / PDF）与“下载 · 各自的原文件”（下载为 ZIP）。

| 命令 | 输入 → 输出 | 约束 |
| --- | --- | --- |
| `canvas:downloadZip` | `{ objectId, nodeIds?, suggestedName? }` → `{ success: true, path, fileCount, skipped, missing }` / `{ success: false, canceled: true }` / `{ success: false, error }` | 画板由对象身份解析，Renderer 不传路径；`nodeIds` 缺省是整张画板。Main 从资料库读画板与其子画板（只读，句柄用完即还），只打开**所在画板自己的** `.assets` 里的附件（`AssetPathSchema` + 资料库内 + 不跟随符号链接）。保存位置只来自系统保存框（用户的选择即授权），默认目录是系统“下载”。先算清再问：没有可下载内容、超过 2000 个文件或合计 512 MB 时直接返回说明，不弹保存框、不写任何文件 |

- **内容**（纯函数 `planBoardDownload`，`shared/ready-canvas/download.ts`）：图片 / 音频 / 视频卡 = 附件原文件，文件名取 `media.originalName`（没有则取标题），扩展名取附件真实扩展名，字节原样（ZIP 内不再压缩）；裁剪过的图片仍是整张原图。带转写的音频另附同名 `.md`。文字卡 / 便签 = `.md`，内容是存储的 Markdown 原文，文件名取第一行（去掉标题、列表等前缀，40 字内）。链接卡汇成该层的 `links.md`（标题 + 网址）。子画板卡 = 以子画板标题命名的文件夹，递归到嵌套子画板（至多 16 层，回到已读画板的环不跟随）。选中分组等于选中其成员。连线、图形、分组框、空文字卡不产生文件。同一层重名加“ (2)”。
- **不打包并计数**：文档卡等引用别处内容的卡片、附件不在本画板 `.assets` 的媒体卡（`skipped`）；读不到的子画板（在回收站、已丢失）；附件文件已不在磁盘（`missing`）。完成提示里写明张数与原因。
- **入口**：卡片右键菜单“下载为 ZIP”（当前选区；选的是子画板卡就是整块子画板）；“更多”菜单“把选中的卡片下载为 ZIP” / 无选区时“下载为 ZIP”（整张画板）。选区条上没有再加按钮（已经很挤）。
- **写 ZIP 只有一处**：`document-engine/export/zip-file.ts` 的 `writeZipFile`（JSZip 流式写到所选路径），“导出为 Markdown”的压缩包改用它；没有第二套 ZIP 写入。Renderer 在调用前先等画板的未完成写入落盘。

### 11.3 交付记录（2026-11-14，只录音 / 裁剪 / ZIP）

- **改动**：只录音——`AudioCard`、`board-media`、`media-ipc`、`runtime`、preload 去掉转写可用性。裁剪——`modules/canvas/interaction/crop.ts`（纯函数）、`surface/CanvasCrop.tsx`、`CanvasChrome`（裁剪条）、`CanvasSurface` 接线、`cards/ImageCard.tsx`（不拉伸的显示）、`media.css`、`app-shortcuts.ts`。ZIP——`shared/ready-canvas/download.ts`、`board-engine/download.ts`、`export/zip-file.ts`、`CanvasAPI.downloadZip`（preload）、`CanvasDocument` 与 `CanvasSurface` 的入口。
- **测试**：`ready-canvas-crop.test.ts` 4 项（铺放、手柄与滑动、一步撤销与比例、未改动 / 清空 / 旋转）；`ready-canvas-download.test.ts` 5 项（计划、选区、真实临时文件上的 `canvas:downloadZip`：字节、上限、取消、缺失与符号链接）；`ready-canvas-media-cards.test.tsx` 改“语音卡”一项、图片卡加 rect 显示、新增“裁剪模式”一项（菜单 / 选区条 / K、Enter / 外部按下 / Esc、撤销、更多菜单与下载）；`ready-canvas-media.test.ts` 断言媒体命令只剩两条。
- **真实窗口**（隐藏、HOME / TMPDIR / profile / 资料库均在临时目录，保存框被替换为临时目录内的路径）：`verify-ready-next-canvas.cjs` 新增 `12-crop`（菜单进入 → 拖手柄 → Enter；卡片比例 = 裁剪比例、附件字节不变、图片不拉伸；角弧缩放后比例保持；撤销两步复原、重做；K 进入后 Esc 不写入）、`13-zip`（全选下载：条目与字节逐一比对，裁剪过的图片仍是原文件；“更多”菜单两组；收进子画板后下载子画板卡得到文件夹；无选区下载整张画板）、`07c`（没有转写的语音卡不出现“转写”二字）。
- **没做 / 没验证**：见 §11.1、§11.2 的“没做”；裁剪手柄的手感、压暗程度只看了隐藏窗口的静帧；旋转卡片的裁剪只有纯函数测试，没有在窗口里验证；512 MB 级别的大包没有实测耗时（附件在 Main 里整读进内存后流式写出）；深色主题下的裁剪模式本次未单独截图。
