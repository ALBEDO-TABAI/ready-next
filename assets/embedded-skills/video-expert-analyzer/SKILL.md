---
name: vea
description: Video Expert Analyzer VNext — use when the user wants a public or local video analyzed with resumable staged execution, especially for long videos, OpenClaw handoff, multi-batch scene scoring, storyboard output, highlight selection, subtitle or lyric correction, or audiovisual analysis.
when-to-use: |
  用户希望对长视频做可续跑的逐镜头深度分析（场景评分、storyboard、精选镜头、视听报告）时使用。
  典型触发词：分析视频 / 长视频 / 续跑 / 分镜表 / 视听分析 / OpenClaw 接力 / 精选镜头 / 视频专家。
  默认一口气跑完；只在 OpenClaw 主控场景下走分段接力。
  与 video-copy-analyzer 区分：本技能做单视频"长任务"深度分析；video-copy 做轻量字幕/文案提取。
---

# Video Expert Analyzer VNext

面向长任务的视频分析 skill。目标不是改输出，而是让长视频、长会话、OpenClaw 接力这类场景更稳、更省上下文、更容易续跑，同时尽量避免漏做。

## 工具调用规约（必读 — 不照做会卡 10 分钟超时）

下面 "主流程" 给的 `python3 scripts/...` 是脚本层入口；**Ready typed action 已经把输出准备、spawn 配置、3 小时超时、`run_state.json` 状态追踪和任务投影都接好**。用户显式选择 VEA，或技能身份已高置信命中时，冷启动直接调用选定 typed action，不要先扫历史目录、`vnext_config.json` 或旧 `run_state.json`。

LLM 看到工具名时按下表对应：

- **跑长链路（prepare / score_batches / finalize / 重跑 pipeline）→ 必须优先 typed action**
  - `skill_video_expert_pipeline({url, outputDir?, sceneThreshold?, bestThreshold?})` — 包了 `pipeline_enhanced.py` / `orchestrate_vnext.py`，3 小时超时
  - `skill_video_expert_ai_analyze({sceneScoresPath, mode?})` — 包了 `ai_analyzer.py --mode score_batches/merge_validate`，3 小时超时
- **续跑 / 查看进度 / 诊断 → 优先 `skill_inspect_run_state`**
  - 只在有显式句柄时使用：用户给了 `run_state.json` / `scene_scores.json` / 输出目录、点了任务卡继续、给了 childRunId，或明确要求查进度/历史。
  - 传 `runStatePath` 或 `outputDir`，让 Ready 判断 running / background_running / budget_paused / done，不要先绕 shell。
- **低级诊断 → `skill_read_artifact` 或 `skill_run_shell`**
  - 只在 inspect 不够用时 fallback；不是长链路 fallback。shell 默认 60 秒，硬上限 10 分钟。
- **读 artifact** → `skill_read_artifact`；**写临时报告/scratchpad** → `skill_write_artifact`

反模式（真踩过的坑，不要再重复）：
- ❌ `skill_run_shell({"command": "python3 scripts/pipeline_enhanced.py <url>"})` — 必超时
- ❌ `skill_run_shell({"command": "cd <dir> && python3 scripts/orchestrate_vnext.py ..."})` — 同上
- ❌ typed action 失败后立刻改用 shell 重跑长链路 — 会丢失结构化状态与 3 小时动作契约
- ❌ 看进度先 `cat run_state.json` 或 tail 日志 — 易错过 detached / projection / lease 状态
- ❌ 新视频冷启动前先扫描旧输出目录或旧 `run_state.json` — 会把历史任务误当续跑
- ✅ `skill_video_expert_pipeline({"url": "<url>", "outputDir": "<dir>"})`
- ✅ 想看进度：`skill_inspect_run_state({"runStatePath": "<outputDir>/run_state.json"})`

如果当前会话里**没看到** `skill_video_expert_pipeline` / `skill_video_expert_ai_analyze` 这两个工具：说明 reference-skill hint 还没 arm 上。在回复里显式提到 "video-expert-analyzer" 或 "VEA" 让 hint 上线，下一回合就会看到。

## 先看什么

先读这个文件拿到主规则。只有在确实需要时，再按需读取：

- `README.md`：整体流程与入口命令
- `docs/openclaw_orchestration.md`：只在 OpenClaw 主控 + 子代理接力时再读
- `docs/appendices.md`：平台差异、歌词 OCR、视听路由、异常恢复

## 何时用这个版本

- 用户明确提到 `video-expert-analyzer-vnext`
- 视频较长、scene 很多，或用户强调”别卡死””能续跑””省上下文”
- 需要生成场景评分、分镜表、精选镜头、字幕/歌词校正、视听剖析
- 宿主是 OpenClaw 时，支持主控加当前批次 worker 串行接力

不要默认替换旧版 `video-expert-analyzer`。这个版本优先用于长任务。

**默认行为是一口气自动做完**，不是人工逐批填表。接力模式只在 OpenClaw 场景下启用。

## 冷启动、续跑与历史目录

- **新视频冷启动**：用户给的是视频链接或本地视频文件，且没有显式续跑句柄。Ready 中直接调用 `skill_video_expert_pipeline`；runtime 负责输出准备和状态追踪。不要为了冷启动先扫 `vnext_config.json`、旧输出目录或旧 `run_state.json`。
- **续跑 / 观察 / 诊断**：只有用户给出 `run_state.json`、`scene_scores.json`、输出目录、任务卡继续、childRunId，或明确要求查进度/历史时，才 inspect/read 对应状态和 artifact。
- **历史目录**：如果偶然发现历史任务，但用户没有要求续跑，表述为“检测到历史任务；它不影响这次新的分析”，继续按新分析推进，不要暗示正在恢复旧任务。
- **配置**：Ready 会通过 host requirements 写入当前 agent 的视觉模型配置。只有用户主动要求改输出根目录、报告语言或模型偏好时才讨论配置；不要把配置扫描当作新分析前置步骤。API key 只让用户自己设置环境变量，绝不写进 JSON。
- **finalize 续跑**：用户说“跑 finalize / 再试一次 / 接力完成”且上下文已有 VEA childRun、`run_state.json` 或输出目录时，继续同一个 VEA skill 任务。不要调用 `browser_resume_task`、不要重新做浏览器采集，也不要因为旧任务卡显示失败就改找另一个 browser 任务。

## 默认执行模式

**默认由主流程自己执行评分。** 除非宿主明确是 OpenClaw 并且用了 `--dispatch-json`，否则：

- `score_batches` 会自动读配置、并行看图、直接写回 `host_batches/*-output.json`，不再要求当前 agent 手工逐批补分。
- 首次启动时，优先自动读取本机 OpenClaw 的 `~/.openclaw/agents/*/agent/models.json`；找不到时再看当前环境变量里的 API 配置。
- 如果自动发现不到可用配置，流程必须明确报 `缺少自动评分配置`，并提示如何补，不允许静默退回人工模式。
- 所有批次完成后，自动进入 `finalize` 生成最终输出。
- 整条链路（prepare → score_batches → finalize）应当尽量一口气做完，中间不需要用户干预。

只有当宿主是 OpenClaw 且明确走接力模式时，才按 `docs/openclaw_orchestration.md` 的规则分段执行。

## 不可妥协规则

1. 不允许抽样、跳过，或对没看过的画面做判断。
2. 每个 scene 都必须有独立结果，并及时写回文件。
3. 如果已有 `scene_scores.json`、`run_state.json`、`host_batches/` 或批次 output，优先续跑，不重做已完成阶段。
4. 每次开始前先读 `run_state.json`；只做当前阶段允许的动作，不自己跳步。
5. `score_batches` 的正常路径是自动并行评分，不要再把“当前 agent 自己逐批看图填 JSON”当成默认方案。
6. OpenClaw 子代理接手当前批次后，必须先更新 `receipt.status = "in_progress"`，并写 `started_at`、`updated_at`。
7. 当前批次完成后，必须把 `receipt.status = "completed"`、`has_todo = false`、`worker_summary`、`updated_at`、`completed_at` 写回。
8. 如果素材缺失、截图坏掉、当前批次无法判断，必须写成 `blocked` 并停止，不能假装完成。
9. OpenClaw 主控不要把整条长历史、整份 `scene_scores.json`、所有历史批次一起塞给下一个 worker。
10. 交付是否完成，以 `delivery_report.json` 和实际输出文件为准，不以口头汇报为准。
11. 用户请求里包含 `pdf` 时，任何一个必需 PDF 缺失都不算完成。
12. Windows 上如果本地链路明确报 `HTTP Error 429`，应直接当成平台限流阻塞回报，不要擅自改走浏览器下载、录屏或别的旁路。
13. 禁止用本地 `PIL` / `OpenCV` 的亮度、颜色、对比度特征脚本冒充“已看图”；这类结果只能算失败或诊断，不能算正式评分。
14. 视听剖析默认由脚本用当前运行时文本模型直接完成正文长文，保证产品后台任务可以自动收尾；只有显式设置 `AUDIOVISUAL_REPORT_HANDOFF=1` 时才启用 `audiovisual_handoff/` 接力。遇到 handoff 任务包时必须按序（body → 然后 diagram **或** overview，两者互斥，通常只触发其一）完成，再重新跑 `finalize`。场景截图由脚本在最终 Markdown 中按 Scene 引用自动回填，不需要单独的配图子任务。正文 `body/output.md` 必须逐模块展开：task.md 里"输出骨架"列出的每个 `##` 模块、`###` 子条目都要字面出现，不得合并/省略；除 `## 导读` 外每个 `##` ≥ 700 字、每个 `###` ≥ 180 字、每个 `##` 至少引用 3 个不同 Scene 编号。脚本会在 finalize 时机器校验，不达标会抛 `ValueError`，并把缺项（含每个模块的实际字数与差额）写到 `audiovisual_handoff/body/validation_errors.json`，按错误提示补齐再跑，不要把"已经写过"当成"合规"。
15. 正文第一个模块必须是 `## 导读`：写给普通观众的总-分速读。先用 2-3 句白话回答该类型的"价值问题"（task.md 会给出默认问题；**如果用户在对话里明确表达过自己的关注点——比如"想看看这访谈聊了什么观点"——导读必须优先回答用户的问题**，默认问题退为兜底），再列 2-4 条亮点（一句话结论 + Scene 编号/时间码）。允许否定或中性结论，不要强行夸。导读受上限约束：默认 ≤400 字、≥2 处 Scene/时间码引用、禁止"双轴""路由""冯·雷斯托夫""加权分"这类框架术语——机器校验会打回。
16. 脚本自动插入的场景截图只能来自当前视频目录的截图目录，不得凭空编造；导读、路由判断、结构图/总览图、尾部总结块、评分表、代码块和表格内部不插图，同一张截图不会重复刷屏。
17. Handoff `receipt.json` 会记录每个子任务的 `input_hash`；当分类结果或 prompt 变化时，已有 `output.md/svg/json` 会被自动作废，需要重新生成。若 receipt 里某任务是 `validation_failed`，说明上次输出没过机器校验，先看 `brief.md` 里的失败原因和 `validation_errors.json` 的逐模块差额，改完再跑 finalize。
18. 补完 handoff 正文不等于任务完成。完成标准始终是 `run_state.json` 与 `delivery_report.json` 都确认通过，并且必需的 `*_audiovisual_analysis.md` / `.pdf` 真实存在。旧 blocked childRun 如果已被新的 childRun 完成，应视为 superseded，不要继续围绕旧卡重试。

## OpenClaw 主控原则（仅 OpenClaw 接力场景适用）

只有宿主明确是 OpenClaw 并且走接力模式时，才适用以下原则：

1. 跑总控入口
2. 读 `run_state.json`
3. 优先直接跑 `python3 scripts/orchestrate_vnext.py /path/to/scene_scores.json --dispatch-json`
4. 如果确实只想单独取派单包，再跑 `python3 scripts/openclaw_dispatch.py /path/to/scene_scores.json`
5. 只把当前批次四件套交给一个短生命周期 worker
6. worker 写回后，主控重新跑总控入口；需要时再取新的派单包

默认采用”单主控 + 单当前批次 worker”的串行接力，不要同时派两个批次。

**如果不是 OpenClaw 接力场景，忽略这一节，直接按”默认执行模式”自己完成。**

## 主流程

### 0. 总控入口

新视频任务在 Ready 中优先走 typed action；下面命令是脚本层入口，仅用于非 Ready 宿主、诊断或说明脚本能力。

优先使用：

```bash
python3 scripts/orchestrate_vnext.py "<视频链接或本地视频>"
python3 scripts/orchestrate_vnext.py /path/to/scene_scores.json
```

总控负责准备素材、续跑到正确阶段，并在已有结果上自动接着走。

### 1. Prepare

```bash
python3 scripts/pipeline_enhanced.py "<视频链接或本地视频>"
```

这一步负责下载或读取视频、切场景、抽主截图、提字幕或转写，并初始化：

- `scene_scores.json`
- `run_state.json`
- `scene_reports/` 草稿
- 当前批次任务包

Windows 上处理 YouTube / Bilibili 时，也必须先走这条本地 pipeline。不要因为 `yt-dlp` 命令名一时不可见，就改走浏览器、录屏或手动搬运。

### 2. Score Batches

```bash
python3 scripts/ai_analyzer.py /path/to/scene_scores.json --mode score_batches
```

这一阶段会自动处理批次分析：

- 先读 `run_state.json`
- 自动发现可用模型配置
- 并行读取每个 scene 的 `primary / start / mid / end` 帧
- 直接写回对应的 `batch-XXX-output.json`
- 自动合并、校验覆盖率，并在条件满足时进入 `finalize`

当前批次最小任务包只有四个文件：

- `batch-XXX-brief.md`
- `batch-XXX-contact-sheet.png`
- `batch-XXX-input.json`
- `batch-XXX-output.json`

**默认模式**：自动并行评分，不需要当前 agent 手工逐批看图填结果。

**OpenClaw 接力模式**：只在明确走 `--dispatch-json` 时使用；主控仍以自动链路为主，子代理只接手被派发的那一小段工作。

### 3. Merge / Validate

```bash
python3 scripts/ai_analyzer.py /path/to/scene_scores.json --mode merge_validate
```

这一步负责合并批次结果，检查覆盖率，并优先修正旧数据里的资源路径或缺失截图问题。

### 4. Finalize

```bash
python3 scripts/ai_analyzer.py /path/to/scene_scores.json --mode finalize
```

只有在覆盖率完整、资源齐全、没有 `blocked`、没有 `needs_review`、也没有本地特征兜底痕迹后，才进入这一步。

这一步除了正式输出，还会自动生成给路由子 skill 使用的轻量分类摘要：

- `*_classification_summary.md`
- `*_classification_summary.json`
- `classification_result.json`

其中：
- 分类摘要直接来自结构化结果，不额外跑模型，默认把全片切成约 21 组前 / 中 / 后分段信号。
- `classification_result.json` 会继续调用子路由逻辑，成为主流程后续视听报告的正式路由来源。

#### 4.1 视听剖析 Agent 接力

`finalize` 生成视听剖析（`*_audiovisual_analysis.*`）时，会按子类型路由触发最多三个交由 agent 完成的子任务：

- `body`：完整的视听剖析正文 Markdown
- `diagram`：SVG 结构图（仅支持该能力的子类型）
- `overview`：MV 内容架构总览 JSON（仅音乐/MV 路由）

场景截图不再作为 handoff 子任务交给 agent 改写 Markdown；脚本会在最终 Markdown 中按 Scene 引用确定性插入对应截图，并自动补图注。

脚本为每个子任务按顺序写一个任务包到 `audiovisual_handoff/<subtask>/task.md`，并把当次 `run_state` 标成 `blocked`（`pending_task = await_audiovisual_agent`），同时抛 `AudiovisualHandoffPending`。这是运行 skill 的 agent（也就是你）应当：

1. 打开 `audiovisual_handoff/brief.md` 看整体状态，再读当前 `status = pending` 子任务的 `task.md`，严格按其中的 system prompt / user message 生成内容。
2. 把结果写入 task.md 指定的输出文件：
   - `body/output.md` — 只写正文 Markdown，保留 prompt 要求的所有 `##` 章节标题，不要额外加顶层 `#` 标题。
   - `diagram/output.svg` — 只写合法的 `<svg>...</svg>` 源码，不要反引号或说明文字。
   - `overview/output.json` — 只写 JSON 对象，字段严格按 prompt 描述，不要代码块围栏。
3. 完成后重新执行 `python3 scripts/ai_analyzer.py <scene_scores.json> --mode finalize`。脚本会读取你刚写入的输出文件，把该子任务标成 `completed`，然后推进到下一个子任务或完成剩余的交付物。
4. 不要手工改 `audiovisual_handoff/receipt.json`；脚本会自己维护。也不要用 `python3 - <<'PY' ...` 这类 heredoc 绕过 — harness 的 exec preflight 会拦，改了也会被下一次 finalize 覆盖，只需让脚本自己推进。
5. 如果某个子任务连续两次都缺关键素材，先排查素材问题，再回到这里重新跑；不要造一份占位文本塞进 `output.*`，那样会污染最终报告。
6. 子任务触发顺序是 body → (diagram 或 overview，两者互斥，由路由能力决定，多数情况只会触发一个)。场景截图由 finalize 在已经拼好路由判断块和结构图/总览图的近终态 Markdown 上自动回填，所以若 body 或 diagram/overview 需要重跑，只需删除对应 `output.*` 并重新跑 finalize。
7. 视频目录名常含弯引号/特殊字符（例如 `‘GO’`、`’s`、`—`）。读取 `audiovisual_handoff/` 下的文件时，**只从脚本打印的错误信息或 `brief.md` 顶部的"Handoff 目录"绝对路径按原样复制**，不要自己重敲 —— 手敲时很容易把 `‘’` 改写成 `''`，导致 `ENOENT`。如果连续两次 ENOENT，先 `ls` 实际视频目录核对字符，再继续。

## 完成标准

最终至少应落出这些结果：

- `scene_scores.json`
- `scene_reports/`
- `*_detailed_analysis.md`
- `*_complete_analysis.md`
- `*_classification_summary.*`
- `classification_result.json`
- `*_storyboard.*`
- `*_storyboard_context.*`
- `*_audiovisual_analysis.*`
- `scenes/best_shots/`
- `delivery_report.json`

## 交付前检查

至少确认：

1. `run_state.json` 已更新到正确阶段，没有脏的 `next_batch`
2. 当前批次 coverage 和 `scene_scores.json` 完成情况一致
3. 当前要求的结果文件都已经真实存在
4. 如果用户请求了 PDF，对应 PDF 确实存在且不是空文件
5. 只要还有 `blocked`、`needs_review`、本地特征兜底痕迹、缺文件、缺图或缺 PDF，就不能报完成
6. 目标语言非中文时，`delivery_report.json` 的 `language_mismatch_outputs` 必须为空——它非空说明四类最终报告还有没翻完的中文稿，不能报完成
7. 如果是人工确认素材问题已解决后要重试 blocked 批次，用 `python3 scripts/ai_analyzer.py <scene_scores.json> --unblock --mode score_batches`，不要手改 JSON

## 环境变量与调参

以下环境变量控制脚本行为，仅在需要时覆盖默认：

- `OPENCLAW_ROOT`：覆盖 OpenClaw 根目录（默认 `~/.openclaw`）。
- `OPENCLAW_MODELS_JSON`：覆盖 `models.json` 完整路径（默认 `$OPENCLAW_ROOT/agents/main/agent/models.json`）。
- `VNEXT_STALE_MINUTES`：当前 worker 超过该分钟数未更新 `heartbeat_at`/`updated_at`/`started_at` 时，`reset_stale_in_progress_receipts` 会把 `receipt.status` 从 `in_progress` 重置为 `pending`（默认 30）。
- `VNEXT_TEXT_MODEL_RETRIES`：`request_text_with_runtime` 对单个 provider 的瞬时错误（按 HTTP 状态码判定：408/409/429/5xx 重试，其它 4xx 直接失败）重试次数（默认 2，指数退避 1s → 2s → 4s）。
- `VNEXT_VISION_MAX_EDGE`：发给视觉模型前把帧图缩到的最长边像素（默认 1568 ≈ 主流供应商的服务端摄入上限；超出部分供应商也会丢弃，只浪费上传）。
- `VNEXT_VISION_JPEG_QUALITY`：缩放重编码的 JPEG 质量（默认 85）。
- `VNEXT_VISION_RAW`：设为 `1` 完全跳过缩放压缩，按原始字节直传。
- `VNEXT_TYPE_WEIGHT_SOFTENING`：场景类型权重的软混合系数 α（默认 0.4；有效权重 = (1-α)·类型档位 + α·均匀权重，设 0 还原硬切换）。
- `AUDIOVISUAL_SUMMARY_MAX_CHARS` / `AUDIOVISUAL_SUMMARY_MIN_SCENE_EVIDENCE`：导读模块的字数上限（默认 400）与最少 Scene/时间码引用数（默认 2）。
- `AUDIOVISUAL_REPORT_HANDOFF`：设为 `1` 时启用 agent handoff；默认关闭，产品后台任务直接生成完整报告。
- `AUDIOVISUAL_REPORT_MAX_TOKENS` / `AUDIOVISUAL_REPORT_MODEL`：视听剖析正文生成时直连文本模型的上限 / 模型名（仅在未启用 handoff 架构时生效）。

## 按需补充

- OpenClaw 接力规则：`docs/openclaw_orchestration.md`
- 平台差异、OCR、视听路由、异常恢复：`docs/appendices.md`
