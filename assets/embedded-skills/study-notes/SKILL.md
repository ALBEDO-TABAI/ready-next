---
name: study-notes
description: "将文章、教程、评论、新闻、故事、研究报告、框架拆解、截图或混合材料压缩成可学习的笔记，并先按内容类型选择模板再输出。Use when Codex receives source material and the user asks '帮我做笔记'、'提取重点'、'生成学习笔记'、'帮我总结'、'做个笔记'，或希望把长文、PDF摘录、网页内容、截图/OCR整理成笔记。Do not use for pure translation, direct Q&A, or raw tables/code/contracts/manuals that need specialized handling instead of forced note-taking."
---

# Study Notes

用这套 skill 时，先判断“原文想完成什么”，再决定“笔记该长什么样”。不要再把所有内容都硬塞进同一套知识点模板。

## Expected input

本 skill 期望接收已经可读的文本材料。

- 接收：正文、节选、标题、文件名、OCR hint、转写文本、上游提供的来源说明。
- 可选接收：`prior_notes`、`topic_thread`、用户语言偏好。
- 不接收：raw image、二进制附件、未经提取的网页或视频。
- 如果上游给的是 raw image/binary，先返回 `modality_mismatch`，请上游完成 OCR、剪藏或转写后再调用。
- 从 FastNote 进入时，默认 `source_note_path` 已经由 FastNote 创建，本 skill 只负责生成学习笔记内容。

## Read in order

- 先读 [references/route-matrix.md](./references/route-matrix.md)
- 再读 [references/complexity-rules.md](./references/complexity-rules.md)
- 起草前读 [references/output-contract.md](./references/output-contract.md)
- 如果拿到了正文、OCR、标题或文件名，先跑：
  - `python3 scripts/route_study_notes.py --prompt "<user request>" --text "<content excerpt>" --file "<name-or-path>" --hint "<ocr-or-caption>"`
  - Windows 兼容路径：`py -3 .\scripts\route_study_notes.py ...`
- 输出格式检查跑：`python3 scripts/validate_study_notes.py`（静态检查 + 跑 evals 路由断言）
- 把脚本结果当作路由先验，不要把它当成最终判断
- 如果脚本返回 `modality_mismatch` 或 `insufficient_text`，不要继续写完整笔记
- 按下面的脚本先验判定表决定是否走短路径
- 只读取你真正需要的方法文件：
  - [references/method-knowledge-tutorial.md](./references/method-knowledge-tutorial.md)
  - [references/method-opinion-commentary.md](./references/method-opinion-commentary.md)
  - [references/method-narrative-story.md](./references/method-narrative-story.md)
  - [references/method-data-report.md](./references/method-data-report.md)
  - [references/method-news-brief.md](./references/method-news-brief.md)
  - [references/method-framework-methodology.md](./references/method-framework-methodology.md)
  - [references/method-mixed-content.md](./references/method-mixed-content.md)
  - [references/method-unsuitable-input.md](./references/method-unsuitable-input.md)
- 需要对照范例时，只读匹配的片段：
      - [references/examples.md](./references/examples.md)
      - 优先看和当前路由同类型的完整输出，不要拿技术教程范例去套故事或新闻

## Script prior decision table

| Script result | Human read | Decision |
| --- | --- | --- |
| `confidence=high`, route agrees, `complexity=short`, route is not `unsuitable-input` | agrees | Use short path: Step 4 -> Step 7 -> Step 8 |
| `confidence=high`, route agrees, route is `unsuitable-input` | agrees | Use unsuitable path; explain why normal notes do not fit |
| `confidence=high`, route conflicts | conflicts | Trust human reading; record the override reason in the quality gate |
| `confidence=medium`, route agrees | agrees | Lightly verify Step 2-3, then continue |
| `confidence=medium`, route conflicts | conflicts | Use `mixed-content` if both routes are strong; otherwise ask if the user goal is unclear |
| `confidence=low` | any | Split into `mixed-content` when clear; ask if user goal is unclear; return a minimal blocked status if text is insufficient |

The `content_type` is an internal judgment. Do not expose route names in the final answer unless the user asks.

**短路径下的 Step 8 校验维度收窄**：走 `Step 4 → Step 7 → Step 8` 短路径时，Step 8 只校验：
- 输出形态匹配 `content_type`（路由 minimums 满足）
- 输出复杂度匹配 `complexity`（短路径不会触发 layered overflow）
- 不再单独校验 `study_goal` 与 `credibility`（短路径默认目标=`background-understanding`，可信度提醒只在事实声明出现时插入）

## Routing Override Record

当 Decision Table 指示"信脚本"但人工阅读得出不同路由时，**必须**在最终输出末尾的 `处理说明` 段记录 override（按用户要求加 `处理说明` 才显示，否则保留为内部状态）：

```text
route_override:
  from: <脚本路由>
  to: <人工路由>
  reason: <一句话说明覆盖依据，e.g. "脚本只看了文件名，正文实际是评论文章">
```

低置信场景下，即使没有路由覆盖，也建议把 `route_confidence`、`route_runner_up`、`route_decision` 三字段写进 `处理说明`，便于后续审计。

## Modality Mismatch Output

当输入是 raw image / 二进制 / 未提取页面时，**不要写笔记**，直接返回 modality_mismatch 块：

```json
{
  "status": "modality_mismatch",
  "missing": ["extracted_text"],
  "received": ["raw_image" | "binary" | "unfetched_url"],
  "suggested_action": "请上游先完成 OCR / 剪藏 / 转写，然后把 extracted_text 再传给 study-notes"
}
```

文本形式的等价输出：

```text
status: modality_mismatch
missing: extracted_text
received: raw_image
suggested_action: 请上游先 OCR 再调用
```

## Layered Overflow

`layered` 复杂度下，如果分层后总长度超过 8000 字（或预计单次回复无法完整输出），按以下顺序拆：

1. 先输出 `一屏总览`（3-5 句）+ `分层目录`（每层一行标题 + 1-2 句要点）
2. 在末尾标出 "未展开层：<layer-name-list>，回复 `继续 <name>` 展开"
3. 等用户选择，**不要静默截断或一口气塞满**

如果 `一屏总览` + `分层目录` 本身就预计超出，先输出 `一屏总览` 并标"分层目录将分多次给出"。

## Workflow

### Step 1: 识别输入格式

- `text`: 直接读正文
- `image`: 如果没有 OCR hint 或正文，返回 `modality_mismatch`；已有 OCR hint 时再继续
- `mixed`: 先合并文字、OCR、图注和用户补充说明，再继续
- 这一步只解决“怎么拿到内容”，不解决“内容属于什么类型”

### Step 2: 判断学习目标

- 顺序与 route-matrix.md 一致：**先看用户学习目标，再决定路由**
- 显式目标优先：用户说“我要复习”“我要拿来实操”“我要拆结构”，就按用户目标走
- 没说时再推断：
  - 了解背景：概念、上下文、发生了什么
  - 直接应用：步骤、方法、注意事项
  - 二次创作：结构、论证方式、写法
  - 记忆复习：最小但不失真的记忆骨架
  - 决策支持：哪些事实或结论值得拿来判断下一步
- 学习目标会影响后续 Step 3-7 的取舍重点

### Step 3: 识别内容类型

- 有文本时优先跑 `route_study_notes.py`
- 先给出一个明确的 `content_type`
- 必须把“输入格式”和“内容类型”当成两个独立维度
- 默认类型：
  - `knowledge-tutorial`: 教程、解释型文章、知识帖
  - `opinion-commentary`: 观点评论、批评、立场文章
  - `narrative-story`: 叙事故事、人物经历、案例讲述
  - `data-report`: 数据报告、研究摘要、行业简报
  - `news-brief`: 新闻事件、公告、政策动态
  - `framework-methodology`: 框架、模型、原则、方法论
  - `mixed-content`: 至少两种内容形态都很强，且不能安全压成单一路由
  - `unsuitable-input`: 纯表格、纯代码、法律条款、说明书等，不适合强做学习笔记
- 如果脚本和人工阅读冲突，以人工阅读为准；并按 `## Routing Override Record` 记录覆盖

### Step 4: 判断这份输入适不适合做“普通学习笔记”

- 先问一句：这份材料本身有没有叙述性或论证性内容可供提炼？
- 碰到这些情况，优先退出普通笔记模式：
  - 纯数字表格、原始数据集
  - 纯代码片段
  - 法律条款、合同、制度原文
  - 说明书、参数表、规格书
- 退出时不要硬写成“知识点归纳”
- 直接切到替代格式：
  - 数据摘要
  - 代码导读
  - 条款摘要
  - 规格清单

### Step 5: 判断输入复杂度和信息密度

- 按 [references/complexity-rules.md](./references/complexity-rules.md) 把输入分成 `short`、`standard`、`layered`
- `< 300` 字优先考虑精简模式，不强套完整结构
- `300-3000` 字走标准流程
- `> 3000` 字或高密度材料走分层流程
- 学术摘要、研究报告、财报、政策说明，哪怕字数不长，也可能要按更高复杂度处理

### Step 6: 做可信度初判

- 问自己四件事：
  - 这是什么来源：一手事实、二手转述、个人经验，还是纯观点？
  - 论据够不够：有数据、例子、引用，还是只有态度？
  - 有没有明显偏颇：遗漏反方、样本过窄、时间过旧、口径不清？
  - 这些不确定性会不会影响读者怎么用这份笔记？
- 不是每次都要展开成长篇质疑，但不能默认“原文说了就算可靠”

### Step 7: 按内容类型选择结构并起草

- 结构先跟 `content_type` 走，再被 `complexity` 和 `study_goal` 微调
- 不要把所有内容都压成“这是什么 + 核心知识点 + 值得记住的 + 一句话总结”
- 类比不是全局硬要求：
  - 推荐：教程、框架、抽象概念解释
  - 可选：评论、故事
  - 默认豁免：数据报告、新闻、法律/政策、精确说明
- 当类比会损失精度时，改用具体场景、原句、数字或例子

### Step 8: 按输出契约收尾

- 对照 [references/output-contract.md](./references/output-contract.md)
- 确保输出形态同时匹配：
  - 内容类型
  - 学习目标
  - 复杂度
  - 可信度需求

## Token budget

- 对 `layered` 或长篇 `mixed-content`，不要静默截断。
- 如果完整分层会超过一次回复容量，先输出一屏总览和分段目录，并明确哪些段落尚未展开。
- 继续展开前，等待用户确认或下一轮继续指令。

## Continuity hooks

- 本 skill 不主动查历史笔记。
- 如果上游提供 `prior_notes`，在输出末尾加“与已有笔记的关系”。
- 如果上游提供 `topic_thread`，只把它当作主题线索，不要凭空补历史内容。

## Language policy

- 用户指定语言时，按用户语言输出。
- 用户未指定时，默认跟随用户请求语言。
- 跨语言材料用用户偏好语言输出，专有名词和关键术语保留原文，首次出现时给简短解释。

## Optional processing note

- 默认不要暴露内部 route、confidence 或脚本分数。
- 只有用户问“为什么这么拆”“详细分析”“推理过程”时，才在末尾加 `处理说明`。

## Global guardrails

- 不要把“叙事故事”写成机械的“知识点归纳”
- 不要把“新闻事件”写成空泛的“核心经验”
- 不要把“数据报告”写成被类比污染的鸡汤
- 不要把“观点评论”写成只有结论、没有论证和反驳空间的速记
- 不要因为用户说“做笔记”就默认必须有四个固定小标题
- 不要把事实、解释、推断、怀疑混在同一句话里
- 不要假装看过图片里不存在的字；OCR 不清时直接说不确定
- 不要为了“外行友好”牺牲精确度
- 不要把推断、常识补充或作者判断写成原文事实

## Quality gate

写完后逐条自查：

1. 这份笔记的结构，是否真的适合原文的内容类型？
2. 学习目标不同的人，看这份笔记会不会觉得重点放对了？
3. 有没有把应该保留精度的地方写得太口语，或者把应该讲人话的地方写得太硬？
4. 有没有把“类比”误当成硬任务，写进本来该保持精确的内容里？
5. 可信度提醒有没有放在真正需要的位置上？
6. 如果把原文换成另一种类型，这份笔记模板是否还能成立？
   - 如果答案是“换成别的类型也一样”，说明你大概率又在偷套通用模板
