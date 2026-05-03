const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '..', '..')
const scriptsRoot = path.join(repoRoot, 'assets', 'embedded-skills', 'video-expert-analyzer', 'scripts')

test('VEA router reuses matching classification_result cache during finalize resume', () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'ready-vea-route-cache-'))
  try {
    const python = `
import json
from pathlib import Path
import sys

sys.path.insert(0, ${JSON.stringify(scriptsRoot)})

from classification_summary import build_classification_summary_payload, classification_summary_hash
from video_type_router_runtime import generate_classification_result

video_dir = Path(${JSON.stringify(tempDir)})
data = {
    "video_id": "cache-test",
    "video_title": "Cache Test",
    "rows": [
        {
            "scene_number": 1,
            "timestamp": "00:00:00,000 --> 00:00:01,000",
            "visual_description": "办公室采访",
            "voiceover": "Welcome to the office.",
            "onscreen_text": "Welcome",
        }
    ],
}
summary = build_classification_summary_payload(data)
cached = {
    "classification": {"type": "brand_film", "type_cn": "品牌影片", "confidence": "high"},
    "facets": {"visual_source": "R", "audio_dominance": "L"},
    "reasoning_summary": "cached route",
    "summary_source": {"summary_hash": classification_summary_hash(summary)},
    "applied_route": {"child_type": "brand_film", "route_label": "旅程型品牌短片"},
}
(video_dir / "classification_result.json").write_text(json.dumps(cached, ensure_ascii=False), encoding="utf-8")

def fail_classifier(summary_payload, runtime_config):
    raise RuntimeError("classifier should not run when cache is fresh")

result = generate_classification_result(data, video_dir, {}, classifier_fn=fail_classifier)
print(json.dumps(result, ensure_ascii=False))
`
    const stdout = execFileSync('python3', ['-c', python], {
      encoding: 'utf8',
    })
    const payload = JSON.parse(stdout)
    assert.equal(payload.reasoning_summary, 'cached route')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
