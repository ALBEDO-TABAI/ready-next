---
title: Stage Y0.5.13 — FastCard full surface (translate + describe image + resolve video + overlay command + clipping/content-study) dogfood sub-plan
stage: Y0.5.13
surface_id: 13
date: 2026-05-23
status: draft-for-baseline
parent_plan: 2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 13
operator_class: agent-with-bai-spotcheck
mandatory_bai_spotcheck: true
requires_five_subflow_markers: true
enforce: false
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# Surface 13 — FastCard full surface

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "(a) In a browser tab, select text and trigger
  `translateFastCardSelection` (`src/preload/index.ts:399`); verify
  translated overlay renders. (b) Right-click an image and trigger
  `FastCardDescribeImageRequest`; verify description appears in overlay.
  (c) Right-click a video element and trigger `FastCardResolveVideoRequest`;
  verify resolved metadata appears. (d) Fire one `FastCardOverlayCommand`
  (per `BrowserFastCardContextActionEvent` at
  `src/preload/index.ts:13-19,394`); verify overlay command round-trip.
  (e) Clip a browser page into note/card flow and ask agent to transform it."
- **Must prove**: "All four FastCard APIs round-trip; overlay snapshot
  (`FastCardOverlaySnapshot`) reflects the latest action; source URL,
  privacy sanitizer, and document target survive the handoff; overlay
  commands do not race with BrowserView hide/show ritual (X4.1
  BrowserViewIntent contract)."

## 1. Detailed reproduction steps

Run all five sub-flows in sequence; capture per-sub-flow time-range OR
separate screencaps (REQUIRED per §9.2.3 surface-13 rule).

### Sub-flow 13.a — translate
1. Open a tab to a foreign-language fixture page (e.g. `https://www.lemonde.fr/` or `https://www.zeit.de/`). Capture build commit.
2. Select a paragraph of text.
3. Right-click → trigger Translate (FastCard). Verify the translation overlay renders with the translated text.

### Sub-flow 13.b — describe image
4. On the same or a different page (one with a notable image), right-click an `<img>`.
5. Trigger `FastCardDescribeImageRequest`. Verify description overlay renders.

### Sub-flow 13.c — resolve video
6. Navigate to a Bilibili / YouTube / supported video URL.
7. Right-click the video element → trigger `FastCardResolveVideoRequest`. Verify resolved metadata (title, author, duration, etc.) appears in overlay.

### Sub-flow 13.d — overlay command round-trip
8. Trigger one explicit `FastCardOverlayCommand` (e.g. dismiss, copy-out, save-to-doc) per `BrowserFastCardContextActionEvent` at `src/preload/index.ts:13-19,394`.
9. Verify the overlay reacts and round-trip completes (snapshot updates).

### Sub-flow 13.e — clip into note/card flow + agent transform
10. Trigger a page clip into the note/card flow.
11. Ask the agent: "把这段剪藏总结成 3 句话". Verify the agent receives the clipped content and produces a transformed result.

12. Stop recording; capture `ready-browser.log`, `ready-tools.log`, `ready-directchat.log`, console.

## 2. Expected result decomposition (test cases)

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 13.a | Translate overlay renders | Step 3: translated text visible in overlay |
| 13.b | Describe-image overlay renders | Step 5: description text in overlay |
| 13.c | Resolve-video overlay renders | Step 7: resolved metadata in overlay |
| 13.d | Overlay command round-trip | Step 8–9: command triggers + snapshot updates |
| 13.e | Clip + agent transform end-to-end | Step 11: transformed result references clipped content |
| 13.f | Overlay snapshot reflects latest action | After each sub-flow, `FastCardOverlaySnapshot` matches most recent op |
| 13.g | Source URL survives handoff | Log shows source URL in handoff payload |
| 13.h | Privacy sanitizer applied | No raw sensitive headers/cookies leak in payload (per privacy sanitizer) |
| 13.i | Document target survives handoff | Clipped content has correct target doc id |
| 13.j | No race with BrowserView hide/show | Log shows `browser.hideAll()` before overlay paint and `showActive()` after dismiss; no interleave (X4.1 BrowserViewIntent contract) |

## 3. Pre-existing automated coverage

Partial coverage at the FastCard layer:

- `src/__tests__/fastcard-ai-service.test.ts`
- `src/__tests__/fastcard-shared.test.ts`
- `src/__tests__/browser-fastcard-video-resolver.test.ts`

The AI service and shared layer are unit-tested. The full five-sub-flow
round-trip in the assembled product is NOT covered automatically; this
dogfood is the only live evidence for invariants 13.f–13.j across all five
sub-flows.

## 4. Operator class

`agent-with-bai-spotcheck` — per §9.4 row "13, 19": "FastCard/clipping (13)
is visual; agent baseline + 白 spot-check."

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-13-fastcard-full-surface.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-13-fastcard-full-surface-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- All four FastCard APIs round-trip (tests 13.a, 13.b, 13.c, 13.d).
- Overlay snapshot reflects latest action (test 13.f).
- Source URL, privacy sanitizer, document target survive handoff (tests 13.g, 13.h, 13.i).
- Overlay commands do not race with BrowserView hide/show (test 13.j).

### Per-test-case checks

- All 10 invariants observable in screencap and/or log tail.

### Required five sub-flow markers (per §9.2.3 surface-13 rule)

- Body's `## Evidence artifacts` section MUST contain 5 named markers
  `### Sub-flow 13.a`, `### Sub-flow 13.b`, `### Sub-flow 13.c`,
  `### Sub-flow 13.d`, `### Sub-flow 13.e`.
- Each sub-flow either references a separate screencap artifact OR an
  explicit time-range within a composite screencap.
- Missing any of the 5 markers makes the surface ineligible for `status: pass`.

### Mandatory 白 spot-check (per §9.4)

`bai_spotcheck` REQUIRED. 白 must reproduce at least sub-flows 13.a, 13.b,
13.e (translate, describe-image, clip — the most visual sub-flows).

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, screencap(s), `ready-browser.log`, `ready-tools.log`, `ready-directchat.log`.
- Per §9.2.1, `git_status_porcelain=0`.
- Per §9.2.2, log strictly overlaps reproduction window ± 30s.
