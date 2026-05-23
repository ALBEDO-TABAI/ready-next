---
title: Stage Y0.5.05 — Document widgets (A-G + freeform) dogfood sub-plan
stage: Y0.5.05
surface_id: 5
date: 2026-05-23
status: draft-for-baseline
parent_plan: 2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 5
operator_class: agent-only
---

# Surface 05 — Document widgets (A–G + freeform)

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "Fixed fixtures: trigger each of widgets A–G with the
  canonical prompt per
  `docs/superpowers/plans/2026-04-30-D-*-implementation.md` (A=summary,
  B=todo, C=quote, D=table, E=code, F=diagram, G=image-caption); plus one
  H1/H2 freeform trigger using the exact phrase '把这段写成醒目的标题卡' (per
  CLAUDE.md §4 trigger-word note). (Codex r2 should-fix #4: was 'A-G
  skeletons plus one H1/H2' without specifying prompts.)"
- **Must prove**: "Each of A–G renders the matching widget type (not silent
  fallback to plain text); H1/H2 freeform triggers freeform widget only on
  the trigger phrase; target attachment from one widget does not leak into
  the next question's context."

## 1. Detailed reproduction steps

1. **Fixture prep**: open a fresh markdown doc at `/tmp/ready-y0-5-fixture/docs/widgets.md` with seed body:
   ```
   # Widget surface fixture

   The Roman Empire fell in 476 AD after a long decline.
   ```
2. Launch app; switch to `document` mode; open the fixture doc. Capture build commit.
3. **A=summary**: select the seed paragraph; trigger the widget prompt for summary (canonical prompt per `docs/superpowers/plans/2026-04-30-D-reminder-registry-compaction-hooks-implementation.md`). Verify summary widget renders.
4. **B=todo**: ask the agent to "把这段拆成待办清单". Verify a todo widget (checkbox list) renders.
5. **C=quote**: ask "把第二句变成引用块". Verify a quote widget renders.
6. **D=table**: ask "把罗马衰落原因列成对照表". Verify a table widget renders.
7. **E=code**: ask "用 Python 写一段斐波那契函数". Verify a code widget with syntax highlight renders.
8. **F=diagram**: ask "用流程图画一下因果链". Verify a diagram widget renders (mermaid/svg/equivalent).
9. **G=image-caption**: drop a sample image (or `@[image.png]` attach) and ask "给这张图配一段说明". Verify an image-caption widget renders.
10. **H1/H2 freeform — POSITIVE trigger**: select the title line; ask EXACTLY: `把这段写成醒目的标题卡`. Verify freeform widget renders.
11. **H1/H2 freeform — NEGATIVE trigger**: paraphrase as `帮我把标题写得醒目一点` (NOT the trigger phrase). Verify it falls back to A–G skeleton (not freeform).
12. **Context isolation**: after step 9 (image attached), ask step 10 immediately. Verify the image attachment from step 9 does NOT leak into step 10's context (per CLAUDE.md §4 multi-target rule).
13. Stop recording; capture `ready-directchat.log` + `ready-tools.log`.

## 2. Expected result decomposition (test cases)

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 5.1 | Widget A renders summary type | Step 3: widget mounts with summary skeleton |
| 5.2 | Widget B renders todo type | Step 4: checkbox list widget |
| 5.3 | Widget C renders quote type | Step 5: quote widget |
| 5.4 | Widget D renders table type | Step 6: table widget |
| 5.5 | Widget E renders code type | Step 7: code widget with language tag |
| 5.6 | Widget F renders diagram type | Step 8: diagram widget |
| 5.7 | Widget G renders image-caption type | Step 9: image + caption widget |
| 5.8 | No silent fallback to plain text | None of steps 3–9 produce a plain markdown paragraph instead of the expected widget |
| 5.9 | Freeform triggered only by exact phrase | Step 10 yields freeform; step 11 does NOT |
| 5.10 | Attachment scope does not leak across asks | Step 12: step-10 task context does not reference step-9 image (verifiable in tools log) |

## 3. Pre-existing automated coverage

Partial coverage at the widget pipeline layer:

- `src/__tests__/document-task-pipeline-widget-fallback.test.ts`
- `src/__tests__/document-task-pipeline-widget-prompt.test.ts`
- `src/__tests__/document-task-pipeline-widget-reprompt.test.ts`
- `src/__tests__/document-widget-skeleton-mapping.test.ts`

The pipeline tests cover the prompt → widget-type classifier. The
trigger-phrase exact-match for freeform and the attachment-context-leak
invariant (5.9, 5.10) are NOT automated; this dogfood adds the live proof.

## 4. Operator class

`agent-only` — per §9.4 row "1, 4, 5, 8, 14, 15".

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-05-document-widgets.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-05-document-widgets-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- Each of A–G renders the matching widget type (tests 5.1–5.7) and no silent fallback (test 5.8).
- H1/H2 freeform triggered only on exact trigger phrase (test 5.9).
- Attachment from one widget does not leak to next (test 5.10).

### Per-test-case checks

- All 10 invariants observable in screencap and/or `ready-directchat.log`.

### Operator-class enforcement (per §9.4)

- `operator_class: agent-only`. `bai_spotcheck` NOT required.

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, screencap, `ready-directchat.log`, `ready-tools.log`.
- Per §9.2.1, `git_status_porcelain=0`.
- Per §9.2.2, log strictly overlaps reproduction window ± 30s.
