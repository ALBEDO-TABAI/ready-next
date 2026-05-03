const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '..', '..')
const scriptPath = path.join(repoRoot, 'scripts', 'vea-assert-artifacts.cjs')

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}

function completeScene(sceneNumber) {
  return {
    scene_number: sceneNumber,
    description: `Scene ${sceneNumber} description`,
    type_classification: 'TYPE-B Narrative',
    weighted_score: 7.2,
    selection: '[USABLE]',
    selection_reasoning: 'Useful scene with clear narrative value.',
    edit_suggestion: 'Keep the useful section and tighten the transition.',
    scores: {
      aesthetic_beauty: 7,
      credibility: 8,
      impact: 6,
      memorability: 7,
      fun_interest: 6,
    },
    storyboard: {
      shot_size: '中景',
      lighting: '柔和自然光',
      camera_movement: '缓慢推进',
      visual_style: '纪实风',
      technique: '环境建立镜头',
    },
  }
}

function writeCompleteFixture(root, overrides = {}) {
  const videoId = overrides.videoId || 'video-ok'
  const scenes = overrides.scenes || [completeScene(1), completeScene(2)]
  const storyboardMd = path.join(root, `${videoId}_storyboard.md`)
  const storyboardPdf = path.join(root, `${videoId}_storyboard.pdf`)
  const audiovisualMd = path.join(root, `${videoId}_audiovisual_analysis.md`)
  const audiovisualPdf = path.join(root, `${videoId}_audiovisual_analysis.pdf`)

  writeJson(path.join(root, 'run_state.json'), {
    status: 'completed',
    current_stage: 'completed',
    total_scenes: scenes.length,
    completed_scenes: scenes.length,
    scores_path: 'scene_scores.json',
    video_dir: root,
  })
  writeJson(path.join(root, 'scene_scores.json'), {
    video_id: videoId,
    title: 'Fixture video',
    scenes,
  })
  writeJson(path.join(root, 'host_batches', 'index.json'), {
    batches: [
      {
        batch_id: 'batch-001',
        output: 'batch-001-output.json',
      },
    ],
  })
  writeJson(path.join(root, 'host_batches', 'batch-001-output.json'), {
    receipt: {
      status: 'completed',
    },
  })
  writeText(storyboardMd, '# Storyboard\n\ncomplete storyboard table')
  writeText(storyboardPdf, '%PDF storyboard')
  writeText(audiovisualMd, '# Audiovisual\n\ncomplete audiovisual report')
  writeText(audiovisualPdf, '%PDF audiovisual')
  writeJson(path.join(root, 'delivery_report.json'), {
    video_id: videoId,
    status: 'completed',
    current_stage: 'completed',
    missing_outputs: [],
    blocked_batches: [],
    incomplete_scene_numbers: [],
    blockers: [],
    required_outputs: {
      storyboard_md: { path: storyboardMd, exists: true, size: 34, ok: true },
      storyboard_pdf: { path: storyboardPdf, exists: true, size: 15, ok: true },
      audiovisual_md: { path: audiovisualMd, exists: true, size: 40, ok: true },
      audiovisual_pdf: { path: audiovisualPdf, exists: true, size: 16, ok: true },
    },
  })
}

function runAssert(outputDir) {
  return spawnSync('node', [scriptPath, '--output-dir', outputDir, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15_000,
  })
}

function parseJson(stdout) {
  return JSON.parse(stdout.trim())
}

test('vea artifact assert passes a complete fixture', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-artifacts-ok-'))
  writeCompleteFixture(root)

  const result = runAssert(root)

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  const report = parseJson(result.stdout)
  assert.equal(report.ok, true)
  assert.equal(report.summary.totalScenes, 2)
  assert.deepEqual(report.problems, [])
})

test('package exposes the standalone VEA artifact assertion command', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

  assert.equal(
    packageJson.scripts['agent:acceptance:vea-artifacts'],
    'node scripts/vea-assert-artifacts.cjs',
  )
})

test('vea artifact assert fails when required artifacts are missing or scenes are incomplete', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-artifacts-missing-'))
  const incomplete = completeScene(1)
  delete incomplete.storyboard.technique
  writeCompleteFixture(root, { scenes: [incomplete] })
  fs.rmSync(path.join(root, 'video-ok_audiovisual_analysis.pdf'))

  const result = runAssert(root)

  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  const report = parseJson(result.stdout)
  assert.equal(report.ok, false)
  assert.ok(report.problems.some((problem) => problem.includes('scene 1 missing storyboard.technique')))
  assert.ok(report.problems.some((problem) => problem.includes('audiovisual_pdf')))
})

test('vea artifact assert fails when one output directory mixes another video id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-artifacts-mixed-'))
  writeCompleteFixture(root, { videoId: 'video-ok' })
  writeText(path.join(root, 'old-video_storyboard.md'), '# stale storyboard')

  const result = runAssert(root)

  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  const report = parseJson(result.stdout)
  assert.equal(report.ok, false)
  assert.ok(report.problems.some((problem) => problem.includes('mixed video artifact')))
})
