#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const DEFAULT_OUT_DIR = 'docs/superpowers/audits/2026-05-24-stage-z-closeout/evidence/agent-panel-video'
const DEFAULT_OUTPUT_ROOT = '/tmp/ready-stage-z-video-panel-acceptance'
const VEA_ACTION_TIMEOUT_MS = 3 * 60 * 60_000
const VIDEO_ACCEPTANCE_TIMEOUT_MARGIN_MS = 5 * 60_000
const DEFAULT_WAIT_MS = VEA_ACTION_TIMEOUT_MS + VIDEO_ACCEPTANCE_TIMEOUT_MARGIN_MS

const CASES = [
  {
    id: 'M1',
    analyzer: 'video-expert-analyzer',
    expectedTools: ['skill_video_expert_pipeline'],
    url: 'https://www.youtube.com/watch?v=xLAPpTflZmk',
  },
  {
    id: 'M2',
    analyzer: 'video-copy-analyzer',
    expectedTools: ['skill_video_copy_analyze'],
    url: 'https://www.youtube.com/watch?v=xLAPpTflZmk',
  },
  {
    id: 'M3',
    analyzer: 'video-expert-analyzer',
    expectedTools: ['skill_video_expert_pipeline'],
    url: 'https://www.youtube.com/watch?v=j9mSt9UpxGc&t=2s',
  },
  {
    id: 'M4',
    analyzer: 'video-copy-analyzer',
    expectedTools: ['skill_video_copy_analyze'],
    url: 'https://www.youtube.com/watch?v=j9mSt9UpxGc&t=2s',
  },
  {
    id: 'M5',
    analyzer: 'video-expert-analyzer',
    expectedTools: ['skill_video_expert_pipeline'],
    url: 'https://www.youtube.com/watch?v=6IcKMHlANtI',
  },
  {
    id: 'M6',
    analyzer: 'video-copy-analyzer',
    expectedTools: ['skill_video_copy_analyze'],
    url: 'https://www.youtube.com/watch?v=6IcKMHlANtI',
  },
  {
    id: 'M7',
    analyzer: 'video-expert-analyzer',
    expectedTools: ['skill_video_expert_pipeline'],
    url: 'https://www.youtube.com/watch?v=Kro93awjY_4',
  },
  {
    id: 'M8',
    analyzer: 'video-copy-analyzer',
    expectedTools: ['skill_video_copy_analyze'],
    url: 'https://www.youtube.com/watch?v=Kro93awjY_4',
  },
]

const options = parseArgs(process.argv.slice(2))
const outDir = resolve(options.outDir || DEFAULT_OUT_DIR)
const outputRoot = resolve(options.outputRoot || DEFAULT_OUTPUT_ROOT)
const selected = selectedCases()
mkdirSync(outDir, { recursive: true })
mkdirSync(outputRoot, { recursive: true })

const target = await findReadyTarget(options.port)
const client = await connectCdp(target.webSocketDebuggerUrl)
const report = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  target: { title: target.title, url: target.url },
  mode: 'agent-panel-test-mode',
  inputMode: 'dom',
  order: selected.map((item) => item.id),
  outputRoot,
  cases: [],
}

try {
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  await enableHarness(client)
  await waitForHarness(client)
  await captureScreenshot(client, join(outDir, 'agent-panel-video-start.png'))
  for (const caseDef of selected) {
    const result = await runVideoCase(client, caseDef, {
      outputRoot,
      waitMs: options.waitMs,
      pollMs: options.pollMs,
      outDir,
    })
    report.cases.push(result)
    writeReport(report, outDir)
    if (!result.ok && options.stopOnFailure) break
  }
  report.finishedAt = new Date().toISOString()
  report.ok = report.cases.length === selected.length && report.cases.every((item) => item.ok)
  writeReport(report, outDir)
  await captureScreenshot(client, join(outDir, 'agent-panel-video-after.png'))
  console.log(JSON.stringify({
    ok: report.ok,
    outDir,
    cases: report.cases.map((item) => ({
      id: item.id,
      ok: item.ok,
      analyzer: item.analyzer,
      observedToolNames: item.observedToolNames,
      terminalState: item.terminalState,
      diagnostics: item.diagnostics.map((diagnostic) => diagnostic.id),
    })),
  }, null, 2))
  process.exit(report.ok ? 0 : 1)
} finally {
  client.close()
}

function parseArgs(argv) {
  const parsed = {
    port: 9333,
    outDir: DEFAULT_OUT_DIR,
    outputRoot: DEFAULT_OUTPUT_ROOT,
    waitMs: DEFAULT_WAIT_MS,
    pollMs: 15_000,
    stopOnFailure: false,
    from: '',
    only: '',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--port') {
      parsed.port = Number(argv[++index] || parsed.port)
    } else if (arg === '--out-dir') {
      parsed.outDir = argv[++index] || parsed.outDir
    } else if (arg === '--output-root') {
      parsed.outputRoot = argv[++index] || parsed.outputRoot
    } else if (arg === '--wait-ms') {
      parsed.waitMs = Number(argv[++index] || parsed.waitMs)
    } else if (arg === '--poll-ms') {
      parsed.pollMs = Number(argv[++index] || parsed.pollMs)
    } else if (arg === '--stop-on-failure') {
      parsed.stopOnFailure = true
    } else if (arg === '--from') {
      parsed.from = argv[++index] || ''
    } else if (arg === '--only') {
      parsed.only = argv[++index] || ''
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  parsed.waitMs = Math.max(30_000, Number.isFinite(parsed.waitMs) ? parsed.waitMs : DEFAULT_WAIT_MS)
  parsed.pollMs = Math.max(1_000, Number.isFinite(parsed.pollMs) ? parsed.pollMs : 15_000)
  return parsed
}

function selectedCases() {
  if (options.only) {
    const wanted = new Set(options.only.split(',').map((item) => item.trim()).filter(Boolean))
    return CASES.filter((item) => wanted.has(item.id))
  }
  if (options.from) {
    const index = CASES.findIndex((item) => item.id === options.from)
    if (index >= 0) return CASES.slice(index)
  }
  return CASES
}

async function findReadyTarget(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = targets.find((item) => {
    const url = String(item.url || '')
    return item.type === 'page'
      && (
        /^http:\/\/localhost:\d+\//.test(url)
        || /^http:\/\/127\.0\.0\.1:\d+\//.test(url)
      )
  })
  if (!target?.webSocketDebuggerUrl) throw new Error('Ready renderer target not found.')
  return target
}

async function connectCdp(url) {
  const ws = new WebSocket(url)
  let nextId = 0
  const pending = new Map()
  const rejectPending = (error) => {
    for (const item of pending.values()) item.reject(error)
    pending.clear()
  }
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id).resolve(message)
      pending.delete(message.id)
    }
  })
  ws.addEventListener('close', () => {
    rejectPending(new Error('CDP WebSocket closed before the command completed.'))
  })
  ws.addEventListener('error', () => {
    rejectPending(new Error('CDP WebSocket failed before the command completed.'))
  })
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', resolveOpen, { once: true })
    ws.addEventListener('error', rejectOpen, { once: true })
  })
  return {
    send(method, params = {}) {
      return new Promise((resolveSend, rejectSend) => {
        const id = ++nextId
        pending.set(id, { resolve: resolveSend, reject: rejectSend })
        try {
          ws.send(JSON.stringify({ id, method, params }))
        } catch (error) {
          pending.delete(id)
          rejectSend(error)
        }
      })
    },
    close() {
      ws.close()
    },
  }
}

async function enableHarness(client) {
  await evaluate(client, [
    '(() => {',
    'const needsReload = !window.__READY_AGENT_TEST__',
    'localStorage.setItem("ready.agentPanelTest", "1")',
    'localStorage.setItem("ready:agent:test", "1")',
    'if (needsReload) setTimeout(() => location.reload(), 0)',
    'return true',
    '})()',
  ].join(';'))
}

async function waitForHarness(client) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 15_000) {
    const result = await evaluate(client, 'Boolean(window.__READY_AGENT_TEST__)')
    if (result === true) return
    await delay(250)
  }
  throw new Error('Agent panel test harness did not become available.')
}

async function runVideoCase(client, caseDef, runOptions) {
  const outputDir = join(runOptions.outputRoot, caseDef.id)
  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })
  const expression = `(${pageRunVideoCase.toString()})(${JSON.stringify({
    ...caseDef,
    outputDir,
    waitMs: runOptions.waitMs,
    pollMs: runOptions.pollMs,
  })})`
  const result = verifyCaseArtifacts(await evaluate(client, expression))
  await captureScreenshot(client, join(runOptions.outDir, `${caseDef.id}-${caseDef.analyzer}.png`))
  writeFileSync(
    join(runOptions.outDir, `${caseDef.id}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  )
  writeFileSync(
    join(runOptions.outDir, `${caseDef.id}.md`),
    renderCaseMarkdown(result),
  )
  return result
}

function verifyCaseArtifacts(result) {
  const diagnostics = Array.isArray(result.diagnostics) ? [...result.diagnostics] : []
  if (result.analyzer === 'video-copy-analyzer') {
    const files = existsSync(result.outputDir) ? readdirSync(result.outputDir) : []
    const required = [
      { id: 'copy_transcript_missing', suffix: '_文字稿.md', label: '文字稿' },
      { id: 'copy_analysis_report_missing', suffix: '_分析报告.md', label: '文案分析报告' },
      { id: 'copy_structured_transcript_missing', suffix: '_结构化文字稿.md', label: '结构化文字稿' },
    ]
    for (const item of required) {
      if (files.some((name) => name.endsWith(item.suffix))) continue
      diagnostics.push({
        id: item.id,
        severity: 'error',
        layer: 'artifact',
        message: `Video Copy Analyzer 缺少${item.label}产物。`,
        evidence: {
          outputDir: result.outputDir,
          expectedSuffix: item.suffix,
          files,
        },
      })
    }
    const progressCard = Array.isArray(result.taskCards)
      ? result.taskCards.find((card) => card.source === 'taskProjection' && card.progress)
      : null
    const progress = progressCard?.progress || null
    if (!progress) {
      diagnostics.push({
        id: 'copy_progress_missing',
        severity: 'error',
        layer: 'projection',
        message: 'Video Copy Analyzer 任务卡缺少进度细节。',
        evidence: {
          taskCards: result.taskCards,
        },
      })
    } else if (progress.completed !== progress.total || progress.total !== 5) {
      diagnostics.push({
        id: 'copy_progress_incomplete',
        severity: 'error',
        layer: 'projection',
        message: 'Video Copy Analyzer 任务卡进度没有显示完整流程完成。',
        evidence: {
          progress,
        },
      })
    }
  } else if (result.analyzer === 'video-expert-analyzer') {
    const outputDir = findVideoExpertOutputDir(result.outputDir)
    if (!outputDir) {
      diagnostics.push({
        id: 'vea_output_dir_missing',
        severity: 'error',
        layer: 'artifact',
        message: 'Video Expert Analyzer 缺少包含交付报告的输出目录。',
        evidence: {
          outputDir: result.outputDir,
          files: safeListFiles(result.outputDir),
        },
      })
    } else {
      const delivery = readJsonFile(join(outputDir, 'delivery_report.json'))
      if (!delivery) {
        diagnostics.push({
          id: 'vea_delivery_report_missing',
          severity: 'error',
          layer: 'artifact',
          message: 'Video Expert Analyzer 缺少 delivery_report.json。',
          evidence: { outputDir },
        })
      } else {
        const deliveryStatus = String(delivery.status || '').toLowerCase()
        if (!['completed', 'complete', 'success', 'done'].includes(deliveryStatus)) {
          diagnostics.push({
            id: 'vea_delivery_not_completed',
            severity: 'error',
            layer: 'artifact',
            message: 'Video Expert Analyzer 交付报告没有完成。',
            evidence: { outputDir, status: delivery.status },
          })
        }
        const requiredOutputs = delivery.required_outputs
        if (requiredOutputs && typeof requiredOutputs === 'object' && !Array.isArray(requiredOutputs)) {
          const failedOutputs = Object.entries(requiredOutputs)
            .filter(([, value]) => value && typeof value === 'object' && value.ok === false)
            .map(([key]) => key)
          if (failedOutputs.length > 0) {
            diagnostics.push({
              id: 'vea_required_outputs_failed',
              severity: 'error',
              layer: 'artifact',
              message: 'Video Expert Analyzer 有交付产物未通过校验。',
              evidence: { outputDir, failedOutputs },
            })
          }
        }
      }

      const handoffReceipt = readJsonFile(join(outputDir, 'audiovisual_handoff', 'receipt.json'))
      if (!handoffReceipt) {
        diagnostics.push({
          id: 'vea_handoff_receipt_missing',
          severity: 'error',
          layer: 'artifact',
          message: 'Video Expert Analyzer 缺少视听剖析 handoff receipt。',
          evidence: { outputDir },
        })
      } else {
        const tasks = handoffReceipt.tasks && typeof handoffReceipt.tasks === 'object'
          ? Object.entries(handoffReceipt.tasks)
          : []
        const incomplete = tasks
          .filter(([, value]) => !value || typeof value !== 'object' || value.status !== 'completed')
          .map(([key, value]) => ({ task: key, status: value?.status || null }))
        if (tasks.length === 0 || incomplete.length > 0) {
          diagnostics.push({
            id: 'vea_handoff_incomplete',
            severity: 'error',
            layer: 'runtime',
            message: 'Video Expert Analyzer 视听剖析 handoff 没有全部完成。',
            evidence: { outputDir, incomplete, taskCount: tasks.length },
          })
        }
      }
    }

    const progressCard = Array.isArray(result.taskCards)
      ? result.taskCards.find((card) => card.source === 'taskProjection' && card.progress)
      : null
    const progress = progressCard?.progress || null
    if (!progress) {
      diagnostics.push({
        id: 'vea_progress_missing',
        severity: 'error',
        layer: 'projection',
        message: 'Video Expert Analyzer 任务卡缺少进度细节。',
        evidence: { taskCards: result.taskCards },
      })
    } else if (progress.stage !== 'completed' || progress.completed !== progress.total || !(progress.total > 0)) {
      diagnostics.push({
        id: 'vea_progress_incomplete',
        severity: 'error',
        layer: 'projection',
        message: 'Video Expert Analyzer 任务卡进度没有显示完整流程完成。',
        evidence: { progress },
      })
    }
  }
  return {
    ...result,
    diagnostics,
    ok: diagnostics.every((item) => item.severity !== 'error'),
  }
}

function safeListFiles(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function isVideoExpertOutputDir(dir) {
  return existsSync(join(dir, 'run_state.json'))
    && existsSync(join(dir, 'scene_scores.json'))
    && existsSync(join(dir, 'delivery_report.json'))
}

function newestDirectory(candidates) {
  return candidates
    .map((dir) => {
      try {
        return { dir, mtimeMs: statSync(join(dir, 'run_state.json')).mtimeMs }
      } catch {
        return { dir, mtimeMs: 0 }
      }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.dir || null
}

function findVideoExpertOutputDir(root) {
  if (!root || !existsSync(root)) return null
  if (isVideoExpertOutputDir(root)) return root
  const candidates = safeListFiles(root)
    .map((name) => join(root, name))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory() && isVideoExpertOutputDir(dir)
      } catch {
        return false
      }
    })
  return newestDirectory(candidates)
}

async function evaluate(client, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (response.error) {
    throw new Error(response.error.message || 'Runtime.evaluate failed.')
  }
  const result = response.result || {}
  if (result.exceptionDetails) {
    const exception = result.exceptionDetails.exception || {}
    throw new Error(exception.description || result.exceptionDetails.text || 'Runtime.evaluate failed.')
  }
  return result.result?.value
}

async function captureScreenshot(client, path) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const data = result.result?.data
  if (!data) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.from(data, 'base64'))
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function writeReport(report, outDir) {
  writeFileSync(join(outDir, 'agent-panel-video-acceptance.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(outDir, 'agent-panel-video-acceptance.md'), renderReportMarkdown(report))
}

function renderReportMarkdown(report) {
  const lines = [
    '# Agent Panel Video Acceptance',
    '',
    `- overall: ${report.ok ? 'pass' : 'fail'}`,
    `- mode: ${report.mode}`,
    `- inputMode: ${report.inputMode}`,
    `- outputRoot: ${report.outputRoot}`,
    '',
    '## Cases',
    '',
    '| ID | Analyzer | Status | Tools | Terminal | Output |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const item of report.cases) {
    lines.push(`| ${item.id} | ${item.analyzer} | ${item.ok ? 'pass' : 'fail'} | ${item.observedToolNames.join(', ') || 'none'} | ${item.terminalState} | ${item.outputDir} |`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

function renderCaseMarkdown(item) {
  const lines = [
    `# Agent Panel Video Acceptance ${item.id}`,
    '',
    `- status: ${item.ok ? 'pass' : 'fail'}`,
    `- analyzer: ${item.analyzer}`,
    `- url: ${item.url}`,
    `- outputDir: ${item.outputDir}`,
    `- inputMode: ${item.inputMode}`,
    `- observedToolNames: ${item.observedToolNames.join(', ') || 'none'}`,
    `- terminalState: ${item.terminalState}`,
    `- diagnostics: ${item.diagnostics.map((diagnostic) => diagnostic.id).join(', ') || 'none'}`,
    '',
    '## Assistant',
    '',
    '```',
    item.assistantMessages.join('\n---\n'),
    '```',
    '',
    '## Task Cards',
    '',
    '```json',
    JSON.stringify(item.taskCards, null, 2),
    '```',
    '',
  ]
  return lines.join('\n')
}

async function pageRunVideoCase(input) {
  const harness = window.__READY_AGENT_TEST__
  if (!harness) throw new Error('missing __READY_AGENT_TEST__')
  await harness.newSession()
  harness.clearEvents()
  const prompt = buildPrompt(input)
  const submit = await harness.submit(prompt, {
    mode: 'dom',
    timeoutMs: input.waitMs,
    pollMs: input.pollMs,
    expectedToolNames: input.expectedTools,
  })
  const terminal = await waitForVideoTerminal(harness, {
    waitMs: input.waitMs,
    pollMs: input.pollMs,
    expectedTools: input.expectedTools,
  })
  const snapshot = terminal.snapshot
  const observedToolNames = Array.from(new Set(snapshot.toolTrace
    .filter((item) => item.kind === 'call')
    .map((item) => {
      const match = String(item.text || '').trim().match(/^([a-zA-Z0-9_:-]+)\s*(?:\(|:)/)
      return match?.[1] || null
    })
    .filter(Boolean)))
  const diagnostics = [
    ...submit.diagnostics,
    ...terminal.diagnostics,
  ].map(downgradeExpectedBackgroundDiagnostic)
  for (const expectedTool of input.expectedTools || []) {
    if (observedToolNames.includes(expectedTool)) continue
    diagnostics.push({
      id: 'expected_tool_not_called',
      severity: 'error',
      layer: 'tool',
      message: `Expected ${expectedTool} to be called.`,
      evidence: { expectedTool, observedToolNames },
    })
  }
  if (snapshot.taskCards.some((card) => ['failed', 'failed_no_background_alive'].includes(card.visualState))) {
    diagnostics.push({
      id: 'task_card_failed',
      severity: 'error',
      layer: 'projection',
      message: 'Video analyzer task card is failed.',
      evidence: {
        taskCards: snapshot.taskCards.map(summarizeTaskCard),
      },
    })
  }
  if (!terminal.complete) {
    diagnostics.push({
      id: terminal.timedOut ? 'video_flow_timeout' : 'video_flow_not_complete',
      severity: 'error',
      layer: 'runtime',
      message: terminal.reason,
      evidence: {
        activeRun: snapshot.runtime.activeRun,
        taskCards: snapshot.taskCards.map(summarizeTaskCard),
      },
    })
  }
  const assistantMessages = snapshot.messages
    .filter((message) => message.type !== 'user' && message.type !== 'ask_user_questions')
    .map((message) => String(message.content || '').slice(0, 2000))
  return {
    id: input.id,
    analyzer: input.analyzer,
    url: input.url,
    outputDir: input.outputDir,
    prompt,
    ok: diagnostics.every((item) => item.severity !== 'error'),
    inputMode: submit.inputMode,
    observedToolNames,
    terminalState: terminal.state,
    diagnostics,
    taskCards: snapshot.taskCards.map(summarizeTaskCard),
    infoCards: snapshot.infoCards,
    assistantMessages,
    events: harness.events(),
  }

  function downgradeExpectedBackgroundDiagnostic(diagnostic) {
    if (
      diagnostic.id === 'tool_result_failure'
      && /\/\.ready\/child-runs\/[^/\s]+\.jsonl/.test(String(diagnostic.evidence?.text || ''))
      && /not inside any of the allowed roots/i.test(String(diagnostic.evidence?.text || ''))
    ) {
      return {
        ...diagnostic,
        severity: 'warning',
        message: `${diagnostic.message}（后台子任务 ledger 读取被沙箱拒绝，作为面板噪声记录，不作为视频任务完成度判定。）`,
      }
    }
    if (
      diagnostic.id === 'tool_result_failure'
      && /skill_inspect_run_state/i.test(String(diagnostic.evidence?.text || ''))
      && /Detached task .* not found/i.test(String(diagnostic.evidence?.text || ''))
    ) {
      return {
        ...diagnostic,
        severity: 'warning',
        message: `${diagnostic.message}（后台子任务刚启动时 run_state 索引可能尚未可查，继续观察任务卡和最终产物。）`,
      }
    }
    if (
      diagnostic.id === 'tool_result_failure'
      && /skill_read_artifact/i.test(String(diagnostic.evidence?.text || ''))
      && /Artifact not found: (?:run_state\.json|scene_scores\.json|delivery_report\.json)|relativePath must be a non-empty string/i.test(String(diagnostic.evidence?.text || ''))
    ) {
      return {
        ...diagnostic,
        severity: 'warning',
        message: `${diagnostic.message}（后台视频任务的中间产物尚未就绪，继续以任务卡进度和最终交付文件判定。）`,
      }
    }
    if (diagnostic.id === 'non_done_terminal_reason' && diagnostic.evidence?.terminalReason === 'checkpoint_background') {
      return {
        ...diagnostic,
        severity: 'info',
      }
    }
    return diagnostic
  }

  function buildPrompt(definition) {
    const name = definition.analyzer === 'video-expert-analyzer'
      ? 'Video Expert Analyzer'
      : 'Video Copy Analyzer'
    return [
      `用 ${name} 分析这个 YouTube 视频，必须完整跑完一次流程并保留产物：${definition.url}`,
      `输出目录必须使用：${definition.outputDir}`,
      definition.analyzer === 'video-copy-analyzer'
        ? 'Video Copy Analyzer 必须产出文字稿、文案分析报告、结构化文字稿三类文件；只生成字幕或文字稿不算完成。'
        : '',
      '请走 Ready agent 的技能工具链，不要改用普通网页搜索，不要只口头总结。',
      '每个步骤都由你自己继续推进；不要停在等待我确认，也不要留下后台任务未完成就说完成。',
      '最终只需要告诉我是否完成、调用了哪个分析器、最终报告或主要产物路径。',
    ].filter(Boolean).join('\n')
  }

  async function waitForVideoTerminal(harnessApi, options) {
    const startedAt = Date.now()
    let lastSnapshot = await harnessApi.snapshot()
    while (Date.now() - startedAt < options.waitMs) {
      lastSnapshot = await harnessApi.snapshot()
      const state = classifyTerminal(lastSnapshot, options.expectedTools)
      if (state.complete || state.failed) {
        return {
          ...state,
          snapshot: lastSnapshot,
          diagnostics: state.failed
            ? [
              ...state.diagnostics,
              {
                id: 'video_task_failed',
                severity: 'error',
                layer: 'runtime',
                message: state.reason,
                evidence: { taskCards: lastSnapshot.taskCards.map(summarizeTaskCard) },
              },
            ]
            : [],
        }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, options.pollMs))
    }
    return {
      complete: false,
      failed: false,
      timedOut: true,
      state: 'timeout',
      reason: 'Video analyzer flow did not reach a completed terminal state before timeout.',
      snapshot: lastSnapshot,
      diagnostics: [],
    }
  }

  function classifyTerminal(snapshot, expectedTools) {
    const snapshotDiagnostics = (snapshot.diagnostics || []).map(downgradeExpectedBackgroundDiagnostic)
    const hardDiagnostic = snapshotDiagnostics.find((diagnostic) => diagnostic.severity === 'error')
    if (hardDiagnostic) {
      return {
        complete: false,
        failed: true,
        timedOut: false,
        state: 'failed',
        reason: hardDiagnostic.message || `Agent panel diagnostic failed: ${hardDiagnostic.id}`,
        diagnostics: snapshotDiagnostics,
      }
    }
    const activeRun = snapshot.runtime?.activeRun || null
    if (activeRun?.error || activeRun?.phase === 'error') {
      return {
        complete: false,
        failed: true,
        timedOut: false,
        state: 'failed',
        reason: activeRun.error || activeRun.blockedReason || 'Agent run entered error state.',
        diagnostics: snapshotDiagnostics,
      }
    }
    if (
      activeRun?.terminalReason
      && activeRun.terminalReason !== 'done'
      && activeRun.terminalReason !== 'checkpoint_background'
    ) {
      return {
        complete: false,
        failed: true,
        timedOut: false,
        state: activeRun.terminalReason,
        reason: activeRun.error || activeRun.blockedReason || `Agent run stopped with ${activeRun.terminalReason}.`,
        diagnostics: snapshotDiagnostics,
      }
    }
    const observedTools = Array.from(new Set(snapshot.toolTrace
      .filter((item) => item.kind === 'call')
      .map((item) => {
        const match = String(item.text || '').trim().match(/^([a-zA-Z0-9_:-]+)\s*(?:\(|:)/)
        return match?.[1] || null
      })
      .filter(Boolean)))
    const expectedCalled = (expectedTools || []).every((toolName) => observedTools.includes(toolName))
    const cards = snapshot.taskCards || []
    const failedCard = cards.find((card) => ['failed', 'failed_no_background_alive'].includes(card.visualState))
    if (failedCard) {
      return {
        complete: false,
        failed: true,
        timedOut: false,
        state: 'failed',
        reason: failedCard.error || failedCard.summary || 'Video analyzer task card failed.',
        diagnostics: snapshotDiagnostics,
      }
    }
    const busyCard = cards.find((card) =>
      ['running', 'background_running', 'budget_paused', 'waiting_input', 'waiting_handoff'].includes(card.visualState),
    )
    if (busyCard) {
      return {
        complete: false,
        failed: false,
        timedOut: false,
        state: busyCard.visualState || 'running',
        reason: busyCard.summary || busyCard.title || 'Video analyzer still running.',
        diagnostics: snapshotDiagnostics,
      }
    }
    const doneCard = cards.find((card) => card.visualState === 'done' || card.phase === 'done' || card.status === 'completed')
    const assistantText = snapshot.messages
      .filter((message) => message.type !== 'user')
      .map((message) => String(message.content || ''))
      .join('\n')
    const artifactVisible = snapshot.infoCards.some((card) => card.kind === 'recent_artifact')
      || cards.some((card) => Array.isArray(card.recentArtifacts) && card.recentArtifacts.length > 0)
      || /报告|report|产物|output|\.md|\.pdf|run_state\.json/i.test(assistantText)
    if (
      expectedCalled
      && doneCard
      && artifactVisible
      && !snapshot.runtime.foregroundBusy
      && !snapshot.composer.locked
    ) {
      return {
        complete: true,
        failed: false,
        timedOut: false,
        state: 'done',
        reason: 'Video analyzer reached done state with visible artifact evidence.',
        diagnostics: snapshotDiagnostics,
      }
    }
    return {
      complete: false,
      failed: false,
      timedOut: false,
      state: 'observing',
      reason: 'Waiting for expected tool, done task card, and artifact evidence.',
      diagnostics: snapshotDiagnostics,
    }
  }

  function summarizeTaskCard(card) {
    return {
      source: card.source,
      title: card.title,
      summary: card.summary,
      phase: card.phase,
      status: card.status,
      terminalReason: card.terminalReason,
      waitingFor: card.waitingFor,
      visualState: card.visualState,
      statusLabel: card.statusLabel,
      error: card.error,
      progress: card.progress,
      recentArtifacts: card.recentArtifacts,
      continuation: card.continuation,
      updatedAt: card.updatedAt,
    }
  }
}
