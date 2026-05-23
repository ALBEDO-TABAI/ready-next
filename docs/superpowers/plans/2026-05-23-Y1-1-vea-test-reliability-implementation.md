---
name: Y1-1-vea-test-reliability-implementation
stage: Y1.1
date: 2026-05-23
status: implementation-draft
enforce: false
parent_roadmap: docs/superpowers/plans/2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
scope_lock: §11.1 (Y1.1 VEA/vision profile test reliability remainder; cache-quota half moved to §11.0a per Y0.8)
acceptance_reference: §11.1 + §3 Stage Z entry P1 subset includes Y1.1
---

# Y1.1 — VEA/vision profile test reliability + disabled-default labeling

## 0. Decision

Stage Y picks the **honest-label path** (§11.1 option b) over the
real-probe path (§11.1 option a).

Rationale (per §11.1 + §4.3 budget + Y0.7/Y0.8 precedent):

- Honest-label path is the minimum P0 scope per §11.1 ("button label
  changes to 'Validate fields only' with disabled state when no key is
  configured"). 2-3h sub-plan slot per §4.3.
- The real-probe path would require a per-`apiKind` POST adapter
  (OpenAI Chat / OpenAI Responses / Anthropic Messages all need
  different payload shapes), real-network exposure (the user's API
  key would be sent the moment they click `测试`), and a model-name
  resolver. That work bundles vision-specific shape decisions that
  Stage Z's VEA dispatch landing already owns.
- This decision mirrors the Y0.7 (MCP not-shipped) + Y0.8 (cache-quota
  relabel) precedent — Stage Y consistently picks the labeling path
  for P0 hardening where the underlying behavior is "configured but
  not enforced / not live-probed".
- Current state (verified at this commit):
  - `src/renderer/pages/Settings.tsx:2491-2500` renders a `测试` button
    that calls `testProfile()` → `testExternalServiceDraft` IPC.
  - `src/main/modules/settings-engine/external-service-store.ts:334-391`
    `testResolvedProfile()` for `kind === 'vision-model'` ONLY validates
    that `baseUrl + model + apiKey` are present (lines 342-344) and
    then falls through to the generic `return { ok: true, message:
    '配置已就绪' }` at line 390 — NO HTTP request is made. This is
    misleading: the green `连接正常` toast suggests a probe succeeded,
    when only field validation happened.
  - Other kinds DO probe: `amap` (line 351-372), `rsshub` / `duckduckgo`
    / `jina` (line 374-388).
  - For `vision-model`, the honest UI must (a) relabel the button to
    "仅校验字段 / Validate fields only" and (b) disable the button when
    required fields (`baseUrl` / `model` / `apiKey`) are missing.

This decision satisfies §11.1 labeling-branch acceptance verbatim:

> "button label changes to 'Validate fields only' with disabled state
> when no key is configured. Tests cover both branches
> (probe-success + probe-failure)."

For the honest-label path, "probe-success" is reinterpreted as
"validation-pass (all required fields filled → button enabled → click
fires field-only validation → success toast)" and "probe-failure" is
reinterpreted as "validation-fail (any required field missing → button
disabled → click is a no-op)".

## 1. Scope

In scope:

- For `kind === 'vision-model'` profiles ONLY:
  - Button label flips from `测试` / `测试中` to `仅校验字段` /
    `校验中` when the selected profile is a vision-model.
  - Button gains an explicit `disabled` state when any required
    vision field is missing (using existing
    `externalServiceMissingRequirements()` helper at Settings.tsx:2130
    which already knows about `vision-model` requiring `baseUrl + model
    + apiKey`).
  - Inline help text added below the button row: `仅校验字段，不发起真实
    请求 / Validates fields only; no live request issued.` so the user
    understands "test pass" does NOT mean the model endpoint was
    reached.
- Behavior test
  `src/__tests__/settings-vea-test-button-relabel.test.ts` asserts:
  - For vision-model profile, button text is the honest label
    (`仅校验字段` not `测试`).
  - When required fields are missing, button is disabled.
  - Inline help text is rendered.
  - For non-vision-model profiles (e.g. `amap`, `jina`), button text
    stays `测试` (does NOT relabel; those kinds DO probe).
- Append Y1.1 disposition row to
  `docs/superpowers/audits/2026-05-23-stage-y-closeout/deferred-work-ledger.md`
  bucket `retired-with-reason` for the relabel + `Stage Z release-
  candidate` for the follow-up real-probe scope.
- Add a § "Stage Z VEA carry-over" subsection to
  `docs/superpowers/audits/2026-05-23-stage-y-closeout/release-handoff.md`
  documenting (a) the labeling-path choice rationale, (b) Stage Z scope
  (real probe for ≥1 `apiKind` adapter), (c) expected file touch
  surface.

Out of scope:

- Main-process change to `src/main/modules/settings-engine/external-
  service-store.ts` — the `testResolvedProfile()` field-validation
  branch stays as-is; the renderer relabel reflects what the main
  process actually does (not pretends to do more).
- Real HTTP probe to vision endpoints — deferred to Stage Z per §13.
- New IPC channel — the existing `settings:testExternalServiceDraft`
  channel is reused unchanged.
- Other external service kinds (`amap`, `rsshub`, `jina`, `duckduckgo`,
  `tavily`, `github`, `bilibili`) — they DO probe and their buttons
  stay labeled `测试`.
- Y0.8 cache-quota work (already done at c969869e) — explicitly
  forbidden by §11.1 scope lock.
- Y0.7 MCP work (already done at parent sub-plan) — explicitly
  forbidden by §11.1 scope lock.
- Vision profile `enabled` default change — §11.1 says "disabled state
  when no key is configured" which the existing
  `externalServiceMissingRequirements()` + `toggleProfileEnabled()`
  flow already handles (Settings.tsx:2214-2230 blocks enabling without
  required fields). The §11.1 "disabled-default labeling" phrasing
  refers to the BUTTON disabled state, NOT the profile `enabled`
  default — the existing toggle behavior already enforces the
  prerequisite check before enabling.

## 2. Files to touch

| File | Change | Reason |
| --- | --- | --- |
| `src/renderer/pages/Settings.tsx` | (1) Add helper `isVisionModelProfile()` (or inline) gating relabel; (2) compute `visionFieldsReady` from existing `externalServiceMissingRequirements()`; (3) in the `测试` button block (line 2491-2500), branch the button label + disabled state + inline help text when `selectedProfile.kind === 'vision-model'`. | Single renderer entry point for the relabel; main-process behavior unchanged. |
| `src/__tests__/settings-vea-test-button-relabel.test.ts` | New behavior test asserting honest label + disabled state + inline help text for vision-model; non-vision-model unaffected. Uses jsdom + createRoot pattern from `settings-cache-quota-relabel.test.ts`. Filename uses `.test.ts` (not `.test.tsx`) because the test uses `createElement` instead of JSX — required for discovery by `scripts/run-parallel-tests.cjs` which globs `*.test.ts` only. | Per `docs/superpowers/testing-conventions.md` behavior tests preferred; jsdom mount is available because Y0.8 already demonstrated it. |
| `docs/superpowers/audits/2026-05-23-stage-y-closeout/deferred-work-ledger.md` | Append Y1.1 disposition row (bucket `retired-with-reason` for the relabel itself; cross-reference to a sibling `vea-vision-real-probe-deferred` row bucket `Stage Z release-candidate` for the follow-up probe work). | §3.1 + §3.3 §0.7 exit criterion; ledger row required so `check-stage-y-p0-ledger.cjs` can validate Y1.1 closure. |
| `docs/superpowers/audits/2026-05-23-stage-y-closeout/release-handoff.md` | Add §5e "VEA / vision profile test carry-over (Y1.1 honest-label branch only)" with rationale + Stage Z scope + expected file touch surface. | Stage Y release-handoff covenant: every P1 deferred-to-Z handoff has a §5x section so Stage Z does not inherit orphans. |

No main-process change. No `src/preload/index.ts` change. No new IPC
channel.

## 3. Acceptance

Per §11.1 labeling-branch acceptance:

- Settings page → external services → select vision-model profile:
  - Button text reads `仅校验字段` (or `校验中` when loading) NOT `测试`.
  - Button is disabled when any of `baseUrl` / `model` / `apiKey` is
    empty AND no draft secret is staged.
  - Inline help text reads `仅校验字段，不发起真实请求 / Validates fields
    only; no live request issued.` directly below the button row.
- Settings page → external services → select non-vision-model profile
  (e.g. `amap`):
  - Button text still reads `测试`.
  - Behavior unchanged.
- New test `settings-vea-test-button-relabel.test.tsx` passes (3-4
  assertions covering the above).
- `npm run typecheck` exit 0.
- `npm run lint:check` exit 0, warning count ≤ 771 (no growth).
- `npm run test` exit 0 (including the new test).
- `npm run verify:ipc-contract` exit 0 (no new IPC channel; surface
  unchanged).

## 4. Step-by-step

1. Read this sub-plan + plan §11.1 + §3.
2. Verify current state at Settings.tsx:2491-2500 + external-service-
   store.ts:342-344,390 (already done in §0 above).
3. Edit `src/renderer/pages/Settings.tsx`:
   - Compute `isVisionModel` from `selectedProfile?.kind ===
     'vision-model'` near the existing `isSelectedTesting` derivation
     (line 2305).
   - Compute `visionMissing` via
     `externalServiceMissingRequirements(selectedProfile, selectedDraft)`
     when `isVisionModel` is true.
   - In the `测试` button JSX (line 2491-2500):
     - Label flip: `isVisionModel ? (isSelectedTesting ? '校验中' :
       '仅校验字段') : (isSelectedTesting ? '测试中' : '测试')`.
     - `disabled` extends with `(isVisionModel && visionMissing.length
       > 0)`.
     - Insert inline help text below the button row (or in the existing
       feedback row directly above) gated on `isVisionModel`.
4. Write `src/__tests__/settings-vea-test-button-relabel.test.ts`
   modeled on `settings-cache-quota-relabel.test.ts`:
   - jsdom + createRoot mounting `ExternalServicesSettingsPanel`
     (export if not already exported; mirror Y0.8 export note).
   - Stub `listExternalServices` to return one vision-model profile
     (missing apiKey) + one amap profile (configured).
   - Assert vision-model panel: button text contains `仅校验字段`,
     button is `disabled`, help text contains `仅校验字段，不发起真实请求`.
   - Assert amap panel: button text contains `测试` (NOT `仅校验字段`).
   - Assert clicking the disabled vision-model button does NOT invoke
     `testExternalServiceDraft` stub.
5. Append Y1.1 ledger row.
6. Add §5e to release-handoff.md.
7. Run verify chains:
   - `npm run typecheck`
   - `npm run lint:check`
   - `npm run test`
8. Commit per task instructions.

## 5. Rollback

If the relabel causes visual regression (e.g. button row width
overflow at small viewport because `仅校验字段` is wider than `测试`),
revert the label change to `测试 (仅字段)` short form keeping the
disabled-state + help text intact. The ledger row + handoff section
stay because the Y1.1 P1 disposition is still satisfied — only the
exact label string changes.

## 6. Predecessor links

- Roadmap: `docs/superpowers/plans/2026-05-23-Y-ready-product-
  completion-and-release-hardening-roadmap.md` §11.1 + §3 P1 subset.
- Sibling labeling-branch precedents:
  - Y0.7 MCP not-shipped: `docs/superpowers/plans/2026-05-23-Y0-7-mcp-
    not-shipped-labeling-implementation.md`
  - Y0.8 cache-quota relabel: `docs/superpowers/plans/2026-05-23-Y0-8-
    cache-quota-relabel-implementation.md`
- Existing vision-model behavior (unchanged by this phase):
  - `src/renderer/pages/Settings.tsx:2398-2438` vision profile form
  - `src/main/modules/settings-engine/external-service-store.ts:
    342-344,390` field-validation-only branch
- Closeout bundle: `docs/superpowers/audits/2026-05-23-stage-y-
  closeout/` (ledger + handoff land here).
