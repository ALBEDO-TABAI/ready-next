---
title: P5d Maintenance/Emergence Status Boundary Implementation
date: 2026-06-20
enforce: false
scope: P5d / C26
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：代码/检查引用：scripts/__tests__/check-unwired-capability-markers.test.cjs, scripts/check-unwired-capability-markers.cjs。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# P5d Maintenance/Emergence Status Boundary

## Goal

自动模型维护回合已退役。生产启动与定时 tick 只保留本地确定性 crystallize 和 belief-decay，两者都不得读取 provider 配置或发起模型请求。candidate-maintenance 仍是未接入的独立边界；`cas-merge.ts` 和已上线的 emergence feed 不受影响。

## Implementation

1. 删除自动模型维护驱动、回合实现与伪状态面。
2. 从 runtime crystallize tick 移除 provider caller，保留本地确定性 crystallize 和 belief-decay。
3. 设置页只展示真实的本地维护状态，并明示说明不调用 AI 模型。
4. 负向门禁要求退役文件不存在，runtime 不得重新引用模型回合或 provider 配置。

## In Scope

- `runtime.ts` 中的维护 tick。
- `maintenance-llm-driver.ts` 与 `maintenance-llm-round.ts` 的退役。
- 信念卡 IPC、Renderer 类型与设置文案的真实状态。
- provider calls = 0 行为测试和防回归负向门。

## Out Of Scope

- 不改变 `cas-merge.ts`、确定性 crystallize/belief-decay 或 emergence feed 的生产地位。
- 不接入 `maintainAgentCandidates`。
- 不新增调度、run/finalizer 写入、迁移或生命周期 job。
- Do not alter P5c packet files, P5b handoff, P5a preroute, P5e derivation, P6 compaction, browser isolation, or specialist agent product routes.

## Verification

- `node scripts/check-unwired-capability-markers.cjs`
- `node --test scripts/__tests__/check-unwired-capability-markers.test.cjs`
- `node scripts/check-mandated-capability-is-live.cjs`
- `node --test scripts/__tests__/check-mandated-capability-is-live.test.cjs`
- `npx tsx@^4.19.2 --test src/__tests__/maintenance-llm-round.test.ts`
- `npm run verify:evolution-p3`
- `npm run verify:evolution-p4`
- `npm run typecheck`
