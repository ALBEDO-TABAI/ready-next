---
title: 视听报告场景插图回补（确定性代码插图，广泛适用）
date: 2026-06-15
status: ready-for-implementation
owner: 白
implementer: codex
enforce: false
related:
  - assets/embedded-skills/video-expert-analyzer/scripts/audiovisual/reporting/builder.py
  - assets/embedded-skills/video-expert-analyzer/scripts/audiovisual/reporting/template_engine.py
  - assets/embedded-skills/video-expert-analyzer/SKILL.md
supersedes_decision:
  - 此前 handoff→脚本直连重构把场景插图（illustrate）整步关在了 AUDIOVISUAL_REPORT_HANDOFF 后面，默认链路不插场景截图。
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# 视听报告场景插图回补实施方案

> 面向实施者（codex）：这是一份**独立**修复计划，只解决"最终视听剖析报告里没有把场景截图插到对应位置"。核心要求三条：**①不引入新缺口；②不破坏现有功能（含 handoff 模式、PDF、其它路由）；③把插图以广泛适用、确定性的方式正确回补进最终报告（md + pdf，所有 child_type 路由通用）。** 行号以当前工作区为准，实施时以符号为准。

## 0. 背景与症状
视觉分析现在能跑完，但最终 `*_audiovisual_analysis.md/.pdf` 正文里没有场景截图，只有开头 1 张结构图。模型在正文里大量引用了 `Scene NNN`，截图文件也都在，但就是没插回正文。

## 1. 实测取证（地面真相）
样本：`小小HYROX`（BV1shJP6TEEQ）刚跑完的报告（`visual-analysis/[飓风商店MediaStore] 小小HYROX，拿捏！/`）：
- 报告 119 行，**仅 1 张图**：`![…结构图](<BV1shJP6TEEQ_audiovisual_structure.png>)`（来自结构图/总览图 prepend 机制，正常）。
- 正文引用 **17 个不同场景**，格式统一为 `Scene NNN`（`_scene_refs` 输出 `Scene {num:03d}`）：`Scene 001`×6 … `Scene 021`×8。
- 截图**存在且与报告同目录**：`frames/BV1shJP6TEEQ-Scene-001.jpg … Scene-021`（84 个帧文件）。
- 解析器 `_scene_screenshot()` 读 `storyboard.screenshot_path`，实测为上述存在的绝对路径 → `_build_scene_image_catalog()` 能建出 21 条非空目录。

结论：**不是素材缺失，不是路径错配，不是生成失败**。是默认链路根本没跑场景插图步骤。

## 2. 根因
- `builder.py` `_maybe_illustrate_markdown()` 第一行 `if coordinator is None: return markdown_text`；而 `coordinator` 仅在 `AUDIOVISUAL_REPORT_HANDOFF=1` 时创建（`generate_audiovisual_report_outputs`，约 510-514 行）。handoff→脚本直连重构后，产品默认 `coordinator=None` → **整个场景插图步骤被跳过**。
- 次要：即便在 handoff 模式下，现有 illustrate 也是**让模型重写 markdown 插图**（`coordinator.request_illustrate(...)`，约 481 行）——慢且不稳，正是要避免的"模型做可重复编辑"反模式。
- 澄清一处（修正先前表述）：`<!-- FIGURE:xxx -->` 占位机制是给**正文内代表镜头图解**的，不是给开头结构图/总览图的；开头结构图/总览图由 `prepend_report_diagram` / `prepend_mv_overview` 单独插入。场景截图正文回补历来只走 illustrate 这一条路 —— 现在这条路被关了。所以是"把唯一的场景插图路接回默认链路"，不是"改结构图机制"。

## 3. 修复总原则
- **可重复转换由代码承担**：把"扫描正文 Scene 引用 → 选图 → 插到对应段后"改成确定性代码后处理，彻底不依赖模型/coordinator。
- **复用现有机件**，只替换"插哪、插不插"的决策（模型 → 代码）；其余规则（目录、去重校验、尾部清理、图注、链接规范化）原样保留。
- **插图是增强，不是交付门槛**：任何插图异常都降级为"未插图但完整的正文"，**绝不因插图问题把 finalize 重新打成 blocked**。
- **广泛适用**：在唯一汇聚点 `generate_audiovisual_report_outputs` 接入，路由无关；md 与 pdf 同源跟随。
- 手术式：只碰 `builder.py` 插图段、`template_engine.py`/`SKILL.md` 的相关措辞与少量常量；不顺手重构其它。

## 4. 修复方案

### 4.1 新增确定性插图函数（核心）
在 `builder.py` 新增 `_illustrate_scene_screenshots(markdown_text, data, report_dir) -> str`，逐段扫描、确定性插图。**完整复刻**现模型 prompt（`_ILLUSTRATE_SYSTEM_PROMPT` + `_build_illustrate_user_message`）里列出的规则：

输入与准备：
- `catalog = _build_scene_image_catalog(data, report_dir)`；**`catalog` 为空直接原样返回**（保持"无图不插"）。
- `by_scene = {it["scene_number"]: it for it in catalog}`；`pre_existing = set(_extract_image_paths(markdown_text))`。
- 计算"可插区"上界：`trailing_start = _find_trailing_zone_start(lines)`（尾部 `> **视听对齐度**…` 总结块 + 最终评分表之后一律不插）。
- 跳过模块集合（**复用现有常量/标题，勿硬编码新串**）：`_value_focus.SUMMARY_SECTION_HEADING`（`## 导读`）、`## 路由判断`（`_route_judgement_block`）、`## 视听剖析概览`、`## 视频结构图`、`## 视频内容架构总览`。

逐块遍历（按空行分块，同时跟踪状态）：
- 维护：`current_heading`（最近的 `##`，判断是否在跳过集合）、`in_code_fence`(```` ``` ````)、当前块是否表格（行首 `|`）、`recent`（最近已插的 rel_path 队列，长度 3）。
- 命中跳过模块 / 代码块内 / 表格块 / `idx >= trailing_start` / 标题行本身 → 只输出、不插图。
- 对"可插段"（自然段或列表项）：
  1. 正则抓 `Scene NNN`：`re.compile(r"Scene\s*0*(\d+)")`，仅保留 `int(n) in by_scene` 的命中（**目录外/无截图的编号直接跳过，绝不编造**）。
  2. 选图：单个引用→该图；多个引用→优先取段落里第一个未在 `recent` 队列内的 Scene；若段落是并列列举且前序候选都不可用，再用加权分（`item["weighted"]`）作补充排序；都被去重命中则跳过本段。（正文引用顺序通常就是分析顺序，避免高分尾声镜头反复抢位置。）
  3. 去重：所选 `rel_path` 在 `recent`（连续 3 段）内、或已在 `pre_existing` 里 → 跳过。
  4. 插入：在该块后的空行处插入一行 `![Scene NNN](<rel_path>)`（alt 用 `Scene {n:03d}`；前后各留一个空行）。把 `rel_path` 压入 `recent`（保留末 3 个）。
  5. 每段最多插 1 张。

收尾（**全部复用现有函数，顺序不变**）：
- `result = _strip_trailing_orphan_images(result, markdown_text)`（双保险，去掉任何落进尾部区的图）。
- `_validate_illustrated_markdown(result, markdown_text, catalog)` 作**自检**（确定性插入应天然通过：路径全来自目录、3 段内不重复）。
- `return _annotate_image_captions(result, markdown_text, catalog)`（脚本自动补 `*Scene NNN · 时间 · 画面：…*` 图注，跳过既有 FIGURE 图与既有图注行）。

### 4.2 接入点改造（让代码插图成为两种模式的唯一插图路）
- `generate_audiovisual_report_outputs` 里把现在的
  `markdown_text = _maybe_illustrate_markdown(markdown_text, enriched, video_dir, coordinator)`（约 524-529 行）
  改为调用 `_illustrate_scene_screenshots(markdown_text, enriched, video_dir)`，**去掉 coordinator 入参与 `coordinator is None` 门控**。
- **降级不阻断**：把这一步整体包进 try；任何异常 → `print` 到 stderr + 返回未插图的 `markdown_text`，**不得抛到 finalize 的 try**（否则 `mark_blocked_state` 会把完整报告重新打成 blocked —— 这正是要避免的新缺口）。
- 保持 `markdown_text = _normalize_markdown_image_links(markdown_text, video_dir)` 仍在插图**之后**执行（约 530 行）——确保新插 rel_path 在 md 与 pdf 都被规范化解析。
- `assemble_audiovisual_report_markdown(..., coordinator=coordinator)`（body/diagram/overview）**不动**；coordinator 仍服务 handoff 的正文/结构图/总览子任务。

### 4.3 退役模型版插图（消除分叉，避免"两套插图实现"本身成为新缺口）
- 删除已无调用方的 builder 侧助手：`_ILLUSTRATE_SYSTEM_PROMPT`、`_build_illustrate_user_message`、`_format_scene_catalog_block`、`_maybe_illustrate_markdown`。
- `coordinator.request_illustrate` 在产品与 handoff 两路都不再被调用；它只服务插图，可一并清理，同时同步 `_SUBTASK_LABELS`、brief 任务顺序和 SKILL 文案，避免 handoff 模式继续提示一个已退役的 illustrate 子任务。
- **handoff 行为变化已确认**：opt-in 的 `AUDIOVISUAL_REPORT_HANDOFF=1` 模式下，原本的 `illustrate` agent 子任务被代码插图取代（不再产 `audiovisual_handoff/illustrate/`）。代码版复刻同一套规则、更稳，属改进。

### 4.4 SKILL.md 同步（契约与实现对齐）
- §4.1 把 `illustrate：在近终态 Markdown 中按 Scene 引用插入对应截图` 的描述从"交由 agent 完成的子任务"改成"由脚本确定性代码完成（无需 agent）"。
- 第 14、16 条里涉及 `illustrate/output.md` 由 agent 生成、连续 3 段不重复、只用场景目录截图等措辞：保留"规则本身"，但把"由 agent 做"改为"由脚本代码做"；handoff 子任务清单去掉 illustrate。

## 5. 不破坏原功能 / 不引入新缺口（逐条保证）
1. **空目录/无截图** → 原样返回，行为同今天（不插图）。
2. **正文无 Scene 引用** → 不插图，原样返回。
3. **目录外/无对应截图的编号** → 跳过，绝不编造路径（沿用 `_validate_illustrated_markdown` 的"仅目录内路径"红线）。
4. **去重** → 连续 3 段不重复同图（与现校验同窗口），`Scene 001`/`Scene 021` 各只插一次。
5. **跳过区** → 导读/路由判断/结构图/总览模块、尾部总结块+评分表、代码块、表格内部一律不插（复用现有常量 + `_find_trailing_zone_start` + `_strip_trailing_orphan_images`）。
6. **既有 FIGURE 结构图/总览图** → `pre_existing` 排除，不被改动、不被重复配图、不被加重复图注。
7. **图注** → 复用 `_annotate_image_captions`/`_format_image_caption`，格式与今天一致。
8. **PDF** → `pdf.py` 已解析 `![](path)`（`image_pattern`，约 130 行）并合并图+图注块；插图进 md 自动跟随进 pdf，无需单独改 PDF。
9. **链接规范化** → 仍在插图之后跑，相对路径在 md/pdf 都可解析。
10. **不阻断交付** → 插图异常降级为未插图完整正文；finalize 不再因插图问题 blocked（相较旧 handoff 路是净改进，不是回退）。
11. **幂等/续跑** → 重跑 finalize 时正文重建后再插图；`pre_existing` 防止对已含图的 md 二次插入。
12. **handoff 模式** → body/diagram/overview 子任务不动；仅 illustrate 由 agent 改为代码，并同步 handoff brief/SKILL 文案。

## 6. 广泛适用性
- **路由无关**：在唯一汇聚点 `generate_audiovisual_report_outputs` 接入，所有 child_type 走同一段代码；跳过区按稳定标题/尾部标志判定，不依赖具体路由模板。
- **引用格式稳健**：主匹配 `Scene\s*0*(\d+)`，覆盖 `Scene 001`/`Scene 1`；映射受 catalog 成员校验，杂散数字不会误配。`_validate_required_sections` 本就强制每模块 ≥3 个 `Scene` 编号，正文里此格式有保证。
- **md + pdf 双产物**：同源 `markdown_text`，一次插图两处生效。

## 7. 涉及文件
- `assets/embedded-skills/video-expert-analyzer/scripts/audiovisual/reporting/builder.py`（新增 `_illustrate_scene_screenshots`；改接入点 524-529；删模型版助手 188-196 / 278-309 / 469-484）。
- `assets/embedded-skills/video-expert-analyzer/SKILL.md`（§4.1、第 14/16 条措辞）。
- `assets/embedded-skills/video-expert-analyzer/scripts/audiovisual/reporting/handoff.py`（退役 illustrate 子任务说明与接口）。
- 不需要改 `pdf.py`、`text_model_runtime.py`、`template_engine.py` 的生成逻辑（仅 SKILL/常量层面）。
- 测试：`src/__tests__/embedded-skill-video-expert-vnext-swap.test.ts` 或就近 python 层测试。

## 8. 测试与验收
- **单元/行为**（首选，可纯 python）：构造一段含 `## 模块A`（多段、引用 `Scene 001/002/021`）、`## 导读`、`## 路由判断`、结构图 FIGURE、尾部 `> **视听对齐度**` + 评分表的 markdown，配一个 21 条的 catalog（指向临时存在的图片文件）。断言：
  - 模块段后正确插入对应 `![Scene NNN](path)`，且每段 ≤1 张、3 段内不重复；
  - 导读/路由判断/结构图/尾部总结块+表格区**零插入**；
  - 目录外编号不产生图；空目录时原样返回；
  - `_validate_illustrated_markdown` 通过；图注由脚本补齐；
  - 插图函数抛错时降级为原文、不抛出。
- **端到端 dogfood**：重跑该视频 finalize（或新视频），确认 `*_audiovisual_analysis.md` 正文出现多张场景截图且位置贴合引用，`*_audiovisual_analysis.pdf` 同步带图；finalize 不 blocked。
- 回归：`npm run typecheck`；相关测试文件；`npm run verify:native`（finalize 落盘链路）。

## 9. 实施顺序
1. 写 `_illustrate_scene_screenshots`（4.1）。
2. 改接入点 + 降级包裹（4.2）。
3. 退役模型版插图 + SKILL.md 同步（4.3 / 4.4）。
4. 加行为测试 → typecheck → dogfood 复测。
- 不先碰无关重构；每步跑测试。

## 10. 需要白拍板的决策
1. handoff 模式（opt-in）也统一走代码插图，消除两套实现，退役不稳的模型 illustrate。
2. 多 Scene 同段的选图规则：优先按正文引用顺序取第一个未重复 Scene，必要时再用加权分作补充排序。
