---
title: 一键运行时配置（Python + ffmpeg + 核心依赖 自下载）实施计划
date: 2026-06-23
branch: agent-evolution/phase1
status: implemented-pending-p3
enforce: false
author: Claude (Opus 4.8)
reviewers:
  - codex (2026-06-23 只读审查，提 6 点，全部采纳；据此降回 draft 并补方案)
decisions:
  - 平台：mac(arm64+x64) + Windows(x64) 一起做
  - 下载源：GitHub 主源 + 国内镜像，按 probeEndpointLatency 探活排序；探活只排序、不硬失败（实下载尝试全失败才报错）
  - 范围：本按钮配「运行时」= Python + ffmpeg/ffprobe + VEA 核心 pip 依赖（轻、无 torch）；torch + ASR 大模型保留现有独立下载
review_log:
  - r1: 初版被 codex 审为「方向可以，但不能直接 ready-for-implementation」。6 点见 §0.7，已全部并入并降 draft。
  - r2: codex 二审 4 点（旧 venv 不重建 / 错误类型混淆 / 镜像优先级与文件名不清 / 解包护栏夸大）全部采纳，见 §0.8。
  - r3: codex 三审 3 点（源循环须试完 / venv 比对用 realpath / P1 编号 C10）全部采纳，见 §0.9。codex 结论：补完即可进 P0 脚本阶段。
  - r5（2026-06-23，P0 钉死）：**P0 已完成**——`pin-runtime-assets.mjs` 真机跑通，8 个 archive 全部填入真实 sha256（registry 0 占位）。修正：codex 写的 PBS tag/版本（20260325/3.11.14）不存在，实际是 **tag `20260610` / `3.11.15`**（GitHub API 查得）；win BtbN 大包 node fetch 反复 terminated，改用 curl 取得（167MB）。新增注册表「全 archive 已钉死」断言。真实 IO 烟测通过（`downloadRuntimeArchive`→sha 匹配→`extractRuntimeArchive` 守卫解包→解释器就位）。**⚠️ 遗留：win BtbN `latest` 是滚动 nightly，sha 会过期**，Windows 派发前需重钉或改 dated tag/自建镜像（mac osxexperts + python 是版本化文件名/tag，稳定）。**P3（干净 mac/win 真机 + venv/pip + 首次 VEA 真跑）仍未做。**
  - r4（2026-06-23，实现）：**P1+P2 已实现并提交**（commit `feat(skill-runtime): one-click runtime provisioning`）。文件见 §0.10。16 个行为测试（mock 下载器）+ web/node typecheck 全过。codex 对抗审查 FIX-FIRST→修复→**SHIP**：① 下载体积超限归类 integrity（非 unreachable）；② venv/依赖失败包成结构化 `runtime_setup_failed`。Claude 自审另修：tar 护栏的元数据前缀漏洞（改用 `tar -tf` 干净名做 abs/`..`，`tar -tvf` 仅取 symlink 目标）+ xattr 去隔离的 stale-path 竞态（改 rename 后同步执行）。P0 后续已由 r5 完成；当前只剩 P3 干净 mac/win 真机验收。
gate_before_ready: P0 已完成，注册表 gate 校验真实 64-hex sha256 并拒绝未钉死哨兵值；对外声称跨平台完全就绪前，仍必须完成 P3 干净 mac/win 真机验收。
goal: 让安装包保持瘦壳（几十 MB），用户在「设置 › 模型与运行时」点一个按钮即自下载并配好 Python + ffmpeg + 技能核心依赖，使首次跑（在线）视频分析不再卡在环境/依赖下载上；无需预装系统 Python/homebrew。
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：代码/检查引用：src/main/modules/skills-runtime/ipc-handler.ts, src/main/modules/skills-runtime/runtime-manager.ts。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# 一键运行时配置 — 实施与验收计划

> 合同先行（CLAUDE.md §0.5）。本文给：契约 → 数据模型 → IPC 面 → 下载器 → 平台矩阵 → UI → 测试/gate → 分期 → 不可在本机验证项。
> **当前状态**：P0 真实资产钉死、P1 主链与 P2 UI 均已完成；仅 P3 干净 mac/win 真机首次安装与 VEA 验收尚未完成。

## 0. 背景、范围、reviewer 修订

### 0.1 现状钩子（复用，不另造）
小（非 seeded）包在全新机器上依赖系统 Python + ffmpeg，否则 `findPythonExecutable` 抛 `Python runtime not found`、`linkIfFound` 静默缺 ffmpeg（详 `docs/diagnostics/2026-06-23-vea-sendim-fixes-and-windows-runtime-guidance.md`）。复用：
- `runtime-manager.ts:550-555` `runtimeRoot`/`runtimeBin = skill-runtime/bin`。
- `runtime-manager.ts:3266` `findPythonExecutable` 第一候选 = 设置项 `skills_python_path` → 下载完写此设置即接通 venv。
- `ensurePythonVenv / ensureRuntimeToolchain / ensurePythonRuntimeReady / ensureSkillInstalled`：venv 构建、工具链链接、技能依赖 pip 安装均已实现；本功能负责「把 Python/ffmpeg 放到位 + 写设置 + 预热核心依赖」。
- `runtime-manager.ts:1175 probeEndpointLatency`（HEAD+2.5s）：源探活，复用做**排序**（非硬失败，见 0.7#6）。
- `skill-source-fetcher.ts:94-125` 的解包护栏（拒绝绝对路径条目 / 拒绝 `..` 越界 / 体积上限）：runtime 解包在此基础上**新增符号链接检查**（现有代码不查 symlink，见 0.8#10）。
- `model-pack-registry.ts:probeFastestModelProvider`：现有「全不可达→退回首候选仍尝试」语义（line 138 注释）；本功能要的是**排序+逐源实下载+全败才报错**，是新 helper，不是照抄（0.7#6）。
- UI：`renderer/components/settings/ModelsRuntimeSettingsPanel.tsx`。

### 0.2 范围（含 / 不含）——回应 0.7#1
**含**（点一次按钮后到位）：① Python（standalone）；② ffmpeg/ffprobe（静态二进制）；③ **VEA 核心 pip 依赖**——即 `assets/embedded-skills/video-expert-analyzer/requirements.txt` 的**非可选段**（yt-dlp / quickjs / scenedetect[opencv] / ffmpeg-python / openai / anthropic / Pillow / numpy / requests / browser_cookie3，均为几十 MB 量级、**不含 torch**），通过既有 `ensureSkillInstalled('video-expert-analyzer')` 预热。
**不含**（保留现状/独立按钮）：torch + funasr（GB 级，VEA 字幕降级第 3/4 级才需，requirements.txt 标为可选 extras）；ASR/OCR 模型权重——仍走现有 `modelPacks:download`。
**因此承诺收窄为**：点完按钮，**在线**视频分析（yt-dlp 抽流 + ffmpeg 合流 + 视觉分析 + API 字幕）即刻可用；**本地 ASR 降级链**仍需用户另装 torch/模型（UI 明示）。

### 0.6 P0 资产钉死（已完成）——回应 0.7#3
P0 已产出**真实资产清单**并钉死：每个 `{platform,arch}` 的 Python、ffmpeg 资产中每个 archive 均有**精确版本、URL、sha256、解包后相对路径**。
- 交付物：`scripts/pin-runtime-assets.mjs` —— 给定 pinned 版本，真实下载各平台资产、`sha256sum`、探明解包布局，**生成** `shared/runtime-asset-registry.ts` 的数据（含真实 hash）。
- 该脚本须在**有网机器**上各跑一次（mac arm64/x64 + win x64 资产都拉一遍）；产出的 registry 连同 sha256 一起提交。
- 已完成的真机结果是 PBS `tag 20260610 / Python 3.11.15`，共 8 个 archive 且注册表无占位 hash。未来更换坐标时必须重跑同一脚本，不得手写猜测值。

### 0.7 codex 审查 6 点（全部采纳，落点如下）
1. **轻依赖未覆盖** → §0.2 把核心 pip 依赖纳入按钮（`ensureSkillInstalled` 预热），torch/模型显式排除并 UI 明示。
2. **镜像配置无落地** → §2 数据模型加用户自定义镜像（设置 `runtime_asset_mirror_base`）、§4 IPC 加保存、§3 选源时并入、§5 UI 失败态给「填镜像并重试」入口。
3. **真实资产未钉死却要 gate** → §0.6 P0；gate 校验真实 hash（§6），draft 期不升 ready。
4. **ffmpeg 修复路径不稳** → §3「ffmpeg 接通」：先真实探测旧入口（跑 `-version` + 架构），坏/旧/错架构则**移除旧入口 + 原子替换**。
5. **解包安全护栏漏** → §3「解包」在 `skill-source-fetcher` 现有(绝对路径/`..`/体积)护栏基础上**新增符号链接检查**（措辞精修见 0.8#10）、同盘临时目录。
6. **「照抄 modelPacks 源选择」不准** → §3 抽新 helper `selectRuntimeSourceOrder`：探活只**排序**，逐源实下载，**全部实下载失败**才 `all_sources_unreachable`；与 modelPacks 的「退回首候选」差异写测试。

### 0.8 codex 二审 4 点（全部采纳）
7. **旧 venv 不会因换 Python 重建**（`ensurePythonVenv` line 3162：版本/SSL 合规即复用现有 `venvRoot=skill-runtime/python`，**不看 base Python 是否变**）。光写 `skills_python_path` 不够——老机器仍可能用旧系统 Python 建的 venv，与「无需系统 Python」目标不符。落点：① 下载的 standalone Python 放 **`skill-runtime/python-dist/`**（与 venvRoot `skill-runtime/python` **分目录**，避免撞）；② provisioner 写设置后，读 `venvRoot/pyvenv.cfg` 的 `home`/`executable`，与新 `skills_python_path` 不一致 → **rm `venvRoot` 强制重建** venv（新增 C10）。
8. **错误类型会误导**：hash 不符 / 压缩包坏 / 架构错 ≠ 源不可达。落点：拆两类——`all_sources_unreachable`（网络/源不可达，**才**提示填镜像）vs `asset_integrity_failed`（hash/压缩包/架构，**不**提示镜像——镜像往往同一坏资产或是钉死 hash 过期，应提示「资产校验失败，疑似钉死值过期/资产被污染」）。改 C4 + §5 UI 分流 + §6 测试分别覆盖。
9. **镜像两处不清**：① 资产模型加 `filename` 字段，镜像 URL = `${mirrorBase}/${platform}/${filename}`（不再含糊）。② 优先级定死：**用户镜像=强制最高优先**（先试，不参与测速排序；用户配它正是因为默认源不通，不能被测速排到后面）；其余默认源再按 `probeEndpointLatency` 排序。改 C9 + §3 helper。
10. **解包护栏措辞夸大**：`skill-source-fetcher:98` 现有护栏只防绝对路径 + `..`，**未真正检查符号链接目标**。改写为「在现有(绝对路径/`..`)护栏**基础上新增**符号链接条目检查（拒绝 symlink 条目，或校验 link target 解析后仍在 extractDir 内）」——不是「复用同等护栏」。

### 0.9 codex 三审 3 点（全部采纳，非方向性阻塞）
1. **源循环须试完所有源**（→ C4 已补）：某源 hash/解包/架构失败不立即终止，继续下一源；全失败时聚合判类（只连接失败=unreachable；≥1 下载成功但校验失败=integrity_failed），错误体带每源原因。
2. **venv 比对口径**（→ C10 已补）：`realpath` 归一化 + 判断 venv base 是否落在 `python-dist/` 下，禁止 raw string 比对（`home`=bin 目录、`executable`=版本化路径会误判）。
3. **P1 编号**（→ §7 已修）：`C1–C9` 改 `C1–C10`。

### 0.10 已实现文件（P1+P2，2026-06-23）
- `src/shared/runtime-asset-registry.ts`：注册表（mac arm64/x64 + win x64，archive 级 sha256；mac ffmpeg/ffprobe 为两个 archive）+ 纯 helper（`selectRuntimeSourceOrder`/`classifyProvisionFailure`/`venvNeedsRebuild`/`assertSafeRuntimeArchiveEntry`/`buildMirrorUrl`/integrity-error 标记）。当前资源均已写入真实 sha256；`PENDING_P0_PIN` 仅作为未来新增资源未校验时的拒绝哨兵。
- `src/shared/runtime-provision-types.ts`：renderer-facing 类型。
- `src/main/modules/skills-runtime/runtime-provisioner.ts`：编排（试完所有源 / 分类 / venv 接管 / ffmpeg 接通+架构校验 / 依赖预热）。注入 IO → 16 行为测试。
- `src/main/modules/skills-runtime/runtime-provisioner-io.ts`：真实 IO（下载/护栏解包/原子放置/探测）。
- `runtime-manager.getRuntimeProvisioner()`：真实 deps 接线。
- `ipc-handler.ts`：`runtime:status/provision/cancel/getMirror/setMirror/selfTest`(+progress)。
- `preload/index.ts`：`skills.*SkillRuntime*`（避开 agent `getRuntimeStatus` 同名）。
- `renderer/types/electron.d.ts` + `ModelsRuntimeSettingsPanel.tsx`（`RuntimeEnvironmentCard`：四行状态 + 一键按钮 + 进度 + 错误码分流镜像配置）。
- `scripts/pin-runtime-assets.mjs`：P0 钉死工具。
- `src/__tests__/runtime-provisioner.test.ts`：16 测试。

## 1. 机器可验合同
- **C1 就绪判定唯一源**：`runtime:status` 的 `{ python{ready,version,sslOk,path}, ffmpeg{ready,path,archOk}, ffprobe{ready,path}, coreDeps{ready,missing[]}, overallReady }` 必须由**真实探测**派生（`python --version` / `ssl.OPENSSL_VERSION` / `ffmpeg -version` 且校验架构 / `pip` 列核心包），不得「文件存在即 ready」。`overallReady = python.ready && ffmpeg.ready && ffprobe.ready && coreDeps.ready`。
- **C2 完整性强制**：每资产有 pinned `sha256`（真实，§0.6）；不过即删 + 失败，禁止接通未校验二进制。
- **C3 原子落盘**：下载→同盘临时目录→校验→解包(护栏)→`rename` 到目标；中断/失败不留半成品被误判 ready。
- **C4 选源 + 错误分类**（0.8#8 / 0.9#1）：`selectRuntimeSourceOrder` = [用户镜像(强制置顶,不测速)] ++ [默认源按 `probeEndpointLatency` 升序]；**逐源实下载，必须把所有源都试完**（某源 hash/解包/架构失败**不**立即终止，继续下一个源——避免错过另一个干净源）。任一源完整成功并接通 → 成功。全失败时按聚合判：**只**发生连接/HTTP 失败 → `all_sources_unreachable`（**才**提示填镜像）；**至少一个源下载成功但校验/解包/架构失败**且无源接通 → `asset_integrity_failed`（**不**提示镜像）。错误体须带**每个源的失败原因**。区别于 modelPacks 的「退回首候选」，须测。
- **C5 设置接通**：Python 解包后写 `skills_python_path` → 指向解包内解释器，须过 `isSupportedReadyPythonVersion`/`isSupportedReadyPythonSslVersion`。
- **C6 平台/架构隔离**：按 `{platform,arch}` 选资产；缺条目 → `unsupported_platform`；ffmpeg 接通时校验架构（0.7#4），错架构拒绝。
- **C7 幂等/单航班**：已 ready 组件跳过（除非 `force`）；进行中再点不重入（复用 modelPacks 取消/状态语义）。
- **C8 依赖预热**：成功路径末尾 `ensureSkillInstalled('video-expert-analyzer')` 预装核心依赖；`coreDeps.ready` 进 `overallReady`（C1）。torch/模型不在此 gate。
- **C9 镜像可配**（0.8#9）：设置 `runtime_asset_mirror_base` 非空时，按 `${base}/${platform}/${archive.filename}` 拼 URL，作为**强制最高优先源**（先试、不参与测速排序）；其余默认源再测速排序。
- **C10 venv 接管**（0.8#7 / 0.9#2）：写 `skills_python_path` 后判断 venv 是否需重建——**用 `realpath` 归一化**比对：读 `venvRoot/pyvenv.cfg` 的 `home`/`executable`，`realpath` 后判断 venv base 是否落在 `skill-runtime/python-dist/` 下（**不做 raw string 对比**，因 `home` 常是 bin 目录、`executable` 可能是 `python3.11` 版本化路径，裸比会误判反复重建）。不在 python-dist 下（或 venv 缺失）→ `rm venvRoot` 从新 Python 重建。standalone Python 解包到 `skill-runtime/python-dist/`，与 `venvRoot=skill-runtime/python` 分目录。

## 2. 数据模型 — `shared/runtime-asset-registry.ts`（新，真实值由 §0.6 脚本生成）
```
type RuntimePlatformKey = 'darwin-arm64' | 'darwin-x64' | 'win32-x64'
interface RuntimeAssetSource { url: string; kind: 'primary' | 'mirror' }
interface RuntimeAssetOutput {
  kind: 'python' | 'ffmpeg' | 'ffprobe'
  relPath: string
  expectedArch?: 'arm64' | 'x64'
}
interface RuntimeAssetArchive {
  sha256: string                                  // archive 真实钉死（§0.6）
  filename: string                                // archive 文件名，用于镜像 URL 拼接（C9/0.8#9）
  sources: RuntimeAssetSource[]
  archiveKind: 'tar.gz' | 'zip'
  expectedUncompressedBytes: number
  outputs: RuntimeAssetOutput[]
}
interface RuntimeAsset {
  id: 'python' | 'ffmpeg'; platform: RuntimePlatformKey
  version: string
  archives: RuntimeAssetArchive[]
}
// 解包目标：python → skill-runtime/python-dist/（与 venvRoot=skill-runtime/python 分目录，0.8#7）；
//   ffmpeg → skill-runtime/bin/。
// 用户镜像：setting `runtime_asset_mirror_base`（如 https://my-cdn/ready-runtime/）→
//   `${base}/${platform}/${archive.filename}`，强制最高优先（不测速，C9/0.8#9）。
```
当前钉死源：Python=`astral-sh/python-build-standalone` `cpython-3.11.15+20260610 install_only`（triple: aarch64/x86_64-apple-darwin、x86_64-pc-windows-msvc），**国内优先走 USTC GitHub Release 镜像** `https://mirrors.ustc.edu.cn/github-release/astral-sh/python-build-standalone/20260610/`，GitHub 原站和 ghproxy 仅兜底；ffmpeg=mac `OSXExperts`（arm64 8.1、Intel 8.0，ffmpeg/ffprobe 分 archive），win `BtbN/FFmpeg-Builds win64-gpl`（一个 archive 含 ffmpeg.exe/ffprobe.exe）。`Evermeet` 仅 Intel、`FFbinaries` 无 mac arm64、`eugeneware/ffmpeg-static` 不覆盖 ffprobe，均不作为当前主源。mac ffmpeg 和 BtbN 国内分发可走 `runtime_asset_mirror_base` 指向的自建/域内 CDN，并由同一套 archive sha256 防污染。

## 3. 主进程 — `RuntimeProvisioner`（新）
- `getRuntimeStatus()`（C1，真实探测，5s 缓存）。
- `provisionRuntime({force}, onProgress)`：每个未 ready 资产中的每个 archive → `selectRuntimeSourceOrder`（C4/C9）→ `downloadWithResume` → `verifySha256`（C2）→ `extractAtomic`（C3+护栏）→ 平台后处理 → 接通；末尾 `ensureSkillInstalled('video-expert-analyzer')`（C8）→ 复跑 `getRuntimeStatus`。
- **解包护栏**（0.8#10）：在现有 `skill-source-fetcher` 的「拒绝绝对路径 / `..`」基础上**新增符号链接条目检查**（拒绝 symlink 条目，或解析 link target 后必须仍在 extractDir 内）；累计体积超 `expectedUncompressedBytes×安全系数` 即中止；临时目录与目标同盘（同卷 rename）。
- **Python 接通**（C5/C10/0.8#7）：解包到 `skill-runtime/python-dist/` → 写 `skills_python_path` = `python-dist/${python output relPath}` → 读 `venvRoot/pyvenv.cfg`，`home`/`executable` 与新 Python 不一致（或 venv 缺失）→ `rm venvRoot` → `ensurePythonVenv` 从新 Python 重建。**确保不复用旧系统 Python 的 venv。**
- **ffmpeg 接通**（0.7#4）：目标 `runtimeBin/ffmpeg(.exe)` 若已存在→跑 `-version` + 校验架构；坏/旧链接/错架构→`unlink` 旧入口；新二进制原子写入 + `chmod 0755`。Windows 直接拷 `.exe`、不建 symlink。
- **macOS 后处理**：解包二进制 `xattr -d com.apple.quarantine`，并 best-effort `codesign -s -`（Apple Silicon 静态二进制可能需要临时签名）；最终仍以 `-version` 真实探测为准。
- `selectRuntimeSourceOrder(asset, archive, mirrorBase, probe)`（新 helper，0.7#6/0.8#9）：返回 `[用户镜像URL(若配置, 置顶不测速)] ++ [archive.sources 按 probe 升序, null 排末不剔除]`，逐源实下载。
- `cancel()`：AbortController 协作中止 + 半成品清理。

## 4. IPC — `skills-runtime/ipc-handler.ts`（照 modelPacks 形态）
- `runtime:status` / `runtime:provision`（进度 `event.sender.send('runtime:provisionUpdate',…)`）/ `runtime:cancel` / `runtime:selfTest`
- `runtime:setMirror`（写设置 `runtime_asset_mirror_base`）/ `runtime:getMirror`（0.7#2）
- preload 暴露 + `renderer/types/electron.d.ts` 补类型。

## 5. UI — `ModelsRuntimeSettingsPanel.tsx`
模型块**上方**加「运行时环境」卡：Python/ffmpeg/ffprobe/核心依赖 四行状态 + 「一键下载并配置」按钮 + 进度 + **失败态按错误码分流**（0.8#8）：`all_sources_unreachable` → 「自定义镜像地址」输入框 + 保存并重试（接 `runtime:setMirror`，0.7#2）；`asset_integrity_failed` → 「资产校验失败（疑似钉死值过期/被污染），请反馈或稍后重试」，**不**引导填镜像；`unsupported_platform`/架构错给明确文案。`overallReady` → 「重新检测/修复」。明示「本地 ASR 降级链需另装 torch/模型」（§0.2）。不动模型下载块。

## 6. 测试 / gate（行为测试 + 真实入口/最小替身；§0.7 要求的几条全覆盖）
`runtime-provisioner.test.ts`（注入 mock 下载器，不打真网）：
- **坏 hash / 坏压缩包 / 错架构 → `asset_integrity_failed`（非 unreachable）**，不接通、不提示镜像（C4/0.8#8）；其中坏压缩包含绝对路径/`..`/**符号链接逃逸**/超体积各自被护栏拒绝（0.8#10）。
- **全源连接失败 → `all_sources_unreachable`**（才提示镜像），且确认是「逐源实下载都失败」而非探活即弃（对照 modelPacks 退回首候选，0.7#6/C4）。
- **坏/旧/错架构 ffmpeg 旧链接** → 被移除并原子替换；架构错 → `asset_integrity_failed`（0.7#4/C6）。
- **旧 venv 重建**（C10/0.8#7）：预置一个「base Python 与新 `skills_python_path` 不一致」的 venv → provision 后 `venvRoot` 被 rm 并从新 Python 重建（断言 pyvenv.cfg 指向 python-dist）。
- **镜像强制优先**（C9/0.8#9）：配置 `runtime_asset_mirror_base` 后，镜像 URL 置顶被先试，即便其测速更慢/未测速；无配置→走默认源。
- **成功路径** → 写设置 + venv 接管 + `ensureSkillInstalled` 被调 + status overallReady（C5/C8/C10）。
- 原子性：中断后 status≠ready（C3）；force/幂等（C7）。
注册表 gate：每 `RuntimePlatformKey` 的 python+ffmpeg 条目齐全、每个 archive 的 **sha256 为真实 64-hex**、`sources≥1 primary`（镜像可选，用户镜像仍强制置顶）、`expectedArch` 对齐。该合同已进入 `runtime-provisioner.test.ts`，同时保留对未来占位哨兵值的失败测试。

## 7. 分期
- **P0 ✅ 已完成**（2026-06-23）：`pin-runtime-assets.mjs` 真机跑通；8 个 archive（python ×3 / mac ffmpeg+ffprobe ×4 / win ffmpeg ×1）真实 sha256 已填入 registry（0 占位）；真实 IO 烟测通过。真值：PBS `tag 20260610 / 3.11.15`、osxexperts ffmpeg/ffprobe 8.1(arm)/8.0(intel)、BtbN win64-gpl latest。**遗留**：win BtbN `latest` sha 会随 nightly 过期，Windows 派发前需重钉/改 dated tag。
- **P1（本机可完整交付+测）✅ 已完成**：真实 sha256 注册表 + `RuntimeProvisioner`(mock 下载器跑通 C1–C10) + `selectRuntimeSourceOrder` + IPC/preload/类型 + §6 全部行为测试（16 个）。注册表完整性与占位哨兵拒绝已进入同一行为测试。
- **P2 ✅ 已完成**：`RuntimeEnvironmentCard` UI 卡 + 进度/失败镜像配置 + selfTest。
- **P3（真机/真网验收）**：干净 Mac 一键→**首次 VEA 在线视频真实跑通**；Windows x64 实测（`.exe`/拷贝/quarantine 不适用/`verify:native`）。不接受单测绿当派发就绪。

## 8. 尚需目标机验证（如实声明）
- 资产真实下载与 sha256 实值已在 P0 完成；尚未全验的是干净系统首次安装、Gatekeeper quarantine、Windows 执行与首次 VEA 真跑，即 P3。
- better-sqlite3 ABI 由各平台 app 构建负责，不在本功能内。

## 9. 关联
- 现状与 Windows 坑：`docs/diagnostics/2026-06-23-vea-sendim-fixes-and-windows-runtime-guidance.md`
- 复用钩子：`runtime-manager.ts`、`model-pack-registry.ts`、`skill-source-fetcher.ts`、`ipc-handler.ts`、VEA `requirements.txt`
