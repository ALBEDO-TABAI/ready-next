# Auto Parallel Score Mainflow Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `score_batches` automatically discover usable model config, score pending scenes with direct multimodal requests in parallel, and stop with a clear setup message when config is missing.

**Architecture:** Reuse the proven OpenClaw probe path as the only scoring engine instead of keeping a manual host-agent scoring branch. Keep `host_batches` as the resumable state layer, but let `ai_analyzer.py` fill batch outputs itself with a scene-level worker pool capped at 10. Extend the existing app config file so first run can remember discovered provider settings, while missing discovery produces a blocked run state plus setup guidance instead of silent fallback.

**Tech Stack:** Python, pytest, existing `host_batches` JSON protocol, OpenClaw `models.json`, existing run-state and pipeline helpers

---

## Chunk 1: Red Tests For The New Default Path

### Task 1: Lock the new `score_batches` behavior in tests

**Files:**
- Modify: `tests/test_ai_analyzer.py`
- Test: `tests/test_ai_analyzer.py`

- [ ] **Step 1: Write failing tests for auto scoring**

Add tests that require:
- `score_batches` to call the automatic scorer instead of printing manual frame-review instructions
- missing config to return exit code `2` with a clear setup hint
- the automatic scorer to default to `10` workers
- ready-to-finalize runs to continue into `finalize`

- [ ] **Step 2: Run the focused analyzer tests and confirm RED**

Run: `pytest tests/test_ai_analyzer.py -q`
Expected: failures around the old manual instructions / missing new helpers

### Task 2: Lock config persistence and pipeline wiring

**Files:**
- Modify: `tests/test_pipeline_helpers.py`
- Modify: `tests/test_openclaw_batch_probe.py`
- Test: `tests/test_pipeline_helpers.py`
- Test: `tests/test_openclaw_batch_probe.py`

- [ ] **Step 1: Write failing tests for config discovery and worker defaults**

Add tests that require:
- OpenClaw `models.json` discovery to be reusable from production code
- persisted config normalization to preserve new model-config keys
- pipeline batch prep to use the same automatic path without a manual branch

- [ ] **Step 2: Run the focused config/probe tests and confirm RED**

Run: `pytest tests/test_pipeline_helpers.py tests/test_openclaw_batch_probe.py -q`
Expected: failures because the production helpers do not exist yet

## Chunk 2: Production Wiring

### Task 3: Add reusable provider discovery and parallel scoring helpers

**Files:**
- Modify: `scripts/openclaw_batch_probe.py`
- Modify: `scripts/pipeline_enhanced.py`
- Test: `tests/test_openclaw_batch_probe.py`
- Test: `tests/test_pipeline_helpers.py`

- [ ] **Step 1: Extract minimal reusable config helpers**

Implement:
- OpenClaw candidate `models.json` discovery
- environment fallback discovery
- config persistence hooks in `pipeline_enhanced.py`

- [ ] **Step 2: Keep the helpers small and production-safe**

Rules:
- no new abstraction layers unless already reused twice
- return plain dicts / paths
- missing config should produce structured diagnostics that `ai_analyzer.py` can print directly

- [ ] **Step 3: Run the focused helper tests**

Run: `pytest tests/test_pipeline_helpers.py tests/test_openclaw_batch_probe.py -q`
Expected: PASS

### Task 4: Replace manual `score_batches` with automatic parallel scoring

**Files:**
- Modify: `scripts/ai_analyzer.py`
- Test: `tests/test_ai_analyzer.py`

- [ ] **Step 1: Implement the smallest automatic scoring loop**

Behavior:
- prepare/merge host batches as today
- detect pending scenes from pending batch outputs
- score scenes via the direct multimodal worker pool
- write results back into batch output JSON files
- merge results and refresh state
- use `10` workers by default

- [ ] **Step 2: Block cleanly when config is missing**

Behavior:
- mark run state as `blocked`
- keep `current_stage` at `score_batches`
- set `last_error` to a short missing-config message
- print concrete setup guidance from CLI

- [ ] **Step 3: Re-run analyzer tests**

Run: `pytest tests/test_ai_analyzer.py -q`
Expected: PASS

## Chunk 3: Docs And Verification

### Task 5: Update the skill docs to match the new single-path behavior

**Files:**
- Modify: `SKILL.md`
- Modify: `README.md`

- [ ] **Step 1: Remove stale manual-scoring guidance**

Update docs so they say:
- `score_batches` now auto-scores
- manual host-agent fill-in is no longer the default workflow
- first run tries OpenClaw config first, then environment variables
- missing config blocks the run and tells the user what to provide

- [ ] **Step 2: Verify docs match actual CLI behavior**

Read the final CLI output strings and make sure docs do not promise hidden fallbacks

### Task 6: Full verification and live smoke

**Files:**
- Modify: `scripts/ai_analyzer.py` (only if final fixes are needed)
- Modify: `scripts/openclaw_batch_probe.py` (only if final fixes are needed)

- [ ] **Step 1: Run the automated test set**

Run: `pytest tests/test_ai_analyzer.py tests/test_pipeline_helpers.py tests/test_openclaw_batch_probe.py tests/test_orchestrate_vnext.py -q`
Expected: PASS

- [ ] **Step 2: Run a real 10-worker smoke on existing host batches**

Run with the real `scene_scores.json` / `host_batches` fixture already used in the probe work.
Expected:
- automatic config discovery succeeds from local OpenClaw config
- 10-worker scoring completes without order corruption
- outputs are written back into batch JSON files
- run state either advances or blocks only for real missing-resource reasons

- [ ] **Step 3: Re-read the completion checklist before reporting**

Checklist:
- `score_batches` is the only normal scoring path
- default worker count is `10`
- missing config produces a direct fix message
- pipeline entrypoint still runs end-to-end
- docs reflect reality
