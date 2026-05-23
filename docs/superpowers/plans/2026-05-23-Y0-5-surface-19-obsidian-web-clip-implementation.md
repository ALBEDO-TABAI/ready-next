---
title: Stage Y0.5.19 — Obsidian web clip + current-tab clip dogfood sub-plan
stage: Y0.5.19
surface_id: 19
date: 2026-05-23
status: draft-for-baseline
parent_plan: 2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 19
operator_class: agent-with-bai-spotcheck
mandatory_bai_spotcheck: true
depends_on: Y0.1.1 disposition
---

# Surface 19 — Obsidian web clip + current-tab clip

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "From an active BrowserView tab, trigger Obsidian
  web-clip IPC; verify clipped content lands in Obsidian; trigger the
  current-tab clip IPC variant."
- **Must prove**: "Clip content shape matches Obsidian's expected payload;
  current-tab IPC does not regress per
  `src/__tests__/obsidian-web-clip-current-tab-ipc.test.ts` (listed in
  Y0.1.1 missing_helper rows; this surface depends on Y0.1.1 disposition)."

## 1. Detailed reproduction steps

1. Pre-check: Y0.1.1 disposition must be landed (the current-tab IPC test was listed in Y0.1.1 missing_helper rows). If not landed, mark `status: deferred-with-owner` (owner=Y0.1.1 owner).
2. Pre-check: Obsidian is installed and the Obsidian "Ready" plugin / URI handler is configured on 白's box.
3. Launch app; capture build commit.
4. Open a browser tab to a content-rich page (e.g. `https://en.wikipedia.org/wiki/Roman_Empire`).
5. **Web clip from active tab**: trigger the Obsidian web-clip IPC (via the right-click menu, toolbar button, or keyboard shortcut).
6. Verify Obsidian receives the clip:
   - Open Obsidian; confirm a new note appears with the clipped content.
   - Verify the clip payload shape matches Obsidian's expected schema (title, source URL, markdown body, tags).
7. **Current-tab clip variant**: trigger the current-tab clip IPC (the alternative entry point that uses the currently-active tab without dragging).
8. Verify Obsidian receives this clip as well.
9. Verify no regression of the `obsidian-web-clip-current-tab-ipc.test.ts` invariants in the live product.
10. Stop recording; capture `ready-browser.log`, `ready-tools.log`, console + screencap of both clips landing in Obsidian.

## 2. Expected result decomposition (test cases)

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 19.1 | Web clip IPC fires successfully | Step 5: tools log shows IPC sent + ack |
| 19.2 | Clip lands in Obsidian | Step 6: new note in Obsidian |
| 19.3 | Clip payload shape matches Obsidian schema | Step 6: title, source URL, markdown body, tags all present and well-formed |
| 19.4 | Current-tab IPC variant fires | Step 7: tools log shows current-tab IPC sent + ack |
| 19.5 | Current-tab clip lands in Obsidian | Step 8: new note appears |
| 19.6 | No regression vs `obsidian-web-clip-current-tab-ipc.test.ts` | Live product matches the contract test's payload-shape assertions |
| 19.7 | Privacy sanitizer applied to clip body | No raw sensitive headers/cookies in clip body (per `obsidian-web-clip-privacy-sanitizer.test.ts`) |

## 3. Pre-existing automated coverage

Extensive at the obsidian-web-clip layer:

- `src/__tests__/obsidian-web-clip-current-tab-ipc.test.ts`
- `src/__tests__/obsidian-web-clip-dragged-tab-ipc.test.ts`
- `src/__tests__/obsidian-web-clip-filename-sanitize.test.ts`
- `src/__tests__/obsidian-web-clip-image-extraction.test.ts`
- `src/__tests__/obsidian-web-clip-materialize.test.ts`
- `src/__tests__/obsidian-web-clip-pick-richer-markdown.test.ts`
- `src/__tests__/obsidian-web-clip-preset-loader.test.ts`
- `src/__tests__/obsidian-web-clip-privacy-sanitizer.test.ts`
- `src/__tests__/obsidian-web-clip-rebelmouse-gallery.test.ts`
- `src/__tests__/obsidian-web-clip-tool-registration.test.ts`

10+ obsidian-web-clip tests. The live end-to-end "clip → Obsidian receives
it" invariant requires a real Obsidian install (not stubbable); this
dogfood is the only live evidence.

## 4. Operator class

`agent-with-bai-spotcheck` — per §9.4 row "13, 19": "Obsidian web clip
needs a live Obsidian instance; only 白's box has it."

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-19-obsidian-web-clip.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-19-obsidian-web-clip-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- Clip content shape matches Obsidian's expected payload (tests 19.3, 19.7).
- Current-tab IPC does not regress per `obsidian-web-clip-current-tab-ipc.test.ts` (test 19.6).

### Per-test-case checks

- All 7 invariants observable in screencap (Obsidian receiving the note) and log tail.

### Pre-condition

- Y0.1.1 disposition must be landed; otherwise `status: deferred-with-owner`.

### Mandatory 白 spot-check (per §9.4)

`bai_spotcheck` REQUIRED. Only 白's box has a live Obsidian install with
the Ready plugin configured. Agent baseline cannot substitute.

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, screencap (showing Obsidian receiving the clip), `ready-browser.log`, `ready-tools.log`.
- Per §9.2.1, `git_status_porcelain=0`.
- Per §9.2.2, log strictly overlaps reproduction window ± 30s.
