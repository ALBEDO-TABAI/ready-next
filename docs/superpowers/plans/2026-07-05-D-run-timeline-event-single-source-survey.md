---
title: Phase D — run-timeline 事件单源（已实施：单发射漏斗 + 单订阅枢纽 + gate）
date: 2026-07-05
status: implemented
enforce: true
---

# Phase D 实施合同（2026-07-05 当日实施完毕，用户随后真机复测）

> 实施勘察修正：run 家族实为五通道（stream/status/error/scopeRunEvent/conversationEvent），
> 主进程发射点全部集中在 claude-bridge/ipc-handler 单区块（10 处），renderer 扇入已高度
> 收敛于 runtimeDriver（唯一旁路=useAgent 的并行 onScopeRunEvent 订阅）。据此 D1-D3 按
> "发射漏斗 + 订阅枢纽 + 双端 gate"落地：
>
> - **D1**：`contracts/run-timeline-contracts.ts`（RunTimelineStamp v/channel/at 信封）+
>   `claude-bridge/run-timeline-emitter.ts` 唯一发射漏斗；ipc-handler 10 处裸 send 全部
>   改经漏斗，负载盖 timeline 戳（纯增量字段，renderer 现有读取零影响）。
> - **D2**：useAgent 的并行 scopeRunEvent 订阅（会话路由终态转移）整体迁入 runtimeDriver
>   单枢纽（今晨 useAgent 拆分使 mapScopeRunPhaseToSessionState 可无环引用）；renderer
>   全域每个 run 通道只剩 runtimeDriver 一个订阅文件。
> - **D3**：`scripts/check-run-timeline-single-source.cjs`（主进程发射面只许漏斗、漏斗必须
>   盖戳且 send 恰一处、renderer 订阅面只许枢纽）挂入 `verify:stability` 链首；行为测试
>   `run-timeline-single-source.test.ts`（信封透传/销毁窗静默/枢纽单源）随链。
> - 验证：typecheck 0；gate OK；verify:stability（含新 gate+新测试）0；renderer 行为网
>   54✓（listener-routing/session-toast/multi-session/scope-live-cache/driver 系）；
>   `npm run build` 全绿（白屏防护边界未触碰）。
>
> 残余（登记不阻塞）：reduce 级全派生纯化（把枢纽内手写状态机改 reduce(RunTimelineEvent[])）
> 是后续增量项，本轮单源合同已立、通道形状已可版本化演进。以下为原勘察记录。

## 1. 现状证据（2026-07-05 实测）

双通道并存，renderer 同时消费两条流并各自持有派生逻辑：

- **`agent:stream`**（turn 级流）：唯一主进程发射点 `claude-bridge/ipc-handler.ts:1472`
  （orchestrator 'output' 转发）；preload `index.ts:316`；renderer 消费
  `stores/useAgent.ts`（initAgentListeners）+ `modules/agent/runtimeDriver.ts`。
- **`agent:scopeRunEvent`**（run/projection 级）：主进程 `publishScopeRunEvent` 23 处调用
  （runtime.ts 枢纽 + document pipeline 经 DomainAdapterHost 闭包等）；preload `index.ts:362`；
  renderer 同上两处消费。
- 任务卡 UI 已收口 projection 派生（O 阶段硬约束"renderer 不新增本地猜测"），但聊天流
  （消息增量/工具胶囊/run 状态徽标）仍由 useAgent/runtimeDriver 对两条流做本地合成——
  这是 D 要消灭的第二真相源。

## 2. 合同骨架（D1-D3，实施日细化为可机器验证条款）

- **D1 统一事件模型**：定义 `RunTimelineEvent` 单一 typed 信封（contracts 层），
  turn 流与 scope run 流的负载全部塞进该信封的 kind 变体；主进程两个发射点改发同构信封
  （通道名可保留，负载合同统一）。
- **D2 renderer 全派生**：useAgent/runtimeDriver 的本地合成逻辑改为纯投影
  （reduce(RunTimelineEvent[]) → 视图状态），删除双流各自的临时状态机；
  以 2026-07-05 useAgent 拆分后的 agent-store-helpers.ts 纯函数区为落点
  （selectors 已出壳，reduce 函数同区安放，可单测）。
- **D3 gate 防旁路**：新增 gate 禁止 renderer 直接从 `agent:stream` 负载读非信封字段、
  禁止主进程新增第三条 run 事件通道；`webContents.send('agent:stream'` 全仓唯一点合同化。

## 3. 实施红线（沿用既有硬约束）

- 白屏防护边界不动（main.tsx bootstrap 兜底 + /workbench fallback）。
- run_meta 终态共享源（p6d）与 finalizeRunOutcome 唯一收口不受事件模型重构影响——
  D 只动"事件的形状与消费"，不动"终态的裁决与落库"。
- 老 run 晚到不得覆盖新 run 可见状态（Run continuity 约束）在 reduce 函数里必须显式建模
  （generation/requestId 仲裁进信封）。

## 4. 依赖与排期

- 前置已就位：O 阶段 projection 收口、useAgent 前置纯块拆分（2026-07-05，32a06ae6）、
  Phase C DirectChat 退役（事件发射者唯一化为 SDK runtime）。
- 建议实施切片：D1（contracts + 主进程信封化，main 侧可无人值守）→ D2（renderer，在场）
  → D3（gate，随 D2 同日）。
