---
title: Skill Child-Loop Boundary
date: 2026-07-12
kind: architecture
status: historical
enforce: false
superseded_by:
  - docs/architecture/current-runtime-contracts.md
---

# Skill Child-Loop Boundary

> 历史说明：本文记录旧 SDK child-loop 的设计与内部持久化形态，不是当前 Codex
> 生产合同。Codex 主链不准入 child-loop 控制、恢复或公开续跑；现行产品只保留
> 历史投影的只读查询，以及 detached/child 任务各自的精确取消入口。不得按本文
> 的 parent/resume/continue 章节恢复模型工具、任务卡按钮或第二条运行主链。

## 0. 权威边界

manifest 把某个 skill action 声明为 child-loop 后：

- child runner 独占该 action 的启动、执行、状态推进、重试、取消、恢复和终态发布。
- 父 Agent 只负责选择工具、传入原始请求与结构化 refs、持有 durable handle、展示 projection，并在 close event 后继续。
- 父循环不得为 child-owned action 合成或强制 `tool_use`，也不得在 child 内部另跑一套模型循环。
- terminal 状态只能通过 child terminal funnel 与 run finalizer 进入共享可见状态。

旧 `turn-engine.ts` 迁移细节已归档到 `docs/archive/architecture/skill-child-loop-boundary-pre-sdk.md`，不得用归档中的行号判断现行实现。

## 1. 身份与声明

- manifest 的 `childLoop.actions` 是 action 归属真值。
- 静态工具名映射、compiled manifest、driver 注册和启动期 assertion 必须一致。
- `isConfiguredChildLoopSkillActionForSkill` / `isConfiguredChildLoopSkillAction` 是代码侧统一判断入口。
- child run 使用独立 `childRunId`；父 task/run id 不能替代 child identity。
- 同一逻辑任务的恢复沿用 durable child identity，不以新建空壳 task 模拟 resume。

相关入口：

- `src/main/modules/tools/child-loop-skill-actions.ts`
- `src/main/modules/tools/skills-tools-static.ts`
- `src/main/modules/agent-control/stage-n-boot-assertion.ts`
- `src/main/modules/agent-control/skills/skill-child-drivers.ts`

## 2. Child 拥有的职责

Child runner 负责：

1. admission 后创建或恢复 child run。
2. 维护 append-only child log 与持久状态。
3. 驱动注册 driver，不让父循环直接执行内部步骤。
4. 将进度、checkpoint、blocked、cancelled、failed、completed 发布为结构化事件。
5. 管理 single-flight、abort tree、cleanup registry 和 retry policy。
6. 只在真实 terminal proof 存在时发布终态。

核心文件：

- `src/main/modules/agent-control/skills/skill-child-runner.ts`
- `src/main/modules/agent-control/skills/skill-child-run-log.ts`
- `src/main/modules/agent-control/skills/skill-child-state-machine.ts`
- `src/main/modules/agent-control/skills/skill-child-run-types.ts`
- `src/main/modules/agent-control/skills/skill-child-close-event-freeze.ts`

具体文件名必须以工作区为准；新增 driver 时同步启动 assertion 与测试。

## 3. Parent 拥有的职责

Parent 负责：

- 由模型选择已授权的 child-owned typed tool。
- 只转发 `userRequestVerbatim` 与结构化资源 refs，不改写用户任务。
- 接收启动结果中的 `childRunId` / run-state handle，并写入 frame/projection。
- 处理 status、resume、cancel 请求和 child close event。
- child 运行中维持等待/checkpoint 姿态，不继续强制同一 action。
- close 后根据结构化结果继续总结、补救或请求用户输入。

Parent 不负责：

- 猜测 child 是否完成。
- 根据 stdout 文案派生终态。
- 在工具面缺失时绕过 manifest 直接调用 driver。
- 用 `skill_start_detached` 再包一层已经 child-owned 的 action。
- 把 child 内部进度复制成第二份状态机。

## 4. Frame、结果与恢复

- Tool result 可通过声明式 frame patch / context modifier 更新同一 turn 的 `TurnFrame`。
- `TurnFrame` 是模型循环内 frame-state 唯一读源；不可从旧变量或 UI 状态反推。
- child 启动回执不是完成 proof。只有 run state、close event 和 finalizer 接受的交付证据才能支持 done。
- 可恢复状态必须带 `childRunId` 或等价 durable handle；“有 skillId/taskRunId”不足以恢复。
- blocked 与 budget-paused 必须保留 child identity、原因和明确继续动作。
- cancel 信号沿父 run -> child run -> driver 传播；cleanup 完成前不得假装 terminal。

## 5. 当前代码边界

### 5.1 Manifest 与 admission

- manifest 编译：`src/main/modules/skills-runtime/`
- child-loop 判定：`src/main/modules/tools/child-loop-skill-actions.ts`
- schema/admission：`src/main/modules/agent-control/tools-runtime/tool-registry.ts`
- 启动一致性：`src/main/modules/agent-control/stage-n-boot-assertion.ts`

任何 child-owned action 都必须先通过普通工具授权与 schema 校验；child-loop 不构成绕过权限的后门。

### 5.2 Dispatch 与 parent-force fence

- 工具分发：`src/main/modules/tools/skills-tools.ts`
- parent-force fence：`src/main/modules/agent-control/contracts/skill-parent-force-fence.ts`
- frame steering：`src/main/modules/agent-control/runtime-core/turn-frame-steering.ts`
- 静态映射：`src/main/modules/tools/skills-tools-static.ts`

`isParentForceForbiddenByManifest` 必须对 child-owned action fail closed。新增或改名 action 时，同时更新 manifest、静态映射、driver 和 parent-force 回归。

### 5.3 Supervisor、projection 与 terminal

- 生命周期 owner：`src/main/modules/agent-control/skills/skill-child-runner.ts`
- 任务监督：`src/main/modules/agent-control/skills/skill-task-supervisor.ts`
- task/run 投影：`src/main/modules/agent-control/task-projection/`
- shared closeout：`src/main/modules/agent-control/runtime-core/run-finalizer.ts`

Supervisor 可以观察、恢复和收口 child run，但不能创建第二套 child terminal truth。Renderer 只消费 projection 派生状态。

## 6. 验证

最小回归按改动范围选择：

```bash
npm run test:n:focus
npm run test:n:gates
npm run verify:n
npx tsx --test src/__tests__/skill-child-run-end-to-end.test.ts
npx tsx --test src/__tests__/skill-child-parent-force-blocked.test.ts
npx tsx --test src/__tests__/skill-task-supervisor.test.ts
node scripts/check-no-parent-force-for-child-loop.cjs
node scripts/check-child-loop-terminal-boundary.cjs
```

涉及 SQLite 持久化时再跑 `npm run verify:native`。结构 gate 只能保护边界存在，仍要用行为测试证明启动、等待、恢复、取消和 terminal。
