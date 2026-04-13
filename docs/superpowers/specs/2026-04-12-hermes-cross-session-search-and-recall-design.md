# Hermes Cross-Session Search And Recall Design

**Date:** 2026-04-12

## Goal

先把 Hermes Agent 在“跨会话搜索 / 回看 / 续接”上的真实做法研究清楚，形成一份可以独立站住的规格说明。

这份规格只回答一个问题：

**Hermes 到底把哪些能力算作跨会话回看，它们分别怎么存、怎么找、怎么回到当前轮。**

完成这一步之后，下一步才进入：

- Hermes vs Ready 的交叉比对
- Ready 版本的改造范围和实施顺序

## Scope

本规格只覆盖：

- Hermes 的 session 持久化结构
- Hermes 的 session resume / continue 机制
- Hermes 的 `session_search` 工具设计
- Hermes 的 session lineage（压缩后的会话谱系）
- Hermes 的 built-in memory、session search、Honcho 之间的边界
- 下一步交叉比对前需要锁定的概念口径

本规格不覆盖：

- Ready 当前实现盘点
- Ready 与 Hermes 的差异分析
- Ready 版本的 UI、数据库或运行时方案
- 详细实施计划
- 本轮代码实现

## Study Inputs

### Hermes 官方文档

- [Sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions/)
- [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/)
- [Session Storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage/)
- [Built-in Tools Reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference/)
- [Context Compression & Prompt Caching](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching/)
- [Honcho Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/honcho/)
- [Memory Providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)

### Hermes 公开源码

- [hermes_state.py](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_state.py)
- [tools/session_search_tool.py](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/session_search_tool.py)

### Ready 内部上下文

- `docs/superpowers/plans/2026-04-08-hermes-agent-inspired-agent-browser-roadmap.md`
- `docs/superpowers/specs/2026-04-08-hermes-inspired-browser-agent-architecture-design.md`
- `docs/superpowers/specs/2026-04-09-agent-core-loop-runtime-host-design.md`

## Core Finding

Hermes 的“跨会话回看”不是单一功能，而是三层能力叠在一起：

1. **会话续接**
   - 继续上一次会话
   - 按 session id 续接
   - 按 title 续接
   - 沿 lineage 自动接到最新分支

2. **跨会话搜索**
   - 用 `session_search` 在所有历史会话中做全文检索
   - 把命中的会话重新压成摘要返回
   - 让当前轮只吃“相关会话胶囊”，而不是整段历史原文

3. **持久记忆**
   - `MEMORY.md` / `USER.md` 作为小而固定的常驻记忆
   - Honcho 这类 provider 作为更深层的外部长期记忆

也就是说，Hermes 把“继续原会话”“按主题找旧会话”“长期沉淀事实/用户画像”明确拆成了不同层，而不是混成一个总回忆池。

## 1. Session Is The Primary Recall Unit

Hermes 把 **session** 当成跨会话回看的第一基本单位。

官方文档和源码都表明，所有 CLI 和消息平台对话都会进入 `~/.hermes/state.db`，并以 SQLite 持久化。核心表有：

- `sessions`
- `messages`
- `messages_fts`

这里的重点不是“有数据库”本身，而是 Hermes 把以下字段当成正式会话真相：

- `id`
- `source`
- `user_id`
- `title`
- `parent_session_id`
- `system_prompt`
- 完整消息历史
- token / cost / 时间戳

这带来几个关键结果：

- 搜索时搜的是“会话里的消息”，不是零散 memory 条目
- 续接时恢复的是“完整会话历史”，不是只拼摘要
- 压缩后的分叉不会丢失，因为 `parent_session_id` 明确保留谱系
- 不同来源平台仍然回到统一的 session 口径上

Hermes 在这里的设计核心是：

**跨会话回看先依赖稳定的 session substrate，再在上面叠 resume、search、memory。**

## 2. Session Storage Is Built For Search, Not Just Logging

Hermes 的 session 存储不是单纯留档，而是从一开始就为“后续可搜、可续、可归并”设计。

### 2.1 SQLite 是正式真相，JSONL 是补充轨迹

官方文档把 SQLite 描述为结构化真相源，JSONL transcripts 更像 gateway 侧原始转录补充。

Hermes 的正式跨会话检索依赖：

- `~/.hermes/state.db`
- `messages_fts` FTS5 虚表

这意味着它的主搜索路径是：

**structured session db -> full-text search -> session-level regrouping**

而不是：

- 文件遍历
- embedding/vector recall
- 直接重放 transcript 文件

### 2.2 Session lineage 是一等公民

Hermes 明确支持 compression-triggered session splitting。

也就是：

- 长会话压缩后，可能切成新 session id
- 新 session 通过 `parent_session_id` 挂回旧 session
- title 也会自动形成 `my project -> my project #2 -> my project #3`

这件事非常关键，因为它说明 Hermes 并不把“压缩”看成历史重写，而是看成**同一任务谱系上的新 continuation**。

因此 Hermes 的“回看”不是只找一个 session，而是天然有 lineage 视角。

### 2.3 平台隔离先体现在 session key

Hermes 在消息平台上使用确定性的 session key：

- DM 基本是一人一会话
- group / channel 默认按 user 隔离
- 可切到 shared room brain

默认 `group_sessions_per_user: true` 的意义是：

- 同一群里不同人的长任务不会互相污染上下文
- 回看和续接天然按“用户在该平台语境下的会话链”来组织

所以 Hermes 的跨会话回看，前提不是“所有消息混在一个总库里”，而是**先把会话边界定稳，再做跨边界检索**。

## 3. Resume Is A First-Class Recall Path

Hermes 不把“回想以前做过什么”全部压到搜索工具上。

它把 resume 单独做成一条正式主链：

- `hermes --continue`
- `hermes --resume <session_id>`
- `hermes --resume "<title>"`
- `hermes -c "<title>"`

并且有几个很明确的设计点：

### 3.1 按 title 续接时会自动选最新 lineage

如果存在：

- `my project`
- `my project #2`
- `my project #3`

那么按 `my project` 续接时，Hermes 会自动落到最新 continuation。

这说明 title 不是纯展示字段，它兼有：

- 用户可记忆入口
- 跨压缩 continuation 的软引用

### 3.2 Resume 会先给 recap，而不是直接把旧记录塞进当前输出

官方文档说明 CLI resume 时会展示一块 compact recap panel：

- 只展示最近若干轮 user / assistant
- 工具调用会折叠
- 系统消息、工具结果、内部 reasoning 不直接暴露

也就是说，Hermes 在“回看旧会话”时，区分了两层：

- **运行时真实恢复**：完整会话历史可继续
- **用户可见回顾**：更轻的 recap 面板

这套设计说明 Hermes 不是把“可继续”和“给用户展示什么”混成一件事。

## 4. `session_search` Is The On-Demand Recall Tool

Hermes 的跨会话搜索核心不在 CLI 命令，而在内置工具 `session_search`。

它是 Hermes 对“想起以前聊过的某件事”的正式回答。

### 4.1 它是双模式工具，不只是 keyword search

从公开源码看，`session_search` 有两个模式：

1. **recent sessions mode**
   - 不带 query
   - 直接返回最近会话的 title / preview / timestamp
   - 不走 LLM，总成本接近 0

2. **keyword search mode**
   - 带 query
   - 走 FTS5 搜索
   - 再对命中的 session 做摘要

这点很重要，因为 Hermes 没把“最近看过什么”和“按主题搜索什么”拆成两个完全不同的工具，而是放进同一个 recall family。

### 4.2 搜索的返回单位是“会话摘要胶囊”，不是原始命中片段

Hermes 的搜索流程非常明确：

1. 用 FTS5 搜消息
2. 按 session regroup
3. 取 top N unique sessions，默认 3，最大 5
4. 载入每个 session 的 conversation
5. 围绕命中点截断到约 100K chars
6. 交给 fast auxiliary model 做 focused summary
7. 返回每个 session 的 summary + metadata

这说明 Hermes 的设计意图是：

**让当前主模型得到“精炼后的旧会话结论”，而不是原始 transcript 洪水。**

它更像“旧会话摘要检索”，而不是“消息级召回结果列表”。

### 4.3 当前 session lineage 会被主动排除

源码里有很清楚的策略：

- 当前 session 会排除
- 当前 session 的 lineage root 也会排除

原因很直接：

- 当前轮已经有这部分上下文
- 再把自己搜回来只会制造重复

这表明 Hermes 把 `session_search` 明确定位为：

**跨当前会话边界的 recall tool**

而不是“当前会话内部翻聊天记录”的替代品。

### 4.4 child sessions 会先归并回 parent

源码里还做了一层 parent resolution：

- 如果命中的是 child / delegation / compression child session
- 会先沿 `parent_session_id` 回到 root parent
- 再以 parent session 作为搜索结果单位

这件事的含义很大：

- Hermes 不希望搜索结果被技术性子会话碎片化
- 它更关心“用户任务主线”而不是“内部运行切片”

所以它的回看对象是 **user-visible primary conversation lineage**，不是内部执行碎片。

### 4.5 搜索结果允许降级，不因为摘要失败而整条失效

如果总结模型不可用或失败，源码会退回 raw preview，而不是把整条命中结果直接吞掉。

这说明 Hermes 对 recall 的要求是：

- 优先给高质量摘要
- 但不能因为摘要链路抖动就完全失去回看能力

也就是 recall 路径具备明确的 degrade 行为。

## 5. Hermes Separates Search From Memory

Hermes 非常明确地区分了：

- **Persistent Memory**
- **Session Search**
- **External Memory Providers**

### 5.1 Built-in memory 是小而固定的常驻层

Hermes 的 built-in memory 只有两份主要文件：

- `MEMORY.md`
- `USER.md`

它们会在 session start 时以 frozen snapshot 注入 system prompt。

特点是：

- 容量小
- 固定成本
- 适合稳定事实
- 不是拿来找“上周我们怎么修过某个 bug”

### 5.2 Session search 是无限历史的按需层

官方文档直接把二者对比得很清楚：

- memory：固定、即时、小
- session_search：按需、可搜索、覆盖全部历史

所以 Hermes 的跨会话回看主轴不是 memory，而是：

**session history as searchable archive**

### 5.3 Honcho 属于另一层，不是 session_search 本体

Honcho 提供的是：

- 更深的 user modeling
- conclusion / profile / semantic search
- 可跨机器、跨平台

但它并不替代 Hermes 的 session substrate。

Hermes 官方文档也明确说：

- built-in memory 仍然存在
- external memory provider 是并行层
- `session_search` 仍然是历史会话检索主链

所以本轮研究的正确边界是：

- 把 Honcho 看作“外部长期记忆扩展”
- 不把它当作 Hermes 原生 session recall 主链的一部分

## 6. What Hermes Means By “Recall”

把上面几层合起来，Hermes 对“recall”的真实定义其实是：

### 6.1 继续同一条会话链

- `continue`
- `resume`
- title / lineage continuation

### 6.2 浏览最近做过什么

- CLI `hermes sessions list`
- `session_search` 无 query 模式

### 6.3 按主题找旧会话

- `session_search(query=...)`
- FTS5 + regroup + summarize

### 6.4 固定注入稳定事实

- `MEMORY.md`
- `USER.md`

### 6.5 用外部 provider 做更深层长期建模

- Honcho 等 memory providers

也就是说，Hermes 的 recall 不是一个单桶，而是一个**分层回看体系**。

## 7. What Not To Misread

这一步最容易误读的地方有几个：

### 7.1 不要把 `session_search` 误读成向量记忆

Hermes 原生主链依赖的是：

- SQLite
- FTS5
- 会话级 regroup
- LLM focused summary

不是 embedding first 的 semantic recall。

### 7.2 不要把 memory 误读成历史会话总库

`MEMORY.md` / `USER.md` 是常驻、稀疏、 curated 的。

它们不是 session archive，也不替代 session_search。

### 7.3 不要把 child session 误读成独立历史单位

Hermes 搜索时会尽量把 child session 折回 parent lineage。

说明系统更关心“用户主线任务会话”，而不是每个内部派生片段。

### 7.4 不要把 recall 误读成“直接把旧内容塞回 prompt”

Hermes 的核心做法是：

- 搜旧会话
- 生成摘要
- 把摘要作为 recall 结果返回

也就是先压缩成可消费胶囊，再让主模型使用。

## 8. Stable Conclusions For The Next Stage

在进入 Ready 对照前，这一步可以先锁定几个稳定结论：

1. **Hermes 的跨会话回看首先是 session system，不是 memory system。**
2. **Hermes 的主题回看主路径是 `session_search`，而不是 resume。**
3. **Hermes 的 `session_search` 返回单位是 session summary，不是 message hits。**
4. **Hermes 对 compression / delegation 的处理不是忽略，而是通过 lineage / parent resolution 做归并。**
5. **Hermes 把 recent browse、named resume、keyword recall、persistent memory 分成了不同层。**
6. **Honcho 是长期记忆扩展层，不是 Hermes 原生 session recall 主链。**

## 9. Explicit Boundary Before Cross-Comparison

这份规格到这里就停下。

下一步才做：

- Ready 当前“保存了什么、能回看什么、不能回看什么”盘点
- Hermes session-centric recall 与 Ready scope-centric runtime 的映射关系
- Ready 是否要采用 session archive、scope archive、独立索引层，还是混合层
- 搜索结果如何重新进入当前轮上下文

换句话说：

**本规格只负责把 Hermes 的真实机制说清，不负责给 Ready 下方案。**
