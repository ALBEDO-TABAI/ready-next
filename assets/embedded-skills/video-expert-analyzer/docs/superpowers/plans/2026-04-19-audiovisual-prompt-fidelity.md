# Audiovisual Prompt Fidelity Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make audiovisual body/svg generation follow each handoff prompt faithfully, block shortcut outputs, and regenerate the affected fixture outputs with verified prompt-compliant content.

**Architecture:** Tighten validation at the handoff ingestion boundary instead of trusting any non-empty `output.*` file. Add focused regression tests around body section compliance, SVG structure compliance, and figure-caption sourcing, then update the generator so prompt-derived requirements drive acceptance. After the flow is strict, rerun the affected fixture set so generated outputs and run-state metadata are consistent.

**Tech Stack:** Python, pytest, markdown/svg generation, existing audiovisual reporting pipeline

---

## Chunk 1: Regression Tests

### Task 1: Add failing tests for prompt fidelity

**Files:**
- Modify: `tests/test_audiovisual_template_engine.py`
- Modify: `tests/test_audiovisual_raw_prompt_adapter.py`

- [ ] **Step 1: Write failing tests for body prompt enforcement**

Add tests that prove title-only compliance is insufficient when raw-prompt-required sections demand specific prompt-derived anchors.

- [ ] **Step 2: Run targeted tests to verify they fail**

Run: `pytest tests/test_audiovisual_template_engine.py -k "prompt_fidelity or strict_body_validation" -v`

- [ ] **Step 3: Write failing tests for SVG prompt structure enforcement**

Add tests that reject SVG payloads missing required prompt-specific structural tokens such as visual/audio parallel lanes when the selected prompt expects them.

- [ ] **Step 4: Run targeted tests to verify they fail**

Run: `pytest tests/test_audiovisual_template_engine.py -k "svg_prompt_fidelity" -v`

- [ ] **Step 5: Write failing tests for figure caption sourcing**

Add tests that prove figure notes must come from current report/body context rather than static route defaults alone.

- [ ] **Step 6: Run targeted tests to verify they fail**

Run: `pytest tests/test_audiovisual_template_engine.py -k "figure_caption" -v`

## Chunk 2: Validation and Generation Fixes

### Task 2: Tighten body and SVG acceptance rules

**Files:**
- Modify: `scripts/audiovisual/reporting/template_engine.py`
- Modify: `scripts/audiovisual/reporting/svg_diagram.py`
- Modify: `scripts/audiovisual/reporting/raw_prompt_adapter.py`

- [ ] **Step 1: Implement minimal body validation improvements**

Make raw-prompt outputs validate against prompt-derived fidelity signals, not just heading presence.

- [ ] **Step 2: Run targeted tests**

Run: `pytest tests/test_audiovisual_template_engine.py -k "prompt_fidelity or strict_body_validation" -v`

- [ ] **Step 3: Implement minimal SVG validation improvements**

Parse the selected SVG prompt and enforce required structure markers/content families before accepting `output.svg`.

- [ ] **Step 4: Run targeted tests**

Run: `pytest tests/test_audiovisual_template_engine.py -k "svg_prompt_fidelity" -v`

### Task 3: Fix figure-caption sourcing

**Files:**
- Modify: `scripts/audiovisual/reporting/common.py`
- Modify: `scripts/audiovisual/reporting/template_engine.py`

- [ ] **Step 1: Implement minimal caption-source fix**

Make figure notes derive from current body/report context or explicitly generated per-run guidance instead of stale static notes alone.

- [ ] **Step 2: Run targeted tests**

Run: `pytest tests/test_audiovisual_template_engine.py -k "figure_caption" -v`

## Chunk 3: Verification and Fixture Regeneration

### Task 4: Run focused test suite

**Files:**
- Test: `tests/test_audiovisual_template_engine.py`
- Test: `tests/test_audiovisual_raw_prompt_adapter.py`
- Test: `tests/test_audiovisual_rendering.py`

- [ ] **Step 1: Run regression suite**

Run: `pytest tests/test_audiovisual_template_engine.py tests/test_audiovisual_raw_prompt_adapter.py tests/test_audiovisual_rendering.py -v`

- [ ] **Step 2: Confirm all tests pass**

Expected: all selected tests green

### Task 5: Regenerate the 10 affected fixture directories

**Files:**
- Modify generated outputs under `/Users/user/Documents/实验田/测试/...`

- [ ] **Step 1: Recreate handoff outputs using prompt-compliant generation**

Regenerate body/svg for the 10 target directories using the fixed flow.

- [ ] **Step 2: Rerun finalize for all 10 directories**

Run the existing finalize command per directory until `run_state.json` and `delivery_report.json` both show completion.

- [ ] **Step 3: Verify output inventory**

Confirm each directory has fresh `*_audiovisual_analysis.md`, `*_audiovisual_analysis.pdf`, `*_audiovisual_structure.svg`, `*_audiovisual_structure.png`, and completed handoff receipts.
