# Auto Scoring Polish Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the automatic scoring path safer and leaner by persisting per-scene progress immediately, adding formal sample validation, removing obvious duplicate recomputation, and updating stale OpenClaw relay docs.

**Architecture:** Extend the existing direct-model scoring path instead of adding a second orchestration layer. Reuse the proven probe helpers for sample validation, add a main-thread completion callback so scene results flush to disk as soon as they return, and trim finalize-time duplicate storyboard refreshes without changing the artifact contract.

**Tech Stack:** Python, pytest, existing `host_batches` JSON protocol, OpenClaw probe helpers, markdown docs

---

## Chunk 1: Lock The New Behavior With Tests

### Task 1: Red tests for incremental write-back and validation

**Files:**
- Modify: `tests/test_openclaw_batch_probe.py`
- Modify: `tests/test_ai_analyzer.py`

- [ ] **Step 1: Write a failing callback test for per-scene completion**

Add a test that requires `analyze_scenes()` to notify the caller on every completed payload while keeping the final ordered return shape.

- [ ] **Step 2: Write a failing test for auto-fill incremental persistence**

Add a test that requires `auto_fill_pending_batches()` to update a batch output file after the first scene completes, before the rest of the batch is finished.

- [ ] **Step 3: Write a failing test for formal sample validation**

Add a test that requires the main scoring path to generate a validation report and surface review-required sample mismatches.

- [ ] **Step 4: Run focused tests and confirm RED**

Run: `pytest tests/test_ai_analyzer.py tests/test_openclaw_batch_probe.py -q`
Expected: failures around missing callback support / missing validation helpers

### Task 2: Red test for reduced finalize recomputation

**Files:**
- Modify: `tests/test_ai_analyzer.py`

- [ ] **Step 1: Write a failing finalize test**

Require finalize to reuse already-refreshed data when generating storyboard outputs instead of re-enriching and re-saving after every artifact variant.

- [ ] **Step 2: Run the focused finalize test and confirm RED**

Run: `pytest tests/test_ai_analyzer.py::test_main_finalize_runs_delivery_pipeline_with_verified_outputs -q`
Expected: failure until the new `skip_enrich` path exists

## Chunk 2: Production Changes

### Task 3: Add callback-based incremental scene completion

**Files:**
- Modify: `scripts/openclaw_batch_probe.py`
- Modify: `scripts/ai_analyzer.py`

- [ ] **Step 1: Add an optional per-result callback to `analyze_scenes()`**

Callback rules:
- called from the coordinator thread
- receives the same payload shape used for ordered results
- does not change the final ordered return contract

- [ ] **Step 2: Use the callback in `auto_fill_pending_batches()`**

Behavior:
- mark involved batch outputs as `in_progress` before worker launch
- flush each finished scene into its batch output immediately
- keep `needs_review` in sync for failed scenes

- [ ] **Step 3: Re-run focused persistence tests**

Run: `pytest tests/test_openclaw_batch_probe.py tests/test_ai_analyzer.py -q`
Expected: PASS for the new persistence behavior

### Task 4: Add formal sample validation to the automatic path

**Files:**
- Modify: `scripts/ai_analyzer.py`
- Test: `tests/test_ai_analyzer.py`

- [ ] **Step 1: Build a small validation pass over sampled scenes**

Behavior:
- sample a few newly scored scene numbers
- re-run the scorer on those packets
- compare first-pass vs validation-pass type and score deltas
- write a JSON report to disk

- [ ] **Step 2: Surface validation issues clearly**

Behavior:
- keep the run flowing when samples look consistent
- block with a clear message when sampled mismatches exceed the chosen threshold

- [ ] **Step 3: Re-run focused validation tests**

Run: `pytest tests/test_ai_analyzer.py -q`
Expected: PASS

### Task 5: Remove the obvious duplicate recomputation without breaking storyboard outputs

**Files:**
- Modify: `scripts/storyboard_generator.py`
- Modify: `scripts/ai_analyzer.py`
- Modify: `scripts/host_batching.py`

- [ ] **Step 1: Allow storyboard generation to skip a redundant enrich pass**

Behavior:
- preserve current default behavior
- let finalize explicitly say when the input data is already refreshed

- [ ] **Step 2: Remove repeated enrich/recompute/save cycles in finalize**

Behavior:
- no extra `enrich_storyboard_data()` round after each storyboard variant
- no extra `save_scores_data()` round that only rewrites unchanged scene data

- [ ] **Step 3: Reduce repeated batch packet rewrites**

Behavior:
- avoid rewriting unchanged batch JSON/text files
- avoid rerendering unchanged contact sheets

- [ ] **Step 4: Re-run targeted tests**

Run: `pytest tests/test_ai_analyzer.py tests/test_pipeline_helpers.py -q`
Expected: PASS

## Chunk 3: Docs And Verification

### Task 6: Clean stale OpenClaw relay guidance

**Files:**
- Modify: `docs/openclaw_orchestration.md`
- Modify: `SKILL.md` (only if wording still conflicts)

- [ ] **Step 1: Reframe relay docs as fallback / repair guidance**

Docs must say:
- automatic scoring is now the default path
- relay mode is only for special repair / constrained runs
- users should not expect routine per-batch manual handoff

- [ ] **Step 2: Read the dispatch docs against the current CLI**

Make sure the doc does not promise a default behavior the code no longer uses

### Task 7: Full verification including a real smoke

**Files:**
- Modify: `scripts/ai_analyzer.py` (only if final fixes are needed)
- Modify: `scripts/openclaw_batch_probe.py` (only if final fixes are needed)

- [ ] **Step 1: Run the relevant automated tests**

Run: `pytest -q`
Expected: PASS

- [ ] **Step 2: Run a real automatic-scoring smoke on a copied sample**

Evidence to collect:
- per-scene results are visible on disk before the whole batch finishes
- validation report is written
- finalize still produces the required outputs

- [ ] **Step 3: Re-read the completion checklist**

Checklist:
- scene results flush incrementally
- sample validation runs in the formal path
- finalize avoids the obvious redundant enrich/save loop
- relay docs match the new default workflow
