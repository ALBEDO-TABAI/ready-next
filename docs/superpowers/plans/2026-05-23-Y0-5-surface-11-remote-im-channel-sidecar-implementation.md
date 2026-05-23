---
title: Stage Y0.5.11 — Remote IM / channel sidecar dogfood sub-plan
stage: Y0.5.11
surface_id: 11
date: 2026-05-23
status: draft-for-baseline
parent_plan: 2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 11
operator_class: agent-with-bai-spotcheck
mandatory_bai_spotcheck: true
mandatory_bai_spotcheck_scope: Feishu live; otherwise deferred-with-owner
---

# Surface 11 — Remote IM / channel sidecar

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "Fixed fixture: 白 sends from a configured Feishu
  thread (1 text message + 1 image attachment + 1 PDF attachment); agent
  receives all three into the scoped session; user then asks agent to
  summarize. If no live Feishu sidecar is reachable, mark surface as
  `deferred-with-owner` (owner=白, reason='live Feishu sidecar not
  reachable in this run') — do NOT stub remote IM. (Codex r2 should-fix #4:
  ambiguity about live vs stub resolved.)"
- **Must prove**: "Attachment lands in resource layer first (no auto-agent-task
  fire); tool logs do not enter the user-visible transcript (CLAUDE.md §2
  hard constraint); summary task references all three attachments by
  resource id, not raw URLs."

## 1. Detailed reproduction steps

1. Pre-check: confirm Feishu sidecar is reachable and configured for 白's account. If not reachable, immediately mark `status: deferred-with-owner` (owner=白, reason: "live Feishu sidecar not reachable in this run"). DO NOT stub remote IM (per §9.1 explicit rule).
2. Launch app; capture build commit. Open agent panel; switch to the Feishu-bridged scoped session.
3. From 白's Feishu thread:
   - Send 1 text message: "Y0.5 remote-im fixture text".
   - Send 1 image attachment (any PNG/JPG).
   - Send 1 PDF attachment.
4. Verify in app: all three appear in the session's resource layer (NOT as auto-fired agent tasks).
5. Verify in app: tool execution logs DO NOT appear inside the user-visible transcript (CLAUDE.md §2). Only resource entries and explicit agent replies are visible to the user.
6. Ask the agent: "总结一下刚才那三个附件". Wait for response.
7. Verify the agent's task context references the three attachments by RESOURCE ID (visible in `ready-tools.log`), not by raw Feishu URLs.
8. Confirm the summary mentions content from all three resources.
9. Stop recording; capture `ready-directchat.log`, `ready-tools.log`, console.

## 2. Expected result decomposition (test cases)

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 11.1 | All 3 attachments arrive in resource layer | Step 4: resource panel shows text + image + PDF entries |
| 11.2 | No auto-agent-task fire on attachment ingest | Step 4: no agent task started without user prompt |
| 11.3 | Tool logs absent from user transcript | Step 5: transcript shows zero tool-execution log entries |
| 11.4 | Summary references resources by resource id | Step 7: tools log shows resource-id references, not raw URLs |
| 11.5 | Summary content covers all 3 attachments | Step 8: summary text mentions text + image + PDF content cues |
| 11.6 | Defer path: marked correctly when sidecar unreachable | If step 1 fails: status=deferred-with-owner with owner=白 |

## 3. Pre-existing automated coverage

Partial coverage at the Feishu schema layer:

- `src/__tests__/feishu-schemas.test.ts`
- `src/__tests__/feishu-zod-golden-snapshot.test.ts`
- `src/__tests__/feishu-zod-param-derivation.test.ts`

Schema/zod tests exist. The live attachment-to-resource-layer flow and the
no-auto-fire invariant (11.2) plus the tool-log-isolation invariant (11.3)
are NOT automated; this dogfood is the only live evidence.

## 4. Operator class

`agent-with-bai-spotcheck` — per §9.4 row 11: "Remote IM requires a live
channel for attachment ingest evidence. 白 has the live Feishu sidecar
configured; preferred operator if reachable." If 白's sidecar is
unreachable, mark as `deferred-with-owner`.

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-11-remote-im-channel-sidecar.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-11-remote-im-channel-sidecar-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- Attachment lands in resource layer first, no auto-agent-task fire (tests 11.1, 11.2).
- Tool logs do not enter the user-visible transcript (test 11.3).
- Summary references attachments by resource id, not raw URLs (test 11.4).

### Per-test-case checks

- All 6 invariants observable in screencap and/or log tail.
- If `status: deferred-with-owner`: both `deferred_owner` and `deferred_reason` non-empty per §9.2.3 lint rule.

### Mandatory 白 spot-check (per §9.4)

`bai_spotcheck` REQUIRED if status=pass. 白 is the preferred operator
because only 白's box has the live Feishu sidecar configured. The agent
may produce a baseline IF a live sidecar is available in CI; otherwise the
agent's role is to script the defer-path and 白 produces all live evidence.

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, screencap, `ready-directchat.log`, `ready-tools.log`.
- Per §9.2.1, `git_status_porcelain=0`.
- Per §9.2.2, log strictly overlaps reproduction window ± 30s.
