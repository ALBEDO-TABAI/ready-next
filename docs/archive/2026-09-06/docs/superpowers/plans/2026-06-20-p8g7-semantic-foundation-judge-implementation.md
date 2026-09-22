---
title: P8g-7 Semantic Foundation Judge + Confirm Preview 实施子计划
date: 2026-06-20
status: implemented for contract/hash/full-preview/unverified-ack; production judge provider deferred to P8g-7b
owner: 白
author: Codex
executor: Codex
reviewer: Claude
enforce: false
pairs_with:
  - outputs/agent-audit/fix-plan/153-CONSENSUS-BROWSER-SPECIALIST-CLAUDE-SUBAGENT-REVIEW.md
  - outputs/agent-audit/fix-plan/156-CLAUDE-P8G7-MICRO-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/158-CLAUDE-P8G7-IMPLEMENTATION-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/161-CONSENSUS-P7C4-P8G7B-P8G8-ROUTE-REFRESH.md
depends_on:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-06-19-specialist-agent-creation-blueprint-implementation.md
scope:
  - P8g-7 semantic foundation judge
  - full foundation confirm preview
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

> Implementation note (2026-06-20): this plan's contract/hash/full preview/explicit unverified confirmation path has landed. A later route refresh found that production `tool-executor` and specialist blueprint IPC registration still do not inject a real `runSemanticFoundationJudge`, and `sourceMessageId` remains unset in the conversation tool path. That remaining production wiring is now P8g-7b, tracked by `outputs/agent-audit/fix-plan/161-CONSENSUS-P7C4-P8G7B-P8G8-ROUTE-REFRESH.md`.

# P8g-7 Semantic Foundation Judge + Confirm Preview

## 0. 完成标准

用户说"我要一个 xxxx 类型的专项 agent"后，Ready 已经能生成 staged blueprint。P8g-7 只补最后一道"这份基础文档是否真的专业、贴合、可执行"的语义审稿层，以及确认前完整预览。

完成时必须满足：

- semantic judge 只做闭集判断题，不做路由、不写状态机、不直接批准创建。
- deterministic admission/quality gate 仍是硬底线；semantic judge 只能追加阻塞，不能洗白 deterministic fail。
- semantic verdict、确认 token、Studio 预览绑定同一个 canonical review-content hash，避免"审 A 确认 B"。
- semantic review 的 hash 必须在 canonical 物化后的蓝图上计算：先重新跑 deterministic admission/quality、重渲染 `foundationDocs.foundationText`，再计算 hash。
- judge 不可用、超时、跳过、缺失或过期时，不得静默当作语义通过；deterministic gate 已通过时，只能走用户显式"未经语义校验"确认。
- semantic issue 最多转成一张 clarification 卡，继续遵守 `ask_user_questions` 单 pending 约束。
- Studio 确认前展示完整 `foundationDocs.foundationText` 正文，而不是只显示状态 chip。
- `FOUNDATION.md` 仍不进入 prompt assembly。
- 不新增 foundation 内容字段；只新增 review metadata。

## 1. 禁止事项

- 不做 Studio 从空白手动创建专项 agent；那是 P8g-8。
- 不做 browser isolation；那是 P7c4。
- 不新增 routing active 开关。
- 不把 judge 的自由文本写回 charter/RULES/FOUNDATION 当真值。
- 不允许 LLM 自造 issue id。
- 不把 judge unavailable 当作 pass。
- 不在普通聊天热路径每轮跑 judge。

## 2. Slice A · Review content hash 与闭集类型

新增共享 review 合同，候选落点：

- `src/shared/agent-specialist-blueprint.ts`
- `src/main/modules/agent-control/agents/specialist-blueprint-confirmation.ts`

新增/调整：

- `SPECIALIST_FOUNDATION_SEMANTIC_ISSUES` 闭集枚举，例如：
  - `scope_too_generic`
  - `role_not_operational`
  - `main_split_unclear`
  - `weak_non_goals`
  - `weak_task_examples`
  - `weak_inputs_outputs`
  - `tool_boundary_underexplained`
  - `memory_policy_unclear`
  - `knowledge_lacks_evidence`
  - `foundation_echoes_request`
  - `lifecycle_unclear`
- `SpecialistFoundationSemanticIssue`
  - `id`
  - `message`
  - `clarificationQuestion?`
- `SpecialistFoundationSemanticReview`
  - `status: 'not_run' | 'passed' | 'blocked' | 'unavailable'`
  - `contentHash`
  - `reviewedAt`
  - `issues`
  - `unavailableReason?`
  - `source: 'semantic_judge' | 'unverified_explicit' | 'not_available'`

Hash 合同：

- 新增 `materializeSpecialistBlueprintForReview(registry, blueprint)`：返回 canonical blueprint，内部重新跑 deterministic admission/quality，并用该结果重渲染 `foundationDocs.foundationText`。
- 新增 `hashSpecialistBlueprintReviewContent(canonicalBlueprint)`。
- `hashSpecialistBlueprintForConfirmation()` 改为复用这个 helper，并只接受 canonical review content 或内部先 canonicalize。
- hash 内容域必须排除 `status`、`confirmation`、`adoption`、`semanticReview` 等流程元数据；`admissionVerdict` / `qualityChecks` 必须继续留在 hash 内，把 deterministic gate 结果绑定进 token。
- hash 内容域必须包含 canonical `foundationDocs.foundationText`，并与 Studio 展示的正文同源。
- semantic review、`requestConfirmation`、`confirmCreate` 三处必须在同一个 canonical 物化结果上计算 hash。

测试：

- `specialist-blueprint-confirmation.test.ts`：确认 token hash 与 review content hash 同域；`admissionVerdict` / `qualityChecks` 变化会改变 hash；`semanticReview` / `confirmation` / `adoption` 变化不会改变 hash。
- `specialist-blueprint-semantic-judge.test.ts`：semantic review contentHash 等于 canonical materialized blueprint hash。
- `agent-specialist-blueprint-schema.test.ts`：闭集枚举、optional review metadata shape。

## 3. Slice B · Semantic judge runner 与规范化

新增纯模块，候选落点：

- `src/main/modules/agent-control/agents/specialist-foundation-semantic-judge.ts`

职责：

- 构造 bounded judge input：blueprint 内容、foundationText、provenance、`userRequestVerbatim`、contentHash。
- 规范化 judge output：
  - issue id 必须属于闭集；
  - 未知 id / 非法 JSON / 空输出按 `unavailable` 或 `blocked` 处理，绝不 pass；
  - issue explanations 做长度上限；
  - clarification questions 最多 3 条；
  - 产出的 review 必须带当前 contentHash。
- 提供 `runSpecialistFoundationSemanticReview(blueprint, deps)`：
  - `deps.judge(input, signal)` 可注入；
  - `deps.timeoutMs` 有默认上限；
  - 无 judge / timeout / throw => `status:'unavailable'`；
  - 有闭集 issues => `status:'blocked'`；
  - 无 issue 且 hash 匹配 => `status:'passed'`。

生产接线原则：

- 若当前批次没有可用 production LLM judge runner，默认返回 `unavailable`，但 UI 必须显式显示"未经语义校验"兜底。
- 后续接入真实 provider 时只替换 `deps.judge`，不改变 gate 语义。

测试：

- 长而泛、但 deterministic 通过的 blueprint 被 fake judge 返回 `scope_too_generic` 后阻塞。
- 未知 issue id 不能静默通过。
- judge timeout/throw 返回 `unavailable`。
- ordinary chat turn 不触发 judge：用 propose/save/pre-confirm 入口计数证明调用次数。

## 4. Slice C · Admission / IPC / confirmation 接线

改造候选文件：

- `src/main/modules/claude-bridge/ipc/agent-specialist-blueprint-group.ts`
- `src/main/modules/tools/builtins/propose-specialist-blueprint.ts`
- `src/main/modules/agent-control/agents/specialist-blueprint-admission.ts`

规则：

- `runAdmission` / save blueprint：
  - 先跑 deterministic admission/quality。
  - deterministic fail 时保持现有阻塞，不跑或不信任 semantic pass。
  - deterministic pass 时运行 semantic review；`blocked` 转 `needs_clarification`，missing 使用闭集 issue id。
  - `unavailable` 不转 `admit` 的语义通过，只把 review metadata 存入 blueprint。
- `requestConfirmation`：
  - 重新跑 deterministic gate。
  - 用 `materializeSpecialistBlueprintForReview()` 生成 canonical blueprint，并重新计算 review content hash。
  - 若 semantic review `passed` 且 hash 匹配，允许发 token。
  - 若 semantic review `unavailable` / missing / stale，只有 payload 带显式 `unverifiedSemanticReviewAck` 且 hash 匹配，才允许发 token。
  - deterministic fail 时不允许 fallback。
- `confirmCreate`：
  - 用同一 canonical materialization helper 重新跑 deterministic gate、重渲染 foundation、重新计算 hash。
  - validate token。
  - 重新校验 token 对应的 semantic pass 或显式 unverified ack。
  - 之后才进入 factory。

> 注意：`confirmCreate` 重新跑 deterministic gate 是 P8g-7 的有意收紧。当前代码主要依赖 token + status，再交给 factory；P8g-7 必须在进入 factory 前再次证明 deterministic gate 仍通过。

Payload 建议：

```ts
interface SpecialistBlueprintUnverifiedSemanticReviewAck {
  kind: 'unverified_semantic_review'
  contentHash: string
}
```

Clarification 约束：

- semantic blocks 进入既有 `buildSpecialistBlueprintClarificationContract` 时最多 3 问。
- 问题文本来自代码拥有的 issue 映射；judge 的自由文本只能作为辅助说明，不当 source truth。

测试：

- deterministic fail + judge pass 仍阻断。
- `requestConfirmation` 期 semantic review hash 与 canonical preview hash 相等，防止 save 阶段/confirm 阶段 render 漂移。
- semantic blocked => `needs_clarification`，且最多 3 个问题。
- judge unavailable + deterministic pass + no ack => 不能 requestConfirmation。
- judge unavailable + deterministic pass + ack hash match => 可 requestConfirmation。
- judge unavailable + deterministic fail + ack => 仍阻断。
- content 改动后旧 semantic review / old token 失效。
- `confirmCreate` 即使 token 有效，也会在 deterministic gate 失败时阻断。

## 5. Slice D · Studio full preview 与显式未审确认

改造候选文件：

- `src/renderer/components/agent-system/AgentSystemStudio.tsx`
- `src/renderer/types/electron.d.ts`
- `src/preload/index.ts`

UI 合同：

- 在确认区域展示完整 `foundationDocs.foundationText`，可滚动、可复制、确认按钮附近可见。
- semantic pass 时显示"语义已校验"。
- semantic blocked 时显示代码 issue label + judge explanation，确认按钮不可用。
- semantic unavailable/missing/stale 且 deterministic pass 时：
  - 显示"未经语义校验"；
  - 用户必须勾选/点击显式确认；
  - 该确认把当前 contentHash 传给 `requestConfirmation`。
- editor dirty 时确认不可用；保存后重新计算 hash/review state。

测试：

- full foundation preview renders before confirm.
- preview text equals requestConfirmation hash input.
- unavailable semantic review requires explicit unverified confirmation.
- blocking semantic review hides/blocks confirm.
- dirty editor invalidates confirm.

## 6. Slice E · Gates / drift checks

扩展或新增：

- `scripts/check-specialist-create-funnel.cjs`
- 可选新增 `scripts/check-specialist-semantic-review-contract.cjs`

Gate 要守：

- `FOUNDATION.md` 不得进入 prompt assembly。
- `semanticReview` 不得成为 prompt 注入读源。
- closed issue enum 只能从 shared 合同导入，不能在 renderer/main 各写一份。
- semantic judge、`requestConfirmation` 与 `confirmCreate` 必须引用同一 canonical materialization + hash helper。
- 不得新增 blank manual creation IPC 或 routing active write。
- 新增测试和 gate 必须挂入 `package.json` 的 `verify:specialist-blueprint` / `verify:agent-system-studio`，不能只存在于手跑命令。

测试：

- gate fixtures 覆盖：直接用自由文本 issue、绕过 hash helper、三处 hash helper 漂移、prompt 注入 foundation、确认路径不校验 semantic/unverified 状态。

## 7. 验证顺序

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/specialist-blueprint-semantic-judge.test.ts \
  src/__tests__/specialist-blueprint-admission.test.ts \
  src/__tests__/specialist-blueprint-confirmation.test.ts \
  src/__tests__/agent-specialist-blueprint-ipc.test.ts \
  src/__tests__/agent-system-studio-render.test.tsx \
  src/__tests__/propose-specialist-blueprint-tool.test.ts
node scripts/check-specialist-create-funnel.cjs
npm run verify:specialist-blueprint
npm run verify:agent-system-studio
npm run typecheck
npm run verify:native
git diff --check
```

实现完成后，把改动交 Claude 做对抗复审；Claude 必须重点看：

- 是否有"判 A 确认 B"的 hash 漏洞；
- judge 是否能洗白 deterministic fail；
- unavailable 是否被静默 pass；
- Studio 是否真的展示完整 foundation 正文。
