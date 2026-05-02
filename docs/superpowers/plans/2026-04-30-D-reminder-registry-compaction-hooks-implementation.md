---
name: D — Reminder Registry + 分层 Compaction + Hook 骨架
description: v3 路线 D 阶段实施计划。引入 SystemReminderRegistry 关掉根因 2（4 处独立 prompt 注入互相打架）；引入 LayeredCompactor + circuit breaker 骨架；引入 HookRegistry 接口。Reminder 部分做完整迁移；Compaction / Hook 只立合同 + skeleton，行为迁移留给 E/F。
status: draft
enforce: true
counter_proposal: 2026-04-30-skill-runtime-agent-layer-reframe.md
implementation_amendment: 2026-05-01-w0-preflight
---

# D — Reminder Registry + 分层 Compaction + Hook 骨架（实施计划）

> **范围**：解决 v3 §3 表里"4 处独立 prompt 注入打架"（B4 类 bug 的根因，residual-debt §B1 / 根因 2），并为后续阶段铺好 Compaction / Hook 的骨架。
>
> **D 完成 = 4 件事**：
> 1. **SystemReminderRegistry**：所有"reach 模型的 system-level 文本"都通过 registry 注册，单一 assembly 点产出 deterministic 文本。turn-engine + turn-frame-steering + skill-domain-adapter 内零内联 `systemReminder: <expr>` 写入；零内联 `session.messages.push({role:'user',content:<reminder>})` 写入。
> 2. **LayeredCompactor 骨架**：双层（L1 cheap 去重 / L2 token-threshold 历史压缩）+ `MAX_CONSECUTIVE_COMPACT_FAILURES = 3` circuit breaker。L1 形式化既有 `prompt-assembly` 截断；L2 只立接口 + 1 个 wire-up + circuit breaker 测试，算法实现 deferred 到 E。
> 3. **HookRegistry 骨架**：4 个 lifecycle 名（`pre_tool_use / post_tool_use / user_prompt_submit / stop`），register/fire/unregister + 顺序保证。0 个真实 hook 上车，只 1 个 fire-point wire-up（`turn-engine` 在 user message 进入前 fire `user_prompt_submit`）证明骨架联通。
> 4. **A0/A1/B/C 合同零退化**：5 条 Layer 1 contract、A1 8 条契约、B 9 条 hard contract、C 7 条 hard contract（如 C 已 land）全部通过 `verify:d` 内嵌的 nested verifies 验证。
>
> **不在 D 范围**：reference-skill 内联（独立 context 通道）、close event 用户文案（assistant→user 通道，跟 reminder 不同 audience）、真实 hook handler 实现、L2 历史压缩算法、Permission 系统。

---

## 0. Context

### 0.1 为什么现在做

**residual-debt §B1（根因 2）的复发预测**已经发生过一次：B4 budget warning 与 turn-frame-steering 的 child-owned reminder 直接打架。Layer 1 用 `renderChildCommandOutcome` 做了**局部**收口（cancel/resume 文案统一）。**全局协调层从未存在**。

D 不是修一个 bug，是**关掉 bug 的入口**：
- 当前 5 处独立的 `systemReminder: ...` 写入（turn-frame-steering 内 5 个 case）+ 2 处独立的 `session.messages.push({role:'user',content:...})` 写入（turn-engine.ts:2354 budget warning / turn-engine.ts:2622 missing-input reminder）= **7 个 author**，一个模型一轮 input 同时收到 3-4 段相互不知情的"系统补充"。
- 任何"为什么模型答非所问 / 跳步 / 用错工具"类的问题，第一可疑就是这条根因。
- 已识别的两次实例（B4 / Layer 1 之前的 inline 散落）都已修，但靠的是局部 helper —— 下次第 8 个 author 进场时同样的悲剧重演。

### 0.2 Reconnaissance Facts（已实地核查）

**`systemReminder` 写入点**（`grep -rn "systemReminder" src/main/modules/`）：

| 文件 | Line | 类型 | 现状 |
|---|---|---|---|
| `turn-frame.ts` | 111 | type field 声明 | TurnFrame.steering.systemReminder: string \| null |
| `turn-frame-steering.ts` | 401 | author（write） | checkpoint 模式：budget 用尽或 skill failed 提示 |
| `turn-frame-steering.ts` | 423 | author（write） | child-owned frame：child-loop runner 接管提示 |
| `turn-frame-steering.ts` | 438 | author（reset to null） | typedToolName 缺失时清空 |
| `turn-frame-steering.ts` | 463-472 | author（write） | force_tool 缺必需输入时降级 checkpoint 提示 |
| `turn-frame-steering.ts` | 476-485 | author（write） | force_tool 模式提示直接调 typed action |
| `turn-frame-steering.ts` | 490-500 | author（write） | ask_model 模式提示优先调 typed action |
| `turn-frame-resolver.ts` | 220 | reset to null | 默认值 |
| `skill-domain-adapter.ts` | 51-59 | consumer（read + push） | 把 frameSteering.systemReminder 推为 session message |

**额外的 model-system-text 注入点（不走 systemReminder field）**：

| 文件 | Line | 写法 | 现状 |
|---|---|---|---|
| `turn-engine.ts` | 101 | `buildBudgetWarningMessage(params)` 函数 | 直接构造文本，下游 push |
| `turn-engine.ts` | 2354 | `session.messages.push({role:'user', content: buildBudgetWarningMessage(...)})` | budget warning 注入点 #1 |
| `turn-engine.ts` | 2474 | `session.messages.push({role:'user', content: buildBudgetWarningMessage(...)})` | budget warning 注入点 #2 |
| `turn-engine.ts` | 2609-2622 | 内联 `reminderTokens.push(...)` + `session.messages.push({role:'user', content: reminderTokens.join('\n')})` | missing-input reminder |

**residual-debt §B1 列出的 4 处明确归到根因 2 的 author**（confirmed 在上面表里）：
1. `buildBudgetWarningMessage`（turn-engine.ts:101 / 2354 / 2474）
2. `turn-frame-steering` reminder（5 case）
3. orchestrator inline reference skill injection — **D 不收**（不同 audience：context document，非 turn 级提示）
4. close event 自然语言化 — **D 不收**（assistant→user，非 model→system）

D 的实际收口范围：**(1) + (2) + missing-input reminder（turn-engine.ts:2609）**。共 9 个 author 站点。

**Compaction 现状**：

| 文件 | 类型 | 现状 |
|---|---|---|
| `prompt-assembly.ts:89-92` | 静态常量 `MAX_L0_CHARS=6000 / MAX_L1_CHARS=8000 / MAX_L2_CHARS=6000 / MAX_TOTAL_CHARS=16000` | L1 既有截断 |
| `skill-context-orchestrator.ts:358` | inline `truncated = raw.length > REFERENCE_SKILL_INLINE_CAP_CHARS` | inlined skill doc 截断 |
| `document-domain-adapter.ts:94` | `truncateDetail(text, max=240)` | 文档 inspection 输出截断 |
| 历史压缩 | **零** | 无 token estimator、无 history compactor、无 circuit breaker |

D 的 Compaction 收口：**形式化 L1（既有截断接进 LayeredCompactor），新建 L2 skeleton + circuit breaker，1 个 wire-up（model-call 前估测 token）**。算法 deferred。

**Hook 现状**：

| 文件 | 类型 | 现状 |
|---|---|---|
| `tool-execution-hooks.ts` | `ToolExecutionHooks` 接口 | per-call observability hooks（onToolStart / onToolResult / ...）—— **不**是 lifecycle hooks |
| `run-coordinator.ts` | `RunCompletionHooks & ReflectionResultHook` | per-run completion hooks |

CC-Source 风格的 `PreToolUse / PostToolUse / UserPromptSubmit / Stop` lifecycle hooks **不存在**。这是 D 要 bootstrap 的。

### 0.3 与 C 的边界

C（Coordinator role）已经把 mode dispatch / TRIGGERS / arbitration 下沉到 DomainAdapter。D 的 Reminder Registry 与 Coordinator 的关系：
- **Coordinator** 负责"我这个产品需要哪些工具 / 哪些 prompt 片段（pre-action）"。
- **Reminder Registry** 负责"这一轮 turn 的 frame 上需要塞哪些 system-level reminder（per-turn dynamic）"。
- 两者都可以是 reminder author —— DomainAdapter 可以注册 reminder（如 SkillDomainAdapter 注册 child-owned reminder）。
- Registry 单一 assembly 点产出 frame.steering.systemReminder。

如果 C 还没 land，D 的 reminder 改动落在当前 turn-frame-steering 文件里；C land 后 SkillDomainAdapter 自然成为 reminder author。**D 不依赖 C**（W1-W3 直接动 turn-frame-steering / turn-engine，不经 DomainAdapter）。

---

## 1. Hard Contracts（CI 必须可机器验证）

### D-Contract-1：`systemReminder: <expr>` 单点写入

`src/main/modules/agent-control/` 下任何 `.ts` 文件**禁止**在 object literal 里直接写入 `systemReminder: <expression>`，**除了**：
- `system-reminder-registry.ts`（D 新建，registry 自身）
- `system-reminder-assembly.ts`（D 新建，单一 assembly 点）
- `turn-frame.ts`（type field 声明）
- `turn-frame-resolver.ts`（默认值 `systemReminder: null` 的 1 处）

**CI 验证**：在 `eslint-rules/index.mjs` 按现有 ESM plugin 形态新增 `ready/no-inline-system-reminder-write`（hard rule，不进 baseline）。AST 匹配 `Property` 节点 key `systemReminder` + value 非 `null` literal，源文件不在白名单则报错。

### D-Contract-2：`session.messages.push` 内联 reminder 禁止

`turn-engine.ts` 内**禁止**出现 `session.messages.push({role:'user'/'system', content:<inline 字符串构造>})` 模式当 reminder 用。所有 reminder 注入必须经 registry。

**CI 验证**：扩展 `eslint-rules/index.mjs` 中的 `ready/no-inline-system-reminder-write`，加 `session.messages.push` 的 ObjectExpression `content` 字段是字符串字面量或 template literal 时报错（仅扫描 turn-engine.ts）。允许 `content: variable` —— 假设变量来自 registry。

### D-Contract-3：Registry 单一 assembly 点

存在唯一函数 `composeSystemReminder(entries: ReminderEntry[]): string | null`：
- 输入：注册项数组（每项含 `topic / priority / text / conflictsWith?`）
- 输出：deterministic 字符串（同样输入永远同样输出）
- 排序：priority 降序 → topic id 字典序升序（稳定）
- 冲突：A 的 `conflictsWith` 包含 B.topic 时，B 被丢弃并 emit `system_reminder_suppressed_by_conflict` metric

**CI 验证**：`src/__tests__/system-reminder-registry.test.ts`（D 新建）至少 6 条契约：`composeSystemReminder` 排序稳定 / 冲突丢弃 / 空输入返回 null / 同 priority 用 id 二级稳定 / metric 在冲突时 emit / 同 topic 重复注册抛错或 last-wins（选一种并钉）。

### D-Contract-4：Compaction Circuit Breaker 存在且生效

存在 `MAX_CONSECUTIVE_COMPACT_FAILURES = 3` 常量（`layered-compactor.ts`）。当 L2 compact 连续 3 次失败时：
- 停止再尝试 compact；
- emit `compaction_circuit_break` metric（注册到 `TOOL_ERROR_METRICS`）；
- 让 turn 继续走（fail-open，不阻塞用户）。

**CI 验证**：`src/__tests__/layered-compactor.test.ts`（D 新建）至少 4 条：默认状态下 L1 idempotent / L2 在 threshold 下不触发 / 模拟 L2 连续 3 次失败后 circuit break 触发 / metric emit 一次。

### D-Contract-5：HookRegistry 4 个 lifecycle 名 + 顺序保证

`HookRegistry` 接口固定 4 个 hook 名：`'pre_tool_use' | 'post_tool_use' | 'user_prompt_submit' | 'stop'`。`fire(name, payload)`：
- 串行 await 该 name 注册的所有 handler，按注册顺序；
- 每个 handler 包 try/catch，throw 不阻断后续 handler 但 emit `hook_handler_failed` metric；
- timeout 默认 5s/handler（可配）。

**CI 验证**：`src/__tests__/hook-registry.test.ts`（D 新建）至少 5 条：4 个 hook 名 typecheck 强制 / 注册顺序 = fire 顺序 / handler throw 不阻断后续 / handler timeout 触发 / metric emit。

### D-Contract-6：A0/A1/B/C 不退化

`verify:d` 内嵌 `verify:b`（含 verify:a0/a05/a1）+ `verify:c`（如已 land）。任何一项 fail 则 D fail。

### D-Contract-7：lint baseline 不增加

`eslint-rules/baseline.json` 在 `system-reminder-*` / `compaction-*` / `hook-registry-*` 命名空间下零条目（hard rules from day 1）。

---

## 2. 架构决定

### D1. Reminder Topic 闭集合

```ts
export type ReminderTopic =
  | 'budget'              // turn-engine 的 buildBudgetWarningMessage
  | 'missing-input'       // turn-engine 的 missing-input reminder
  | 'checkpoint'          // turn-frame-steering 的 checkpoint 模式
  | 'child-owned'         // turn-frame-steering 的 child-loop runner 接管
  | 'force-tool-locked'   // turn-frame-steering 的 force_tool 锁定
  | 'force-tool-missing'  // turn-frame-steering 的 force_tool 缺必需输入
  | 'typed-action-preferred' // turn-frame-steering 的 ask_model + typed action
```

**理由**：闭集合让"新 author 想加 reminder"必须扩 union + 改测试，触发 review checkpoint。开放字符串 = 没人审。新 topic 进来时一眼能看到既有 topic 是否已覆盖语义。

### D2. Priority 数值规约

| 范围 | 用途 | 例 |
|---|---|---|
| 100-90 | 终止类（checkpoint / 强制停） | checkpoint=100 |
| 89-70 | 强约束（force tool / child ownership） | child-owned=85 / force-tool-locked=80 / force-tool-missing=78 |
| 69-50 | 软约束（资源 / budget） | budget=60 / missing-input=55 |
| 49-1  | 偏好（typed action 优先等） | typed-action-preferred=30 |
| 0     | 默认（最低，最后） | — |

**理由**：分段让 priority 不是随意数字而是"层"。新 topic 选择 priority 时必须落入某个语义层。CI 测试断言 priority ∈ [0, 100]。

### D3. 冲突默认表

```ts
const DEFAULT_CONFLICTS: Record<ReminderTopic, ReminderTopic[]> = {
  'checkpoint': [], // 终止级，不被任何东西压
  'child-owned': ['typed-action-preferred', 'force-tool-locked', 'force-tool-missing'],
    // child 在跑时不应该再说"赶紧调 typed action"
  'force-tool-locked': ['typed-action-preferred'],
    // 既然 force_tool 模式锁了，不需要重复说"优先调 typed action"
  'force-tool-missing': ['typed-action-preferred', 'force-tool-locked'],
    // 缺输入时已在引导补输入，不再说锁了 force_tool
  'budget': [],
  'missing-input': [],
  'typed-action-preferred': [],
}
```

**理由**：冲突是已知的（来自 residual-debt §B1 + B4 实例），不让 author 临场写 `conflictsWith`。集中在一个表 = 单点 review。author 仍可 `register({...,conflictsWith:[...]})` override 默认表，但默认覆盖 95% 场景。

### D4. Registry 是 Per-Turn Scope

`SystemReminderRegistry` 实例**每个 turn 一个**，turn 结束销毁。**不**是全局 singleton。

理由：
- reminder 是 per-turn dynamic 的（child status / budget 实时变化），下一轮 turn 的 reminder 完全不同。
- 全局 singleton 会带 stale state、跨 turn 串台。
- per-turn 实例 = pure function-style：`registry = createRegistry(); authors.forEach(a => a.register(registry, frame)); const text = registry.compose()`. 无 lifecycle 顾虑。

**实施**：`turn-engine.execute()` 内创建 registry，传入 turn-frame-steering / Coordinator 等 author。turn 结束 registry 自然 GC。

### D5. Migration 方向：Author 改造，不改 consumer

下游消费 `frame.steering.systemReminder` 的代码（如 `skill-domain-adapter.ts:51-59` 把它推为 session message）**不变**。Registry 的 assembly 输出最终写到 `frame.steering.systemReminder` —— 与现行 type field 完全兼容。这意味着 D 是**纯重构**，下游零感知。

理由：consumer 改造会扩散 blast radius。D 只动 author 侧 + assembly 接合点。

### D6. Compaction 双层

```
LayeredCompactor:
  L1 (always-on, idempotent, cheap):
    - prompt-assembly 既有的 MAX_L0/L1/L2/TOTAL 截断
    - 重复 pasted content 去重（既有逻辑）
    - 输入：messages[]，输出：messages[] (token count <= L1_BUDGET)

  L2 (token-threshold gated, expensive, with retry budget):
    - 当 estimatedTokens(messages) > L2_THRESHOLD 时触发
    - 实际算法：deferred（D 阶段返回 messages 不变 + log "L2 not yet implemented"）
    - circuit breaker: 连续 3 次 L2 throw 后停尝试 + emit metric
    - 输入：messages[]，输出：messages[] 或 throw CompactionFailed
```

**理由**：D 是"立合同"，不是"修压缩"。给 L2 留接口位 + circuit breaker，等 E 阶段实做。

### D7. Hook Registry：注册即合同

```ts
type HookName = 'pre_tool_use' | 'post_tool_use' | 'user_prompt_submit' | 'stop'

interface HookHandler<P> {
  readonly name: string  // 用于 metric / debug
  readonly fn: (payload: P) => Promise<void> | void
  readonly timeoutMs?: number  // default 5000
}

interface HookRegistry {
  register<H extends HookName>(name: H, handler: HookHandler<HookPayloadFor<H>>): () => void
  fire<H extends HookName>(name: H, payload: HookPayloadFor<H>): Promise<void>
}
```

**理由**：
- 4 个 hook name 是闭 union（typecheck 强制）。新 hook = 改 union + payload 类型。
- `register` 返回 unregister 函数（CC-Source 模式）。
- `fire` 是 Promise<void>，不返回 handler 结果（避免下游觉得 hook 是 RPC）。
- `HookPayloadFor<H>` 是 conditional type，每个 hook name 对应固定 payload shape，防止跨 hook 串台。

### D8. Hook fire-point：1 个证明骨架联通

D 阶段唯一接入 hook fire 的位置：`turn-engine.execute()` 在用户 message 进入处理前 fire `'user_prompt_submit'`，payload 包含 `{userText, sessionId, timestamp}`。**0** handler 注册，fire 是 no-op。

理由：证明 fire-point 接入正常（不抛错、不阻塞），future stage 注册真实 handler 时不再动 turn-engine。

---

## 3. Worker 划分（8 队）

### W0 — Pre-flight Audit

**Owner**：general-purpose 1 人 / 0.5 天

**输出**：`docs/superpowers/plans/2026-04-30-D-pre-flight-audit-report.md`

**任务**：
1. 跑 grep 列出 9 个 reminder author 站点（已在 §0.2 给出，校验是否完整）。
2. 跑 grep 列出所有 `compact / truncate / token` 站点，标注哪些是 L1（cheap dedup）哪些可能是未来 L2 候选。
3. 跑 grep 检查 `tool-execution-hooks.ts` / `run-coordinator.ts` 现有 hook，确认它们与 D 引入的 lifecycle hook **不**冲突（语义是 callback vs registry，两套并存）。
4. 检查 C 阶段 land 状态：W3-W6 与 C 的 SkillDomainAdapter 改动是否会冲突？
5. 列出"D 完成时应该死掉的代码 / 函数"清单：`buildBudgetWarningMessage`（function 还在但 caller 改用 registry）、turn-frame-steering 的 `systemReminder: ...` 内联 object literal 7 处。

**完成判据**：报告 push，W1 owner 拿到完整 author 清单 + 已知 conflict。

**依赖**：无。

### W1 — SystemReminderRegistry 接口 + assembly + 1 trivial 迁移

**Owner**：general-purpose 1 人 / 1 天

**目标文件**（新建）：
- `src/main/modules/agent-control/system-reminder-registry.ts`
- `src/main/modules/agent-control/system-reminder-assembly.ts`
- `src/__tests__/system-reminder-registry.test.ts`

**目标文件**（修改）：
- `src/main/modules/agent-control/turn-frame-steering.ts`：把 1 个最简单 case（line 401 checkpoint reminder）改造成"author 注册到 registry，registry 在 assembly 时被读"模式。其他 4 个 case 留给 W2。

**改动清单**：

1. `system-reminder-registry.ts`：
   ```ts
   export interface ReminderEntry {
     readonly topic: ReminderTopic
     readonly priority: number
     readonly text: string
     readonly conflictsWith?: ReadonlyArray<ReminderTopic>
   }

   export interface SystemReminderRegistry {
     register(entry: ReminderEntry): void
     compose(): string | null
   }

   export function createSystemReminderRegistry(): SystemReminderRegistry { ... }
   ```

2. `system-reminder-assembly.ts`：
   ```ts
   export function composeSystemReminder(
     entries: ReadonlyArray<ReminderEntry>,
   ): string | null { ... }
   ```
   纯函数。registry.compose() 内部调用它。

3. `turn-frame-steering.ts` 改造：
   - 把 `selectFrameSteering` 函数签名加一个 `registry: SystemReminderRegistry` 参数（caller 传入）。
   - 把 line 401 的 checkpoint case 改为 `registry.register({ topic:'checkpoint', priority:100, text: reason })` + 返回 `{ ..., systemReminder: registry.compose() }`。
   - 其他 case **暂时保留** 内联写法（W2 处理）。

4. `turn-engine.ts`（caller）：
   - 在 execute 入口创建 registry 实例。
   - 传给 `selectFrameSteering`。

5. 新测试 `system-reminder-registry.test.ts`：
   - it('compose returns null on empty registry')
   - it('compose preserves single entry text')
   - it('compose orders entries by priority desc, then topic id asc (stable)')
   - it('compose drops entries listed in another entry conflictsWith with metric')
   - it('compose with default conflicts (child-owned suppresses typed-action-preferred)')
   - it('register same topic twice — last-wins with debug metric')

**完成判据**：
- 5 测试通过。
- typecheck 通过。
- W1 改的 1 个 checkpoint case 在 `turn-engine-route.test.ts` / 既有 frame steering 测试里行为等价（systemReminder 字符串字面相同）。

**依赖**：W0。

### W2 — turn-frame-steering 剩余 4 case 迁移

**Owner**：general-purpose 1 人 / 0.5-1 天

**目标文件**（修改）：`turn-frame-steering.ts`

**改动清单**：把 line 423 / 463-472 / 476-485 / 490-500 四个 case 全改为 registry.register + registry.compose 模式。同时把 line 438 的 reset-to-null 改为"不 register 任何东西，registry.compose() 返回 null"。

每个 case 的 topic / priority 映射：

| 旧 line | 现内容 | 新 topic | 新 priority |
|---|---|---|---|
| 401 | checkpoint reason | `'checkpoint'` | 100 |
| 423 | child-owned 接管 | `'child-owned'` | 85 |
| 463-472 | force_tool 缺输入 → checkpoint | `'force-tool-missing'` + `'checkpoint'` | 78 + 100 |
| 476-485 | force_tool 锁 | `'force-tool-locked'` | 80 |
| 490-500 | ask_model 优先 typed action | `'typed-action-preferred'` | 30 |

注意 463-472 case 同时注册两个 topic（force-tool-missing 描述问题 + checkpoint 表示进入 checkpoint），让 registry 用 priority 自然把两者合并到同一段 reminder。

**新测试**：
- 在 W1 的测试文件里追加 5 条："steering returns equivalent reminder string for case <X> via registry"（每个 case 一条 snapshot 等价测试）。

**完成判据**：
- turn-frame-steering 内 0 个 inline `systemReminder: <expr>` 写入（除 line 438 的 `null` 默认值）。
- 等价测试通过。
- 既有 turn-frame-steering 测试零退化。

**依赖**：W1。

### W3 — turn-engine 内联 reminder 迁移

**Owner**：general-purpose 1 人 / 1 天

**目标文件**（修改）：`turn-engine.ts`

**改动清单**：

1. **buildBudgetWarningMessage 改造**：
   - line 101 函数保留（为兼容性 + 单测目的），但 caller 不再直接 push 结果到 session.messages。
   - line 2354 / 2474 改为 `registry.register({ topic:'budget', priority:60, text: buildBudgetWarningMessage(...) })`。
   - registry.compose() 输出最终 frame.steering.systemReminder。

2. **missing-input reminder 改造**（line 2609-2622）：
   - 把 `reminderTokens.push(...)` + `session.messages.push({role:'user', content: ...})` 改为 `registry.register({ topic:'missing-input', priority:55, text: reminderTokens.join('\n') })`。

3. 验证两条改动后，session.messages 内不再被 turn-engine 直接 push 任何 reminder 字符串。

**新测试**：在 `turn-engine-route.test.ts` 追加：
- it('budget warning is delivered through registry not direct message push')
- it('missing-input reminder routed through registry with topic missing-input')

**完成判据**：
- D-Contract-1 / D-Contract-2 lint rule（在 W4 加入）的预期通过状态：turn-engine.ts 内 0 个内联 push reminder。
- 既有 budget warning / missing input 行为测试零退化。

**依赖**：W1（registry 接口稳定）。可与 W2 并行。

### W4 — Lint rule + verify:d gate

**Owner**：general-purpose 1 人 / 0.5 天

**目标文件**（新建）：
- `scripts/check-reminder-isolation.cjs`（可选，如果 ESLint rule 不够覆盖）

**目标文件**（修改）：
- `eslint-rules/index.mjs`：按现有 ESM plugin 形态新增并注册新规则
- `package.json`：加 `verify:d` script

**改动清单**：

1. ESLint rule `no-inline-system-reminder-write`：
   - 扫 `src/main/modules/agent-control/`。
   - 报错条件：ObjectExpression Property key.name === 'systemReminder' 且 value 不是 `null` literal 且 source file ∉ 白名单 `['system-reminder-registry.ts', 'system-reminder-assembly.ts', 'turn-frame.ts', 'turn-frame-resolver.ts']`。
   - 报错条件 2：在 `turn-engine.ts` 内的 `CallExpression` 形如 `*.messages.push(...)`，参数是 ObjectExpression `{role, content}`，content 是 string literal 或 template literal 且看起来是 reminder（heuristic：以 `'系统补充'` 开头，或包含 `'reminder'`/`'提示'`）—— 保守规则只 ban 包含 `'系统补充'` 的，覆盖现状所有 reminder。

2. `verify:d` script in package.json（C 已 land，必须包含 `verify:c`；当前 `check-eslint-baseline.cjs` 不支持 `d-gate` area，除非 W4 同步扩展 checker，否则不要写 `--area d-gate`）：
   ```
   "verify:d": "npm run typecheck && npm run lint:check && node scripts/check-eslint-baseline.cjs && node scripts/check-subagent-isolation.cjs && node scripts/check-skill-child-runner-api.cjs && npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/system-reminder-registry.test.ts src/__tests__/layered-compactor.test.ts src/__tests__/hook-registry.test.ts src/__tests__/turn-frame-steering.test.ts src/__tests__/turn-engine-route.test.ts src/__tests__/skill-domain-adapter.test.ts src/__tests__/prompt-assembly.test.ts && npm run verify:c"
   ```

**完成判据**：
- 故意在 turn-frame-steering 写 `systemReminder: '测试'` → ESLint 立即报错。
- 故意在 turn-engine push `{role:'user',content:'系统补充：xxx'}` → ESLint 报错。
- `verify:d` 在主分支跑成功。

**依赖**：W2 + W3（迁移完成后才能开 hard rule）。

### W5 — LayeredCompactor 骨架

**Owner**：general-purpose 1 人 / 1 天

**目标文件**（新建）：
- `src/main/modules/agent-control/layered-compactor.ts`
- `src/__tests__/layered-compactor.test.ts`

**目标文件**（修改）：
- `src/main/modules/agent-control/tool-error-metrics.ts`：注册 `compactionCircuitBreak: 'compaction_circuit_break'`、`compactionL2Failed: 'compaction_l2_failed'`。
- `src/main/modules/agent-control/turn-engine.ts`：在 model call 前 1 个位置插入 `layeredCompactor.maybeCompact(messages, budget)`；按修订执行顺序，W5 先做 skeleton/tests/metrics，直接改 `turn-engine.ts` 的 wire-up 等 W4 后或由 W4 统一接入，避免和 W1-W3 reminder 迁移冲突。

**改动清单**：

1. `layered-compactor.ts`：
   ```ts
   export const MAX_CONSECUTIVE_COMPACT_FAILURES = 3

   export interface LayeredCompactorOptions {
     readonly l1Budget?: number       // default 16000 chars (matches prompt-assembly MAX_TOTAL_CHARS)
     readonly l2Threshold?: number    // default 0 = disabled
     readonly estimateTokens?: (messages: Message[]) => number
   }

   export interface LayeredCompactor {
     compactL1(messages: Message[]): Message[]
     maybeCompact(messages: Message[]): Message[]   // L1 + maybe L2
     readonly circuitBroken: boolean
   }

   export function createLayeredCompactor(opts: LayeredCompactorOptions): LayeredCompactor { ... }
   ```

   - L1 实现：复用 prompt-assembly 既有截断逻辑（移过来 / 共享）。
   - L2 实现：D 阶段 stub —— 当 estimatedTokens > l2Threshold 时尝试调 `compactL2(messages)`（私有），D 阶段 stub 直接 throw `'L2 not implemented'`。
   - circuit breaker：consecutive throw 计数，>= 3 时设 `circuitBroken = true`，maybeCompact 跳过 L2 直接返回 L1 结果，emit `compaction_circuit_break` metric 一次。

2. `turn-engine.ts` 插入点：在调用 model 之前（grep `responseHandler` / `agentManager.runAgent` 等位置），调 `compactor.maybeCompact(session.messages)`。如果 compactor 抛 `L2 not implemented` 异常，turn-engine 不应该挂 —— maybeCompact 内部已经 catch 并 fallback 到 L1。

3. 测试：
   - it('compactL1 is idempotent: compactL1(compactL1(x)) === compactL1(x)')
   - it('maybeCompact skips L2 when l2Threshold is 0')
   - it('maybeCompact triggers L2 when estimated > threshold; D stub throws and circuit breaker counts')
   - it('after 3 consecutive L2 failures, circuitBroken === true and metric emitted once')
   - it('once circuit broken, subsequent maybeCompact returns L1 result without trying L2')

**完成判据**：
- 5 测试通过。
- typecheck 通过。
- turn-engine 内 1 个 wire-up 点能把消息传进 compactor 不抛错。
- D-Contract-4 满足。

**依赖**：无（与 W1-W4 并行）。

### W6 — HookRegistry 接口 + 1 fire-point

**Owner**：general-purpose 1 人 / 0.5-1 天

**目标文件**（新建）：
- `src/main/modules/agent-control/hook-registry.ts`
- `src/__tests__/hook-registry.test.ts`

**目标文件**（修改）：
- `src/main/modules/agent-control/tool-error-metrics.ts`：注册 `hookHandlerFailed: 'hook_handler_failed'`、`hookHandlerTimeout: 'hook_handler_timeout'`。
- `src/main/modules/agent-control/turn-engine.ts`：在 user message 进入处理前 fire `'user_prompt_submit'`；按修订执行顺序，W6 先做 skeleton/tests/metrics，直接改 `turn-engine.ts` 的 fire-point 等 W4 后或由 W4 统一接入，避免和 W1-W3 reminder 迁移冲突。

**改动清单**：

1. `hook-registry.ts`：
   ```ts
   export type HookName = 'pre_tool_use' | 'post_tool_use' | 'user_prompt_submit' | 'stop'

   export interface UserPromptSubmitPayload { userText: string; sessionId: string | null; timestamp: number }
   export interface PreToolUsePayload { toolName: string; input: Record<string, unknown> }
   export interface PostToolUsePayload { toolName: string; result: unknown; success: boolean }
   export interface StopPayload { reason: string }

   export type HookPayloadFor<H extends HookName> =
     H extends 'user_prompt_submit' ? UserPromptSubmitPayload :
     H extends 'pre_tool_use' ? PreToolUsePayload :
     H extends 'post_tool_use' ? PostToolUsePayload :
     H extends 'stop' ? StopPayload : never

   export interface HookHandler<P> { readonly name: string; readonly fn: (p: P) => Promise<void> | void; readonly timeoutMs?: number }

   export interface HookRegistry {
     register<H extends HookName>(name: H, handler: HookHandler<HookPayloadFor<H>>): () => void
     fire<H extends HookName>(name: H, payload: HookPayloadFor<H>): Promise<void>
   }

   export function createHookRegistry(): HookRegistry { ... }
   ```

2. `turn-engine.ts` fire-point：在 `execute` 函数最早期（user message 已进入 session 但 model 调用前）`await hooks.fire('user_prompt_submit', {userText, sessionId, timestamp: Date.now()})`。0 handler 时 fire 是 fast no-op。

3. 测试：
   - it('register returns unregister function that removes handler')
   - it('fire awaits handlers in registration order')
   - it('handler throw does not abort sibling handlers; emits hook_handler_failed metric')
   - it('handler exceeding timeoutMs emits hook_handler_timeout metric and continues')
   - it('all 4 HookName values typecheck-strict (compile-time test)')

**完成判据**：
- 5 测试通过。
- typecheck 通过。
- turn-engine 启动后 fire `user_prompt_submit` 不抛错（0 handler 时 fire 应该立即 resolve）。
- D-Contract-5 满足。

**依赖**：无（与 W1-W5 并行）。

### W7 — 文档同步 + 路线图状态

**Owner**：general-purpose 0.5 人 / 0.5 天

**改动清单**：

1. **`CLAUDE.md` §6.x 新增 §6.15 Reminder Registry / Compaction / Hooks**：
   ```
   ### 6.15 System reminder / Compaction / Hook 三件抽象
   - **System reminder**：所有"reach 模型的 system-level 文本" 通过 SystemReminderRegistry 注册（topic + priority + text + conflictsWith）。`turn-frame-steering` / `turn-engine` 内禁止内联 `systemReminder: <expr>` 或 `messages.push({role:'user',content:<reminder>})`。Lint rule `ready/no-inline-system-reminder-write` 强制。
   - **Layered compaction**：`createLayeredCompactor()` 提供 L1（cheap dedup / 截断，always-on）+ L2（token-threshold gated，D 阶段为 stub）。consecutive 3 次 L2 失败 → circuit break + emit `compaction_circuit_break` metric。
   - **Hook registry**：4 个 lifecycle 名固定（pre_tool_use / post_tool_use / user_prompt_submit / stop）。register 返回 unregister。fire 串行 await，handler throw 不阻断兄弟 handler。
   ```
2. **`AGENTS.md` §6.x 同步**（CLAUDE.md §12 要求保持一致）。
3. **`docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md` §5.1**：把 D 行从工作量描述改为 `[x] completed YYYY-MM-DD`。
4. **§5.1.3 加 E 准入 note**：E 阶段开工时要求 D 的 7 条 hard contract 全绿；E 落 reference-skill inject + close event 自然语言化的 registry 化。

**完成判据**：
- CLAUDE.md / AGENTS.md / 路线图同步。
- 文档 link 全部 reachable。

**依赖**：W1-W6 全部 land。

---

## 4. 团队依赖与执行顺序

```
W0 (audit) ─→ W1 (registry + 1 case) ─→ W2 (steering 剩余 4 case)
                                    ├─→ W3 (turn-engine 2 push)
                                    └─→ W4 (lint rule + verify:d)
              W5 (compactor 骨架) ────────────────────────────────┐
              W6 (hook registry) ────────────────────────────────┤
                                                                  ├─→ W7 (docs)
                              W2/W3 land ─→ W4 ──────────────────┘
```

**串行段**：W0 → W1。W1 完成后 W2/W3 可并行；W4 在 W2/W3 都 land 后跑 lint rule。
**并行段**：W5 / W6 的 skeleton/tests/metrics 与 W1-W3 并行；它们的 `turn-engine.ts` wire-up/fire-point 等 W4 后统一接入。
**最终段**：W7 在 W4/W5/W6 都 land 后 wrap 文档。

---

## 5. 端到端验证

```bash
# 1. 类型 + lint baseline
npm run typecheck
npm run lint:check
# 当前 baseline checker 不支持 d-gate；除非 W4 扩展 checker，否则只跑全量 baseline check。
node scripts/check-eslint-baseline.cjs

# 2. D 三件套 + 既有相关测试
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/system-reminder-registry.test.ts \
  src/__tests__/layered-compactor.test.ts \
  src/__tests__/hook-registry.test.ts \
  src/__tests__/turn-frame-steering.test.ts \
  src/__tests__/turn-engine-route.test.ts \
  src/__tests__/skill-domain-adapter.test.ts \
  src/__tests__/prompt-assembly.test.ts

# 3. 不退化 gate
npm run verify:c

# 4. 手动 dev 烟测（关键场景）
# - 普通 turn：user message 进入 → fire user_prompt_submit no-op → 模型回复正常
# - skill child-owned + budget warning 同时触发：模型只看到 1 段合并 reminder（child-owned 压制 typed-action-preferred；budget 与 child-owned 共存）
# - force_tool 缺必需输入：模型看到 force-tool-missing + checkpoint 合并 reminder
# - 长上下文 turn：messages 接近 16K，L1 触发截断；L2 stub throw 但 turn 不挂

# 5. 故意 break 检查（CI 应该挡住）
# - 在 turn-frame-steering 加一行 `systemReminder: '测试'` → eslint 立即报
# - 在 turn-engine push '系统补充：测试' → eslint 报
```

---

## 6. 关键文件路径速查

修改：
- `src/main/modules/agent-control/turn-frame-steering.ts`（W1+W2）
- `src/main/modules/agent-control/turn-engine.ts`（W3+W5+W6）
- `src/main/modules/agent-control/tool-error-metrics.ts`（W5+W6 metric 注册）
- `eslint-rules/index.mjs`（W4 注册新规则）
- `package.json`（W4 加 verify:d）
- `CLAUDE.md` §6.15（W7）
- `AGENTS.md`（W7 同步）
- `docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md`（W7 标记完成）

新建：
- `src/main/modules/agent-control/system-reminder-registry.ts`（W1）
- `src/main/modules/agent-control/system-reminder-assembly.ts`（W1）
- `src/main/modules/agent-control/layered-compactor.ts`（W5）
- `src/main/modules/agent-control/hook-registry.ts`（W6）
- `src/__tests__/system-reminder-registry.test.ts`（W1）
- `src/__tests__/layered-compactor.test.ts`（W5）
- `src/__tests__/hook-registry.test.ts`（W6）
- `docs/superpowers/plans/2026-04-30-D-pre-flight-audit-report.md`（W0）

---

## 7. 显式 out-of-scope

**不在 D 范围**，留给 E / F / 后续 follow-up：

- **reference-skill 内联**（`SkillContextOrchestrator.tryInlineReferenceSkillDoc`）：是 context document 注入，不是 turn-level reminder。E 阶段做。
- **close event 自然语言化**（`renderChildCommandOutcome`）：assistant→user 输出，不是 model→system input。**永远不**进 SystemReminderRegistry。
- **L2 历史压缩算法**：D 只立 stub + circuit breaker。E 阶段做真实压缩（先 LLM-summarize 旧 turn、再尾部保留）。
- **真实 hook handler 注册**：D 只立接口 + 1 fire-point。F 阶段做"Skill 注册 hook" / "用户配置 hook"。
- **token estimator**：D 用 `messages.map(m => m.content?.length ?? 0).reduce((a,b)=>a+b,0)` 这种 char-count proxy，足够触发 stub circuit breaker。真实 tokenizer 留给 E。
- **`buildBudgetWarningMessage` 函数体本身**：D 阶段函数保留（被 registry 调用）。如果 E 阶段改 budget warning 文案策略，那时再重构函数。

---

## 8. 风险与缓解

### 8.1 Registry 改造让既有 reminder 文案变化

**风险**：W1+W2 重排 priority / conflicts 后，模型实际收到的合并 reminder 跟旧版字面不同 → 模型行为漂移。

**缓解**：
- §3 定的 priority 数值规约让"重要 reminder（checkpoint=100）始终在前"，与现状语义一致。
- §3 默认 conflicts 表覆盖已知打架（child-owned vs typed-action-preferred），与 residual-debt §B1 列出的实例一致 —— 改造 = 关掉 bug，不是引入新行为。
- W2 每个 case 加一条 snapshot test 钉住"registry 输出 == 旧 inline 字面值"（同一 frame 输入）。任何 case 漂移立即被测试抓住。

### 8.2 Lint rule 误杀

**风险**：W4 的 `no-inline-system-reminder-write` 太严，把测试文件 / 注释里的 `systemReminder` 字段也报。

**缓解**：
- ESLint rule 实现时**只**扫 `src/main/modules/agent-control/`（path 白名单）。测试 / 注释不在范围。
- ObjectExpression 规则只看 `Property.value.type !== 'Literal' || value.value !== null` 的写入，跳过 reset-to-null 默认值。
- `messages.push` 规则只 ban `content` 是 `'系统补充'` 开头的字面量；变量传入 OK（registry 出来的）。

### 8.3 Hook registry 引入死代码

**风险**：D 只有 1 个 fire-point + 0 handler。`createHookRegistry` 的代码全是死代码，违反 §0.5 原则 "Simplicity First"。

**缓解**：
- §3 明确 hook registry 是"骨架"，不是"工程产品"。其存在意义是定义合同，而非投入使用。
- D-Contract-5 通过 typecheck + 5 测试钉死合同形状，这些测试本身就是 registry 的 user。
- 如未来 E 阶段决定不用 hook，rollback 是删 1 个文件 + 1 个 fire-point + 1 个测试文件，blast radius 小。
- 接受这部分"暂时投机"是为了 v3 §5.1 路线整体连贯（D 不立 hook 接口 → E/F 又得回头补一遍）。

### 8.4 Compactor 在生产关键路径但 L2 不实做

**风险**：W5 的 wire-up 把 compactor 接到 model call 前，每个 turn 都过一遍 maybeCompact。L1 是真实工作（截断），L2 永远 throw + circuit break，性能 / 错误日志噪音。

**缓解**：
- L2 默认 threshold = 0（disabled），调用方不显式打开就不触发 L2。turn-engine 默认配 0，等 E 阶段再打开。
- L1 既有逻辑只是从 prompt-assembly 移到 compactor，性能等价。
- 如果发现日志噪音，circuit breaker 触发后**永久** stop tracing 直到下次 turn 重建 compactor。

### 8.5 W2 改 turn-frame-steering 与 C 的 SkillDomainAdapter 改动冲突

**风险**：如果 C 阶段在改 SkillDomainAdapter 的 `arbitrateRunCapabilities`，W2 也在动 turn-frame-steering 的 reminder 输出，merge 时打架。

**缓解**：
- W0 audit 确认 C 当前 land 状态。如 C 已 land 完整 → W2 直接做。
- 如 C 还在 in-flight，W2 owner 跟 C 的 owner 协调"不要同时改 SkillDomainAdapter prepare 内 reminder 相关代码"。
- 若 C 后续要改 SkillDomainAdapter 的 reminder author 行为，那时让 SkillDomainAdapter 直接调 registry.register —— 这是 D 已经铺好的路径，无 schema 变化。

---

## 9. 与战略原则的对照

`CLAUDE.md §0.5` 的 5 条 + 升维 2 条原则在 D 的应用：

1. **先合同，后代码**：§1 给 7 条 hard contract，每条 CI 可验证。
2. **修根因，不修症状**：根因 2 是"4 处独立注入"，D 直接关掉根因（registry 单点）；不是修 B4 这一个具体打架案例。
3. **拒绝 legacy 兼容分支**：W2 改完后不留"既支持 inline 又支持 registry"双轨；ESLint hard rule 强制单轨。`buildBudgetWarningMessage` 函数留是因为它**本身是数据**（文本生成器），不是 legacy 注入路径；caller 100% 改用 registry。
4. **形态意识**：CC-Source 没有 `frame.steering.systemReminder` 这种结构（CC 是单一 system prompt + tool result message 流），Ready 有自己的 frame 抽象。D 不抄 CC 的 hook 形态（CC 是 process-wide，Ready 是 per-turn registry 实例 + per-engine hook registry）。
5. **CI 强制 > 文档约束 > 人审**：D-Contract-1/2/3/4/5 全部 CI 强制；CLAUDE.md §6.15 是文档辅助。
6. **抽象的边界 = 形态的差异**（agent 层原则 6）：reminder 内部是"per-turn dynamic 文本"，外部是"frame.steering.systemReminder string"。compactor 内部是 L1+L2 流水线，外部是 maybeCompact(messages) → messages。hook 内部是 ordered handlers，外部是 fire(name, payload) → Promise。三个抽象边界都清晰。
7. **重新做一遍优于继续打磨**（agent 层原则 7）：D 不在 turn-frame-steering 内"再分一层"；是把 reminder 注入整体迁出 turn-frame-steering，下一次新 reminder 直接 register，不需要回 turn-frame-steering 改 inline。

---

## 10. 文档维护

- D 完成后更新 `2026-04-30-skill-runtime-agent-layer-reframe.md` §5.1。
- 如 W1-W6 任何 worker 实施时发现本计划与现实不符，**优先**修计划 + frontmatter 加 `implementation_amendment: YYYY-MM-DD-<short>`。
- L2 算法 deferred 到 E 时，E 的 plan 必须引用 D 的 layered-compactor.ts 文件路径 + circuit breaker 合同。
- Hook 真实 handler 落地时（E 或 F），必须复用 D 的 HookRegistry 接口，不允许另起炉灶。

## 11. W7 Final Land Record

- Status: DONE. W7 docs synced and final `npm run verify:d` passed on 2026-05-01.
- HEAD at final verify: `10d261651192791098ea8e8a304caef7639898df`.
- Final verification:
  - `npm run verify:d` exited 0.
  - The run included nested `verify:c`, hard lint rule tests, and D focused tests.
  - D focused test tail: 97 tests, 97 pass, 0 fail.
  - `lint:check` reported existing warnings only: 0 errors, 541 warnings.
- Notable implementation amendment: W4 hard lint covered all `turn-engine.ts` inline `系统补充：` / `系统提醒：` message pushes, not only the original 3 W3 sites. The extra sites were migrated through `SystemReminderRegistry` without changing their trigger timing or text.
