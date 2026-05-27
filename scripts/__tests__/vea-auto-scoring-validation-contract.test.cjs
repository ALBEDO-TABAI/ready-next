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

test('VEA delivery report preserves non-blocking auto scoring validation warnings', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-delivery-warning-'))
  fs.writeFileSync(
    path.join(tmp, 'run_state.json'),
    JSON.stringify({
      status: 'completed',
      current_stage: 'completed',
      completed_scenes: 1,
      coverage_ratio: 1,
      verification: { passed: true },
    }),
  )
  fs.writeFileSync(
    path.join(tmp, 'auto_scoring_validation.json'),
    JSON.stringify({
      checked_at: '2026-05-26T00:00:00',
      passed: true,
      sample_scene_numbers: [49, 80],
      validation_warning_scene_numbers: [49, 80],
      validation_failed_scene_numbers: [80],
      blocking_scene_numbers: [],
    }),
  )

  const python = `
import json
import sys
from pathlib import Path

sys.path.insert(0, ${JSON.stringify(aiAnalyzerDir)})

from delivery_validation import write_delivery_report

report = write_delivery_report(
    Path(${JSON.stringify(tmp)}),
    {"video_id": "demo", "title": "Demo", "scenes": []},
    ["md", "pdf"],
)
print(json.dumps(report, ensure_ascii=False))
`
  const out = execFileSync('python3', ['-c', python], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const report = JSON.parse(out)
  assert.deepEqual(report.auto_scoring_validation.validation_failed_scene_numbers, [80])
  assert.deepEqual(report.auto_scoring_validation.validation_warning_scene_numbers, [49, 80])
  assert.equal(report.non_blocking_warnings.length, 1)
  assert.match(report.non_blocking_warnings[0], /Scene 049/)
  assert.match(report.non_blocking_warnings[0], /Scene 080/)
})

test('VEA delivery verification fails when auto scoring validation has blocking scenes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-delivery-blocking-'))
  fs.writeFileSync(
    path.join(tmp, 'auto_scoring_validation.json'),
    JSON.stringify({
      checked_at: '2026-05-26T00:00:00',
      passed: false,
      sample_scene_numbers: [7],
      validation_warning_scene_numbers: [7],
      validation_failed_scene_numbers: [],
      blocking_scene_numbers: [7],
    }),
  )

  const python = `
import json
import sys
from pathlib import Path

sys.path.insert(0, ${JSON.stringify(aiAnalyzerDir)})

from delivery_validation import build_verification_payload

verification = build_verification_payload(
    Path(${JSON.stringify(tmp)}),
    {"video_id": "demo", "title": "Demo", "scenes": []},
    [],
    include_output_checks=False,
)
print(json.dumps(verification, ensure_ascii=False))
`
  const out = execFileSync('python3', ['-c', python], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const verification = JSON.parse(out)
  assert.equal(verification.passed, false)
  assert.deepEqual(verification.auto_scoring_blocking_scene_numbers, [7])
  assert.deepEqual(verification.auto_scoring_validation.blocking_scene_numbers, [7])
})

test('VEA delivery report folds blocking auto scoring validation into final verification', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-report-blocking-'))
  fs.writeFileSync(
    path.join(tmp, 'run_state.json'),
    JSON.stringify({
      status: 'completed',
      current_stage: 'completed',
      completed_scenes: 1,
      coverage_ratio: 1,
      verification: { passed: true },
    }),
  )
  fs.writeFileSync(
    path.join(tmp, 'auto_scoring_validation.json'),
    JSON.stringify({
      checked_at: '2026-05-26T00:00:00',
      passed: false,
      sample_scene_numbers: [9],
      validation_warning_scene_numbers: [9],
      validation_failed_scene_numbers: [],
      blocking_scene_numbers: [9],
    }),
  )

  const python = `
import json
import sys
from pathlib import Path

sys.path.insert(0, ${JSON.stringify(aiAnalyzerDir)})

from delivery_validation import write_delivery_report

report = write_delivery_report(
    Path(${JSON.stringify(tmp)}),
    {"video_id": "demo", "title": "Demo", "scenes": []},
    [],
)
print(json.dumps(report, ensure_ascii=False))
`
  const out = execFileSync('python3', ['-c', python], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const report = JSON.parse(out)
  assert.equal(report.verification.passed, false)
  assert.equal(report.verification.auto_scoring_validation_passed, false)
  assert.deepEqual(report.verification.auto_scoring_blocking_scene_numbers, [9])
})

test('VEA auto scoring validation blocks when sample order mismatches the reference', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-validation-order-'))
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
        "type_classification": "TYPE-C Aesthetic",
        "scores": {
            "aesthetic_beauty": 7,
            "credibility": 9,
            "impact": 5,
            "memorability": 6,
            "fun_interest": 4,
        },
    }],
    [],
)
fake.build_validation_report = lambda generated_scenes, reference_scenes, sample_size, scene_packets: {
    "sample_scene_numbers": [1],
    "order_matches_reference": False,
    "samples": [{
        "scene_number": 1,
        "type_matches": True,
        "total_score_delta": 0,
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
  assert.deepEqual(summary.needs_review_scene_numbers, [])
  assert.deepEqual(summary.blocking_scene_numbers, [1])
  assert.equal(summary.passed, false)
})
