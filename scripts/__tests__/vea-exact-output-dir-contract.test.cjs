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
