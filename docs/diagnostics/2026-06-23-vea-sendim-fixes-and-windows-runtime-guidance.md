# 2026-06-23 — VEA YouTube 下载 + Send IM 工具暴露修复，及 Windows 运行时移植指引

> 作者：Claude（Opus 4.8）｜ 分支：`agent-evolution/phase1` ｜ 提交：`fix(agent): repair VEA YouTube download + Send IM tool exposure`
> 范围：记录 2026-06-23 这轮（codex 多轮未根治后）实测坐定的问题点与修复，并据此给 Windows 端移植/修复指引。
> 方法纪律：每个根因都用**运行时复现 + 开关验证**坐定，不靠读代码推正则（前两次失败正是栽在只读代码推断）。

---

## 0. TL;DR

| # | 问题 | 真根因（证据） | 修复 | Windows 关联 |
|---|---|---|---|---|
| 1 | VEA YouTube 下载间歇性失败 | `pipeline_enhanced.py._step_download_video` 单发 yt-dlp、零重试；YouTube 对自适应流间歇 `HTTP 403`（同一视频 23:28 败 / 23:53 成 / 00:37 又败） | 3 策略重试 + player_client 轮换 + 渐进式回退 + 韧性参数 | yt-dlp/ffmpeg/node 的 Windows 解析见 §3 |
| 2 | Send IM「当前会话未开放 skill_send_im_file 工具」 | `@[Send IM]@[文件.md]` 撞上 `shouldUseLocalDocumentToolSet` 的 `@[...md]` 分支 → 整轮被当文档编辑、工具面收窄、`skill_send_im_file` 被剔 → `toolCount=0` | send-to-IM 投递意图不再判为文档编辑 | 纯 TS，跨平台一致 |
| 3 | Send IM 显式路径/同义词不识别 | 意图闸 `hasLocalSendImFileIntent` 不认内联绝对路径、不认 `sendim` | 加 `LOCAL_INLINE_ABSOLUTE_FILE_SOURCE` + `sendim` | Windows 绝对路径形态见 §3 |
| 4 | VEA 下载彻底失败时的收口语义 | codex 用 `recoverable_paused/checkpoint_background`（假装后台在跑） | 改 `blocked/blocked_external`（如实=等用户动作） | 跨平台一致 |

**Send IM 仍有一条独立的外部约束（非本仓代码可修）**：微信 openclaw 出站 `ilink/bot/sendmessage` 返回 `ret=-2/-3`「微信出站发送会话已失效」。工具开放、文件解析成功之后仍可能撞这条，需用户先从微信给 Ready 发一条新消息刷新会话。详见 §2.4。

---

## 1. 问题 1：VEA YouTube 下载（真根因 + 修复）

### 1.1 证据
`~/Library/Application Support/ready/skill-runtime/results/*.json`（SkillRunResult 一手账本）：

- 同一视频 `uk2KmRlx7eA`：`23:28 failed(403)` → `23:53 success` → `00:37 failed(403)`。**间歇性**坐实——失败是 YouTube 服务端反爬，重试即可救回。
- 失败的安装版 run 跑在 `/Applications/Ready.app/.../skill-runtime/python` → **安装版能正确找到并执行 yt-dlp，打包不是执行阻断点**。
- 报错精确指向 `pipeline_enhanced.py:1292 _step_download_video → subprocess.run(check=True)`，单发、无重试、固定自适应格式 `bestvideo[ext=mp4]+bestaudio[ext=m4a]/best`。

### 1.2 修复
`assets/embedded-skills/video-expert-analyzer/scripts/pipeline_enhanced.py` 新增 `_download_remote_video_with_retry()` + `_cleanup_partial_video()`：
- 3 策略依次重试，每轮重新抽取流地址：`default-adaptive` → `multiclient-adaptive` → `multiclient-progressive`；
- 仅对 YouTube 加 `--extractor-args "youtube:player_client=default,tv,web_safari,mweb"`；
- 每次调用加 `--no-continue --force-overwrites --retries 10 --fragment-retries 10 --extractor-retries 3 --no-progress`；
- 任一轮产出有效文件即返回，全败才抛 `yt-dlp 下载失败: ...`。

实测：旧单发命令现已成功（间歇性已证），渐进式回退走 HLS（tv client）另一条链路也下成——提供真实韧性，不只是重试同一条死链路。

> 注意：修的是仓库源 `assets/embedded-skills/...`；运行时副本经 `runtime-manager.ts:syncEmbeddedSkill` 按**内容 hash** 自动重灌（无需手动清），dev 与安装版都覆盖。Python venv（yt-dlp 本体）不动。

### 1.3 codex 错在哪
codex 整个 diff **没碰 Python 下载代码**，只在 TS 编排层把失败转成 `recoverable_paused` 提示「用浏览器手动下载」——改症状不改根因（CLAUDE.md §0.5 红线 #2）。本轮已把该兜底降级为「真实重试耗尽后的最后手段」并改 `blocked_external`。

---

## 2. 问题 2/3：Send IM 工具未开放（真根因 + 修复）

### 2.1 证据（运行时复现，不是读代码推断）
- 从会话库 `ready.db chat_messages` 捞出**用户真实输入**：`@[Send IM]@[2026 世界杯-1781619835060.md]`（技能名 + 文件名两个 `@[]`，无「微信」动词、无绝对路径）。
- `ready-tools.log` 该轮 `tool_capability stage=sdk_runtime_final_tools toolCount=0` → **整个工具集为空**，不是单独少 send-im。
- 用仓库真实测试夹具 `createRuntime`（`agent-sdk-runtime.test.ts`）跑这条原话：复现 `tools(0)`；打补丁后 `tools(1) skill_send_im_file=true`；**开关验证**：关补丁→回到 0，开补丁→恢复。

### 2.2 根因
`agent-sdk-runtime.ts:shouldUseLocalDocumentToolSet()` 的判定正则含 `@\[[^\]]+\.(?:md|markdown|txt|docx?)\]`。用户用 `@[文件.md]` 引用要发的文件时，这一轮被**误判为文档编辑任务**，触发 `toolDefinitions.filter(isLocalDocumentToolDefinition)`（仅留 `domain==='document'|'file'`），`skill_send_im_file`（domain=`skill`）被剔 → 0 工具 → 模型回「当前会话未开放」。

「发文件到微信」是**投递**意图，不是改文档——两个启发式撞车，文档那条赢了。

### 2.3 修复
- `shouldUseLocalDocumentToolSet`：检测到 `hasLocalSendImFileIntent` 为真时直接返回 false（投递 ≠ 文档编辑）。**这是用户实际撞的那个修复。**
- 意图闸 `remote-im-file-intent.ts` 顺带放宽：认内联绝对路径（`LOCAL_INLINE_ABSOLUTE_FILE_SOURCE`）+ `sendim` 同义词，覆盖 `@[Send IM]把 /路径.md 发微信` 这类写法。
- 回归测试：`agent-sdk-runtime.test.ts` 新增「exposes skill_send_im_file when the file to send is referenced as @[file.md]」。

### 2.4 codex 对/错澄清（用于校正其经验文件）
codex 的 send-im 文档（`docs/superpowers/plans/2026-06-17-send-im-l1-and-agent-state-fix-implementation.md`、`docs/diagnostics/2026-06-17-send-im-codex-round-layered-review.md`）**方向大体正确**：它识别了暴露层 `toolCount=0`、`adjudication_degraded`(s1 overlay)、`ret=-2/-3` 微信会话三件事，并做了 `@[Send IM]@@[文件]` 进 send-im 授权。

**但它的暴露修复只用图片验证**（AC-1：`@[Send IM] 把这四张图发到我微信`，`.png/.jpg`）。图片**不**命中 `shouldUseLocalDocumentToolSet` 的 `.md/.txt/.docx` 文档正则，所以图片路径没暴露这个 bug。用户实际发的是 `.md` 文档 → 命中文档-工具集塌缩，这条 codex 从未覆盖。**结论：codex 的 send-im 暴露分析对图片成立、对 `@[文件.md]` 文档不成立；本轮补齐。**

### 2.5 微信 `ret=-3` 是独立外部约束
`src/python/ready_sidecar/channels/wechat_openclaw_adapter.py` 的出站 `ilink/bot/sendmessage`，per-target `context_token` 过期后 bot 无法主动发消息 → `ret=-2/-3`。已由 `channel-delivery-result.ts:normalizeChannelDeliveryError` 如实诊断为非重试 `blockedExternal`。**任何本仓代码都修不了**，需用户先从微信给 Ready 发一条新消息刷新会话。复测 Send IM 时务必先做这一步，否则即便工具开放也会撞 `ret=-3`。

---

## 3. 为什么不打包 skill-runtime 进 DMG，功能也完整可用？

### 3.1 分层模型（关键认知）
Ready 是**瘦壳 + 本地置备的运行时**两层，运行时不在安装包里，而是落在用户数据目录、跨安装持久：

| 组件 | 安装包内（DMG/Resources） | 用户数据 `~/Library/Application Support/ready/skill-runtime`（跨安装持久） | 来源 |
|---|---|---|---|
| 技能脚本 `embedded-skills`（如 `pipeline_enhanced.py`） | ✓ 打包进 Resources | 经 `syncEmbeddedSkill` 按 hash 重灌到 `skills/` | 随版本 |
| Python 解释器 + venv | ✗（dev 模式不打包） | 首次运行用系统 Python `python -m venv` 建（`runtime-manager.ts:ensurePythonVenv` ~3153） | 本机置备 |
| 技能依赖（yt-dlp/torch/funasr…） | ✗ | 首次跑该技能时 `pip install -r requirements.txt` 装入共享 venv（hash 门控） | 在线 PyPI/镜像 |
| ffmpeg/ffprobe 二进制 | ✗（dev 是 symlink 到 `/opt/homebrew/bin/ffmpeg`） | `which/where` 探测系统二进制后 symlink 到 `skill-runtime/bin/`（`ensureRuntimeToolchain` ~3388） | 系统/homebrew |
| ML 模型包（FunASR VAD/ASR…） | ✗ | 用户在「设置 › 模型与运行时」按需下载到 `cache/{modelscope,huggingface}/`（`startModelPackDownload` ~763） | 在线，按需 |

**所以一个不含运行时的 DMG 也能完整工作的根本原因**：运行时是**独立、本机置备、跨安装持久**的一层。你的开发/测试机上 `skill-runtime` 早已建好（之前用过），新装 DMG 直接复用它；新版只更新瘦壳 + 技能脚本（脚本按 hash 自动重灌）。Python venv、yt-dlp、ffmpeg、模型一律不在包里，也不随安装重置。

> 历史更新（2026-07-16）：`build-seeded-dist.mjs` 已退役并删除，不得再从本机设置导出发布配置。日常 `build:dist` 只允许空 AI seed；确需内置配置或完整 runtime 时使用受控 Packer 流程。

### 3.1.1 更新（2026-06-23）：一键运行时配置已实现（P1+P2）
全新机器原本需要预装系统 Python/ffmpeg、且 ASR 模型要手动下（见本节原结论）。现已实现「设置 › 模型与运行时 › 运行时环境」的**一键下载并配置**：自下载固定版 standalone Python + 静态 ffmpeg/ffprobe + 预热 VEA 核心 pip 依赖（不含 torch），用户点一下即可，无需系统 Python/homebrew。设计见 `docs/superpowers/plans/2026-06-23-one-click-runtime-provisioning-implementation.md`。
- 已完成：注册表 + provisioner（试完所有源/校验/护栏解包/venv 接管/架构校验）+ IPC/preload/UI + 16 行为测试 + codex 对抗审查 SHIP。
- **当前状态**：P0 已完成，注册表的 8 个 archive 均为真实 64-hex sha256，`assets_not_pinned` 只保留为未来新增未钉死资产的安全拒绝。仍未完成的是 P3 干净 mac/win 真机验收（含 `tar` 可用性、Windows `.exe`、首次 VEA 真跑）。ASR 大模型仍走独立下载按钮（运行时与模型分开）。

### 3.2 推论
- 在**已有运行时**的机器上换版本，只要改的是 TS（瘦壳）或 embedded-skills（脚本），普通 `build:dist` 即可，运行时零改动。今天两处修复正是如此：send-im 是 TS、VEA 是 embedded-skills 脚本。
- 目标机器无法在线置备运行时时，必须改走受控 Packer 的完整包流程；不得恢复已退役的本机设置导出脚本。

---

## 4. Windows 端移植 / 修复指引

下面按「今天的修复在 Windows 上是否一致」+「Windows 全新机器置备运行时的坑」两条线给指引。仓库已有部分 Windows 分支（`getVenvPythonPath` 返回 `Scripts\python.exe`、`getWhichCommand` 返回 `where`、`packaged-runtime.ts` 候选含 `.exe/.cmd`），但以下点需逐一在 **Windows 本机**验证（CLAUDE.md 硬约束：Windows 不是 macOS 的副本，必须本机重装依赖、重编 `better-sqlite3`）。

### 4.1 今天的修复在 Windows 上
- **Send IM 工具暴露修复（问题 2/3）**：纯 TS，跨平台一致，随瘦壳生效。`LOCAL_INLINE_ABSOLUTE_FILE_SOURCE` 只匹配 `/Users|/Volumes|/var|/tmp|...` 这类 **POSIX 绝对路径**——Windows 绝对路径是 `C:\Users\...`，当前不匹配。**Windows 待办**：若要支持「把 `C:\...\foo.md` 发微信」这种内联 Windows 路径，需在该正则补 `[A-Za-z]:\\\\...` 形态。`@[Send IM]@[文件.md]` 与 `@[文件]` 引用路径不受影响（跨平台一致）。
- **VEA 下载重试（问题 1）**：`pipeline_enhanced.py` 用 `build_yt_dlp_command` 解析 `yt-dlp`/`node`/`ffmpeg`，已有 Windows 回退（`yt-dlp` 不在 PATH 时回退 `python -m yt_dlp`）。**Windows 待办**：确认 `node`（nsig 用）、`ffmpeg.exe`、`yt-dlp.exe` 在 Windows runtime 的 PATH 内可解析；`--ffmpeg-location` 传的是目录/可执行，注意 `.exe` 后缀与反斜杠。`--extractor-args`/`--no-continue`/`--force-overwrites` 等参数跨平台一致。

### 4.2 全新 Windows 机器置备运行时的坑
1. **Python 解释器**：无打包 Python 时需从注册表/PATH 找 3.9–3.12 且 OpenSSL 1.1.1+；找不到要走「设置里手填 `skills_python_path`」。venv 路径为 `python\Scripts\python.exe`。
2. **ffmpeg/ffprobe**：dev macOS 是 symlink 到 homebrew；Windows **没有 homebrew**，`where ffmpeg` 多半失败。必须随 runtime 带 `ffmpeg.exe/ffprobe.exe` 或引导用户装。**注意**：`prepare-release-skill-runtime.mjs` 当前 deref symlink 的逻辑是为 macOS 的悬空 symlink 设计的，Windows 应直接拷 `.exe`，不要带任何 macOS `bin/` 产物。
3. **better-sqlite3 ABI**：必须在 Windows 本机按 Electron 版本重编（win32-x64），不能带入 macOS `node_modules`/`.node`。
4. **symlink/junction**：`ensureRuntimeToolchain` 用 `symlinkSync` 建 `bin/` 链接；Windows 无管理员或禁用 NTFS symlink 时会失败——Windows 上应优先**直接拷贝** `.exe` 而非 symlink。
5. **PATH 分隔符**：`path.delimiter`（Windows `;`）仓库已用对，沿用即可，勿硬编码 `:`。
6. **模型包离线门**：打包模式默认 `MODELSCOPE_OFFLINE=1/HF_HUB_OFFLINE=1/TRANSFORMERS_OFFLINE=1`；全新 Windows 无预置模型时，需模型的技能（VEA 的 ASR 段）会抛 `__READY_ASR_MODEL_PACK_MISSING__` 并阻塞，直到用户在「设置 › 模型与运行时」下载。Windows 安装引导应提示这一步。
7. **发布边界**：旧 `build-seeded-dist.mjs` 已退役；Windows 需要独立的 NSIS/dir 打包路径（electron-builder.yml 的 win/nsis 目标），不能复用 macOS Packer 或携带本机 AI 设置。

### 4.3 验收口径（Windows）
- VEA：在 Windows 本机真跑一个 YouTube 链接，确认重试内能下成 + ASR 模型包已就绪；不接受「TS 测试绿」当证据。
- Send IM：Windows 本机用 `@[Send IM]@[文件.md]` 确认工具开放；再用刷新过的微信会话确认真实送达（绕开 `ret=-3`）。
- `npm run verify:native` 必须在 Windows 本机过（better-sqlite3 真实加载）。

---

## 5. 关联文件
- 修复提交：`fix(agent): repair VEA YouTube download + Send IM tool exposure`
- 置备机制：`src/main/modules/skills-runtime/runtime-manager.ts`（`ensurePythonVenv` ~3153 / `ensureRuntimeToolchain` ~3388 / `syncEmbeddedSkill` ~3110 / `startModelPackDownload` ~763）
- send-im 旧诊断（本轮校正其「仅图片验证」盲点）：`docs/diagnostics/2026-06-17-send-im-codex-round-layered-review.md`、`docs/superpowers/plans/2026-06-17-send-im-l1-and-agent-state-fix-implementation.md`
- 微信出站：`src/python/ready_sidecar/channels/wechat_openclaw_adapter.py`、`src/main/modules/agent-control/runtime-core/channel-delivery-result.ts`
