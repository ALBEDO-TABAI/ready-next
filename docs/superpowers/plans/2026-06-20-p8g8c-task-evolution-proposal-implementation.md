---
title: P8g-8c task evolution proposal implementation
date: 2026-06-20
branch: agent-evolution/phase1
enforce: true
source:
  - outputs/agent-audit/fix-plan/00-ROADMAP.md
  - outputs/agent-audit/fix-plan/188-CONSENSUS-P8G8C-TASK-EVOLUTION-PROPOSAL-ROUTE.md
  - outputs/agent-audit/fix-plan/190-P8G8C-TASK-EVOLUTION-PROPOSAL-CLOSEOUT.md
---

# P8g-8c 任务演进提案实施文档

## 1. 完成标准

专项 agent 完成归属任务后，系统可以把明确的学习信号转成该 agent 的 staged 知识更新提案。用户在 Agent System Studio 中确认后，提案才写入该专项 agent 的知识卡。

本阶段不做路由卡编辑、agent 退休/合并/恢复、真实语义 provider、浏览器身份隔离、自动 active 写入。

## 2. 最小行为

新增 task evolution proposal helper：

- 只接受 terminal success 的 task projection。
- 只处理 active specialist owner。
- 必须存在 `learningRefs`，否则跳过。
- 每个 task 最多生成一条 task evolution proposal。
- 目标为 agent-scoped knowledge card：`agents/<ownerAgentId>/knowledge/task-evolution-<taskId>.md`。
- proposal 仍使用 `specialist_content_edit_proposals`，状态为 `staged`。
- `provenance.source` 为 `task_evolution`，并记录 `taskId`、`runId`、`scopeId`。
- 只有 `task_evolution` 内部提案允许在确认时创建新的 knowledge card；手动 Studio `knowledge_card` 编辑仍只能改已有卡。

## 3. 接线

在 `AgentSdkRuntime` 的 finalizer learning hook 中调用 helper：

- 成功生成 proposal 后记 metric。
- 跳过或失败不影响 run 终态。
- 不修改 `finalizeRunOutcome()` 内部主体。
- 不把 proposal 写入 prompt assembly。

## 4. Studio 更新

Studio 已显示 content proposals。本阶段只补 provenance 显示：

- task evolution proposal 显示为“任务演进”。
- 显示 taskId。
- 确认/拒绝继续复用现有三通道。

## 5. 文件触点

预计新增：

- `src/main/modules/agent-control/agents/specialist-task-evolution-proposals.ts`
- `src/__tests__/specialist-task-evolution-proposals.test.ts`

预计修改：

- `src/shared/agent-system-studio.ts`
- `src/main/modules/agent-control/agents/specialist-content-edit-proposals.ts`
- `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts`
- `src/main/modules/agent-control/runtime-core/run-finalizer.ts`
- `src/renderer/components/agent-system/AgentSystemStudio.tsx`
- `src/__tests__/specialist-content-edit-proposals.test.ts`
- `src/__tests__/agent-system-studio-render.test.tsx`
- `package.json`

## 6. Gate 与测试

必须证明：

- active specialist owner + learningRefs + terminal success 会产生 staged knowledge proposal。
- main/retired/missing owner 不产生 proposal。
- 无 learningRefs 或失败终态不产生 proposal。
- 同一 task 不重复产生 proposal。
- 用户确认 proposal 后才写入 agent-scoped knowledge card。
- Studio 没有新增 lifecycle/route/registry 写通道。

验证：

```bash
npm run verify:agent-system-studio
npm run typecheck
npm run verify:specialist-blueprint
npm run verify:stability
npm run verify:evolution-p4
git diff --check
```
