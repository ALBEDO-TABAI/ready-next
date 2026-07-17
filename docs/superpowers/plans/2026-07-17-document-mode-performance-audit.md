---
title: 文档模式性能与多面负载现状审计
date: 2026-07-17
status: reviewed
enforce: false
owner: 白
original_author: Claude (Fable 5)
reviewed_by: Codex
scope: 文档标签、编辑/预览、Widget、Board/PDF/Ebook/Image、Main 文档处理、文件变更与保存协调
---

# 文档模式性能与多面负载现状审计

## 1. 审计目标与结论

目标场景是 10–30 个标签、长图文、大 PDF、多节点画布、文档双开、文档+浏览器分栏、Agent 后台写文档与前台交互并行。本轮以真实调用链为准，对 Claude 初稿逐条复核后得出：

1. 主要瓶颈判断基本正确：编辑热路径上存在多次全文扫描，预览每次更改会重做结构解析和 Markdown 渲染，PDF 一次挂载所有页，Board 拖动每个指针事件重建整份状态，DOCX/XLSX/EPUB 的 CPU 密集处理占用 Main 事件循环。
2. 初稿不能直接实施：它把“保留未变块对象”误写成“结构解析已真增量化”，把直接文件通知错并到只覆盖 watcher 的通道，并把已被打包规则排除的 Tiptap 依赖当成运行资源大户。
3. 初稿漏了三个更直接的放大器：每次正文变更还会重新扫描 Widget 状态；文件变更由 DocumentMode 和每个 MarkdownEditor 重复订阅；双开时两个编辑器与顶层快捷键同时处理保存。
4. 正文驱逐暂不应落地。`DocTab.content` 被 Agent 动作、附件引用、Widget 目标、全局搜索和标签右键菜单同步读取。在建立统一的异步“获取正文”合同前把它清空，会用错内容换取一点内存，不符合修根因和无兼容分支的红线。

## 2. 已证实的运行拓扑

- 生产编辑面是受控 `<textarea>`，预览是默认模式。`TiptapEditor.tsx` 和 `EditorFloatingToolbar.tsx` 未挂载；`electron-builder.yml` 明确排除 `node_modules/@tiptap/**`，所以它们是维护性清理项，不是本轮运行性能项。
- 非分栏工作台会 keep-alive 四个 mode。隐藏 mode 仍然挂载，只是不接收指针事件；DocumentMode 已有 `isActive`，但内部派生计算尚未统一受它约束。
- DocumentMode 只挂载 active 和 split 两个内容面，非可见标签没有 React 组件树；它们的成本主要是 store 中的正文。
- BrowserView 是原生覆盖层。文档+浏览器分栏下，文档的 Renderer 工作和 Main 的文档处理都会与 BrowserView 尺寸、输入和 IPC 共享事件循环。

## 3. 最高优先级问题

### P0-A：编辑热路径存在多条全文扫描

1. `MarkdownEditor` 每次正文变更都同步调用 `buildDocumentOutline`，即使当前是编辑面且大纲面板没打开。
2. `DocumentFloatingPanels` 另外防抖重建一次大纲；批注定位对每条 mark 再各自重建一次大纲。
3. `MarkdownEditor` 的 Widget 状态 effect 每次正文变更都执行 `extractWidgetStateMapFromContent`，并在无 Widget 变更时仍创建新 state，导致第二次渲染。
4. `useDocTabs` 每次击键替换 `tabs` 数组，zustand persist 立即序列化并同步写 metadata localStorage。

这四项叠加在受控 textarea 的同一个输入帧上，是长文档打字延迟的主因。

### P0-B：滚动恢复被正文引用意外触发

`DocumentMode.tabByScrollKey` 依赖整个 `tabs`。击键换数组引用后，滚动捕获 callback、监听 effect 和 `useLayoutEffect` 恢复链跟着变化。`restoreElementScroll` 又会排入多组 rAF 与定时回放。内容编辑不应重置布局恢复链，这是依赖边界错误，不是单纯的“定时器太多”。

### P0-C：预览每次变更整篇解析、所有 Markdown 块重渲染

`buildStructuredNotePreview` 对 frontmatter、header metadata、Widget fence、embed 和正文块做多趟线性扫描。`NotePreview` 随后对所有 block 重建 `ReactMarkdown`。结构解析受全局元数据、源区间和块顺序影响，本轮可以安全做的是：

- 保留未变块的对象身份，用 memo 阻断未变 `ReactMarkdown`/Mermaid/Widget 子树；
- 为视口外块使用 `content-visibility`降低布局与绘制成本；
- 保留全文结构解析的 O(n) 事实，不把块复用冒充为真正增量 parser。

### P0-D：PDF 与 Board 的可见面成本无上界

- `PdfViewer` 为 `numPages` 的每一页同时挂载 `<Page>`，缩放会让全部页重新栅格化。它还先用 IPC 把整份 PDF 读入 Renderer；超过二进制读取上限时直接失败，没有使用已传入的 `local-file://` URL。
- `BoardEditor` 拖动每个 pointermove 都执行 `patchState -> normalizeReadyBoardState -> nodes.map`，吸附开启时每帧又重算全部固定节点边界。持久化已经防抖且原子，瓶颈是拖动中的状态与 DOM 路径。

### P0-E：重文档转换占用 Main 事件循环

DOCX 的 mammoth 解析、XLSX 的 SheetJS 解析、EPUB 的解压+章节转换，以及 DOCX 保存中的 `Packer.toBuffer` 均在 Main 执行。扩大查调用方后还发现，Agent 文档读取和附件提取会在 Main 重复执行 DOCX/XLSX/PDF 解析。初稿只把编辑器 parser 移到 worker、将 `writeFileSync` 换成 async 仍不够：所有 live 重文档入口都必须收口，DOCX 打包本身也必须一起下移。

## 4. 第二优先级问题与重复入口

1. `DocumentMode` 和 `MarkdownEditor` 全量订阅 store，active 正文每次变更使整个文档工作面重跑；分栏另一面也缺少明确的 memo 边界。
2. `DocumentMode` 与每个 `MarkdownEditor` 都订阅 `document:directoryChanged`。双开时同一变更可以触发页面级和两个编辑器级回读。
3. 顶层 `useKeyboardShortcuts` 与每个 `MarkdownEditor` 都处理 Cmd/Ctrl+S。双开时焦点文档没有显式的单一保存归属。
4. Widget 渲染预算单独再解析一次 fence，并重复编译 Widget；每个 iframe 各建一个主题 `MutationObserver`；高度缓存只用代码前 200 字符作 key 且无上限。
5. 预览滚动每个事件都重新查询所有标题并读取边界，测量本身没有进 rAF 合并。
6. `document:read` 文本路径无尺寸上限；二进制已有 guard，文本没有同等的结构化错误。
7. 直接写入完成后的广播与 `fs.watch` 事件会双发。正确的收口是让 `directory-change-broadcast` 成为唯一的 per-webContents 合并发射器，而不是把直接通知塞进仅管理已订阅目录的 `watch-group`。
8. `EbookViewer` 的 relocate 每次都同步读改写 localStorage；`ImageGallery` 同目录换图每次重新 list/stat。

## 5. 不纳入本轮开发的项目

### 5.1 正文内存驱逐

现状确实无上界，但同步正文消费者很多。本轮只记录真实内存数字，不用 30 分钟定时器或 `content === ''` 假状态驱逐。后续若量测证明文本正文是主要内存源，先建立单一 `ensureTabContentLoaded(tabId)` 异步合同，迁移所有 Agent/UI/附件消费者，再实施按总字节预算的 LRU，不按时间猜测。

### 5.2 Tiptap 与未挂载旧组件删除

只修正误导注释。是否删除旧文件与依赖属产品路线和维护整理，不用性能名义夹带决策。

### 5.3 Agent 写入合并与 pipeline 减少磁盘真值回读

每次工具调用都是可观察的语义边界，不应暗中合并。commit registry 成功也不等于磁盘真值验证可以删除。本轮从消费侧降低每次写入的渲染与解析成本，不改工具语义和真值验证。

### 5.4 Widget 滚出视口即销毁 iframe

这会丢失 Widget 内部交互态。本轮保留已有重 Widget 手动预览预算，只收敛重复编译、observer 和缓存。真正的 iframe LRU 需先完成可验证的 state snapshot/restore 合同。

## 6. 修订后的实施顺序

1. 先建可重复的计数型基线与 `verify:document-perf`。
2. 先清理击键、双开保存、重复监听和隐藏面热路径。
3. 再做预览块稳定渲染身份、Widget 编译/主题桥收口与滚动降载。
4. 收口目录广播、文本大小 guard 和查看器小型缓存。
5. 单独攻坚 PDF 窗口化、Board 拖动和文档 worker，每项都要有真实 Electron 证据。

具体机器合同、测试和验收门见配套的 `2026-07-17-document-mode-performance-implementation.md`。

## 7. 扩大审查后的补充修正

实施过程中继续沿相邻调用链扩大审查，确认初稿还遗漏了以下会放大多面负载的问题：

1. metadata 若在每次短暂 idle 时立即写入，连续输入仍可能退化为高频写盘；正确合同是“输入安静 120ms 后再等待 idle”，并从第一次变更起保留 500ms 硬上限。
2. 双开状态本身存在不变量缺口：active/split 可能指向同一标签，关闭主栏后可能留下无效分栏，点击已在副栏显示的标签也可能重复挂载。必须在 store 层归一，而不是靠视图补救。
3. 隐藏 DocumentMode 不能一律卸载。普通文档应卸载重树；含交互 Widget 的可见场景要冻结最后一次可见快照并保留 iframe，避免丢失内部状态，同时不能继续消费隐藏期正文更新。
4. PDF 即使只挂载少量 `<Page>`，缩放若仍让 500 个占位 slot 接收新 props，也会制造大批无意义 React 更新；窗口外 slot 必须忽略 zoom，仅由容器缩放变量更新高度。当前半径为 3，严格上限是 7，不是 9。
5. Board 的连续热路径不止节点拖动，还包括框选、缩放框、箭头端点和滚轮平移/缩放；这些入口同样必须按动画帧合并。节点拖动保持“过程零 state、结束一次提交”，其他连续入口最多每帧一次提交。
6. document worker 若允许 DOCX/XLSX/PDF 重任务并发，虽然 Main 不再卡顿，双开和 Agent 并行仍会放大 CPU 与内存峰值；worker 内部必须串行执行重任务。Agent 的分段读取也要把 offset/limit 下推到 worker，不能先把完整提取结果复制回 Main 再截断。
7. 目录广播不能遍历任意 `webContents`（其中可能含非工作台页面）；直接变更只发给活跃 `BrowserWindow` 的 Renderer，watcher 事件仍只发给订阅者，并在同一发射器中合并。

## 8. 对抗性复审后的最终补充

完成实施与真实负载验收后，独立复审继续沿保存、退出和浏览器联动时序下挖，确认还有五类不能靠普通稳定性测试覆盖的边界：

1. 同一 clean 文档在第一次回读未完成时又收到变更事件，不能只共用旧 Promise；必须至少再读一次，最终落到最新磁盘版本。
2. 画板 1.5 秒合并保存期内直接退出，React 卸载的异步 cleanup 不能作为可靠性边界；Main 退出流程必须等待 Renderer 中所有已登记状态拥有者确认落盘。
3. 原子替换不能绕过只读文件，也不能静默改变软链接或多重硬链接身份；必须先验证可写性，保留权限位，跟随软链接目标，并对无法原子保持身份的多重硬链接明确拒绝。
4. 浏览器图片加入画板不能由 Main 从旧磁盘快照做 read-modify-write；当前 BoardEditor 必须在自己的最新状态上合并，再经同一保存排队落盘。编辑器为节省资源而卸载时，外部素材按画板真实路径暂存，重挂载后仍由该画板消费。
5. 双画板的活动目标必须由用户真实焦点决定，不能由异步 open 的返回顺序决定；旧画板释放时只能 compare-and-clear 自己的句柄。浏览器回收也必须在“超额候选页全在加载”时保留低频复查，did-stop/did-fail 后立即重启回收，并在后台页稳态期保留内存压力采样。
