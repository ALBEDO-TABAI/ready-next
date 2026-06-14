# Output Contract

Default to two artifacts when the request is `standard` or `deep`:

1. `Analysis Report`
2. `Study Report`

For `quick`, return a compact answer and omit the full Study Report unless the user explicitly wants learning guidance.

## Language

Write the report in the user's language, including section headings (for Chinese requests, e.g. 快速解读 / 详细分析 / 总体判断 / 学习报告). Keep machine-facing identifiers — route names, status values, confidence levels — in their English code form.

## 0. Blocking States

Do not produce a normal report when the script or visual inspection returns a blocking state.

- `visual_input_missing`: ask for image evidence. Do not route.
- `visual_evidence_insufficient`: state what can be seen, what is blocked, and what image evidence is needed.
- `needs_clarification`: ask one question using the strongest route and focus options.

## 1. Route Decision

Open with:

- chosen route
- status
- route confidence and intent confidence
- response depth
- one short reason tied to visible evidence and the user's goal

If the image is a single frame, render, or cropped detail, note that limitation early.

## Evidence Tone

Keep certainty visible in the wording:

- Directly visible facts: write normally.
- Strong inferences: use "looks like", "this suggests", "从 X 可以读出", or "看起来像".
- Weak hypotheses: use "可能", "或许", or "一种可能的读法是".

Any technical claim about lens, lighting setup, material, rendering pipeline, AI generation, data validity, or medical/scientific meaning must use this tone rule.

## AI Content Check

AI-content checks are cross-route and only calibrate certainty. They do not change the primary route by themselves.

Mention AI generation only when the user asks about it or visible evidence supports it, such as:

- broken or inconsistent text rendering
- hand, edge, or local anatomy anomalies
- repeated textures or overly smooth reflections
- object boundaries that do not resolve across the image
- local semantic conflicts inside one object or scene

Do not state that an image is AI-generated as fact unless the source or user provided that fact.

## Scientific and Medical Safety

Scientific or medical evidence is evidence-bound, not route-bound.

- If the primary route is `scientific-medical-imaging`, open the analysis by saying it is a visual/evidence read, not a diagnosis.
- If medical or scientific imagery appears inside a poster, ad, slide, or graphic-design artifact, still avoid diagnostic conclusions.
- Use cautious language around "healthy", "disease", "malignant", "abnormal", or equivalent conclusions.
- Recommend qualified professional confirmation when the user is asking for scientific or medical interpretation.

## 2. Analysis Report

Start with a short digest, then expand.

Recommended structure:

- `Quick Read`: 3-5 concise findings
- `Detailed Analysis`: use the route-specific dimensions from the chosen method file
- `Overall Judgment`: what works, what weakens the image, and what the image is trying to do

Rules:

- Tie every important claim to visible evidence.
- Prefer plain language over theory names unless the theory genuinely improves clarity.
- If the user asked for comparison, explicitly separate shared traits from differences.
- If the route confidence is not high, keep the judgment proportional.

### Detailed Analysis coverage

The chosen method file is the single source for section structure. Cover its `Core lenses` / analysis-order sections whenever the evidence allows, and keep its `Evidence ladder` separation (fact vs inference vs hypothesis) visible in the wording.

- For `generic-mixed` and `universal-fallback`, follow the triage-first structure in their method files: name the top route and runner-up, run the universal four-step read, and say what extra context would sharpen the route.
- When the evidence cannot support a lens, say so instead of skipping it silently.

A compact sample report skeleton lives in [examples.md](./examples.md#sample-report-skeleton).

## 3. Study Report

Convert the critique into a learning plan.

Use the router's focus scores:

- learning focus strong: keep a full Study Report.
- commercial focus strong: prioritize effectiveness and keep Study brief unless asked to learn.
- technical focus strong: make drills concrete and keep evidence language cautious.

Include:

- `What to Learn Now`: 2-4 concepts or habits
- `Practice Drills`: 2-3 concrete exercises
- `What to Watch For Next Time`: repeated failure modes or blind spots
- `Suggested Comparisons`: optional; mention only when the image clearly points toward a useful reference direction

The study report should help the user do something next, not just understand the critique.

Each drill must include:

- what to do
- how to do it
- what counts as finished

## Batch rules

- For a same-series batch, include set-level consistency.
- For before/after or versioned work, explain exactly what changed.
- For mixed batches, segment the report by subgroup instead of flattening everything.
- For subject-vs-reference, keep the subject image as the evaluated object and use references as anchors only.
- For two images, use a compact A/B difference read. For 3-5 images, use the standard batch shape. For more than 5 images, group first and keep groups to five or fewer.

Use this shape for mixed batches:

```markdown
## Batch Report

### Subgroup A: <route> (images <numbers-or-names>)
#### Analysis Report
#### Study Report

### Subgroup B: <route> (images <numbers-or-names>)
#### Analysis Report
#### Study Report

### Cross-batch synthesis
```
