---
name: surf-pro
description: 围绕专题开展网页调研并建立可追溯的本地资料库；用于多源证据归档与研究报告，不用于单次事实查询或单页阅读。
category: analysis
symbolName: magnifyingglass.circle.fill
seedVersion: 1
---

# Surf Pro

Use this skill to turn a broad search or research request into a professional, evidence-backed local archive: source map, URL list, image library, text clips, source grading, stop-search criteria, and reports.

The core principle is: **do not start by collecting random links**. Start by decomposing the topic into mechanisms, dimensions, or evidence needs; then search for sources that cover those needs; then archive traceable text/images locally; then write conclusions only from accepted evidence.

## Trigger

Use this skill for a topic-level research package with traceable sources and local archiving. A single fact lookup, reading one article, or collecting a few links does not need this workflow. Include a tracking list only when the user requests ongoing source tracking; creating a list does not schedule monitoring.

Examples:

- “搜集近十年高定服装的搭配理论、优秀作品和图文案例。”
- “帮我找某个护肤成分的海外讨论、竞品表达和高质量资料源。”
- “建立一个关于直播间空间设计的参考网址、图片和案例资料库。”
- “找某个品牌近几季 campaign 的视觉资料，并长期追踪。”

## Output Promise

A good Surf Pro run produces a local, auditable research package, not only a chat answer.

Choose deliverables that serve the requested package; scope, traceable evidence and findings are required, while image archives and tracking plans depend on the task:

1. Research scope and mechanism map.
2. Search query matrix and discovery log.
3. Graded source table.
4. Long-term tracking URL list with discovery method and inclusion reason.
5. Local text clips / page clips where accessible.
6. Local image archive when the task involves visuals.
7. Evidence cards or source notes that connect claims to source URLs and local files.
8. Report(s) that separate facts, interpretation, uncertainty, and next steps.
9. Stop-search assessment explaining why the first round is enough, or what remains thin.

## Operating Flow

### 1. Clarify the research unit without over-asking

If the user already gave a clear topic, move. Ask at most one question only when the answer changes the search universe, such as time range, geography, language, platform, or intended use.

If unclear, choose a practical default and state it in the research scope.

Define:

- Topic.
- Time range.
- Region / language.
- Use case: internal research, client report, creative reference, training, trend tracking, competitive scan, etc.
- Evidence type needed: URL, article text, images, video references, comments, official pages, forums, academic sources, retail pages, social posts.
- Local storage root under the owning department’s `artifacts/` or `tmp/` directory.

### 2. Build a mechanism map before searching

Identify the dimensions needed to answer the research question. Let the topic and evidence determine their number; do not pad a small task to meet a quota.

A mechanism can be:

- A theory / style / framework.
- A product category or use scenario.
- A user motivation or pain point.
- A visual relationship: proportion, material, color, gesture, layout, scene, lighting.
- A platform behavior or content pattern.
- A risk / anti-pattern.

For each mechanism, define:

- What evidence would prove it.
- What source types are suitable.
- What source types are insufficient.
- What local files should be collected.

Example for fashion styling:

| Mechanism | Evidence needed | Suitable sources | Insufficient sources |
|---|---|---|---|
| 纵向雕塑身体 | runway looks + review + image details | Vogue Runway, The Impression, brand official runway | Pinterest reposts, unloaded screenshots |
| 日常低重心身体 | street style + campaign + real-use body scene | Vogue street style, brand lookbook, The Impression | flat-lay e-commerce only |
| 平台模板风险 | repeated generic platform visuals | trend articles, social screenshots with context, content platform examples | a single disliked image |

### 3. Create a search-source strategy

Choose the discovery routes needed for coverage; add another when it resolves an evidence gap:

1. **Seed authority sources**: start from known authoritative sources in the domain.
   - Fashion examples: Vogue Runway, The Impression, SHOWstudio, WWD, BoF, official brand collection/lookbook/campaign pages.
   - Beauty examples: brand official, retailer ingredient pages, dermatologist/clinical sources, Vogue Business/BoF/Glossy/BeautyMatter, regulatory/academic sources.
   - Culture/social examples: official platforms, public forums, trade media, creator pages, review communities.
2. **Mechanism queries**: search `mechanism + brand/category + source type + year/season/platform`.
3. **Source-page reverse tracing**: when an image or quote is useful, trace back from direct asset URL or repost to original source page.
4. **Gap-driven search**: when a mechanism is thin, search for substitute brands, adjacent cases, official pages, or higher-quality commentary.

Record the original query or discovery method for every source kept.

### 4. Grade sources before relying on them

Grade each source, and do not let low-grade sources carry core conclusions.

Default grading:

- **A — Core authority**: official source, recognized professional archive, deep industry media, academic/regulatory source, high-signal primary data.
- **B — Strong support**: brand-owned pages, specialist blogs with traceable evidence, campaign/lookbook pages, high-quality interviews, professional newsletters.
- **C — Auxiliary**: retail pages, shallow trend lists, image galleries, social posts with limited context, useful only for signals or examples.
- **D — Reject / do not cite**: unloaded screenshots, access denied, cookie/loading pages, no source attribution, repost-only images, SEO spam, broken pages, hallucinated or unverifiable references.

A conclusion can be considered stable only when it has either:

- One A source plus supporting image/text evidence, or
- Two or more independent B sources plus traceable local evidence, or
- A clearly labeled exploratory status if evidence is thinner.

### 5. Archive locally with traceability

Create a topic folder under the appropriate department or workspace artifact path.
Use `references/local-archive-template.md` for the full folder and file templates.

For every saved image, preserve:

- `source_url` or `source_page`.
- `direct_image_url` if available.
- `local_path`.
- `mechanism`.
- `source_grade`.
- `discovery_method`.
- `visual_check`.
- `copyright_note`.
- `sha256` if possible.

For every clipped page, preserve:

- URL.
- Title.
- Publisher / author when visible.
- Publish date when visible.
- Access date.
- Key text excerpt.
- Relevant images count / local image links.
- Source grade.
- Mechanism coverage.
- Use boundary.

### 6. Build the long-term tracking URL list as a system, not a link dump

Every URL in the long-term list should include URL, source name, grade, discovery method, original query, covered mechanisms, content type, inclusion reason, update rhythm, use boundary, and replacement/adjacent source.

A long-term URL should usually be an archive, column, brand collection path, campaign hub, forum search, or repeatable source path — not only a single article. Single articles can be evidence cards, but they are not always long-term tracking entries.

### 7. Stop searching only when coverage and saturation are visible

Do not stop because the list “feels enough”. Stop when the stop table is satisfied.

Stop when the agreed questions have supporting evidence, requested archived assets are traceable, and remaining uncertainty is explicit. Require recurring URLs only for a tracking task. Expand search for a concrete unresolved question; do not add rounds once the requested coverage is satisfied.

If these are not satisfied, do not call the research complete. Mark gaps explicitly.

### 8. Write reports only after evidence exists

Do not produce final analysis from source titles or screenshots alone.

A good report includes:

- Scope and method.
- Mechanism map.
- Source grading summary.
- Evidence coverage table.
- Findings by mechanism.
- Cross-analysis.
- What changed after image/text evidence review.
- Long-term tracking plan.
- Evidence limits and copyright boundaries.
- Next update path.

Separate:

- Facts directly supported by evidence.
- Interpretation.
- Low-confidence hypotheses.
- Excluded sources and why.

### 9. Handle visual research carefully

For visual topics, screenshots of unloaded webpages are not evidence.

Acceptable visual evidence:

- Original images from source page or traceable media assets.
- Fully loaded page screenshots with visible relevant visual content and URL.
- Official lookbook / campaign / runway images.
- Professional media image galleries with source context.
- Locally saved files mapped to source URL and mechanism.

Reject or downgrade:

- Homepage screenshots.
- Cookie / loading / access denied pages.
- Pinterest-only reposts.
- Unattributed social reposts.
- Cropped image with no source page.
- E-commerce flat-lay when the mechanism requires body/scene/styling.

### 10. Use browser and web tools appropriately

Use the environment's available browser tools when the task requires interaction, visual inspection, scrolling, lazy-loaded images, or screenshots. Follow their actual instructions; do not require an unavailable `browser-v2` skill.

Use WebSearch/WebFetch or local scripts when they are enough for source discovery, metadata extraction, and text clipping.

For private/authenticated sources, use available authenticated tools within the user's existing request and authorization. Ask only when access or the intended use is not yet authorized; never infer permission to publish from permission to read.

### 11. Final acceptance index

End with an acceptance index that lists:

- Files created.
- Source counts by grade.
- Mechanism coverage counts.
- Local image/text counts.
- Long-term tracking URL counts.
- Known gaps.
- Rejected source types.
- Stop-search judgment.
- Copyright / external use boundary.
- Recommended next update date or trigger.

## Common Failure Modes

- Collecting many links before defining mechanisms.
- Treating one good image as a theory.
- Writing final reports before images/text are actually inspected.
- Keeping Pinterest, SEO pages, or unloaded screenshots as core proof.
- Long-term URL list contains one-off articles only.
- Image library exists but reports do not change after visual review.
- Source table has URLs but no discovery method or inclusion reason.
- Stopping because of time, not because coverage/saturation is achieved.

## Compact User-Facing Summary Pattern

When reporting progress, say:

```text
我会先把主题拆成机制/证据桶，再按权威种子源、机制关键词、来源反查和缺口补采四条路径找资料。最终会本地收录网址、图片、文本剪藏和证据卡，并用来源分级与停止搜索表判断这一轮是否够完整。
```
