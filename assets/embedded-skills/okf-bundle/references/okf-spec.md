# OKF v0.1 — 规范要点（authoring reference）

> 这是对 Google Cloud《Open Knowledge Format》v0.1（2026-06-12 发布，Apache-2.0，
> 仓库 `GoogleCloudPlatform/knowledge-catalog/okf`）的忠实压缩，用于**正确产出**符合规范的知识包。
> 写任何概念文件前，先读这一节。**只对照本规范，不要照搬网上的二手图解**——很多图解擅自加了
> `id / domain / status / version / created / updated` 等字段和 `关系/ 证据/` 等文件夹，这些**不在 v0.1 规范里**。

## 一句话
OKF 把"知识"表示为**一个装着 Markdown 文件的目录**，每个文件带一段 YAML frontmatter。
能 `cat` 就能读，能 `git clone` 就能传。没有 schema 注册中心、没有运行时、没有必装 SDK。

## 核心术语
- **Bundle（知识包）**：一个自包含的目录树，是分发单位。
- **Concept（概念）**：包内一个知识单元 = **一个 Markdown 文件**。可以是具体资产（表、API），也可以是抽象概念（指标、业务流程、决策、术语、Runbook）。
- **Concept ID**：概念文件相对包根的路径**去掉 `.md`**。例：`tables/users.md` → ID 是 `tables/users`。
  —— **ID 来自路径，不是 frontmatter 字段**。不要写 `id:`。
- **Link（关系）**：从一个概念指向另一个概念的**普通 Markdown 链接**，用来表达层级之外的关系。
- **Citation（引用）**：从概念指向支撑其论断的外部来源的链接。

## 目录结构（§3）
目录怎么分层完全由生产者决定，**与领域无关**。常见做法是按 `type` 分子目录：
```
path/to/bundle/
├── index.md                # 可选。该目录的列表（渐进式披露）。
├── log.md                  # 可选。变更历史。
├── <concept>.md            # 包根下的一个概念。
└── <subdir>/               # 子目录把概念分组。
    ├── index.md
    ├── <concept>.md
    └── <subdir>/ …
```
分发方式：git 仓库（推荐，自带历史/署名/diff）、tar/zip、或大仓库里的一个子目录。

### 保留文件名（§3.1）—— 只有两个
| 文件名 | 含义 |
| --- | --- |
| `index.md` | 目录列表（见 §6）。**不可**用作概念文件。 |
| `log.md` | 变更历史（见 §7）。**不可**用作概念文件。 |
其余所有 `.md` 都是概念文件。**`README.md` 不是保留名，也不是 OKF 结构件**——别用它当目录入口，用 `index.md`。
标签不另存文件：要按 tag 浏览，消费端扫描 frontmatter 现算即可。

## 概念文件（§4）
每个概念是一个 UTF-8 Markdown 文件，两部分：① 由独占一行的 `---` 包起来的 YAML frontmatter；② 自由 Markdown 正文。

### Frontmatter（§4.1）
```yaml
---
type: <Type name>                  # 必填（唯一必填项）
title: <显示名>                     # 推荐
description: <一句话摘要>            # 推荐
resource: <底层资产的规范 URI>       # 推荐（抽象概念可省略）
tags: [<tag>, <tag>]               # 可选
timestamp: <ISO 8601 时间>          # 可选（最后有意义改动时间）
# … 生产者可自定义任意其它键
---
```
- **`type` 是唯一必填项**：短字符串，用于消费端路由/过滤/展示。例：`BigQuery Table`、`Metric`、`API Endpoint`、`Playbook`、`Reference`、`Term`。
  类型**不集中注册**；选**描述性、自解释**的值即可；消费端必须容忍未知类型。
  —— 别把 `type` 一律写成 `concept`：那是合法但毫无信息量的选择，违背了 `type` 用于路由的初衷。
- 推荐字段优先级：`title` → `description` → `resource` → `tags` → `timestamp`。`title` 省略时消费端可从文件名推导。
- **扩展**：可加任意自定义键；消费端遇到不认识的键不得拒收，round-trip 时应保留。
  —— 所以 `owner: / domain: / sensitivity:` 这类团队字段**可以**加，但要知道它们是**你团队的扩展**，不是 v0.1 规定字段。

### 正文（§4.2）
标准 Markdown。**优先用结构化 Markdown**（标题、列表、表格、围栏代码块）而非大段散文——结构既利于人读，也利于 Agent 检索。无强制小节。以下小标题是**约定俗成**，适用时使用：
| 小标题 | 用途 |
| --- | --- |
| `# Schema` | 资产的列/字段结构化描述。 |
| `# Examples` | 具体用例，常用围栏代码块。 |
| `# Citations` | 支撑正文论断的外部来源（见 §8）。 |

## 交叉链接（§5）
概念之间用**标准 Markdown 链接**互联，形成比文件层级更丰富的**关系图**。
- **绝对（包内相对）链接，以 `/` 开头**，相对包根解析 —— **推荐**，因为文件在子目录内移动时仍稳定：
  `See the [customers table](/tables/customers.md) for the join key.`
- 相对链接：`See the [neighboring concept](./other.md).`
- **关系类型由周围文字表达，链接本身不带类型**。构图的消费端通常把所有链接当作"无类型有向边"。
- **必须容忍坏链**：指向尚不存在的概念不是错误，可能只是"还没写的知识"。

## index.md（§6）
任意目录（含包根）都可放一个 `index.md` 来列出该目录内容，支持**渐进式披露**——让人/Agent 先看见有什么，再决定打开哪个。
- **index.md 不含 frontmatter**（唯一例外：包根 index.md 可放 `okf_version`，见 §11）。
- 正文按小节分组列条目，每条带链接与简短描述（描述取自被链概念的 frontmatter）：
```markdown
# 分组标题
* [标题1](relative-url-1) - 条目1 的一句话描述
* [标题2](relative-url-2) - 条目2 的一句话描述

# 另一分组
* [子目录](subdir/) - 子目录的一句话描述
```
生产者可自动生成；消费端在缺失时可现场合成。

## log.md（§7，可选）
任意层级都可放，记录该范围的变更历史。扁平、按日期分组、**最新在前**：
```markdown
# Directory Update Log

## 2026-05-22
* **Update**: Added new table reference for [Customer Metrics](/tables/customer-metrics.md).
* **Creation**: Established the [Dataplex Playbook](/playbooks/dataplex.md).

## 2026-05-15
* **Initialization**: Created foundational directory structure.
```
日期标题**必须**用 ISO 8601 `YYYY-MM-DD`。条目是散文；开头加粗词（`**Update**`/`**Creation**`/`**Deprecation**`）是约定不是强制。

## 引用 Citations（§8）
正文若引用外部材料，应在文末 `# Citations` 下编号列出：
```markdown
# Citations
[1] [来源标题](https://…)
[2] [内部 Runbook](https://wiki.acme.internal/…)
```
引用链接可以是绝对 URL、包内相对路径，或指向 `references/` 子目录的路径（把外部材料镜像为一等 OKF 概念）。

## 一致性 Conformance（§9）—— 只有三条
一个包**符合 OKF v0.1**当且仅当：
1. 每个**非保留** `.md` 都有**可解析**的 YAML frontmatter；
2. 每个 frontmatter 都有**非空 `type`**；
3. 保留文件（`index.md`/`log.md`）出现时遵循 §6/§7 的结构。

消费端把其余约束当作软指引。**消费端不得**因以下情况拒收：缺可选字段 / 未知 `type` / 未知附加键 / 坏链 / 缺 `index.md`。
这种宽松消费是有意的：包会增长、会重构、会被 Agent 部分生成，仍须保持可用。

## 版本（§11）
形如 `<major>.<minor>`。minor 升级只做向后兼容的新增；major 可能改必填字段名或保留文件名。
包可在**包根 `index.md` 的 frontmatter** 里声明 `okf_version: "0.1"`（这是 index.md 里**唯一**允许出现 frontmatter 的地方）。消费端遇到不认识的版本应尽力消费而非拒收。

## 非目标（§Non-goals）
不定义固定的类型分类法；不规定存储/服务/查询基础设施；不取代领域 Schema（Avro/Protobuf/OpenAPI 等）——OKF **引用**它们，不吞并它们。
**OKF 也不管访问控制**：包只是知识；权限、账号、审计仍由外部系统负责。涉密来源要脱敏，别把密钥/凭据/个人隐私写进概念正文。

## 最小示例
```
my_bundle/
├── index.md                 # frontmatter 仅含 okf_version
├── datasets/
│   ├── index.md
│   └── sales.md             # type: BigQuery Dataset
└── tables/
    ├── index.md
    ├── orders.md            # type: BigQuery Table
    └── customers.md
```

## 与本 skill 体系的关系（治理层，非规范）
- 单个 `index.md` 是**包内**目录（OKF 规范的一部分）。
- 我们额外维护一个**工作区级**的 `OKF-INDEX.md`（母题索引），用来定位工作区里**所有**知识包。
  它**不是** OKF 的一部分；大写命名刻意区别于保留的小写 `index.md`，不会被误认成包内目录。
