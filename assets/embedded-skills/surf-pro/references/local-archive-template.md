# Local Archive Template

Use this folder and file structure for a Surf Pro research package.

## Recommended Folder Structure

```text
artifacts/<topic-slug>/
├── 00-research-brief.md
├── 01-mechanism-map.md
├── 02-search-query-log.md
├── 03-source-table.md
├── 04-long-term-tracking-urls.md
├── page-clips/
│   └── <source_id>.md
├── image-library/
│   └── <mechanism-slug>/
│       ├── manifest.json
│       └── originals/
├── evidence-cards/
│   └── <source_id>.md
├── reports/
│   ├── independent/
│   ├── cross-analysis.md
│   └── final-report.md
└── acceptance-index.md
```

## `00-research-brief.md`

```md
# Research Brief

- Topic:
- User request:
- Time range:
- Geography / language:
- Intended use:
- Evidence types needed:
- Local archive root:
- Research boundaries:
- Questions left open:
```

## `01-mechanism-map.md`

```md
# Mechanism Map

| mechanism_id | mechanism_name | definition | evidence_needed | suitable_sources | insufficient_sources | output_expected |
|---|---|---|---|---|---|---|
```

## `02-search-query-log.md`

```md
# Search Query Log

| round | query | tool/channel | purpose | results_kept | gaps_found | next_action |
|---|---|---|---|---|---|---|
```

## `03-source-table.md`

Use the source grading template.

## `04-long-term-tracking-urls.md`

```md
# Long-Term Tracking URLs

| url | source_name | source_grade | discovery_method | original_query | covered_mechanisms | content_type | inclusion_reason | update_rhythm | use_boundary | replacement_source |
|---|---|---|---|---|---|---|---|---|---|---|
```

## Page Clip Template

```md
# <Source Title>

- source_id:
- URL:
- source_name:
- author:
- published_at:
- accessed_at:
- source_type:
- source_grade:
- discovery_method:
- original_query:
- covered_mechanisms:
- use_status:
- copyright_or_use_boundary:

## Relevant Excerpts

> Quote or paraphrased excerpt with location/context.

## Image References

| image_url | local_path | visual_check | mechanism | status |
|---|---|---|---|---|

## Research Notes

- Why this source matters:
- What it can support:
- What it cannot support:
```

## Image Manifest Template

```json
{
  "mechanism": "",
  "image_count": 0,
  "items": [
    {
      "source_id": "",
      "source_page": "",
      "direct_image_url": "",
      "local_path": "",
      "sha256": "",
      "source_grade": "",
      "discovery_method": "",
      "visual_check": "",
      "use_status": "internal_research_only",
      "copyright_note": "External display, client delivery, commercial reuse, or training-data use requires rights review."
    }
  ]
}
```

## Evidence Card Template

```md
# Evidence Card: <source_id>

- source_id:
- mechanism:
- source_grade:
- source_url:
- source_type:
- discovery_method:
- local_clip_path:
- local_image_paths:
- evidence_status:

## What this supports

## Evidence

## Visual / Text Check

## Limits

## Copyright / Use Boundary
```
