---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# I W0 Pre-flight Audit Report

> Date: 2026-05-02
> Worktree: `/Users/user/Documents/实验田/ready-cowork`
> Branch at audit start: `main`
> HEAD at audit start: `4b315a4f0a9ecf07f8d3c3e11145859d776a85f3`
> Claude draft source: `.worktrees/codex-skill-runtime-b-plan/docs/archive/2026-09-06/docs/superpowers/plans/2026-05-02-I-cross-boundary-confirmation-and-renderer-observability.md`

## Summary

- The I direction is valid: the current send path still lets renderer show or clear state before main has confirmed the corresponding durable state.
- The draft needs factual corrections before implementation:
  - `src/renderer/stores/useAgent.ts` is the active store path.
  - `sendScoped` does not currently persist the user message; renderer calls `chat:saveMessage` separately.
  - attachments are message metadata, not independently persisted rows, so `partial persisted` must mean metadata/input confirmation, not row-by-row attachment persistence.
  - `requestId` is a run correlation id, not a persisted entity.
  - `responseId` is local renderer state; its risk is assistant-message persistence failure after streaming.
- Hard ESCALATE is triggered: renderer silent catch N0 is `82`, greater than the `>80` split threshold. I must ship as I1/I2.

## Commands Run

```bash
git status --short
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
node scripts/check-silent-catch.cjs
rg -n "\.catch\(\(\) => (null|undefined|\{\})\)" src/renderer
rg -n "\blogAgentMetric\b" src/renderer src/preload
rg -n "result\.error|error instanceof Error|String\(error\)|data\.error" src/renderer
```

Read-only subagent audits were also used for:

- send-chain confirmation truth
- renderer observability and error-surface counts
- H-shaped implementation/gate shape

## Evidence

| Item | Current fact | Evidence |
| --- | ---: | --- |
| H silent-catch gate | green, main-only | `silent catch: ok (198 baseline entries)` |
| baseline renderer entries | 0 | `scripts/snapshots/silent-catch-baseline.json` has no `src/renderer/` entries |
| renderer silent catches | 82 | AST scan using H checker logic over `src/renderer/` |
| renderer `.catch(() => null/undefined/{})` regex hits | 42 | `rg` over `src/renderer/` |
| renderer metric channel | 0 | no `logAgentMetric` / renderer metric IPC in renderer/preload |
| broad raw error use in renderer | 110 hits | includes non-agent products; I1 only fixes agent-send surfaces |

## Send Chain Findings

- `AgentControlRuntime.sendScoped` currently returns only `{ success, error }`; the IPC handler also only returns those fields.
- Scope lazy-create exists in main for local `conv-` ids when `agent` is supplied.
- User message persistence happens in renderer through `persistChatMessage`, which swallows thrown errors and ignores `{ success:false }`.
- Attachments are serialized into user message metadata and later reconstructed from DB chat messages. If user message persistence fails, tool-side attachment lookup cannot see them.
- `buildComposedAgentInput` silently skips file-read failures, so a user can see an attachment while the actual model input omits it.
- Assistant responses also persist through renderer-side `persistAssistantMessage`; failures are swallowed.

## Open Decisions

| Question | Decision |
| --- | --- |
| W split | Split I into I1 and I2 because renderer silent catch N0 is `82`. |
| subagent assignment | Keep work serialized locally; use subagent findings only as evidence. |
| renderer N0 threshold | Triggered. I1 excludes silent-catch baseline; I2 owns it. |
| friendly mapping location | `src/renderer/modules/agent/error-message-mapping.ts`. |
| metric batching | No batching; low-frequency fixed metric names only. |
| persistence field names | Use stable `persistence` plus `errorKind`, but correct attachment names to metadata/input states. |
| attachment partial UI | I1 stops send on input attachment failure; metadata partial is visible as friendly send failure. |
| errorKind completeness | I1 covers proven agent-send errors; broad product errors stay out of scope. |
| evidence drift | Current plan corrected from W0 facts before code work. |

## ESCALATE Outcomes

- `§1` evidence drift is corrected here and in the implementation plan.
- `renderer silent-catch N0 > 80` is triggered; I is split.
- friendly mapping broad renderer false-positive risk is high if scoped to all products; I1 is intentionally restricted to agent-send surfaces.

## Post-flight Note

- I2 froze the expanded silent-catch baseline at `279` total entries.
- Renderer entries moved from `N0=82` measured during W0 to `N_FINAL=81` after the I1 code changes and W6 baseline update.
