# Changelog

本文件记录 study-notes skill 的所有重要变更，格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased] - 2026-06-12

### Fixed（路由脚本）

- **"材料是 X" vs "材料讲 X" 高置信误判**：`detect_unsuitable_kind` 改为占比判定（代码看围栏外正文量和代码行占比，表格看表格行占比和表外文字量，法律看行首条文数，均叠加讲解语气反信号）。unsuitable 信号存在但占比不足时，该路由直接清零出局。带代码示例的教程、讲合同技巧的文章不再被误判为 `unsuitable-input`；纯代码、纯规格表、真实条文仍正确命中。
- **小分母数字比误判**：`digit_ratio` 启发（路由加分与密度升档两处）加 120 字门槛，"这篇5000字的长文"+一句正文不再被推成 `data-report`。
- **纯 URL 输入**：SKILL.md 声明过的 `unfetched_url` 此前未实现，现在纯 URL（剥离链接后剩余文本 < 40 字）返回 `modality_mismatch / unfetched_url`；带正文的 URL 不受影响。

### Added

- `references/study-goals.md`：五个学习目标锚定修订版 Bloom 认知层级，各绑定一个实证笔记动作（自测题 / 触发条件 / 写法地图 / 证据边界）；核心约束为"路由定骨架，目标最多追加一个专属块"。SKILL.md Step 2 / Step 7、route-matrix、output-contract 均已接线。
- **长度提示失配检测**：声称长度远大于实际文本时脚本输出 `length-hint mismatch` note；SKILL.md 规则为按节选写并标注"提供全文可做完整分层"，不追问。
- **PDF 独立模态**：`.pdf` 从图片类拆出，提示语区分文本层 PDF（直接提取）与扫描版（需 OCR）；带摘录文本的 PDF 正常放行。
- **multi-source 场景**：SKILL.md Step 1 与 method-mixed-content 明确"多篇各自独立"按来源分篇路由，区别于 mixed-content 的"一篇多层"。
- **数字回核指令**：method-data-report 与 method-news-brief 收尾前逐项回核数字、日期、口径、专有名词，不确定即删或标注存疑。
- `references/examples.md` Example K：完整执行三层结构的 layered data-report 成品范例（此前 layered 只有 overflow 预览示例）。
- `evals/README.md`：两层测试协议——路由断言自动跑；`manual_checks` 用独立会话 LLM-judge 验收，附 judge prompt 模板与触发时机。
- 新增 5 条边界 evals（23-27）：纯 URL、带代码块的教程、讲合同技巧的文章、嵌小表格的数据报告、未提取的 PDF。

### Changed

- **零追问原则**：决策表中两个"目标不清时先问"分支改为"带假设产出"——按最可能判断写完，结尾一行标注所采假设；仅材料缺失（`insufficient_text` / `modality_mismatch`）才阻塞。output-contract 同步。
- **规则收敛到单一权威位置**：类比策略以各 method 文件 `## Analogy policy` 为唯一权威（route-matrix 删类比列，output-contract 的逐路由表改为全局原则 + 指针，SKILL.md Step 7 改为指针；mixed-content 与 unsuitable-input 补齐缺失小节）；语言策略收敛到 output-contract，SKILL.md 改为指针。
- **Override record 矛盾修复**：原"必须记录但默认不显示"改为——发生路由覆盖时必须输出一行不暴露内部路由名的最简 `处理说明`，完整记录仅在用户追问时展开。
- **阅读顺序按置信度分流**：脚本先行；`confidence=high` 且人工同意时跳过 route-matrix 与 complexity-rules，直接读对应 method 文件；`validate_study_notes.py` 明确标注为维护期工具，生成笔记时不运行。
- **validator 改测结构不测字面**：output-contract 的字面句子断言改为 section 存在性检查；method 文件必需 section 增加 `## Analogy policy`；新增 study-goals 覆盖检查（目标列表与路由脚本自动对齐）；两份范例标签列表合并为单一常量。
- `references/routes.json` 版本号与 skill 版本对齐（1.0.0 → 0.1.0）。

### 设计决策（本次评审定调，后续迭代沿用）

- 不设压缩率契约：换形式重新表征即学习，防的是逐字复述而非长度。
- 零追问优先：skill 目标是在最少用户输入下产出结果。
- study_goal 不做 goal×route 模板矩阵，复杂度上限是"一个追加块"。

## [0.1.0] - 2026-05-17

### Added

- 首次公开发布：8 路由内容分型（含 mixed-content / unsuitable-input 出口）、确定性路由脚本作先验 + 人工阅读终判的双层架构、short/standard/layered 复杂度分档、modality_mismatch 与 insufficient_text 守卫、22 条路由 evals 与结构 validator、逐路由 method 文件与完整输出范例。
