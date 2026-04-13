# Hermes Persistent Memory Design

**Date:** 2026-04-12

## Goal

先把 Hermes Agent 在“持久记忆 / 记忆写入 / 外部记忆扩展”上的真实做法研究清楚，形成一份可以独立站住的规格说明。

这份规格只回答一个问题：

**Hermes 到底把哪些东西算 persistent memory，它们分别怎么存、怎么写、怎么进当前轮，以及和 session recall / 外部 memory provider 的边界在哪里。**

完成这一步之后，下一步才进入：

- Hermes vs Ready 的交叉比对
- Ready 版本的改进路线和实施顺序

## Scope

本规格只覆盖：

- Hermes built-in persistent memory 的真实结构
- `MEMORY.md` / `USER.md` 的存储、注入和更新方式
- `memory` 工具的真实合同
- 容量控制、去重、安全扫描和 frozen snapshot 机制
- memory provider 的真实扩展方式与生命周期
- persistent memory 与 `session_search` / session archive 的边界

本规格不覆盖：

- Ready 当前实现盘点
- Ready 与 Hermes 的差异评分
- Ready 版本的 UI、数据库或运行时方案
- 详细实施计划
- 浏览器、技能、能力分组的其他主题

## Study Inputs

### Hermes 官方文档

- [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- [Memory Providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)
- [Honcho Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/honcho)
- [Sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions/)

### Hermes 公开源码

- [tools/memory_tool.py](https://github.com/NousResearch/hermes-agent/blob/main/tools/memory_tool.py)
- [run_agent.py](https://github.com/NousResearch/hermes-agent/blob/main/run_agent.py)
- [agent/memory_manager.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/memory_manager.py)
- [agent/memory_provider.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/memory_provider.py)
- [agent/prompt_builder.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/prompt_builder.py)
- [tests/tools/test_memory_tool.py](https://github.com/NousResearch/hermes-agent/blob/main/tests/tools/test_memory_tool.py)
- [tests/agent/test_memory_provider.py](https://github.com/NousResearch/hermes-agent/blob/main/tests/agent/test_memory_provider.py)

### Ready 内部上下文

- `docs/superpowers/specs/2026-04-12-hermes-cross-session-search-and-recall-design.md`
- `docs/superpowers/specs/2026-04-12-hermes-capability-grouping-and-runtime-switches-design.md`

## Core Finding

Hermes 的 persistent memory 不是一个“大而全”的长期知识库，也不是旧会话搜索的别名。

它真正的结构是三层分离：

1. **Built-in persistent memory**
   - 只有两份小而固定的常驻记忆：`MEMORY.md` 和 `USER.md`
   - 固定容量
   - 固定注入成本
   - 目标是减少未来轮次的重复提醒

2. **Session recall**
   - 通过 `session_search` 去历史会话里按需检索
   - 属于 archive / recall 主链
   - 不是 persistent memory 本体

3. **External memory provider**
   - Honcho、Mem0、OpenViking 等外挂型记忆层
   - 与 built-in memory 并行
   - 只允许同时启用一个
   - 用来补更深层的跨会话建模和语义回忆

Hermes 在记忆这块最值得借的，不是“它会记得更多”，而是：

**它把“常驻事实”“旧会话回看”“外挂长期建模”分成了不同层，避免一个 memory 名词同时承担三套职责。**

## 1. Built-in Memory Is A Small Resident Layer

## 1.1 Hermes 的内建持久记忆只有两份文件

Hermes 官方文档把 built-in memory 定义得很克制：

- `MEMORY.md`
  - agent 自己的工作笔记
  - 适合环境事实、项目约定、工具 quirks、稳定经验
- `USER.md`
  - 用户画像
  - 适合偏好、沟通习惯、身份信息、工作方式

默认位置是：

- `~/.hermes/memories/MEMORY.md`
- `~/.hermes/memories/USER.md`

这两个文件就是 Hermes 的 built-in persistent memory 真相源。

## 1.2 这层 memory 被故意做得很小

Hermes 官方文档给了明确字符上限：

- `MEMORY.md`: 2200 chars
- `USER.md`: 1375 chars

这层不是为了“尽量多记”，而是为了：

- 保证 system prompt 固定成本可控
- 逼 agent 做取舍、合并和清理
- 让真正长期有价值的事实留下来

Hermes 的设计哲学很明确：

**persistent memory 是 always-on steering layer，不是长期日志仓库。**

## 1.3 它采用 frozen snapshot，而不是中途热更新 prompt

Hermes 在 session start 时把 memory 文件读进来，渲染成 system prompt 里的固定块。

这份注入是 frozen snapshot：

- 当前 session 开始时拍一份快照
- session 中途写 memory 会立刻落盘
- 但不会反向改动当前 session 的 system prompt
- 下一次 session 开始时才重新加载

原因不是“做不到热更新”，而是：

**Hermes 把 prefix cache 稳定性放在了很高优先级。**

也就是说，memory 的持久化是真实时发生的，但 prompt 可见性是“下一轮 session 生效”。

## 1.4 当前 Hermes 运行时其实还是“双路径”而不是“完全统一”

Hermes 代码里有一个很容易误读的点：

- `agent/memory_manager.py` 和 `agent/memory_provider.py` 的注释，把 built-in memory 描述成 provider 体系的一部分
- 但当前 `run_agent.py` 里，built-in memory 仍然通过 `MemoryStore` 单独装配
- `MemoryManager` 实际只负责可选的 external provider

也就是说，Hermes 当前稳定的产品边界是：

- built-in memory 始终存在
- external provider 是并行外挂

但内部实现还没有完全收敛成一个统一的 provider 抽象。

这个细节很关键，因为它说明：

**Hermes 的概念边界已经很清楚，但实现本身仍带有过渡态。**

## 2. The `memory` Tool Is Intentionally Narrow

## 2.1 Hermes 内建记忆只有一个正式工具面

Hermes 对 built-in memory 只提供一个工具：

- `memory`

它的动作也故意很少：

- `add`
- `replace`
- `remove`

没有：

- `read`
- `search`
- `list_recent`
- 多层 CRUD 面板式操作

Hermes 的假设是：

- 记忆内容本来就已经在当前 session 的 system prompt 里
- agent 不需要把 built-in memory 当数据库来来回回查询

这点和“会话回看”是故意拆开的。

## 2.2 `replace/remove` 采用 substring matching，而不是 ID 驱动

Hermes 的 built-in memory 不是 structured row store。

它让 agent 用 `old_text` 去匹配唯一子串：

- 命中唯一条目就替换或删除
- 命中多个条目就报歧义错误

这套设计说明 Hermes 对 built-in memory 的预期是：

- 条目少
- 可读
- 人和模型都能快速理解
- 不需要数据库式主键管理

## 2.3 tool response 返回 live state，但 system prompt 仍保持 frozen

Hermes 的 `memory` 工具调用结果会回传：

- 当前 entries
- usage 百分比
- 当前字符占用
- 成功 / 错误信息

这意味着它把两件事拆开了：

- **当前 session 的记忆注入**
  - frozen snapshot
- **当前工具交互的反馈**
  - live state

这不是冲突，而是有意的双视图设计。

## 2.4 运行时 guidance 比文档示例更保守

Hermes 在这块有一个值得特别记录的现实：

- 网站文档里仍有一处较宽松的例子，把 completed work 也算成可保存 memory
- 但 `agent/prompt_builder.py`、`tools/memory_tool.py` 的 schema 描述和对应测试，已经明确禁止把 task progress、session outcome、completed-work log、temporary TODO state 写进 memory
- 当前代码 guidance 还明确要求：这类信息应交给 `session_search` 或 skill 体系，而不是写进 built-in memory

因此如果以当前源码为准，应优先采用更严格的口径：

**built-in memory 只保存稳定、跨轮依然有用的 steering facts，不保存任务日记。**

## 3. Hermes Treats Curation And Hygiene As First-Class Rules

## 3.1 保存规则是显式写给模型的

Hermes 不是只给 memory 一个写接口，然后任由模型自己发挥。

它在 prompt guidance 和 schema description 里反复强调：

- 优先保存用户偏好和纠正
- 其次是环境事实
- 再其次是稳定约定和可复用经验
- 不要保存一次性上下文
- 不要保存大块原始数据
- 不要把 memory 写成任务流水账

这说明 Hermes 对 memory 的理解不是“长期存储”，而是：

**未来 steering 成本最小化。**

## 3.2 容量管理是内建机制，不是后补运维

当 memory 超上限时，Hermes 会显式返回：

- 当前占用
- 新内容会超出多少
- 需要先 replace/remove/merge

它甚至在 prompt 里给模型 visible usage，使模型知道现在是 40%、80% 还是接近满。

也就是说：

- 整理 memory 不是后台 GC
- 而是 agent 自己要学会维护

## 3.3 去重是默认行为

Hermes 的 built-in memory 会拒绝 exact duplicate entry。

这进一步说明它不是 append-only log。

## 3.4 安全扫描直接发生在写入前

`tools/memory_tool.py` 在写入前做了显式扫描，阻止以下内容进入 memory：

- prompt injection
- role hijack
- credentials / token exfiltration
- SSH backdoor 类内容
- invisible Unicode

原因很简单：

**这层内容会直接进入 system prompt，所以它本身就是 prompt surface 的一部分。**

这也是 Hermes 和记忆数据库型实现很不一样的地方：

它把 memory 当 prompt asset 来管，而不是单纯当存储表来管。

## 4. Session Recall Is Deliberately Not Memory

这一点在 Hermes 官方文档和当前源码口径里都很清楚：

- memory 是小、固定、即时注入的常驻层
- `session_search` 是覆盖全部历史会话的按需回看层

也就是说：

- “用户以后都不想再重复说”的稳定事实，进 memory
- “我们上周讨论过某个细节吗”，走 `session_search`

更细的 session recall 结构已经在：

- `docs/superpowers/specs/2026-04-12-hermes-cross-session-search-and-recall-design.md`

里单独整理过，这里不重复展开。

本规格只锁定一个边界：

**Hermes 不把旧会话 archive 混进 built-in persistent memory。**

## 5. External Memory Providers Form A Separate Additive Layer

## 5.1 Hermes 只允许一个 external provider 同时激活

Hermes 的 memory provider 体系有一个很明确的约束：

- built-in memory 始终存在
- external provider 只允许同时启用一个

原因在 `MemoryManager` 注释里说得很直接：

- 避免 tool schema 膨胀
- 避免多个 backend 冲突

这意味着 Hermes 的 memory 扩展不是“全都挂上去”，而是：

**一个小的内建 core，加一个单选外挂层。**

## 5.2 provider 生命周期非常完整

Hermes 给 memory provider 定义了完整生命周期：

- `system_prompt_block()`
- `prefetch()`
- `queue_prefetch()`
- `sync_turn()`
- `on_session_end()`
- `on_pre_compress()`
- `on_memory_write()`
- `on_delegation()`
- `shutdown()`

这说明 external provider 不是一个单纯“多几个工具”的插件。

它可以参与：

- prompt 注入
- turn 级 recall
- turn 后写回
- session 结束抽取
- compression 前保留关键信息
- 内建 memory 写入镜像
- delegation 结果观察

## 5.3 provider recall 是 API-call-time 注入，而且带 fence

Hermes 在 `run_agent.py` 里对 provider recall 做了两层处理：

1. 在当前 turn 进入 tool loop 前先 `prefetch_all()`
2. 把 recall 结果用 `<memory-context>` fenced block 包起来
3. 只在 API-call-time 注入到当前 user message
4. 不把这段 recalled context 持久化回会话原文

这里的关键不是“它会 prefetch”，而是：

- recall context 是 ephemeral
- recall context 有显式 system note
- recall context 不被当成新 user input

这套 fence 设计很成熟，说明 Hermes 很清楚 provider recall 和用户原话不是同一类上下文。

## 5.4 built-in memory 的写入还能镜像给 external provider

当 Hermes 内建 `memory` 工具发生 `add/replace` 时：

- built-in file 会先更新
- 外部 provider 会通过 `on_memory_write()` 接到同一事件

这意味着 Hermes 的模型是：

- built-in memory 是原生小记忆
- external provider 是增益层
- 两者可以同步，但不是替代关系

## 6. Honcho Shows What The Provider Layer Is Actually For

Honcho 不是 session recall 主链，也不是 built-in memory 的替代品。

它展示的是 provider layer 的目标能力：

- 更深的 user modeling
- semantic search
- dialectic reasoning
- per-agent peer identity
- profile / workspace 级隔离

Hermes 把 Honcho 放在 provider layer，说明它想表达的是：

**深层长期建模是外挂扩展，不应该污染 built-in core 的口径。**

换句话说：

- `MEMORY.md` / `USER.md` 负责“小而稳”
- Honcho 这类 provider 负责“深而广”

## 7. Stable Conclusions For The Next Stage

在进入 Ready 对照前，这一步可以先锁定几个稳定结论：

1. **Hermes 的 built-in persistent memory 是小而固定的常驻层，不是总记忆池。**
2. **Hermes 明确把 persistent memory 和 session recall 分开。**
3. **Hermes 的 built-in memory 只有一个窄工具面，强调 curated update，而不是数据库式查询。**
4. **Hermes 把安全扫描、去重、容量管理当成 prompt hygiene，而不是后补治理。**
5. **Hermes 的 external memory provider 是单选外挂层，并且生命周期完整。**
6. **Hermes 当前实现存在过渡态：概念上 built-in + provider 已经分层，但代码上 built-in 仍未完全并入统一 provider 抽象。**
7. **Hermes 当前源码口径比网站文档示例更保守：稳定 steering facts 应进 memory，任务日志应交给 session recall。**

## 8. Explicit Boundary Before Cross-Comparison

这份规格到这里就停下。

下一步才做：

- Ready 当前 memory / reflection / session recall / trigger 的真实盘点
- Hermes 的小型 resident memory core 与 Ready 当前多层 memory 链路的对照
- Ready 是否要拆出 built-in resident memory、task memory、session recall、provider slot
- Ready 后续改进路线的优先级

换句话说：

**本规格只负责把 Hermes 的真实 memory 结构说清，不负责直接给 Ready 下方案。**
