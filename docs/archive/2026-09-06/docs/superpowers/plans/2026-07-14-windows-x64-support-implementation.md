---
title: Ready Windows x64 支持方案与执行计划
date: 2026-07-14
last_verified: 2026-07-15
status: awaiting-user-decision
enforce: false
target_platform: windows-x64
source_branch: feature/skill-envelope-floors
source_head: 72527eba58b02806d0b973cf2ad5eeea862fe832
source_worktree: stale-candidate-archived
handoff_candidate_status: archived-outside-workspace
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Ready Windows x64 支持方案与执行计划

> 创建时间：2026-07-14
> 最近复核：2026-07-15；原源码候选包已证明与当前工作树漂移且含退役打包脚本，已移出活跃项目并仅作历史归档。
> 状态：范围待用户一次确认；确认并回写 §0.1 前不得交给 Windows 执行 agent。
> 前置调研：本文所有“现状”结论均已在 2026-07-15 对上述分支、当前工作树、打包配置、运行时矩阵、二进制格式和平台敏感调用重新核对；命令输出与 `file:line` 共同作为证据，不继承旧文档的通过结论。
> 定位：`docs/platform/windows-development.md` 继续负责日常源码交接与回传规则；本文负责把当前主线补成可发布的 Windows x64 产品。`docs/archive/2026-09-06/docs/superpowers/plans/2026-06-16-windows-sync-handoff.md` 已是 `enforce: false` 的历史快照，不得作为实现基线。

## 0. 目标、假设与完成标准

### 0.1 用户待确认范围（一次确认即可）

用户只指定了“Windows”，没有指定系统下限、安装形态、离线要求、体积、签名条件或真机来源。为避免后续执行 agent 猜测，本文给出一组**建议默认值**；它们不是已获用户确认的产品决定。用户一次确认后，把本节改成“已确认范围”、将 frontmatter 改为 `status: pending`、`enforce: true`，执行 agent 此后不得自行变更。

1. **系统/架构建议**：首轮交付与验收只承诺 **Windows 11 x64**，证据记录精确 Windows build；Windows 10、ARM64 和 ia32 不在本轮验证面。不得仅为排除 Windows 10 添加人为启动拦截；最低系统要求最终以依赖支持范围和真机结果为准。
2. **分发形态建议**：正式产物为 **x64、按用户安装、不要求管理员权限的 NSIS 薄安装包**；`win-unpacked` 只用于调试和自动冒烟。选择 NSIS 是因为当前 `electron-updater` 已读取 `app-update.yml`，仓库诊断文档也明确 Windows 应走 `win/nsis`，这条路径能复用现有自动更新主链；不是为引入第二套安装器。
3. **联网/离线建议**：薄安装包不内置 Python、FFmpeg 或完整 AI runtime；继续使用现有首次使用时下载并校验的模式，不承诺完全离线安装后立即使用全部技能。
4. **文件系统建议**：首版支持本机盘符路径；原始 UNC 路径（`\\server\share\...`）、跨系统工作区迁移和网络共享不在承诺面，必须在入口明确拒绝，不能静默改成错误路径。映射盘可被系统表现为盘符，但本轮不宣称共享盘锁、时钟和断线恢复已通过。
5. **网页引擎建议**：Windows 使用 Electron 自带 Chromium，不引入 WebView2、Tauri origin 或固定 WebView2 runtime。
6. **签名建议**：正式公开包必须签名；拿不到组织代码签名证书时，只能产出明确标注为“内部验收、未签名”的包，不能对外发布。
7. **体积建议**：安装包失败线为 350 MiB，`win-unpacked` 失败线为 1 GiB，两项分别测量。依据是 `du -sm exports/Ready-0.6.1-arm64.dmg exports/mac-arm64/Ready.app` 实测当前同版本 Mac 安装包 235 MiB、解包应用 864 MiB，并给 Windows 平台文件留出余量；若首个干净 Windows 基线证明平台必需字节超过预算，先把清单与理由交给用户改计划，不能由执行 agent 静默抬高。
8. **真机建议**：最终至少有一台 Windows 11 x64 真机或隔离虚拟机可安装、升级和卸载；GitHub runner 不能替代桌面行为验收。若当前没有，W1/W2 可以先做，W3/W4 保持未完成。
9. **源码建议**：2026-07-15 的 `Pack-source/` 与 `Pack-source.zip` 候选包已作废：它含退役的本机配置打包脚本，ZIP 还有大量 `__MACOSX` 冗余，且实际为 232,909,147 bytes、SHA-256 `801e3ba2055fc38e17ec5daced0815ed4be6358df818bf53e741905da282ee2b`，与旧记录不符。它已移到项目外 `/Users/user/实验田/ready-cowork-archives/2026-07-15-stale-pack-source/`，只作历史取证，不得用于 Windows 开工。W0 必须在用户确认范围和源码边界后按当前源码重新生成最终交接包。
10. **安全硬约束（无需产品取舍）**：标准 Windows 包永远不携带 `ai-settings.seed.json`、`.env`、provider key、外部服务凭据、Cookie 或 OAuth token；会从本机设置导出凭据的 `build:dist:seeded` 入口已退役并删除，受控内置配置只能走 Packer。

用户只需一次回复是否接受上述建议；若不接受，只需同时给出要变更的系统/架构、安装形态、离线要求、体积、签名或真机条件。未确认前本文是完成的调研方案，但不是可开工合同。

### 0.2 当前基线

| 领域 | 当前事实 | 结论 |
| --- | --- | --- |
| 产品版本 | `package.json:3,216,266-280`：Ready 0.6.1、Electron 42.3.0、better-sqlite3 12.10.0、Node `>=20` | 以当前主线为唯一源码起点 |
| 历史源码候选 | 原候选包的实际字节数/哈希与文档记录不符，并含已退役脚本 | 已移出活跃工作区；不能作为 Windows 基线，W0 必须重建 |
| Windows CI | `.github/workflows/ready-windows-packaged-smoke.yml:17-54` 已在 `windows-latest` 执行 `npm ci`、build、`--win --dir` 和 DOM 冒烟 | 不是从零移植，但只证明解包版能启动 |
| 正式打包 | `electron-builder.yml:77-93` 只有 macOS arm64 的 DMG/ZIP/dir，没有 `win`/NSIS 发行合同 | 正式 Windows 安装包尚不存在 |
| 原生依赖 | `file node_modules/electron/dist/Electron.app/Contents/MacOS/Electron node_modules/better-sqlite3/build/Release/better_sqlite3.node` 分别返回 `Mach-O 64-bit executable arm64` / `Mach-O 64-bit bundle arm64`；`package.json:12-22` 已有 Electron ABI 重建与真实加载检查 | Windows 必须本机 `npm ci` 和重编，绝不复制 Mac 产物 |
| 薄 runtime | `src/shared/runtime-asset-registry.ts:13,48-52,105-164` 已有 `win32-x64` Python 与 FFmpeg 坐标 | 复用平台矩阵，不另造 runtime 合同 |
| 本机设置种子 | `electron-builder.yml:43-45` 仍声明 seed 资源；`build:dist` 已增加默认空 seed 门禁，会导出本机凭据的旧入口已删除 | Mac 标准发布的误内置边界已收口；Windows 公开包仍须证明该资源完全缺席 |
| 历史 Windows 证据 | 旧 smoke 基于 Electron 34，距当前主线数百次提交；旧 handoff 绑定 `a0e0084d...` | 只能参考历史意图，不能继承“已通过”结论 |
| 复核漂移 | 本计划首次提交 `c5523332e` 到当前 HEAD 相隔 5 次提交、涉及 92 个 tracked 文件；构建配置、Windows workflow 和 runtime 矩阵重新核对后分类未变。当前未提交切片新增的唯一平台交互形态是任务卡标准 Pointer Events（`TaskCard.tsx:345-380`），没有新增 `win32`、shell、原生二进制或 OS 路径分支 | 方案继续有效；Pointer Events 进入 W3 的真实 Windows 鼠标/触屏拖拽抽测，精密触控板双指横滑单列实验，不另造平台分支 |
| 当前工作树 | 活跃项目根目录已不再包含 `Pack-source/` 或 `Pack-source.zip`；业务改动仍须在 W0 时重新盘点 | W0 重新记录最终清单；执行时不得顺手纳入、覆盖或清理未确认的用户改动 |

### 0.3 交付目标

从用户确认的当前源码生成一个可安装、可升级、可卸载、可持续验证的 Windows 11 x64 NSIS 薄安装包。Browser、Document、RSS、Calendar、Agent、技能、文件预览与本地持久化保持与现行产品同一合同；只允许本文明确写出的平台限制。

### 0.4 完成标准

以下十二项必须全部满足，少一项都不能把计划标成完成：

1. **源码一致**：Windows 本地 `git rev-parse HEAD` 与交接清单一致；旧 `ready-win` 快照、Mac `node_modules`、产物、缓存、seed、用户数据和密钥均未混入。
2. **依赖与全套测试**：Windows 上 `npm ci`、`npm run verify:native`、`npm run typecheck`、`npm test`、`npm run build` 全部退出 0；不能用 skip、改弱断言或删除测试换绿。
3. **Windows 专项红→绿**：本计划每个 P0 反例先在修复前于 Windows 复现失败，修复后通过；专项报告中 skipped 数为 0。
4. **解包版真实可用**：`npm run build:win:dir` 成功，`Ready.exe` 启动后 `/workbench` 可交互；本地 SQLite 创建、写入、重启 readback 成功。
5. **包体纯净**：`npm run verify:windows-package` 证明 `win-unpacked` 与安装后的产品载荷中，`Ready.exe`、DLL、NODE 和下载 runtime 的 EXE 均为 PE x64，且没有 Mach-O、ELF、ia32/ARM64 native、`__pycache__`、`.pyc`、`test_extension.node`、`react-grid-layout/ip_fetcher*`、`yarn-error.log`、重复 better-sqlite3、`ai-settings.seed.json`、`.env`、私钥或非空凭据；安装包与解包目录分别在预算内。NSIS 外层引导程序和卸载器不套用产品载荷的 x64 文件头断言，改由签名、版本元数据、安装行为和安装后载荷检查证明正确。
6. **进程全退**：正常退出、任务超时、用户取消和 Main 强制终止四种情况下，带本轮唯一 token 的 Python、Node、RSSHub 和 Chromium 子孙进程最终均为 0；崩溃后下一次启动的 boot reaper 也能完成兜底清理。
7. **路径安全**：盘符路径中的空格、中文、`#` 可打开、拖入、保存和预览；只拒绝把整个用户主目录、Documents、Desktop 本身或盘符根选作 workspace root，其中普通文件和深层项目必须可用；UNC 被明确提示不支持；视频 Range 请求返回 206 并可拖动进度。
8. **技能闭环**：Windows 原生命令合同、Let's Go RSS 跨进程锁、VEA SVG→PNG、Python sidecar 父进程监控和运行时首次下载均通过目标机行为测试。
9. **窗口合同**：右上角原生最小化/最大化/关闭可用；拖动、双击最大化、Aero Snap、系统菜单、100%/150% 缩放正常；Ready 点在 Windows 左上角且中心 X 为 25 px；不使用 `frame: false`。
10. **真实功能面**：BrowserView 覆盖关系、Document、RSS、Calendar、Agent、设置、附件、图片和媒体矩阵在真实 Windows 11 x64 上留有截图或结构化记录。
11. **正式安装与更新**：签名 NSIS 安装、覆盖升级、自动更新下载/安装、卸载和用户数据保留均通过；`latest.yml`、blockmap、安装包签名和版本一致。
12. **文档与证据**：更新受影响的当前权威文档，记录起止提交、命令、包路径、哈希、签名、体积、真机型号/系统版本、失败修复与已知限制。真实 Windows 11 x64 终验是现有 Mac 无法 100% 替代的唯一最终验证，因为窗口管理、文件锁、进程树、媒体解码和签名安装均由目标系统决定。

## 1. 第一性原理：Windows 的物理差异源

### 1.1 判型：不是从零移植，而是补齐发行矩阵

| 层 | 当前实测 | 分类 | 决策 |
| --- | --- | --- | --- |
| 构建/发行 | `.github/workflows/ready-windows-packaged-smoke.yml:17-54` 已有 Windows runner、Windows 依赖安装、解包构建和启动冒烟；`electron-builder.yml:81-96` 仍只有 macOS target | C 打包矩阵 | 沿用现有 Windows 构建列，补 NSIS、包体纯度、签名与更新合同；不另建第二套构建系统 |
| 下载 runtime | `runtime-asset-registry.ts:13,48-52,115-140` 已有 `win32-x64` Python 与 FFmpeg source；`runtime-provisioner.ts:265-283` 把平台 source 归一到 `runtimeRoot/bin/(ffmpeg|ffprobe)[.exe]` | A 架构产物 + C 平台数据行 | 复用既有平台键和架构中立目的路径；只固定字节、补 PE x64 断言和 Windows 放置语义，所有技能侧命令名与环境合同不改 |
| Electron/native addon | 当前 Electron 与 `better_sqlite3.node` 在 Mac 实测为 arm64 Mach-O；`package.json:12-22` 已有 Electron ABI 重建与真实加载 gate | A 架构产物 | Windows 本机 `npm ci` + rebuild 生成 PE x64；禁止复制 Mac `node_modules`，无需修改数据库 API |
| 应用源码与静态资源 | tracked Rust/Swift/C++ 壳源码均为 0；Renderer/Main 由 TypeScript/JavaScript 构建，Python sidecar 以源码分发 | D 已验证安全区，另有 B 语义风险 | 字节本身不用“移植”；只处理 §3 已由 Windows 物理差异命中的路径、进程、锁、媒体和窗口语义 |
| Windows FFmpeg | `runtime-asset-registry.ts:119-138` 明确使用 rolling `latest`，当前哈希会随上游字节变化而失效 | A 外部阻塞项 | Day 0 第一时间固化并审计同一份 Win64 字节；未固定前 gate 响亮失败，但不阻塞 Mac 上的 W1 |
| RSSHub 浏览器 | `rsshub-process.ts:79,188-268,301-329` 会依次使用显式路径、缓存、系统 Chrome/Edge，最后下载固定 build `136.0.7103.49` | A 外部/下载产物 + E 待实测 | 系统浏览器不进入包体纯度统计；Ready 管理下载的 Chrome 必须登记 build、来源与 PE 架构，并在干净 Windows 上分别验证系统 Edge 和自动下载两条路径 |
| Python 技能依赖 | VEA/视频分析 requirements 含 torch、torchaudio、opencv、onnxruntime 等范围版本；仓库没有一份已在 Windows 锁定并实跑的 wheel 清单 | A 下载产物 + E 待实测 | 不把 Mac import 结果外推到 Windows；目标机记录解析出的精确版本，检查 `.pyd/.dll` 架构并跑真实导入/代表性产物，失败则先锁依赖而不是加平台 skip |

结论：Ready 已经有 Windows 构建入口和 `win32-x64` runtime 行，不需要重造运行时架构。真正工作量是**补一个发行矩阵列、重建目标平台原生字节、修正已实锤的平台语义**；由于 runtime 的 source 已归一到架构中立目的路径，技能命令名、HTTP/IPC 路由和运行时环境变量合同保持不变。

### 1.2 四个物理差异源

| 物理差异源 | 命中的 Ready 链路 | 需要闭合的语义 |
| --- | --- | --- |
| 文件系统 | 工作区安全、绝对路径、拖放 URI、本地文件协议、原子替换、文件名、长路径 | `C:\...` 不是 POSIX 路径；反斜杠、盘符、大小写、被占用文件和 DOS 设备名必须按 Windows 语义处理 |
| 进程与命令 | Agent shell primitive、setup、Python sidecar、RSSHub/Chromium、超时/取消、boot reaper、Python 文件锁 | Windows 没有 POSIX 负 PID 进程组、`SIGTERM` 语义、`bash` 和 `fcntl`；必须有一个共享进程树合同和原生命令/锁实现 |
| Chromium 与桌面窗口 | BrowserWindow 标题栏、原生按钮、BrowserView、GPU、字体/IME、音视频播放 | Electron 自带 Chromium，故 WebView2 不相关；但系统窗口管理、字体、输入法、GPU 和编解码能力仍需真机验证 |
| 发行载体与架构字节 | Electron EXE/DLL、better-sqlite3、可选 native 包、运行时下载、ICO、NSIS、签名和更新 | 每个产品载荷 native 文件都必须是 PE x64；NSIS 外层容器单独验签与安装行为；安装、升级和包体纯度都是产品正确性的一部分 |

凡是不落在这四个来源里的担心，都必须先查 §2；已经有证据的安全区禁止重复建设或“顺手加固”。

## 2. 已验证安全区（防御性改造禁区）

| 领域 | 结论 | 证据 |
| --- | --- | --- |
| Renderer origin | 开发期用 `ELECTRON_RENDERER_URL`，打包后 `loadFile(index.html)`；没有 Tauri origin 依赖 | `src/main/index.ts:410-423`；目标字符串检索零命中 |
| Web 引擎 | Ready 使用 Electron 42.3 自带 Chromium，不需要 WebView2 安装或预检 | `package.json:266-267`；仓库 `WebView2` 目标检索零命中 |
| 平台探测 | Renderer 不靠 UA；Preload 已暴露 `process.platform` | `src/preload/index.ts:1484-1487`；`navigator.platform/userAgent` 行为检索零命中 |
| 安全边界 | 主窗口与浏览内容继续使用 `contextIsolation: true`、`nodeIntegration: false` | `src/main/index.ts:466-481`；`src/main/modules/browser-engine/host-layout-service.ts:26-39` |
| SQLite 重建 | 已有补丁、electron-builder rebuild 和真实 Electron ABI 加载/查询 gate | `package.json:12-22,34`；`scripts/check-better-sqlite3-electron-abi.cjs:11-63` |
| runtime 平台矩阵 | Windows x64 Python、FFmpeg/ffprobe、`.exe`、`Scripts` 和 PATH 分隔符已有明确结构 | `src/shared/runtime-asset-registry.ts:105-164`；`src/main/modules/skills-runtime/packaged-runtime.ts:39-63`；`src/main/modules/skills-runtime/python-runtime-provisioner.ts:303-328` |
| UTF-8 与 Python argv | Python 环境已显式 UTF-8；生产 Python 子进程基本使用 argv，不依赖 `shell=True` | `python-runtime-provisioner.ts:303-328`；生产脚本检索 |
| 路径沙箱 | 通用本地路径安全 helper 已处理反斜杠和 Windows 大小写；skill path sandbox 使用 Node 标准绝对路径判断 | `src/main/modules/app-control/local-path-safety.ts:17-30`；`src/main/modules/tools/skill-primitives/path-sandbox.ts` |
| 正常退出编排 | before-quit 已等待各模块清理；缺口是 Windows 树终止和崩溃兜底，不是重写整个退出流程 | `src/main/index.ts:1177-1226`；`src/main/modules/process-cleanup/before-quit.ts:88-137` |
| 非 Mac 材料 | Windows/Linux 已有不透明背景，Mica 调用失败会回退 | `src/main/modules/window-material/main-window-material.ts:67-80,121-129` |
| 图标 | `build/icon.ico` 是有效的多尺寸 Windows ICO | `file build/icon.ico` 实测 |
| 打包冒烟 | 现有脚本已能找到 `win-unpacked/Ready.exe`、用隔离 userData 启动、检查 DOM，并用 `taskkill /T /F` 收尾 | `scripts/run-packaged-smoke.cjs:43-49,202-317` |
| 产品数据 | 绝对路径存入本机 localStorage/SQLite 本身不是 bug；首版使用全新 Windows userData，不迁移 Mac 数据 | `src/renderer/stores/useWorkspace.ts:760-820`；`src/main/modules/migrations.ts:1476-1496` |
| 原生壳 | 仓库没有 Rust/Swift/C++ 壳层源码；平台敏感面集中在 Electron/Node/Python | tracked `*.rs` 为 0；不要新增原生壳项目 |
| Python 常规调用 | 生产 Python 中 `O_EXCL|msvcrt|shell=True|killpg|setsid|preexec_fn` 当前零命中；`split(':')` 命中仅为时间码；受管环境已显式 UTF-8 | 本轮 grep；`python-runtime-provisioner.ts:303-328`；不要批量重写所有 `open()`/`subprocess` |
| 唯一名图片落盘 | 图片生成以 UUID 新文件为目标，不存在覆盖已打开目标的 rename 语义 | `image-generation-service.ts:256-266`；不要把 D11 的覆盖重试机械扩散到这条链 |

## 3. 差异与风险清单

分级固定如下：

- **P0**：不闭合就不能把包交给用户。
- **P1**：公开发布前闭合，或按本文已经做出的决定记录为明确限制。
- **P2**：终验时一并覆盖，不单独扩成重构项目。

所有新增测试遵守同一纪律：**修复前在 Windows 红，修复后绿**。一直绿、仅 source grep、跳过或只在 Mac 跑，都不算证明差异已闭合。

### 3.1 P0

#### D1 当前源码与历史快照漂移

- **位置**：本文 frontmatter/§0.2；`docs/platform/windows-development.md:1-35`；`docs/archive/2026-09-06/docs/superpowers/plans/2026-06-16-windows-sync-handoff.md:1-48`。
- **差异实锤**：旧 handoff 是 `enforce: false`，绑定旧目录、旧分支和 `a0e0084d...`；`git rev-list --count a0e0084d..HEAD` 在本轮返回 304。当前 HEAD 为 `72527eba...`，并有 45 项未提交业务改动。刚生成的候选 ZIP 已通过完整性检查，但它生成在本文复核写回之前，也没有得到用户对 dirty tree 边界的确认。
- **最小修复**：只从用户确认的 `HEAD + 明确列出的未提交切片` 开始；本文复核完成且范围确认后重新运行 `pack-source --zip`，Windows 本地校验提交、文件清单、ZIP SHA-256 和排除项。禁止在旧 `ready-win` 上追补，也禁止仅因当前候选包已经存在就跳过基线确认。
- **验证**：Mac 交接记录与 Windows intake 的 HEAD、文件数、SHA-256、未提交清单和排除项逐项相同；任何一项不一致立即失败。

#### D2 共享打包配置仍声明设置种子资源

- **位置**：`electron-builder.yml:43-45`；`scripts/check-ai-seed-release-safety.cjs`；`src/main/modules/settings-engine/seed-loader.ts:17-19`。
- **差异实锤**：builder 对所有平台复制 `build/runtime-seeds/ai-settings.seed.json`。现在标准 `build:dist` 会先验证 seed 必须是空对象，坏 JSON 或非空内容会立即失败；只有受控 Packer 可以显式授权内置配置。Windows 公开包仍必须在包体 gate 中要求该资源完全缺席。禁止在日志、文档或报告中显示具体值。
- **最小修复**：
  1. 立即轮换当前 seed 所代表的全部 provider/外部服务凭据；检查这些本地包是否曾上传，若上传则撤下并按已泄露处理。凭据轮换是用户/组织动作，功能开发不能代做或跳过。
  2. 从共享 `electron-builder.yml` 的标准 `extraResources` 删除该 seed；标准 Mac/Windows build 都不得依赖本机忽略文件。
  3. 继续保持已退役的 `build:dist:seeded`、`export-ai-settings-seed.mjs` 不得恢复；受控内置配置只能由 Packer 临时写入、验证并恢复，不用“清空几个已知字段”冒充安全。
  4. package gate 同时检查解包目录和 `app.asar` 文件清单：对 `ai-settings.seed.json`、`.env*`、私钥/证书私钥、Cookie/token 数据库等敏感文件名无条件拒绝；只对 JSON/YAML/SQLite 等候选配置文件解析已知凭据字段是否非空，不扫描普通打包 JS 或测试 fixture 中出现的字段名。检查输出只能报路径与字段名，绝不打印值。
  5. 轮换完成后再删除/隔离本机旧 seed 与由它生成的污染产物；本计划不授权自动删除用户文件。
- **验证**：标准 Mac/Windows 包均找不到 seed；构造只含假凭据的 fixture 时 gate 必须红；清理后绿；release 记录只写“轮换完成”和负责人，不写 secret。

#### D3 正式 Windows 打包与二进制纯度缺失

- **位置**：`electron-builder.yml:11-109`；`.github/workflows/ready-windows-packaged-smoke.yml:41-54`。
- **差异实锤**：builder 只有 macOS 发行配置；广泛复制 `node_modules/**/*`。现有 Mac 包已能带入其他平台预编译、`react-grid-layout/ip_fetcher`、Python cache 和重复 better-sqlite3，说明“能打包”不等于“目标字节纯净”。
- **最小修复**：
  1. `electron-builder.yml` 增加 `win`：NSIS、x64、`build/icon.ico`、`requestedExecutionLevel: asInvoker`、产物名 `Ready-${version}-win-x64-setup.exe`；`nsis` 固定 `oneClick: true`、`perMachine: false`、`packElevateHelper: false`、`buildUniversalInstaller: false`、`deleteAppDataOnUninstall: false`，即只生成 x64 产品载荷、按用户安装、无提权 helper，并保留 userData。
  2. `package.json` 增加 `build:win:dir`、`build:win`、`verify:windows-package`，都显式 `--publish never`；发布上传是独立步骤。
  3. 在 `win.files` 中先排除 `node_modules/**/prebuilds/**`，再只放回 `node_modules/**/prebuilds/win32-x64/**`；同时排除 `react-grid-layout/ip_fetcher*`、`yarn-error.log` 和 `better-sqlite3/build/Release/test_extension.node`。`electron-builder.yml:51-80` 已经完成 embedded-skills、sidecar 的 `__pycache__` 与 `.py[co]` 过滤，执行 agent 只保留并验证，不得重复实现。不得在 `afterPack` 后解包/重打 `app.asar`，`scripts/post-build.cjs` 的现有 Mac 签名职责不变。
  4. 新增 `scripts/check-windows-package.cjs --input <path> --mode dir|installed|nsis`。`dir/installed` 模式读取文件头而非调用 Windows 默认不存在的 `file`：`Ready.exe`、DLL、NODE 和 Ready 管理下载的 runtime EXE 的 PE Machine 必须为 `0x8664`，并拒绝 Mach-O、ELF、其他 PE 架构和禁止文件。扫描必须覆盖 `app.asar` 清单、`app.asar.unpacked`、resources 与安装后目录，不能只维护几个已知包名；WebAssembly 魔数单独识别，不能把 QuickJS WASM 扩展因 `.so` 后缀误删。`nsis` 模式不武断要求外层引导程序是 x64；它检查签名、产品名、版本、发布者、更新元数据、可安装性，以及安装后载荷能否通过 `installed` 模式。
  5. secret gate 无条件拒绝敏感文件名，只对候选配置文件解析非空敏感值，避免把打包后的普通 JS 字段名或测试代码误报为凭据；输出只能包含路径与字段名，不能显示值。
  6. 每次 build 使用按版本和模式隔离的干净输出目录；gate 断言当前版本的安装包恰好一份，禁止按修改时间选“最新”而误拿旧产物。安装包与 `win-unpacked` 分别测量、分别判预算。
  7. 删除 `electron-builder.yml:46-50` 的 better-sqlite3 额外副本前，先用打包后真实 SQLite readback 证明 `app.asar.unpacked` 是唯一所需位置。
- **验证**：解包目录、安装后的载荷与 NSIS 分别跑对应 package gate；Windows `Ready.exe` 启动后建表、写入、重启读取；Mac `build:dir` 仍通过，证明清理没有破坏现有产物。

#### D4 native 与下载 runtime 仍有发行级缺口

- **位置**：`src/shared/runtime-asset-registry.ts:115-140`；`src/main/modules/skills-runtime/runtime-provisioner-io.ts:76-153`；`runtime-provisioner.ts:225-284`；`src/main/modules/rss-engine/rsshub-process.ts:79,188-268,301-329`。
- **差异实锤**：Python 坐标已固定；Windows FFmpeg 使用会滚动的 `latest` URL，注释已明确哈希会失效。下载后架构探针只在 macOS 强校验，Windows 只证明程序可能启动；rename 在 Windows 被占用时也可能失败。RSSHub 还会复用缓存/系统 Chrome 或下载固定 build 的 Chrome，这个目标平台二进制此前没有进入资产清单和真机门禁。
- **最小修复**：
  1. Day 0 把 registry 当前指向的 FFmpeg 候选下载到隔离目录，只处理这一份字节：先核对实际 SHA-256，再审计 ZIP 条目没有绝对路径、`..` 穿越或意外布局，并检查其中所有 EXE/DLL 的 PE 架构为 x64。审计通过后把**同一份字节**上传到 Ready release 仓库的不可变 tag `runtime-ffmpeg-win64-20260714`，registry 改为该固定 URL、固定文件名、固定 SHA-256 和版本名；不得在审计与上传之间重新下载 `latest`。上传未完成时 registry gate 必须响亮失败。
  2. 给 `pbsArchive` 的 Python output 也写入 `expectedArch`（Windows 为 `x64`，两条 Mac 记录保持各自真实架构）。新增可复用的 PE header x64 检查；`probeRuntimeBinary` 必须在 Python/FFmpeg/ffprobe 的版本或 SSL 分支提前返回之前先验架构，下载 runtime 与打包 native gate 共用同一实现，禁止只靠“程序能启动”。
  3. Windows 解压继续用系统 `tar.exe`，但 provision 开始前先探测；缺失时给明确系统要求，不引入 7-Zip/ImageMagick 等隐式依赖。
  4. runtime 放置只对 `EPERM/EACCES/EBUSY` 做 5 次、100→1600 ms 的有界退避；耗尽保留临时文件并报告，不吞错。
  5. RSSHub 将系统浏览器与 Ready 管理下载的浏览器分开记账：系统 Chrome/Edge 只验证存在、可启动和实际版本，不纳入 Ready 包体；缓存/下载分支必须绑定 build `136.0.7103.49`、验证可执行文件为 PE x64，并在状态页明确显示来源。错误架构、损坏缓存或下载不可用时清晰失败，不静默退回无浏览器状态。
  6. 首次安装 Python 技能依赖后输出精确版本锁定记录，并遍历 `.pyd/.dll` 验证 PE x64；torch、torchaudio、opencv 与 onnxruntime 至少各做一次 import，VEA/视频分析各做一个最小真实产物。不能从依赖名或 pip 成功退出推断 wheel 可用。
- **验证**：ZIP 穿越/错误布局、篡改哈希、错误 Python PE arch、错误 FFmpeg PE arch、缺 `tar.exe`、前四次 rename 失败第五次成功、持续失败七类测试红→绿；真机完成 Python/FFmpeg 首次下载、关键 wheel 架构/import 和技能调用，并在两台干净环境或两个 VM 快照分别证明“系统 Edge”与“空缓存自动下载 Chrome”路径。

#### D5 Windows 进程树与崩溃回收不闭合

- **位置**：`src/main/modules/process-cleanup/spawn-with-tree-kill.ts:14-24,139-154,316-332`；`src/main/modules/process-cleanup/boot-reaper-core.ts:11-17,43-48`；`src/main/modules/tools/skill-primitives/run-shell.ts:399-445`；`src/main/modules/tools/builtins/run-setup-command.ts:241-289`；`src/main/modules/rss-engine/rsshub-process-cleanup.ts:1-25`；`src/main/modules/rss-engine/rsshub-worker.mjs:12-33`；`src/python/ready_sidecar/main.py:23-64,599-605`；`src/main/modules/mcp/client.ts:94-97,236-253`；`src/main/modules/skills-runtime/model-pack-manager.ts:158-159,214-225`；`src/main/modules/agent-control/sidecar-manager.ts:126-203`；`src/main/modules/claude-bridge/agent-manager.ts:455-465,571-588,638,729-742`。
- **差异实锤**：Unix 用独立进程组和负 PID；Windows 多处只 `child.kill()`。boot reaper 和 sidecar 父进程监控直接跳过 Windows，RSS 注释却错误声称 boot reaper 会兜底。MCP stdio server、模型包下载、Agent sidecar 与 claude bridge 也各自 spawn/单杀，旧计划只列了前几条入口，不能证明所有 live owner 已闭合。
- **最小修复**：
  1. 以现有 `spawn-with-tree-kill.ts` 为唯一进程树权威，导出共享 `terminateProcessTree()`：正常退出请求 → 有界等待 → Windows `taskkill /PID <pid> /T /F` → 等待 taskkill 完成 → 存活探针；Unix 现有组信号不变。
  2. 先生成并测试一张 live spawn owner 清单；direct action、run-shell、setup、RSSHub、Python sidecar、MCP stdio、模型包下载、Agent sidecar 与 claude bridge 全部接入同一 spawn policy 和 `terminateProcessTree()`。若某入口经调用图证明 dormant，明确写入清单而不是默默漏掉；禁止各调用点复制 `if (win32) taskkill`。
  3. 所有 Node GUI 子进程经共享 spawn policy 加 `windowsHide: true`；Python 仅在 Windows 使用 `CREATE_NO_WINDOW`。不改变 argv、cwd、env 或授权。
  4. RSS worker 在 IPC `disconnect` 时停止服务并退出；下一次启动的 Windows boot reaper 用 PowerShell CIM 只枚举命令行包含当前 Ready sidecar、RSS worker或当前 puppeteer cache 绝对路径且父进程已不存在的 PID，再按精确 PID 清树，绝不按 `python.exe`/`chrome.exe` 进程名群杀。
  5. Python sidecar 在 Windows 用标准库 `ctypes` 的 `OpenProcess(SYNCHRONIZE)` + `WaitForSingleObject` 监控父 PID；父进程消失即走已有 shutdown。
- **验证**：在 Windows 创建 wrapper→grandchild→great-grandchild 并带唯一 token，分别验证正常退出、timeout、abort、Main 强杀、崩溃后重启 reaper；每次用 `Get-CimInstance Win32_Process` 查 token，结果必须为 0。现有 `skill-direct-action-tree-kill` 的 Windows skip 必须删除。真实 GUI 运行 runtime 下载、VEA、RSS 更新和 shell 任务时全程无黑色控制台闪现。

#### D6 `skill_run_shell` 默认依赖 Bash

- **位置**：`src/main/modules/tools/skill-primitives/run-shell.ts:1-7,100-112,328-332`；`src/main/modules/tools/system-tools.ts:26-49,91-98`；现有测试 `src/__tests__/skill-primitive-run-shell.test.ts:141-175,214-230`。
- **差异实锤**：复合命令无条件走 `bash -c`，Windows 11 不承诺有 Bash；直接改成 `shell: true` 会扩大注入面并破坏现有授权合同。`system_run_openclaw` 还用 `${SHELL || '/bin/zsh'} -lc 'command -v openclaw'` 查找命令，Windows 的 `.cmd` 安装形态必然漏掉。
- **最小修复**：
  1. primitive schema 增加可选 `dialect: auto | argv | posix | cmd`。`auto` 对无操作符命令继续 argv 直启；复合命令在 Windows 走 `cmd`、其他平台走 `posix`。不做 POSIX→cmd 字符串翻译。
  2. Windows adapter 只使用经过校验的 `ComSpec`，参数固定为 `/d /s /c`，`windowsHide: true`；显式 `posix` 在 Windows 返回 `unsupported_shell_dialect`，不寻找 Git Bash/WSL。
  3. 新增 `cmd-risk-patterns.ts`：对链中每个可执行项做现有 allowlist 检查；拒绝嵌套 `cmd/powershell/pwsh/wsl/bash`、下载后执行、破坏性命令和输出目录外重定向；解析不了的语法 fail closed。
  4. 工具描述把当前主机和可用 dialect 告诉模型，错误也返回可执行的 cmd 写法；现有 Bash 审计与 Mac 行为不变。
  5. OpenClaw 发现复用已有 host-aware `getWhichCommand()`/`where` 合同并显式处理 `.cmd`；执行继续用 argv、`shell: false`、`windowsHide: true`，不把它并入通用 cmd 字符串解释器。
- **验证**：Windows 测试覆盖带空格盘符、`%VAR%`、`&&`、pipe、输出目录内重定向、外部重定向拒绝、危险命令拒绝、timeout/abort 清整树，以及 OpenClaw 的 `.exe`/`.cmd` 发现和启动；Mac 原有 POSIX 测试全过。

#### D7 两个嵌入技能仍绑定 Unix/macOS

- **位置**：`assets/embedded-skills/lets-go-rss/scripts/rss_engine.py:23-50,384-387`；`assets/embedded-skills/video-expert-analyzer/scripts/audiovisual/reporting/svg_diagram.py:123-150,357-377`；`assets/embedded-skills/video-expert-analyzer/scripts/pipeline_enhanced.py:903-955`。
- **差异实锤**：Let's Go RSS 没有 `fcntl` 时直接取消业务锁；VEA 必调用 macOS 独有 `qlmanage` 生成 PNG。Windows 上前者会并发踩写，后者必然找不到程序。
- **最小修复**：
  1. 保留 `update_lock` 单一抽象，Windows 用标准库 `msvcrt.locking(..., LK_NBLCK, 1)` 实现同样 fail-fast 锁；锁文件先确保至少 1 byte，finally 解锁。
  2. 把精确版本 `@resvg/resvg-js@2.6.2` 加入生产 `dependencies` 和 lockfile，用它替代 `qlmanage`。helper 固定为 `assets/embedded-skills/video-expert-analyzer/scripts/audiovisual/render_svg_png.mjs`；Main 把当前 Electron 可执行文件、`ELECTRON_RUN_AS_NODE=1`、helper 路径和 `createRequire()` 锚点作为显式环境传给 Python：开发态锚到仓库 `package.json`，打包态锚到 `process.resourcesPath/app.asar/package.json`。helper 只接收输入 SVG、输出 PNG 和固定宽度，不执行任意 JS。
  3. `asarUnpack` 显式加入 `node_modules/@resvg/**`；Windows staging 只保留它的 win32-x64 native，package gate 将 `.node` 纳入 PE x64 清单。Mac 也用同一 renderer，删除双实现。打包后必须用 `Ready.exe` + `ELECTRON_RUN_AS_NODE=1` 运行 helper 探针，证明模块及其 native 文件能从 `app.asar.unpacked` 真实加载。
  4. 文件名 sanitizer 同时处理大小写无关的 `CON/PRN/AUX/NUL/COM1..9/LPT1..9`、末尾点/空格和空结果。
- **验证**：两个 Python 进程争锁只能一个进入；源码态和打包态都用中英文 SVG 生成 PNG 且签名/尺寸有效；`CON`、`NUL.txt`、`COM1`、`foo.` 均产生合法稳定文件名。所有测试先在原实现 Windows 红后再改绿。

#### D8 Windows 路径安全、文档路由与文件 URL 分裂

- **位置**：`src/shared/workspace-validation.ts:95-110,166-177,212-253`；`src/main/modules/agent-control/domain-adapters/document-domain-orchestrator.ts:128-133,277-283`；`src/renderer/components/agent/ChatPanel.tsx:655-660`；`src/renderer/components/agent/chat-panel/attachments-preview/index.tsx:50-53`；`src/renderer/components/agent/chat-panel/drag-drop/use-attachment-intake.ts:205`；`src/renderer/components/agent/chat-panel/attachment-summary.ts:7`；`src/renderer/modules/agent/document-quote-navigation.ts:9`；`src/renderer/modules/agent/document-actions/execute.ts:1102`；`src/renderer/utils/dragDrop.ts:165-180`；`src/renderer/pages/modes/DocumentMode.tsx:795-812`；`src/renderer/components/ready/FilePanel.tsx:97`；`src/renderer/components/layout/fileTreeDragPayload.ts:87`；`src/renderer/utils/boardTransfer.ts:98-102`；`src/renderer/components/document/note-preview-parser.ts:504-513`；`src/main/modules/document-engine/ipc/file-io-group.ts:101-110`；`src/main/index.ts:973-995`。
- **差异实锤**：真实调用中 `C:\Users\alice\Documents` 被错误放行，UNC 被当成非绝对路径；Document 确定性编辑、聊天附件打开/定位、图片预览、设计项目 intake/摘要、文档引用跳转和测试 autosave 都用 `startsWith('/')`，盘符路径会在进入主链前被丢弃；多个 Renderer 入口会把 `C:\...` 生成无效 URL；`local-file://` 对 UNC 会丢双斜杠。
- **最小修复**：
  1. 在纯共享 `src/shared/host-file-url.ts` 同时提供 `isHostAbsolutePath` 与 `toFileUrl`/`toLocalFileUrl`，统一盘符规范化、编码、解码和支持范围；上述 Main/Renderer 生产者、消费者和入口逐个复用，删除 `startsWith('/')` 与直接字符串拼接。
  2. helper 支持 Windows 盘符、空格、中文和 `#`；原始 UNC 返回结构化 `unsupported_network_path`，不得转成 `/server/share`。
  3. `workspace-validation` 用同一分类与 `path.win32` 语义比较 home/个人目录；只拒绝把盘符根、整个 home、Documents 或 Desktop **本身**选作工作区根。Documents/Desktop 下的合法深层项目可以作为工作区，目录中的普通文件也必须能作为附件、文档或预览打开；不得把工作区根限制扩散成文件访问限制。
  4. Document adapter 改用共享 host-aware absolute path 判断，不再 `startsWith('/')`。
  5. 新增静态 gate，只禁止新增直接 `file://${encodeURI(...)}`/`local-file://${...}`；真正正确性仍由行为测试证明。
- **验证**：盘符根、home、Documents/Desktop 本身作为 workspace root 时拒绝；`C:\Users\张三\Documents\Ready Scratch` 作为 workspace root 时接受，且 `C:\Users\张三\Documents\资料 #1.png` 可作为普通文件打开；UNC 明确拒绝；同一文件从文件树、Document、附件、聊天缩略图、Browser 本地 HTML 均可用；Range 206 与 seek 行为通过。

#### D9 Windows 主窗口仍使用 macOS 标题栏参数

- **位置**：`src/main/index.ts:454-482`；`src/renderer/components/layout/TopBar.tsx:8-25`；`src/renderer/components/layout/ModeSlider.tsx:1-23`；`src/renderer/modules/workbench/chrome.ts:3-18`；`src/renderer/pages/Settings.tsx:464-471`；当前合同 `docs/architecture/current-runtime-contracts.md:15`。
- **差异实锤**：`titleBarStyle: 'hiddenInset'` 无条件用于所有平台；Ready 点仍在右侧。Settings 还硬编码 macOS traffic-light clearance 与左侧 72px。当前文档已要求 Windows 原生按钮在右、Ready 点中心 X=25、`hidden + titleBarOverlay`。
- **最小修复**：
  1. 提取可纯测的主窗口 chrome options：macOS 保持 `hiddenInset`；Windows 使用 `titleBarStyle: 'hidden'` 和高度 44 的 `titleBarOverlay`；Linux 保持普通安全配置。
  2. 主题变化时同步 overlay 背景/符号颜色；Mica 只作为现有增强，失败继续不透明背景。
  3. Windows 把 Ready 点放到左侧轨道中心 `6 + 38 / 2 = 25`，右侧给原生按钮保留点击区；drag/no-drag 区域不遮按钮。
  4. Settings 与 Workbench 复用同一平台 chrome 几何，Windows 不保留 macOS traffic-light 空白。
  5. 禁止 `frame: false` 和自绘最小化/最大化/关闭。
- **验证**：纯函数/Renderer 合同测试加真实 Windows 11 检查：三个按钮、拖动、双击、Snap、系统菜单、100%/150%、亮暗主题、全屏、BrowserView hide/show。

#### D10 Windows CI 只证明“DOM 非空”

- **位置**：`.github/workflows/ready-windows-packaged-smoke.yml:17-54`；`scripts/run-packaged-smoke.cjs:202-317`。
- **差异实锤**：现有 job 没跑全套测试、运行时、sidecar、RSSHub、文件路径、SQLite、进程树、包体纯度和 NSIS；旧通过记录基于 Electron 34。
- **最小修复**：扩展现有 workflow，不另建重复流水线：Node 20.19.1 + Python 3.11 → `npm ci` → native → typecheck → full test → Windows 专项 → win-unpacked → package gate → packaged smoke → SQLite/path/process/runtime 行为冒烟。上传 smoke、二进制清单、体积、日志和 `win-unpacked`；NSIS 只在 release/manual job 生成。
- **验证**：PR job 每次真实运行；Windows 专项 TAP/JSON 明确 `failed=0, skipped=0`。Mac merge gates 保持原样并修正其中过时的“Windows out of scope”注释。

### 3.2 P1

#### D11 Windows 文件替换会受占用影响

- **位置**：`src/main/modules/agent-control/atomic-write.ts:8-36`；`assets/embedded-skills/video-expert-analyzer/scripts/shared_io.py:1-30`；`src/main/modules/tools/file-management-runtime.ts:178-187`；`src/main/modules/tools/file-management-organize-tools.ts:421-425,494-500`；`src/main/modules/tag-forge/tag-forge-writer.ts:65-91`；`src/main/modules/board-engine/board-service.ts:373-377`。
- **差异实锤**：Node `rename` 和 Python `os.replace` 都只尝试一次；杀毒、索引器或读者短暂占用时，Windows 常返回 `EPERM/EACCES/EBUSY` 或 WinError 5/32。文件管理 plan/journal、用户选择覆盖、Tag Forge 与 Board 都是 live rename-over-existing，旧计划只列两个 helper，范围不足。
- **最小修复**：公共 Node helper 与 VEA Python helper 只对指定错误做相同的 5 次有界退避；成功后 fsync/readback；耗尽保留 temp 和原目标，返回可诊断错误。plan/journal、Tag Forge 和 Board 复用该原子替换；用户文件 `overwrite=true` 走“目标→同目录备份、源→目标、失败回滚”的有限事务，禁止先删目标。UUID 唯一名新文件等已证明不覆盖的链路留在安全区，不机械迁移全仓。
- **验证**：每个 live 写入口注入前四次失败第五次成功、永久失败保留 temp/备份、其他错误不重试；overwrite 回滚后原文件内容不变；真实 Windows 上并发读写 run state、Tag Forge、Board 与文件整理。

#### D12 原始 UNC、长路径与跨系统 workspace 文件

- **位置**：`src/shared/workspace-validation.ts`；`src/main/modules/document-engine/ipc/workspace-group.ts:74-149`；`.ready-workspace.json` 读写入口。
- **差异实锤**：现状会误解 UNC；所谓 portable workspace 实际保存绝对路径。网络共享的锁、mtime 和断线行为也没有目标机证据。
- **最小修复**：首版明确拒绝原始 UNC；Mac 路径或不存在的 Windows root 导入时要求用户重新选择，不写入失效路径。用基础目录长度 160/200 字符跑 Document、VEA 和技能输出；超过可用边界时在任务开始前给准确错误，不中途留下半成品。
- **验证**：UNC、Mac workspace、160/200 字符路径三组真机实验留记录。不得声称映射盘/共享盘已支持。

#### D13 Windows 媒体解码能力未知

- **位置**：`src/renderer/components/document/NotePreview.tsx:283-306`；`src/renderer/components/document/BoardEditor.tsx:1059-1060`；`src/renderer/components/agent/chat-panel/attachments-preview/index.tsx:153-158`；`src/renderer/components/document/MarkdownEditor.tsx:176-209`；`src/main/modules/browser-engine/fastcard-video-resolver.ts:92-122`；`src/main/modules/browser-engine/resource-sniffer.ts:455-475`。
- **差异实锤**：Document、Board、聊天附件和 Markdown 都把多种扩展直接交给 `<video>/<audio>`；生产范围检索 `canPlayType|MediaCapabilities` 为零命中。网络候选由 Main 按画质排序，但真实解码能力只在 Renderer/Chromium 可测，当前也没有跨 Preload 的 typed capability 合同。Electron 结论不能从 WebView2 或 macOS 外推。
- **最小修复**：Renderer 启动后对固定 MIME/codec 集合生成 typed capability snapshot，经现有 Browser IPC 只作为 Main 候选排序提示；无 snapshot 时保持保守默认，不把能力结果当安全授权。Document/Board/附件/Markdown 的媒体元素统一处理加载错误，显示“当前设备无法播放此编码，可在系统播放器打开”。不引入自动转码或新媒体 runtime。
- **验证**：Main 排序测试注入支持/不支持 snapshot；真实 Electron 42 Windows 测 H.264/AAC MP4、VP9 WebM、AV1、HEVC iPhone MOV、MP3、AAC、FLAC，记录可播/不可播/有声无画、seek、内存和外部打开结果；四个 UI 表面都覆盖失败提示。

#### D14 签名、升级与卸载尚无 Windows 证据

- **位置**：`electron-builder.yml:1-10`；`src/main/index.ts:816-910`。
- **差异实锤**：autoUpdater 已存在且读取 `app-update.yml`，但没有 Windows NSIS、证书、`latest.yml`、blockmap 或升级实证。
- **最小修复**：
  1. 组织提供证书后只通过 release secrets `WIN_CSC_LINK` 与 `WIN_CSC_KEY_PASSWORD` 注入，不把证书/密码写入仓库；正式命令强制 `-c.forceCodeSigning=true`，生成签名 NSIS、`latest.yml` 和 blockmap。
  2. 先用同一证书构建两个临时版本 A/B。把 B 的安装包、blockmap 和 `latest.yml` 原样放入 `test-results/update-feed/`，新增固定 fixture server `scripts/serve-windows-update-fixture.cjs` 通过本机 HTTP 提供这些文件。
  3. 只在隔离的升级测试虚拟机中安装 A，再把 A 的 `resources/app-update.yml` 指向该本机 generic feed；从 A 的真实界面/IPC 发起检查，等待 B 下载完成、退出安装并重启，最后从应用显示与 `package.json` 版本 readback 同时确认已经是 B。不得用直接运行 B 安装包冒充自动更新。
  4. 本机更新链通过后，以最终版本重新做干净签名构建，但仍用 `--publish never`。完成全部本地 package、签名、安装/卸载 gate 后，用独立脚本把**同一批字节**上传到 `ALBEDO-TABAI/ready-releases` 的 draft release；`GH_TOKEN` 只在上传阶段注入。先从远端 draft 下载并核对安装包、blockmap 和 `latest.yml` 的名称、大小与 SHA-256，全部一致后才把该 draft 改为公开 release。`electron-builder.yml` 的 `releaseType` 同步改成 `draft` 作为误用保护，禁止“先公开再检查”。
  5. 卸载默认保留 userData；重新安装后验证原数据可恢复。
- **验证**：A/B 的安装包和安装后 `Ready.exe` 均为 `Get-AuthenticodeSignature Status=Valid`，签名主体、时间戳证书和发布者一致；fixture server 日志证明 A 确实请求并下载 B 的元数据、blockmap 与安装包；最终远端三项资产 readback 一致。无证书时只允许内部未签名 QA 包。

### 3.3 P2

#### D15 路径身份与显示

- **位置**：`src/renderer/stores/useDocTabs.ts:140-149,195-217,560-575`；`src/main/modules/document-engine/pipeline/document-task-pipeline-executor.ts:2057-2066`；`src/renderer/utils/path.ts:5-7`。
- **差异实锤**：`normalizeDocTabPathKey` 已经统一反斜杠并只折叠盘符大小写，Renderer 的文件名 helper 也已跨分隔符安全，这两部分不能重复改造；但身份仍由 Renderer 字符串规范化决定，junction、真实大小写等同一文件别名可能形成重复 tab，并原样进入 localStorage。pipeline 仍直接按 `/` 取标题。
- **最小修复**：Main 在文件打开/保存边界返回 `realpath.native` 结果并作为持久身份，Renderer 只消费这份规范路径；不存在的新文件在首次成功保存后切换到 Main 回传身份。保留现有盘符/分隔符规则，不全局 lowercase。pipeline 标题改用 D8 的共享 basename helper。
- **验证**：正反斜杠、盘符大小写、junction/别名和真实文件规范路径只开一个 tab，重启后仍不重复；Document pipeline 标题只显示正确文件名。

#### D16 DPI、字体、IME 与材料细节

- **位置**：窗口材料和 Workbench chrome；无充分静态证据。
- **差异实锤**：这些行为由 Windows 桌面合成、字体回退和输入法决定，CI 无法证明。
- **最小修复**：不加平台设计分叉；在 100%/150% 缩放、中文用户名和中文输入法下修最小布局/输入问题。Mica 失败只回退现有不透明背景。
- **验证**：真机截图、输入与拖拽记录；不因追求 Mica 阻塞功能发布。

## 4. 工作分解

### W0 源码、目标机与外部资产对齐

#### 改动/操作

1. 用户先确定当前未提交文件是提交、排除还是单独说明；执行 agent 不代替用户把它们混入 Windows 基线。
2. 已归档的旧 `Pack-source.zip` 只作历史证据，不得复用。用户确认范围后，从确认的同一主线重新生成最终 source handoff，记录 HEAD、dirty 清单、文件数、字节数和 SHA-256；Windows 复制到本地短路径，例如 `C:\src\ready`，不在共享盘直接 install/build。
3. Windows 安装 Node 20.19.1、Python 3.11 与能供 node-gyp 使用的 Visual Studio Build Tools C++ 工作负载；依赖只在 Windows 本地 `npm ci`。
4. Day 0 先完成凭据轮换与污染包去向核查，再并行发起不可变 Win64 FFmpeg 资产上传和组织 Windows 代码签名证书接入。凭据轮换和 FFmpeg 固定未完成时任何新的可分发包都不得流出；证书只阻塞公开签名发布，不阻塞 W1/W2 内部验收。

凭据轮换只记录负责人、完成时间、涉及的 provider/profile 名称和污染包去向；不得记录旧值、新值或可复用 token。若无法确认某份旧包是否外流，按已经外流处理。

#### 完成门禁

```powershell
$ErrorActionPreference = 'Stop'
git status --short --branch
git rev-parse HEAD
node -v
npm -v
python --version
npm ci
npm run verify:native
```

期望：HEAD 与交接清单一致；Node 为 20.19.1，Python 为 3.11.x；native gate 退出 0；凭据轮换/污染包核查有一份不含 secret 值的签收记录。任何源码、native 或安全基线不一致都停止，不在错误快照上修或继续出包。

### W1 跨平台正确性修复（先在 Mac 开发并回归）

这些改动不是 legacy 兼容分支，而是补齐已有抽象的 Windows 一半；POSIX 行为必须由原测试证明零变化。

| 项 | 主要文件 | 改动 | 验证 |
| --- | --- | --- | --- |
| 包体合同 | `electron-builder.yml`、`package.json`、新 package gate | 标准包移除本机 seed；加 NSIS x64、`win.files`/资源过滤、PE/secret/禁止项/体积检查；不改现有 Mac post-build | 假 secret fixture + gate fixture + Mac `build:dir` 回归 |
| runtime | registry、provisioner I/O、RSSHub Chromium、新 PE helper | FFmpeg 不可变 URL、PE x64、tar preflight、rename 重试；系统 Edge/管理下载 Chrome 分账 | 纯函数与注入测试；两条浏览器路径留 W2/W3 |
| 进程树 | 共享 cleanup、spawn owner 清单、run-shell、setup、RSSHub、sidecar、MCP、模型包、boot reaper | 单一 spawn policy/终止器、父进程监控、精确 reaper | owner 清单 gate + 纯 helper；Windows 集成留 W2 |
| shell | run-shell、system-tools、primitive schema、tool description、新 cmd audit | 显式 dialect、cmd adapter、OpenClaw host-aware 发现、fail closed | argv/posix 原测试 + cmd/.cmd fixture |
| 路径 | 新 shared URL helper、workspace validator、Document adapter、所有直接 URL 入口 | 盘符正确、UNC 明确拒绝、单一编解码 | 盘符/中文/#/安全根/Range 测试 |
| 媒体 | Renderer codec snapshot、Browser IPC、四个媒体 UI 表面 | 按真实 Chromium 能力排序；失败可系统打开；不加转码 runtime | 注入 snapshot 排序测试 + Windows codec 矩阵 |
| embedded skills | RSS lock、VEA renderer/filename、Node helper、依赖与打包资源 | `msvcrt` 锁、resvg、合法文件名 | 双进程锁、PNG、文件名 fixture |
| 窗口 | Main chrome options、TopBar/ModeSlider、合同测试 | Windows overlay、原生按钮预留、左侧 Ready 点 | 纯 options/Renderer 合同；真机留 W3 |
| 原子写 | Node/Python 公共 helper、文件管理、Tag Forge、Board | 有界重试、保留 temp；用户文件覆盖有备份回滚 | 逐 live 入口注入失败红→绿 |

Mac 收尾命令：

```bash
npm run typecheck
npm test
npm run verify:native
npm run build
npm run build:dir
```

期望：全部退出 0，现有 macOS 包仍启动。W1 不需要等待 Windows 真机或签名证书。

### W2 Windows CI、行为测试与解包版

#### 新增固定命令

`package.json` 增加：

```text
build:win:dir          npm run build && node scripts/prepare-windows-output.cjs && electron-builder --config electron-builder.yml --config.directories.output=exports/windows --win --x64 --dir --publish never
build:win              npm run build && node scripts/prepare-windows-output.cjs && electron-builder --config electron-builder.yml --config.directories.output=exports/windows --win nsis --x64 --publish never
verify:windows         node scripts/run-windows-platform-tests.cjs
verify:windows-package node scripts/check-windows-package.cjs
```

`scripts/prepare-windows-output.cjs` 只允许清理仓库内专用的 `exports/windows/`，路径越界立即失败；这能隔离旧产物又不碰现有 Mac exports。`verify:windows` 必须实际运行而不是 grep：完整 spawn owner 清单的进程树、sidecar 父死、MCP/模型包取消、RSS 锁、cmd shell、OpenClaw `.cmd` 发现、workspace/path/URL、原子替换与覆盖回滚、SVG→PNG、DOS 文件名、SQLite 持久化、runtime PE 探针及 RSSHub 浏览器来源；Windows 上 skipped 数必须是 0。

#### CI 顺序

```powershell
$ErrorActionPreference = 'Stop'
npm ci
npm run verify:native
npm run typecheck
npm test
npm run verify:windows
npm run build:win:dir
npm run verify:windows-package -- --input exports\windows\win-unpacked --mode dir
node scripts/run-packaged-smoke.cjs --platform win32 --port 9335 --timeout 90000 --out test-results/windows-packaged-smoke.json
```

#### 完成门禁

- 全命令退出 0，专项 `failed=0, skipped=0`。
- `test-results/` 含 smoke、进程、路径、runtime、二进制清单、最长路径与体积报告。
- `win-unpacked` 作为 CI artifact 上传；不把它当正式发行包。
- 使用全新 `READY_USER_DATA_DIR`，SQLite 写入后重启 readback。

### W3 真实 Windows 11 x64 终验

GitHub runner 可证明构建与自动行为，不能替代以下真机项：

1. 从全新 userData 启动，逐一打开 Browser、Document、RSS、Calendar、Agent、设置；检查 BrowserView 不盖住 DOM 弹层。
2. 标题栏测试三个原生按钮、拖动、双击、Aero Snap、Alt+Space、全屏、亮暗主题、100%/150% 缩放；截图记录 Ready 点中心位置。
3. 路径矩阵：中文用户名、空格、`#`、盘符大小写、正反斜杠；只把 Documents/Desktop 本身或盘符根选作 workspace root 时拒绝，其中普通文件和深层项目必须可用；原始 UNC 显示不支持。
4. 同一大 MP4 通过 Document/Board/附件进入，验证 Range 206、seek 和内存；再跑 H.264/AAC MP4、VP9 WebM、AV1、HEVC MOV、MP3/AAC/FLAC 矩阵。
5. Runtime 设置执行 Python/FFmpeg 首次下载；关键 Python wheels 记录精确版本并通过 PE x64/import；用两个干净 VM 快照分别验证 RSSHub 复用系统 Edge 和空缓存自动下载固定 Chrome；运行视频分析、Let's Go RSS 更新和 VEA 代表性任务，确认真实产物、合法文件名、浏览器来源可见且无控制台闪现。
6. 分别做正常退出、shell timeout、用户取消、Main 强杀；用唯一 token 查询所有后代。强杀后重新启动，boot reaper 完成兜底。
7. 基础路径长度 160/200 字符跑 Document 保存、VEA 和 skill 输出；记录通过边界或准确前置错误。
8. 导入带 Mac 路径的 `.ready-workspace.json`，必须要求重新选择或明确拒绝，不能静默持久化失效路径。
9. 在 Agent 面板启动一个显式后台长任务，验证任务卡运行/终态固定、停止按钮、右上角清除，以及鼠标拖拽和触屏向右拖拽清除；纵向滚动不能被横向手势劫持。精密触控板双指横滑单独记录是否产生 pointer 或 wheel 事件：若产品要承诺该手势，先补对应行为测试；不能把现有 Pointer Events 自动宣称为触控板支持。不得新增 Windows 专用交互分支。

W3 结束时，未通过项要回 W1/W2 修复并重跑，不允许仅写进“观察到的问题”后继续发布。

### W4 NSIS、更新、签名与文档同步

#### 内部升级门禁

1. 从同一 release-candidate 提交创建两个连续的临时版本提交 A/B，只改 `package.json` 与 lockfile 的版本，并让 `npm run verify:version` 都通过；两个版本使用同一 Windows 证书签名。
2. 两次都用 `--publish never` 构建，分别隔离到 `exports/windows-update-a/` 和 `exports/windows-update-b/`。把 B 的安装包、blockmap 与 `latest.yml` 复制到干净的 `test-results/update-feed/`，运行 `node scripts/serve-windows-update-fixture.cjs --root test-results/update-feed --port 9386`。
3. 在隔离虚拟机中正常安装 A，仅在该测试机把已安装 A 的 `resources/app-update.yml` 改为 `provider: generic`、`url: http://127.0.0.1:9386`。从 A 发起真实更新检查；必须看到 B 下载、退出安装、重启，且应用界面与版本 readback 都变为 B。
4. 保存 fixture server 请求日志；它必须包含 `latest.yml`、B blockmap 和 B 安装包。直接运行 B 安装器、只检查元数据或只看下载进度都不能替代本门禁。

#### 正式发布构建

```powershell
$ErrorActionPreference = 'Stop'
$version = node -p "require('./package.json').version"
if (Test-Path Env:GH_TOKEN) { throw 'GH_TOKEN must not be present during install, test, build, or local verification' }
if (-not $env:WIN_CSC_LINK -or -not $env:WIN_CSC_KEY_PASSWORD) {
  throw 'WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD are required for the signed local build'
}
npm ci
npm run verify:native
npm run typecheck
npm test
npm run verify:windows
npm run build
node scripts/prepare-windows-output.cjs
npx electron-builder --config electron-builder.yml --config.directories.output=exports/windows --win nsis --x64 --publish never -c.forceCodeSigning=true
$installers = @(Get-ChildItem exports\windows -Filter "Ready-$version-win-x64-setup.exe")
if ($installers.Count -ne 1) { throw "Expected exactly one installer for $version" }
$installer = $installers[0]
npm run verify:windows-package -- --input $installer.FullName --mode nsis
$signature = Get-AuthenticodeSignature $installer.FullName
if ($signature.Status -ne 'Valid') { throw "Invalid installer signature: $($signature.Status)" }
Get-FileHash $installer.FullName -Algorithm SHA256
node scripts/run-windows-installer-smoke.cjs --installer $installer.FullName --output test-results/windows-installer-smoke.json
```

上面所有本地门禁退出 0 后，才进入独立的发布 step/job，并只在该 step 的环境注入 `GH_TOKEN`：

```powershell
$ErrorActionPreference = 'Stop'
$version = node -p "require('./package.json').version"
if (-not $env:GH_TOKEN) { throw 'GH_TOKEN is required only for the draft upload and release verification step' }
try {
  node scripts/publish-windows-draft-release.cjs --repo ALBEDO-TABAI/ready-releases --tag "v$version" --input exports/windows
  node scripts/verify-windows-release-assets.cjs --repo ALBEDO-TABAI/ready-releases --tag "v$version" --state draft --input exports/windows --output test-results/windows-release-draft-readback.json
  node scripts/promote-windows-release.cjs --repo ALBEDO-TABAI/ready-releases --tag "v$version" --evidence test-results/windows-release-draft-readback.json
  node scripts/verify-windows-release-assets.cjs --repo ALBEDO-TABAI/ready-releases --tag "v$version" --state published --input exports/windows --output test-results/windows-release-published-readback.json
} finally {
  Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
}
```

期望：本地签名、package gate、最终安装/卸载 smoke 与两项体积门禁先全部通过；draft 读回的安装包、blockmap、`latest.yml` 名称、大小与重新下载后的 SHA-256 都和本地一致，之后才允许公开。`publish-windows-draft-release` 必须拒绝覆盖同 tag 的非 draft release 或任何不一致资产；`promote-windows-release` 只接受本轮 draft readback 证据。公开后再读回一次；上传令牌在构建阶段明确不存在，并在发布 step 成功或失败后都被清除。

#### 安装/升级/卸载

1. 普通用户无管理员权限安装。
2. 安装后从开始菜单和桌面启动，路径/SQLite/runtime smoke 通过。
3. 安装后的 `Ready.exe` 也必须验签；其签名主体、时间戳证书与 A/B 两个升级版本一致。
4. 用上述 A/B 本机 feed 证明 `latest.yml` + blockmap 自动下载、退出安装、重启版本 readback。
5. 卸载后程序文件消失，用户数据按合同保留；重新安装可恢复同一数据。
6. 没有有效证书时终止公开发布，只保留内部 QA 产物。

#### 文档同步

- 更新 `docs/platform/windows-development.md` 的实际命令、支持系统、包路径和回传流程。
- 只有运行时硬合同发生变化时才更新 `docs/architecture/current-runtime-contracts.md`。
- 更新 `CHANGELOG.md` 与发布记录。
- 若根指引新增硬约束，同次保持 `AGENTS.md` 与 `CLAUDE.md` 正文同步；否则不要把阶段细节塞回根指引。
- 把 W3/W4 证据放到新的 audit/release 记录，不在本文堆测试流水账。

## 5. 执行顺序与依赖

```text
W0a 当前源码确认 ───────────────┐
                                ├──> W2 Windows CI/解包版 ──> W3 真机终验 ──> W4 正式发布
W1 跨平台修复（可立即在 Mac 做） ┘

W0s 凭据轮换 + 污染包核查 ─────────> 任何新的可分发包
W0b 固定 FFmpeg 资产 ───────────────> W2 runtime gate
W0c 代码签名证书 ───────────────────────────────────────────> W4 公开签名发布
```

关键认识：除 Windows 集成测试、桌面交互、签名安装和媒体实测外，所有合同、纯函数、资源坐标、包体 gate 与 Mac 回归都能先完成。目标机或证书暂时不可用不能成为 W1 停工理由。

建议提交切分：

1. `fix(windows): close host path and workspace safety contracts`
2. `fix(windows): unify process tree and native shell lifecycle`
3. `fix(windows): make embedded skill outputs portable`
4. `build(windows): add x64 package purity and CI gates`
5. `feat(windows): add native titlebar and NSIS release`
6. `docs(windows): record real-device and release evidence`

每个提交只含对应切片和测试；不可变 FFmpeg 资产与代码提交分开记录，便于审计和回滚。

## 6. 风险表

| # | 风险 | 等级 | 处置 |
| --- | --- | --- | --- |
| R1 | 本机凭据种子再次进入安装包或既有包已外流 | P0 | 立即轮换；核查/撤下污染包；标准 builder 删除 seed；package gate 只报字段名不报值 |
| R2 | 旧快照或当前 dirty tree 被误当成 Windows 基线 | P0 | W0 双端 HEAD/清单校验；用户先决定未提交文件；重新生成 handoff |
| R3 | FFmpeg `latest` 变化导致所有新用户校验失败 | P0 | Day 0 自托管不可变字节；未固定时 registry gate 响亮失败，不发残包 |
| R4 | Windows 进程竞态测试“一直绿”而误判已修 | P0 | 原实现真机红→修复后绿；用 wrapper+多代子进程和唯一 token，不接受 mock 单杀 |
| R5 | taskkill 或 reaper 误杀其他应用 | P0 | 只按已知根 PID或当前 Ready 绝对命令行+父进程不存在筛选；禁止按进程名群杀 |
| R6 | cmd adapter 扩大命令注入面 | P0 | 显式 dialect、每段 allowlist、独立风险审计、解析失败拒绝；不使用 `shell:true` |
| R7 | Windows native 混入 Mac/Linux/其他架构 | P0 | Node PE/Mach-O/ELF 文件头 gate；Windows 本机 `npm ci`；禁止复制 node_modules |
| R8 | 新 resvg native 增加一类架构产物 | P0 | 精确版本、Windows 本机安装、package PE x64 gate、Mac/Win 双平台 PNG 行为测试 |
| R9 | 原子替换重试变成无限等待或吞错 | P1 | 只重试指定错误、固定 5 次、保留 temp、总时限可断言 |
| R10 | 媒体差异比预想大 | P1 | 先真机矩阵；做明确错误和外部打开小闭环；不引入自动转码 |
| R11 | UNC/共享盘被用户误以为已支持 | P1 | 原始 UNC 入口明确拒绝；发布说明写清；映射盘不作承诺 |
| R12 | 证书交付晚 | P1 | W1-W3 照常；只产内部未签名 QA 包，不宣称公开发布完成 |
| R13 | 评估项膨胀成通用跨平台重构 | P1 | 只改本文命中的调用链；安全区禁止重复审计；真机未命中的重复 atomic helper 不顺手迁移 |
| R14 | 真机可得性不足 | P1 | 先完成 W1/W2；可发内部 beta，但未完成 §0.4 第 9-12 项时不得宣称 Windows 支持完成 |
| R15 | 包体超预算 | P1 | 用清单先删非目标 prebuild、cache、测试文件和重复 native；不先提高 350 MiB/1 GiB 预算 |
| R16 | RSSHub 浏览器链在有 Edge 的开发机通过、到干净用户机才失败 | P0 | 系统 Edge 与空缓存自动下载两条独立门禁；管理下载的 Chrome 记录 build、来源、PE 架构和启动结果 |
| R17 | Python 依赖在 Mac 可装、Windows 解析不到同版本 wheel 或混入错误架构 | P0 | 目标机记录精确锁定结果；扫描 `.pyd/.dll` PE x64；关键 import 与代表性产物都通过，不接受 pip 成功即完成 |

## 7. 明确不做

- 不在旧 `ready-win` 快照上修，不建立永久 Windows fork 或 legacy 兼容分支。
- 不复制 Mac 的 `node_modules`、`.node`、Electron、runtime、`.app`、DMG、cache、seed、密钥、ready.db 或 localStorage。
- 不恢复已退役的 `build:dist:seeded`、`export-ai-settings-seed.mjs`，不把任何本机 AI 设置种子接入 Windows/公开发布；不在日志中打印 secret 值。
- 建议范围内不验证或承诺 Windows 10、ARM64、ia32、portable、MSIX、Microsoft Store 或完全离线大包；用户若改变 §0.1，先同步调整本文合同再开工。
- 不移植 `Packer/` 的 macOS DMG UI；Windows 首版直接使用 electron-builder + NSIS。
- 不引入 WebView2、Tauri origin、Git Bash、WSL、ImageMagick、Cairo 或用户自装 shell 作为隐式依赖。
- 不用 `frame: false`，不自绘 Windows 三个系统按钮。
- 不把数据库内所有绝对路径全局改成 `/`，不批量迁移 Mac 用户状态。
- 不在首版支持原始 UNC/网络共享，不在实测前承诺 HEVC。
- 不新增自动转码 runtime，不把约 1.4 GiB 的完整 Mac runtime 塞进 Windows 包。
- 不按 `python.exe`、`node.exe` 或 `chrome.exe` 进程名群杀。
- 不删除锁、吞掉 rename/PNG 错误、放宽工作区安全规则或用平台 skip 换取测试通过。
- 不修改 Renderer、Agent、Browser、Widget 等安全区中的业务合同，除非本计划列出的真实 Windows 调用链要求。

## 8. 最终交付报告模板

执行 agent 完成后按以下固定格式交付：

```text
源码：<起始提交> -> <结束提交>
目标：Windows 11 x64 / NSIS thin installer（以用户最终确认的 §0.1 为准）
安装包：<绝对路径>
SHA-256：<hash>
签名：Valid / 内部未签名（后者不得公开发布）
大小：installer <MiB>；win-unpacked <MiB>

自动验证：
- npm ci: pass
- verify:native: pass
- typecheck: pass
- npm test: pass
- verify:windows: pass，skipped=0
- verify:windows-package: pass
- package secret scan: pass；ai-settings.seed.json=absent；credential rotation=complete
- packaged smoke: pass

真机：
- 系统/硬件：<Windows build / CPU / scaling>
- 窗口与四模式：pass
- 路径/SQLite/Range：pass
- runtime/RSS/VEA：pass
- 进程清理：pass，残留 token=0
- 媒体矩阵：<逐项结果>
- 安装/升级/卸载：pass

明确限制：原始 UNC、映射盘保证、跨 OS 用户状态、Windows ARM64、离线大包不在首版范围。
外部阻塞：<若有，只能是证书或用户/组织控制的资源；功能问题必须先修>
```
