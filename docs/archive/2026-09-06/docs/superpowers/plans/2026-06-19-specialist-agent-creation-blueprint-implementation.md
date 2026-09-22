---
title: Specialist Agent Creation Blueprint 实施子计划
date: 2026-06-19
status: approved by Codex/Claude route consensus, enforce 生效
owner: 白
author: Codex
executor: Codex
reviewer: Claude
enforce: false
pairs_with:
  - outputs/agent-audit/fix-plan/10-CLAUDE-SPECIALIST-AGENT-INTENT-BLUEPRINT-REVIEW.md
  - outputs/agent-audit/fix-plan/36-CONSENSUS-P8CF-SPECIALIST-CREATION-ROUTE.md
depends_on:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-06-19-agent-browser-specialist-surface-studio-implementation.md
scope:
  - P8c creation funnel
  - P8f conversational specialist blueprint
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Specialist Agent Creation Blueprint 实施子计划

## 0. 完成标准

用户在聊天里说"我要一个 xxx 类型的专项 agent"时，Ready 不直接创建 agent，而是生成可审的 staged blueprint；信息不足时先澄清；通过确定性准入和用户显式确认后，才经唯一 factory 路径创建专项 agent 与基础资产。

完成时必须满足：

- conversation / manual Studio / emergence candidate 三入口都进入同一 blueprint shape。
- deterministic admission 覆盖 admit / clarify / duplicate / unsafe / too_broad / premature。
- 无确认 token 时不能写 agent registry、agent 资产文件或 routing card。
- 确认 token 一次性，绑定 blueprint + session/run；确认后仍重跑 admission 和 factory 校验。
- 确认创建后 routing card 默认 staged，除非本批显式实现且测试 routing-specific activation guard。
- staged blueprint 和 staged foundation docs 不进入 prompt 注入。
- `npm run verify:specialist-blueprint`、`npm run typecheck` 通过；涉及 SQLite/持久化时跑 `npm run verify:native`。

## 1. 禁止事项

- 不自动派生专项 agent。
- 不把 LLM 裁决当 admission 结果。
- 不复用高危工具 frozen-call token；只复用"确认不提权、确认后重跑校验"原则。
- 不把 routing card 静默设为 active。
- 不做 suggest chip / "总是这样处理" / auto 可撤回。
- 不做跨 agent 知识自动迁移。
- 不做多 blueprint 批量确认。
- 不把 Studio 变成任意编辑 active agent 资产的入口。

## 2. Slice A · Blueprint runtime shape

扩展 `src/shared/agent-specialist-blueprint.ts`：

- `blueprintId`
- `status: 'draft' | 'needs_clarification' | 'staged' | 'confirmed' | 'rejected' | 'expired'`
- `inferredScope`
- `foundationDocs`
- `provenance`
- `confirmation`

要求：

- 兼容 P8a/P8b 已有 placeholder，不破坏 Studio read model。
- `userRequestVerbatim` 继续保留字节级原话。
- `foundationDocs` 全部是 staged，不得被 prompt 注入读路径默认消费。

测试：

- `src/__tests__/agent-specialist-blueprint-schema.test.ts`

## 3. Slice B · Blueprint store + admission

新增最小 staged blueprint store / repository。

候选落点：

- `src/main/modules/agent-control/agents/specialist-blueprint-store.ts`
- `src/main/modules/agent-control/agents/specialist-blueprint-admission.ts`

admission verdict：

- `admit`
- `clarify`
- `reject_duplicate`
- `reject_unsafe`
- `reject_too_broad`
- `reject_premature`

确定性规则：

- slug 小写且唯一。
- charter / rules / intendedDomain / nonGoals 必填。
- triggers ≤8，必须是字面关键词。
- duplicate 至少检查 id collision、trigger overlap、charter/domain overlap。
- too_broad 检查全能型 domain、nonGoals 缺失、recurringTasks 跨度过大。
- premature 检查是否只是一次性任务、缺少明确创建意图或证据不足。
- unsafe 走现有 safety/action policy 的可复用判定，不交给模型自判。
- clarify 分支只能写 staged blueprint + 澄清问题，不能创建 agent。

测试：

- `src/__tests__/specialist-blueprint-admission.test.ts`

## 4. Slice C · Confirmation token + one factory path

新增 blueprint confirmation token，不复用 frozen-call token。

候选落点：

- `src/main/modules/agent-control/agents/specialist-blueprint-confirmation.ts`
- 扩展 `src/main/modules/agent-control/agents/agent-factory.ts`

要求：

- token 绑定 `blueprintId` + session/run。
- token 一次性，用后失效。
- confirm 只证明用户确认；factory 仍重跑 admission、slug、owner、routing、资产写入校验。
- IPC confirm handler 必须调用 `SpecialistBlueprintConfirmationStore.consume()` 后才能进入 factory；factory 内的 token id 比对只是二次防线，不等于 replay 防护。
- factory 支持 `source:'user-blueprint'`，与 `source:'emergence-candidate'` 共用最终写路径。
- 写入失败要原子回滚，不留 registry / 文件 / routing 孤儿。

测试：

- `src/__tests__/specialist-blueprint-confirmation.test.ts`
- `src/__tests__/specialist-agent-factory-blueprint.test.ts`

## 5. Slice D · IPC / preload / Studio

新增受控 IPC，不暴露任意写：

- list staged blueprints
- create/update draft blueprint
- run admission
- request confirmation token
- confirm create
- reject / expire blueprint

候选落点：

- `src/main/modules/claude-bridge/ipc/agent-specialist-blueprint-group.ts`
- `src/preload/index.ts`
- `src/renderer/types/electron.d.ts`
- `src/renderer/components/agent-system/AgentSystemStudio.tsx`

UI 要求：

- 每个接收 blueprint payload 的 IPC handler 必须先调用 `validateSpecialistAgentBlueprintShape()`；未经 shape validation 的对象不得 cast 成 `SpecialistAgentBlueprint`。
- Studio staged blueprint 区域从占位变成真实列表。
- detail 能看 scope、non-goals、foundation docs、admission verdict、clarification questions。
- 确认按钮只有 admission=admit 时可用。
- reject/clarify 原因必须可见。
- 不提供 active routing 静默开关。

测试：

- `src/__tests__/agent-specialist-blueprint-ipc.test.ts`
- `src/__tests__/agent-system-studio-blueprint-render.test.tsx`

## 6. Slice E · Conversational intake

用户在聊天中表达创建意图时：

- LLM 只识别/抽取/草拟。
- 信息不足时使用 `ask_user_questions` 或等价 blueprint clarification card。
- 信息足够时创建 staged blueprint preview card。
- preview card 动作：继续完善、去 Studio 编辑、确认创建、取消。

候选落点需先读现有 chat interaction / task card / agent_interaction 路径后确定；不得在 renderer 本地猜测创建成功。

测试：

- `src/__tests__/specialist-blueprint-conversation-intake.test.ts`
- `src/__tests__/verbatim-relay.test.ts` 扩展 userRequestVerbatim。

## 7. Gate / verify

扩展现有 gate：

- `scripts/check-specialist-create-funnel.cjs`

从"全部禁止 blueprint persistence / chat creation"改为：

- 只允许 blueprint store、admission、confirmation、factory 白名单写路径。
- 禁止 renderer/preload 直接 registry create。
- 禁止任何路径跳过 confirmation token。
- 禁止 staged blueprint / foundation docs 接入 prompt 注入读路径。

新增 package script：

```bash
npm run verify:specialist-blueprint
```

建议内容：

- schema test
- admission matrix
- confirmation token test
- factory blueprint test
- IPC test
- render test
- create funnel gate + gate tests

## 8. 验证顺序

1. 先跑 specialist blueprint 焦点测试。
2. 跑 `node scripts/check-specialist-create-funnel.cjs` 与 gate tests。
3. 跑 `npm run verify:specialist-blueprint`。
4. 跑 `npm run typecheck`。
5. 涉及 SQLite / 持久化后跑 `npm run verify:native`。
6. 最后把结果交 Claude 做对抗复审。

## 9. 2026-06-20 Route Update

P8g-6 已补上 staged blueprint、显式确认、FOUNDATION.md、结构化 quality gate 与 Studio 编辑面。后续复审确认这些改动是真实收口，但不能把它读成"语义上一定专业"：

- 当前 quality gate 主要是确定性结构/长度/禁词/复述/证据/边界检查；
- 长而空泛、但避开禁词的蓝图仍可能通过；
- Studio 目前显示 FOUNDATION 已生成的状态，不等于确认前完整审阅 FOUNDATION 正文。

因此新增后续 **P8g-7 · semantic foundation judge + confirm preview**：LLM 只做结构化质量判断题，判断结果转成代码拥有的 blocking issue，再进入既有 `clarify`/确认闸门；确认前 Studio 必须展示完整 `foundationDocs.foundationText`。详见 `outputs/agent-audit/fix-plan/121-CONSENSUS-BROWSER-SPECIALIST-PRODUCT-ROUTE-UPDATE.md`。

最新 Claude/子审查复审把该路线收窄为：P8g-7 不新增更多基础字段，现有 schema 已足够；本批只补**加性**语义质量 judge、确认前全文预览，以及"语义未审"的显式确认兜底。详见 `outputs/agent-audit/fix-plan/153-CONSENSUS-BROWSER-SPECIALIST-CLAUDE-SUBAGENT-REVIEW.md`。

用户随后再次补充"我要一个 xxxx 类型的专项 agent"场景，路线刷新见 `outputs/agent-audit/fix-plan/147-CONSENSUS-SPECIALIST-INTENT-BROWSER-ROUTE-REFRESH.md`。P8g-7 的验收必须证明：

- 长而空泛、但能通过确定性词法检查的蓝图会被语义 judge 打回 `needs_clarification`；
- judge 只在 blueprint 提议、编辑、确认前运行，不进入普通聊天热路径；
- judge 只产生代码拥有的闭集 blocking issue id，不直接放行创建，也不能移除 deterministic gate 的阻塞；
- judge 失败、超时、跳过、缺失或结果过期时，不能静默当作语义通过；若 deterministic gate 已通过，只能在完整预览里明确标"未经语义校验"，并要求用户显式确认；
- blueprint/foundation 内容 hash 变化后旧 judge 结果失效，必须重判或走上述"未经语义校验"显式确认兜底；
- Studio 在确认前展示完整 `foundationDocs.foundationText`，不能只显示"已预览"状态。

重新登录后的短 Claude prompt 已成功返回 REVISE，主要修正就是上述"fail-closed 不等于 LLM 不可用时创建路径整体瘫痪"。两轮无输出留痕仍保留在 `outputs/agent-audit/fix-plan/144-CLAUDE-LATEST-SPECIALIST-BROWSER-ROUTE-PROMPT.md`、`145-CLAUDE-LATEST-SPECIALIST-BROWSER-ROUTE-FAILURE.md`、`146-CLAUDE-LATEST-SPECIALIST-BROWSER-MICRO-FAILURE.md`。

P8g-7 之后另列后续产品切片：Studio blank-create + lifecycle/evolution 管理。当前 Studio 能编辑已有 staged blueprint，但还不能声明已有完整"从空白手动创建专项 agent"产品入口；该项不塞进 P8g-7 首个竖切。
