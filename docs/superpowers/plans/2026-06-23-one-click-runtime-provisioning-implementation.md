---
title: 一键运行时配置（Python + ffmpeg 自下载）实施计划
date: 2026-06-23
branch: agent-evolution/phase1
status: ready-for-implementation
enforce: true
author: Claude (Opus 4.8)
decisions:
  - 平台：mac(arm64+x64) + Windows(x64) 一起做
  - 下载源：GitHub 主源 + 国内镜像，按 probeEndpointLatency 探活选源（复用模型下载的源选择/连接性能策略）
  - 范围：本按钮只配「运行时」(Python + ffmpeg/ffprobe + 轻依赖)；ASR 大模型保留现有独立下载按钮
goal: 让安装包保持瘦壳（几十 MB），用户在「设置 › 模型与运行时」点一个按钮即自下载并配好 Python 与 ffmpeg，无需预装系统 Python/homebrew。
---

# 一键运行时配置 — 实施计划

> 合同先行（CLAUDE.md §0.5）。本文给：契约 → 数据模型 → IPC 面 → 下载器 → 平台矩阵 → UI → 测试/gate → 分期 → 不可在本机验证项。

## 0. 背景与现状钩子（复用，不另造）
小（非 seeded）包在全新机器上依赖系统 Python + ffmpeg，否则 `findPythonExecutable` 抛 `Python runtime not found`、`linkIfFound` 静默缺 ffmpeg（见 `docs/diagnostics/2026-06-23-vea-sendim-fixes-and-windows-runtime-guidance.md`）。本功能把「运行时」改为**按需自下载到 `skill-runtime/`**。已存在、本计划直接复用的钩子：

- `runtime-manager.ts:550-555` `runtimeRoot`/`runtimeBin = skill-runtime/bin`。
- `runtime-manager.ts:3266` `findPythonExecutable` 第一候选 = 设置项 `skills_python_path`。**下载完写此设置即接通 venv 构建。**
- `runtime-manager.ts:ensurePythonVenv / ensureRuntimeToolchain / ensurePythonRuntimeReady`：venv 构建与工具链链接已自动；本功能只负责「把 Python/ffmpeg 先放到位 + 写设置」。
- `runtime-manager.ts:1175 probeEndpointLatency`（HEAD + 2.5s 超时）：源探活，**直接复用做主源/镜像选择**。
- `model-pack-registry.ts` 的 `ModelProvider{ provider, repoId, mirrorEndpoint }` + `ModelSource`：runtime 资产注册表照此形态建。
- `skills-runtime/ipc-handler.ts:132` 已有 github + 国内 mirror 探活先例；`modelPacks:download` 的「IPC + `event.sender.send` 推进度」模式照抄。
- UI：`renderer/components/settings/ModelsRuntimeSettingsPanel.tsx`。

## 1. 机器可验合同（先于实现）
- **C1 就绪判定唯一源**：`runtime:status` 返回的 `{ python: {ready, version, sslOk, path}, ffmpeg: {ready, path}, ffprobe: {ready, path}, overallReady }` 必须由**真实探测**派生（`python --version`/`ssl.OPENSSL_VERSION`、`ffmpeg -version`），不得由「文件存在」臆断。`overallReady === (python.ready && ffmpeg.ready && ffprobe.ready)`。
- **C2 完整性强制**：每个下载资产必须有 pinned `sha256`；校验不过 = 删除 + 失败，**禁止**用未校验二进制接通运行时。
- **C3 原子落盘**：下载→临时目录→校验→解包→`rename` 到目标；中断/失败不得留下半成品被 `runtime:status` 误判为 ready。
- **C4 源选择确定性**：候选源按 `probeEndpointLatency` 升序，全 null（都不可达）→ 结构化 `all_sources_unreachable` 错误并提示用户配镜像；不得静默卡死。
- **C5 设置接通**：Python 解包后写 `skills_python_path` 指向解包内的解释器；该路径必须能通过既有 `isSupportedReadyPythonVersion`/`isSupportedReadyPythonSslVersion`。
- **C6 平台隔离**：资产 URL/sha/解包布局按 `{platform, arch}` 选取；缺该平台条目 → 明确 `unsupported_platform`，不得拉错架构产物。
- **C7 幂等**：重复点按钮：已 ready 的组件跳过（除非 `force`）；进行中再点不重入（单航班锁，复用 modelPacks 取消/状态语义）。

## 2. 数据模型 — `shared/runtime-asset-registry.ts`（新）
```
type RuntimePlatformKey = 'darwin-arm64' | 'darwin-x64' | 'win32-x64'
interface RuntimeAssetSource { url: string; kind: 'primary' | 'mirror' }   // 探活择优
interface RuntimeAsset {
  id: 'python' | 'ffmpeg'        // ffmpeg 资产同时产出 ffmpeg+ffprobe
  platform: RuntimePlatformKey
  version: string                // 钉死版本
  sha256: string                 // 钉死校验值（C2）
  sources: RuntimeAssetSource[]  // 主源 GitHub + 国内镜像
  archiveKind: 'tar.gz' | 'zip'
  // 解包后相对路径，供接通使用：
  pythonRelPath?: string         // e.g. 'python/bin/python3' | 'python\\python.exe'
  ffmpegRelPaths?: { ffmpeg: string; ffprobe: string }
}
```
**钉死源（实现时填 sha256）**：
- Python：`astral-sh/python-build-standalone` 的 `cpython-3.11.x+<date>-<triple>-install_only.tar.gz`（relocatable）。triple：`aarch64-apple-darwin` / `x86_64-apple-darwin` / `x86_64-pc-windows-msvc`。镜像：ghproxy 或域内 CDN。
- ffmpeg：mac → osxexperts/evermeet 的 ffmpeg+ffprobe；win → `BtbN/FFmpeg-Builds` 的 `ffmpeg-*-win64-gpl.zip`（含 ffmpeg.exe/ffprobe.exe）。镜像：域内 CDN。
> 稳态建议：长期最好把这些资产镜像到你们自己的 OSS/CDN 当主源（最可控）；本期按「github 主 + 国内镜像 + 探活」实现，注册表留好换源位。

## 3. 主进程 — `RuntimeProvisioner`（新，挂在 `SkillsRuntimeManager` 或独立模块）
方法（均走 `runtime-manager` 已有的 `runtimeRoot`）：
- `getRuntimeStatus(): RuntimeStatus`（C1，真实探测，带 5s 缓存避免狂探）。
- `provisionRuntime({ force }, onProgress): Promise<RuntimeStatus>`：对每个未 ready 资产→`selectSource`(探活 C4)→`downloadWithResume`→`verifySha256`(C2)→`extractAtomic`(C3)→平台后处理→接通(C5)。Python 接通=写 `skills_python_path` + 调 `ensurePythonVenv`；ffmpeg 接通=放 `runtimeBin` 下 + `chmod 0755`。结束跑 `getRuntimeStatus` 复核。
- `cancel()`：协作式中止（AbortController），半成品清理。
- 平台后处理：
  - **macOS**：解包后对二进制 `xattr -d com.apple.quarantine`（C2 之外的可执行前提，否则 Gatekeeper 拦）；`chmod +x`。
  - **Windows**：`.exe`，不建 symlink、**直接拷贝**到 `runtimeBin`；路径用 `path.join`，PATH 用 `path.delimiter`。
- 下载器：`fetch` + Range 续传 + 进度回调；超时/重试；失败带源信息。

## 4. IPC 面 — `skills-runtime/ipc-handler.ts`（照抄 modelPacks 形态）
- `runtime:status` → `getRuntimeStatus()`
- `runtime:provision`（progress 经 `event.sender.send('runtime:provisionUpdate', …)`）
- `runtime:cancel`
- `runtime:selfTest`（跑 `python -c`/`ffmpeg -version`/`yt-dlp --version`，返回逐项 ok）
preload 暴露 + `renderer/types/electron.d.ts` 补类型。

## 5. UI — `ModelsRuntimeSettingsPanel.tsx`
模型下载块**上方**加「运行时环境」卡：三行状态(Python/ffmpeg/ffprobe，各 ✅版本 / ❌未配置) + 「一键下载并配置」按钮 + 进度条 + 失败时结构化指引(含「源不可达→填镜像」入口)。`overallReady` 时按钮变「重新检测/修复」。不动现有模型下载块（C：运行时与模型分开）。

## 6. 测试 / gate（CLAUDE.md §6：行为测试 + 真实入口/最小替身）
- `runtime-provisioner.test.ts`：注入 mock 下载器（不打真网）——
  - sha256 不符 → 失败且不接通（C2）；
  - 全源探活 null → `all_sources_unreachable`（C4）；
  - 成功路径 → 写 `skills_python_path` + 状态 ready（C5）；原子性：中断后 status 不为 ready（C3）；
  - 平台缺条目 → `unsupported_platform`（C6）；force/幂等（C7）。
- 注册表静态 gate：每个 `RuntimePlatformKey` 的 python+ffmpeg 条目齐全、`sha256` 非空、`sources` 至少 1 主 1 镜像。
- 不引入「文件存在即 ready」的结构断言冒充行为。

## 7. 分期
1. **P1（可在本机完整交付+测）**：注册表 + `RuntimeProvisioner`(mock 下载器跑通契约) + IPC/preload/类型 + 行为测试 + 注册表 gate。
2. **P2**：UI 卡 + 进度/错误指引 + selfTest。
3. **P3（须真机/真网，本机/CI 不可全验）**：填真实 sha256；macOS arm64 干净机实测一键→VEA 跑通；Windows x64 实测（含 `.exe`/拷贝/`verify:native`）。

## 8. 不可在此环境验证（如实声明）
- 真实从 GitHub/镜像下载、Gatekeeper quarantine、Windows 执行——本机/CI 都不能全验；P3 必须在干净的 mac + Windows 各跑一次，不接受「单测绿」当派发就绪证据。
- better-sqlite3 ABI 仍由各平台 app 构建负责（不在本功能内）。

## 9. 关联
- 现状与 Windows 坑：`docs/diagnostics/2026-06-23-vea-sendim-fixes-and-windows-runtime-guidance.md`
- 复用钩子：`src/main/modules/skills-runtime/runtime-manager.ts`、`model-pack-registry.ts`、`ipc-handler.ts`
