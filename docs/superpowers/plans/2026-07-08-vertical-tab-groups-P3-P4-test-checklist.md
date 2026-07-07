---
status: P3 + P4 delivered (committed + adversarially reviewed); this is the real-machine acceptance checklist for 白
owner: 白
author: Claude (Opus 4.8)
enforce: false
governs:
  - docs/superpowers/plans/2026-07-07-vertical-tab-groups-and-reorder-implementation.md (feature)
  - docs/superpowers/plans/2026-07-08-vertical-tab-groups-execution-handoff.md (execution state)
note: >
  Vertical-tab groups: P3 (browser overlay group UI) + P4 (opener→group inheritance) are
  implemented, gated, and adversarially reviewed. Automated verification is green; the items
  below are the manual real-machine acceptance pass. Run `npm run dev` on macOS.
---

# Vertical-tab Groups — P3 + P4 Real-Machine Test Checklist

## 0. What shipped this round (commits on `feature/skill-envelope-floors`)

| Commit | What |
| --- | --- |
| `a5485a24` | **P3** — browser overlay tab-group UI (protocol id-based reorder + group commands; D-SNAPSHOT flat-order snapshot; 52px strip group bars + two-intent drag; overlay flyout group headers/members/collapse + inline editor; delete/new-tab-in-group orchestration; 2 gates + tests) |
| `614982df` | **P4** — opener→group inheritance (background-opened link lists after its opener + inherits its group) |
| `92dbdab3` | P3 review fixes — split-pair connector adjacency + overlay rename unmount-commit |

## 1. Automated verification already green (no action needed — for reference)

- `npm run typecheck` — our files clean (the only errors are another session's unrelated
  uncommitted conflict markers in `map-semantic-intent.ts` / `route-planner.ts` — NOT ours).
- `npm run verify:tab-groups` — 4 gates OK + 46 tests pass (model / stores / display-model /
  overlay-snapshot flat-order / opener-inheritance).
- Adversarial review (4 independent lenses): store orchestration **clean**; the 2 UI findings
  above were fixed and are re-checked below (items P3-5b, P3-14).

## 2. Setup

`npm run dev` → Browser mode. Open ~4–5 tabs on real sites (so favicons/titles differ).

---

## 3. P0 regression — right-click "open in new tab" (background)

| # | Action | Expected |
| --- | --- | --- |
| P0-1 | Right-click a link → 在新标签页打开链接 | New tab appears in the strip immediately; the **current page is NOT preempted** (no view jump); the address bar stays on the original tab. |
| P0-2 | Right-click an image → 在新标签页打开图片 | Same as P0-1. |

## 4. P3 — browser overlay group UI (the new work)

| # | Action | Expected |
| --- | --- | --- |
| P3-1 | Hover the 52px rail | Flyout opens flush to the right of the rail, over the page. |
| P3-2 | Drag one tab **onto** another (release over the middle of the target) | A group forms (folder-style highlight during hover). Both tabs get a colored left bar in the 52px strip; the flyout shows a **group header** (color dot + name placeholder 未命名群组 + count) with the two members indented under it. |
| P3-3 | Drag a tab into the **gap** between two tabs (top/bottom quarter of a row) | Reorder with a divider line; **no** group forms. |
| P3-4 | Drag an ungrouped tab onto a **grouped** tab | It joins that group (does not make a new one). |
| P3-5 | Group header → click ⋯ → inline editor. Type a name, press Enter (or click a tab row) | Header shows the new name. |
| **P3-5b** | **[fix]** ⋯ → type a new name → **without clicking elsewhere first**, click 群组中新建标签 (or 取消群组) | The rename is **still applied** (name is not lost). This is the macOS button-click-doesn't-blur case. |
| P3-6 | Inline editor → click a color swatch | Group color updates everywhere (strip bar + header dot + member bars). |
| P3-7 | Inline editor → 群组中新建标签 | A new blank tab **joins the group** (adjacent to the group), created in the background — it does **not** steal focus / jump the page. |
| P3-8 | Group header → collapse chevron | Members hide in the flyout; the **52px strip still shows** every member icon with its color bar. |
| P3-9 | With a group collapsed, click one of its member icons in the strip | The group **auto-expands** and the tab activates (D-COLLAPSE). |
| P3-10 | Hover a grouped member in the flyout → click 移出 | The tab leaves the group and settles just outside the group's run. |
| P3-11 | Inline editor → 取消群组 | Group is removed; **all its tabs remain** (just ungrouped). |
| P3-12 | Inline editor → 关闭群组标签 | All member tabs close; other tabs remain. If the group held **every** tab, a blank replacement tab appears (never 0 tabs / blank window). |
| **P3-12b** | **[fix]** Delete a group that holds **every** open tab | The replacement tab appears and the rail/flyout do **not** flicker to the empty-state view mid-operation. |
| P3-13 | Open group A's ⋯, then group B's ⋯; rename each | Each editor shows the correct group's name; renaming one never renames the other. |
| **P3-14** | **[fix]** Make a group, activate a tab **inside** it, then shift-click a tab **outside** the group to split-view | The strip's active/split connector nub must **not** falsely bridge the active icon to the group member below it. (It should only draw a connector when the split icon is directly below the active icon.) |
| P3-15 | Toggle split view on/off a few times | Groups are **not** wiped by the split-view remount. |
| P3-16 | Quit and relaunch the app | Groups + tab order + colors + collapse state are all **preserved**. |
| P3-17 | Drag-reorder tabs **inside** the flyout | Order updates; the flyout reflects it; the flyout does **not** self-close mid-drag. |
| **P3-17b** | **[fix]** Enter split view (shift-click a second tab), then drag a **third** tab to reorder it (strip or flyout) | It lands **where you dropped it** — not jumped to the top, and (when dropped inside a group) it actually joins that group. This is the split-hoist vs flat-order geometry fix. |
| P3-18 | Drag a tab out of the flyout and drop **outside** it | Flyout closes. (Drag + drop **inside** the flyout → it stays open.) |
| P3-19 | ⋯ → rename a group using **Chinese IME** (拼音) | Composition works correctly in the overlay child window (R-OVERLAY-INPUT). |

## 5. P4 — opener→group inheritance

| # | Action | Expected |
| --- | --- | --- |
| P4-1 | Put a tab in a group. In that tab, right-click a link → 在新标签页打开链接 | The new (background) tab **joins the same group**, positioned **right after the opener** (not at the end). |
| P4-2 | In an **ungrouped** tab, right-click a link → 在新标签页打开链接 | The new tab appears **right after the opener** (adjacent), ungrouped. |
| P4-3 | Middle-click (or a `target=_blank` link / window.open) from a grouped tab | New tab inherits the group, adjacent to the opener. |

## 6. Regression sanity

| # | Action | Expected |
| --- | --- | --- |
| R-1 | New tab (+), switch tabs, close tab, middle-click-close | All work as before. |
| R-2 | Throughout | No duplicate rows in the strip or flyout for the same tab. |

---

## 7. If something fails

Note the item number + what you saw. The two most subtle areas (and their guardrails):
- **Reorder landing in the wrong slot** when a split tab and its active partner are in
  different groups — the snapshot sends the *flat* order and the drop resolves `toRank`
  against it (`check-overlay-snapshot-flat-order` guards this). If a reorder lands wrong,
  capture the before/after order + which tab was active/split.
- **Groups vanishing** after split-toggle / restart — guarded by
  `check-tabs-merge-preserves-groups`; if it happens, note whether it was a split-toggle or
  a restart.
