---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Hermes vs Ready Memory Cross-Comparison

**Date:** 2026-04-12

## Goal

在已经厘清 Hermes persistent memory 真实结构之后，把它和 Ready 当前“记忆相关链路”的真实现状做一次交叉比对。

这份对照只回答一个问题：

**Ready 当前记忆体系和 Hermes 真正的差异，究竟是在“能力缺失”上，还是在“边界混合”上。**

## Scope

本对照覆盖：

- Ready 当前 persistent memory 相关主链
- `PromptAssemblyService` 的 L0/L1/L2 与 session recall 注入
- `MemoryRepository / ReflectionService / MemoryLifecycleManager / memory-tools`
- `SessionRecallService` 与 memory 的边界
- Hermes built-in memory、session recall、external provider 的对照

本对照不覆盖：

- 浏览器、技能、能力分组的其他主题
- 详细文件级实施步骤
- 本轮代码实现

## Study Inputs

### Hermes 侧

- `docs/archive/2026-09-06/docs/superpowers/specs/2026-04-12-hermes-persistent-memory-design.md`
- `docs/archive/2026-09-06/docs/superpowers/specs/2026-04-12-hermes-cross-session-search-and-recall-design.md`
- Hermes 官方 memory / memory providers / sessions 文档
- Hermes 源码：`tools/memory_tool.py`、`run_agent.py`、`agent/memory_manager.py`、`agent/memory_provider.py`

### Ready 侧

- `src/main/modules/agent-control/prompt-assembly.ts`
- `src/main/modules/repositories/memory-repository.ts`
- `src/main/modules/agent-control/reflection-service.ts`
- `src/main/modules/agent-control/memory-lifecycle.ts`
- `src/main/modules/agent-control/session-recall-service.ts`
- `src/main/modules/tools/memory-tools.ts`
- `src/main/modules/tools/session-recall-tools.ts`
- `src/main/modules/agent-control/runtime.ts`
- `src/main/modules/claude-bridge/direct-chat.ts`
- `src/shared/ai-capability-groups.ts`
- `src/main/modules/agent-control/tool-gateway.ts`

## Core Finding

Ready 现在并不是“没有记忆”，相反，它已经有一套比 Hermes built-in memory 更厚的记忆能力：

- L0/L1/L2
- trigger rules
- 自动反思沉淀
- 生命周期维护
- 会话回看索引
- 前台 UI 里的可见 memory capture

但它当前最大的短板不是“功能不够多”，而是：

**没有把 resident memory、session recall、scope execution memory、trigger rule、外部 provider 这些层做清楚的拆分。**

所以和 Hermes 相比，Ready 当前更像：

- 能力更丰富
- 结构更混合
- 产品前台更强
- 常驻记忆 core 反而不够清晰

## 1. Persistent Memory Core

### Hermes

- built-in memory 只有 `MEMORY.md` / `USER.md`
- 小、固定、always-on
- 用途是长期 steering

### Ready

- `PromptAssemblyService` 的 L0 现在包含：
  - `MEMORY.md`
  - `AGENTS.md`
  - `USER.md`
  - `TOOLS.md`
  - `SOUL.md`
- 其中只有一部分是真正的“记忆”
- 另一部分其实是运行指令、工具索引、人格设定、上下文文件

### 对照结论

Ready 当前的 L0 更像“常驻上下文包”，不是“agent curated memory core”。

这会带来两个问题：

1. `memory` 这个词在 Ready 里被用来指代过多不同性质的东西
2. 真正应该由 agent 自己维护的 resident memory，反而没有被单独立出来

## 2. Session Recall Boundary

### Hermes

- `session_search` 是独立主链
- 旧会话 archive 不混入 built-in memory

### Ready

- `session_recall` 已经被单独设成 capability group
- `direct-chat.ts` 也明确要求：历史聊天优先走 `session_search`，不要把 `memory_search` 当历史聊天检索
- `SessionRecallService` 也已经独立维护 metadata / attachment index / vector recall

### 对照结论

Ready 在“旧会话回看要和 memory 分开”这件事上，其实已经站到了和 Hermes 类似的方向。

但当前仍有一处混合：

- `PromptAssemblyService` 最终把 L0/L1/L2/recall 都收口成 `memoryRefs`
- 前台概念上仍容易让人误以为这些都是同一类 memory

也就是说，Ready 的底层边界比前台命名更清楚，命名和合同还没完全跟上。

## 3. Write Surface And Curation Model

### Hermes

- built-in memory 只有一个 `memory` 工具
- 强调 `add / replace / remove`
- 不鼓励把 memory 当数据库查来查去
- 运行时 guidance 明确禁止把 task log、session outcome 写入 memory

### Ready

- 当前 memory 工具有：
  - `memory_create`
  - `memory_search`
  - `memory_update`
  - `memory_list_recent`
- 还有：
  - `createFromConversation`
  - `ReflectionService` 自动写入
  - memory UI 手工创建

### 对照结论

Ready 当前更像一个 memory CRUD system，而不是一个 curated resident memory tool。

这会带来三个偏差：

1. 模型更容易把 memory 当成“可搜表”，而不是“需谨慎维护的常驻 steering facts”
2. `search/list_recent` 这种能力会鼓励 agent 把长期记忆和普通数据库混同
3. 自动沉淀和手工沉淀的规则现在并没有强制收口到同一种 curation 口径

## 4. What Actually Gets Auto-Injected

### Hermes

- built-in memory 在 session start 冻结
- fixed cost
- external provider recall 在 API-call-time 作为 fenced context 注入
- session recall 只在需要时走 `session_search`

### Ready

- `PromptAssemblyService.buildForScopedRun()` 会在每次 run 开始时动态重建：
  - L0
  - L1 scope summary
  - daily files
  - DB summaries
  - explicit session recall
  - automatic session recall
  - L2 trigger hits

### 对照结论

Ready 当前的优势是灵活，缺点是 resident layer 不够稳定。

和 Hermes 相比，Ready 更像：

- 每轮重新拼上下文
- 常驻记忆、会话摘要、触发规则一起装配

这让 Ready 在“当前任务更聪明”上有优势，但在“persistent memory core 足够轻、足够稳定”上不如 Hermes 清楚。

## 5. Global Learning And Layer Semantics

### Hermes

- resident memory 就是 resident memory
- user facts 和 agent notes 都有明确归宿

### Ready

- `ReflectionService` 会把 user preference 写进 `l0`
- 会把 session summary 写进 `l1`
- 但 `PromptAssemblyService.createMemoryFromConversation()` 在 `category === 'learning'` 时，写的是：
  - `layer: 'l1'`
  - `scopeId: null`
- 同时 `loadL0()` 并不会主动读取这些 global learning

### 对照结论

Ready 当前已经出现了一个明显的语义不齐：

- 有些“全局 learning”并没有被放进真正的 resident layer
- 有些 memory 虽然被称作长期学习，但默认不会进入 always-on 注入

这说明 Ready 现在的 layer 命名已经先于真正的 resident memory 合同。

## 6. Hygiene, Safety, And Duplication

### Hermes

- 写入前做 injection / exfiltration / invisible Unicode 扫描
- built-in memory exact duplicate 会被拒绝
- capacity overflow 会强迫模型 consolidate

### Ready

- `ReflectionService` 有一定的 duplicate check
- 但这是针对自动反思写入，不是整个 memory 系统的统一入口规则
- 当前没有看到 built-in resident memory 级别的统一安全扫描
- 当前也没有 resident budget 驱动的统一 merge / replace 机制

### 对照结论

Ready 在这块最缺的不是“搜索能力”，而是：

- prompt-facing memory hygiene
- 全入口统一 curation rule
- resident budget 下的整理机制

## 7. Triggered Rule Injection

### Hermes

- built-in memory 本身不承担复杂触发器职责
- 更深层 recall 交给 provider / search / session recall

### Ready

- `MemoryRepository` 已经有：
  - `agent_triggers`
  - `agent_trigger_refs`
  - access log
- `PromptAssemblyService.resolveTriggers()` 会在用户文本命中规则时拉起 L2 规则
- `MemoryLifecycleManager` 还会做 trigger priority 优化

### 对照结论

Ready 在 trigger/rule 这块其实比 Hermes built-in memory 更强。

这不是要砍掉的部分，反而是应该保留为独立层的能力。

真正的问题是：

**当前 trigger memory 和 resident memory 还没有被清楚地定义成两条不同链。**

## 8. Lifecycle And Maintenance

### Hermes

- built-in memory 主要靠字符预算和 agent 自己整理
- external provider 才会接入 prefetch / sync / session-end / pre-compress 等更复杂生命周期

### Ready

- `MemoryLifecycleManager` 会自动：
  - 归档旧 L1
  - 归档低访问 L2
  - 清理历史归档
  - 优化 trigger priority
- `MemoryRepository` 还有 access count、last accessed、access log

### 对照结论

Ready 现在已经有一套比 Hermes built-in memory 更“数据库化、运维化”的维护能力。

这套能力本身不是问题。

问题在于它当前维护的对象，同时混着：

- resident memory
- scope summary
- trigger memory
- 其他候选长期信息

也就是说，运维层先长出来了，但对象分层还没完全长出来。

## 9. External Provider Extensibility

### Hermes

- 有正式 memory provider 抽象
- 只允许一个 external provider
- provider 能参与 prefetch、sync、session-end、pre-compress、memory-write mirroring

### Ready

- 当前还没有正式的 external memory provider slot
- 所有 memory 逻辑都还在主进程核心链路内部：
  - repository
  - prompt assembly
  - reflection
  - lifecycle

### 对照结论

Ready 现在更像一个“内建数据库 memory system”，还不是“内建 core + 可选外挂 provider”。

如果后续想吸收 Hermes/Honcho 路线，这个 slot 必须单独开出来。

## 10. Product Visibility And Human Review

### Hermes

- built-in memory 主要通过工具和文件体现
- 外部 provider 主要通过 CLI/status/tool 暴露

### Ready

- 已经有：
  - `MemoryStatsCard`
  - `MemoryCreator`
  - `MemoryListPanel`
  - `TriggerManager`
  - task panel 里的 `memoryCapture`
- 自动沉淀后的记忆还支持用户确认、撤销、补充

### 对照结论

这是 Ready 明显领先 Hermes 的地方。

Ready 已经具备了把“记忆写回”做成产品内可见、可干预、可撤销流程的基础。

后续路线不应该牺牲这点，而应该把它接到更清楚的 resident memory 合同上。

## 11. Summary Judgment

如果把两边压成一句话：

- **Hermes 更强在边界清晰、memory hygiene、resident core 克制、provider slot 完整。**
- **Ready 更强在前台可见性、trigger/rule richness、生命周期运维、产品化 review 流程。**

所以 Ready 当前真正需要补的，不是“做出更多 memory 功能”，而是：

1. **把 resident memory 从大杂烩里单独抽出来**
2. **把 session recall、task memory、trigger rule、provider recall 分层**
3. **给 resident memory 补上统一 curation / budget / safety 规则**
4. **保留 Ready 已有的 review UI 和 lifecycle 优势**

## 12. Stable Conclusions Before Planning

在进入改进计划前，可以先锁定几个结论：

1. **Ready 不缺 memory 能力，缺的是 memory 边界。**
2. **Ready 已经有 session recall 主链，不应该再把历史会话检索回退到 memory 系统里。**
3. **Ready 需要一个真正的小型 resident memory core，而不是继续让 L0 承担所有常驻上下文概念。**
4. **Ready 现有 trigger/rule、review UI、lifecycle manager 都值得保留，但应该从 resident memory 合同里拆出来。**
5. **Ready 后续若接 Hermes/Honcho 类路线，应该新增 external provider slot，而不是继续往核心 memory 表里叠功能。**

## 13. Explicit Handoff To Planning

基于这份对照，下一步不应该直接开改代码，而应该先把路线排清：

- 先拆概念
- 再做 resident core
- 再调整 reflection / session recall / trigger 的归属
- 最后才谈 external provider

也就是说：

**当前最优先的不是“补一个新 memory feature”，而是先把 memory 的四五种含义拆开。**
