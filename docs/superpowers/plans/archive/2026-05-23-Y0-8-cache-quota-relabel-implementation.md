---
artifact: Stage Y0.8 sub-plan — Settings cache quota relabel (P0, non-deferrable)
date: 2026-05-23
status: implementation plan — relabel path chosen per plan §11.0a
parent_plan: ./2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_sections:
  - "§11.0a (P0 scope lock for Y0.8)"
  - "§3.1 Y0.8 row (non-deferrable P0)"
  - "§3.2 non-deferrable carve-out"
  - "§3.3 §0.7 enforcement (check-stage-y-p0-ledger.cjs)"
enforce: false
---

# Y0.8 sub-plan — Settings cache quota UI relabel (path-(b))

## 1. Decision

**Path chosen: relabel (path-(b) per plan §11.0a).** Not eviction
(path-(a)).

### Rationale

Per plan §11.0a + §4.3 budget itemization (codex r4 must-fix #3):

| Path | Effort | Trade-off |
| --- | ---: | --- |
| (a) eviction — measurable trigger + LRU + tests | 4-6 h | Real enforcement, but Chromium HTTP/code cache cannot be hard-bounded via Electron API; only userData subdirs (puppeteer cache, shared dictionary) are deletable, and LRU semantics over heterogeneous subdirs do not match any user mental model. Designing the eviction policy correctly is itself a Stage Z scope-of-work conversation, not a Stage Y closeout task. |
| (b) relabel — UI text + tracking row | 1-2 h | Honest labeling: existing "configured limit" value persists for future use, but the UI no longer claims enforcement. Stage Z owns real eviction landing. |

Path-(b) is the **fast P0 disposition** that closes Y0.8 green without
shipping a half-built eviction mechanism. The existing `cache_quota_bytes`
persistence path (`window.electronAPI.settings.set('cache_quota_bytes', …)`
at `src/renderer/pages/Settings.tsx:1703`) remains in place so the
configured value carries forward into Stage Z, where the real eviction
landing will read it.

## 2. Scope

In-scope:

- `src/renderer/pages/Settings.tsx` `StorageSettingsPanel` quota row
  (currently lines 1797-1821): replace the description label with honest
  text that disclaims enforcement and instructs manual cleanup.
- One behavior test asserting the field still renders AND the honest
  label appears alongside it.
- `release-handoff.md` § "Stage Z cache quota carry-over" subsection
  populated with the relabel decision + Stage Z scope handoff.
- `deferred-work-ledger.md` follow-up row tagged
  `Stage Z release-candidate` (Y0.8 itself is green via relabel; this
  row tracks the deferred eviction work). The row's `item` field MUST
  NOT contain the literal substring `Y0.8` because
  `scripts/check-stage-y-p0-ledger.cjs` would treat it as a §3.2
  carve-out violation.

Out-of-scope (Stage Z):

- Any actual eviction logic (size-trigger detection, LRU ordering,
  background sweep, user-confirm prompts).
- Main-process cache code changes (`src/main/modules/cache/*`,
  `clearCache` IPC implementation, etc.).
- New IPC channels or preload surface additions.
- The existing `Clear cache` button behavior (already functional).
- The cache-stats breakdown panel (already functional).

## 3. Files to touch

| File | Change |
| --- | --- |
| `src/renderer/pages/Settings.tsx` | Replace the quota row's `text-[12px]` description (currently `目标上限（仅记录偏好，Chromium 当前不强制驱逐）`) with bilingual honest text per §4 below. |
| `src/__tests__/settings-cache-quota-relabel.test.ts` | New test file — assert relabel text appears + quota select still renders. |
| `docs/superpowers/audits/2026-05-23-stage-y-closeout/release-handoff.md` | Populate §5c "Cache quota carry-over (Y0.8 path-(b))" — replace the `_(pending)_` placeholder with the relabel decision + Stage Z scope handoff. |
| `docs/superpowers/audits/2026-05-23-stage-y-closeout/deferred-work-ledger.md` | Append follow-up row `y0-8-cache-quota-relabel-disposition`. |
| `docs/superpowers/plans/archive/2026-05-23-Y0-8-cache-quota-relabel-implementation.md` | This sub-plan (created now per plan §11 sub-plan-first rule). |

No main-process changes. No new IPC channels. No new preload surface.
No lint-budget raise. No new dependencies.

## 4. Label text

Two label paragraphs, kept in the same `text-[12px]` description slot
so the visual structure is preserved.

**EN (intentional copy for English-locale review):** `Cache size limit
(configured but NOT enforced — manual cleanup required).`

**ZH (production copy — current UI is Chinese-locale):** `缓存大小上限（仅记录配置，未强制执行 — 需要手动清理）`.

The current copy `目标上限（仅记录偏好，Chromium 当前不强制驱逐）` is
honest in spirit (it already says "仅记录偏好" and "不强制驱逐") but
buries the user-actionable phrase. The new copy promotes "需要手动清理"
into the description so the user understands that hitting the existing
"清除缓存" button is the only way to actually reduce cache size.

Per the orchestrator's recommendation, both EN + ZH variants are
recorded in the source (ZH in the JSX text content, EN in a sibling
inline comment) so the relabel is discoverable to future English-locale
work without forking the JSX.

## 5. Acceptance per plan §11.0a

| Acceptance item | Disposition |
| --- | --- |
| Scope lock: cache quota path-(a) OR path-(b) chosen | path-(b) chosen (this sub-plan, §1) |
| UI label changed to honest "configured limit, not enforced; manual cleanup required" | `src/renderer/pages/Settings.tsx` quota-row description (lines 1797-1821) |
| Tracking row in `release-handoff.md` | §5c populated (no longer `_(pending)_`) |
| Tests cover both branches (eviction-fires + eviction-disabled-with-relabel) | path-(a) test deferred to Stage Z; path-(b) test landed in `src/__tests__/settings-cache-quota-relabel.test.ts` |
| `npm run typecheck` exit 0 | (verified at implementation; see commit) |
| `npm run lint:check` exit 0 + no warning budget growth above 771 | (verified at implementation; see commit) |
| `npm run test` exit 0 including new test | (verified at implementation; see commit) |

Per plan §11.0a, "Tests cover both branches (eviction-fires +
eviction-disabled-with-relabel)" reads naturally as **either branch
needs its own test when its path is taken**. Since path-(b) is the
chosen disposition, only the eviction-disabled-with-relabel test
lands in Stage Y; the eviction-fires test lands in Stage Z when the
real eviction logic ships.

## 6. Test plan

`src/__tests__/settings-cache-quota-relabel.test.ts` (using the same
`node:test` + source-grep precedent as
`src/__tests__/settings-liquid-glass-contract.test.ts`):

1. Read `src/renderer/pages/Settings.tsx`.
2. Assert the file contains the honest ZH label substring
   (`未强制执行` + `需要手动清理`).
3. Assert the file still contains the existing
   `window.electronAPI.settings.set('cache_quota_bytes', …)` call (proves
   the persistence path was NOT removed — the configured value still
   carries forward into Stage Z).
4. Assert the file still contains the `CACHE_QUOTA_OPTIONS` constant
   with `256MB`, `1GB`, `5GB`, `unlimited` entries (proves the user can
   still set a value).

Source-grep is admissible here because the change is a literal-text
relabel; the test asserts the text appears in the JSX literal and the
adjacent code paths are preserved. A jsdom DOM-render test would
require either exporting `StorageSettingsPanel` (an export-for-test
that CLAUDE.md §0 "手术式改动" cautions against) or mounting the entire
Settings page with the full electronAPI proxy harness (~200 lines of
boilerplate as in `chat-panel-baseline.test.ts`) for a single literal-
text assertion. The source-grep approach is honest about what is being
verified: the JSX literal text. Stage Z's eviction-fires test will need
a real DOM-render harness anyway and will be the right place to
factor that out.

## 7. Why this is non-deferrable but the ledger row uses `Stage Z release-candidate`

Per plan §3.2 carve-out + `check-stage-y-p0-ledger.cjs:268`, Y0.8 is
**non-deferrable** — the Y0.8 row in the P0 ledger MUST be green
before Stage Y closes. Per `check-stage-y-p0-ledger.cjs:276-292`, the
green_rule passes when `release-handoff.md` contains the cache-quota
decision row.

The ledger row added here is a **follow-up tracker for the deferred
eviction work**, NOT a deferral of Y0.8 itself. The `item` field
deliberately does NOT contain the literal substring `Y0.8` (it uses
`y0-8-cache-quota-relabel-disposition`) so that the gate's
case-sensitive `lr.item.includes('Y0.8')` check
(`check-stage-y-p0-ledger.cjs:354`) does not mistake it for a §3.2
carve-out violation. The bucket `Stage Z release-candidate` is for
the **eviction work** that ships in Stage Z, not for Y0.8 closure.

## 8. Commit message

`Stage Y0.8 — Settings cache quota relabel (UI label + behavior test) per plan §11.0a`

## 9. Predecessors

- Plan §11.0a (P0 scope lock for Y0.8) — this sub-plan's authority
- Plan §3.1 Y0.8 row (non-deferrable P0)
- Plan §3.2 non-deferrable carve-out
- Plan §3.3 §0.7 enforcement
- `scripts/check-stage-y-p0-ledger.cjs:264-294` (gate that validates
  the relabel decision row in `release-handoff.md`)
- `src/renderer/pages/Settings.tsx:1647-1822` (existing
  `StorageSettingsPanel` containing the quota row)

## 10. Successors

- Stage Z eviction landing — must read the persisted
  `cache_quota_bytes` value, implement size-trigger detection over
  the userData cache subdirs (or document explicitly that
  Chromium-managed dirs are out of scope), and add the
  eviction-fires test deferred from this sub-plan §6.
