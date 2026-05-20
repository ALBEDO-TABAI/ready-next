---
name: image-analysis-router
description: Route image-heavy requests into the correct critique workflow, then produce a targeted analysis plus study report. Use when Ready receives one or more images and the user wants structured analysis, style classification, critique, or learning notes for posters, brand graphics, UI screenshots, paintings, illustrations, photographs, interior design photos or renders, building exteriors or urban scenes, infographics or diagrams, product or industrial design images, comics or sequential pages, fashion or styling visuals, sculpture or installation works, game visuals, scientific or medical images, typography-led pieces, presentation/report pages, movie stills, storyboard frames, or mixed visual sets. Trigger on requests such as "分析这张图", "拆一下这组海报", "看看这张摄影作品怎么学", "鉴赏这幅画", "分析这个空间图", "看看这个建筑立面", "拆这个信息图", "分析这个产品外观", "读一下这页漫画", "看看这套穿搭", "分析这个游戏界面", "看看这个医学图", "拆这个字体海报", "帮我看这页PPT", or any case where a generic image summary would be too shallow.
---

# Image Analysis Router

Use this skill when the main challenge is not "describe the image" but "pick the right way to read the image first."

## Expected Input

This skill expects image evidence plus a visual-analysis goal.

- Accept: local image paths, image attachments, screenshots, filenames, OCR hints, source note path, source URLs, and user goal.
- Do not accept raw text-only study material as an image job; that belongs to `study-notes` after extraction.
- `universal-fallback` is a named first-principles route for uncategorizable visuals, not a silent failure fallback.

## Read in order

- Read [references/route-matrix.md](./references/route-matrix.md) first.
- Read [references/output-contract.md](./references/output-contract.md) before drafting the final answer.
- If the script or visual read indicates a batch, read [references/method-batch-handling.md](./references/method-batch-handling.md).
- If the image may be AI-generated or the user asks about generation, read [references/_ai-content-check.md](./references/_ai-content-check.md).
- Read only the route file(s) named in [references/route-matrix.md](./references/route-matrix.md).

## Workflow

1. Gather the user's goal, image count, file names, and any supplied context.
2. If prompt text or file names are available, run:
   - `python3 scripts/route_image_request.py --prompt "<user request>" --file "<name-or-path>" --hint "<ocr-or-caption>"`
   - Add `--quiet` to suppress route_scores/focus_scores/image_routes when only the decision is needed.
3. Treat the script output as a routing prior, not final truth.
4. Read the script status before route selection:
   - `visual_input_missing`: stop and ask upstream for image evidence.
   - `visual_evidence_insufficient`: do not force a route; state what is readable and what blocks analysis.
   - `needs_clarification`: ask one clarifying question using the script's route and focus options.
   - `ok`: continue.
5. Visually inspect at least one representative image before locking the route. If visual inspection conflicts with the script, follow the image and state the override reason briefly.
6. Pick one primary route per image or subgroup. If the batch is mixed, split it instead of forcing one lens onto everything.
7. State both route and intent confidence:
   - `high`: dominant route clearly matches both visual evidence and user goal
   - `medium`: one route leads, but a second route is plausible
   - `low`: hybrid, under-specified, or missing context
   - If `intent_confidence` is low AND the goal would change the report, ask one clarifying question first.
   - If `route_confidence` is low because all scores are weak, use `universal-fallback` only when evidence is still readable.
   - If `route_confidence` is low because several strong routes tie, use `generic-mixed` and split the route-specific layers.
8. Load only the method file(s) needed for the chosen route.
9. Follow the script's `response_depth`:
   - `quick`: short answer, no full Study Report unless learning intent is explicit.
   - `standard`: Analysis Report plus brief Study Report.
   - `deep`: full Analysis Report plus full Study Report.

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

When the script returns a blocking status, return the canonical JSON object below (or the equivalent text block). Do NOT continue to a normal Analysis Report.

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

## UI Screenshot Handling

Until a dedicated `ui-product` route exists, route standalone UI screenshots (app screens, web dashboards, settings panels) to `graphic-design` AND emphasize these four extra dimensions in the report:

1. **Information density**: how many things compete for attention; foreground vs background.
2. **State clarity**: empty / loading / error / success states; affordance signals.
3. **Interaction cues**: tappable / hoverable / disabled visual differentiation.
4. **Hierarchy resilience**: does the layout still work at smaller widths / accessibility scaling?

Do NOT use `presentation-document` for live UI screens; that route is for slide / report layouts.

## Routing matrix (compact)

| Route | Dominant signal |
| --- | --- |
| `graphic-design` | Typography, layout, branding, CTA, hierarchy, packaging, poster, image-text composition |
| `photography` | Camera capture, lens behavior, exposure, depth, realism, documentary truth |
| `painting-illustration` | Painted, drawn, stylized, symbolic, art-historical, iconography |
| `interior-design` | Space, zoning, furniture, materials, atmosphere, lighting, circulation |
| `architecture-urban` | Massing, facade, site, public realm, skyline, streetscape, landscape integration |
| `infographic-diagram` | Chart, process diagram, map, flow graphic, system schematic |
| `product-industrial-design` | Object, device, packaging, prototype, form / usability / manufacturability |
| `comics-sequential` | Comic page, manga, webtoon, strip, panel order, narrative pacing |
| `fashion-styling` | Clothing, silhouette, layering, accessories, runway/editorial/personal styling |
| `sculpture-installation-craft` | 3D artwork, material assembly, site-specific installation, volume / presence |
| `game-visual-design` | Game screenshot, HUD, character sheet, scene tied to gameplay |
| `scientific-medical-imaging` | Diagnostic, scientific, microscopic, radiologic — interpretability / annotation |
| `typography-lettering` | Lettering, logotypes, calligraphy, type posters, wordmarks |
| `presentation-document` | Slide, report page, proposal page, dashboard, document spread |
| `film-frame` | Movie still, animation frame, storyboard, cinematic composition |
| `generic-mixed` | Image doesn't cleanly fit any single route or batch mixes domains |
| `universal-fallback` | None match strongly enough but a structured first-principles read is still useful |

Tiebreakers: a movie poster goes to `graphic-design`; raw frame inside → `film-frame` only if user wants cinematic analysis. Building image judged as photo → `photography`; judged for facade/site → `architecture-urban`. Product image as ad/ecommerce → `graphic-design`; as form/ergonomics → `product-industrial-design`.

## Guardrails

- Do not pretend certainty when the route is ambiguous.
- Do not use `universal-fallback` when the image is missing or unreadable; use `visual_input_missing` or `visual_evidence_insufficient`.
- Do not judge paintings with poster/ad standards unless explicitly asked.
- Do not treat documentary photography as pure aesthetics when ethics/context/truthfulness are part of the request.
- Do not infer hidden generation workflows for AI art without visible evidence.
- If scientific or medical evidence appears, avoid diagnostic conclusions even when primary route is not `scientific-medical-imaging`.
- Do not over-read narrative meaning from a single still frame.
- Do not collapse mixed batches into a single verdict when items serve different roles.

## Batch handling

- Same-project batch: analyze individual quality and set-level consistency.
- Before/after: isolate what improved, what regressed, what still blocks the target.
- Mood boards / reference packs: look for repeated signals, don't over-critique one image.
- Subject-vs-reference: name the subject first, use references as anchors.
- Two-image: compact A/B diff. More than five: group before analyzing.

## Recommended response pattern

Follow [references/output-contract.md](./references/output-contract.md). At minimum, the final answer should include:

1. Route decision and confidence
2. Why that route fits
3. The route-specific analysis
4. A concrete study report with drills or next-step practice — omit only when `response_depth: quick` AND `study_report_mode: none`, in which case mark the answer "quick read only" and offer to expand on request.
