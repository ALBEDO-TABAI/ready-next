---
title: P8g-8b Studio content management implementation
date: 2026-06-20
branch: agent-evolution/phase1
enforce: true
source:
  - outputs/agent-audit/fix-plan/184-CONSENSUS-P8G8B-STUDIO-CONTENT-MANAGEMENT-ROUTE.md
  - outputs/agent-audit/fix-plan/00-ROADMAP.md
---

# P8g-8b Studio 内容管理实施文档

## 1. 完成标准

本阶段完成后，用户在 Agent System Studio 里能看清已创建专项 agent 的内容包，并能对内容提出 staged 修改；只有用户确认后，修改才进入真实 RULES、FOUNDATION 或 agent-scoped knowledge card。

本阶段不完成任务结果自动演进、路由卡编辑、生命周期操作、真实语义 provider 或浏览器隔离。

## 2. 交付范围

### 2.1 内容包读取

扩展 `AgentSystemStudioSnapshot`：

- `RULES.md`: relPath、exists、preview、content、contentHash。
- `FOUNDATION.md`: relPath、exists、preview、content、contentHash。
- knowledge cards: 增加 body/contentHash。
- agent: 增加 content summary counts 和 content edit proposal list。

约束：

- staged proposal 只显示在 Studio，不进入 prompt assembly。
- main agent、retired agent、merged agent 仍可查看，不可编辑。

### 2.2 内容修改 proposal

新增 `specialist_content_edit_proposals` durable 存储。

支持 target：

- `rules`: `agents/<agentId>/RULES.md`
- `foundation`: `agents/<agentId>/FOUNDATION.md`
- `knowledge_card`: `agents/<agentId>/knowledge/**/*.md`

状态：

- `staged`
- `applied`
- `rejected`
- `conflict`

确认规则：

- stage 时记录 base hash 和 base content。
- confirm 时重新计算目标 hash；hash 不一致则转 `conflict`，不写目标。
- confirm 成功后再写真实内容，并转 `applied`。
- reject 只转 `rejected`。

### 2.3 IPC / preload / renderer

新增 Studio proposal channels：

- `agent:systemStudio:stageContentEdit`
- `agent:systemStudio:confirmContentEdit`
- `agent:systemStudio:rejectContentEdit`

不新增 create、transition、lifecycle 或直接 registry 写通道。

### 2.4 UI

在 `AgentSystemStudio` 中：

- 当前 agent 详情区展示 RULES、FOUNDATION、知识卡完整内容与数量。
- active specialist 才显示编辑入口。
- 编辑后提交为 staged proposal。
- proposal 区显示目标、状态、创建时间、base/proposed 内容 diff。
- staged proposal 可确认或拒绝。
- conflict proposal 显示冲突，不自动覆盖。

UI 风格继续使用 Settings 现有 compact card、chip、icon button 和小字号，不做新视觉系统。

## 3. 文件触点

预计修改：

- `src/shared/agent-system-studio.ts`
- `src/main/modules/migrations.ts`
- `src/main/modules/agent-control/agents/specialist-content-edit-proposals.ts`
- `src/main/modules/agent-control/agents/specialist-studio-read-model.ts`
- `src/main/modules/claude-bridge/ipc/agent-system-studio-group.ts`
- `src/preload/index.ts`
- `src/renderer/types/electron.d.ts`
- `src/renderer/components/agent-system/AgentSystemStudio.tsx`
- `scripts/check-specialist-studio-readonly.cjs`
- `scripts/__tests__/check-specialist-studio-readonly.test.cjs`
- `package.json` only if verify script needs renamed gate text.

预计新增/修改测试：

- `src/__tests__/specialist-content-edit-proposals.test.ts`
- `src/__tests__/agent-system-studio-read-model.test.ts`
- `src/__tests__/agent-system-studio-ipc.test.ts`
- `src/__tests__/agent-system-studio-render.test.tsx`
- `src/__tests__/migration-specialist-content-edit-proposals.test.ts`

## 4. Gate 规则

`check-specialist-studio-readonly.cjs` 改为 proposal-write allowlist gate：

- 必须保留 snapshot 和 routing simulation。
- 只允许 content-edit proposal 三通道。
- 继续禁止 create/transition/updateStatus/raw registry write/raw belief transition。
- 禁止 renderer 直接调用非 proposal 写通道。

## 5. 验证

焦点验证：

```bash
npm run verify:agent-system-studio
npm run verify:specialist-blueprint
npm run typecheck
```

若触及 SQLite-backed 验收，`verify:agent-system-studio` 已包含 `verify:native` 的上游不足时，应补跑：

```bash
npm run verify:native
```

最终还需：

```bash
git diff --check
```

## 6. 非目标防线

本阶段不得：

- 从任务结果自动生成或确认 proposal。
- 自动激活或改写 routing card。
- 让 staged proposal 进入 prompt 注入。
- 修改 browser identity/session 策略。
- 删除或绕过 existing blueprint confirmation/admission 纪律。
