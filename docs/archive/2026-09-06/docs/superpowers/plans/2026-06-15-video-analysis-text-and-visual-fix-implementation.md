---
title: 视频拖拽分析修复（文案截断 + 视觉视听正文卡死 + 任务状态桥）
date: 2026-06-15
status: approved v2 — 用户补充决策已并入（结构化稿走模型分段建议+代码保留全文；视听报告先止血复测，不预先分模块）
owner: 白
revision_history:
  - v1 (2026-06-15): Claude 初稿 + Codex 复核，定位文案输出截断、视觉 finalize 超时、任务状态桥断裂。
  - v2 (2026-06-15): 并入用户补充决策：结构化稿采用模型分段建议 + 代码保留全文；视听报告先做超时/重试止血并真实复测，若复测仍不过再追加分模块生成，不作为本轮默认实施项。同时补齐 run_state 子目录与 child/task 身份不对齐的状态桥缺口。
enforce: false
implementer: codex
related:
  - assets/embedded-skills/video-copy-analyzer/
  - assets/embedded-skills/video-expert-analyzer/
  - src/main/modules/rss-engine/
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# 视频拖拽分析修复实施方案

> 面向实施者（codex）：本文件是经过双方（Claude + Codex）复核，并吸收用户补充决策后的最终方案。按「实施顺序」一节自上而下做，不要先碰无关重构。每条修复都给了根因、改动点（文件:函数/行）、目标行为、验收标准。行号以当前 HEAD + 工作区为准，实施时以符号为准、行号仅作定位。

## 0. 背景与症状

用户从浏览器模块把标签页拖到文件管理区，对同一类视频分别用「文案分析」「视觉分析」：

- **文案分析**：返回"顺利完成"，但校正文稿只有约 8 分钟内容，原视频 15 分钟，缺一大半。
- **视觉分析**：任务卡一直停在 22%，没有新进度，也没有额外进程。

两条链路入口（拖拽路由）：`src/renderer/components/layout/fileTreeExternalDrop.ts` → `rss:startItemAnalysis`（action `copy` / `visual`）→ `src/main/modules/rss-engine/item-analysis-manager.ts` 的 `runCopyFlow` / `runVisualFlow`。

## 1. 实测取证（地面真相，非推断）

样本：`一万块钱买个iPad mini`（BV1zBEr6AEnE，时长 15:32）走文案；`小小HYROX`（BV1shJP6TEEQ，时长 36s）走视觉。

文案侧：

| 环节 | 实测 | 结论 |
| --- | --- | --- |
| 原始 SRT（B 站 API 字幕） | 444 条，覆盖到 `00:15:32` | 完整 |
| 喂给 LLM 的输入转写 | 5024 字（< 8000 字裁切线） | 模型看到了全文 |
| 输出的 `_文字稿.md`（校正稿） | 在「华为是真的把能够做到的一切」断句中止 | 截断 |
| 断点位置 | 对应 SRT `00:08:17`，= 全文 51%（2572/5024 字） | 即"8 分钟左右" |
| `_结构化文字稿.md` | 停在同一句 | 继承截断 |
| `文案分析报告.md` | 结构完整（基于摘要，非整篇复现） | 正常 |

结论：原始字幕完整，**截断发生在"校正文稿"这次模型调用的输出预算上**，不是字幕、不是下载、不是输入裁切。

视觉侧（`visual-analysis/BV1shJP6TEEQ/run_state.json`）：

```
status: "blocked", current_stage: "finalize",
total_scenes: 21, completed_scenes: 21, coverage_ratio: 1.0,
last_error: "视听剖析生成失败：文本模型调用失败：mimo/mimo-v2.5: APITimeoutError: Request timed out…",
missing_outputs: ["audiovisual_md", "audiovisual_pdf"]
```

结论：视觉链路**没有卡在 prepare**，而是跑完了全部 21 个场景评分 + storyboard + 分类 + 详析，**只差最后一步"视听剖析正文"**，因文本模型超时被判 blocked。任务卡的 22% 与内部真实状态完全脱节。

## 2. 根因（三条）

### 根因 A — 文案：整篇逐字复现压在单次小输出预算上
- `src/main/modules/rss-engine/subagent-runner.ts` `correctCopyTranscript()`：把"逐字校正整篇文稿"作为**单次** LLM 调用，`maxTokens: 1_600`（重试仅 `2_400`，且只在形状校验失败时触发）。1600 token ≈ 2700 中文字 ≈ 8 分钟内容 → 在 51% 处断句停笔。
- `structureCopyTranscript()` 同样整篇复现，`maxTokens: 1_800/2_400` → 同类截断。
- 完整性护栏形同虚设：`hasCorrectedTranscriptShape()` 只要求输出 ≥ 源文 **25%**（`subagent-runner.ts` `minLength = floor(sourceLength*0.25)`）；`hasStructuredTranscriptShape()` 阈值 45%。51% 的半截稿轻松"达标"，不重试、判成功（"失败要响亮"被违反）。
- `summarizeCopy()` 是分析（判断题），有界输出合理，**不在修复范围**。

### 根因 B — 视觉：视听正文单次 16k token 大调用压在 90s 客户端超时上
- `video_expert_pipeline` → `scripts/ready_compat.py` `_build_pipeline_cmd` → `scripts/orchestrate_vnext.py <url>`，跑全链路 `_run_pipeline_flow`(prepare) + `_run_ai_flow(--mode auto)`(评分→merge→**finalize**)。
- finalize 调 `scripts/ai_analyzer.py:1995` `generate_audiovisual_report_outputs` 生成视听正文。
- 正文是**单次大调用**：`scripts/audiovisual/reporting/template_engine.py` `_request_agent_report` → `request_text_with_runtime(..., max_output_tokens=AUDIOVISUAL_REPORT_MAX_TOKENS)`，工作区里该默认值刚从 4000 改为 **16000**。
- 文本运行时客户端超时硬编码 **90s**：`scripts/text_model_runtime.py` `DEFAULT_REQUEST_TIMEOUT_SECONDS = 90.0`（三处 `_call_*` 都用它），瞬时错误重试 2 次。16k token 长文在 90s 内不可能返回 → `APITimeoutError` ×3 → `文本模型调用失败` → finalize 捕获 → `mark_blocked_state` → run_state blocked。
- 工作区另有未提交改动：把视听正文从 agent handoff 改为脚本直连（`AUDIOVISUAL_REPORT_HANDOFF` 默认关、coordinator 变 `None`），并加了一次校验失败后的 repair 重试（又一次 16k 调用）。**这条新默认路径正是现在超时的那条**；repair 会进一步放大时延。

### 根因 C — 任务状态桥断裂：外层 job 进度与内层 run_state 完全脱节
- 渲染层进度靠轮询 `rss:getItemAnalysisProgress` → `getItemProgress()`，返回的是 job 存储的 `progress` 字段。
- 该 `progress` 是 `runVisualFlow` 里**硬编码**的 `20/22/64/92/98`（`updateJob`）：22 设在第一个 `awaitVeaChildRun(video_expert_pipeline)` **之前**（资源复用分支），下一档 64 在它**返回之后**。因为整条 finalize 跑在这第一个 child run 内部，它 blocked 时进度永远到不了 64。
- `item-analysis-manager.ts` **从不读 child 的 `run_state.json`**（全文唯一出现是一处注释）。所以内部 21/21、coverage 1.0、blocked + last_error 这些真实状态，外层 job 一无所知。
- `executeJob` 的 catch（`item-analysis-manager.ts`）把一切抛错塌缩成 `status:'failed'` 且**不动 progress** → 失败后进度条仍冻结在 22；`translateVeaCloseToError` 已区分的 `veaCause`（blocked/paused/failed/killed）被丢弃；`run_state.last_error` 不上浮。
- "进程没暴露" = python 子进程写完 blocked 已退出。"一直卡 22%" = 失败前超时重试空转 + 失败后进度冻结 + 错误不上浮，三者叠加。

> 命中 `CLAUDE.md` 硬约束："任务卡 UI 只消费 projection 派生状态；renderer 不新增本地猜测""后台任务终态必须经 TaskEventBridge 推回"。当前 RSS 分析 job 的进度是手搓常量、不是 child run 真实状态的派生，桥是断的。

## 3. 修复总原则
- 不让模型一次性复写/生成超长文本；长文本的**覆盖由代码保证**，模型只做有界判断或有界分段生成。
- 预算是硬限制：调用预算（token/超时）要与产出规模匹配，且失败可观测、可续跑。
- 手术式改动：只碰文案两个 builder、视听正文超时/重试参数、视觉 job 的状态桥；不顺手重构。视听正文分模块生成不作为本轮默认实施，只有复测仍失败才追加。
- 每条修复落到行为测试或 gate。

## 4. 修复清单（按实施顺序）

### 第 1 刀：文案完整性（根因 A）—— 必须做，方向不可妥协

**1.1 `correctCopyTranscript` 改为代码驱动的分块校正**
- 代码把 `extractedText` 按句/行边界切成有序块，目标 ~1200–1500 字/块。
- 每块单独调用 `complete()`（沿用现有校正 system prompt），`maxTokens` 按块大小给足（约 1.5× 块字数 + 余量），`timeoutMs` 适中（90–120s）。
- 逐块按序拼接为完整校正稿。**覆盖由代码保证**：任一块返回空、或 `getMarkdownBodyLength(resp) < 该块正文 ×0.8`（疑似截断/拒答）→ **回退该块原文**，绝不丢内容。
- 删除输入侧 `clipText(extractedText, 8_000)`（分块要吃全文）。
- 短稿（≤1 块）保留原单次快路径，避免给 36s 视频过度工程化。
- 边界质量：按句界切分；可选把上一块尾句作为只读上下文喂入，缓解同音字判断的上下文丢失（不强制）。

**1.2 `structureCopyTranscript` 改为"模型只做有界分段建议 + 代码保留全文"**
- 模型只输出**小体量分段计划**：对（已完整的）校正稿，返回若干 `{split_line_index, section_title}`（建议用行号而非锚句，匹配更稳）。输出量小，截断不可能。
- 代码据分段计划，把校正稿**逐字**按行切段、插 `## 一、<title>` 等标题归段 → 全覆盖。
- 分段计划为空/非法 → 回退现有 `buildFallbackStructuredTranscript`（单段"## 一、完整口播"含全文），仍然完整。
- 不再让模型整篇复写一遍结构化稿。

**1.3 收紧完整性护栏（失败要响亮）**
- `hasCorrectedTranscriptShape` 最低覆盖率 25% → ~80%；不达标即判不完整、进重试/回退原文。
- `hasStructuredTranscriptShape` 参照基准改为**源文**、阈值上调（~70%）。
- 安全性质：阈值提高只会让"未校正但完整的原文兜底"顶上 → worst case = 完整原文，**严格优于半截校正稿，不会因收紧丢任何内容**。

**验收**：15 分钟级转写（≥5000 字）经 `buildCopyDeliverables`，校正稿与结构化稿覆盖 ≈100%（用源文末尾内容做断言）；半截模型输出被判不完整并回退到全覆盖。

### 第 2 刀：视觉可观测性 + 任务状态桥（根因 C）—— 先于报告修复

**2.1 把外层 job 进度改为 child run 真实状态的派生（修断桥）**
- `runVisualFlow` 在 `awaitVeaChildRun` 等待期间，周期性读取 child 的 `run_state.json`，把 `current_stage` + `coverage_ratio` + `completed_scenes/total_scenes` 映射到 job 的 `progress/message`：
  - prepare → ~20–40%；score_batches → 40–85%（按 coverage_ratio 线性）；finalize → 85–99%。
- run_state 路径解析：pipeline 会在 `outputDir` 下建以 video-id 命名的子目录（实测 run_state 在 `visual-analysis/BV.../run_state.json`）。复用现有 `findFileByName(outputDir, 'scene_scores.json')` 同款查找定位 `run_state.json`，不要假设它就在 `outputDir` 根。
- 身份对齐必须闭合：当前通用进度桥对 `video_expert_pipeline` 启用 child-run 严格匹配，但 VEA 写出的 `run_state.json` 里没有 `child_run_id/task_id`，因此即便找到子目录状态，也可能被 strictChildRunId 过滤掉。实施时二选一闭合：
  1. VEA 在 `run_state.json` 写入 Ready 注入的 `READY_SKILL_CHILD_RUN_ID` / `READY_SKILL_TASK_ID`；
  2. 或 child runner 使用 ready_compat 已解析出的真实 `outputDir/runStatePath` 作为可信句柄，并同步更新任务记录。
- 禁止继续只记录根目录 `visual-analysis/run_state.json`：终态、进度、产物路径必须指向真实视频子目录，否则下次仍会出现内部完成、外部 22% 的错位。
- 这是 projection 派生，符合"任务卡只消费派生状态"，替代硬编码 22/64。

**2.2 终态诚实上浮 + 区分 blocked/failed**
- `executeJob` catch 读取抛错上的 `veaCause`，映射为不同 job 状态/文案，不要一律塌缩成 `failed` 且冻结 progress。
- blocked（差视听正文）场景：进度反映真实完成度（如 ~90%，而非 22），文案明确"已完成 21/21 场景评分，最后一步视听剖析正文生成失败，可重试/可续跑"，并把 `run_state.last_error` 上浮到任务卡。
- 给"重试/续跑"出口。该 run 在脚本层本就可续跑（重跑 finalize 只补正文，其它缓存命中）；**不擅自自动重跑执行类动作**（守自动续跑纪律），由用户显式触发。

**2.3 生命周期对齐（避免双记录互相矛盾）**
- 审查 `startSkillChildRunAndWait`（`veaChildAwait`）：child run 在 skills-runtime/task tracker 里的记录，与 RSS job 记录，在 blocked/failed 终态时不得并存为 `failed` + `running/suspended`。终态以单一真相收口，二者一致。
- 实施时按 `CLAUDE.md`"后台任务终态必须经 TaskEventBridge 推回"核对：child 终态是否正确推回并反映到 job/projection。

**验收**：构造一个 child run 在 finalize 返回 blocked 的桩，断言：等待期 job 进度随真实子目录 run_state 推进（非冻结 22）；终态 job 状态为可区分的 blocked、progress 反映真实完成度、last_error 上浮；记录里的 `outputDir/runStatePath` 指向真实视频子目录；child run 与 job 无矛盾双记录。

### 第 3 刀：视听正文先止血复测（根因 B）—— 本轮不默认分模块

用户补充决策：**视听报告先不做分模块**。先修实测已命中的超时/重试配置，真实复测能通过就收口；复测仍不能通过，再追加分模块生成。

**3.1 让视听正文调用的超时/重试与当前输出预算匹配**
- 给 `request_text_with_runtime` 加可选 `request_timeout_seconds`，透传到三处 `_call_*`（替换硬编码 `DEFAULT_REQUEST_TIMEOUT_SECONDS=90`）。
- `_request_agent_report` 传入专用超时（新 env `AUDIOVISUAL_REPORT_TIMEOUT_SECONDS`，默认建议 300–360s），先保持现有报告结构，不预先拆模块。
- 给这类长调用增加 per-call retry 控制（0/1 次），避免 90s × 多次退避式空转；超时后要快速进入可观测 blocked，而不是长时间假卡住。
- repair 重试也必须受同一超时/重试预算控制；模型调用超时本身不应触发另一轮同体量 16k repair。

**3.2 真实复测闸门**
- 用这次实测失败的视觉样本重新跑端到端视觉分析。
- 若生成 `audiovisual_md` + `audiovisual_pdf`，且任务卡能显示真实进度与完成状态，本轮不再做分模块。
- 若仍然因为超时、长度、校验失败导致 blocked，再开启"视听正文分模块生成"后续工单：按 `required_sections` 逐模块调用、逐模块校验/repair、最终组装报告。

**验收**：桩测试确认视听正文调用带入专用超时/重试预算；真实样本复测生成 `audiovisual_md` + `audiovisual_pdf`，且 finalize 不再 blocked。若复测失败，必须停下补充证据并转入分模块工单，不允许继续用更大的超时硬赌。

### 第 4 刀（复测后决策项）：是否给视听正文指定更强文本模型
- `AUDIOVISUAL_REPORT_MODEL`（默认 `claude-sonnet-4-5`）**只在旧 `client` 路径生效，运行时路径被忽略**（`template_engine.py` `_request_agent_report` 两条分支）。产品路径实际用 `resolve_auto_scoring_config()` 的 `mimo-v2.5`。
- 若第 3 刀复测后 mimo 长文质量/速度仍不足，再决定是否让运行时路径也能优先走更强文本模型（让该 env 在运行时路径生效，或在 attempt order 里优先稳的文本模型）。**先做超时/重试止血并复测，再据实测决定是否动模型或分模块**。

## 5. 不纳入本次（潜在缺口，单独排期）
- **FunASR Nano 无 VAD 截断**：`video-copy-analyzer/scripts/extract_subtitle_funasr.py` Nano 路径（`model.generate(input=[audio_path], itn=True, language="中文")`）不挂 VAD，长音频会被模型最大长度截断；回退 paraformer 路径才有 `vad_model` + `batch_size_s=300`。本次样本走 B 站 API 完整字幕未踩到，但 YouTube/无 CC 场景会踩。属另一类缺口，单独处理。
- **输入侧 8000 字裁切**：本次未踩中（5024<8000），且第 1 刀已删除该裁切；列此仅作记录。
- **视听正文分模块生成**：不作为本轮默认实施；仅当第 3 刀复测仍失败时，作为下一工单打开。

## 6. 涉及文件
- 文案：`src/main/modules/rss-engine/subagent-runner.ts`（`correctCopyTranscript`/`structureCopyTranscript`/两个 shape 助手 + 分块助手）。
- 视觉脚本：`assets/embedded-skills/video-expert-analyzer/scripts/text_model_runtime.py`（超时/重试参数透传）、`assets/embedded-skills/video-expert-analyzer/scripts/audiovisual/reporting/template_engine.py`（视听正文专用超时入参、repair 预算约束）、`assets/embedded-skills/video-expert-analyzer/scripts/run_state.py` / `pipeline_enhanced.py`（如采用写入 child/task 身份的闭合路线）。
- 视觉外层：`src/main/modules/rss-engine/item-analysis-manager.ts`（`runVisualFlow` 进度派生、`executeJob` 终态映射、run_state 读取、生命周期对齐）、必要时 `src/main/modules/agent-control/skills/skill-child-runner.ts` / `task-projection/run-state-selection.ts`（如采用可信句柄闭合路线）。
- 测试：`src/__tests__/embedded-skill-video-copy-migration.test.ts`、`src/__tests__/embedded-skill-video-expert-vnext-swap.test.ts`（按需新增行为用例）。

## 7. 测试与验证
- 文案行为测试：长转写 + 遵守 max_tokens 的桩模型 → 断言覆盖 ≈100%；半截输出被拒并回退全覆盖。
- 视觉桩测试：blocked 路径下进度随真实子目录 run_state 推进、终态可区分且 last_error 上浮；视听正文调用带专用超时/重试预算。
- 回归：`npm run typecheck`；上述两个测试文件；`npm run verify:native`（subagent 走 settings 读 `ai_model_config`；视觉 run_state 落 SQLite/文件链路）。
- 真机 dogfood：对 15 分钟真视频端到端跑文案（确认全文）+ 视觉（确认收尾出 `audiovisual_md/pdf`，任务卡进度真实）。

## 8. 实施顺序（codex 按此推进）
1. 文案完整性：分块校正 + 全文兜底 + 收紧成功判断（第 1 刀）。
2. 视觉可观测性 + 状态桥：进度派生自 run_state、终态诚实、生命周期对齐（第 2 刀）。
3. 视听正文超时/重试止血 + 真实复测（第 3 刀）；复测通过则停止，不做分模块。
4. 若复测失败，再开分模块生成或更强文本模型的后续决策（第 4 刀）。
- 不先碰无关重构；每刀完成后跑对应测试与 `typecheck`。

## 9. 已确认决策
1. 结构化稿：走「模型分段建议 + 代码保留全文」，不让模型整篇复写结构化稿。
2. 视听正文：先不做分模块；先修超时/重试并复测，能通过就不再扩大改动。
3. 若视听正文复测仍失败，再基于失败证据决定分模块生成或指定更强文本模型。
