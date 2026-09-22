---
status: P3 + P4 delivered (committed + adversarially reviewed); this is the real-machine acceptance checklist for 白
owner: 白
author: Claude (Opus 4.8)
enforce: false
governs:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-07-07-vertical-tab-groups-and-reorder-implementation.md (feature)
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-07-08-vertical-tab-groups-execution-handoff.md (execution state)
note: >
  Vertical-tab groups: P3 (browser overlay group UI) + P4 (opener→group inheritance) are
  implemented, gated, and adversarially reviewed. Automated verification is green; the items
  below are the manual real-machine acceptance pass. Run `npm run dev` on macOS.
  2026-07-10: §8 appended — Edge-parity restyle (P5) supersedes the P3 items that referenced
  the old header/inline-editor/移出 UI; run §8 INSTEAD of the struck-through parts.
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

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

---

## 8. P5 (2026-07-10) — Edge-parity restyle: what changed + acceptance

Uncommitted round on top of P3/P4. Both group surfaces (browser overlay flyout + document
rail flyout) were restyled to match Edge; the store/protocol semantics are UNTOUCHED except
one new overlay command (`set-group-editor`, height reservation for the floating menu).

**Supersedes:** P3-2's header description (no more color dot / count / tinted band), P3-5
(⋯ + inline editor → hover ✏️ + floating menu), P3-10 (移出 button removed — per-tab removal
is drag-out only, group-level via 取消群组). Everything else in §3–§6 still applies as written.

What shipped:

- **Group header = Edge pill**: solid group-color rounded pill (caret + name, white text;
  dark text on yellow), click toggles collapse, right-click opens the edit menu. Hover the
  header row → ＋ (group new tab) and ✏️ (群组选项) appear at the right. No count badge, no
  full-row color wash.
- **Continuous spine**: grouped members show ONE unbroken 3px color line (flyout: from under
  the pill to the last member, rounded bottom cap; 52px strip: bridged across row gaps per
  group run). Replaces the per-row dashes.
- **Edit menu = Edge menu**: floating panel (name input with group-color focus ring, 9
  DISTINCT color swatches — cyan/yellow/pink no longer alias blue/orange/red, selected shown
  as a donut ring, icon'd actions 群组中新建标签页 / 取消群组 / ─ / 关闭群组标签页). Doc rail
  portals it; the overlay window grows via `set-group-editor` so the menu never clips.
- **Opaque overlay panel**: the child-window flyout background is now layered over solid
  `--bg-content` — the live page no longer bleeds through (a transparent BrowserWindow
  cannot backdrop-blur what's behind it).
- **Header is a drop target**: dropping a dragged tab onto the pill row adds it to that group.

Real-machine items (browser overlay AND document rail where applicable):

| # | Action | Expected |
| --- | --- | --- |
| P5-1 | Hover the rail with a group present | Header shows a solid color pill with the name (未命名群组 placeholder), caret inside the pill; NO dot/count/⋯; page content does NOT bleed through the panel. |
| P5-2 | Click the pill / click again | Collapses (members hide, caret →) / expands. |
| P5-3 | Look at the header row (07-10 revised: ALWAYS visible while the flyout is up, not hover-gated — the flyout is itself hover-summoned, so a second hover gate read as "buttons missing") | ＋ and ✏️ sit at the row's right; ＋ opens a background tab into the group; ✏️ opens the floating menu under the pill. |
| P5-4 | Open the menu on a group near the flyout BOTTOM (few tabs) | The overlay window grows to fit the menu; nothing clips. Close (Enter/action) → window shrinks back. |
| P5-5 | Menu: type name + Enter; type name + click an action without blurring | Both commit the rename (unmount-commit preserved). |
| P5-6 | Menu: swatches | 9 visually DISTINCT colors; selected renders as a ring (donut); clicking recolors pill + spine + strip bars live, menu stays open. |
| P5-7 | Grouped members | **Final (白 07-10 两轮裁定)**: FLYOUT member rows have NO vertical color line (减少隔断; grouping reads from the pill + indentation). The 52px STRIP keeps its continuous group-color bar at the icons' left (one unbroken segment per group run, bridging row gaps; hidden when collapsed). |
| P5-8 | Drag a tab onto the PILL row | Pill shows a soft ring; drop joins the group (works for collapsed groups too). |
| P5-9 | Right-click the pill | Opens the same edit menu (Edge behavior). Right-click a member row still sends the tab reference to chat (unchanged). |
| P5-10 | Remove a single tab from a group | Drag it out (before/after an ungrouped neighbor). The old hover 移出 button is gone by design. |
| P5-11 | Document mode rail | Same pill/spine/menu appearance and behaviors (menu is a portal, flips up near the viewport bottom). |
| P5-12 | Dark theme pass | Pill text legible on every color; menu surface/borders read correctly. |

**P5b — group chip in the 52px icon strip** (白 2026-07-10 follow-up: the strip needs an
in-strip group affordance like Edge's icon rail; supersedes P3-8's "strip still shows every
member icon" — collapsed members now HIDE in the strip and the chip stands in for them):

| # | Action | Expected |
| --- | --- | --- |
| P5-13 | Group present → look at the 52px strip | A small solid-color group chip (rounded, caret inside) sits in the group's slot ABOVE its member icons, aligned with the flyout's pill row. |
| P5-14 | Click the chip / click again | Group collapses: member icons disappear from the strip (and flyout), caret flips to ›. Expand restores them. Strip and flyout rows stay vertically aligned 1:1 throughout. |
| P5-15 | Collapse a group holding the ACTIVE tab | The chip shows the active ring/slot treatment (page keeps showing that tab). Expanding again shows the active icon highlighted as before. |
| P5-16 | Drag a tab over the chip and drop | Chip highlights (soft group fill + ring); drop joins the group — including when collapsed. |
| P5-17 | Split view where the split tab's group is collapsed | No false connector nub bridging the active icon to whatever sits below (the hidden split must not be "paired"). |
| P5-18 | Open the flyout with a group present; compare chip vs pill | The strip chip and the flyout pill sit EDGE-aligned (same 20px height / 6px radius, same row band). Click the chip / pill / swatches / menu items repeatedly | No lingering blue :focus-visible ring on any of them (mouse clicks no longer focus these controls; keyboard Tab still shows the ring). |

**P5c (2026-07-10, second 白 follow-up) — alignment root cause + spine removal, LIVE-VERIFIED via CDP:**

- The strip-vs-flyout ~6.5px vertical offset was NOT window placement (CDP probe: applyBounds
  deltaX/deltaY = 0). Root cause: the strip list's `py-[6px]` Tailwind arbitrary class is
  **absent from the built CSS** (padding computed 0px), so strip rows started at rail top+0
  while flyout rows start at window top+6.5. `pr-[8px]` (flyout row right padding) was dead
  too. Both are now INLINE styles off the shared layout constants. ⚠ Lesson for this repo:
  single-occurrence Tailwind arbitrary classes are not reliably generated — geometry-critical
  values in the rail/flyout files must be inline styles.
- After the fix, measured live (real group, real hover-open): pill-vs-chip center delta =
  **0.5px** (the flyout panel's 0.5px border; sub-pixel, invisible).
- Group lines final split per 白: FLYOUT member line removed (减少隔断); STRIP continuous
  bar RESTORED/kept (only affiliation cue among bare icons). Inline-styled (no arbitrary
  Tailwind classes for geometry).
