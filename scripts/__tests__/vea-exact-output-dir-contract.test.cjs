const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, realpathSync, rmSync } = require('node:fs')
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
