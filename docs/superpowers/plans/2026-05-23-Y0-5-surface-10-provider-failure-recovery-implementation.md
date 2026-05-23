---
title: Stage Y0.5.10 — Provider failure recovery (11-code) dogfood sub-plan
stage: Y0.5.10
surface_id: 10
date: 2026-05-23
status: draft-for-baseline
parent_plan: 2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 10
operator_class: agent-with-bai-spotcheck
mandatory_bai_spotcheck: true
mandatory_bai_spotcheck_scope: HTTP 402 + HTTP 429 paths only (per §9.4 codex r2 ruling)
---

# Surface 10 — Provider failure recovery (11-code)

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "Fixed-fixture matrix: for each of the X2 11-code
  ProviderTerminalCode values, trigger the failure via (a) stub provider for
  unit-test-equivalent paths, (b) live provider for HTTP 402 and HTTP
  429-with-retry-after (mandatory 白 spot-check per §9.4 codex r2 ruling).
  All 11 codes documented in
  `src/main/modules/claude-bridge/provider-terminal-error.ts`. (Codex r2
  should-fix #4: was 'simulate ...' without specifying stub vs live.)"
- **Must prove**: "User sees clear failure for each of 11 codes; composer
  unlocks on every code; retry policy is bounded (transient +
  provider_thinking_echo_required have bounded auto-retry; others do not
  retry); HTTP 402 + HTTP 429 evidence captured live by 白."

## 1. Detailed reproduction steps

1. Read the 11-code enum from `src/main/modules/claude-bridge/provider-terminal-error.ts`. List the 11 codes in the evidence file's reproduction section.
2. Launch app; capture build commit. Open the agent panel.
3. **Stub-driven matrix (agent baseline)**: for each of the 11 codes (except 402 and 429 — those are live), use the test-harness or stub provider hook to inject the failure on the next send.
4. Per code:
   - Send a fixture message.
   - Observe the surfaced failure (toast, banner, inline error).
   - Verify composer unlocks after the failure.
   - Verify the retry policy matches spec (transient + `provider_thinking_echo_required` → bounded auto-retry; others → no auto-retry).
   - Capture `ready-tools.log` slice + screencap per code.
5. **Live-driven HTTP 402 (mandatory 白 spot-check)**: 白 uses a real provider account that returns 402 (out-of-credits) for the next request. Send. Capture live evidence.
6. **Live-driven HTTP 429 with `Retry-After` (mandatory 白 spot-check)**: 白 triggers a real rate-limit (or contrives one). Send. Observe the bounded retry and surfaced failure.
7. Cross-link to Y0.3 evidence if Y0.3 already captures the 402 path.
8. Stop recording.

## 2. Expected result decomposition (test cases)

For each ProviderTerminalCode value C ∈ 11-code set:

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 10.C.1 | Clear failure surfaced | Toast/banner/inline error visible per spec |
| 10.C.2 | Composer unlocks | After failure observed, send button re-enabled (matches `runtime-driver-terminal-unlock.test.ts` invariant) |
| 10.C.3 | Retry policy correct | Transient + `provider_thinking_echo_required` retry up to N times; others do not retry |
| 10.402 | HTTP 402 live evidence captured | 白's live screencap shows 402 surface |
| 10.429 | HTTP 429 live evidence captured | 白's live screencap shows 429 with Retry-After bounded retry |

11 codes × 3 invariants = 33 stub rows; plus 2 live rows = 35 test cases.

## 3. Pre-existing automated coverage

Partial unit coverage of the 11-code matrix:

- `src/__tests__/provider-terminal-classification.test.ts`
- `src/__tests__/runtime-driver-terminal-unlock.test.ts`

X2 stage already covered the 11-code matrix at unit-test level. The live
HTTP 402 path is the X2 root-cause regression and was NOT covered by unit
test before; this surface adds the live evidence required by §9.4 codex r2
ruling.

## 4. Operator class

`agent-with-bai-spotcheck` (HTTP 402 + HTTP 429 paths only) — per §9.4
row 10: "X2 already covered the 11-code matrix in unit tests; HTTP 402 is
the X2 root-cause regression and its live recovery must be 白-verified. May
cross-link to Y0.3 evidence if Y0.3 captures the 402 path."

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-10-provider-failure-recovery.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-10-provider-failure-recovery-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- User sees clear failure for each of 11 codes (tests 10.C.1 for all C).
- Composer unlocks on every code (tests 10.C.2 for all C).
- Retry policy bounded per spec (tests 10.C.3 for all C).
- HTTP 402 + HTTP 429 evidence captured live by 白 (tests 10.402, 10.429).

### Per-test-case checks

- All 35 test cases observable in screencap and/or log tail.
- Evidence file body MUST explicitly cover the HTTP 402 scenario OR cross-link to Y0.3 evidence (per §9.2.3 lint rule for surface 10).

### Mandatory 白 spot-check (per §9.4 + §9.2.3)

`bai_spotcheck` frontmatter block REQUIRED. Scope: HTTP 402 + HTTP 429
paths. The 9 other codes may be agent-baseline-only. The spotcheck evidence
MUST be a separate artifact showing 白 reproducing 402 AND 429 live.

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, screencaps (one per code or composite with time-ranges), `ready-tools.log`.
- Per §9.2.1, `git_status_porcelain=0`.
- Per §9.2.2, log strictly overlaps each code's reproduction window ± 30s.
- Per §9.2.3 surface-10 rule: body explicitly covers HTTP 402 OR cross-links to Y0.3.
