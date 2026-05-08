---
name: systematic-literature-review
description: 学术综述方法论：Boolean query / PRISMA / 引用图谱
when-to-use: 用户要求做学术综述、文献综述、systematic review、literature mapping 类任务
---

# Systematic Literature Review

## 方法论
1. **定义研究问题**（PICO 框架：Population / Intervention / Comparison / Outcome）
2. **构造 Boolean query**：(termA OR synonym) AND (termB) NOT (irrelevant)
3. **多 query 并行**：通过 web_search 跑英文 + 中文 boolean
4. **PRISMA 流程**：identification → screening → eligibility → included
5. **引用图谱**：抓取被引/引用关系，识别 seed paper
6. **质量评估**：每篇按 inclusion criteria 评分

预算：60 iterations / 60 tool calls。
