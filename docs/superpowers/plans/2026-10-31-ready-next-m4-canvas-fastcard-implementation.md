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
