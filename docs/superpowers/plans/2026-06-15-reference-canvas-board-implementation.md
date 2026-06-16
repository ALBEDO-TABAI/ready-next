---
title: Reference 画板（文件型编辑器 / 自包含 HTML）实现计划 v2.1
date: 2026-06-15
status: implemented
owner: 白
executor: Claude / Codex
enforce: true
supersedes_draft: v1 愿景草案、v2 初版（均被本版替换）
related:
  - CLAUDE.md
  - AGENTS.md
  - docs/superpowers/plans/2026-06-01-electron42-html-in-canvas-upgrade-implementation.md
external_references: []
---

# Reference 画板（文件型编辑器 / 自包含 HTML）实现计划 v2.1

> 经两轮审查收口。v2.1 相对 v2 的修订（Codex 第二轮 5 点，已逐条核验真实代码）：
> ① 真正的内容路由是 `DocumentMode` 的 `DocumentEditor`，不是 `FilePreview`；② 状态转义改成可执行的 JS unicode 规则；③ 主进程路径授权改用 **board handle 能力模型**（不信任 renderer 传的 workspaceRoot）；④ `.readyboard` 必须接入**所有**文档打开/拖入链路；⑤ 模板资源打包路径与 packaged 验证写清。

## 0. 架构决议（不可破）

1. **画板 = 文件型编辑 surface，不是新模块**。心智入口仍是 browser/document/rss/calendar 四个；画板藏在文件工作流里：文件树右键「新建画板」或打开画板文件时，在**现有文档内容区**用 React 渲染画板编辑器。
2. **磁盘形态 = 自包含 `.readyboard`**（内部仍是 HTML 容器：引擎内联 + 状态内联 + 相对 `assets/` 引用）。编辑/拖入/保存只在 Ready 内；对外分享可另行导出 HTML。
3. **Ready 内不把画板当网页加载**：`BoardEditor`（React，主渲染进程，完整 `electronAPI`）直接挂载共享引擎模块，把 `.readyboard` 当**数据文件**读写。→ 没有 senderFrame 协议校验、preload、partition、tab 生命周期问题。
4. **浏览器模块不承担画板任何生命周期。**

## 1. 当前事实（已读源码核实）

### 1.1 文档内容区的真正路由器（v2 写错点，已纠正）
- `src/renderer/pages/modes/DocumentMode.tsx:273` `DocumentEditor()` 是 tab 内容路由：`:293` image/video/pdf/ebook → `FilePreview`；xlsx → `UniverSheet`；**其余（含 `html`）落 `MarkdownEditor`（:307）**。
- `FilePreview.tsx:28` 只是 image/video/pdf/ebook 的**子分发器**，不是主入口。
- `.readyboard` 经 `path.ts:12 getFileExtension` 取最后段 = `readyboard`，不是普通 `html`。**→ board 分支仍加在 `DocumentEditor` 顶部（`isReadyBoardFile(tab.path)` 命中即 `lazy(BoardEditor)`），避免被其他文档兜底误收。**

### 1.2 必须接入的三条「打开/拖入」链路（Codex#4 完整性）
- **A. 文件树点击**：`FileTree.tsx:1727 handleOpenFile`，`:1741` 把所有 `.html` 送浏览器。board 检测须放在 `:1741` 之前 → `useDocTabs.openTab` + `setWorkbenchMode('document')` 后 return。
- **B. 内容区路由**：`DocumentMode.tsx:293`（见 1.1）。
- **C. 文档分屏/拖入**：`documentPaneDrop.ts:53 isDocumentPaneOpenablePath` 用 `OPENABLE_DOCUMENT_PANE_EXTS`（`:3`，不含 `readyboard`），须改为 `isReadyBoardFile(path) || OPENABLE.has(ext)`。
- 阶段 0 出「开/拖入入口审计清单」，确保无第四条遗漏（file-emergence open / agent open / recent 等）。

### 1.3 打开/持久化/拖拽原语
- `useDocTabs`：`openTab(path)`、`openTabInPane(path,pane)`、`setActiveTab(id)`、`DocTab`。
- `local-file://`：`src/main/index.ts:881`（GET/Range/MIME 全有）；`isPathAllowed()` 在 `:794`（**私有，阶段 0 抽出**）。
- 路径→URL：`dragDrop.ts:121 toLocalFileUrl`；拖入解析 `:67 getDroppedFilesFromDataTransfer`（含 `getFilePathFromDrop`=webUtils）。
- 文件树拖拽源：`FileTree.tsx:240` 已写 `application/x-ready-drag`(JSON 含 path)+`text/plain`(path)。**拖到文档区 BoardEditor 是同一渲染进程的 HTML5 DnD**，直接读这些数据即得路径（无需 native 跨 view 拖拽）。
- 右键菜单：`FileTree.tsx:2992 getContextItems`，native 映射 `:3099`；图标 `@tabler/icons-react`（`IconArtboard`）。

### 1.4 协议/可移植性事实
- 相对引用 `<img src="assets/x.jpg">` 随**文档自身协议**解析：外部 `file://`→可显示；Ready 内 BoardEditor 解析为 `local-file://<dir>/assets/x.jpg`。**状态只存相对路径，按上下文解析**——查看可移植、编辑仅 Ready 内。

### 1.5 资源打包/读取范式（Codex#5 依据）
- `seed-loader.ts:16-19` 与 `embedded-skills`（`runtime-manager.ts:3089`）范式：`app.isPackaged ? join(process.resourcesPath, X) : join(app.getAppPath(), 'assets', X)`；配 `electron-builder.yml:40 extraResources` 的 `from/to`。**模板沿用此范式。**
- `workspaceRoot/pinnedFolders` 在 renderer Zustand（`useWorkspace`）持久化，**主进程无可信副本**——故不能用 renderer 传入的 workspaceRoot 做写入授权（见 §3 handle 模型）。

## 2. Codex 两轮审查处置
| # | 问题 | 处置 |
|---|---|---|
| R1-1 | 自包含与 local-file 打架 | 状态存相对路径、按上下文解析（§1.4）。 |
| R1-2 | 校验协议错配 | 不以网页加载画板 → 协议校验消失（§0.3）。 |
| R1-3 | preload host 大工程 | 改文件型 React surface，消失（§0）。 |
| R1-4 / R2-2 | 内联状态注入 | §3 转义改 JS unicode 规则 + 原子写 + 测试断言无原始 `</script>`。 |
| R1-5 | tldraw 清理 | §8 解耦独立 PR、不 gating，收益/风险据实。 |
| R1-6 | v1 过大 | 分阶段（§4-7），功能不丢。 |
| R1-7 | isPathAllowed 私有 | 阶段 0 抽 `local-path-safety.ts`+测试。 |
| R2-1 | 路由入口写错 | 入口改 `DocumentEditor`（§1.1）。 |
| R2-3 | 路径授权无可信源 | §3 **board handle 能力模型**：save/import 只认 main 侧 handle，renderer 不传写路径。 |
| R2-4 | 打开/拖入链路不全 | §1.2 三链路 + 审计清单。 |
| R2-5 | 模板打包未写清 | §3 + §1.5：`assets/board/` + extraResources + 主进程范式 + packaged smoke。 |

## 3. 关键合同（可机器验证）

- **类型**：`.readyboard`；`isReadyBoardFile(path)=/\.readyboard$/i`（shared，廉价免读文件）。接入 §1.2 三链路。
- **状态嵌入安全（R2-2 可执行规则）**：序列化进 `<script type="application/json" id="ready-board-state">…</script>` 前，对 JSON 文本做 **JS unicode escape**（HTML 实体在 `<script>` 内不解码，**必须**用 `\uXXXX` 而非 `&lt;`）：`<` → `\u003C`、`>` → `\u003E`、`&` → `\u0026`、U+2028 → `\u2028`、U+2029 → `\u2029`。→ 测试：含 `</script>`、`<!--`、U+2028 的文本，roundtrip 后**生成 HTML 中不出现原始 `</script>`** 且 `JSON.parse` 等价。写盘**原子**（temp+rename）。
- **board handle 能力模型（R2-3 唯一授权真值源）**：
  - `board:create(parentDir)` / `board:open(absPath)` 是取得 handle 的唯一入口；main 校验 `isReadyBoardFile`（open）+ `isPathAllowed`（`..`/symlink/敏感路径）+ 存在性，登记 `boardId → {absPath, dir}`，返回 `boardId`。
  - **重开必重取句柄（R3-3）**：BoardEditor 每次打开已有 `.readyboard` 都必须经 `board:open(absPath)` 重新取 handle，**不得依赖上次内存里的 boardId**；重启 / renderer 刷新 / tab 恢复后同理，否则保存与落盘路径会断。
  - `board:save(boardId, stateJson)` 只写 `registry[boardId].absPath`；`board:importAsset(boardId, srcPath)` / `importRemoteImage(boardId, url)` 只写 `registry[boardId].dir + '/assets/'`。**renderer 永不传写入路径，只持不透明 boardId。**
  - 可选硬化：main 维护「已授权根」（来自经 main 的文件夹授权/`showOpenDialog` 路径），create/open 再校验 parentDir ⊆ 某根（阶段 0 确认来源）。
  - → 测试：伪造 boardId / 越界 src / 非 `.readyboard` 目标 / 敏感路径全部拒绝；正常 handle 写通过。
- **资源落盘**：`assets/` 内 `<hash8>-<原名>` **内容哈希去重**；远程下载带超时 + 字节上限 + 类型校验。→ 测试。
- **相对路径不变量**：状态内资源引用恒为相对 `assets/...`；渲染时解析为 `local-file://<dir>/...`，写盘保持相对。→ 测试。
- **模板打包（R2-5）**：模板 `assets/board/board-template.html` 由 `npm run build:board-template`（从 `src/board/engine` 内联）生成并提交；`electron-builder.yml` 加 `extraResources: - from: assets/board to: board`；主进程读 `app.isPackaged ? join(process.resourcesPath,'board','board-template.html') : join(app.getAppPath(),'assets','board','board-template.html')`；CI/verify 加「模板与源一致」freshness 检查 + packaged `build:dir` smoke。

## 4. 阶段 0：探针与前置合同（开工门槛）
1. 抽 `isPathAllowed` → `src/main/modules/app-control/local-path-safety.ts` + 单测（敏感/`..`/symlink/边界）。
2. **DnD 探针**：文档区临时 drop 区，确认从文件树拖入能读到 `application/x-ready-drag`/`text/plain` 路径（预期可，同渲染进程）。
3. **开/拖入入口审计**：列全 `.readyboard` 必须接入的链路（至少 §1.2 三条），确认无遗漏。
4. **board handle 授权源确认**：handle 模型落地；确认是否补「已授权根」及其 main 侧来源。
5. **引擎构建/模板/保存定稿**：引擎=框架无关 TS 模块（`src/board/engine`），两处出口（BoardEditor import + 内联模板）；`build:board-template` + freshness 检查；保存=用模板重生成整份自包含 HTML（消除"只替换块"解析风险）+ 原子写。
- 验收：1 过测试；2/3/4/5 结论写回 §12。

## 5. 阶段 1：最小可用 reference board
范围：新建画板、拖/选**本地图片**、assets 复制去重、移动/缩放/选择、平移缩放、保存 + 重开还原。
- 类型检测 `isReadyBoardFile`（shared）。
- 三链路接入：`FileTree.tsx:1741` 前拦截 → 文档区；`DocumentMode.tsx:293` 顶部 board 分支 → `lazy(BoardEditor)`；`documentPaneDrop.ts:53` 接 `isReadyBoardFile`。
- 引擎 v1：pan/zoom（`transform`）、image 节点、选择/拖动/缩放、视口裁剪护栏、状态 load/serialize。
- 新建入口：`getContextItems` 文件夹/空白加「新建画板」（`IconArtboard`+native iconText）；`board:create(dir)` 取 handle+写模板（默认 `画板.readyboard`，冲突 `画板 2.readyboard`…）→ `openTab`，并**立即刷新文件树**（复用现有新建文件的 refresh / loadDirChildren 路径，新文件须马上出现在左侧——列为验收合同）。
- 拖入：文件树拖图片（HTML5 DnD 读 ready-drag→path）+ 工具条「添加图片」选择器 → `board:importAsset(boardId, src)` → 去重 → image 节点（相对路径）。
- 保存：保存按钮 + ⌘S + 防抖自动保存（~1.5s）；`board:save(boardId, stateJson)` 重生成自包含 HTML 原子写。
- 验收（真实 Electron）：右键文件夹→新建→文档区空画板；拖/选本地图片落 `assets/` 去重；移动缩放；保存后关闭重开状态在；普通 `.html/.htm` 仍走浏览器，`.readyboard` 只走画板编辑器。
- 测试：§3 全部合同 + 新建落位 + roundtrip + 去重。

## 6. 阶段 2：标注元素
文字、色块/矩形、箭头/连线、自由画笔、便签——增改删 + 随平移缩放变换 + 持久化。设计镜像 Ready token（`--bg-primary`/`--text-title`/`--border-default`/`--color-ready-orange #ff4b2b`/玻璃浮层），主操作品牌橙点缀。

## 7. 阶段 3：媒体卡片与网页图片
- **Markdown 卡片**：拖入 .md → 渲染卡片，点击经 `board:openInDocument` 在文档模式打开。
- **视频卡片**：`<video>`+控件（`local-file://` Range）。
- **网页图片 → 画板**（跨 webContents，难点）：**主路径=浏览器图片右键「添加到画布」（接 `context-menu-service`）+ 画板内 ⌘V 粘贴**（最可靠，且比跨 browser/document 模式拖拽更自然）；原生拖拽 best-effort + 探针。远程图经 `board:importRemoteImage` 落 `assets/`。

## 8. tldraw 清理（解耦，独立小 PR，不 gating）
- 删 `package.json:190`、`index.css` 三段（~4630/6010/6020）、`electron-builder.yml:21,38`；`npm install` 刷 lockfile。
- 风险：**低但非零**（源码零引用，不影响编译；仍验 typecheck+install+一次 build）。
- 收益：生产包早已排除（收益小），真实收益 = dev `node_modules` 瘦身(~32M) + 移除违规隐藏水印 CSS（发布合规）+ 依赖卫生。
- **不与画板主线绑定，不作任何阶段前置。**

## 9. 最小闭环映射（CLAUDE.md §7）
1. Main IPC：`board:create`/`board:open`/`board:save`/`board:importAsset`/`board:importRemoteImage`/`board:openInDocument`（全部经 handle 模型）。
2. Preload：主渲染进程 preload 增上述 invoke（无新 host preload）。
3. Renderer 类型：`electron.d.ts` 补声明。
4. Renderer UI：`isReadyBoardFile`(shared)、`FileTree` 拦截+新建菜单、`DocumentEditor` 分支、`documentPaneDrop` 接入、`BoardEditor`+`src/board/engine`。
5. 资源/构建：`assets/board/board-template.html` + `build:board-template` + freshness 检查 + `extraResources`。
6. 测试/gate：§3 合同 + roundtrip + 去重 + 新建落位 + `local-path-safety` + handle 越界拒绝。
7. 文档：本计划 + `CHANGELOG.md`。

## 10. 风险
- 网页图跨 webContents 拖拽（阶段 3）：右键/粘贴为主、原生 best-effort，不缺失。
- 自包含引擎版本漂移：保存即重生成 → Ready 内永远最新；状态带 `engineVersion` 留升级出口。
- 模板 freshness：靠 `build:board-template` + verify 检查防止源/产物脱节。
- 大画板性能：阶段 1 即上视口裁剪；缩略/虚拟化后置。

## 11. 验证
- `npm run typecheck`；聚焦测试（纯 Node，无 SQLite）：`local-path-safety`、`board-handle-authz`（越界/伪造 boardId 拒绝）、`board-state-roundtrip`（含 `</script>`/U+2028）、`board-asset-import-dedupe`、`board-create-placement`、`board-file-detect`（三链路识别）。
- packaged：`npm run build:dir` smoke 确认模板可从 `process.resourcesPath/board` 读到。
- 各阶段真实 Electron 产品面验收（独立 userData，留截图/日志）。

## 12. 当前状态
- 状态：v2.1 已实现并完成真实 Electron 验证。
- 已落地：文件型 `BoardEditor`、`.readyboard` 三链路打开/拖入、board handle 能力模型、模板生成/打包、相对 `assets/` 资源、图片/视频/Markdown/网页图片导入、标注元素、保存/重开、tldraw 依赖清理。
- 补充需求已落地：文件管理器复选多个文件后拖入画板会传递批量 payload；画板按落点自动拼图排布，避免全部素材叠在同一点。
- 验证记录：`npm run typecheck`、`npm run verify:board`、`npm run build:dir`；真实 dev app 用 `/Users/user/实验田/测试/lib-a/pin` 的 52 张图、`lain-video.mp4`、`BV1FnE96PEGq_audiovisual_analysis.md` 批量导入，初始 54 个素材节点 `overlaps=0`，保存后在 Ready 内重开可加载 52 张图、1 个视频和 Markdown 正文。
