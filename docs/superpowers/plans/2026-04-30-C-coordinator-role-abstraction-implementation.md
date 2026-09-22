---
name: C — Coordinator Role 抽象（DomainAdapter v2）
description: v3 路线 C 阶段实施计划。把 TRIGGERS / 工具过滤 / 仲裁规则从 turn-engine + prompt-assembly 中挤出，下沉到每个 DomainAdapter 内部；新增 contributePromptFragment / arbitrateRunCapabilities / decorateUserText 三个方法；CI 强制 turn-engine 不再持有产品身份。
status: draft
enforce: false
counter_proposal: ../../archive/2026-09-06/docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# C — Coordinator Role 抽象（实施计划）

> **范围**：把"每个产品自己的 system prompt 片段、工具过滤规则、仲裁规则"从 `turn-engine.ts` 与 `prompt-assembly.ts` 下沉到对应 `DomainAdapter` 实例内部。结果：turn-engine 只剩"调度"职责，没有任何 `adapter.id === 'browser'` 类硬编码；`prompt-assembly.ts` 的 TRIGGERS 数组里只剩 `module: 'system'`。
>
> **公共行为不变**：用户视角 0 差异。每个产品的 prompt 命中条件、工具白名单、仲裁结果都与 C 之前等价（通过迁移测试钉死）。
>
> **不重命名 `DomainAdapter`**。它就是 Coordinator role 的实现名。架构概念上称 "Coordinator"（v3 §C 词汇），代码层保持 `DomainAdapter` 不动。文件顶部加一段说明把两个名字粘到一起，避免半截重命名留下两套词汇。
>
> **C 完成 = 5 件事**：
> 1. `turn-engine.ts` 内零 `adapter.id === '<product>'` 比较；
> 2. `turn-engine.ts` 内零 `import` 来自 `tools/browser-tools.ts` / `document-domain-helpers.ts` / `skills-tools.ts` 等单产品模块；
> 3. `prompt-assembly.ts` 的 `TRIGGERS` 数组只剩 `module: 'system'`；
> 4. 6 个 DomainAdapter 全部实现（或显式 `null` 退订）三个新方法；
> 5. `npm run verify:c` 绿灯，A0/A1/B 阶段全部 contract 测试不退化。

---

## 0. Context

### 0.1 为什么现在做

A0 / A0.5 / A1 / B 的"地基 + child runtime → SubAgent 迁移"完成后，agent 层的"长任务"维度已经收敛。剩下的横向分散是"短任务的产品形态"：每开一个新产品（未来的"AI 编程伴侣 mode"、"播客生成 mode"），都要在 turn-engine 与 prompt-assembly 各加一段 if-else / TRIGGERS 条目。这是 v3 §3 表里"Browser/Document/Skill mode 切换在 turn-engine 内嵌"那一行的原因。

C 不是修 bug，是**关掉 bug 的入口**：
- B4（多处 prompt 注入打架）的根因是 prompt 片段散落，没有"产品自己拿到自己的注入位"。
- 任何"为什么 force_document × allow_browser 能同时出现"类的 invariant 失谐都是因为仲裁规则不在产品自己手上。
- 任何"为什么 turn-engine 5000 行还在涨"的疑问都是因为新产品没有自己的注入点，只能往里塞。

C 的体量比 B 小：DomainAdapter 已经 60% 完成（6 个实现、registry-based 选择、prefix narrowing 共享 helper）。剩下 40% 是把 TRIGGERS 与仲裁挪进来。

### 0.2 Reconnaissance Facts（已实地核查，引用即真）

**DomainAdapter 现状**（`src/main/modules/agent-control/domain-adapter.ts:163-178`）：
```ts
interface DomainAdapter {
  id: string
  shouldHandle(params): boolean
  prepare(params): Promise<DomainAdapterPrepareResult>
  dispatch(params): Promise<DomainAdapterDispatchResult>
  applyResult(params): Promise<DomainAdapterApplyResult>
  buildProjectionPatch(params): Record<string, unknown> | null
}
```

6 个实现（host 注册顺序见 `claude-bridge/direct-chat.ts`）：
- `BrowserDomainAdapter`（`src/main/modules/agent-control/browser-domain-adapter.ts`）
- `DocumentDomainAdapter`（`document-domain-adapter.ts`）
- `RSSPDomainAdapter`（`rss-domain-adapter.ts`）
- `CalendarDomainAdapter`（`calendar-domain-adapter.ts`）
- `FeishuDomainAdapter`（`feishu-domain-adapter.ts`）
- `SkillDomainAdapter`（B 阶段引入，`skill-domain-adapter.ts`，~7KB）

**单一调度点**：`selectDomainAdapter(adapters, params)`（`domain-adapter.ts:229-237`）。**这是 C 之后**唯一允许的"按产品分支"位置。

**当前 turn-engine.ts 的 leakage 调查**（来自 Explore 报告）：
- `turn-engine.ts:1650`：`domainAdapters.find(adapter => adapter.id === 'browser')`
- `turn-engine.ts:1771-1789`：`selectedDomainAdapter?.id === 'browser' ? browserPrepareResult : ...`
- `turn-engine.ts:1790-1797`：`shouldHideBrowserProcessText`（产品逻辑写在 turn-engine 里）
- `turn-engine.ts:1576`：`Boolean((toolPolicy as any).forceDocumentTool)` — 文档专属 flag 由 turn-engine 直接读
- `turn-engine.ts:1532 / 1548 / 1668-1683 / 2490`：`browserDecisionMode` 多次读取，全是 turn-engine 在做产品判断

**TRIGGERS 现状**（`prompt-assembly.ts:130-203`）：6 条，覆盖 `feishu-doc / feishu-image / browser-upload / document-write / rss-analysis / calendar-write`。每条有 `pattern: RegExp`、`refs: [{path, title, summary}]`、`blocking: bool`。这些规则全是产品级的，但写在共享文件里。

**Layer 1 / A1 / B 的 contract 锁定**：
- A1 5 件：`SubAgent` 接口、`runSubAgent` generator、cleanup drain 单调用、abort-while-hung 单 terminal、metric 注册。
- B 9 件（C1-C9）：runner 5 个公共 API 不变 + AbortController 树 + cleanup 统一 + 5 条 Layer 1 测试。
- Layer 1 5 件：A1 identity guard、A2 resume failure surface、B2 `READY_SKILL_CHILD_RESUME_ENABLED`、B6 prepareResumeLifecycle、helper banner singleton 规约。
- C 不许碰这 19 项的实现，只许在它们之上做"调度面"的重排。

### 0.3 名字与概念的对齐

- **架构概念**：Coordinator role（v3 §C 词汇 / `agent-layer-reframe.md` §1.2 / §3）
- **代码实现名**：`DomainAdapter`（已有，6 实现）
- **C 之后**：在 `domain-adapter.ts` 顶部添加块注释说明这两个名字是同一回事；不做大规模重命名（rename 触及 50+ 文件，blast radius 不值得）。
- 未来引入 CC-Source 风格的"Worker SubAgent + Coordinator"双层时，再考虑分裂命名（C 阶段不需要）。

---

## 1. Hard Contracts（CI 必须可机器验证）

> **原则 1**：先写"如果这个改动成功，CI 能机器验证哪几条合同"。下面 7 条是 C 的硬合同，任何一条破坏 = C 失败。

### C-Contract-1：turn-engine 不持有产品身份

`src/main/modules/agent-control/turn-engine.ts` 中**禁止**出现下列模式：
- `\.id\s*===\s*['"](browser|document|skill|rss|calendar|feishu)['"]`
- `\.id\s*!==\s*['"](browser|document|skill|rss|calendar|feishu)['"]`
- 字符串字面量 `'browser'/'document'/'skill'/'rss'/'calendar'/'feishu'` 用作 `adapters.find(...)` 比较谓词

**CI 验证**：在 `eslint-rules/index.mjs` 注册 `ready/no-coordinator-id-leak`（hard rule，不进 baseline），AST 层匹配 `BinaryExpression` 左操作数是 `MemberExpression` 且属性名是 `id`，右操作数是 6 个产品名之一的字符串字面量。

### C-Contract-2：turn-engine 不导入单产品模块

`turn-engine.ts` 的 `import` 列表中**禁止**包含：
- `from './browser-domain-adapter'` 之外的任何 `tools/browser-*`
- `from './document-domain-helpers'` / `from './document-task-pipeline-executor'` / `from './document-task-pipeline'`（domain adapter 通过 `dispatch` 调用，turn-engine 不直接 import）
- `from '../tools/skills-tools'` 的具体函数（除 `getActiveSkillContext` 这种"运行时元数据查询"工具）

**CI 验证**：扩展 `scripts/check-subagent-isolation.cjs` 的兄弟脚本 `scripts/check-coordinator-isolation.cjs`，扫描 turn-engine.ts 的 import specifier 与白名单匹配。

### C-Contract-3：TRIGGERS 只剩 system

`prompt-assembly.ts` 的 `TRIGGERS` 数组中，所有 entry 的 `module` 字段必须 ∈ `{undefined, 'system'}`。任何 `'browser' | 'document' | 'rss' | 'calendar' | 'feishu' | 'skill'` 都视为迁移漏网。

**CI 验证**：`check-coordinator-isolation.cjs` 加一道 ts-AST 扫描，定位 `TRIGGERS` 数组字面量，每个 element 的 `module` property 不在白名单则报错。

### C-Contract-4：所有 adapter 显式实现新方法

升级后的 `DomainAdapter` 接口新增 3 个方法：`contributePromptFragment / arbitrateRunCapabilities / decorateUserText`。所有 6 个实现必须**显式**提供这 3 个方法 —— 即使是返回 `null`，也要写出来（对编辑者一目了然），不允许"接口可选 + 实现忽略"的隐性退订。

**CI 验证**：TypeScript 接口改为 required；`tsc --noEmit` 成为唯一验证。所有适配器构造函数包含三个显式 method（即使 `() => null`）。

### C-Contract-5：verify:c 绿灯

新增 `npm run verify:c`，包含：
1. `npm run typecheck`
2. `npm run lint:check`（包含 `ready/no-coordinator-id-leak` hard rule）
3. `node scripts/check-coordinator-isolation.cjs`（C-Contract-1/2/3 三个机制都跑）
4. `node scripts/check-eslint-baseline.cjs`
5. `npm run test:c:gates`
6. 焦点测试套件：
   - `src/__tests__/coordinator-contract.test.ts`（C 新增）
   - `src/__tests__/turn-engine-route.test.ts`（既有，必须不退化）
   - `src/__tests__/prompt-assembly.test.ts`（既有，必须不退化）
   - `src/__tests__/run-capability-controller.test.ts`
   - `src/__tests__/run-capability-controller-arbitration.test.ts`
   - `src/__tests__/browser-task-planner.test.ts`
   - `src/__tests__/browser-domain-orchestrator.test.ts`
7. `npm run verify:b`

### C-Contract-6：A0/A1/B 阶段不退化

- A0 词汇 invariant 测试通过（terminal reason union 不增成员）
- A1 8 个 contract 测试通过（`sub-agent-contract.test.ts`、`sub-agent-runner.test.ts`）
- B 的 5 条 Layer 1 contract 测试通过（identity guard / resume failure / RESUME_ENABLED flag / prepareResumeLifecycle / helper banner）
- B 的 runner 公共 API smoke 通过

**CI 验证**：`verify:c` 内嵌 `verify:b` 调用；任何一条 fail 则 C 失败。

### C-Contract-7：lint baseline 不增加

- `eslint-rules/baseline.json` 在 `coordinator-*` / `domain-adapter-*` 命名空间下零条目（这两类是从 day 1 开始的硬规则，不允许豁免）。
- 现有 `ui-history` 等历史 baseline 条目允许保留，但 C 提交不得新增任何条目。

**CI 验证**：`scripts/check-eslint-baseline.cjs` 继续生效。

---

## 2. 架构决定（Architecture Decisions）

### D1. 不重命名 `DomainAdapter`

保持 6 个 `*DomainAdapter` 类名 + 接口名 + 选择函数名 `selectDomainAdapter` 全部不动。

**理由**：rename 触及 ~50 文件 / ~200 引用，blast radius 大于收益。Coordinator 是架构概念名，DomainAdapter 是代码实现名 —— 用块注释绑定即可。

**实施**：在 `domain-adapter.ts` 顶部加入：

```ts
/**
 * === Coordinator role (v3 stage C) ===
 *
 * 每个 DomainAdapter 是一个 Coordinator role 实例。它对一个产品（browser /
 * document / skill / rss / calendar / feishu）的"模式行为"端到端负责：
 *   1. 模式触发：shouldHandle()
 *   2. 提示注入：contributePromptFragment()
 *   3. 工具过滤：prepare() 返回 allowedToolNames
 *   4. 仲裁规则：arbitrateRunCapabilities()
 *   5. 用户文本润色：decorateUserText()
 *   6. 执行：dispatch() / applyResult()
 *   7. 投影：buildProjectionPatch()
 *
 * turn-engine.ts 只做调度，不持有产品身份。引入新产品 = 实现新 DomainAdapter
 * 并在 host.domainAdapters 注册，turn-engine 不动。
 */
```

### D2. 接口扩展（3 个新方法，全部 required）

```ts
// === C 新增 ===

export interface CoordinatorPromptFragment {
  /** 用于 dedupe / debug */
  id: string
  /** 用于 trigger hit 报告 */
  label: string
  /** 用于 prompt-assembly 的优先级排序（数字越大越靠前） */
  priority: number
  /** 命中条件：返回 true 才注入 */
  matches: (context: { userText: string; route: TaskExecutionRoute | null }) => boolean
  /** 注入内容：返回 ref 列表（与现有 TRIGGERS 的 refs 同结构）*/
  refs: Array<{ path: string; title: string; summary: string; sensitive?: boolean }>
  /** 是否阻塞模式（同现有 TRIGGERS.blocking）*/
  blocking: boolean
}

export interface CoordinatorCapabilityArbitration {
  forceTool?: 'document' | 'browser' | 'skill' | null
  hideAssistantProcessText?: boolean
  budgetMultiplier?: number
  // 未来扩展：toolGroupOverrides / additionalAllowedTools / ...
}

export interface DomainAdapter {
  // ...existing 6 methods...

  // C 新增：贡献 prompt 片段
  contributePromptFragment: () => CoordinatorPromptFragment[] | null

  // C 新增：仲裁运行能力（forceDocumentTool 等专属 flag 来这里）
  arbitrateRunCapabilities: (
    params: DomainAdapterPrepareParams<TurnEngineSession>
  ) => CoordinatorCapabilityArbitration | null

  // C 新增：润色用户可见文本（如 browser 隐藏过程文本）
  decorateUserText: (
    text: string,
    params: { phase: 'pre_dispatch' | 'post_dispatch' }
  ) => string
}
```

**理由**：
- 三个方法都设为 required（不是 optional），遵循 §0.5 原则 1 "先合同"——所有 6 个适配器都必须显式回答 "我是否注入 prompt？"、"我是否仲裁？"、"我是否润色文本？"。即使全部 `return null` 也是显式声明。
- `contributePromptFragment` 一个函数返回数组，因为单产品可能有多条 trigger（如 feishu 有 doc + image 两条）。
- `arbitrateRunCapabilities` 仅在该 adapter 是当前激活 adapter（`shouldHandle === true` 且被 select）时被调用 —— 不是多 adapter 投票仲裁，避免跨产品仲裁规则纠缠。
- `decorateUserText` 替代 turn-engine 内 `shouldHideBrowserProcessText` 这类"产品自己决定文本可见性"的硬编码。

### D3. 优先级合并规则（取代 TRIGGERS 数组的"自然顺序"）

`prompt-assembly.ts` 的新工作流：

```
1. 调用 host.domainAdapters.flatMap(a => a.contributePromptFragment() ?? [])
   收集所有 fragment。
2. 按 priority 降序排序。同 priority 用 id 字典序作为稳定排序的二级 key。
3. 对每个 fragment 调用 fragment.matches(context)。命中则 push 到
   triggerHits 列表，否则跳过。
4. 后续 ref 加载、l1/l2 budget 截断逻辑保持不变。
```

**理由**：
- 现有 TRIGGERS 数组的"声明顺序 = 优先级"是隐式的（容易被未注意到的 push 改变行为）。改成 explicit `priority` 让产品自己声明严肃度：feishu 阻塞类 priority=100，文档写入 priority=50，浏览器一般规则 priority=20。
- 稳定排序避免不同产品的 fragment 在数组里位置乱跳引发 prompt diff。

### D4. 仲裁单点：active adapter 独裁

只有当前被 `selectDomainAdapter` 选中的 adapter 的 `arbitrateRunCapabilities` 会被调用并采纳。其他 adapter 的同名方法即使返回非 null，也被忽略。

**理由**：
- 已经踩过的坑（B4 多处 prompt 注入打架）证明"多源仲裁"是 bug 农场。
- "只有 owner 说话"是 §0.5 原则 4（形态意识）的应用：每次只有一个产品在跑，让它独占决定权。

### D5. 迁移顺序：小到大，最后啃 browser

按 turn-engine 现有 leakage 体量（grep 出来的 `id === 'X'` + `'X-specific' import` 数量）排序，从最小到最大：

| W# | 产品 | leakage 估计 | 备注 |
|---|---|---|---|
| W2 | rss + calendar + feishu | ~6 处 | 三个一起做（最简单） |
| W3 | skill | ~12 处 | B 阶段刚加，trigger 还在 prompt-assembly 里 |
| W4 | document | ~20 处 | `forceDocumentTool` flag 是 leakage 大头 |
| W5 | browser | ~40 处 | `browserDecisionMode` 整套 |

**理由**：
- 先小后大可以让 W2 小批量验证整套迁移路径正确，再用 W3/W4/W5 复用。
- Browser 是体量最大、最危险的，留到最后做时已经有 W2/W3/W4 三轮经验。
- 这条排序也是 v3 §6.1 的风险缓解："分产品逐步迁移，先迁一个最简单的（如 RSS），再迁 skill，最后迁 browser / document"。

### D6. CI 工具复用

新建 `scripts/check-coordinator-isolation.cjs` 复用 A1 已成形的 TS Compiler API 模式（`scripts/check-subagent-isolation.cjs`），不再用 grep 正则。**不允许**走 source-grep 反模式（违反 A0 的 invariant）。

在 `eslint-rules/index.mjs` 注册 `ready/no-coordinator-id-leak`，复用 A0 的 ESLint 自定义规则机制。

### D7. 与 B 共存

C 绝对不进 `skill-child-runner.ts` / `skill-child-sub-agent*.ts`（这些是 B 的 territory）。C 只进 `*-domain-adapter.ts` + `turn-engine.ts` + `prompt-assembly.ts` + `tool-registry.ts`（如有 leakage 残留）。

如果 W3（skill）开始时 B 还没完全 land，C 的 W3 worker 必须等 B 至少 land 到 W4（cleanup unification），否则 SkillDomainAdapter 仍在变化中。**实际操作**：W0 audit 时确认 B 已合并到 main / 已 land 完 W4，否则 W3 推迟到 B land 后启动；W2 / W4 / W5 与 B 互不阻塞，可并行。

---

## 3. Worker 划分（7 队）

> 每队 owner agent type = `general-purpose`（涉及多文件改动 + 测试）。所有队 land 后跑 §5 端到端验证。

### W0 — Pre-flight Audit（不动代码）

**Owner**：general-purpose 1 人，0.5 天

**输出文件**：`docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-C-pre-flight-audit-report.md`

**任务**：
1. 跑 `git grep -nP "\.id\s*===\s*['\"](browser|document|skill|rss|calendar|feishu)['\"]" src/main/modules/agent-control/turn-engine.ts`，列出每条 hit。
2. 跑 `git grep -n "import" src/main/modules/agent-control/turn-engine.ts | grep -E "(browser-tools|document-domain-helpers|document-task-pipeline|skills-tools)"`，列出每条 hit。
3. 列出 `prompt-assembly.ts` 的 TRIGGERS 数组每条 entry，按 `module` 分桶。
4. 检查 B 当前 land 状态（git log + 残余 untracked 文件 + 是否合并到 main），记录 W3 是否需要等待。
5. 检查是否有 `shouldHideBrowserProcessText` / `forceDocumentTool` 类硬编码字段在 turn-engine 内被读取，列出每个读点 file:line。

**完成判据**：报告 push 后，W1 owner 拿到完整 leakage 清单 + B 等待状态。

**依赖**：无。

### W1 — Coordinator 接口升级（不迁移）

**Owner**：general-purpose 1 人，0.5-1 天

**目标文件**（修改）：
- `src/main/modules/agent-control/domain-adapter.ts`：加 D2 三个方法 + D1 顶部块注释
- 6 个 `*-domain-adapter.ts`：每个加三个方法的**显式** `null/empty/passthrough` 实现（保持当前行为完全等价）

**目标文件**（新建）：
- `src/__tests__/coordinator-contract.test.ts`：5 条契约测试

**改动清单**：

1. `domain-adapter.ts`：
   - 顶部加块注释（D1 标准模板）。
   - 接口加 `contributePromptFragment / arbitrateRunCapabilities / decorateUserText` 三个方法（required）。
   - 新增 `CoordinatorPromptFragment / CoordinatorCapabilityArbitration` 类型导出。

2. 6 个 `*-domain-adapter.ts`（W1 内只加方法骨架，不迁移业务）：
   ```ts
   contributePromptFragment(): CoordinatorPromptFragment[] | null { return null }
   arbitrateRunCapabilities(): CoordinatorCapabilityArbitration | null { return null }
   decorateUserText(text: string): string { return text }
   ```

3. `coordinator-contract.test.ts`：
   ```ts
   it('every registered DomainAdapter implements the 3 new C methods')
   it('contributePromptFragment fragments have unique ids per adapter')
   it('arbitrateRunCapabilities returns null when adapter is not active')
   it('decorateUserText is identity by default')
   it('priority sort yields stable order for same priority + different ids')
   ```

**完成判据**：
- `tsc --noEmit` 通过（接口扩展 + 6 实现都满足）。
- 5 条契约测试通过。
- 现有所有测试 0 退化（W1 是纯 additive）。

**依赖**：W0。**不依赖** B（W1 只动 adapter 接口，不动 SkillDomainAdapter 业务）。如果 B 还在改 SkillDomainAdapter 行为，W1 加的三个方法用 `null` 实现，等于无操作。

### W2 — RSS / Calendar / Feishu 三个一起迁

**Owner**：general-purpose 1 人，1 天

**目标**：把 `prompt-assembly.ts` TRIGGERS 中 `module: 'rss' | 'calendar' | 'feishu'` 的 4 条（rss-analysis / calendar-write / feishu-doc / feishu-image）下沉到对应 adapter 的 `contributePromptFragment()`。

**改动清单**：

1. **每个 adapter 的 `contributePromptFragment` 实现**（参考模板）：
   ```ts
   contributePromptFragment(): CoordinatorPromptFragment[] {
     return [
       {
         id: 'rss-analysis',
         label: 'RSS 分析操作',
         priority: 30,
         matches: ({ userText }) => RSS_TRIGGER_PATTERN.test(userText),
         refs: [{ path: 'docs/rss-rules.md', title: 'RSS 分析规则', summary: 'RSS 拉取和分析规则' }],
         blocking: false,
       },
     ]
   }
   ```
   `RSS_TRIGGER_PATTERN` 从 `prompt-assembly.ts` 导入或迁移到 `rss-domain-adapter.ts`（建议迁过去）。

2. **`prompt-assembly.ts`**：
   - 删 TRIGGERS 数组里 4 条 module 非 system 的 entry。
   - 改 `triggerHits` 计算逻辑：先调 `host.domainAdapters.flatMap(a => a.contributePromptFragment() ?? [])`，然后按 priority 排序，跑 matches，命中后 push 到 hits。
   - 保留 system / undefined module 的 trigger（暂无，但保留架构位置）。
   - 注意 `prompt-assembly` 接收 host 的方式：现有的 `PromptAssemblyDeps` 需要扩展一个 `getCoordinators?: () => DomainAdapter[]` 入口（W2 加）。

3. **`prompt-assembly.test.ts`**：
   - 新增："给定 mock RSS adapter contributePromptFragment 命中，triggerHits 包含该 fragment id"
   - 新增："不命中则不出现"
   - 验证现有测试（如果有的话）现有 RSS 触发场景仍 pass —— 通过 mock host.domainAdapters 包含 RSSPDomainAdapter 实例。

4. **行为等价回归**：
   - 找一段实际 RSS 用户输入，跑改前/改后的 prompt assembly，diff 应该相同（refs 顺序 / blocking 状态）。这条手动 / 通过 snapshot test 验证。

**完成判据**：
- TRIGGERS 中 rss/calendar/feishu 4 条全删。
- 三个 adapter 的 `contributePromptFragment` 各自返回正确 fragment。
- prompt-assembly.test.ts 新测试通过。
- 现有任何依赖 RSS/calendar/feishu trigger 行为的测试通过。

**依赖**：W1。

### W3 — Skill 迁移

**Owner**：general-purpose 1 人，1 天

**前置 gate**：B 阶段已 land 至少到 W4（cleanup unification）。如未达成，W3 阻塞，W2/W4/W5 可继续。

**改动清单**：

1. `SkillDomainAdapter.contributePromptFragment()`：
   - 如果 prompt-assembly 当前还没有 skill-specific TRIGGERS，则保留 `null`（W3 仅做 prep）。
   - 如果有（B 阶段加进去的），把它迁过来。
2. `SkillDomainAdapter.arbitrateRunCapabilities()`：
   - 当前 turn-engine 是否对 skill 模式有专属仲裁？检查 `forceSkillTool` / `skillExecutionMode` 类 flag。如有，迁过来。
3. `tool-registry.ts` 中 `filterSkillPrimitivesBySession` 当前在哪里被调用？如果在 turn-engine 调，迁到 SkillDomainAdapter.prepare() 内。

**完成判据**：
- turn-engine.ts 内零 `from '../tools/skills-tools'` 直接 import（除运行时元数据查询）。
- SkillDomainAdapter 的 prepare 完整覆盖 skill 工具过滤。
- `tool-registry.test.ts` / `skills-tools-integration.test.ts` 等不退化。

**依赖**：W1 + B 至少 land 到 W4。

### W4 — Document 迁移

**Owner**：general-purpose 1 人，1-1.5 天

**改动清单**：

1. `DocumentDomainAdapter.contributePromptFragment()`：迁 `document-write` 这条 TRIGGER。
2. `DocumentDomainAdapter.arbitrateRunCapabilities()`：迁 `forceDocumentTool` 仲裁逻辑。
   - 当前 `turn-engine.ts:1576` 是 `Boolean((toolPolicy as any).forceDocumentTool)` —— 这个判断本质是"如果当前是 document mode，应该 force document tool"。迁到 DocumentDomainAdapter.arbitrateRunCapabilities 返回 `{ forceTool: 'document' }`，turn-engine 改为读 `arbitration.forceTool`。
3. `run-capability-controller.ts`（如已存在的话）：把 forceDocumentTool 内嵌规则改为读 active adapter 的 arbitration 结果。

**完成判据**：
- turn-engine 不直接读 `forceDocumentTool`，改为读 `arbitration.forceTool === 'document'`。
- `forceDocumentTool × allowBrowserTools` 同时存在时的降级逻辑保持等价（已有测试通过）。
- `run-capability-controller.test.ts` 不退化。

**依赖**：W1。

### W5 — Browser 迁移（最大）

**Owner**：general-purpose 1 人，1.5-2 天

**改动清单**：

1. `BrowserDomainAdapter.contributePromptFragment()`：迁 `browser-upload` TRIGGER。
2. `BrowserDomainAdapter.arbitrateRunCapabilities()`：
   - 迁 `browserDecisionMode === 'free_tool_loop' / 'tool_loop' / 'planner'` 等模式判断。
   - 迁 `shouldHideBrowserProcessText` 决定逻辑（用 `decorateUserText` 实现）。
3. `BrowserDomainAdapter.decorateUserText()`：实际隐藏过程文本（替换原 `turn-engine.ts:1790-1797` 的逻辑）。
4. turn-engine.ts 内的所有 `domainAdapters.find(a => a.id === 'browser')` 改为读 selectedDomainAdapter（如果 active），其他位置删掉。
5. `browserPrepareResult` 这种"只在 browser 路径上存在的中间产物"应该全部进入 selectedDomainAdapter.prepare 的 domainState（已有此机制），turn-engine 不直接拿。

**完成判据**：
- turn-engine.ts 内零 `'browser'` 字面量比较（除注释）。
- `browser-domain-adapter.test.ts` / `browser-task-planner.test.ts` 等不退化。
- 手动 dev 烟测：
  - 浏览器模式正常进入。
  - 长任务（如点击-上传）流程正确。
  - 过程文本隐藏行为不变。

**依赖**：W1 + W4（确保仲裁框架成熟）。

### W6 — Lint Gate + verify:c admission

**Owner**：general-purpose 1 人，0.5 天

**改动清单**：

1. **在 `eslint-rules/index.mjs` 注册 `ready/no-coordinator-id-leak`**：
   - 模板参考 A0 现有 rule 工厂。
   - 检测 turn-engine.ts 内 `\.id\s*===\s*['"]<6 个产品名>['"]`。
   - hard rule，不进 baseline。
   - 加到 `eslint.config.mjs` 的 rule 列表，并在 `eslint-rules/__tests__/a0-rules.test.mjs` 覆盖有效/无效样例。

2. **新建 `scripts/check-coordinator-isolation.cjs`**：
   - 复用 `scripts/check-subagent-isolation.cjs` 的 TS Compiler API 框架。
   - 三道 check：
     - turn-engine.ts 不导入单产品模块（白名单：`./*-domain-adapter`、共享 helper、运行时元数据查询）。
     - prompt-assembly.ts 的 TRIGGERS 数组只剩 system / undefined module。
     - turn-engine.ts 不用字面量 `'browser'/'document'/...` 做 adapter 比较（与 ESLint rule 双保险）。

3. **新建 `npm run verify:c` script**：
   - `package.json` scripts 里加：
     ```json
     "test:c:gates": "node --test eslint-rules/__tests__/*.test.mjs scripts/__tests__/*.test.cjs",
     "test:c:focus": "npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/coordinator-contract.test.ts src/__tests__/turn-engine-route.test.ts src/__tests__/prompt-assembly.test.ts src/__tests__/run-capability-controller.test.ts src/__tests__/run-capability-controller-arbitration.test.ts src/__tests__/browser-task-planner.test.ts src/__tests__/browser-domain-orchestrator.test.ts",
     "verify:c": "npm run typecheck && npm run lint:check && node scripts/check-coordinator-isolation.cjs && node scripts/check-eslint-baseline.cjs && npm run test:c:gates && npm run test:c:focus && npm run verify:b"
     ```
   - 内嵌 `verify:b` 调用确保 C-Contract-6 不退化。

4. **A1 boundary teardown 检查**（如果 B 还没完成）：W6 不再做 A1 残余清理（B 的 W0 已经做完）。

**完成判据**：
- `npm run verify:c` 在 main 分支跑成功。
- 故意引入一个 `'browser'` id 比较，eslint rule 立即报错。
- 故意把 `module: 'rss'` 写回 TRIGGERS，check-coordinator-isolation.cjs 立即报错。

**依赖**：W2/W3/W4/W5 全部 land。

### W7 — CLAUDE.md + 文档同步

**Owner**：general-purpose 0.5 人 / 0.5 天

**改动清单**：

1. **`CLAUDE.md` §6.x 新增 §6.14 Coordinator role**：
   ```
   ### 6.14 Coordinator role / DomainAdapter 抽象
   - 每个产品（browser / document / skill / rss / calendar / feishu）通过实现
     `DomainAdapter` 注册自己的 mode 行为：触发条件、提示注入、工具过滤、仲裁规则、
     用户文本润色、执行、投影。turn-engine.ts 只调度，不持有产品身份。
   - 引入新产品 = 实现新 DomainAdapter + 在 host.domainAdapters 注册，turn-engine 不动。
   - 改产品行为 = 改对应 *-domain-adapter.ts，不能反向去 turn-engine 内加 if-else。
   - CI 强制（`verify:c` + `eslint ready/no-coordinator-id-leak`）：turn-engine
     内零 `adapter.id === '<product>'` 比较；TRIGGERS 数组只剩 system；6 个 adapter
     全部显式实现 contributePromptFragment / arbitrateRunCapabilities / decorateUserText。
   ```
2. **`AGENTS.md`** 同步条目（CLAUDE.md §12 要求两份保持同步）。
3. **`docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md` §5.1 表**：把 C 行从 "3-5 天" 状态改为 `[x] completed YYYY-MM-DD`。

**完成判据**：
- CLAUDE.md / AGENTS.md 同步。
- 路线图 §5.1 标记 C 完成。

**依赖**：W6。

---

## 4. 团队依赖与执行顺序

```
W0 (audit) ─→ W1 (interface) ─┬─→ W2 (rss/calendar/feishu) ─┐
                              │                              ├─→ W6 (lint gate) ─→ W7 (docs)
                              ├─→ W4 (document) ─────────────┤
                              ├─→ W5 (browser) ──────────────┤
                              └─→ W3 (skill, gate B≥W4) ─────┘
```

**关键串行段**：W0 → W1 → W6/W7。
**关键并行段**：W2 / W3 / W4 / W5 在 W1 land 后可并行（每条产品迁移之间互不依赖）。

W3 受 B 进度门控：如 B 未 land 到 W4，W3 排在最后，W6 可先跑（不带 W3 改动）；W3 后 land 时 W6 重跑一次 verify:c 即可。

---

## 5. 端到端验证

每个 W 的测试通过后，跑这套综合 verify：

```bash
# 1. 类型
npm run typecheck

# 2. lint + C 自有 isolation
npm run lint:check
node scripts/check-coordinator-isolation.cjs
node scripts/check-eslint-baseline.cjs
npm run test:c:gates

# 3. C 焦点测试套件
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/coordinator-contract.test.ts \
  src/__tests__/turn-engine-route.test.ts \
  src/__tests__/prompt-assembly.test.ts \
  src/__tests__/run-capability-controller.test.ts \
  src/__tests__/run-capability-controller-arbitration.test.ts \
  src/__tests__/browser-task-planner.test.ts \
  src/__tests__/browser-domain-orchestrator.test.ts

# 4. 不退化 gate（A0/A1/B 全套）
npm run verify:b   # 内嵌 verify:a1 / verify:a0

# 5. 一键验收
npm run verify:c

# 6. 手动 dev 烟测（如本轮需要 Electron UI 复查）
# - 浏览器模式：进站 → 上传 → 提交，过程文本隐藏行为正确
# - 文档模式：force_document × allow_browser 冲突场景仍降级到 document
# - skill 模式：长 skill 启动 → budget paused → resume，行为等价
# - rss 模式：rss-analysis trigger 命中时仍注入正确 ref
# - 跨模式切换：browser → document 切换时 prompt 片段切换正确
```

---

## 6. 关键文件路径速查

修改：
- `src/main/modules/agent-control/domain-adapter.ts`（W1）
- `src/main/modules/agent-control/turn-engine.ts`（W2/W3/W4/W5 各自删 leakage）
- `src/main/modules/agent-control/prompt-assembly.ts`（W2/W3/W4/W5 各删 TRIGGERS 条目）
- `src/main/modules/agent-control/browser-domain-adapter.ts`（W5）
- `src/main/modules/agent-control/document-domain-adapter.ts`（W4）
- `src/main/modules/agent-control/rss-domain-adapter.ts`（W2）
- `src/main/modules/agent-control/calendar-domain-adapter.ts`（W2）
- `src/main/modules/agent-control/feishu-domain-adapter.ts`（W2）
- `src/main/modules/agent-control/skill-domain-adapter.ts`（W3）
- `src/main/modules/agent-control/run-capability-controller.ts`（W4 如存在）
- `src/main/modules/agent-control/tool-registry.ts`（W3 如有 leakage）
- `package.json`（W6 加 verify:c）
- `CLAUDE.md` §6.14（W7）
- `AGENTS.md`（W7）
- `docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md` §5.1（W7）

新建：
- `scripts/__tests__/check-coordinator-isolation.test.cjs`（W6）
- `scripts/check-coordinator-isolation.cjs`（W6）
- `src/__tests__/coordinator-contract.test.ts`（W1）
- `docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-C-pre-flight-audit-report.md`（W0）

---

## 7. 显式 out-of-scope

**不在 C 范围**，留给 D / E / F follow-up：

- **D 阶段任务**：reminder registry / 分层 compaction / hook 系统骨架。C 不引入 hook，不改 compaction，不改 reminder。
- **重命名 DomainAdapter → Coordinator**：D1 决定保留名字。如未来 CC-Source 风格的 Worker SubAgent + Coordinator 双层引入时再考虑。
- **多 adapter 仲裁投票机制**：D4 决定 active adapter 独裁。"两个 adapter 都参与仲裁"的需求不在 C 范围。
- **新增产品 adapter**：C 不新增产品，只重排 6 个已有产品的代码归属。
- **修 4 处 prompt 注入打架（B4）**：C 完成后 4 处会自然变 1 处（活跃 adapter 自己负责），但 C 阶段不主动修 B4 的具体 case；如发现迁移过程中某条 prompt 行为差异，记入 audit 报告，C 后开 follow-up。
- **B 阶段任何残余债**：B 还在跑的时候 C 不动 SkillDomainAdapter / SkillChildSubAgent。

---

## 8. 风险与缓解

### 8.1 W2 第一次端到端跑迁移时发现新 leakage

**风险**：W0 audit 没看到的 leakage 在 W2 实施时暴露（如 `tool-registry.ts` 里另有 product-id 比较）。

**缓解**：W2 owner 在迁移过程中遇到任何 leakage 立即记入 `audit-report.md` 第二节"实施期发现的 leakage"，不就地修。W6 lint rule 设计时带上"扩展白名单"机制（lint rule 仅扫 turn-engine.ts，其他文件如 tool-registry 单独 audit）。如果发现 tool-registry 也有 leakage，加进 W3/W6 的范围（tool-registry 的 skill leakage 已经在 W3 范围内）。

### 8.2 W5 browser 迁移破坏长期跑通的浏览器流程

**风险**：browser 是最复杂的产品（task planner / decision mode / process text 隐藏 / 上传流程），迁移过程中行为漂移概率最高。

**缓解**：
- W5 之前先在 worktree 跑一遍现有 `browser-task-planner.test.ts` + `browser-domain-adapter.test.ts`，记录 baseline。
- W5 实施时每个改动前后跑 baseline，确保数字一致。
- 完成后手动跑 §5 第 6 步的浏览器 4 个用例。
- 如手动测试发现差异，立即标记 W5 失败，单独立 follow-up，不强行 land。

### 8.3 W3 与 B 阶段时序冲突

**风险**：B 还在改 SkillDomainAdapter 行为时，W3 也在改它的 contributePromptFragment / arbitrateRunCapabilities，git rebase 痛苦。

**缓解**：
- W3 启动前严格门控：B 必须 land 到 W4（cleanup unification），SkillDomainAdapter 业务行为冻结。
- W3 owner 启动前找 B owner 确认"SkillDomainAdapter 接下来 1-2 天不会改 prepare/dispatch 主流程"。
- 如 B 后续还需要改 SkillDomainAdapter，新改动同时 patch C 的方法即可（已经分离）。

### 8.4 lint rule 误杀

**风险**：`no-coordinator-id-leak` 规则太严，把测试文件 / 注释里的 `'browser'` 字面量也报错。

**缓解**：
- rule 实现时**只**扫 `src/main/modules/agent-control/turn-engine.ts` 单文件（path 白名单）。
- 测试文件 / 适配器自己内部用 `this.id === 'browser'` 这类自我比较 OK。
- 注释 / 字符串字面量不在 BinaryExpression 里的不报。

---

## 9. 与战略原则的对照

`CLAUDE.md §0.5` 的 5 条原则（+ 升维文档新增的 2 条）在 C 阶段的应用：

1. **先合同，后代码**：§1 给出 7 条 hard contract，每条都 CI 可验证。
2. **修根因，不修症状**：C 不修 B4 的具体 prompt 打架案例，而是切掉"prompt 片段散落"的根因 —— 让活跃 adapter 独占 prompt 注入位。
3. **拒绝 legacy 兼容分支**：W1 三个新方法都设为 required（不是 optional），任何 adapter 都必须显式声明，避免"接口可选 + 实现忽略"的隐性退订。
4. **形态意识**：CC-Source 的 Coordinator 是 feature-flag 切换的"角色"（Worker 列表 + 任务分配），Ready 的 6 产品是平行模式（每次只 1 个激活）—— D4 规定 active 独裁，不抄 CC 的多 worker 模型。
5. **CI 强制 > 文档约束 > 人审**：C-Contract-1/2/3 全部 CI 强制（lint rule + isolation script + tsc）；CLAUDE.md §6.14 是文档辅助，不是主防线。
6. **抽象的边界 = 形态的差异**（agent 层原则 6）：DomainAdapter 内部是产品 owner，外部是 turn-engine scheduler，边界清晰。
7. **重新做一遍优于继续打磨**（agent 层原则 7）：C 不是在 turn-engine 内"再分一层"细化 mode dispatch；是把 mode dispatch 整体迁出 turn-engine。

---

## 10. 文档维护

- C 完成后更新 `../../archive/2026-09-06/docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md` §5.1 的 C 行状态。
- 如 W2-W5 任何一个 worker 实施时发现本计划与现实不符，**优先**修计划 + 在计划里加 implementation_amendment frontmatter 字段，不就地"算了"。
- 不复制 B 计划的 audit-patch 模式（C 第一版即定稿，因 DomainAdapter 已有底盘）。如有 codex audit 修订，append amendment block，不修主文。

---

## 11. Implementation Completion Record

Date: 2026-05-01
Branch: `codex/skill-runtime-b-plan`
HEAD at verification: `a1bcf477535e38c4883841d9473f982567af5d31`

W1-W7 status:
- W1/W3: completed. Runtime and RunCoordinator pass the real coordinator list per run, and contract tests cover the forwarding path.
- W2: completed. RSS / Calendar / Feishu prompt fragments live in their adapters.
- W4: completed. Document trigger and `forceDocumentTool` arbitration live in `DocumentDomainAdapter`.
- W5: completed. Browser trigger, prepare reuse, and process-text hiding live through `BrowserDomainAdapter`.
- W6: completed. `check-coordinator-isolation.cjs`, `ready/no-coordinator-id-leak`, and `verify:c` are wired.
- W7: completed. CLAUDE / AGENTS / roadmap docs are synchronized.

Verification evidence:
- `npm run verify:c` exited 0.
- `npm run lint:check` exited 0 with the existing warning baseline (`541 problems`, `0 errors`, `541 warnings`).
- `node scripts/check-eslint-baseline.cjs` reported `A0 ESLint baseline ok (143 entries)`.
- `npm run test:c:gates` reported `48` passing tests.
- `npm run test:c:focus` passed through the `verify:c` chain.
- `npm run verify:b` completed inside `verify:c` and exited 0.
