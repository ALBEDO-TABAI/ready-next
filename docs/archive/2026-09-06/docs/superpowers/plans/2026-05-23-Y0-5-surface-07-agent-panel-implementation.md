---
title: Stage Y0.5.07 — Agent panel dogfood sub-plan
stage: Y0.5.07
surface_id: 7
date: 2026-05-23
status: draft-for-baseline
parent_plan: ../../../../../superpowers/plans/2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 7
operator_class: agent-with-bai-spotcheck
mandatory_bai_spotcheck: true
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Surface 07 — Agent panel

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "New chat, provider switch, failed send, retry, cold
  start, multi-tab session."
- **Must prove**: "Composer unlocks; active/visible session lists stay
  consistent."

## 1. Detailed reproduction steps

1. Cold start the app (kill, then `npm run dev`). Capture build commit.
2. Open the agent panel. Confirm composer is focused/ready.
3. Start a New Chat (session A). Send a short message ("ping"); wait for response.
4. Switch provider from current to another configured provider (e.g. OpenAI → Anthropic compatible). Confirm session A's provider tag updates.
5. **Failed send**: temporarily set an invalid API key for the active provider (or use the offline trick: kill network briefly). Send a message; observe the failure surface.
6. Re-enable network / restore key; click Retry on the failed message. Confirm composer unlocks and the retry succeeds.
7. Open a new tab → new chat (session B). Send a message in session B.
8. Switch back to session A. Verify A's composer is independent (not showing B's draft, per `useagent-input-value-session-isolation.test.ts` invariant).
9. Open a third tab (session C). Verify the active/visible session list shows all three; switching tabs makes one active at a time.
10. Cold start again (kill, restart). Verify sessions A/B/C persist or re-hydrate per spec.
11. Stop recording; capture `ready-directchat.log`, `ready-tools.log`, console.

## 2. Expected result decomposition (test cases)

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 7.1 | Composer ready on cold start | Step 2: input focused, no blocking spinner |
| 7.2 | New chat creates fresh session | Step 3: A appears in session list with its own id |
| 7.3 | Provider switch updates active session metadata | Step 4: provider tag matches the switched-to provider |
| 7.4 | Failed send surfaces visibly + composer eventually unlocks | Step 5–6: error visible; after retry succeeds, composer is unlocked (no permanent lock per `runtime-driver-terminal-unlock.test.ts`) |
| 7.5 | Multi-tab session isolation | Step 8: A's composer does not show B's draft |
| 7.6 | Active/visible session lists consistent | Step 9: list shows A/B/C; one active highlight |
| 7.7 | Cold-start hydration consistent | Step 10: sessions A/B/C re-appear (or per persistence spec) |

## 3. Pre-existing automated coverage

Extensive coverage at the agent panel and useAgent hook layer:

- `src/__tests__/agent-panel-test-harness.test.ts`
- `src/__tests__/chat-panel-baseline.test.ts`
- `src/__tests__/chat-panel-body-flex-contract.test.ts`
- `src/__tests__/chat-panel-collapsed-rail-contract.test.ts`
- `src/__tests__/chat-panel-waterfall-contract.test.ts`
- `src/__tests__/useAgent-area-selector-contract.test.ts`
- `src/__tests__/useAgent-cross-area-mutation-guard.test.ts`
- `src/__tests__/useAgent-listener-routing-contract.test.ts`
- `src/__tests__/useAgent-session-slice-migration.test.ts`
- `src/__tests__/useagent-input-value-session-isolation.test.ts`
- `src/__tests__/agent-runtime-host-contract.test.ts`
- `src/__tests__/runtime-driver-terminal-unlock.test.ts`

10+ tests. Composer-unlock under live provider-failure conditions and
cold-start hydration in the assembled product require live observation;
this dogfood adds invariants 7.4, 7.7 in product.

## 4. Operator class

`agent-with-bai-spotcheck` — per §9.4 rows "2, 7, 16, 17, 18": composer
timing is visual/timing-sensitive in ways CI-class hardware may mask.
白 MUST observe at least once.

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-07-agent-panel.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-07-agent-panel-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- Composer unlocks (test 7.4).
- Active/visible session lists stay consistent (tests 7.5, 7.6, 7.7).

### Per-test-case checks

- All 7 invariants observable in screencap and/or log tail.

### Mandatory 白 spot-check (per §9.4)

`bai_spotcheck` frontmatter block REQUIRED. 白 must reproduce the
failed-send → retry → composer-unlock cycle and confirm timing matches
spec (no spinner stuck > 5s after retry).

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, screencap, `ready-directchat.log`, `ready-tools.log`.
- Per §9.2.1, `git_status_porcelain=0`.
- Per §9.2.2, log strictly overlaps reproduction window ± 30s.
