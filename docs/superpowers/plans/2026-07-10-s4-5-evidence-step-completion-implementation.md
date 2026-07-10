---
title: S4-5 证据化步骤完成判定实施契约
date: 2026-07-10
kind: implementation
enforce: true
status: implemented
depends_on:
  - 2026-06-09-browser-observation-probe-layer-implementation.md (WP3 + WP5 PASS)
  - 2026-06-10-agent-stability-closure-implementation.md (S4-3)
verify_entry: npx tsx@^4.19.2 --test src/__tests__/plan-persistence-reinjection.test.ts src/__tests__/browser-domain-orchestrator.test.ts
---

# S4-5 证据化步骤完成判定

## 1. 前置复核

结论：**PASS，可解除 blocked。**

- WP3 已成为正式工具链：`browser_act_on_target` 进入 catalog，强制 fresh `target_id + generation`，stale/ambiguity/跨 frame/readBack 均有行为测试；D10–D18 真机记录证明目标行动和动作后复查跑在实际 Electron 页面链路。
- WP5 已进入 live browser free-loop：`BrowserDomainOrchestrator.recordToolLoopProgress()` 收集结构化 `BrowserTaskEvidence`；`browser-domain-orchestrator.test.ts` 钉死“模型口头说完成不推进、page-map evidence 推进”；`agent-runtime-host-contract.test.ts` 钉 live host 接线。
- 未通过的不是 Plan P，而是 S4-3 的独立活动计划曾只根据工具返回推进，没有绑定任务句柄、终态和交付数量。

## 2. 机器合同

1. 活动计划只允许 `verify:'evidence'`，并持久保存发现任务 ID、后台执行任务 ID、冻结清单数量、已保存数、失败数和剩余数。
2. 每步声明一种结构化证据要求：
   - `collection_manifest`：发现任务必须已完成，且冻结目标数大于 0；queued/running/paused 只记录句柄，不完成步骤。
   - `collection_run`：逐项采集必须引用已记录的发现任务，并返回不同的可追踪执行句柄。
   - `media_download_complete`：`ok=true`、`completion=complete`、`remaining=0`、`failedCount=0`，已保存数必须等于冻结清单数。
   - `task_terminal_complete`：查询 ID 必须与已记录句柄一致，状态为 completed，且数量完整。同一份结构化结果可连续证明相邻步骤。
3. 普通文本、空 JSON、只有 `ok:true`、只有工具名、running、partial、存在失败项或剩余项，均不能完成最终复核。
4. 计划注入只显示当前缺失的证据，不暴露内部判定标签。
5. 计划 scope、TTL、步骤顺序和现有工具入口不变；不新增浏览器工具，不改 Plan P 证据生成。

## 3. 改动面

- `active-plan-step-reminder.ts`：给步骤增加 evidence requirement；以确定性解析器替换工具存在性推进。
- `plan-persistence-reinjection.test.ts`：覆盖 queued 不推进、完整清单推进、句柄不匹配不推进、partial 不收口、数量完整才完成。
- `browser-domain-orchestrator.ts` 不改：它是 Plan P 已验收的自由浏览循环证据面，本项只消费同口径的结构化工具事实。

## 4. 回滚

回滚仅还原活动计划推进解析器与提示文案；不触碰 Plan P、BrowserTaskEvidence 或浏览器动作实现。

## 5. 实施结果

- `ActivePlan.verify` 只允许 `evidence`；发现句柄、执行句柄、冻结目标数、已保存/失败/剩余数持久化在证据快照中。
- 冻结数量不可被后续结果改写；任务句柄不一致、queued/running/paused、partial、空 JSON、单独 `ok:true`、失败或剩余非零均不推进最终步骤。
- 同一结构化结果只能连续证明相邻步骤；提醒只显示当前缺少的证据，源码与测试已清除 `weak` 判据文案。
- `plan-persistence-reinjection.test.ts` 完整覆盖 queued 不推进、完整清单推进、句柄不匹配不推进、partial 不收口、数量完整才收口；定向链与 `verify:stability` 通过。
