---
title: 文档模式性能与多面负载实施合同
date: 2026-07-17
status: completed
enforce: true
owner: 白
reviewed_by: Codex
depends_on:
  - docs/architecture/current-runtime-contracts.md
  - docs/superpowers/plans/2026-07-15-document-open-latency-implementation.md
  - docs/superpowers/plans/2026-07-17-document-mode-performance-audit.md
---

# 文档模式性能与多面负载实施合同

## 1. 目标与完成定义

本轮不以“加了 memo”或“测试能跑”为完成。只有下列条件同时成立才能收口：

1. 长文档编辑时，每次击键不同步重建大纲、不扫描 Widget fence、不重启滚动恢复链，metadata 不每键同步写 localStorage。
2. 文档双开时，一次保存只有一个明确目标；一次目录变更只有一个 Renderer 调度入口，clean 文档回读去重，dirty 文档永不被覆盖。
3. 文档 mode 隐藏时，普通文档卸载重树；含交互 Widget 的最后可见场景冻结正文并保留 iframe 状态。Agent 连续写入不触发预览解析、大纲、批注和 Widget 状态扫描，回到文档 mode 后只用最新正文补算一次。
4. 预览改变一个块时，结构 parser 可以仍是 O(n)，但未变块不重跑 ReactMarkdown、Mermaid 或 Widget 编译；视口外块不承担完整布局/绘制。
5. 500 页 PDF 同时挂载的 `Page` 不超过 7，使用 `local-file://` 和 Range 响应按需读取，超大 PDF 不再因 Renderer 整文件字节上限而无法打开；缩放不重渲染窗口外的轻量占位 slot。
6. Board 节点拖动期间不调用 `patchState`，pointerup 只提交一次，固定节点边界只在 dragstart 快照一次；框选、缩放框、箭头端点和滚轮连续事件最多每动画帧提交一次。
7. DOCX 读/写、XLSX 解析、EPUB 导入，以及 Agent/附件路径中 DOCX、XLSX、PDF 的文本提取都在 document worker 中串行执行；Main 只负责请求调度与返回。分段提取的 offset/limit 下推到 worker。文本和 DOCX 发布都用同目录临时文件+替换，失败不损坏原文件。
8. `npm run verify:document-perf`、`npm run verify:widget-ready`、`npm run verify:native`、`npm run typecheck`、受影响全量测试和 build 全部通过；真实 Electron 的长文档、PDF、Board、双开与 document+browser 矩阵验收通过。系统采样优先使用完整 Xcode 的 Time Profiler；机器没有 `xctrace` 时，必须用 `/usr/bin/sample` 对精确的 Main/Renderer PID 重放同一负载并记录环境限制，不得静默跳过。
9. 连续外部变更不吞最后一次刷新；画板退出前完成最后一次保存，浏览器导入图片不覆盖本地未保存节点，双画板导入只命中用户实际点选的画板。
10. 文本/DOCX 发布保留权限位，拒绝只读目标和多重硬链接，跟随软链接真实目标；浏览器超额页全在加载时不得丢失后续回收。

## 2. 不可破的边界

- 不改 Agent 文档工具的逐次可观察语义，不合并或丢弃工具写入。
- 不删除 pipeline 的磁盘真值校验，不把 commit receipt 当成文件 readback。
- 不用 `content === ''` 表示被驱逐正文，本轮不实施正文 LRU。
- 不以性能名义删除 Tiptap 旧面或改变未确认的富文本路线。
- Widget 的 nonce、CSP、结构真值、主题令牌、事件桥和导出合同不改；不在没有 state restore 合同时销毁滚出视口的 iframe。
- BrowserView 的 hide/show/bounds 合同不由本计划重写；只在联合验收中验证 document+browser。
- 不用 source grep 代替行为测试。结构 gate 只钉住唯一所有者、worker 边界和不可破合同。

## 3. P0：基线、可观测性与聚合 gate

### 3.1 实施

1. 新建纯测试/开发诊断的 document performance counters，覆盖 outline、Widget fence 全文扫描/Widget state parse、preview parse/block render、widget compile、PDF mounted pages、Board drag commits/interaction frames、directory broadcasts 和 metadata writes。诊断默认关闭，不创建常驻 timer。
2. 新增 `npm run verify:document-perf`，只组合本计划的行为测试和必要结构 gate，不把整仓测试重复塞入。
3. 生成可重用 fixture：5 万字/5000 行 Markdown、50 个图文块、20 个 Widget、150 节点 Board 和多页 PDF。fixture 不进用户工作区。

### 3.2 基线场景

| ID | 场景 | 必须记录 |
|---|---|---|
| D1 | 5 万字 edit 连续输入 | 输入延迟 p95、outline/widget fence scan/widget parse 计数、metadata write 计数 |
| D2 | 长文档 preview-edit 改一块 | preview parse 计数、未变 Markdown/Mermaid/Widget 重渲染数 |
| D3 | 文档 mode 隐藏时 Agent append x50 | 派生扫描数、long task、切回补算数 |
| D4 | 500 页 PDF 打开、滚动、缩放 | 挂载 Page 上限、首屏时间、Renderer 堆 |
| D5 | 150 节点 Board 拖动 5s | 帧时间、patchState 次数、fixed bounds 计算次数 |
| D6 | 文档双开 + 保存/外部变更 | 保存目标数、readFile 次数、dirty 保护 |
| D7 | document+browser + DOCX/XLSX/EPUB/PDF 重处理 | Main 响应、浏览器交互、系统采样热点 |

## 4. P1：编辑热路径与双开单一所有者

### 4.1 大纲与批注

1. 删除 `MarkdownEditor` 渲染期 `buildDocumentOutline`。预览可见行定位优先读 DOM 标题和 parser 已有源区间，只在 reveal 需要且无可用区间时才惰性建 outline。
2. `DocumentFloatingPanels` 仅在 outline 或 marks 面板打开时、以 140ms 防抖建一份 outline。`resolveDocumentMarkLocation` 接收已有 outline，M 条 mark 不得再建 M 份 outline。

### 4.2 Widget 状态扫描

1. 无 Widget marker 的正文直接返回空 map，不进 parser。
2. 以 Widget fence 签名而非整篇正文驱动状态提取；源编辑器用 beforeinput 的精确替换区间增量平移已知 fence range，非 Widget 击键既不重新提取，也不重新全文扫描 fence。改动 fence 或新增/删除 marker 时才重建签名与 range。
3. merge 后与当前 state 等价时返回原引用，不制造第二次渲染。隐藏 document mode 不提取，显示时只处理最新签名。

### 4.3 滚动与 store 边界

1. 滚动键到 tab 的映射只依赖 `id/path`，正文通过需要时从 store 读取。击键不得改变 capture/restore callback 身份。
2. 恢复仅在切标签、切 edit/preview、分栏改变或重挂载时触发。保留一次 rAF 和一次有界的稳定后兜底；图片晚到用 ResizeObserver/onload 触发，不排多档固定 timer 风暴。
3. `DocumentMode`/`MarkdownEditor` 使用字段 selector，稳定的 rail projection 用浅比较；`DocumentEditor` 建明确 memo 边界，一栏击键不渲染另一栏。
4. metadata persist 从第一次变更起保留 500ms 最长窗口；输入安静 120ms 后才请求 idle 提前落盘，新输入会取消该 idle 请求。pagehide/beforeunload/visibility-hidden 同步冲刷，既有 draft 300ms 合同不改。

### 4.4 双开保存与外部回读

1. 在 doc store 显式记录 `focusedPaneTabId`，必须是 active/split 之一；切标签、关闭和取消分栏时同步归一。
2. Cmd/Ctrl+S 只保留顶层单一入口，目标为 `focusedPaneTabId ?? activeTabId`；删除每个 MarkdownEditor 的全局监听。已挂载编辑面通过按 tab 注册的 owner 执行并显示保存错误，隐藏/未挂载但可直接写的文本由顶层安全回退。保存仍必须用 snapshot commit，保存期间继续输入不得被旧结果标为 clean。
3. `document:directoryChanged` 在 Renderer 只由 DocumentMode 订阅一次。只处理可见 active/split 且 clean 的文本标签；同一 `tabId/path` 的并发回读共享 in-flight promise，返回时重新检查 path/dirty。隐藏期只记脏，激活后一次回读。

### 4.5 行为 gate

- 连续 20 次正文更改：outline=0，普通击键的 Widget fence 全文扫描=0，无 Widget 文档的 Widget parse=0，scroll restore=0，metadata `setItem<=2`。
- marks 关闭时 mark resolve=0；打开后 M 条 mark 共用一份 outline。
- 双开时一次保存只写焦点标签；目录事件对每个可见 clean tab 最多一次 read，dirty tab 为 0。
- 隐藏 mode 写入 10 次：preview/outline/marks/widget-state 派生计算均为 0；显示补算各不超过 1。

## 5. P2：预览块复用与 Widget 资源收口

### 5.1 预览块渲染身份

1. parser 返回仍以最新全文为真值，不宣称对象复用或增量 parser。渲染层为每块生成 `type + 块原文哈希 + 同值出现次序` 的稳定内容寻址身份；在前文插入导致 source range 整体偏移时，未变块仍保持同一 React key。
2. 块视图抽成 memo 组件，稳定 props 不含整篇 content。改一个 markdown 块时，其他 markdown/details/embed/widget 块不重跑子渲染；源区间仍从本次 parser 结果读取。
3. 块容器使用 `content-visibility:auto` 和保守 `contain-intrinsic-size`；reveal、预览内编辑、拖排、导出捕获必须通过。导出树显式关闭该降载，不得导出空白块。

### 5.2 Widget 单次解析/编译

1. `getDocumentWidgetRenderBudget` 接收已解析的 widget records/已解析渲染码，不再自己 parse 整篇正文。
2. `resolveDocumentWidgetRenderCode` 增加容量有界的内容寻址 LRU，key 覆盖 stored code、skeleton spec 和 component spec。未改 Widget 的正文更改不重新编译。
3. Widget 主题桥抽成模块级订阅注册表，全文档只有一个 `documentElement` MutationObserver；每个 Widget 注册/注销 `postTheme` 回调。message 令牌校验不改。
4. Widget 高度缓存使用完整内容 hash 并限制容量；不使用前 200 字符。
5. Mermaid SVG 以 code+明确的渲染主题配置作为 key 的有界 LRU（当前配置固定为 `base`）；每次挂载对 SVG id 重新命名，避免多图同页冲突。

### 5.3 预览滚动

标题节点列表在 preview block 结构变化时刷新；scroll 事件只排一个 rAF，查询和几何读取全部在该 rAF 内进行。同一帧多个 scroll 事件只扫一次。

### 5.4 gate

- 改变单个块：未变 Markdown/Mermaid/Widget 渲染计数为 0，源区间与拖排结果正确。
- 同一 Widget 连续解析 20 次：编译 1 次；缓存超容量后最旧项被驱逐。
- N 个 Widget 同时 ready：全局主题 observer=1，卸载全部后 observer=0。
- 隐藏普通文档不保留编辑树；隐藏含 Widget 场景只保留最后可见快照，隐藏期正文更新不穿透，重新显示后追到最新正文。
- `npm run verify:widget-ready` 全绿；导出不缺块、Widget 事件与主题切换真实 Electron 通过。

## 6. P3：文件变更、文本 guard 与轻查看器

### 6.1 目录变更单一发射器

1. `directory-change-broadcast.ts` 成为唯一调用 `webContents.send('document:directoryChanged')` 的模块，为每个 webContents 维护 140ms 的 path Set 与一个 timer。
2. 直接写/创建/移动路径只向活跃 `BrowserWindow` 的 Renderer 排队；`watch-group` 只向已订阅 sender 排队。两者在发射器中去重，不丢未被 watch 的直接变更，也不向 worker/辅助 webContents 广播。
3. sender 销毁、监视取消、app quit 清理 timer 与 Set。测试提供显式 flush/reset seam，不依赖真时等待。

### 6.2 文本大小 guard

`document:read` 在读 UTF-8 前 stat；超过 20 MiB 返回 `TEXT_FILE_TOO_LARGE` 和 bytes/limitBytes，不截断、不分配全文字符串。Renderer 显示明确提示并保留重试/关闭，不把它伪装成普通读取失败。

### 6.3 Ebook 与 ImageGallery

1. Ebook relocate 位置写入 500ms 合并，pagehide/visibility-hidden/卸载冲刷；保留每本书独立 key 和最近记录上限。
2. ImageGallery 对目录 siblings 使用有界 LRU，同目录换图不重复 list/stat；`directoryChanged` 命中目录时立即失效，其他目录不失效。

### 6.4 gate

- 直接 write + fs.watch 在同一窗口内对同一 sender 只发 1 条合并事件，paths 去重；未 watch 的直接 write 仍能送达。
- 20 MiB+1 文本在读取前被拒绝，错误码和尺寸信息完整；20 MiB 边界内容正确。
- 50 次 ebook relocate 最多 2 次 storage write，卸载前最后位置必达；同目录连续看 20 张图只 list 一次。

## 7. P4：PDF 窗口化与 Board 拖动快路径

### 7.1 PDF

1. `PdfViewer` 直接把 `local-file://` URL 交给 react-pdf/pdf.js，删除 Renderer `Uint8Array` state 和 `document.readFile` PDF 路径。现有协议的 HEAD/206/Content-Range/Accept-Ranges 必须有行为测试，打包态真实打开大 PDF 必须通过。
2. 保留所有页的轻量占位器，只挂载当前页前后各 3 页的 `<Page>`，严格上限 7。页尺寸由已渲染页的 viewport 按需回填；未测页使用保守占位。缩放通过容器 CSS 变量更新全部占位高度，窗口外 slot 的 React props 保持 memo 相等。
3. 既有上一页/下一页、页码、缩放/适应宽度、文本层、标注层和滚动恢复必须真实验证；混合页尺寸在访问后逐页校准，不承诺预取未访问页。只有页数窗口合同允许纯结构 gate。

### 7.2 Board

1. dragstart 快照被拖节点/组的起始位置、固定节点 bounds 和 DOM refs。
2. pointermove 只写入最新坐标并排一个 rAF。rAF 中使用 `style.translate`（不覆盖节点既有 rotate/transform）更新被拖 DOM，并更新参考线。期间不更改文档 state。
3. pointerup 清除临时 translate，从起始快照+最终 delta 生成一次 state commit；既有历史/保存语义不变。pointercancel/Escape/卸载必须清理 rAF 和临时样式。
4. 框选、缩放框、箭头端点和滚轮平移/缩放共享“原始事件只写最新值、单个 rAF 消费”的边界；每个动画帧最多一次 React state commit，结束时保留最终值。

### 7.3 gate

- `numPages=500` 时任意滚动位置挂载 Page<=7；缩放不渲染窗口外页，也不重渲染数百个窗口外 slot；超大 PDF 不走 IPC 整文件读取。
- Board 拖动 100 个 pointermove：期间 patchState=0，结束=1，fixed bounds 快照=1；取消后 state/DOM 回到起始状态。
- Board 其他连续交互的 100 个原始事件最多产生对应动画帧数的状态提交，卸载时没有遗留 rAF。
- 真实 Electron 中完成 PDF 滚动/缩放/跳页、Board 单选/多选/吸附/取消，以及 document+document 与 document+browser 组合。

## 8. P5：document worker 与原子发布

### 8.1 worker 合同

1. 新增具名 `document-worker` build entry、worker protocol 与 lazy bridge。命令仅包含 `parseDocx`、`parseXlsx`、`importEpub`、`extractDocumentText`、`readDocxText`、`writeDocx`、`shutdown`。每条请求有 id，错误序列化，返回后清理 pending。
2. worker 首次请求才启动；空闲 60s 后请求正常退出并给 1s 收尾，app quit 显式 shutdown 并给 4.5s 收尾。crash 不在 Main 透明回退执行重处理，而是返回结构化失败，避免“worker 坏了就冻住全应用”。
3. worker 内部以单一队列串行执行重任务，保证请求顺序并限制 CPU/内存峰值。Main 只传路径、选项和小型结构化结果；worker 自行读取源文件，DOCX 由 worker 直接原子发布到目标路径，不把大 Buffer 复制回 Main。文本提取只返回请求的 offset/maxChars 窗口和 nextOffset；对 Renderer 的现有 IPC 数据形状保持一致。
4. 文档模式解析、Agent 文档提取与附件 DOCX/XLSX 读取路径中，mammoth、xlsx、jszip/turndown 的 EPUB 链、pdf2json 和 docx Packer 只由 document worker 调用图可达。其他与本计划无关的压缩包导出等 Main 功能不在此约束内。

### 8.2 DOCX 与文本发布

1. DOCX 保存的旧正文只解析一次，同时供空覆盖与骤缩 guard 使用。防误写语义和 best-effort 备份保留。
2. worker 生成 DOCX bytes 后，在目标同目录写唯一 tmp，fsync/close 后原子替换；文本保存复用同一发布 helper。不先删原文件，失败 finally 清理 tmp。
3. Windows 上替换已存目标需使用可回滚的同目录 backup-swap；任何一步失败都恢复原文件，不保留直接覆盖兼容分支。

### 8.3 gate 与打包验收

- 真 worker 行为测试覆盖 DOCX 读/写/解析、XLSX 解析、EPUB 导入与 PDF 文本提取，以及并发 request id、串行执行顺序、crash/pending reject、idle shutdown 与再启动。
- 原子写注入中断时目标仍是旧文件，成功后没有 tmp；DOCX guard 只读旧正文一次。
- 重处理期间并发 Main ping 不被 CPU 工作阻塞。`npm run verify:native` 通过。
- dev、packaged dir 和 DMG 中均能解析 worker 路径；真实 DOCX/XLSX/EPUB/PDF 样本成功读取，DOCX 成功写回并 readback。

## 9. P6：对抗复审时序与所有者加固

### 9.1 连续刷新和退出冲刷

1. 每个 `tabId/path` 的外部回读记录 generation。请求进行中又来事件时，同一请求至少再读一次；最后一次 generation 检查与从 in-flight map 删除在同一个不可插入的同步段完成。
2. Renderer 以单一 before-quit bridge 组装所有状态拥有者。Board 和阅读会话只登记 handler，不各自提前 ack；Main 等全部 handler settled 后才继续退出，总时间仍受既有 5 秒上限保护。

### 9.2 画板与浏览器联动

1. Main 的浏览器右键动作只下载/导入 asset，不读旧画板状态、不直接保存。当前 BoardEditor 把 asset 合并到 `stateRef.current`，增加 revision，经同一 coordinator 串行落盘。
2. BoardEditor 暂时卸载时，asset 以 Main 返回的真实画板路径暂存，重挂载时交给新句柄。同一画板重开复用 Main 句柄，不因 mode 切换无界增长。
3. BoardEditor 接收 pane 焦点并在 pointer/focus capture 时更新 active board；异步 open 只在该 pane 仍是焦点时激活。标签关闭只对自己的 boardId 做 compare-and-clear。

### 9.3 发布语义和浏览器回收

1. 原子发布先 `lstat`；软链接解析到真实目标，多重硬链接显式拒绝。已存目标先检查可写性，临时文件写完后重设原权限位再替换。
2. 超额时如果后台候选页全在 loading，回收器保留 30 秒低频复查；`did-stop-loading`/`did-fail-load` 立即重启。只要还有可回收的后台页，预算内也保留低频内存压力采样。

### 9.4 gate

- 回读 v1 未完成时到达 v2 事件，最终渲染 v2 且 in-flight map 清空。
- Board edit 后在 debounce 内触发 quit，ack 后磁盘 readback 必须是最新值。
- local unsaved node + external image，以及 local save in-flight + external image，最终状态都同时含原节点和图片；隐藏后重挂载不丢图。
- 双画板相反 open 完成顺序不改变点选目标；旧画板关闭不清除新画板。
- 只读、软链接、多重硬链接和权限位都有真文件行为测试。超额 loading 页在 loading 结束后自动回收。
- 聚焦文本未走完常规提交时直接退出，磁盘 readback 仍必须包含最后输入。
- 一个失败与一个慢保存并存时，退出冲刷必须等慢保存完成后再聚合失败；失败路径在后续同路径成功之前不得允许从旧盘面重开。
- 原位替换与恢复都失败时保留原文件备份，清理临时文件，并返回可读的 backupPath。

## 10. 最终验收顺序

1. `npm run verify:document-perf`
2. `npm run verify:widget-ready`
3. 文档打开/保存/外部刷新/Widget/Board/Ebook/PDF 受影响测试
4. `npm run typecheck`
5. `npm run verify:native`
6. `npm run test`
7. `npm run build`
8. 真实 Electron D1–D7，保存计数、Page 挂载数和 Board commit 计数读回
9. 先尝试 `xcrun xctrace record --template 'Time Profiler'`，使用正确 Ready 进程重放 D1/D5/D7；若完整 Xcode/`xctrace` 不存在，则分别用 `/usr/bin/sample <renderer-pid>` 与 `/usr/bin/sample <main-pid>` 重放同一负载，记录样本、驻留峰值与热点栈。前态用实施前已证实的调用链和会失败的计数合同固定，后态用同一计数合同加真实系统采样证明；不得在代码完成后伪造不可比的“前态 trace”
10. 检查所有净增行文件；超过 1000 行按规则更新 `docs/code-health/large-file-health-log.md`
11. 由一个 fresh adversarial agent 对实施计划、全部 diff、测试证据和真实验收做对抗复审；所有有效问题修复并复测后才允许 commit。

## 11. 实施记录

| 阶段 | 状态 | 证据 |
|---|---|---|
| P0 基线/gate | completed | 固定生成 5000 行/50 图/20 Widget/双文档/双画布/500 页 PDF/DOCX/XLSX/EPUB；最终 `verify:document-perf` 全部通过，并纳入 workspace watcher 订阅唯一性合同。默认样本目录每轮先清空，避免导入产物污染。 |
| P1 编辑/双开 | completed | 打包态 194955 字正文连续输入 next-frame p95 3.2ms、metadata 写 1 次且无大纲/Widget 派生；双栏焦点保存只写目标栏，外部覆盖不覆盖 dirty 正文。 |
| P2 预览/Widget | completed | 单块修改只触发 1 次结构解析和 1 个预览块渲染，未变 Widget 编译/渲染均为 0；隐藏期连续写 50 次派生计算为 0，返回后各补算 1 次。 |
| P3 变更/guard/查看器 | completed | 合并目录广播、20 MiB 文本边界、Ebook 合并写入与 ImageGallery 目录 LRU 均进入最终 137 项专项行为 gate；Widget 总 gate 196 项通过。 |
| P4 PDF/Board | completed | 打包态 500 页 PDF 在 200% 缩放和滚动后同时挂载 7 页，Renderer V8 used heap 22.3 MiB；150 节点拖动 5 秒只提交 1 次，诊断记录 120 个合并帧。 |
| P5 worker/原子发布 | completed | 打包态真实 DOCX/XLSX/EPUB 均在界面打开；连续 600 个 DOCX/XLSX worker 请求 2185.1ms 全成功，10ms Renderer heartbeat 最大 11.5ms；原子中断/恢复和 Electron 42 SQLite 原生 gate 通过。 |
| P6 对抗时序/所有者 | completed | 连续刷新、退出落盘、只读/链接/权限、画板外部导入、双画板焦点和超额 loading 回收行为合同全部落地；补齐聚焦文本退出提交、保存失败传递、同路径失败阻断旧状态重开、多画板 all-settled 等待和双重失败备份保留。macOS 文件监听进一步补齐启动确认、运行期死亡自动摘除、跨路由失败真值、旧事件仲裁和可见重试。`verify:document-perf` 全部通过，`verify:browser-perf` 117 通过 + 2 项由 native gate 覆盖，IPC 合同与真实 Electron 补验通过。 |
| 真实 Electron + 系统采样 | completed | `xctrace` 因本机仅有 CommandLineTools 不可用，已按合同使用 `/usr/bin/sample`：Renderer 20 秒样本峰值 244.3 MiB，Main 12 秒样本峰值 302.0 MiB；D1/D5/D7 重放期间等待栈占主导，浏览器交互保持响应，未出现文档解析占用 Main UI 线程的热点。 |
| 对抗复审 | completed | 全程只使用同一个 fresh adversarial agent；每轮有效问题都先修复、补行为证据，再由它继续复查。最终组合验证覆盖延迟重挂载阻断、一失败+一慢保存全部等完、聚合报错、后续成功清除失败、双重失败保留备份，以及 watcher 启动/运行/跨路由/延迟事件/重复重试竞态；同一复审者第三轮给出 PASS。 |
| 最终全量验收 | completed | 最终 `npm run verify` 零失败；串行子任务 154 项通过、3 项由 native gate 覆盖，串行时序/性能 35 项全过。文档性能样本已改为测试自建、自清理，macOS 真文件监听改在串行 lane 验收，并对异步启动失败明确报错。`npm run build:dist` 生成 Ready 0.7.5 arm64 应用、ZIP 与 DMG；成品已通过签名、版本、架构、只读挂载、Applications 快捷方式、独立 document worker 和全新隔离资料启动检查。 |

实现与验收阶段均已按证据回填；普通 Node 的 native ABI 项由本轮 Electron 42 `verify:native` 真机原生门补足，不作为跳过验收。最终提交仍以同一对抗复审者给出 PASS 为最后一道门。
