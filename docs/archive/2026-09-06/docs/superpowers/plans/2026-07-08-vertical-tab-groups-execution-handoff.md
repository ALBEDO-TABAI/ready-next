---
status: execution checkpoint after P0/P1/P2 (committed + adversarially reviewed); P3/P4 + final review + test-checklist remain
owner: 白
author: Claude (Opus 4.8)
enforce: false
governs:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-07-07-vertical-tab-open-in-new-tab-fix-implementation.md (Doc A = Phase 0)
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-07-07-vertical-tab-groups-and-reorder-implementation.md (Doc B = feature)
note: >
  Resume brief for the vertical-tab groups feature. P0 (bug fix), P1 (model+stores),
  P2 (document UI) are DONE, committed, and adversarially reviewed. This doc hands off
  P3 (browser overlay UI), P4 (opener→group inheritance), and the final overall review +
  test checklist. Read Doc A + Doc B first; this doc adds execution state, exact anchors,
  reusable assets, and the concurrent-branch caveat.
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Vertical-tab Groups — Execution Handoff (2026-07-08)

## 1. Status — what is DONE (committed + reviewed)

Branch `feature/skill-envelope-floors`. All five commits below are in history and are
ancestors of the current HEAD (verified via reflog — the other session's agent-control
commits sit on top; NOT a force-reset):

| Commit | Phase | Delivered |
| --- | --- | --- |
| `d055bd66` | docs | Doc A + Doc B plan docs |
| `7ca9b2f2` | **P0** | Right-click 在新标签页打开 opens in background (widen `BrowserContextMenuHost.createTab` + wiring + `{background:true}`); gate `check-context-menu-open-in-tab-background.cjs`; strengthened `browser-tab-lifecycle-tabopened.test.ts` |
| `1e1443e0` | **P1** | `src/shared/tab-groups.ts` + `tab-group-model.ts` (pure, I1–I3); both stores gain `groupId`/`tabGroups`/group methods/persistence (doc v2→v3); 3 backend→renderer paths preserve groups; gates `check-tabs-merge-preserves-groups.cjs` + `check-tab-group-model-single-source.cjs`; `verify:tab-groups` |
| `4fde895d` | **P2** | Document rail group UI (52px color bars + flyout headers/members/collapse + two-intent drag + edit popup); pure `tab-rail-display-model.ts` + `tab-group-visuals.ts`; DocumentMode wiring + delete/new-tab orchestration |
| `5db09b04` | P2 fix | Portaled group edit popup `key` (cross-group rename corruption) |

Review trail: P0 (2 rounds), P1 (6-lens → 8 findings fixed → confirm), P2 (4-lens → 5
findings fixed → confirm → 1 fix-up). All fixes test-locked.

## 2. ⚠ Concurrent-branch caveat (READ FIRST)

Another session is actively committing agent-control/map work on this SAME branch and
leaves **uncommitted conflict markers** in `src/main/modules/agent-control/map-semantic-intent.ts`
and `src/main/modules/map-engine/route-planner.ts`. Consequences for resuming:

- **`npm run typecheck` fails globally on THEIR files.** Verify OUR files in isolation:
  `npm run typecheck 2>&1 | grep <our-file>` → expect zero. Do NOT touch/resolve their
  conflict markers.
- **Commit often + surgically.** Stage only our files by explicit path (never `git add -A`).
  For `package.json`, isolate our hunk with `git apply --cached --recount` (see §6 recipe) —
  their hunks (version bump, agent verify scripts) must stay unstaged.
- Our work is safe in history; the risk is only to *uncommitted* working-tree files, so
  keep the uncommitted window small.

## 3. Reusable assets from P1/P2 (P3 leans on these)

- **`src/shared/tab-group-model.ts`** (pure): `GroupModelState`, `normalizeGroupState`,
  `createGroupFromDrop/addToGroup(tail-append)/removeFromGroup/reorderTab/rename/recolor/
  setGroupCollapsed/disbandGroup`, `segmentIntoRuns`. Invariants I1 (contiguity) / I2
  (group order = earliest member) / I3 (no orphans).
- **`src/shared/tab-groups.ts`**: `TabGroup`, `TabGroupColor`, `TAB_GROUP_COLORS`,
  `pickNextGroupColor`, `isTabGroupColor`.
- **`src/renderer/components/tabs/tab-rail-display-model.ts`** (pure, P3-REUSABLE):
  `buildTabRailRows(order, groupOf, groups, activeId, splitId)` → `{rows, flatOrder}` with
  run-local split hoist + I-DISPLAY contiguity; `resolveReorderDrop(flatOrder, groupOf,
  movedId, targetId, intent)` → `{toRank, intoGroupId}`.
- **`src/renderer/components/tabs/tab-group-visuals.ts`** (pure): `tabGroupColorVar/Soft`,
  `resolveTabDropIntent(offsetY, rowHeight)` → `'before'|'onto'|'after'`.
- **`useBrowserTabs`** already has the group methods + `mergeBackendTabsPreservingGroups`
  (P3 command handlers call these).
- **`src/shared/vertical-rail-flyout-layout.ts`**: `resolveGroupedFlyoutContentHeight`,
  `VERTICAL_RAIL_FLYOUT_GROUP_HEADER_HEIGHT` (added in P2).
- Reference implementation to mirror: **`DocumentVerticalTabRail.tsx`** (the whole P2
  group UI — the browser overlay is the same UI in a separate window).

## 4. P3 — Browser overlay group UI (NEXT)

The browser rail's flyout is a **separate frameless BrowserWindow** with its own renderer
consuming a read-only snapshot + sending commands. Unlike the doc rail (same-window portal),
group ops land main-renderer-side and reflect back via the next snapshot.

### 4.1 Protocol — `src/shared/browser-vertical-rail-overlay.ts`
- `VerticalRailOverlayTab` += `groupId?: string | null`.
- `VerticalRailOverlaySnapshot` += `groups: TabGroup[]`.
- **D-CMD**: replace `reorder{fromIndex,toIndex}` (`:41`) with `reorder{movedTabId, toRank,
  intoGroupId}`; add `create-group{draggedTabId,targetTabId}`, `add-to-group{tabId,groupId}`,
  `remove-from-group{tabId}`, `rename-group{groupId,name}`, `recolor-group{groupId,color}`,
  `set-group-collapsed{groupId,collapsed}`, `disband-group{groupId}`, `delete-group{groupId}`,
  `new-tab-in-group{groupId}`.

### 4.2 D-SNAPSHOT — `VerticalTabRail.tsx` `buildSnapshot` (`:83-113`, the map at `:89`)
Currently `getActiveTabPairOrder(t,aId,sId).map(({tab})=>…)` — the **pair-hoisted display
order, dropping sourceIndex**. Change to emit the **raw flat `tabs` order** + per-tab
`{ split, groupId }` + `groups: tabGroups`. The overlay renderer does the run-local hoist
itself (via `buildTabRailRows`); `toRank` is resolved against the **flat** snapshot order
(`snapshot.tabs.findIndex(id)`), never the visual row. Height: use
`resolveGroupedFlyoutContentHeight` (headers 26px, exclude collapsed) not the flat count.

### 4.3 Command switch — `VerticalTabRail.tsx` (`:164-215`)
- `reorder` (`:189-192`) → id-based: `useBrowserTabs.getState().reorderTabToRank(movedTabId, toRank, intoGroupId)`.
- Add cases for each group command → the matching `useBrowserTabs` group method, then `pushSnapshot`.
- `delete-group` / `new-tab-in-group` are **store-layer orchestration with IPC** (Doc B §11.1):
  - delete-group: members = tabs with groupId; **never-empty** — if deleting all tabs, create a
    replacement first (mirror `useBrowserTabActions.ts` last-tab path), then `browser:closeTab`
    each member; active reselection comes from backend + the merge helper. Do NOT bare-loop closeTab.
  - new-tab-in-group: `createTab(DEFAULT_BROWSER_URL, {background:true})` → `addTabToGroup(newId, groupId)`
    → `browser:reorderTabs(flatIds)` writeback (C-ORDER). Fresh id: the new tab arrives via
    `browser:tabOpened` first; sequence the addToGroup after it lists.

### 4.4 Overlay renderer — `src/renderer/pages/VerticalRailOverlayWindow.tsx`
Mirror `DocumentVerticalTabRail.tsx`'s flyout: `buildTabRailRows` over the snapshot's flat
order → group headers + members + collapse; two-intent drag via `resolveTabDropIntent` +
`resolveReorderDrop`; **optimistic local drag preview** (React state), commit-on-drop via
`send(command)`; next snapshot corrects. Group edit popup: same as P2 but **rendered inside
this child window** (text input works — verify IME per Doc B R-OVERLAY-INPUT). Suppress
hover-close mid-drag. It's a separate JS heap → NO `useBrowserTabs` import; snapshot+command only.

### 4.5 52px browser strip — `VerticalTabRail.tsx` render
Add the group-color left bar per grouped tab (mirror the doc strip). Respect CLAUDE.md §2:
NO backdrop-filter on the BrowserView band (see the `:291-293` lesson).

### 4.6 Gates (Doc B §13)
- `check-overlay-command-group-parity.cjs`: every `VerticalRailOverlayCommand` group variant
  has a handler in the `VerticalTabRail` command switch.
- `check-overlay-snapshot-flat-order.cjs`: `buildSnapshot` no longer wraps the overlay tabs in
  a global `getActiveTabPairOrder` (guards D-SNAPSHOT). Wire both into `verify:tab-groups`.

### 4.7 Tests
Protocol/command parity gate + gate tests; a headless test for the flat-order snapshot;
reuse the display-model tests (already cover the overlay's ordering). Real-machine drag is
the acceptance face (test checklist).

## 5. P4 — opener→group inheritance
Depends on P0's background push. `buildTabPayload` (`tab-meta-service.ts:43-60`) + the emit
gain `openerTabId`; renderer `onTabOpened` (`useBrowserRuntimeEffects.ts:253-287`) inserts the
new tab **after its opener** and inherits the opener's `groupId` (instead of appending at end).
Behavior test: open a link from a grouped tab in the background → new tab joins the same group,
adjacent to the opener. `addTab` dedup assertion (Doc B §14 note).

## 6. Working recipes

- **Adversarial review** (per phase): `Workflow` with N finder lenses (schema'd findings) →
  adversarial verify (default REFUTED) → synthesize confirmed. Then fix → re-confirm round.
- **Comprehensive test sweep** (import-grep MISSES source-reading contract tests — this bit us
  twice in P1): `grep -rlE "useBrowserTabs|useDocTabs|<changed-basenames>" src/__tests__` (path
  string AND import), run the union with `tsx --test`. Pre-existing baseline failure to ignore:
  `ui-contracts/workbench-keep-alive-contract.test.ts`.
- **Isolate a package.json hunk**:
  `git diff package.json > /tmp/p.diff; awk 'NR<=4{print;next} /^@@/{if(buf~/<marker>/)printf"%s",buf;buf=$0"\n";next}{buf=buf $0"\n"} END{if(buf~/<marker>/)printf"%s",buf}' /tmp/p.diff > /tmp/h.patch; git apply --cached --recount /tmp/h.patch`
- **verify lane**: `npm run verify:tab-groups` (gates + gate tests + model/store/display tests).

## 7. Final step (after P3+P4)
Overall adversarial review across all phases → fix → then output the **test checklist**
(content + expected result per item) for 白 to run on a real machine, and STOP. Seed items
already known:

- P0: right-click 在新标签页打开链接/图片 → tab enters strip, current page NOT preempted, address bar stays on original.
- P2 doc: drag tab onto tab → group forms; drag between → reorder w/ divider; collapse hides members in flyout (strip still shows); group menu rename/recolor/新建/取消群组/关闭群组标签; drag out → leaves group; switch between two group menus → correct names, no wrong-group rename; close last group member → no orphan.
- P3 browser: same as P2 in the hover overlay; split-view toggle does NOT wipe groups; restart preserves groups; delete-group never leaves 0 tabs.
- P4: background-open a link from a grouped tab → new tab joins that group adjacent to opener.
