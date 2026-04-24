# Original Prompt Full Replacement Design

## Goal

把 `chart/file-Prompt/` 里的原始分析 prompt 重新接回视听报告主流程，让报告正文尽可能按原 prompt 的分析深度和专业视角生成；只移除对运行帮助不大的块（理论文献、输入格式、参考文献），同时保留现有报告壳层（标题、路由判断、图块注入、评分表、生成时间）。

## Scope

- 为原 prompt 建立稳定的一一对应映射：`child_type / framework -> raw prompt file`。
- 在报告生成链路中新增一层原 prompt 适配器，负责读取、裁剪、整理原 prompt。
- 让原 prompt 成为正文主骨架，而不是只作为模板灵感来源。
- 为原 prompt 模式补一层更完整的输入数据，避免出现“长 prompt + 短摘要”的空转。
- 分批替换现有模板体系，优先覆盖目前仍停留在压缩版模板的类型。
- 为新行为补测试，锁住映射、裁剪、输出结构和回退逻辑。
- 为 `performance_mv` 提供一个明确的临时原稿回退，直到专用 prompt 就位。

## Non-Goals

- 不改动现有视频路由判断逻辑。
- 不重写原 prompt 本身的分析思想或章节内容。
- 不先引入两段式“先内部分析、再二次成文”的复杂流程。
- 不取消现有报告中的 `路由判断`、图块、评分表等外围内容。

## Current Findings

当前仓库已经存在两套并行资产：

1. `chart/file-Prompt/*.md`
   原始分析 prompt，内容长、判断维度完整、推导链更细。
2. `scripts/templates/*.md`
   当前实际运行的模板，多数是原 prompt 的压缩提炼版。

目前最明显的问题不是“没有接原 prompt”，而是“只接了它的结论性骨架，没有接它的大部分分析力”。这在以下类型上最明显：

- `commentary_remix -> template_commentary_mix.md`
- `documentary_essay -> template_documentary_generic.md`
- `brand_film -> template_journey_brand_film.md`
- `narrative_trailer -> template_narrative_trailer.md`
- `rhythm_remix -> template_mix_music.md`
- `meme_viral -> template_meme.md`

这些类型都有现成原 prompt，但运行时仍主要依赖压缩模板或 family 模板。

## Mapping

当前确认的一一对应关系如下：

| type_key | 原 prompt | 当前实际模板 | 现状 |
|---|---|---|---|
| `concept_mv` | `concept-mv-storyboard-analysis-prompt.md` | `template_type_concept_mv_concept_mv.md` | 已有细分模板，但仍是压缩版 |
| `live_session` | `live-session-storyboard-analysis-prompt.md` | `template_type_live_session_narrative_performance.md` | 已有细分模板，但仍是压缩版 |
| `narrative_short` | `narrative-short-storyboard-analysis-prompt.md` | `template_type_narrative_short_narrative_performance.md` | 已有细分模板，但仍是压缩版 |
| `narrative_trailer` | `trailer-analysis-prompt.md` | `template_narrative_trailer.md` | 只有 framework 模板 |
| `talking_head` | `talking-head-storyboard-analysis-prompt.md` | `template_type_talking_head_lecture_performance.md` | 已有细分模板，但仍是压缩版 |
| `documentary_essay` | `documentary-storyboard-analysis-prompt.md` | `template_documentary_generic.md` | 只有 framework 模板 |
| `commentary_remix` | `video-essay-storyboard-analysis-prompt.md` | `template_commentary_mix.md` | 只有 framework 模板 |
| `brand_film` | `ad-brand-campaign-storyboard-analysis-prompt.md` | `template_journey_brand_film.md` | 只有 framework 模板 |
| `event_promo` | `event-promo-storyboard-analysis-prompt.md` | `template_type_event_promo_event_brand_ad.md` | 已有细分模板，但仍是压缩版 |
| `explainer` | `explainer-storyboard-analysis-prompt.md` | `template_type_explainer.md` | 已有细分模板，但仍是压缩版 |
| `infographic_motion` | `infographic-motion-storyboard-analysis-prompt.md` | `template_type_infographic_motion_infographic_animation.md` | 已有细分模板，但仍是压缩版 |
| `rhythm_remix` | `rhythm-remix-storyboard-analysis-prompt.md` | `template_mix_music.md` | 只有 framework 模板 |
| `mood_montage` | `mood-montage-storyboard-analysis-prompt.md` | 多个 `template_type_mood_montage_*` | 一份原 prompt 对多条框架落点 |
| `cinematic_vlog` | `cinematic-vlog-storyboard-analysis-prompt.md` | `template_type_cinematic_vlog.md` | 已有细分模板，但仍是压缩版 |
| `reality_record` | `reality-record-storyboard-analysis-prompt.md` | `template_type_reality_record_documentary_generic.md` | 已有细分模板，但仍是压缩版 |
| `meme_viral` | `meme-viral-storyboard-analysis-prompt.md` | `template_meme.md` | 仍在吃 family 模板 |
| `motion_graphics` | `motion-graphics-storyboard-analysis-prompt.md` | `template_type_motion_graphics_pure_motion_graphics.md` | 已有细分模板，但仍是压缩版 |
| `experimental` | `experimental-storyboard-analysis-prompt.md` | `template_type_experimental_experimental.md` | 已有细分模板，但仍是压缩版 |
| `performance_mv` | `mv-temp1.md`（临时原稿来源） | `template_narrative_performance.md` | 已纳入原 prompt 替换，后续可无痛替换为正式版 |

## Decision

采用“正文按原 prompt 整份替换，外围报告壳层继续保留”的方案。

具体定义：

- **保留原 prompt 的主体内容**
  - `SYSTEM ROLE`
  - `ANALYSIS PIPELINE`
  - 各模块问题、格式禁忌、校准示例、附录提示
- **剔除原 prompt 中运行价值较低的内容**
  - `THEORETICAL ANCHORS`
  - `INPUT FORMAT`
  - `REFERENCES`
- **保留现有报告壳层**
  - `# 视听剖析报告`
  - `## 路由判断`
  - 图块注入
  - 评分表 / 对齐度表
  - 生成时间

换句话说：原 prompt 负责“正文怎么想、怎么分析、怎么写”，现有系统负责“报告外壳怎么组装、资源怎么插进去”。

## Key Design Choice: Keep Full Prompt, Add Thin Output Wrapper

原 prompt 大多描述的是分析流程，而不是可直接验证的最终 Markdown 报告格式。为了避免输出变成“研究提纲”或段落散文，适配器会加一层很薄的输出约束：

- 读取原 prompt 中的 `### MODULE N — Xxx`。
- 将模块标题转换为最终必须出现的 `## Xxx` 正文标题。
- 在 user message 里追加统一要求：
  - 按模块顺序输出
  - 使用二级标题
  - 每个模块写成完整报告段落，而不是列表式答题草稿
- 继续沿用现有缺节校验逻辑，确保正文结构完整。

这层 wrapper 只负责“让原 prompt 更适合生成报告”，不改写原 prompt 的分析内容。

## Input Data Must Expand With Prompt

如果只把 prompt 变长，而给模型的数据仍然只是当前的压缩摘要，报告不会真正变强。因此本次替换必须绑定更厚的输入包。

### Current Problem

当前 `template_engine` 主要给模型传：

- 路由判断摘要
- 若干聚合指标
- 15 条以内的内容摘要
- 若干高光场景与分析维度分组

这套输入对压缩模板够用，但对原 prompt 明显不够，因为原 prompt 默认是在分析“分镜表”，而不是分析一份短摘要。

### New Input Packet

原 prompt 模式下，user message 需要至少包含四层信息：

1. **路由和全局判断**
   - 路由结果
   - reference
   - 双层信息
   - 关键聚合指标

2. **路线专属摘要**
   - 现有 `build_template_context()` 产出的关键字段继续保留
   - 用于帮助模型快速抓住当前视频的重点矛盾

3. **完整场景上下文**
   - 基于 `storyboard_context_rows`
   - 尽量保留每个 scene，而不是采样 15 条
   - 至少保留：时间、画面、旁白、画面文字、镜头信息、叙事作用

4. **高光 / 证据线索**
   - 当前的 highlight specs
   - 重要分组场景
   - 方便模型在长上下文里快速抓重点

### Full-Retention Policy

这次替换的核心原则不是“控制到最短”，而是“优先保留内容，必要时再压缩形式”。

因此场景输入包按以下顺序降级，而不是直接抽样：

1. 优先传 **全部 scene**
2. 如果太长，先压缩字段形态（更短的一行式表示）
3. 再压缩可有可无的修饰字段
4. 最后才允许做有限裁剪，并且必须优先保住：
   - 首尾场景
   - 高光场景
   - 峰值场景
   - 含明显台词 / 字幕 / 证据功能的场景

不允许一开始就退回“只抽 15 条”的旧策略。

## Architecture

建议新增一层专门的原 prompt 适配器，而不是把所有逻辑继续堆进 `template_engine.py`。

### New Layer

建议新增：

- `scripts/audiovisual/reporting/raw_prompt_adapter.py`

职责：

- 原 prompt 路径映射
- prompt 读取与裁剪
- 模块标题提取
- module -> required sections 转换
- 原 prompt 模式下的输入包拼装
- 对 `template_engine` 暴露一个稳定接口

### Existing Layer Responsibilities

`template_engine.py` 继续负责：

- 当前模板路线
- context 计算
- 最终报告组装
- 图块注入
- 评分块注入
- fallback

也就是说，改造后会有两条正文生成路径：

1. **raw prompt path**
   - 优先用于已接入替换批次的类型
2. **template path**
   - 作为未迁移类型和异常场景的回退

## Rollout Strategy

### Batch 1

优先替换当前“最亏”的 6 类：

- `commentary_remix`
- `documentary_essay`
- `brand_film`
- `narrative_trailer`
- `rhythm_remix`
- `meme_viral`

原因：

- 原 prompt 已存在
- 当前运行仍主要依赖 framework / family 压缩模板
- 替换收益最大，差异最容易感知

### Batch 2

替换已经有 type-specific 模板、但仍是压缩版的类型：

- `concept_mv`
- `live_session`
- `narrative_short`
- `talking_head`
- `event_promo`
- `explainer`
- `infographic_motion`
- `cinematic_vlog`
- `reality_record`
- `motion_graphics`
- `experimental`

### Batch 3

处理特殊映射：

- `mood_montage`
  - 一份原 prompt 会落到多个 framework，统一复用同一份原 prompt
- `performance_mv`
  - 先使用 `mv-temp1.md` 作为临时原稿来源，后续再切换到正式专用版

## Risks

### 1. Prompt 变长但输出没变好

如果只替换 prompt，不同步扩充输入数据，会出现“理论很强、证据很薄”的空转。

**应对：** 本次改造必须把 richer storyboard packet 作为同批交付。

### 2. 输出不再像报告

原 prompt 更像分析任务书，不完全等于最终报告格式。

**应对：** 增加模块标题 wrapper 和 required sections 校验。

### 3. Token / 成本上升

原 prompt + 全量 scene 输入一定会比现在更贵。

**应对：**

- 先只在替换批次启用
- 使用分层降级的 scene packet，而不是直接抽样
- 保证长内容优先用更紧凑的编码形式承载

### 4. 已有图块插入位置不再精确

原 prompt 不含当前模板里的 `FIGURE` 标记，图块可能先退化成正文后追加。

**应对：**

- 第一阶段允许“无 marker 则追加到正文后”
- 后续如果需要，再给 raw prompt path 单独补一层 marker 注入策略

### 5. 某些类型映射不稳定

例如 `mood_montage` 会根据框架落到多条路径，不能简单一对一。

**应对：** 放到 Batch 3 单独处理，不拖慢 Batch 1。

## Success Criteria

- Batch 1 的 6 类视频在报告生成时优先走原 prompt path，而不是旧压缩模板。
- 原 prompt 适配器能稳定剔除 `THEORETICAL ANCHORS`、`INPUT FORMAT`、`REFERENCES`。
- 原 prompt 模式下，正文能按模块生成清晰的二级标题报告。
- 原 prompt 模式下，scene 输入包不再退回旧的 15 条摘要策略。
- 未迁移类型和异常类型仍能安全回退到旧模板路径。
- 自动化测试覆盖：
  - prompt 映射
  - prompt 裁剪
  - module -> heading 提取
  - richer scene packet
  - Batch 1 集成路径
