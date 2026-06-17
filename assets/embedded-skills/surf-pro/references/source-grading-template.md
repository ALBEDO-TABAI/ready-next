# Source Grading Template

Use this template to grade every source before using it as evidence.

## Source Table Columns

| source_id | title | url | source_name | source_type | source_grade | discovery_method | original_query | covered_mechanisms | evidence_type | key_excerpt_or_visual | local_clip_path | local_image_paths | use_status | copyright_or_use_boundary | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

## Source Grades

### A — Core authority

Use for core conclusions.

Typical sources:

- Official brand / institution / regulatory / academic sources.
- Recognized professional archive or industry media.
- Deep original reporting or professional review.
- Primary datasets, public filings, official documentation.

Requirements:

- Clear publisher/source identity.
- Traceable URL.
- Relevant text/image evidence.
- Date or temporal context when relevant.
- Not a repost-only page.

### B — Strong support

Use as support or mechanism calibration.

Typical sources:

- Brand-owned lookbook/campaign/product pages.
- Specialist blogs/newsletters with strong traceability.
- Interviews, campaign pages, image galleries with source context.
- High-quality public forum threads with visible discussion context.

Requirements:

- Source identity is clear.
- Evidence is relevant.
- Some context exists, even if not deeply analytical.

### C — Auxiliary signal

Use only as secondary signal, examples, or weak trend indicators.

Typical sources:

- Retail/e-commerce pages.
- Shallow trend listicles.
- Social posts with limited context.
- Image galleries without deep explanation but with traceable source.

Do not use C sources as sole proof for a major conclusion.

### D — Reject / do not cite

Do not use as proof.

Examples:

- Unloaded pages.
- Cookie/loading/access denied screenshots.
- Broken URLs.
- Pinterest/Tumblr/repost-only images without original source.
- SEO spam.
- No publisher/source identity.
- Hallucinated or unverifiable references.

## Discovery Methods

Use one of:

- `seed_authority_source`
- `mechanism_query`
- `source_page_reverse_tracing`
- `gap_fill_search`
- `official_archive_navigation`
- `forum_or_social_search`
- `user_provided_source`

## Use Status

Use one of:

- `core_evidence`
- `supporting_evidence`
- `long_term_tracking`
- `auxiliary_signal`
- `rejected`
- `needs_manual_review`

## Copyright / Use Boundary Examples

- `internal_research_only; external display requires rights review`
- `text summary can be cited with URL; images require separate permission`
- `official source; still verify commercial reuse rights`
- `public forum content; anonymize user comments if used externally`
