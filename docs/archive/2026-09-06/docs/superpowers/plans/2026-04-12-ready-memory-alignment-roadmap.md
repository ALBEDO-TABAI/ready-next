---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Ready Memory Alignment Roadmap

**Date:** 2026-04-12

## Goal

基于 Hermes 的 persistent memory 结构和 Ready 当前现状，对 Ready 的“记忆路线”给出一份清晰、可分阶段推进的改进计划。

这份路线图的目标不是一次把所有 memory 功能做完，而是：

**先把边界拆清，再把 resident memory core 做稳，最后才扩展到 provider 和更深层长期建模。**

## Planning Principles

1. **先拆名词，再拆代码。**
   - 如果 resident memory、session recall、task memory、trigger rule 这些词还混着，任何实现都会越改越乱。

2. **先做小而稳的常驻记忆 core。**
   - Ready 现在最缺的不是更多 memory 表，而是一个真正小而清楚的 always-on resident layer。

3. **不牺牲 Ready 已有的前台可见性。**
   - 当前的 memory capture、确认/撤销/补充、memory 面板和 trigger 管理都是资产，不是负担。

4. **不把历史会话搜索再塞回 memory。**
   - `session_recall` 已经独立成链，后续只能更清楚，不能回退。

5. **外部 provider 放到后半程。**
   - 在 resident core 没稳定前就接 Honcho 类 provider，只会把边界搅得更乱。

## Phase 1: Lock The Vocabulary

### 目标

先把 Ready 里几种不同的“记忆”正式命名并定边界。

### 要锁定的对象

1. **Resident Memory**
   - 小、固定、always-on
   - 用来保存长期 steering facts

2. **Session Recall**
   - 历史会话搜索 / 引用 / 自动补召回
   - 来自会话 archive

3. **Task / Scope Memory**
   - 当前 scope 摘要、daily log、最近对话压缩
   - 服务当前任务和邻近轮次

4. **Trigger Rule Memory**
   - 命中条件后按需注入的规则和参考

5. **External Provider Memory**
   - Honcho / Mem0 / OpenViking 这类外挂长期记忆层

### 本阶段完成标准

- `memory` 这个词不再同时指代上面五种对象
- 文档里明确哪种对象会 always-on 注入，哪种只按需检索
- capability / UI / runtime 用语开始同步

## Phase 2: Build A Real Resident Memory Core

### 目标

给 Ready 补上一个真正像 Hermes built-in memory 的 resident core。

### 应该具备的特征

- 只有少量固定 store
  - 至少区分 agent memory 和 user memory
- 小而明确的预算
  - 建议用字符或 token 上限，而不是无限堆
- frozen snapshot 语义
  - 至少单轮稳定，不随着中途写入频繁抖动
- 统一的 curation 行为
  - add / replace / remove / merge
- 统一去重
- 统一安全扫描
  - 防 prompt injection / secret exfiltration / invisible chars

### 当前可直接复用的部分

- `UserProfileRepository` 与 `ReflectionService` 里的偏好抽取
- 现有前台确认/撤销/补充流程
- 部分 `PromptAssemblyService` 的 L0 装配经验

### 当前必须纠正的部分

- 不要再把 `AGENTS.md / TOOLS.md / SOUL.md` 混称为 resident memory
- 全局 learning 不应再以 `l1 + scopeId:null` 这种半全局半会话方式存在
- resident core 不能继续依赖“查数据库 recent rows”来模拟

## Phase 3: Reclassify Existing L1/L2 As Non-Resident Layers

### 目标

把 Ready 现有 memory 体系里最混的部分重新归位，而不是硬删。

### 需要重新归类的对象

1. **当前 L1 scope summary**
   - 归到 task / scope memory

2. **daily memory files**
   - 归到 task / execution log

3. **trigger refs / rules**
   - 归到 trigger rule layer

4. **auto session summary**
   - 默认归到 task memory 或 session recall metadata
   - 不直接进入 resident memory

5. **显式全局 learning**
   - 重新判断到底属于 resident core，还是 provider / skill / rule

### 本阶段完成标准

- Resident memory 不再承担“当前任务摘要”的职责
- Trigger memory 不再冒充长期常驻记忆
- Session recall 不再通过 memory 通道被解释

## Phase 4: Tighten Reflection And Memory Capture

### 目标

让自动沉淀只进入正确层，不再“一次反思，多层乱写”。

### 建议规则

1. **用户偏好**
   - 优先进入 user resident memory

2. **稳定环境事实 / 长期约定**
   - 进入 agent resident memory

3. **本轮完成了什么**
   - 进入 session recall 或 task memory
   - 不进入 resident memory

4. **新方法 / 新工作流**
   - 优先转 skill
   - 不优先转 resident memory

5. **需要命中触发词才有用的规则**
   - 进入 trigger rule layer

### 产品策略

- 保留当前“已沉淀、可撤销、可补充”的前台体验
- 但 capture item 要带清楚层级标签
- 用户能看见自己确认的是 resident 还是 session/task 级别

## Phase 5: Add An External Memory Provider Slot

### 目标

等 resident core 和 recall 边界稳定后，再补 Hermes 式 provider slot。

### 建议形态

- built-in resident memory 始终存在
- external provider 单选启用
- provider 参与：
  - prompt side static block
  - pre-turn prefetch
  - post-turn sync
  - session-end extraction
  - pre-compress preservation
  - built-in write mirroring

### 必须坚持的约束

1. **一次只允许一个 external provider**
2. **provider recall 必须和用户原话隔离**
3. **provider tool surface 不能直接污染 built-in resident memory 合同**
4. **session recall 仍保持独立，不被 provider 替代**

## Phase 6: Migration, UI, And Safe Rollout

### 目标

把现有数据和平面体验平稳迁过去，而不是一次性重置。

### 迁移原则

1. **先映射，不先删除**
   - 先给旧数据标新归属，再决定是否清理

2. **优先保用户可见资产**
   - 已有的 capture、trigger、stats、list panel 都保住

3. **先做兼容层，再收紧旧接口**
   - 旧 `memory_*` 接口可以先兼容，后面再逐步收口

4. **迁移时不要把旧 L1 摘要批量升格成 resident memory**
   - 这会直接污染新 core

### rollout 建议

- 第一步只切概念和注入合同
- 第二步切 resident write path
- 第三步切 reflection 归属
- 第四步再开放 provider slot

## Priority Order

推荐顺序如下：

1. **先做边界词典和 resident core 合同**
2. **再修正 reflection / auto capture 的落点**
3. **再整理 L1/L2/trigger 的归属**
4. **最后再引入 external provider slot**

不推荐的顺序：

- 先接 Honcho
- 先扩 memory 搜索
- 先往现有表里继续叠层级和字段

## Success Criteria

当下面这些条件同时成立时，这条路线才算真正收口：

1. 用户和开发者都能清楚区分 resident memory、session recall、task memory、trigger rule。
2. resident memory 变成小而稳定的 always-on core，而不是杂糅上下文包。
3. 自动沉淀默认不再把任务日志塞进长期记忆。
4. 旧会话回看继续走独立 recall 主链，不被 memory 回退替代。
5. 外部 provider 可以被当作外挂层接入，而不是改写核心 memory 语义。
6. Ready 当前已有的前台确认、撤销、补充体验仍然保留。

## Final Recommendation

如果只抓一条主线：

**Ready 记忆路线接下来最该做的，不是“增强记忆”，而是“把记忆拆层”。**

只有 resident core、session recall、task memory、trigger rule、provider slot 这些层真正拆开后，后面的实现才会越做越稳，而不是越做越像一个名叫 memory 的总仓库。
