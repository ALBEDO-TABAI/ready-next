---
title: Agent Browser Surface + Specialist Studio 实施子计划
date: 2026-06-19
status: approved by Codex/Claude consensus, enforce 生效
owner: 白
author: Codex
executor: Codex
reviewer: Claude
enforce: false
pairs_with:
  - outputs/agent-audit/fix-plan/07-AGENT-BROWSER-SPECIALIST-ROUTE-RECALIBRATION.md
  - outputs/agent-audit/fix-plan/22-CONSENSUS-P7D-P8AB-ROUTE-REVISION.md
scope:
  - P7d-code
  - P8a/P8b-read
  - blueprint-prep
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Agent Browser Surface + Specialist Studio 实施子计划

## 0. 完成标准

本批只解决两个当前可证明的问题：

1. **agent browser write 必须有代码派生的 surface intent**，不得因为缺省参数而静默落到用户当前浏览器页。
2. **专项 agent 系统必须有集中只读 Studio 与 why-no-handoff trace**，让用户看见现有 agent、内容物、路由卡、任务归属和没分派原因。

本批只预留"我要一个 xxx 类型专项 agent"的 blueprint 信息架构与 schema；不实现创建写入。

完成时必须满足：

- P7d 焦点测试和 gate 通过。
- P8 read-only Studio 焦点测试通过。
- `npm run typecheck` 通过。
- 涉及 SQLite/read repository 的改动跑 `npm run verify:native`。
- 不新增 specialist 创建写入路径，不调用 `registry.create`。

## 1. 禁止事项

- 不直接扩 `AgentBrowserSurface` 为 `read-only-observe`。
- 不把 `read-only-observe` 放进 browser write lease。
- 不把 `tool-executor.ts` 当成唯一 browser choke point。
- 不做 BrowserView owner chip、上锁 UI、独立 partition、真实 app 前台不变硬验收。
- 不修改高风控 visible collection 的产品策略。
- 不让 staged routing card 进入 prompt/preroute active-only 路径。
- 不让 Studio 直接调用 generic `agent:beliefCards:transition` 激活 routing card。
- 不实现聊天里创建专项 agent，不持久化 blueprint，不扩展确认 token 写路径。

## 2. Slice A · P7d-code

### A1 · Surface intent 类型与映射

新增纯模块，定义代码派生 intent：

- `user-view-assisted` → engine surface `user-view`，需要 user-view turn lease。
- `agent-view-background` → engine surface `agent-view`，必须有 agent tab / scoped facade。
- `read-only-observe` → no engine write surface，不需要 write lease。

预期落点：

- `src/main/modules/browser-engine/browser-surface-binding.ts`
- `src/main/modules/browser-engine/agent-browser-errors.ts`

测试：

- `src/__tests__/browser-surface-binding.test.ts`

### A2 · 覆盖生产 agent dispatch 入口

新增 helper，例如 `resolveBrowserToolSurfaceBinding()`，由以下入口调用：

- `src/main/modules/tools/tool-executor.ts`
- `src/main/modules/tools/browser-agent-runner.ts`
- `src/main/modules/browser-engine/scoped-browser-facade.ts`

要求：

- browser write 没有 intent → structured deny。
- `user-view-assisted` 没有 turn lease → structured deny。
- `agent-view-background` 没有 agent tab/scoped tab → structured deny。
- read-only 工具保持可读，不强要 write lease。

测试：

- 扩展 `src/__tests__/browser-free-loop-lease-dispatch.test.ts`
- 扩展 `src/__tests__/scoped-browser-facade.test.ts`
- 新增 `src/__tests__/browser-surface-gate.test.ts`

### A3 · Gate

新增 gate，枚举 production agent browser write 入口与允许旁路。

预期落点：

- `scripts/check-browser-surface-binding.cjs`
- `scripts/__tests__/check-browser-surface-binding.test.cjs`
- `package.json` 新增 `verify:browser-surface`

允许旁路：

- browser module IPC / native service 内部调用。
- 底层 browser 工具单元测试直接调用。
- 明确标注的 browser engine pure tests。

验证：

```bash
node scripts/check-browser-surface-binding.cjs
node --test scripts/__tests__/check-browser-surface-binding.test.cjs
npx tsx@^4.19.2 --test src/__tests__/browser-surface-binding.test.ts src/__tests__/browser-surface-gate.test.ts src/__tests__/browser-free-loop-lease-dispatch.test.ts src/__tests__/scoped-browser-facade.test.ts
npm run typecheck
```

## 3. Slice B · P8a/P8b-read

### B1 · Studio read model

新增只读聚合模型，供 renderer Studio 使用。

数据块：

- agent registry：main / active / staged-like candidates / retired / merged。
- per-agent knowledge inventory：RULES / knowledge cards / routing cards summary。
- routing inventory：active/staged/invalid routing cards，包含 disabled reason。
- owned tasks：按 `ownerAgentId` 最近 N 条。
- recent preroute trace：最近 N 次 evaluation 与 why-no-handoff 原因。
- blueprint placeholders：只读占位，当前可为空。

预期 main 落点：

- `src/main/modules/agent-control/agents/specialist-studio-read-model.ts`
- `src/main/modules/claude-bridge/ipc/agent-system-studio-group.ts`
- `src/preload/index.ts`
- `src/renderer/types/electron.d.ts`

测试：

- `src/__tests__/agent-system-studio-read-model.test.ts`
- `src/__tests__/agent-system-studio-ipc.test.ts`

### B2 · Routing inventory

新增 Studio-only inventory；不得改变 `BeliefCardStore.listRoutingCards()` active-only 语义。

要求：

- staged routing card 可见。
- missing triggers 可见。
- target inactive / retired / merged 可见。
- invalid card 可见为 disabled，不进入 preroute。

预期落点：

- `src/main/modules/agent-control/knowledge/belief-card-store.ts`

测试：

- 扩展 `src/__tests__/belief-card-store.test.ts`
- 扩展 `src/__tests__/session-preroute.test.ts`，证明 staged 仍不进入 preroute。

### B3 · Preroute trace

新增 trace builder 与 in-memory ringbuffer，不改变现有 `evaluateSessionPreroute()` 返回语义。

trace reason 至少包含：

- `routing_off`
- `suggest_only`
- `card_staged`
- `missing_triggers`
- `target_inactive`
- `no_keyword_match`
- `precedent_conflict`
- `state_owner_inactive`

预期落点：

- `src/main/modules/agent-control/agents/session-preroute-trace.ts`
- `src/main/modules/agent-control/runtime-core/runtime.ts`
- `src/main/modules/claude-bridge/ipc/session-preroute-group.ts`

测试：

- `src/__tests__/preroute-trace.test.ts`

### B4 · Owner task read

新增按 `ownerAgentId` 的只读查询，不新增 handoff-chain 表。

预期落点：

- `src/main/modules/repositories/task-projection-repository.ts`
- `src/main/modules/agent-control/runtime-core/runtime.ts`
- `src/main/modules/claude-bridge/ipc/agent-system-studio-group.ts`

测试：

- `src/__tests__/agent-system-owned-tasks.test.ts`

### B5 · Renderer Studio

新增独立 Settings section：`agent-system`。

预期落点：

- `src/renderer/components/agent-system/AgentSystemStudio.tsx`
- `src/renderer/pages/Settings.tsx`

UI 要求：

- 不放在 `personalities` section 下面。
- 可看主 agent、专项 agent、候选、退休/合并。
- 可看知识/路由/任务/trace。
- staged blueprint 区域只读占位，显示"后续可从对话/手动/候选生成"。
- 不显示可创建按钮，除非按钮明确 disabled 且不触发任何写 IPC。

测试：

- `src/__tests__/agent-system-studio-render.test.tsx`
- `scripts/check-specialist-studio-readonly.cjs`

验证：

```bash
npx tsx@^4.19.2 --test src/__tests__/agent-system-studio-read-model.test.ts src/__tests__/agent-system-studio-ipc.test.ts src/__tests__/preroute-trace.test.ts src/__tests__/agent-system-owned-tasks.test.ts src/__tests__/agent-system-studio-render.test.tsx
node scripts/check-specialist-studio-readonly.cjs
npm run typecheck
npm run verify:native
```

## 4. Slice C · Blueprint-prep

本批只写 schema 与只读占位，不做持久化。

### C1 · Schema

定义 future blueprint 类型：

- `specialistId`
- `displayName`
- `charter`
- `intendedDomain`
- `nonGoals`
- `recurringTasks`
- `requiredInputs`
- `expectedOutputs`
- `routingTriggers`
- `routingActivateOnCreate`
- `seedRulesText`
- `knowledgeSeeds`
- `migrationCandidates`
- `toolSafetyNotes`
- `source`
- `userRequestVerbatim`
- `clarificationAnswers`
- `admissionVerdict`
- `qualityChecks`

预期落点：

- `src/shared/agent-specialist-blueprint.ts`

测试：

- `src/__tests__/agent-specialist-blueprint-schema.test.ts`

### C2 · Funnel contract gate

新增只读 gate，先防止当前批次出现绕过计划的创建写入。

预期落点：

- `scripts/check-specialist-create-funnel.cjs`
- `scripts/__tests__/check-specialist-create-funnel.test.cjs`

当前批次 gate 规则：

- 新增文件不得直接调用 specialist `registry.create`。
- 不得新增 chat-driven creation IPC。
- 不得新增 blueprint persistence write。
- 现有 emergence derivation path 可保留。

验证：

```bash
npx tsx@^4.19.2 --test src/__tests__/agent-specialist-blueprint-schema.test.ts
node scripts/check-specialist-create-funnel.cjs
node --test scripts/__tests__/check-specialist-create-funnel.test.cjs
npm run typecheck
```

## 5. 总验证

本批收尾至少跑：

```bash
npm run verify:browser-surface
npx tsx@^4.19.2 --test src/__tests__/agent-system-studio-read-model.test.ts src/__tests__/agent-system-studio-ipc.test.ts src/__tests__/preroute-trace.test.ts src/__tests__/agent-system-owned-tasks.test.ts src/__tests__/agent-system-studio-render.test.tsx src/__tests__/agent-specialist-blueprint-schema.test.ts
node scripts/check-specialist-studio-readonly.cjs
node scripts/check-specialist-create-funnel.cjs
npm run typecheck
npm run verify:native
```

若 Slice B renderer 改动较大，补一次真实 dev app Settings 基础打开检查，确认 `agent-system` section 可进入且页面不白屏。

## 6. 2026-06-20 Route Update

后续 P7c2/P7c3 已补上 foreground preservation live proof 与 BrowserView-proof native lock overlay，但这条实施线仍只证明：

- browser write 有代码派生 surface binding；
- visible `user-view-assisted` 有 lease / reclaim / native lock overlay；
- background `agent-view` 必须绑定 agent tab。

它不证明 agent browser 已有独立 BrowserView/profile/partition，也不证明 visible browser occupation 被彻底消除。该产品/基础设施决策进入后续 **P7c4 · independent agent browser isolation decision/spike**，见 `outputs/agent-audit/fix-plan/121-CONSENSUS-BROWSER-SPECIALIST-PRODUCT-ROUTE-UPDATE.md`。

最新 Claude/子审查复审接受该拆分：P7c4 是后续独立 browser identity/profile/partition 决策，不并入当前 P1b/P2/P3 修复线。详见 `outputs/agent-audit/fix-plan/153-CONSENSUS-BROWSER-SPECIALIST-CLAUDE-SUBAGENT-REVIEW.md`。

用户后续补充专项 agent 创建意图后，路线刷新再次确认 P7c4 的边界，见 `outputs/agent-audit/fix-plan/147-CONSENSUS-SPECIALIST-INTENT-BROWSER-ROUTE-REFRESH.md`。P7c4 不得把 lock overlay、隐藏 tab 或同 session agent tab 称为隔离；它必须先做 decision/spike，并明确选择：

- 是否采用独立 BrowserView/profile/partition 或等价可检查身份边界；
- 登录、cookie、session 是隔离、共享还是显式桥接；
- 站点卡学习是否按 browser 身份隔离或共享；
- 哪些任务仍允许 visible `user-view-assisted` co-driving；
- visible co-driving 下 native lock overlay 仍必须出现；
- 若实现隔离，必须有 live proof 证明用户当前 tab、URL、focus、scroll、typing state 不被 agent-view 工作扰动。

重新登录后的短 Claude prompt 已成功返回 REVISE，并同意 P7c4 留在 browser module/product lane：lock overlay（控制/可见性）与 isolation（身份/状态分离）是正交问题，不能混称。两轮无输出留痕仍保留在 `outputs/agent-audit/fix-plan/144-CLAUDE-LATEST-SPECIALIST-BROWSER-ROUTE-PROMPT.md`、`145-CLAUDE-LATEST-SPECIALIST-BROWSER-ROUTE-FAILURE.md`、`146-CLAUDE-LATEST-SPECIALIST-BROWSER-MICRO-FAILURE.md`。
