---
title: S4-5 证据化步骤完成判定实施契约
date: 2026-07-10
kind: implementation
enforce: true
status: implemented
depends_on:
  - 2026-06-09-browser-observation-probe-layer-implementation.md (WP3 page evidence)
  - 2026-06-10-agent-stability-closure-implementation.md (S4-3)
verify_entry: npx tsx@^4.19.2 --test src/__tests__/plan-persistence-reinjection.test.ts src/__tests__/browser-domain-orchestrator.test.ts
---

# S4-5 证据化步骤完成判定

## 1. 前置复核

结论：**PASS，可解除 blocked，但验收依据在 2026-07-11 对抗复核后更正为 live SDK 证据漏斗。**

- WP3 已成为正式工具链：`browser_act_on_target` 进入 catalog，强制 fresh `target_id + generation`，stale/ambiguity/跨 frame/readBack 均有行为测试；D10–D18 真机记录证明目标行动和动作后复查跑在实际 Electron 页面链路。
- 旧 WP5 **没有**进入 live SDK：`BrowserDomainAdapter.applyResult()` 在当前生产链无调用方；`BrowserDomainOrchestrator.recordToolLoopProgress()` 是退役 TurnEngine 时代保留的 dormant 组件，不作为本工单准入证据，也不得为满足旧 premise 复活 legacy 调度路径。
- 当前 live SDK 的实际证据漏斗是：`AgentSdkToolExecutor` 每个真实工具结果调用 `noteToolResultForActivePlan()`，`agent-sdk-turn-model-loop` 下一次模型调用前注入 `buildActivePlanReminderText()`。`plan-persistence-reinjection.test.ts` 用真实 `AgentSdkRuntime`、真实 SDK 工具包装和第二轮模型输入证明该链路，不是直接调用解析器冒充接线。
- 因此本工单的准入条件改为“WP3 页面证据可用 + live SDK 工具结果进入 code-owned 活动计划并回注模型”。这取代已死亡的 WP5/TurnEngine 依赖边，符合不复活 legacy 路径的架构红线。

## 2. 机器合同

1. 活动计划只允许 `verify:'evidence'`，并在会话元数据中持久保存发现任务 ID、后台执行任务 ID、冻结清单数量、已保存数、失败数和剩余数；主进程重启后按同一 scope 恢复。
2. 每步声明一种结构化证据要求：
   - `collection_manifest`：发现任务必须已完成，且冻结目标数大于 0；queued/running/paused 只记录句柄，不完成步骤。
   - `collection_run`：逐项采集必须引用已记录的发现任务，并返回不同的可追踪执行句柄。
   - `media_download_complete`：`ok=true`、`completion=complete`、`remaining=0`、`failedCount=0`，已保存数必须等于冻结清单数。
   - `task_terminal_complete`：查询 ID 必须与已记录句柄一致，状态为 completed，且数量完整。同一份结构化结果可连续证明相邻步骤。
3. 普通文本、空 JSON、只有 `ok:true`、只有工具名、running、partial、存在失败项或剩余项，均不能完成最终复核。
4. 计划注入只显示当前缺失的证据，不暴露内部判定标签。
5. 计划 scope、TTL、步骤顺序和现有工具入口不变；不新增浏览器工具，不改 Plan P 证据生成。

## 3. 改动面

- `active-plan-step-reminder.ts`：给步骤增加 evidence requirement；以确定性解析器替换工具存在性推进，并接入会话元数据持久层。
- `plan-persistence-reinjection.test.ts`：覆盖重启恢复、queued 不推进、完整清单推进、句柄不匹配不推进、partial 不收口、数量完整才完成。
- `browser-domain-orchestrator.ts`：作为 dormant 防御面同步收紧为显式正值证据，避免后续复用时把字段名或 `false` 当成功。

## 4. 回滚

回滚仅还原活动计划推进解析器与提示文案；不触碰 Plan P、BrowserTaskEvidence 或浏览器动作实现。

## 5. 实施结果

- `ActivePlan.verify` 只允许 `evidence`；发现句柄、执行句柄、冻结目标数、已保存/失败/剩余数持久化在会话元数据的证据快照中，内存状态丢失后可恢复。
- 冻结数量不可被后续结果改写；任务句柄不一致、queued/running/paused、partial、空 JSON、单独 `ok:true`、失败或剩余非零均不推进最终步骤。
- 同一结构化结果只能连续证明相邻步骤；提醒只显示当前缺少的证据，源码与测试已清除 `weak` 判据文案。
- 直接从 `browser_collect_notes` 进入时只暂存 source/execution 句柄，必须再查询并验证 source task 的 completed + 非空清单后才能推进；completed 但仍有 `failedItems`/`remaining` 的发现结果不冻结清单。
- `plan-persistence-reinjection.test.ts` 完整覆盖 queued 不推进、完整清单推进、句柄不匹配不推进、partial 不收口、数量完整才收口；定向链与 `verify:stability` 通过。
- dormant 的 `BrowserDomainOrchestrator` 同步收紧为 fail-closed：错误/泛化成功不算证据、目标页必须显式匹配、所有完成字段必须为明确正值、普通 click 不算提交、提交必须有动作后页面状态。该防御不改变 live 所有权。
