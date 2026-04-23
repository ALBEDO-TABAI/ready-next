# OpenClaw Batch Probe Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone probe that reads `host_batches` scene packets, sends scene frames to OpenClaw-backed multimodal providers, and records 1/5/10-scene throughput and stability without touching the main pipeline.

**Architecture:** Add one standalone script under `scripts/` that reuses the existing scene-analysis prompt/validation helpers from `ai_analyzer.py`, reads provider credentials from OpenClaw's local `models.json`, and writes probe-only output files. Add one focused test module that covers scene collection, model attempt ordering, and batch-like output shaping so the probe can evolve safely without changing `score_batches`.

**Tech Stack:** Python 3.9+, `openai`, `anthropic`, `requests`, `pytest`

---

## Chunk 1: Probe Skeleton

### Task 1: Lock probe behavior with tests

**Files:**
- Create: `tests/test_openclaw_batch_probe.py`
- Test: `tests/test_openclaw_batch_probe.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_collect_probe_scenes_spans_multiple_batches():
    ...

def test_build_attempt_order_keeps_preferred_then_fallbacks():
    ...

def test_build_batch_like_output_uses_probe_receipt():
    ...
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_openclaw_batch_probe.py -q`
Expected: FAIL because `openclaw_batch_probe` does not exist yet.

### Task 2: Implement the minimal probe helpers

**Files:**
- Create: `scripts/openclaw_batch_probe.py`
- Modify: `tests/test_openclaw_batch_probe.py`

- [ ] **Step 3: Write minimal implementation**

```python
def resolve_model_entry(...): ...
def build_attempt_order(...): ...
def collect_probe_scenes(...): ...
def build_batch_like_output(...): ...
```

- [ ] **Step 4: Run the targeted tests**

Run: `pytest tests/test_openclaw_batch_probe.py -q`
Expected: PASS

## Chunk 2: Provider Calls And CLI

### Task 3: Add provider-backed scene analysis

**Files:**
- Modify: `scripts/openclaw_batch_probe.py`
- Test: `tests/test_openclaw_batch_probe.py`

- [ ] **Step 5: Add minimal provider clients**

```python
def analyze_scene_with_attempts(...): ...
def call_openai_compatible_scene(...): ...
def call_anthropic_scene(...): ...
```

- [ ] **Step 6: Reuse existing prompt and JSON validation**

Run: `pytest tests/test_openclaw_batch_probe.py -q`
Expected: PASS

### Task 4: Add CLI and probe output writing

**Files:**
- Modify: `scripts/openclaw_batch_probe.py`

- [ ] **Step 7: Add CLI for 1/5/10-scene experiments**

```bash
python3 scripts/openclaw_batch_probe.py \
  --host-batches /path/to/host_batches \
  --counts 1,5,10 \
  --preferred-model kcode/K2.6-code-preview \
  --fallback-model zai/GLM-5V-Turbo \
  --fallback-model novacode-openai/gpt-5.4
```

- [ ] **Step 8: Write probe-only output files**

Expected outputs:
- `probe_runs/<timestamp>/probe-n1-output.json`
- `probe_runs/<timestamp>/probe-n5-output.json`
- `probe_runs/<timestamp>/probe-n10-output.json`
- `probe_runs/<timestamp>/probe-summary.json`

## Chunk 3: Verification

### Task 5: Run probe experiments and capture evidence

**Files:**
- Modify: `probe_runs/...` (generated)

- [ ] **Step 9: Run 1-scene probe**

Run: `python3 scripts/openclaw_batch_probe.py --host-batches <path> --counts 1 ...`
Expected: one scene result plus timing/attempt metadata.

- [ ] **Step 10: Run 5-scene and 10-scene probes**

Run: `python3 scripts/openclaw_batch_probe.py --host-batches <path> --counts 5,10 ...`
Expected: stable outputs, success/failure counts, per-scene timings.

- [ ] **Step 11: Verify targeted tests still pass**

Run: `pytest tests/test_openclaw_batch_probe.py -q`
Expected: PASS

- [ ] **Step 12: Summarize whether the probe is suitable for replacing manual `score_batches` work**

Evidence:
- model actually used per scene
- total elapsed time per count
- parse success rate
- field completeness rate
