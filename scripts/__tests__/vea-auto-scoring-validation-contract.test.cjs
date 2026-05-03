const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '..', '..')
const aiAnalyzerDir = path.join(repoRoot, 'assets', 'embedded-skills', 'video-expert-analyzer', 'scripts')

test('VEA semantic sample review is diagnostic and does not block finalize readiness', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-validation-'))
  const hostBatches = path.join(tmp, 'host_batches')
  fs.mkdirSync(hostBatches, { recursive: true })
  fs.writeFileSync(
    path.join(hostBatches, 'index.json'),
    JSON.stringify({
      batches: [
        {
          batch_id: 'batch-001',
          input: 'batch-001-input.json',
          output: 'batch-001-output.json',
        },
      ],
    }),
  )
  fs.writeFileSync(
    path.join(hostBatches, 'batch-001-input.json'),
    JSON.stringify({
      scenes: [
        {
          scene_number: 1,
          frames: {},
        },
      ],
    }),
  )
  const scoresPath = path.join(tmp, 'scene_scores.json')
  fs.writeFileSync(
    scoresPath,
    JSON.stringify({
      scenes: [
        {
          scene_number: 1,
          type_classification: 'TYPE-C Aesthetic',
          scores: {
            aesthetic_beauty: 7,
            credibility: 9,
            impact: 5,
            memorability: 6,
            fun_interest: 4,
          },
        },
      ],
    }),
  )

  const python = `
import json
import sys
import types
from pathlib import Path

sys.path.insert(0, ${JSON.stringify(aiAnalyzerDir)})

fake = types.ModuleType("openclaw_batch_probe")
fake.sample_scene_numbers = lambda numbers, sample_size: [1]
fake.analyze_scenes = lambda packets, attempts, max_workers: (
    [{"scene_number": 1, "batch_id": "batch-001", "ok": True}],
    [{
        "scene_number": 1,
        "type_classification": "TYPE-B Narrative",
        "scores": {
            "aesthetic_beauty": 6,
            "credibility": 9,
            "impact": 5,
            "memorability": 5,
            "fun_interest": 4,
        },
    }],
    [],
)
fake.build_validation_report = lambda generated_scenes, reference_scenes, sample_size, scene_packets: {
    "sample_scene_numbers": [1],
    "order_matches_reference": True,
    "samples": [{
        "scene_number": 1,
        "type_matches": False,
        "total_score_delta": 2,
    }],
}
fake.build_attempt_order = lambda providers, preferred_model, fallback_models: [{"model_ref": preferred_model}]
fake.load_provider_catalog = lambda path: {}
sys.modules["openclaw_batch_probe"] = fake

import ai_analyzer

summary = ai_analyzer.run_auto_scoring_validation(
    Path(${JSON.stringify(scoresPath)}),
    Path(${JSON.stringify(tmp)}),
    {"config_source": "test", "providers": {}, "preferred_model": "test/model"},
    scored_scene_numbers=[1],
    sample_size=1,
    max_workers=1,
)
print(json.dumps(summary))
`
  const out = execFileSync('python3', ['-c', python], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const summary = JSON.parse(out)
  assert.deepEqual(summary.validation_failed_scene_numbers, [])
  assert.deepEqual(summary.needs_review_scene_numbers, [1])
  assert.equal(summary.passed, true)
})
