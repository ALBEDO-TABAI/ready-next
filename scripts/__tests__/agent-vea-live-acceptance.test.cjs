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
    child_run_id: 'vfixture001',
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

test('VEA live acceptance can verify output-root runs without forcing exact output dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-live-root-layout-'))
  const nested = path.join(root, '[Uploader] Nested Video Title')
  const report = runTsx(`
${fixtureSource()}
const acceptanceModule = import('./scripts/agent-vea-live-acceptance.ts')

async function main() {
  const { parseArgs, runAcceptance } = await acceptanceModule
  const root = ${JSON.stringify(root)}
  const nested = ${JSON.stringify(nested)}
  const calls = []
  const opts = parseArgs(['--mode', 'fresh', '--output-layout', 'root', '--output-dir', root, '--json', '--wait-ms', '1000'])
  const deps = {
    makeAgentContext: () => agentContext,
    createRunner: async () => ({
      startSkillChildRun: async (params) => {
        calls.push({
          outputDir: params.requestedInput.outputDir,
          exactOutputDir: params.requestedInput.exactOutputDir === true,
        })
        writeComplete(nested)
        return launch(nested)
      },
      waitForSkillChildRunClose: async () => close(nested),
    }),
    completePendingHandoffs: async () => [],
    repairHandoffValidationErrors: async () => [],
  }
  const { report } = await runAcceptance(opts, deps)
  console.log(JSON.stringify({
    success: report.success,
    outputDir: report.results[0].artifacts.outputDir,
    calls,
    handleProblems: report.results[0].runs[0].handleProblems || [],
  }))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`)

  assert.equal(report.success, true)
  assert.equal(path.resolve(report.outputDir), path.resolve(nested))
  assert.deepEqual(report.calls, [{ outputDir: root, exactOutputDir: false }])
  assert.deepEqual(report.handleProblems, [])
})

test('VEA live acceptance fails when fresh run_state does not carry the current child id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-live-child-id-'))
  const report = runTsx(`
${fixtureSource()}
const acceptanceModule = import('./scripts/agent-vea-live-acceptance.ts')

async function main() {
  const { parseArgs, runAcceptance } = await acceptanceModule
  const root = ${JSON.stringify(root)}
  const opts = parseArgs(['--mode', 'fresh', '--url', 'https://example.test/watch?v=dynamic-video-id', '--output-dir', root, '--json', '--wait-ms', '1000'])
  const deps = {
    makeAgentContext: () => agentContext,
    createRunner: async () => ({
      startSkillChildRun: async () => {
        writeComplete(root)
        const statePath = path.join(root, 'run_state.json')
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
        state.child_run_id = 'old-child'
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
        return launch(root)
      },
      waitForSkillChildRunClose: async () => close(root),
    }),
    completePendingHandoffs: async () => [],
    repairHandoffValidationErrors: async () => [],
  }
  const { report } = await runAcceptance(opts, deps)
  console.log(JSON.stringify({
    success: report.success,
    problems: report.results[0].artifacts.problems,
    handleProblems: report.results[0].runs[0].handleProblems || [],
  }))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`)

  assert.equal(report.success, false)
  assert.ok(report.handleProblems.some((problem) => problem.includes('child_run_id mismatch')))
  assert.ok(report.problems.some((problem) => problem.includes('child_run_id mismatch')))
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

test('VEA live acceptance reuses a pending handoff output that already exists on resume', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-live-existing-handoff-'))
  const report = runTsx(`
${fixtureSource()}
const acceptanceModule = import('./scripts/agent-vea-live-acceptance.ts')

async function main() {
  const { completePendingHandoffs } = await acceptanceModule
  const root = ${JSON.stringify(root)}
  writeJson(path.join(root, 'audiovisual_handoff', 'receipt.json'), {
    tasks: {
      diagram: {
        status: 'pending',
        task: 'audiovisual_handoff/diagram/task.md',
        output: 'diagram/output.svg',
      },
    },
  })
  writeText(path.join(root, 'audiovisual_handoff', 'diagram', 'task.md'), 'write svg')
  writeText(path.join(root, 'audiovisual_handoff', 'diagram', 'output.svg'), '<svg><title>ok</title></svg>')
  const completed = await completePendingHandoffs(root, agentContext)
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'audiovisual_handoff', 'receipt.json'), 'utf8'))
  console.log(JSON.stringify({
    completed,
    status: receipt.tasks.diagram.status,
  }))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`)

  assert.equal(report.status, 'completed')
  assert.equal(report.completed.length, 1)
  assert.equal(report.completed[0].name, 'diagram')
  assert.equal(report.completed[0].reusedExisting, true)
  assert.equal(report.completed[0].model, 'existing-output')
})

test('VEA live acceptance regenerates a completed handoff when the SVG output is malformed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-live-malformed-handoff-'))
  const report = runTsx(`
${fixtureSource()}
import http from 'node:http'
const acceptanceModule = import('./scripts/agent-vea-live-acceptance.ts')

async function main() {
  const { completePendingHandoffs } = await acceptanceModule
  const root = ${JSON.stringify(root)}
  let requests = 0
  const server = http.createServer((req, res) => {
    requests += 1
    req.resume()
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: '<svg><title>ok</title></svg>',
        },
      }],
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    writeJson(path.join(root, 'audiovisual_handoff', 'receipt.json'), {
      tasks: {
        diagram: {
          status: 'completed',
          task: 'audiovisual_handoff/diagram/task.md',
          output: 'diagram/output.svg',
        },
      },
    })
    writeText(path.join(root, 'audiovisual_handoff', 'diagram', 'task.md'), 'write svg')
    writeText(path.join(root, 'audiovisual_handoff', 'diagram', 'output.svg'), '<svg><title>truncated</title>')
    const ctx = {
      ...agentContext,
      base_url: 'http://127.0.0.1:' + port,
      api_key: 'test',
      api_kind: 'openai-completions',
    }
    const completed = await completePendingHandoffs(root, ctx)
    const output = fs.readFileSync(path.join(root, 'audiovisual_handoff', 'diagram', 'output.svg'), 'utf8')
    console.log(JSON.stringify({
      completed,
      output,
      requests,
    }))
  } finally {
    server.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`)

  assert.equal(report.requests, 1)
  assert.equal(report.output, '<svg><title>ok</title></svg>')
  assert.equal(report.completed.length, 1)
  assert.equal(report.completed[0].reusedExisting, undefined)
  assert.equal(report.completed[0].model, 'fixture/vision')
})

test('VEA live acceptance defaults to the selected model without config fallbacks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-live-model-'))
  const modelsJson = path.join(root, 'models.json')
  fs.writeFileSync(modelsJson, JSON.stringify({
    providers: {
      xiaomi: {
        baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
        apiKey: 'test-key',
        api: 'anthropic-messages',
        models: [{
          id: 'mimo-v2.5',
          api: 'anthropic-messages',
          input: ['text', 'image'],
        }],
      },
    },
  }))

  const report = runTsx(`
${fixtureSource()}
const acceptanceModule = import('./scripts/agent-vea-live-acceptance.ts')

async function main() {
  const { parseArgs } = await acceptanceModule
  const opts = parseArgs([
    '--mode', 'fresh',
    '--output-dir', ${JSON.stringify(path.join(root, 'out'))},
    '--models-json', ${JSON.stringify(modelsJson)},
    '--preferred-model', 'xiaomi/mimo-v2.5',
    '--json',
  ])
  const ctx = (await acceptanceModule).makeAgentContext(opts)
  console.log(JSON.stringify({
    provider: ctx.provider,
    model: ctx.model_id,
    fallbacks: ctx.fallback_chain,
    inputModes: ctx.input_modes,
  }))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`)

  assert.equal(report.provider, 'xiaomi')
  assert.equal(report.model, 'mimo-v2.5')
  assert.deepEqual(report.fallbacks, [])
  assert.deepEqual(report.inputModes, ['text', 'image'])
})

test('VEA live acceptance does not hardcode a default video URL', () => {
  const report = runTsx(`
const acceptanceModule = import('./scripts/agent-vea-live-acceptance.ts')

async function main() {
  const { parseArgs } = await acceptanceModule
  const opts = parseArgs([])
  console.log(JSON.stringify({
    url: opts.url,
    outputDir: opts.outputDir,
  }))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`)

  assert.equal(report.url, '')
  assert.ok(!report.outputDir.includes('4qkyxm4jppc'))
})

test('VEA live acceptance writes a test manifest for the output it used', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-live-manifest-'))
  const report = runTsx(`
${fixtureSource()}
const acceptanceModule = import('./scripts/agent-vea-live-acceptance.ts')

async function main() {
  const { parseArgs, runAcceptance } = await acceptanceModule
  const root = ${JSON.stringify(root)}
  const opts = parseArgs(['--mode', 'fresh', '--url', 'https://example.test/watch?v=dynamic-video-id', '--output-dir', root, '--json', '--wait-ms', '1000'])
  const deps = {
    makeAgentContext: () => agentContext,
    createRunner: async () => ({
      startSkillChildRun: async () => {
        writeComplete(root, 'dynamic-video-id')
        return launch(root)
      },
      waitForSkillChildRunClose: async () => close(root),
    }),
    completePendingHandoffs: async () => [],
    repairHandoffValidationErrors: async () => [],
  }
  const { report } = await runAcceptance(opts, deps)
  const manifestPath = path.join(root, '.ready-vea-test-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  console.log(JSON.stringify({
    cleanupDefault: opts.cleanupTestOutput,
    success: report.success,
    manifestPath,
    records: manifest.records,
  }))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`)

  assert.equal(report.cleanupDefault, 'off')
  assert.equal(report.success, true)
  assert.equal(report.records.length, 1)
  assert.equal(path.resolve(report.records[0].outputDir), path.resolve(root))
  assert.equal(report.records[0].videoId, 'dynamic-video-id')
  assert.equal(report.records[0].url, 'https://example.test/watch?v=dynamic-video-id')
  assert.equal(path.resolve(report.records[0].runStatePath), path.resolve(path.join(root, 'run_state.json')))
  assert.equal(path.resolve(report.records[0].deliveryReportPath), path.resolve(path.join(root, 'delivery_report.json')))
  assert.match(report.records[0].createdAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.match(report.records[0].updatedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('VEA live acceptance cleanup dry-run reports deletions without removing files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-live-dry-run-'))
  const outputDir = path.join(root, 'registered-output')
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(path.join(outputDir, 'run_state.json'), '{}')
  fs.writeFileSync(path.join(root, '.ready-vea-test-manifest.json'), JSON.stringify({
    version: 1,
    testRoot: root,
    records: [{
      outputDir,
      url: 'https://example.test/video',
      videoId: 'registered-video',
      runStatePath: path.join(outputDir, 'run_state.json'),
      deliveryReportPath: path.join(outputDir, 'delivery_report.json'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  }, null, 2))

  const report = runTsx(`
const acceptanceModule = import('./scripts/agent-vea-live-acceptance.ts')

async function main() {
  const { parseArgs, cleanupTestOutput } = await acceptanceModule
  const opts = parseArgs(['--mode', 'fresh', '--output-layout', 'root', '--output-dir', ${JSON.stringify(root)}, '--cleanup-test-output', 'dry-run'])
  const cleanup = cleanupTestOutput(opts, 'before')
  console.log(JSON.stringify({
    cleanupMode: opts.cleanupTestOutput,
    existsAfter: fs.existsSync(${JSON.stringify(outputDir)}),
    cleanup,
  }))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`)

  assert.equal(report.cleanupMode, 'dry-run')
  assert.equal(report.existsAfter, true)
  assert.deepEqual(report.cleanup.deleted, [])
  assert.equal(report.cleanup.wouldDelete.length, 1)
  assert.equal(path.resolve(report.cleanup.wouldDelete[0]), path.resolve(outputDir))
})

test('VEA live acceptance cleanup only deletes manifest entries under the test root with VEA markers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-live-cleanup-'))
  const keepUnmanifested = path.join(root, 'unmanifested')
  const deleteRegistered = path.join(root, 'registered')
  const keepMissingMarker = path.join(root, 'missing-marker')
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-live-outside-'))
  for (const dir of [keepUnmanifested, deleteRegistered, keepMissingMarker, outside]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(path.join(keepUnmanifested, 'run_state.json'), '{}')
  fs.writeFileSync(path.join(deleteRegistered, 'scene_scores.json'), '{}')
  fs.writeFileSync(path.join(outside, 'delivery_report.json'), '{}')
  fs.writeFileSync(path.join(root, '.ready-vea-test-manifest.json'), JSON.stringify({
    version: 1,
    testRoot: root,
    records: [
      { outputDir: deleteRegistered, url: 'https://example.test/delete', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { outputDir: keepMissingMarker, url: 'https://example.test/no-marker', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { outputDir: outside, url: 'https://example.test/outside', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ],
  }, null, 2))

  const report = runTsx(`
const acceptanceModule = import('./scripts/agent-vea-live-acceptance.ts')

async function main() {
  const { parseArgs, cleanupTestOutput } = await acceptanceModule
  const opts = parseArgs(['--mode', 'fresh', '--output-layout', 'root', '--output-dir', ${JSON.stringify(root)}, '--cleanup-test-output', 'before'])
  const cleanup = cleanupTestOutput(opts, 'before')
  console.log(JSON.stringify({
    exists: {
      unmanifested: fs.existsSync(${JSON.stringify(keepUnmanifested)}),
      registered: fs.existsSync(${JSON.stringify(deleteRegistered)}),
      missingMarker: fs.existsSync(${JSON.stringify(keepMissingMarker)}),
      outside: fs.existsSync(${JSON.stringify(outside)}),
    },
    cleanup,
  }))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`)

  assert.equal(report.exists.registered, false)
  assert.equal(report.exists.unmanifested, true)
  assert.equal(report.exists.missingMarker, true)
  assert.equal(report.exists.outside, true)
  assert.deepEqual(report.cleanup.deleted.map((item) => path.resolve(item)), [path.resolve(deleteRegistered)])
  const skippedByPath = new Map(report.cleanup.skipped.map((item) => [path.resolve(item.outputDir), item.reason]))
  assert.equal(skippedByPath.get(path.resolve(keepUnmanifested)), 'not_in_manifest')
  assert.equal(skippedByPath.get(path.resolve(keepMissingMarker)), 'missing_vea_marker')
  assert.equal(skippedByPath.get(path.resolve(outside)), 'outside_test_root')
})

test('VEA live acceptance includes cleanup results in the JSON debug report', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-vea-live-cleanup-report-'))
  const outputDir = path.join(root, 'registered-output')
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(path.join(outputDir, 'run_state.json'), '{}')
  fs.writeFileSync(path.join(root, '.ready-vea-test-manifest.json'), JSON.stringify({
    version: 1,
    testRoot: root,
    records: [{
      outputDir,
      url: 'https://example.test/video',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  }, null, 2))

  const report = runTsx(`
${fixtureSource()}
const acceptanceModule = import('./scripts/agent-vea-live-acceptance.ts')

async function main() {
  const { parseArgs, runAcceptance } = await acceptanceModule
  const root = ${JSON.stringify(root)}
  const opts = parseArgs(['--mode', 'fresh', '--output-layout', 'root', '--output-dir', root, '--cleanup-test-output', 'dry-run', '--json', '--wait-ms', '1000'])
  const deps = {
    makeAgentContext: () => agentContext,
    createRunner: async () => ({
      startSkillChildRun: async () => {
        writeComplete(path.join(root, 'fresh-output'))
        return launch(path.join(root, 'fresh-output'))
      },
      waitForSkillChildRunClose: async () => close(path.join(root, 'fresh-output')),
    }),
    completePendingHandoffs: async () => [],
    repairHandoffValidationErrors: async () => [],
  }
  const { report } = await runAcceptance(opts, deps)
  console.log(JSON.stringify({
    cleanupReports: report.debug.cleanupTestOutput,
    registeredStillExists: fs.existsSync(${JSON.stringify(outputDir)}),
  }))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`)

  assert.equal(report.registeredStillExists, true)
  assert.equal(report.cleanupReports.length, 2)
  assert.equal(report.cleanupReports[0].phase, 'before')
  assert.equal(report.cleanupReports[0].wouldDelete.map((item) => path.resolve(item)).includes(path.resolve(outputDir)), true)
  assert.equal(report.cleanupReports[1].phase, 'after')
})
