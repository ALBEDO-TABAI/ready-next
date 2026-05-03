const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '..', '..')

function runTsx(source) {
  const result = spawnSync('npx', ['tsx@^4.19.2', '--eval', source], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(result.status, 0, `tsx failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  const jsonLine = result.stdout.trim().split('\n').filter(Boolean).at(-1)
  return JSON.parse(jsonLine)
}

function fixtureSource() {
  return `
import fs from 'node:fs'
import path from 'node:path'

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}

function scene(number) {
  return {
    scene_number: number,
    description: 'complete description',
    type_classification: 'TYPE-B Narrative',
    weighted_score: 7,
    selection: '[USABLE]',
    selection_reasoning: 'clear reason',
    edit_suggestion: 'clear edit',
    scores: {
      aesthetic_beauty: 7,
      credibility: 8,
      impact: 6,
      memorability: 7,
      fun_interest: 6,
    },
    storyboard: {
      shot_size: '中景',
      lighting: '自然光',
      camera_movement: '推进',
      visual_style: '纪实',
      technique: '建立镜头',
    },
  }
}

function writeBase(root, videoId = 'fixture-video') {
  writeJson(path.join(root, 'run_state.json'), {
    status: 'completed',
    current_stage: 'completed',
    total_scenes: 1,
    completed_scenes: 1,
    scores_path: 'scene_scores.json',
    video_dir: root,
  })
  writeJson(path.join(root, 'scene_scores.json'), {
    video_id: videoId,
    title: 'Fixture',
    scenes: [scene(1)],
  })
  writeJson(path.join(root, 'host_batches', 'index.json'), {
    coverage_ratio: 1,
    batches: [{ batch_id: 'batch-001', output: 'batch-001-output.json' }],
  })
  writeJson(path.join(root, 'host_batches', 'batch-001-output.json'), {
    receipt: { status: 'completed' },
  })
}

function writeComplete(root, videoId = 'fixture-video') {
  writeBase(root, videoId)
  const storyboardMd = path.join(root, videoId + '_storyboard.md')
  const storyboardPdf = path.join(root, videoId + '_storyboard.pdf')
  const audiovisualMd = path.join(root, videoId + '_audiovisual_analysis.md')
  const audiovisualPdf = path.join(root, videoId + '_audiovisual_analysis.pdf')
  writeText(storyboardMd, '# storyboard')
  writeText(storyboardPdf, '%PDF storyboard')
  writeText(audiovisualMd, '# audiovisual')
  writeText(audiovisualPdf, '%PDF audiovisual')
  writeJson(path.join(root, 'delivery_report.json'), {
    video_id: videoId,
    status: 'completed',
    missing_outputs: [],
    blocked_batches: [],
    incomplete_scene_numbers: [],
    required_outputs: {
      storyboard_md: { path: storyboardMd, ok: true },
      storyboard_pdf: { path: storyboardPdf, ok: true },
      audiovisual_md: { path: audiovisualMd, ok: true },
      audiovisual_pdf: { path: audiovisualPdf, ok: true },
    },
  })
}

function writePendingHandoff(root, videoId = 'fixture-video') {
  writeBase(root, videoId)
  const storyboardMd = path.join(root, videoId + '_storyboard.md')
  const storyboardPdf = path.join(root, videoId + '_storyboard.pdf')
  const audiovisualMd = path.join(root, videoId + '_audiovisual_analysis.md')
  const audiovisualPdf = path.join(root, videoId + '_audiovisual_analysis.pdf')
  writeText(storyboardMd, '# storyboard')
  writeText(storyboardPdf, '%PDF storyboard')
  writeJson(path.join(root, 'delivery_report.json'), {
    video_id: videoId,
    status: 'completed',
    missing_outputs: ['audiovisual_md', 'audiovisual_pdf'],
    blocked_batches: [],
    incomplete_scene_numbers: [],
    required_outputs: {
      storyboard_md: { path: storyboardMd, ok: true },
      storyboard_pdf: { path: storyboardPdf, ok: true },
      audiovisual_md: { path: audiovisualMd, ok: false },
      audiovisual_pdf: { path: audiovisualPdf, ok: false },
    },
  })
  writeJson(path.join(root, 'audiovisual_handoff', 'receipt.json'), {
    tasks: {
      body: {
        status: 'pending',
        task: 'audiovisual_handoff/body/task.md',
        output: 'audiovisual_handoff/body/output.md',
      },
    },
  })
  writeText(path.join(root, 'audiovisual_handoff', 'body', 'task.md'), 'write body')
}

function launch(root, closeStatus = 'completed') {
  return {
    childRunId: 'vfixture001',
    status: 'running',
    eventLogPath: path.join(root, '.ready', 'child-runs', 'run.jsonl'),
    outputDir: root,
    runStatePath: path.join(root, 'run_state.json'),
    sceneScoresPath: path.join(root, 'scene_scores.json'),
    closeEvent: null,
    closeStatus,
  }
}

function close(root) {
  return {
    kind: 'closed',
    closeEvent: {
      status: 'completed',
      terminalReason: 'done',
      outputDir: root,
      runStatePath: path.join(root, 'run_state.json'),
      sceneScoresPath: path.join(root, 'scene_scores.json'),
    },
  }
}

const agentContext = {
  provider: 'fixture',
  model_id: 'vision',
  base_url: 'http://127.0.0.1',
  api_key: 'test',
  api_kind: 'openai-completions',
  fallback_chain: [],
  input_modes: ['text', 'image'],
}
`
}

test('VEA live acceptance fresh-resume cleans once, runs fresh first, then verifies the same output dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-live-fresh-resume-'))
  fs.writeFileSync(path.join(root, 'stale.txt'), 'stale')
  const report = runTsx(`
${fixtureSource()}
const acceptanceModule = import('./scripts/agent-vea-live-acceptance.ts')

async function main() {
  const { parseArgs, runAcceptance } = await acceptanceModule
  const root = ${JSON.stringify(root)}
  const calls = []
  let cleanCalls = 0
  const opts = parseArgs(['--mode', 'fresh-resume', '--output-dir', root, '--json', '--wait-ms', '1000'])
  const deps = {
    makeAgentContext: () => agentContext,
    createRunner: async () => ({
      startSkillChildRun: async (params) => {
        calls.push({
          action: params.action,
          outputDir: params.requestedInput.outputDir,
          exactOutputDir: params.requestedInput.exactOutputDir === true,
          staleExists: fs.existsSync(path.join(root, 'stale.txt')),
        })
        writeComplete(root)
        return launch(root)
      },
      waitForSkillChildRunClose: async () => close(root),
    }),
    cleanOutputDir: (dir) => {
      cleanCalls += 1
      fs.rmSync(dir, { recursive: true, force: true })
      fs.mkdirSync(dir, { recursive: true })
    },
    completePendingHandoffs: async () => [],
    repairHandoffValidationErrors: async () => [],
  }
  const { report } = await runAcceptance(opts, deps)
  console.log(JSON.stringify({
    success: report.success,
    mode: report.mode,
    phases: report.results.map((result) => result.phase),
    cleanCalls,
    calls,
    freshResume: report.freshResume,
  }))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`)

  assert.equal(report.success, true)
  assert.equal(report.mode, 'fresh-resume')
  assert.deepEqual(report.phases, ['fresh', 'resume'])
  assert.equal(report.cleanCalls, 1)
  assert.deepEqual(report.calls, [
    {
      action: 'video_expert_pipeline',
      outputDir: root,
      exactOutputDir: true,
      staleExists: false,
    },
  ])
  assert.equal(report.freshResume.sameOutputDir, true)
})

test('VEA live acceptance observe reports pending handoff without completing it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-live-observe-'))
  const report = runTsx(`
${fixtureSource()}
const acceptanceModule = import('./scripts/agent-vea-live-acceptance.ts')

async function main() {
  const { parseArgs, runAcceptance } = await acceptanceModule
  const root = ${JSON.stringify(root)}
  let completeCalls = 0
  const opts = parseArgs(['--mode', 'fresh', '--handoff', 'observe', '--output-dir', root, '--json', '--wait-ms', '1000'])
  const deps = {
    makeAgentContext: () => agentContext,
    createRunner: async () => ({
      startSkillChildRun: async () => {
        writePendingHandoff(root)
        return launch(root)
      },
      waitForSkillChildRunClose: async () => close(root),
    }),
    completePendingHandoffs: async () => {
      completeCalls += 1
      return []
    },
    repairHandoffValidationErrors: async () => [],
  }
  const { report } = await runAcceptance(opts, deps)
  console.log(JSON.stringify({
    success: report.success,
    completeCalls,
    result: report.results[0],
  }))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`)

  assert.equal(report.success, true)
  assert.equal(report.completeCalls, 0)
  assert.equal(report.result.observedPendingHandoff, true)
  assert.deepEqual(report.result.runs[0].pendingHandoffs, ['body'])
})

test('VEA live acceptance complete can use a test handoff completer and keep looping to final artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-live-complete-'))
  const report = runTsx(`
${fixtureSource()}
const acceptanceModule = import('./scripts/agent-vea-live-acceptance.ts')

async function main() {
  const { parseArgs, runAcceptance } = await acceptanceModule
  const root = ${JSON.stringify(root)}
  const calls = []
  let handoffCompletions = 0
  const opts = parseArgs(['--mode', 'fresh', '--handoff', 'complete', '--output-dir', root, '--json', '--wait-ms', '1000'])
  const deps = {
    makeAgentContext: () => agentContext,
    createRunner: async () => ({
      startSkillChildRun: async (params) => {
        calls.push(params.action)
        if (calls.length === 1) writePendingHandoff(root)
        else writeComplete(root)
        return launch(root)
      },
      waitForSkillChildRunClose: async () => close(root),
    }),
    completePendingHandoffs: async () => {
      handoffCompletions += 1
      writeJson(path.join(root, 'audiovisual_handoff', 'receipt.json'), {
        tasks: { body: { status: 'completed' } },
      })
      return [{
        name: 'body',
        taskPath: path.join(root, 'audiovisual_handoff', 'body', 'task.md'),
        outputPath: path.join(root, 'audiovisual_handoff', 'body', 'output.md'),
        bytesWritten: 12,
        model: 'test',
      }]
    },
    repairHandoffValidationErrors: async () => [],
  }
  const { report } = await runAcceptance(opts, deps)
  console.log(JSON.stringify({
    success: report.success,
    calls,
    handoffCompletions,
    runCount: report.results[0].runs.length,
    finalComplete: report.results[0].artifacts.complete,
  }))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`)

  assert.equal(report.success, true)
  assert.deepEqual(report.calls, ['video_expert_pipeline', 'video_expert_ai_analyze'])
  assert.equal(report.handoffCompletions, 1)
  assert.equal(report.runCount, 2)
  assert.equal(report.finalComplete, true)
})
