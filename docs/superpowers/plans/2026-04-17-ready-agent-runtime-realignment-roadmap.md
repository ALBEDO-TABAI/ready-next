# Ready Agent Runtime Realignment Roadmap

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Ready 的 agent 主链边界，让 execution truth、tool runtime、domain orchestration、task projection 和 continuation 各归其位，同时尽量复用现有 `RunCoordinator / RunProjection / capability groups / domain orchestrators` 的积累。

**Architecture:** 采用“保留外壳、替换内核”的渐进迁移，不做 big bang。先把工具契约和工具运行时做成正式层，再把 `DirectChatEngine` 缩成 provider host，把单轮 execution truth 收口到新的 `TurnEngine`，最后再推进子任务 / worker / 更强 continuation。

**Tech Stack:** Electron 34、React 19、TypeScript 5、Vite 6、better-sqlite3、现有 `agent-control` / `claude-bridge` / `tools` 目录结构。

---

## Phase 0: Freeze The Truth Before Refactor

**Why first**

现在最大风险不是“不会改”，而是边改边丢真相。先把当前链路和目标链路都文档化，并把关键 contract 用测试钉住，后面拆 `direct-chat.ts` 才不会越改越虚。

**Files**

- Use: `docs/superpowers/specs/2026-04-17-claude-code-agent-architecture-study.md`
- Use: `docs/superpowers/specs/2026-04-17-claude-code-vs-ready-agent-gap-analysis.md`
- Use: `docs/superpowers/specs/2026-04-17-ready-agent-runtime-realignment-design.md`
- Modify: `src/__tests__/agent-runtime-host-contract.test.ts`
- Add: `src/__tests__/tool-runtime-contract.test.ts`
- Add: `src/__tests__/turn-engine-contract.test.ts`

- [ ] 把“当前哪些职责仍然在 `DirectChatEngine`”写成测试断言，而不是只写在文档里。
- [ ] 把“未来哪些职责应该被迁出”也写成 contract 断言，方便逐阶段验证文件缩责是否真的发生。
- [ ] 给工具定义层和 turn engine 预先立 contract test，哪怕实现还没落地。
- [ ] 运行验证：
  `npx tsx --test src/__tests__/agent-runtime-host-contract.test.ts src/__tests__/tool-runtime-contract.test.ts src/__tests__/turn-engine-contract.test.ts`

## Phase 1: Introduce Formal Tool Definitions

**Why next**

如果工具继续只是前缀字符串，后面不可能把执行主链真正抽干净。

**Files**

- Add: `src/main/modules/agent-control/tool-definition.ts`
- Add: `src/main/modules/agent-control/tool-result-types.ts`
- Add: `src/main/modules/agent-control/tool-registry.ts`
- Modify: `src/main/modules/agent-control/tool-gateway.ts`
- Modify: `src/main/modules/tools/index.ts`
- Modify: `src/main/modules/tools/tool-executor.ts`
- Test: `src/__tests__/tool-gateway-registry.test.ts`
- Test: `src/__tests__/tool-runtime-contract.test.ts`

- [ ] 为每个工具族引入统一 `ToolDefinition`，至少补齐：
  `domain / kind / concurrency / interrupt / timeout / resultShape`。
- [ ] 让 `ToolGateway` 从“能力目录”升级为“工具定义注册表 + schema 入口”。
- [ ] 保持 capability groups 继续负责工具面暴露，但不要再让它独自承担执行语义。
- [ ] 让 `tool-executor` 消费 `ToolDefinition`，不再只按前缀猜行为。
- [ ] 第一阶段先覆盖 browser/document/rss/calendar/skill/feishu/system/memory/session_recall 八类工具。
- [ ] 运行验证：
  `npx tsx --test src/__tests__/tool-gateway-registry.test.ts src/__tests__/tool-runtime-contract.test.ts`

## Phase 2: Separate Tool Runtime From Turn Logic

**Why next**

工具定义补齐后，才能把权限、并发、结果结构化、cleanup 统一下沉到独立运行时。

**Files**

- Add: `src/main/modules/agent-control/tool-runtime.ts`
- Add: `src/main/modules/agent-control/tool-execution-hooks.ts`
- Modify: `src/main/modules/agent-control/execution-loop-orchestrator.ts`
- Modify: `src/main/modules/tools/tool-executor.ts`
- Modify: `src/main/modules/agent-control/tool-runtime-context-builder.ts`
- Test: `src/__tests__/execution-loop-parallel-tools.test.ts`
- Add: `src/__tests__/tool-runtime-results.test.ts`
- Add: `src/__tests__/tool-runtime-interrupt.test.ts`

- [ ] 让 `ToolRuntime` 成为“批量工具执行真相层”。
- [ ] 把并发调度、超时、interrupt、cleanup、结构化结果回收统一挪到 `ToolRuntime`。
- [ ] 让 `ExecutionLoopOrchestrator` 只负责 loop-level orchestration，不再自己理解太多工具细节。
- [ ] 让工具结果开始返回结构化对象，再由上层决定如何映射成文本 / task payload / transcript event。
- [ ] 运行验证：
  `npx tsx --test src/__tests__/execution-loop-parallel-tools.test.ts src/__tests__/tool-runtime-results.test.ts src/__tests__/tool-runtime-interrupt.test.ts`

## Phase 3: Extract A Single Turn Engine

**Why next**

这是整个整改的主任务。目标不是简单切文件，而是让 Ready 正式拥有一个清晰的 execution owner。

**Files**

- Add: `src/main/modules/agent-control/turn-engine.ts`
- Add: `src/main/modules/agent-control/turn-state.ts`
- Add: `src/main/modules/agent-control/turn-transcript.ts`
- Modify: `src/main/modules/claude-bridge/direct-chat.ts`
- Modify: `src/main/modules/agent-control/orchestrator.ts`
- Modify: `src/main/modules/agent-control/run-contracts.ts`
- Test: `src/__tests__/turn-engine-contract.test.ts`
- Add: `src/__tests__/turn-engine-route.test.ts`
- Add: `src/__tests__/turn-engine-projection.test.ts`

- [ ] 把当前 `DirectChatEngine.sendMessage()` 中的单轮执行主链抽到 `TurnEngine`。
- [ ] `DirectChatEngine` 缩为 provider-facing host shell，不再持有绝大多数产品策略。
- [ ] 把本轮状态统一收口成 `TurnState`：
  `route / budget / toolPool / transcript / interaction / continuation / domainState`。
- [ ] 明确 `TurnEngine` 的输入输出合同，禁止 renderer、runtime、projection 直接依赖中间局部变量。
- [ ] 运行验证：
  `npx tsx --test src/__tests__/turn-engine-contract.test.ts src/__tests__/turn-engine-route.test.ts src/__tests__/turn-engine-projection.test.ts`

## Phase 4: Promote Domain Orchestrators Into Real Adapters

**Why next**

当前 Browser / Document 已经有独立 orchestrator，但还没有形成统一 adapter 体系。

**Files**

- Add: `src/main/modules/agent-control/domain-adapter.ts`
- Add: `src/main/modules/agent-control/browser-domain-adapter.ts`
- Add: `src/main/modules/agent-control/document-domain-adapter.ts`
- Add: `src/main/modules/agent-control/skill-domain-adapter.ts`
- Add: `src/main/modules/agent-control/rss-domain-adapter.ts`
- Add: `src/main/modules/agent-control/calendar-domain-adapter.ts`
- Add: `src/main/modules/agent-control/feishu-domain-adapter.ts`
- Modify: `src/main/modules/agent-control/browser-domain-orchestrator.ts`
- Modify: `src/main/modules/agent-control/document-domain-orchestrator.ts`
- Modify: `src/main/modules/agent-control/task-execution-router.ts`
- Test: `src/__tests__/browser-domain-orchestrator.test.ts`
- Test: `src/__tests__/document-tool-loop-orchestrator.test.ts`
- Add: `src/__tests__/domain-adapter-contract.test.ts`

- [ ] 定义统一 `DomainAdapter` 合同：
  `shouldHandle / prepare / dispatch / applyResult / buildProjectionPatch`。
- [ ] Browser / Document 先接入，保持现有能力不丢。
- [ ] Skill / RSS / Calendar / Feishu 再按同一模式补齐，结束“主循环里写很多专属分支”的状态。
- [ ] `task-execution-router` 继续保留路由职责，但只输出 route，不再暗含大量 domain 内部细节。
- [ ] 运行验证：
  `npx tsx --test src/__tests__/browser-domain-orchestrator.test.ts src/__tests__/document-tool-loop-orchestrator.test.ts src/__tests__/domain-adapter-contract.test.ts`

## Phase 5: Make Projection A Real Mirror Of Execution Truth

**Why next**

Ready 的 `TaskProjection` 很强，但还没有完全成为 execution truth 的稳定镜像。

**Files**

- Modify: `src/main/modules/agent-control/run-projection.ts`
- Modify: `src/main/modules/agent-control/task-projection-sync.ts`
- Modify: `src/main/modules/agent-control/run-contracts.ts`
- Modify: `src/main/modules/agent-control/runtime.ts`
- Modify: `src/renderer/modules/agent/taskCardViewModel.ts`
- Test: `src/__tests__/task-projection-sync.test.ts`
- Add: `src/__tests__/task-projection-truth-contract.test.ts`

- [ ] 把 projection 输入全面切到结构化 turn result / transcript event。
- [ ] 继续减少“从 assistant 文本里猜任务状态”的比重。
- [ ] 让 `TaskPanel`、聊天任务卡、继续/重试草稿都优先消费结构化 projection 字段。
- [ ] 确保 projection 是 mirror，不是 second runtime。
- [ ] 运行验证：
  `npx tsx --test src/__tests__/task-projection-sync.test.ts src/__tests__/task-projection-truth-contract.test.ts`

## Phase 6: Strengthen Continuation And Session Truth

**Why next**

只有 turn engine 和 projection 收口后，continuation 才能从“靠提示恢复”走向“靠状态恢复”。

**Files**

- Modify: `src/main/modules/agent-control/session-continuity.ts`
- Modify: `src/main/modules/agent-control/task-execution-router.ts`
- Modify: `src/main/modules/agent-control/run-budget-policy.ts`
- Modify: `src/main/modules/claude-bridge/direct-chat.ts`
- Add: `src/main/modules/agent-control/continuation-state.ts`
- Test: `src/__tests__/session-continuity.test.ts`
- Test: `src/__tests__/task-continuation-budget.test.ts`
- Add: `src/__tests__/continuation-state-contract.test.ts`

- [x] 让 continuation 尽量恢复结构化 turn state，而不是再靠 prompt 补足缺口。
- [x] 把 budget / step / blockedReason / resumableActions 的恢复统一接到 continuation state。
- [x] 让 projection 和 continuation 引用同一份 task identity，不再在 UI、runtime、prompt 三层分别猜。
- [ ] 运行验证：
  `npx tsx --test src/__tests__/session-continuity.test.ts src/__tests__/task-continuation-budget.test.ts src/__tests__/continuation-state-contract.test.ts`

## Phase 7: Only Then Add Worker / Subtask Infrastructure

**Why last**

在前面几层没收口之前做 worker/subtask，只会把当前混乱复制到更多执行链里。

**Files**

- Add: `src/main/modules/agent-control/subtask-runtime.ts`
- Add: `src/main/modules/agent-control/worker-session.ts`
- Add: `src/main/modules/agent-control/worker-projection.ts`
- Modify: `src/main/modules/agent-control/run-contracts.ts`
- Modify: `src/main/modules/agent-control/orchestrator.ts`
- Test: `src/__tests__/subtask-runtime-contract.test.ts`
- Add: `src/__tests__/worker-session-contract.test.ts`

- [ ] 先明确 worker/subtask 的 task identity、budget identity、projection identity。
- [ ] 子任务 transcript、projection、cleanup 独立，不要复用主线程模糊状态。
- [ ] 只有当 worker 能成为正式 execution primitive 时，再开放更复杂的 planner/subagent 方案。
- [ ] 运行验证：
  `npx tsx --test src/__tests__/subtask-runtime-contract.test.ts src/__tests__/worker-session-contract.test.ts`

## Guardrails

- [ ] 不做 big bang，任何阶段都必须保持当前主链可运行。
- [ ] 不同时重写 Browser 和 Document 两个主域。
- [ ] 每一阶段只迁出一种真相，不要一边迁 tool runtime 一边重写 projection。
- [ ] `DirectChatEngine` 的缩责必须有 contract test 支撑，不能只靠人工感觉。
- [ ] 新增结构化层时，优先桥接现有 renderer 消费方，不强迫前端同一阶段整体改写。

## Done When

- [ ] `DirectChatEngine` 不再是超级宿主。
- [ ] `TurnEngine` 成为单轮 execution 真相 owner。
- [ ] `ToolRuntime` 拥有正式工具定义与结构化结果。
- [ ] Browser / Document / Skill / RSS / Calendar / Feishu 都走统一 adapter contract。
- [ ] projection 成为 execution truth 的稳定镜像。
- [ ] continuation 恢复主要依赖结构化状态而不是 prompt 补词。

## Suggested Order

- [ ] Phase 0
- [ ] Phase 1
- [ ] Phase 2
- [ ] Phase 3
- [ ] Phase 4
- [ ] Phase 5
- [ ] Phase 6
- [ ] Phase 7
