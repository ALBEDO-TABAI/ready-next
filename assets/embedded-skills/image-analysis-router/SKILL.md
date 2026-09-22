---
name: image-analysis-router
description: 按图像类型选择专业分析方法；用于用户未指定分析框架的视觉评析或学习拆解，不用于普通截图问答。
---

# Image Analysis Router

Use this skill when the main challenge is not "describe the image" but "pick the right way to read the image first."

## Expected Input

This skill expects image evidence plus a visual-analysis goal.

- Accept: local image paths, image attachments, screenshots, filenames, OCR hints, source note path, source URLs, and user goal.
- Do not create the upstream source note here. When called by another skill that owns a source note, treat `source_note_path` as owned by that caller.
- Do not accept raw text-only study material as an image job; that belongs to `study-notes` after extraction.
- `universal-fallback` is a named first-principles route for uncategorizable visuals, not a silent failure fallback.

## Read in order

Resolve `scripts/` paths from this skill's directory, using `$CLAUDE_SKILL_DIR` when the host provides it; do not rely on the workspace's current directory. Script availability does not grant execution permission.

- Read [references/route-matrix.md](./references/route-matrix.md) first.
- Read [references/output-contract.md](./references/output-contract.md) before drafting the final answer.
- If the script or visual read indicates a batch, read [references/method-batch-handling.md](./references/method-batch-handling.md).
- If the image may be AI-generated or the user asks about generation, read [references/_ai-content-check.md](./references/_ai-content-check.md).
- If two routes stay plausible after visual inspection, read [references/examples.md](./references/examples.md) for worked tie-break examples.
- Read only the route file(s) named in [references/route-matrix.md](./references/route-matrix.md).
- When `response_depth` is `quick`, the route-specific sections of [references/output-contract.md](./references/output-contract.md) can be skimmed; blocking states, evidence tone, and safety rules always apply.

## Workflow

1. Gather the user's goal, image count, file names, and any supplied context.
2. When the local script is available and authorized, use it for an ambiguous route; otherwise route from the visible image and user goal:
   - `python3 scripts/route_image_request.py --prompt "<user request>" --file "<name-or-path>" --hint "<ocr-or-caption>" --source-url "<url>"`
   - Windows compatible: `py .\scripts\route_image_request.py ...`
   - Add `--quiet` to suppress route_scores/focus_scores/image_routes when only the decision is needed.
3. Treat the script output as a routing prior, not final truth.
4. Read the script status before route selection:
   - `visual_input_missing`: if you can already see the image(s) directly in the conversation, this status is moot — pass the attachment via `--file`, note it via `--hint "image attached"`, or simply proceed with visual routing. Only when you genuinely have no image evidence: stop and ask upstream for it.
   - `visual_evidence_insufficient`: do not force a route; state what is readable and what blocks analysis. Confirm against the actual image — the script infers this from the prompt wording.
   - `needs_clarification`: check the actual image and conversation first. Ask only if missing user intent would materially change the report; a keyword-script result alone does not block the task.
   - `router_unavailable` (or the script errors): proceed with visual-only routing and note that the keyword prior was unavailable.
   - `ok`: continue.
5. Visually inspect at least one representative image before locking the route. If visual inspection conflicts with the script, follow the image and state the override reason briefly.
6. Pick one primary route per image or subgroup. If the batch is mixed, split it instead of forcing one lens onto everything.
7. State both route and intent confidence:
   - `high`: the dominant route clearly matches both the visual evidence and the user's goal
   - `medium`: one route leads, but a second route is plausible
   - `low`: the image is hybrid, under-specified, or the file is missing enough context
   - If `intent_confidence` is low and the user's goal would change the report, ask one clarifying question before producing the full report.
   - If `route_confidence` is low because all route scores are weak, use `universal-fallback` only when the visual evidence is still readable.
   - If `route_confidence` is low because several strong routes tie, use `generic-mixed` and split the route-specific layers.
8. Load only the method file(s) needed for the chosen route.
9. Follow the script's `response_depth` as a default, not a verdict:
   - `quick`: short answer, no full Study Report unless learning intent is explicit.
   - `standard`: Analysis Report plus brief Study Report.
   - `deep`: full Analysis Report plus full Study Report.
   - Override the depth when the visible request clearly contradicts it — e.g. a short prompt that names specific dimensions deserves at least `standard`, and an explicit ask for depth in any language deserves `deep`. Record the override as `depth_override` in `处理说明` (same shape as `route_override`).

## Routing Override Record

If visual inspection contradicts the script's `top_route`, record the override in the final answer's `处理说明` (only shown when the user asks for it):

```text
route_override:
  from: <script top_route>
  to: <visual route>
  reason: <one sentence tied to visible evidence>
```

If `route_confidence` or `intent_confidence` is `low`, also surface `route_confidence`, `route_runner_up`, and `route_decision` fields in `处理说明`.

## Status Schema

When actual image inspection and context confirm a blocking status, return the canonical JSON object below (or the equivalent text block). Do not produce a normal report without the missing evidence. A script status overridden by real evidence is not a blocker.

```json
{
  "status": "visual_input_missing" | "visual_evidence_insufficient" | "needs_clarification",
  "modality": "image",
  "blocked_step": "route" | "analysis",
  "blocked_reason": "<one sentence>",
  "suggested_action": "<concrete next step for the upstream caller>",
  "clarification_options": {"routes": [...], "focuses": [...]}
}
```

`clarification_options.routes` MUST only contain routes that scored above zero. Empty arrays are valid.

## Routing rules

The full signal table, tie-breakers, and batch type rules live in [references/route-matrix.md](./references/route-matrix.md); worked examples for high-drift calls live in [references/examples.md](./references/examples.md). Do not re-derive routing criteria here.

Two principles override everything in the table:

- If one image straddles multiple routes, choose based on what the user is actually trying to learn. Example: a movie poster usually goes to `graphic-design`; the raw frame inside that poster goes to `film-frame` only if the user wants cinematic analysis.
- If none of the named routes fits well, use `universal-fallback` rather than forcing a bad match. It is a real route and must still produce a layered analysis and study report.

## Guardrails

- Do not pretend certainty when the route is ambiguous.
- Do not use `universal-fallback` when the image is missing or unreadable; use `visual_input_missing` or `visual_evidence_insufficient`.
- Do not judge paintings with poster or ad-performance standards unless the user explicitly asks for commercial translation.
- Do not treat documentary or journalistic photography as pure aesthetics when ethics, context, or truthfulness are part of the request.
- Do not infer hidden generation workflows for AI art unless visible evidence supports the claim; use `_ai-content-check.md` to calibrate uncertainty.
- If scientific or medical evidence appears anywhere in the image, avoid diagnostic conclusions even when the primary route is not `scientific-medical-imaging`.
- Do not over-read narrative meaning from a single still frame; state the missing motion, sound, or sequence context.
- Do not collapse mixed batches into a single verdict when the images clearly serve different roles.

## Batch handling

- For a same-project batch, analyze both individual quality and set-level consistency.
- For before/after batches, isolate what improved, what regressed, and what still blocks the target result.
- For mood boards or reference packs, look for repeated signals instead of over-critiquing one image in isolation.
- For subject-vs-reference batches, name the subject image first and use references only as anchors.
- For two-image batches, use a compact A/B difference read; for more than five images, group before analyzing.

## Recommended response pattern

Follow [references/output-contract.md](./references/output-contract.md).

At minimum, the final answer should include:

1. route decision and confidence
2. why that route fits
3. the route-specific analysis
4. a concrete study report with drills or next-step practice — **omit only when `response_depth: quick` AND `study_report_mode: none`**, in which case mark the answer "quick read only" and offer to expand on request
