# Agent 层升维：Ready 缺失的根本分层 + 路线重订

> **写作背景**：前两份文档（`...residual-architectural-debt.md` 与 `...cc-source-comparison-and-ideal-architecture.md`）都聚焦在"agent 怎么用 skill"——child runtime / resume / cancel / outputDir 这条线。这次升维到 **agent 本身的设计层**（QueryEngine / Coordinator / SubAgent / Hook / OutputStyle）后，发现一个更根本的判断：
>
> **Ready 缺一层 subagent / coordinator 抽象。前两份文档识别出的 26 项"架构债"中，约 35-45% 是这一缺失的投影；剩下 55-65% 仍然真实。**
>
> 这不是要推翻前两份文档，而是把它们从"局部最优"升到"全局最优"——演进路线必须重新排。

---

## 0. 战略级警示

`CLAUDE.md §0.5` 已落地的 5 条原则里，**原则 4（形态意识）** 在本文档被直接考验：

- Ready 当前的 turn-engine 一锅烩 + child runtime 复杂度，**有没有可能 35-45% 是"我们没问 CC-Source 是怎么分层的"造成的**？
- 答案是：**确实有**。下面用证据 + 反证支持这个判断。

如果判断成立，**优先级排序需要重订**——不是"把 child runtime 修好"，而是"逐步把 child runtime 这层消解掉，迁移到 subagent 模型"。

---

## 1. CC-Source 的 agent 层分层（9 维度纪要）

完整 grep 结果见对话历史。下面只列与 Ready 形成关键对照的 5 件事：

### 1.1 QueryEngine：分层生成器链

```
QueryEngine.submitMessage()  ← 入口
  └─ query() generator        ← 真正的 turn 生成器
      └─ queryLoop while(true) ← 模型循环
```

每层职责单一：QueryEngine 拿 user input，query 生成 model 响应，queryLoop 处理工具调用迭代。**Stream 处理是 yield 链**，cancellation 是单一 abortController 信号。

### 1.2 Coordinator Mode：feature-gated 角色切换

`src/coordinator/coordinatorMode.ts` 是 feature-flag 切换的角色：激活时把"worker tools 列表 + 任务分配指令"注入 user context。Worker 通过 `Agent` tool 的 `subagent_type` 被 spawn。

**这是"多 agent 工作分配"模式**，不是 fork——worker 独立 context、独立 system prompt。

### 1.3 SubAgent：Fork vs Fresh Spawn 二元设计

CC-Source 有**两种** subagent：

- **Fork**（`src/tools/AgentTool/forkSubagent.ts:32-71`）：omit `subagent_type` 时触发，子继承完整 parent context + 已渲染 system prompt（字节级复用，绕过 GrowthBook 冷热差异）+ permissionMode: 'bubble'。
- **Fresh spawn**：指定 `subagent_type`，子零 context 启动，独立 system prompt。

**Task 状态**（`src/tasks/types.ts`）有 7 种：LocalShellTask / LocalAgentTask / RemoteAgentTask / InProcessTeammateTask 等，每种自带 lifecycle（pending → running → terminal）。

### 1.4 System Prompt Assembly：优先级链

`buildEffectiveSystemPrompt`（`src/utils/systemPrompt.ts:41-120`）的 6 档优先级：

```
override > coordinator > agent > custom > default > appendSystemPrompt
```

Agent role 决定 system prompt；Fork agent 的 model 是 `'inherit'`。

### 1.5 Compaction：分层 + circuit breaker

- 第一层：`src/history.ts` pasted content 去重 / inline 化
- 第二层：`src/services/compact/autoCompact` 在 token 接近上限时触发，保留 preserved segment tail
- Circuit breaker：`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`

---

## 2. Ready 当前 agent 层（一张图说清问题）

```
   user input
        ↓
   ┌─────────────────────────────────────────────────────┐
   │  TurnEngine.execute()  (一个 async 方法)            │
   │                                                     │
   │   ↓ skill detection                                │
   │   ↓ child run continuation decision                │
   │   ↓ child cancel intent                            │
   │   ↓ child resume intent                            │
   │   ↓ feature flag check                             │
   │   ↓ run capability prepare                         │
   │   ↓ tool admission                                 │
   │   ↓ model loop (while iterations < 220)            │
   │   ↓ tool dispatch                                  │
   │   ↓ domain adapter (browser / document / skill)    │
   │   ↓ budget warning injection                       │
   │   ↓ steering reminder injection                    │
   │   ↓ skill capsule routing                          │
   │   ↓ continuation state save                        │
   │   ↓ ... (200+ inline branches)                     │
   └─────────────────────────────────────────────────────┘
        ↓
   ┌────────────────────┐    ┌──────────────────┐
   │ child runner       │    │ supervisor       │
   │ (本轮我们 Layer 1   │    │ (skill task      │
   │  修复的对象)        │    │  projection)     │
   └────────────────────┘    └──────────────────┘
```

**Ready 没有的**：
- ❌ Generator 链分层（QueryEngine / query / queryLoop）
- ❌ Coordinator role
- ❌ SubAgent 抽象（Fork / Spawn）
- ❌ Permission mode bubble
- ❌ System prompt 优先级链（只有 inline if-else 决定 mode）
- ❌ 分层 compaction（只有单点压缩）

**Ready 把这些工作都塞进 turn-engine.ts**——一个文件 5000+ 行，一个 execute() 方法 1500+ 行。

---

## 3. 根因 0：缺乏 agent 层分层抽象

前两份文档列了 5 条根因。**升维后发现一条更根本的，称为根因 0**：

> **Ready 把"应该在 agent 层完成的工作"全部塞进了 turn-engine.execute() 内部。child-runtime 是这个塞挤的副产品。**

具体地：

| Ready 现象 | CC-Source 怎么处理 | Ready 缺的抽象 |
|---|---|---|
| 长 skill（VEA）的 budget / cancel / lifecycle 散在 child runner + turn-engine | 长任务 = SubAgent，自带 lifecycle + budget + abortController | **SubAgent** |
| Resume 复用 childRunId、in-place 续跑、handle preservation | SubAgent 持久化历史，resume = 新 SubAgent 从历史恢复（不复用 id） | **SubAgent persistence model** |
| Browser/Document/Skill mode 切换在 turn-engine 内嵌 | Coordinator role 切换 system prompt + tool 列表 | **Coordinator / Agent role** |
| 4 处独立 prompt 注入打架（B4） | System prompt 优先级链 6 档 | **Prompt assembly chain** |
| Context compression 单点（turn-engine.ts) | 分层 compaction + circuit breaker | **Layered context management** |
| Hook 概念缺失 | PreToolUse / PostToolUse / UserPromptSubmit / Stop hook | **Hook system** |

**这一条"根因 0" 的不修，会以什么形式复发？**

- 任何新增产品模式（比如未来加 "AI 编程伴侣 mode"、"播客生成 mode"）都会在 turn-engine 内再加一段 if-else，导致它继续膨胀。
- 任何新增长任务类型（不只 VEA，未来加 "deep research"、"代码审计 24h"）都会再造一个 child runtime 副本。
- 任何 prompt 注入新需求都会再加一处独立分支，B4 类打架问题以新形态重复。

**这是**前两份文档识别的 5 条根因 + 26 个症状**所有事**复发的元根源。**修这一条之后，剩下大量症状会自然消失或重定位**。

---

## 4. 形态对照：必须本地化的 4 件事

直接照抄 CC-Source 的 SubAgent 模型会出错。Ready 形态特有的约束：

### 4.1 长任务的产物持久化复用（CC 没有）

CC 的 SubAgent 完成即销毁，产物不复用。Ready 的 VEA outputDir 必须跨 turn / 跨 session 复用——所以：

- **不能照抄 CC 的"resume = 新 instance"模型**，Ready 的 SubAgent 必须支持"complete → 静止→ 同 outputDir 上启动新 SubAgent 复用产物"。
- 但**可以照抄"SubAgent lifecycle 独立"**：lifecycle id 跟 outputDir 分开建模，两个独立合同。

### 4.2 多产品共享 turn-engine（CC 没有）

CC 的 QueryEngine 是单一产品入口。Ready 的 turn-engine 同时为浏览器、文档、RSS、日历、Skill 服务——这种"多产品共享"形态决定了不能照抄"单一产品 QueryEngine"。

但**可以引入 Coordinator role**：每个产品作为 coordinator role 注册自己的 system prompt + tool list，turn-engine 只负责调度，不内嵌 mode switch 逻辑。

### 4.3 跨进程恢复（CC 没有）

CC 单进程 CLI。Ready 是 Electron 多进程 + 跨 session 恢复。SubAgent 模型必须支持"进程重启后从持久化恢复"——这是 Layer 1 已经处理的 `markRowProcessRestarted` 路径，本地化进 SubAgent 即可。

### 4.4 测试可见性（CC 没有）

CC 的测试在 Anthropic 私有 repo。Ready 测试在公开 monorepo——SubAgent 引入时必须**同步**引入测试规约，不能学 CC 的"代码注释级约束"。

---

## 5. 路线重订（v3）

前两份文档的演进路线：

```
v1 (debt 文档): A 地基 / B 防爆 / C 减脆 / D 提质 / E 工程基建
v2 (CC 对照):  A + AbortController 树 + CleanupRegistry / B / C + Permission / D / E
```

**升维后的 v3** 必须把"agent 层分层"作为更根本的方向：

### 5.1 v3 阶段路线

| 阶段 | 内容 | 工作量 | 与前两份文档的关系 |
|---|---|---|---|
| **A0 — 战略地基** | 词汇 invariant（根因 1）+ 流程门（根因 5）+ 5 条原则上 CI | 3-4 天 | 与 v2 阶段 A 一致。**任何后续阶段不可能跳过这一步** |
| **A0.5 — source-grep 清零门** | 清掉 agent / skill / runtime 相关 `eslint-rules/baseline.json` source-grep 条目；UI / 样式历史债只要求 baseline 不增加 | [x] completed 2026-04-30 | A1 准入 = A0 commit `7de7ca0` + A0.5 硬门通过；剩余 `ui-history` baseline 不阻塞 A1 |
| **A1 — Agent 层抽象起点** | 引入 **SubAgent 概念骨架**（lifecycle / context / permission mode）+ `runSubAgent` generator skeleton；不改 `turn-engine` / child runtime | [x] completed 2026-05-01 | **v1/v2 没有这一阶段**；B 开工首个 PR 需移除 A1 临时 boundary gate |
| **B — Child Runtime 迁移** | 把 child runner 改造为 SubAgent 的特化（VEA SubAgent / RSS SubAgent）；`prepareResumeLifecycle` / AbortController 树 / cleanupRegistry 在 SubAgent 框架内实现 | [x] completed 2026-05-01 | **v2 阶段 A 的"AbortController 树 + CleanupRegistry"在这里落地，但作为 SubAgent 子能力** |
| **C — Coordinator 抽象** | 引入 Coordinator role：browser / document / skill / RSS 各自注册自己的 system prompt + tool list；turn-engine 只调度 | [x] completed 2026-05-01 | **v1/v2 没有这一阶段** |
| **D — 系统 reminder registry**（根因 2）+ Compaction 分层 + Hook 系统骨架 | 引入 reminder registry / 分层 compaction / 简单 hook 触发点 | [x] completed 2026-05-01 | v2 阶段 D 的提质升级版；`verify:d` 内嵌 `verify:c`，hard lint 强制禁止 inline system reminder |
| **E — 防爆 + 减脆**（O1 outputDir GC、O4 atomic write、O6 retry、O8 PermissionContext） | 这些都在 SubAgent 框架内统一实现 | [x] completed 2026-05-01 | **v2 的 B + C 在这里完成，但成本下降——因为有了 A1 的骨架**；`verify:e` 内嵌 `verify:d` |
| **F — 测试规约 + e2e 链路** | 根因 3 + O5 | [x] completed 2026-05-01 | v2 阶段 B + E 合并；`verify:f` 内嵌 `verify:e`，e2e 通过 `READY_E2E=1 npm run verify:f:e2e` 单独触发 |
| **G — 提质（剩余的 N1-N4 + O7）** | Layer 1 次生债收尾 + 用户控制面 | [x] completed 2026-05-01 | v2 阶段 D；`verify:g` 内嵌 `verify:f` |
| **H — v3 路线尾巴清扫** | 文档声明校验、silent catch baseline、timer/idempotency 与测试反模式残余收口 | [x] completed 2026-05-02 | 不是 v4 起点；`verify:h` 内嵌 `verify:g`，补齐 v3 尾部 hard gate |
| **I — 跨边界确认 + renderer 观测面** | renderer ↔ main 发送确认、友好错误、renderer metric、silent catch baseline 扩扫 | [x] completed 2026-05-02 | v3 audit scope 第一次扩展；`verify:i` 内嵌 `verify:h` |
| **J — 主进程稳定性 + 日志生命周期** | main ↔ Electron runtime handler + 9 类 `ready-*.log` rotation | [x] completed 2026-05-02 | v3 audit scope 第二次扩展，不是 v4 起点；`verify:j` 内嵌 `verify:i` |

> **v3 路线交付完成并扩展至运行边界（2026-05-02）**：A0 / A0.5 / A1 / B / C / D / E / F / G / H / I / J 全部完成；J 阶段最终 gate 为 `npm run verify:j`。

**G 准入**：F 的 7 条 hard contract 全绿；`docs/superpowers/testing-conventions.md`、CLAUDE.md / AGENTS.md §6.17 同步完成；`npm run verify:f` 退出码 0。

### 5.1.2 C 阶段准入

**C（Coordinator 抽象）准入**：B 的 9 条 hard contract 全部 land，`verify:b` 退出码 0；child runtime 已是 SubAgent 特化（VEA SubAgent）。C 阶段开工 PR 必须把 turn-engine 内嵌的 mode switch 重构为 Coordinator role 注册。

### 5.1.3 E 阶段准入

**E（防爆 + 减脆）准入**：D 的 reminder registry、LayeredCompactor、HookRegistry、hard lint 与 `verify:d` 全部通过；E 阶段不得重新引入 inline system reminder。真实 L2 压缩、reference-skill context 注入策略和后续 hook handler 必须复用 D 已落地的 registry / compactor / hook 合同，不允许另起并行抽象。

### 5.1.4 F 阶段准入

**F（测试规约 + e2e 链路）准入**：E 的 7 条 hard contract 全绿，`npm run verify:e` 退出码 0；atomic write checker、outputDir/log lifecycle、legacy resume fallback、17 reason retry policy、circuit breaker、gateway admission parity 与 VEA happy-path child-run 链路均不得退化。

### 5.2 关键差异

**v2 vs v3 的差异点**：

1. **新增 A1 阶段**：不动 child runtime，先在 turn-engine 旁边搭起 SubAgent 抽象骨架。
2. **B 阶段从"修 child runtime"变为"迁移 child runtime 到 SubAgent"**：实际工作量近似，但产出是"child runtime 不再独立存在，而是 SubAgent 的一种特化"。
3. **新增 C 阶段（Coordinator）**：把 turn-engine 内嵌的 mode switch 抽出来。这一阶段不直接修任何 bug，但解掉了大量未来 bug 的诱因（比如 B4 类 prompt 打架）。
4. **E 阶段成本下降**：因为 A1 + B 把"长任务的统一抽象"建好了，outputDir GC / retry / PermissionContext 都是 SubAgent 的标准能力，不必重新发明。

### 5.3 不变的部分

- **A0（词汇 invariant + 流程门）** 不变。这是任何阶段的前提，但只代表战略地基完成。
- **A0.5（agent / skill / runtime source-grep baseline 清零）** 新增为 A1 硬门；UI / 样式类历史 source-grep 不阻塞 A1，但 baseline 不能增加。
- **F（测试规约）** 不变，但服务对象从"child runtime 测试"变为"SubAgent 测试 + 迁移 contract 测试"。
- **G（次生债收尾）** 不变。

### 5.4 v2 路线哪些"作废"了？

- v2 阶段 A 的 "AbortController 树 + CleanupRegistry" → 不作废，但**重定位**到 v3 阶段 B 的 SubAgent 框架内。
- v2 阶段 B 的 outputDir GC → **重定位**到 v3 阶段 E。
- v2 阶段 C 的 PermissionContext → **强化**到 v3 阶段 E（因为有了 SubAgent 概念，PermissionContext 自然是 SubAgent 的一部分）。
- v2 阶段 D 的 reminder registry → **保留**在 v3 阶段 D（核心是同一件事）。

---

## 6. 风险评估

升维路线 v3 引入了"重新做一遍"的风险。诚实评估：

### 6.1 技术风险

- **A1 阶段的 SubAgent 抽象设计错了**：会污染所有后续阶段。**缓解**：A1 阶段先只做骨架（接口 + 1 个最小 SubAgent 实现），不动现有 child runtime；用 1-2 个 PoC 验证后再展开。
- **B 阶段迁移期生产挂掉**：child runtime 是用户在用的东西，迁移过程中可能引入回归。**缓解**：迁移走 feature flag，新旧两套并存到稳定为止；每条迁移路径单独 verify。
- **C 阶段 Coordinator 引入大爆炸 refactor**：browser / document / RSS 都要改。**缓解**：分产品逐步迁移，先迁一个最简单的（如 RSS），再迁 skill，最后迁 browser / document。

### 6.2 工期风险

v3 总工期 29-41 天，比 v2 的 16-22 天约多一倍。诚实承认这是"重新做一遍"的代价。**但 v3 完成后的项目长期可维护性显著高于 v2**：

- 新增产品模式 = 注册新 Coordinator role，turn-engine 不动。
- 新增长任务类型 = 实现新 SubAgent 特化，框架不动。
- Bug 修复的爆炸半径 = SubAgent scope，不会扩散到 turn-engine。

### 6.3 战略风险

最大风险：**A0 还没完成就开始 A1**。前面 5 条原则都没强制起来时引入大型重构，等于在沙地上盖房子。**A0 必须 100% 完成、CI 强制起来后再开 A1**。

---

## 7. 与前两份文档的关系（最终定位）

| 文档 | 定位 | 现在的有效性 |
|---|---|---|
| `2026-04-30-skill-runtime-residual-architectural-debt.md` | 26 项遗留架构债清单 | **完全有效**——本文档的根因 0 是它的元根源，但 26 项症状仍真实需要解 |
| `2026-04-30-skill-runtime-cc-source-comparison-and-ideal-architecture.md` | CC 对照 + 理想架构（v2 路线） | **部分作废**——v2 路线被 v3 取代；但 CC 对照的 5 维度分析仍是 v3 的输入 |
| `2026-04-30-skill-runtime-agent-layer-reframe.md`（本文档） | Agent 层升维 + v3 路线 | **当前权威路线** |

未来如果再发现"还有更上一层"的问题，应该：

1. 写第四份文档；
2. **不删**前面文档，**只**在新文档里说明哪些前文结论被覆盖。

这是文档级的"原则 3：拒绝 legacy"——保留历史决定的可追溯性，但路线必须更新。

---

## 8. 立刻可做的下一步

**A0 阶段**（词汇 invariant + 流程门 + 5 原则上 CI）现在就可以开 plan：

- §A0.1：删 `terminalReason: 'infra_error'` 联合成员 + 引入 `mapDriverThrowToTerminalReason` factory。
- §A0.2：自定义 ESLint rule 禁止 source-grep 反模式。
- §A0.3：`.claude/architectural-principles.md` 里的"复发签名"翻译为可机器执行的 lint / test rule。
- §A0.4：counter-proposal → plan → 审 plan → 执行 → 审结果 工作流的 `.claude/` hook（如果 Claude Code 支持，否则用 git pre-commit）。

**完成 A0 + A0.5 之后**才开 A1 的 SubAgent 抽象设计；A0 结束时只允许产出 A0.5 cleanup plan，不允许直接进入 A1。

---

## 9. 战略原则（再加 2 条，针对 agent 层）

`CLAUDE.md §0.5` 的 5 条原则之上，本次升维新增 2 条 agent 层专用原则。建议下次 CLAUDE.md 更新时加上：

6. **抽象的边界 = 形态的差异。** 引入新抽象（SubAgent / Coordinator / Hook）时，必须先明确"这个抽象内部是什么形态、外部是什么形态"。**抽象边界跟形态差异不一致 = 抽象错。**
7. **重新做一遍优于继续打磨。** 当一个模块被识别为"塞挤产物"（多个职责的混合）时，**不要**继续在它内部分层细化。**正确的修法是把它解耦成多个独立模块**，让原模块自然消亡。Ready 的 turn-engine 是这条原则的标准案例。

这 2 条原则下次提交 CLAUDE.md 时一起落地（与 A0.4 的 hook 机制同 PR）。

---

## 10. 文档维护

- 本文档随 A1 阶段完成更新一次（"SubAgent 骨架是否如设计"）。
- v3 路线随每个阶段完成更新。
- 如果未来某个阶段发现 v3 也有偏差，写第四份文档而不是修改本文档。
