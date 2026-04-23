# Original Prompt Full Replacement Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewire audiovisual report generation so supported routes use the original `chart/file-Prompt` prompts as the main body-generation source, removing only low-value sections while preserving the existing report shell and fallback behavior.

**Architecture:** Add a dedicated raw-prompt adapter layer that maps route types to original prompts, strips non-runtime sections, converts modules into required report headings, and feeds the model a much richer storyboard packet. Keep the current template engine as the outer assembler and as the fallback path for un-migrated or unsupported types.

**Tech Stack:** Python, pytest, markdown templates, existing report builder/runtime

---

## Chunk 1: Lock Raw Prompt Adapter Behavior In Tests

### Task 1: Add failing unit tests for prompt mapping, sanitizing, and heading extraction

**Files:**
- Create: `tests/test_audiovisual_raw_prompt_adapter.py`
- Modify: `tests/test_audiovisual_template_engine.py`

- [ ] **Step 1: Write a failing test file for raw prompt path selection**

Cover:
- Batch 1 `type_key -> raw prompt file` resolution
- missing mapping fallback behavior

- [ ] **Step 2: Write failing tests for prompt sanitizing**

Assert the sanitized raw prompt:
- keeps `SYSTEM ROLE`
- keeps `ANALYSIS PIPELINE`
- removes `THEORETICAL ANCHORS`
- removes `INPUT FORMAT`
- removes `REFERENCES`

- [ ] **Step 3: Write failing tests for module heading extraction**

Assert that:
- `### MODULE N — Xxx` becomes required output section `## Xxx`
- Batch 1 prompts expose the expected section count

- [ ] **Step 4: Run focused pytest to verify the new tests fail for the intended reason**

Run:
`pytest tests/test_audiovisual_raw_prompt_adapter.py tests/test_audiovisual_template_engine.py -k "raw_prompt or original_prompt" -v`

Expected:
- failures due to missing adapter functions / missing raw prompt path

---

## Chunk 2: Build The Raw Prompt Adapter

### Task 2: Implement the raw prompt loading and sanitizing layer

**Files:**
- Create: `scripts/audiovisual/reporting/raw_prompt_adapter.py`
- Modify: `scripts/audiovisual/reporting/__init__.py`
- Test: `tests/test_audiovisual_raw_prompt_adapter.py`

- [ ] **Step 1: Create a failing import test for the adapter module surface**

Target functions should include stable entry points such as:
- raw prompt path resolution
- sanitized prompt loading
- required heading extraction
- raw prompt availability check

- [ ] **Step 2: Run the import-level test to verify it fails**

Run:
`pytest tests/test_audiovisual_raw_prompt_adapter.py -k "import or surface" -v`

- [ ] **Step 3: Implement the adapter with the minimal API needed by the tests**

Include:
- raw prompt mapping constants
- prompt file loading
- section stripping helpers
- module-heading extraction helpers

- [ ] **Step 4: Re-run the adapter tests until green**

Run:
`pytest tests/test_audiovisual_raw_prompt_adapter.py -v`

---

## Chunk 3: Add A Richer Storyboard Packet For Raw Prompt Mode

### Task 3: Replace the old 15-scene synopsis strategy for raw prompt requests

**Files:**
- Modify: `scripts/audiovisual/reporting/raw_prompt_adapter.py`
- Modify: `scripts/audiovisual/reporting/template_engine.py`
- Test: `tests/test_audiovisual_raw_prompt_adapter.py`
- Test: `tests/test_audiovisual_template_engine.py`

- [ ] **Step 1: Write a failing test for full-scene packet retention**

Assert that raw prompt mode:
- uses `storyboard_context_rows` when present
- prefers full scene coverage over 15-scene sampling

- [ ] **Step 2: Write a failing test for packet degradation order**

Assert that the packet builder:
- first compacts formatting
- only later trims less-important fields
- does not immediately drop to sampling

- [ ] **Step 3: Run the focused packet tests to verify failure**

Run:
`pytest tests/test_audiovisual_raw_prompt_adapter.py tests/test_audiovisual_template_engine.py -k "packet or storyboard_context" -v`

- [ ] **Step 4: Implement the richer storyboard packet builder**

Requirements:
- preserve all scenes when practical
- emit compact one-line rows
- keep key route metrics and highlight scenes ahead of the full packet
- expose a final string ready for `user_message`

- [ ] **Step 5: Re-run the packet tests until green**

Run:
`pytest tests/test_audiovisual_raw_prompt_adapter.py tests/test_audiovisual_template_engine.py -k "packet or storyboard_context" -v`

---

## Chunk 4: Wire Batch 1 Routes Onto The Raw Prompt Path

### Task 4: Route the six highest-value types through original prompts

**Files:**
- Modify: `scripts/audiovisual/reporting/template_engine.py`
- Modify: `scripts/audiovisual/reporting/markdown.py`
- Test: `tests/test_audiovisual_template_engine.py`

Batch 1 types:
- `commentary_remix`
- `documentary_essay`
- `brand_film`
- `narrative_trailer`
- `rhythm_remix`
- `meme_viral`

- [ ] **Step 1: Add failing integration tests for Batch 1 path selection**

Assert that these types:
- prefer the raw prompt path
- no longer depend on the compressed template as the main body generator

- [ ] **Step 2: Add failing tests for required headings in Batch 1 output**

Assert that generated body contains the module-derived headings for each type.

- [ ] **Step 3: Run focused Batch 1 integration tests to confirm failure**

Run:
`pytest tests/test_audiovisual_template_engine.py -k "commentary_remix or documentary_essay or brand_film or narrative_trailer or rhythm_remix or meme_viral" -v`

- [ ] **Step 4: Implement the raw-prompt branch in `template_engine`**

Requirements:
- detect mapped raw prompt types
- build raw prompt system prompt and user message
- keep the existing report shell assembly path
- preserve fallback to template mode when no raw prompt is available

- [ ] **Step 5: Re-run the Batch 1 integration tests until green**

Run:
`pytest tests/test_audiovisual_template_engine.py -k "commentary_remix or documentary_essay or brand_film or narrative_trailer or rhythm_remix or meme_viral" -v`

---

## Chunk 5: Extend To Batch 2 Without Breaking Fallbacks

### Task 5: Migrate the remaining one-to-one types to original prompts

**Files:**
- Modify: `scripts/audiovisual/reporting/raw_prompt_adapter.py`
- Modify: `tests/test_audiovisual_raw_prompt_adapter.py`
- Modify: `tests/test_audiovisual_template_engine.py`

Batch 2 types:
- `concept_mv`
- `live_session`
- `narrative_short`
- `talking_head`
- `event_promo`
- `explainer`
- `infographic_motion`
- `cinematic_vlog`
- `reality_record`
- `motion_graphics`
- `experimental`

- [ ] **Step 1: Add failing coverage tests for Batch 2 mapping and raw path usage**

- [ ] **Step 2: Run the focused tests to verify failure**

Run:
`pytest tests/test_audiovisual_raw_prompt_adapter.py tests/test_audiovisual_template_engine.py -k "concept_mv or live_session or narrative_short or talking_head or event_promo or explainer or infographic_motion or cinematic_vlog or reality_record or motion_graphics or experimental" -v`

- [ ] **Step 3: Extend mapping and integration to cover Batch 2**

- [ ] **Step 4: Re-run focused Batch 2 tests until green**

Run:
`pytest tests/test_audiovisual_raw_prompt_adapter.py tests/test_audiovisual_template_engine.py -k "concept_mv or live_session or narrative_short or talking_head or event_promo or explainer or infographic_motion or cinematic_vlog or reality_record or motion_graphics or experimental" -v`

---

## Chunk 6: Lock Special Cases And Final Regression

### Task 6: Protect fallback and unresolved mapping cases

**Files:**
- Modify: `scripts/audiovisual/reporting/raw_prompt_adapter.py`
- Modify: `tests/test_audiovisual_raw_prompt_adapter.py`
- Modify: `tests/test_audiovisual_template_engine.py`

- [ ] **Step 1: Add failing tests for special-case handling**

Cover:
- `mood_montage` multi-framework routing
- `performance_mv` no-stable-prompt fallback
- unmapped route fallback to current template path

- [ ] **Step 2: Run the special-case tests to confirm failure**

Run:
`pytest tests/test_audiovisual_raw_prompt_adapter.py tests/test_audiovisual_template_engine.py -k "mood_montage or performance_mv or fallback" -v`

- [ ] **Step 3: Implement the minimum fallback logic needed**

Requirements:
- unresolved types stay on current template path
- `performance_mv` 使用 `mv-temp1.md` 作为临时原稿来源
- `mood_montage` 在不同 framework 落点下仍统一走同一份原 prompt
- special mappings remain explicit and testable

- [ ] **Step 4: Run focused full regression for report generation**

Run:
`pytest tests/test_audiovisual_raw_prompt_adapter.py tests/test_audiovisual_template_engine.py tests/test_routing_and_dispatch.py -v`

- [ ] **Step 5: Run one broader regression pass before claiming completion**

Run:
`pytest tests/test_ai_analyzer.py tests/test_video_type_router_runtime.py -k "audiovisual or classification" -v`
