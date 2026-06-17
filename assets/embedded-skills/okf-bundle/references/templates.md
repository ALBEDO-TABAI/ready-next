# 模板速查（templates）

> 直接套用的骨架。字段含义见 `references/okf-spec.md`。记住：**只有 `type` 必填**；`index.md`/`log.md` 是仅有的两个保留名；关系用包内链接，证据用 `# Citations`。

## 1) 概念文件（绑定资产）`<type-dir>/<concept>.md`
```markdown
---
type: BigQuery Table
title: Customer Orders
description: One row per completed customer order across all channels.
resource: https://console.cloud.google.com/bigquery?p=acme&d=sales&t=orders
tags: [sales, orders, revenue]
timestamp: 2026-06-17T14:30:00Z
source: /sources/data-dictionary.xlsx#orders   # 团队扩展键：记录出处，便于治理/复核
---

# Schema

| Column        | Type      | Description                               |
|---------------|-----------|-------------------------------------------|
| `order_id`    | STRING    | Globally unique order identifier.         |
| `customer_id` | STRING    | FK into [customers](/tables/customers.md). |
| `total_usd`   | NUMERIC   | Order total in US dollars.                |

# Joins
Joined with [customers](/tables/customers.md) on `customer_id`.

# Citations
[1] [数据字典 v1.2 §3.2](/references/data-dictionary.md)
```

## 2) 概念文件（抽象概念，无资产）
```markdown
---
type: Metric
title: Weekly Active Users (WAU)
description: Distinct users with ≥1 qualifying event in a trailing 7-day window.
tags: [engagement, metric]
timestamp: 2026-06-17T14:30:00Z
---

# Definition
统计**滚动 7 天**内有至少一次合格事件的去重用户数。事件来源见 [events 表](/tables/events.md)。

# Caveats
- 时区按 UTC 切窗。
- 机器人流量已在上游过滤。

# Citations
[1] [指标口径评审纪要](https://wiki.example.internal/metrics/wau)
```

## 3) 包根 `index.md`（**唯一**可带 frontmatter 的 index.md；frontmatter 只放 okf_version）
```markdown
---
okf_version: "0.1"
---
# <知识包名> · Overview

一句话说明这个包覆盖什么主题（母题）。

# Datasets
* [Sales](datasets/sales.md) - 零售业务相关的全部数据表

# Tables
* [Orders](tables/orders.md) - 每行一笔完成的订单
* [Customers](tables/customers.md) - 客户主数据

# Metrics
* [WAU](metrics/wau.md) - 周活跃用户口径
```
> 这个带 `okf_version` 的包根 index.md 同时充当**知识包标记**，`okf_tools.py scan` 据此可靠识别。

## 4) 子目录 `index.md`（不带 frontmatter）
```markdown
# Tables
* [Orders](orders.md) - 每行一笔完成的订单
* [Customers](customers.md) - 客户主数据
```

## 5) `log.md`（最新在前，日期用 `YYYY-MM-DD`）
```markdown
# Directory Update Log

## 2026-06-17
* **Initialization**: 从 `/sources/sales-2026Q2/` 提炼，建立 datasets/tables/metrics 结构，共 12 个概念。
* **Creation**: 新增 [WAU 指标](/metrics/wau.md)，口径待数据负责人确认。
```

## 6) 工作区母题索引条目（写在 `OKF-INDEX.md` 里；通常由 `okf_tools.py index` 自动生成/合并）
`okf_tools.py index` 会扫描后生成下面这种表格行，并把**人工字段**（母题、状态、备注）保存在文件末尾的
`<!-- OKF-INDEX-DATA … -->` JSON 块中，重建时自动保留。你**手动**要做的只是：在该 JSON 块里给新包写上有意义的
`theme`（母题）/ `status`（draft/review/canonical/superseded）/ `note`，然后重跑 `index` 即可。

```markdown
| 母题 / Theme | 知识包 / Bundle | type 词表 | 概念数 | 标签 | 状态 | 更新于 | 合规 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 销售域核心知识 | [knowledge/sales](knowledge/sales) | BigQuery Table×6, Metric×3 | 12 | sales, revenue | review | 2026-06-17 | ✅ |
```

## 7) 把外部来源镜像为一等概念 `references/<slug>.md`
当某个外部文档是多个概念的共同依据，可镜像成概念，便于被 `# Citations` 用包内路径引用、也便于治理时统一更新。
```markdown
---
type: Reference
title: 电商数据建模规范 v1.2
description: 内部建模规范，是订单域多个表定义的权威依据。
resource: https://wiki.example.internal/standards/data-modeling-v1.2
timestamp: 2026-05-01T00:00:00Z
---
# 摘要
本规范定义了交易类核心实体的命名与字段约束……（仅摘要与要点，不整篇复制原文）
```
