---
title: Stage Y0.5.20 — `agent_interaction` capability routing dogfood sub-plan
stage: Y0.5.20
surface_id: 20
date: 2026-05-23
status: draft-for-baseline
parent_plan: ../../../../../superpowers/plans/2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 20
operator_class: agent-only
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Surface 20 — `agent_interaction` capability routing

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "Send a query that triggers `ask_user_questions`
  (the structured reverse-question tool); verify the routing path; verify
  the '1-per-turn + 1-pending-card-per-session' constraint from CLAUDE.md
  §5."
- **Must prove**: "`agent_interaction` is its own capability dimension per
  CLAUDE.md §3 line 53; routing must not be confused with skill
  authorization."

## 1. Detailed reproduction steps

1. Launch app; capture build commit. Open agent panel; start a new session (session A).
2. **Trigger ask_user_questions (basic)**: ask a deliberately ambiguous question that should prompt the agent to reverse-ask. Example: "帮我做个产品决策". The agent should fire `ask_user_questions` with a structured card.
3. Verify a single ask-user-questions card appears (1-per-turn invariant).
4. **Try to trigger a second ask_user_questions in the same turn**: send a follow-up while the first card is still pending. Verify the second attempt is blocked OR queued (NOT fired immediately; per CLAUDE.md §5 "1-per-turn").
5. **Try to trigger ask_user_questions in a different session (session B) while A's card is still pending**: open session B and ask another ambiguous question. Verify the second session can show its own pending card (1-per-session, not 1-per-app).
6. Return to session A and answer the pending card. Verify the card resolves and the agent continues.
7. Verify in `ready-tools.log` that the `agent_interaction` capability dimension is recorded SEPARATELY from any skill authorization (per CLAUDE.md §3 line 53).
8. Verify that `agent_interaction` routing does NOT appear under the skill authorization map for the current turn.
9. Stop recording; capture `ready-directchat.log` + `ready-tools.log` + console.

## 2. Expected result decomposition (test cases)

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 20.1 | Ambiguous query triggers ask_user_questions | Step 2: card appears |
| 20.2 | 1-per-turn enforcement | Step 4: second attempt in same turn is blocked or queued |
| 20.3 | 1-pending-card-per-session enforcement | Step 5: session B can have its own pending card while A's is pending |
| 20.4 | Answering resolves the card | Step 6: pending card cleared; agent resumes |
| 20.5 | `agent_interaction` recorded as own capability dimension | Step 7: tools log shows it under capability=`agent_interaction`, distinct from `skill_authorization` |
| 20.6 | No confusion with skill authorization | Step 8: skill authorization map for the turn does NOT include `agent_interaction` |

## 3. Pre-existing automated coverage

Extensive at the ask-user-questions layer:

- `src/__tests__/ask-user-group-register.test.ts`
- `src/__tests__/ask-user-questions-boot-and-session-sweep.test.ts`
- `src/__tests__/ask-user-questions-cancel-symmetry.test.ts`
- `src/__tests__/ask-user-questions-handler.test.ts`
- `src/__tests__/ask-user-questions-send-message-race.test.ts`
- `src/__tests__/ask-user-questions-store.test.ts`
- `src/__tests__/ask-user-questions-submit-chain.test.ts`
- `src/__tests__/ask-user-questions-sweep-pure.test.ts`
- `src/__tests__/skill-primitive-ask-user-turn-suspend.test.ts`

8+ tests covering the ask-user-questions handler, store, submit chain, and
turn-suspend behavior. The capability-dimension separation (20.5, 20.6) is
asserted in code but the live invariant in the assembled product is the
unique contribution of this dogfood.

## 4. Operator class

`agent-only` — per §9.4 row 20: "`ask_user_questions` constraint
enforcement is logic-testable; agent can run the fixture matrix."

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-20-agent-interaction-routing.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-20-agent-interaction-routing-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- `agent_interaction` is its own capability dimension (tests 20.5).
- Routing not confused with skill authorization (test 20.6).
- 1-per-turn + 1-pending-card-per-session constraints (tests 20.2, 20.3).

### Per-test-case checks

- All 6 invariants observable in screencap and/or log tail.

### Operator-class enforcement (per §9.4)

- `operator_class: agent-only`. `bai_spotcheck` NOT required.

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, screencap, `ready-directchat.log`, `ready-tools.log`.
- Per §9.2.1, `git_status_porcelain=0`.
- Per §9.2.2, log strictly overlaps reproduction window ± 30s.
