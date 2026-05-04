import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const RUN_STATE_SCRIPT_DIR = fileURLToPath(new URL(
  '../../assets/embedded-skills/video-expert-analyzer/scripts',
  import.meta.url,
))

test('VEA run_state writes Phase 1 identity and progress contract fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-vea-run-state-contract-'))
  try {
    const code = `
import json
import os
import time
from pathlib import Path

from run_state import mark_stage

root = Path(${JSON.stringify(dir)})
run_state_path = root / "run_state.json"
active_dir = root / "video-output"
active_dir.mkdir(parents=True, exist_ok=True)

state = mark_stage(
    run_state_path,
    stage="prepare",
    status="running",
    total_scenes=3,
    completed_scenes=0,
    coverage_ratio=0,
    active_output_dir=str(active_dir),
)
started_at = state["started_at"]
time.sleep(0.02)
state = mark_stage(
    run_state_path,
    stage="score_batches",
    status="running",
    total_scenes=3,
    completed_scenes=1,
    coverage_ratio=1 / 3,
    active_output_dir=str(active_dir),
)

assert state["schema_version"] == 1
assert state["task_id"] == "task-from-ready"
assert state["child_run_id"] == "child-from-ready"
assert state["pid"] == os.getpid()
assert state["started_at"] == started_at
assert state["active_output_dir"] == os.path.normpath(os.path.abspath(active_dir))
assert state["current_stage"] == "score_batches"
assert state["total_scenes"] == 3
assert state["completed_scenes"] == 1
assert state["coverage_ratio"] == 0.3333
print(json.dumps(state, ensure_ascii=False))
`
    const output = execFileSync('python3', ['-c', code], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PYTHONPATH: RUN_STATE_SCRIPT_DIR,
        READY_SKILL_TASK_ID: 'task-from-ready',
        READY_SKILL_CHILD_RUN_ID: 'child-from-ready',
      },
    })
    const state = JSON.parse(output)
    assert.equal(state.task_id, 'task-from-ready')
    assert.equal(state.child_run_id, 'child-from-ready')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
