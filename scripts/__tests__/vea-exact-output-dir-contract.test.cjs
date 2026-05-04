const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { existsSync, mkdtempSync, realpathSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '..', '..')
const scriptsRoot = path.join(repoRoot, 'assets', 'embedded-skills', 'video-expert-analyzer', 'scripts')

test('VEA typed pipeline can treat outputDir as the exact durable task directory', () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'ready-vea-exact-output-'))
  try {
    const python = `
from pathlib import Path
import sys

sys.path.insert(0, ${JSON.stringify(scriptsRoot)})
import pipeline_enhanced

pipeline_enhanced.get_video_info = lambda url: {
    "success": True,
    "title": "Nested Title Should Not Win",
    "uploader": "Uploader",
}

target = Path(${JSON.stringify(tempDir)})
pipeline = pipeline_enhanced.VideoAnalysisPipeline(
    "https://www.youtube.com/watch?v=4qkyxm4jppc",
    str(target),
    exact_output_dir=True,
)
print(pipeline.video_output_dir)
print(pipeline.scores_path)
`
    const [videoOutputDir, scoresPath] = execFileSync('python3', ['-c', python], {
      encoding: 'utf8',
    }).trim().split('\n').slice(-2)
    const realTempDir = realpathSync(tempDir)
    assert.equal(path.resolve(videoOutputDir), realTempDir)
    assert.equal(path.resolve(scoresPath), path.join(realTempDir, 'scene_scores.json'))
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('VEA ready compat treats outputDir as an output root unless exactOutputDir is explicit', () => {
  const python = `
import json
import sys

sys.path.insert(0, ${JSON.stringify(scriptsRoot)})
import ready_compat

root_payload = {"url": "https://www.youtube.com/watch?v=p4ahGSFTY-c", "outputDir": "/tmp/ready-output-root"}
exact_payload = {**root_payload, "exactOutputDir": True}
print(json.dumps(ready_compat._build_pipeline_cmd(root_payload), ensure_ascii=False))
print(json.dumps(ready_compat._build_pipeline_cmd(exact_payload), ensure_ascii=False))
`
  const [rootCmdRaw, exactCmdRaw] = execFileSync('python3', ['-c', python], {
    encoding: 'utf8',
  }).trim().split('\n').slice(-2)
  const rootCmd = JSON.parse(rootCmdRaw)
  const exactCmd = JSON.parse(exactCmdRaw)

  assert.ok(rootCmd.includes('-o'))
  assert.ok(!rootCmd.includes('--exact-output-dir'))
  assert.ok(exactCmd.includes('--exact-output-dir'))
})

test('VEA prepare stage reports scene clipping progress before scoring starts', () => {
  const python = `
import json
import sys

sys.path.insert(0, ${JSON.stringify(scriptsRoot)})
import pipeline_enhanced

pipeline = pipeline_enhanced.VideoAnalysisPipeline.__new__(pipeline_enhanced.VideoAnalysisPipeline)
calls = []
pipeline._mark_run_stage = lambda *args, **kwargs: calls.append({"args": args, "kwargs": kwargs})
pipeline._mark_prepare_progress(total_scenes=10, completed_scenes=4)
pipeline._mark_prepare_progress(total_scenes=0, completed_scenes=0)
print(json.dumps(calls, ensure_ascii=False))
`
  const calls = JSON.parse(execFileSync('python3', ['-c', python], {
    encoding: 'utf8',
  }).trim().split('\n').at(-1))

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    args: ['prepare'],
    kwargs: {
      status: 'running',
      completed: false,
      total_scenes: 10,
      completed_scenes: 4,
      coverage_ratio: 0.4,
    },
  })
})

test('VEA fresh pipeline resets stale completion artifacts in the selected output directory', () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'ready-vea-fresh-reset-'))
  try {
    const python = `
from pathlib import Path
import json
import os
import sys

sys.path.insert(0, ${JSON.stringify(scriptsRoot)})
import pipeline_enhanced

pipeline_enhanced.get_video_info = lambda url: {
    "success": True,
    "title": "Fresh Reset Clip",
    "uploader": "Uploader",
}

root = Path(${JSON.stringify(tempDir)})
video_dir = root / "[Uploader] Fresh Reset Clip"
video_dir.mkdir(parents=True, exist_ok=True)
(video_dir / "run_state.json").write_text(json.dumps({
    "task_id": "old-task",
    "child_run_id": "old-child",
    "status": "completed",
    "current_stage": "completed",
    "completed_stages": ["completed"],
    "completed_scenes": 99,
    "coverage_ratio": 1.0,
}, ensure_ascii=False), encoding="utf-8")
(video_dir / "scene_scores.json").write_text("{}", encoding="utf-8")
(video_dir / "delivery_report.json").write_text("{}", encoding="utf-8")

pipeline = pipeline_enhanced.VideoAnalysisPipeline(
    "https://www.youtube.com/watch?v=4qkyxm4jppc",
    str(root),
)
print(pipeline.run_state_path)
print(pipeline.scores_path)
print(video_dir / "delivery_report.json")
`
    const env = {
      ...process.env,
      READY_SKILL_TASK_ID: 'new-task',
      READY_SKILL_CHILD_RUN_ID: 'new-child',
    }
    const [runStatePath, scoresPath, deliveryReportPath] = execFileSync('python3', ['-c', python], {
      encoding: 'utf8',
      env,
    }).trim().split('\n').slice(-3)
    const state = JSON.parse(readFileSync(runStatePath, 'utf8'))
    assert.equal(state.task_id, 'new-task')
    assert.equal(state.child_run_id, 'new-child')
    assert.equal(state.status, 'running')
    assert.equal(state.current_stage, 'prepare')
    assert.deepEqual(state.completed_stages, [])
    assert.equal(state.completed_scenes, 0)
    assert.equal(state.coverage_ratio, 0)
    assert.equal(existsSync(scoresPath), false)
    assert.equal(existsSync(deliveryReportPath), false)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
