# Route Matrix

先判断“内容是什么”，再判断“笔记该怎么写”。

## Selection order

1. 先看用户学习目标（定义见 [study-goals.md](./study-goals.md)）。
2. 再看原文的主导形态。
3. 如果两种形态都很强，拆成 `mixed-content`，不要硬压成一种。
4. 如果材料本身不适合普通笔记，切到 `unsuitable-input`。
5. 注意区分"材料是 X"和"材料在讲 X"：带代码示例的教程是教程，讲合同技巧的文章是教程，正文里嵌一张小表的报告是报告。

## Route table

类比策略见各 method 文件的 `## Analogy policy` 小节。

| Route | 强信号 | 默认关注点 | 避免误判 | Read next |
| --- | --- | --- | --- | --- |
| `knowledge-tutorial` | 解释概念、教做法、步骤建议、常见误区、经验提炼 | 这是什么、怎么做、怎么用 | 不要把框架型文章误写成操作教程 | [method-knowledge-tutorial.md](./method-knowledge-tutorial.md) |
| `opinion-commentary` | 明确立场、批评、价值判断、作者论证、结论带主观色彩 | 作者主张、理由、证据、反驳空间 | 不要把观点写成事实摘要 | [method-opinion-commentary.md](./method-opinion-commentary.md) |
| `narrative-story` | 人物、时间推进、场景、转折、经历、案例叙述 | 发生了什么、转折是什么、作者想表达什么 | 不要把故事拆成生硬知识点 | [method-narrative-story.md](./method-narrative-story.md) |
| `data-report` | 数字、样本、同比环比、研究结果、调研、结论与限制 | 核心发现、关键数据、口径边界、能说明什么 | 不要把解释层写得比数据层更重 | [method-data-report.md](./method-data-report.md) |
| `news-brief` | 时间地点人物机构、事件进展、官方回应、政策变动、已知/未知 | 5W1H、当前状态、后续影响 | 不要把新闻写成鸡汤经验 | [method-news-brief.md](./method-news-brief.md) |
| `framework-methodology` | 模型、原则、框架、三步法、五层结构、清单、方法论 | 框架是什么、由什么组成、怎么配合、适用边界 | 不要把框架拆散成互不相干的知识点 | [method-framework-methodology.md](./method-framework-methodology.md) |
| `mixed-content` | 新闻加评论、报告加方法、故事加结论，多条主线并存 | 把主线拆开，再说明关系 | 不要为了整齐牺牲结构真实度 | [method-mixed-content.md](./method-mixed-content.md) |
| `unsuitable-input` | 纯表格、纯代码、法律条款、说明书、规格书 | 先解释为何不适合普通笔记，再切换摘要形式 | 不要硬凑学习笔记模板 | [method-unsuitable-input.md](./method-unsuitable-input.md) |

## Tie-breakers

- `knowledge-tutorial` vs `framework-methodology`
  - 重点在“如何做”选 `knowledge-tutorial`
  - 重点在“结构怎么组成”选 `framework-methodology`
- `knowledge-tutorial` vs `data-report`
  - 文章在教方法，数据只是辅助时选 `knowledge-tutorial`
  - 数据本身是主角时选 `data-report`
- `news-brief` vs `opinion-commentary`
  - 如果事件事实是主线，评论只是补充，选 `news-brief`
  - 如果作者借事件表达立场，选 `opinion-commentary`
  - 两条都强，选 `mixed-content`
- `narrative-story` vs `knowledge-tutorial`
  - 读完最先记住的是人物经历和转折，选 `narrative-story`
  - 读完最先记住的是方法和可复用经验，选 `knowledge-tutorial`
- `data-report` vs `framework-methodology`
  - “发现了什么”是主线，选 `data-report`
  - “框架怎么拆、怎么用”是主线，选 `framework-methodology`

## Route confidence

- `high`: 关键信号集中，几乎没有强竞争路由
- `medium`: 有主路由，但还有一个合理备选
- `low`: 材料混合、信息不足，或只能做临时判断

低置信度时，在脑中保留备选路由，写笔记时不要过度下结论。
