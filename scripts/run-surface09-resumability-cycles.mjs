#!/usr/bin/env node

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const DEFAULT_OUT_DIR = 'docs/superpowers/audits/2026-05-24-stage-z-closeout/evidence/surface-09-task-card-resume-strict-final'
const DEFAULT_USER_DATA_DIR = '/private/tmp/ready-stage-z-surface09-resumability-userdata'
const DEFAULT_WORKSPACE_ROOT = '/tmp/ready-stage-z-surface09-resumability/workspaces/current'

const SCENARIOS = {
  clean: {
    label: 'clean restart',
    mode: 'browser_close',
  },
  sigkill: {
    label: 'kill -9',
    mode: 'sigkill',
  },
  sigterm: {
    label: 'forced quit',
    mode: 'sigterm',
  },
}

const options = parseArgs(process.argv.slice(2))
const outDir = resolve(options.outDir)
const userDataDir = resolve(options.userDataDir)
const workspaceRoot = resolve(options.workspaceRoot)
const runStamp = new Date().toISOString().replace(/[:.]/g, '-')
const reportPath = join(outDir, `surface-09-skills-center-resumability-stage-z-cycles-${runStamp}.json`)

mkdirSync(outDir, { recursive: true })
mkdirSync(workspaceRoot, { recursive: true })

const report = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  mode: 'agent-panel-test-mode',
  inputMode: 'dom',
  port: options.port,
  userDataDir,
  workspaceRoot,
  scenarios: [],
}

try {
  for (const name of options.scenarios) {
    const result = await runScenario(name)
    report.scenarios.push(result)
    writeReport()
    if (!result.ok && options.stopOnFailure) break
  }
  report.finishedAt = new Date().toISOString()
  report.ok = report.scenarios.length === options.scenarios.length
    && report.scenarios.every((item) => item.ok)
  writeReport()
  console.log(JSON.stringify({
    ok: report.ok,
    reportPath,
    scenarios: report.scenarios.map((item) => ({
      name: item.name,
      ok: item.ok,
      childRunId: item.childRunId,
      restartObservedStatus: item.restart?.matchingChildRun?.status || null,
      resumeSuccess: item.resume?.success ?? null,
      artifactSurvived: item.artifactSurvived,
    })),
  }, null, 2))
  process.exit(report.ok ? 0 : 1)
} catch (error) {
  report.finishedAt = new Date().toISOString()
  report.ok = false
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  writeReport()
  throw error
}

async function runScenario(name) {
  const config = SCENARIOS[name]
  if (!config) throw new Error(`Unknown scenario: ${name}`)
  const scenarioStamp = `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const fixture = createProbeFixture(scenarioStamp)
  const result = {
    name,
    label: config.label,
    terminationMode: config.mode,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: false,
    fixture,
    childRunId: null,
    preTermination: null,
    termination: null,
    restart: null,
    resume: null,
    artifactSurvived: false,
    logs: [],
  }

  let app = null
  try {
    app = await startReadyApp(`${name}:initial`)
    const start = await startProbeRun(fixture)
    result.preTermination = start
    result.childRunId = start.matchingChildRun?.childRunId || null
    if (!result.childRunId) {
      throw new Error(`${name}: child run did not start`)
    }

    result.termination = await terminateReadyApp(app, config.mode)
    app = null

    app = await startReadyApp(`${name}:restart`)
    const restart = await inspectAfterRestart(fixture, result.childRunId)
    result.restart = restart
    result.artifactSurvived = verifyArtifactSurvival(fixture, restart)
    result.resume = await resumeProbeRun(restart)

    result.ok = Boolean(
      result.childRunId
      && restart.matchingChildRun
      && restart.visibleTaskCard
      && restart.visibleTaskCard.canResume === true
      && restart.visibleTaskCard.statusLabel !== '已完成'
      && result.artifactSurvived
      && result.resume?.success === true,
    )
    return result
  } catch (error) {
    result.error = error instanceof Error ? error.stack || error.message : String(error)
    return result
  } finally {
    result.finishedAt = new Date().toISOString()
    if (app) {
      await terminateReadyApp(app, 'sigterm').catch(() => null)
    }
  }
}

function createProbeFixture(scenarioStamp) {
  const probeName = `surface09-cycle-${scenarioStamp}`
  const probeDir = join(workspaceRoot, probeName)
  mkdirSync(join(probeDir, 'frames'), { recursive: true })
  mkdirSync(join(probeDir, 'scenes'), { recursive: true })
  const sceneScoresPath = join(probeDir, 'scene_scores.json')
  const runStatePath = join(probeDir, 'run_state.json')
  const framePath = join(probeDir, 'frames', 'scene_001.png')
  const sceneVideoPath = join(probeDir, 'scenes', 'scene_001.mp4')
  writeFileSync(sceneVideoPath, 'surface09 resumability probe scene placeholder\n', 'utf8')
  writeFileSync(
    framePath,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'),
  )
  writeFileSync(sceneScoresPath, `${JSON.stringify({
    video_id: probeName,
    title: 'Surface09 Resumability Probe',
    scenes: [{
      scene_number: 1,
      start_time: 0,
      end_time: 3,
      timestamp_range: '00:00:00,000 --> 00:00:03,000',
      caption: '测试场景',
      filename: 'scene_001.mp4',
      file_path: sceneVideoPath,
      frame_path: framePath,
      frame_samples: {
        primary: framePath,
        start: framePath,
        mid: framePath,
        end: framePath,
      },
      type_classification: 'TYPE-A Hook',
      description: '用于 Surface09 重启续跑验证的完整测试场景。',
      visual_summary: '静态测试画面。',
      scores: {
        aesthetic_beauty: 8,
        credibility: 8,
        impact: 8,
        memorability: 8,
        fun_interest: 8,
      },
      selection_reasoning: '测试夹具已补全评分字段。',
      edit_suggestion: '无需剪辑，仅用于续跑验证。',
      storyboard: {
        shot_size: '特写',
        lighting: '均匀光',
        camera_movement: '静止',
        visual_style: '测试图',
        technique: '无',
        screenshot_path: framePath,
      },
      weighted_score: 8,
      selection: '[USABLE]',
    }],
  }, null, 2)}\n`, 'utf8')
  writeFileSync(runStatePath, `${JSON.stringify({
    version: 'vnext',
    status: 'running',
    current_stage: 'score_batches',
    total_scenes: 1,
    completed_scenes: 0,
    scene_scores_path: 'scene_scores.json',
    video_dir: probeDir,
  }, null, 2)}\n`, 'utf8')
  return { probeName, probeDir, runStatePath, sceneScoresPath }
}

async function startProbeRun(fixture) {
  const client = await connectToReady()
  try {
    await enableHarness(client)
    const prompt = [
      '请加载并使用 video-expert-analyzer skill，继续这个已经中断的 VEA 任务：',
      fixture.runStatePath,
      '请先检查 run_state，然后直接继续 score_batches，不要向用户提问。',
      '这是 Surface09 重启续跑验证，请让后台子任务启动并保留可续跑句柄。',
    ].join('\n')
    return await evaluate(client, `
      (${pageStartProbeRun.toString()})(${JSON.stringify({
        workspaceRoot,
        prompt,
        probeName: fixture.probeName,
        waitMs: options.childStartWaitMs,
        pollMs: options.pollMs,
      })})
    `)
  } finally {
    client.close()
  }
}

async function inspectAfterRestart(fixture, childRunId) {
  const client = await connectToReady()
  try {
    await enableHarness(client)
    const inspection = await evaluate(client, `
      (${pageInspectAfterRestart.toString()})(${JSON.stringify({
        childRunId,
        probeName: fixture.probeName,
      })})
    `)
    if (inspection?.visibleTaskCard) {
      const screenshotPath = join(outDir, `${fixture.probeName}-after-restart.png`)
      const screenshot = await client.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      }).catch(() => null)
      const data = screenshot?.result?.data
      if (data) {
        writeFileSync(screenshotPath, Buffer.from(data, 'base64'))
        inspection.screenshotPath = screenshotPath
      }
    }
    return inspection
  } finally {
    client.close()
  }
}

async function resumeProbeRun(restart) {
  if (!restart?.visibleTaskCard) {
    return { success: false, error: 'visible task card missing' }
  }
  const client = await connectToReady()
  try {
    await enableHarness(client)
    return await evaluate(client, `
      (${pageResumeProbeRun.toString()})(${JSON.stringify({
        scopeId: restart.visibleTaskCard.scopeId,
        taskId: restart.visibleTaskCard.taskId,
        childRunId: restart.visibleTaskCard.continuation?.childRunId || restart.matchingChildRun?.childRunId || null,
        waitMs: options.resumeWaitMs,
      })})
    `)
  } finally {
    client.close()
  }
}

function verifyArtifactSurvival(fixture, restart) {
  const outputDir = restart?.matchingChildRun?.outputDir || restart?.visibleTaskCard?.continuation?.outputDir || fixture.probeDir
  const runStatePath = restart?.matchingChildRun?.runStatePath || restart?.visibleTaskCard?.continuation?.runStatePath || fixture.runStatePath
  return Boolean(
    outputDir
    && runStatePath
    && existsSync(outputDir)
    && existsSync(runStatePath)
    && statSync(outputDir).isDirectory()
    && statSync(runStatePath).isFile()
  )
}

async function startReadyApp(label) {
  const child = spawn('npm', ['run', 'dev'], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      READY_USER_DATA_DIR: userDataDir,
      READY_REMOTE_DEBUGGING_PORT: String(options.port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.unref()
  const logs = []
  child.stdout.on('data', (chunk) => pushLog(logs, chunk))
  child.stderr.on('data', (chunk) => pushLog(logs, chunk))
  child.on('error', (error) => pushLog(logs, `spawn error: ${error.stack || error.message}`))
  const exitPromise = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  const ready = waitForReadyTarget(options.startWaitMs)
  const first = await Promise.race([
    ready.then(() => ({ ready: true })),
    exitPromise.then((exit) => ({ ready: false, exit })),
  ])
  if (!first.ready) {
    throw new Error(`${label}: Ready dev process exited before renderer target appeared: ${JSON.stringify(first.exit)}\n${logs.slice(-80).join('\n')}`)
  }
  return { label, child, logs }
}

async function terminateReadyApp(app, mode) {
  const result = {
    mode,
    startedAt: new Date().toISOString(),
    exited: false,
    exitCode: null,
    signal: null,
  }
  if (mode === 'browser_close') {
    await browserClose().catch((error) => {
      result.browserCloseError = error instanceof Error ? error.message : String(error)
    })
  } else {
    const signal = mode === 'sigkill' ? 'SIGKILL' : 'SIGTERM'
    try {
      process.kill(-app.child.pid, signal)
    } catch (error) {
      result.killError = error instanceof Error ? error.message : String(error)
    }
  }
  const exit = await waitForExit(app.child, options.exitWaitMs)
  result.exited = exit.exited
  result.exitCode = exit.code
  result.signal = exit.signal
  result.finishedAt = new Date().toISOString()
  result.logTail = app.logs.slice(-120)
  if (!exit.exited) {
    try {
      process.kill(-app.child.pid, 'SIGKILL')
    } catch {
      // best effort cleanup
    }
    await waitForExit(app.child, 5_000)
  }
  return result
}

async function browserClose() {
  const version = await fetchJson(`http://127.0.0.1:${options.port}/json/version`)
  if (!version.webSocketDebuggerUrl) throw new Error('browser websocket missing')
  const client = await connectWebSocket(version.webSocketDebuggerUrl)
  try {
    await client.send('Browser.close')
  } finally {
    client.close()
  }
}

async function connectToReady() {
  const startedAt = Date.now()
  let lastError = null
  while (Date.now() - startedAt < options.startWaitMs) {
    let client = null
    try {
      const target = await waitForReadyTarget(5_000)
      client = await connectWebSocket(target.webSocketDebuggerUrl)
      await client.send('Runtime.enable')
      await client.send('Page.enable').catch(() => null)
      return client
    } catch (error) {
      lastError = error
      client?.close?.()
      await delay(500)
    }
  }
  throw new Error(`Ready CDP connection did not stabilize after ${options.startWaitMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function waitForReadyTarget(timeoutMs) {
  const startedAt = Date.now()
  let lastError = null
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${options.port}/json/list`)
      const target = targets.find((item) => {
        const url = String(item.url || '')
        return item.type === 'page'
          && /localhost:5173\/?$/.test(url)
          && !/browser-fastcard-overlay/.test(url)
      })
      if (target?.webSocketDebuggerUrl) return target
    } catch (error) {
      lastError = error
    }
    await delay(500)
  }
  throw new Error(`Ready renderer target not found after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`)
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
  const startedAt = Date.now()
  while (Date.now() - startedAt < 15_000) {
    const ready = await evaluate(client, 'Boolean(window.__READY_AGENT_TEST__?.snapshot)').catch(() => false)
    if (ready === true) return
    await delay(250)
  }
  throw new Error('Agent panel test harness did not become available')
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails || result.result?.exceptionDetails) {
    const details = result.exceptionDetails || result.result.exceptionDetails
    throw new Error(details.exception?.description || details.text || 'Runtime.evaluate failed')
  }
  const value = result.result?.value ?? result.result?.result?.value
  return typeof value === 'string' ? JSON.parse(value) : value
}

async function connectWebSocket(url) {
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
  ws.addEventListener('close', () => rejectPending(new Error('CDP websocket closed')))
  ws.addEventListener('error', () => rejectPending(new Error('CDP websocket failed')))
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

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`)
  return response.json()
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exited: true, code: child.exitCode, signal: child.signalCode }
  }
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolveWait({ exited: false, code: child.exitCode, signal: child.signalCode })
    }, timeoutMs)
    const onExit = (code, signal) => {
      clearTimeout(timer)
      resolveWait({ exited: true, code, signal })
    }
    child.once('exit', onExit)
  })
}

function pushLog(logs, chunk) {
  const text = String(chunk)
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) logs.push(line)
  }
  if (logs.length > 400) logs.splice(0, logs.length - 400)
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function writeReport() {
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function parseArgs(argv) {
  const parsed = {
    scenarios: Object.keys(SCENARIOS),
    port: 9335,
    outDir: DEFAULT_OUT_DIR,
    userDataDir: DEFAULT_USER_DATA_DIR,
    workspaceRoot: DEFAULT_WORKSPACE_ROOT,
    startWaitMs: 60_000,
    childStartWaitMs: 45_000,
    resumeWaitMs: 10_000,
    exitWaitMs: 12_000,
    pollMs: 500,
    stopOnFailure: false,
    cleanUserData: true,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--scenario') {
      const value = argv[++index] || ''
      parsed.scenarios = value === 'all'
        ? Object.keys(SCENARIOS)
        : value.split(',').map((item) => item.trim()).filter(Boolean)
    } else if (arg === '--port') {
      parsed.port = Number(argv[++index] || parsed.port)
    } else if (arg === '--out-dir') {
      parsed.outDir = argv[++index] || parsed.outDir
    } else if (arg === '--user-data-dir') {
      parsed.userDataDir = argv[++index] || parsed.userDataDir
    } else if (arg === '--workspace-root') {
      parsed.workspaceRoot = argv[++index] || parsed.workspaceRoot
    } else if (arg === '--start-wait-ms') {
      parsed.startWaitMs = Number(argv[++index] || parsed.startWaitMs)
    } else if (arg === '--child-start-wait-ms') {
      parsed.childStartWaitMs = Number(argv[++index] || parsed.childStartWaitMs)
    } else if (arg === '--resume-wait-ms') {
      parsed.resumeWaitMs = Number(argv[++index] || parsed.resumeWaitMs)
    } else if (arg === '--exit-wait-ms') {
      parsed.exitWaitMs = Number(argv[++index] || parsed.exitWaitMs)
    } else if (arg === '--poll-ms') {
      parsed.pollMs = Number(argv[++index] || parsed.pollMs)
    } else if (arg === '--stop-on-failure') {
      parsed.stopOnFailure = true
    } else if (arg === '--keep-user-data') {
      parsed.cleanUserData = false
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  for (const scenario of parsed.scenarios) {
    if (!SCENARIOS[scenario]) throw new Error(`Unknown scenario: ${scenario}`)
  }
  if (parsed.cleanUserData) {
    rmSync(resolve(parsed.userDataDir), { recursive: true, force: true })
  }
  return parsed
}

function pageStartProbeRun(input) {
  const h = window.__READY_AGENT_TEST__
  if (!h) throw new Error('missing __READY_AGENT_TEST__')
  return (async () => {
    await h.prepareWorkspace(input.workspaceRoot, { reindex: false })
    const visibleSession = await h.createVisibleSession()
    const submit = await h.submit(input.prompt, {
      waitForIdle: false,
      timeoutMs: 2_000,
      allowStoreFallback: true,
    })
    const observations = []
    const startedAt = Date.now()
    let matchingChildRun = null
    let matchingTaskCard = null
    while (Date.now() - startedAt < input.waitMs) {
      const snap = await h.snapshot()
      const activeChildRuns = await window.electronAPI.agent.listActiveChildRuns()
      const rows = Array.isArray(activeChildRuns?.data) ? activeChildRuns.data : []
      matchingChildRun = rows.find((run) => [
        run?.outputDir,
        run?.runStatePath,
        run?.sceneScoresPath,
      ].some((value) => String(value || '').includes(input.probeName))) || null
      matchingTaskCard = snap.taskCards.find((card) => [
        card?.continuation?.outputDir,
        card?.continuation?.runStatePath,
        JSON.stringify(card?.recentArtifacts || []),
      ].some((value) => String(value || '').includes(input.probeName))) || null
      observations.push({
        at: new Date().toISOString(),
        currentScopeId: snap.currentScopeId,
        composer: snap.composer,
        runtime: snap.runtime,
        matchingChildRun,
        matchingTaskCard,
        taskCards: snap.taskCards.slice(0, 6),
      })
      if (matchingChildRun?.status === 'running' || matchingTaskCard?.visualState === 'running') break
      if (matchingChildRun || matchingTaskCard) break
      await new Promise((resolve) => setTimeout(resolve, input.pollMs))
    }
    return {
      visibleSession,
      submit,
      matchingChildRun,
      matchingTaskCard,
      observations,
      sessionSummary: h.sessionSummary(),
    }
  })()
}

function pageInspectAfterRestart(input) {
  const h = window.__READY_AGENT_TEST__
  if (!h) throw new Error('missing __READY_AGENT_TEST__')
  return (async () => {
    const summary = h.sessionSummary()
    const activationAttempts = []
    for (const session of summary.sessions) {
      if (!session.conversationId) continue
      const activated = await h.activateSession(session.id)
      activationAttempts.push(activated)
      const found = findVisibleTask(await h.snapshot(), input)
      if (found.visibleTaskCard) {
        const activeChildRuns = await window.electronAPI.agent.listActiveChildRuns()
        return {
          summaryBefore: summary,
          activationAttempts,
          activeChildRuns,
          matchingChildRun: findMatchingChildRun(activeChildRuns, input),
          ...found,
        }
      }
    }
    const activeChildRuns = await window.electronAPI.agent.listActiveChildRuns()
    const snap = await h.snapshot()
    return {
      summaryBefore: summary,
      activationAttempts,
      activeChildRuns,
      matchingChildRun: findMatchingChildRun(activeChildRuns, input),
      ...findVisibleTask(snap, input),
    }
  })()

  function findMatchingChildRun(activeChildRuns, input) {
    const rows = Array.isArray(activeChildRuns?.data) ? activeChildRuns.data : []
    return rows.find((run) => run?.childRunId === input.childRunId || [
      run?.outputDir,
      run?.runStatePath,
      run?.sceneScoresPath,
    ].some((value) => String(value || '').includes(input.probeName))) || null
  }

  function findVisibleTask(snap, input) {
    const visibleTaskCard = snap.taskCards.find((card) =>
      card?.continuation?.childRunId === input.childRunId
      || card?.taskId === `skill-child:${input.childRunId}`
      || [
        card?.continuation?.outputDir,
        card?.continuation?.runStatePath,
        JSON.stringify(card?.recentArtifacts || []),
      ].some((value) => String(value || '').includes(input.probeName)),
    ) || null
    return {
      snapshot: snap,
      visibleTaskCard,
      visibleButtons: [...document.querySelectorAll('button')]
        .map((button) => button.innerText.trim())
        .filter(Boolean),
      bodyTail: document.body.innerText.slice(-2000),
    }
  }
}

function pageResumeProbeRun(input) {
  const h = window.__READY_AGENT_TEST__
  if (!h) throw new Error('missing __READY_AGENT_TEST__')
  return (async () => {
    const before = await h.snapshot()
    const apiCalls = []
    const instrumentation = []
    const restoreFns = []
    const previousTaskActionEvents = window.__READY_AGENT_TASK_ACTION_EVENTS__
    window.__READY_AGENT_TASK_ACTION_EVENTS__ = []
    const wrap = (owner, key) => {
      if (!owner || typeof owner[key] !== 'function') return
      const original = owner[key].bind(owner)
      owner[key] = (...args) => {
        const entry = { key, args: args.map((arg) => {
          try { return JSON.parse(JSON.stringify(arg)) } catch { return String(arg) }
        }) }
        apiCalls.push(entry)
        try {
          const result = original(...args)
          if (result && typeof result.then === 'function') {
            return result.then(
              (value) => {
                entry.result = cloneForReport(value)
                return value
              },
              (error) => {
                entry.error = String(error?.message || error)
                throw error
              },
            )
          }
          entry.result = cloneForReport(result)
          return result
        } catch (error) {
          entry.error = String(error?.message || error)
          throw error
        }
      }
      instrumentation.push({ key, wrapped: true })
      restoreFns.push(() => { owner[key] = original })
    }
    wrap(window.electronAPI?.agent, 'resumeRun')

    try {
      let targetCard = findTargetTaskCard(input)
      let button = targetCard ? findActionButton(targetCard, ['继续生成报告', '继续处理']) : null
      if (targetCard && !button) {
        targetCard.querySelector('button')?.click()
        await new Promise((resolve) => setTimeout(resolve, 250))
        targetCard = findTargetTaskCard(input)
        button = targetCard ? findActionButton(targetCard, ['继续生成报告', '继续处理']) : null
      }
      const visibleButtonsBeforeClick = [...document.querySelectorAll('button')]
        .map((candidate) => candidate.innerText.trim())
        .filter(Boolean)
      let clicked = false
      let label = null
      if (button) {
        label = button.innerText.trim()
        button.click()
        clicked = true
      }
      await new Promise((resolve) => setTimeout(resolve, input.waitMs))
      const taskActionEvents = Array.isArray(window.__READY_AGENT_TASK_ACTION_EVENTS__)
        ? [...window.__READY_AGENT_TASK_ACTION_EVENTS__]
        : []
      const after = await h.snapshot()
      const taskStateChanged = JSON.stringify(before.taskCards || []) !== JSON.stringify(after.taskCards || [])
        || before.runtime?.streamingRequestId !== after.runtime?.streamingRequestId
        || before.runtime?.toolTraceStatus !== after.runtime?.toolTraceStatus
        || before.runtime?.activeRun?.updatedAt !== after.runtime?.activeRun?.updatedAt
      const continuationMessageObserved = after.messages.some((message) =>
        /正在继续技能任务|已继续技能任务|继续后台任务/.test(String(message.content || '')))
      const resumeCallSucceeded = observedSuccessfulResumeRun(apiCalls, input)
      const taskActionResumeObserved = observedTaskActionResume(taskActionEvents, input)
      const effect = {
        ok: Boolean(clicked && targetCard && (resumeCallSucceeded || taskActionResumeObserved)),
        expectation: 'targeted-task-card-button+resumeRun',
        taskStateChanged,
      }
      return {
        success: effect.ok,
        via: 'task-card-button',
        scopeId: input.scopeId,
        taskId: input.taskId,
        childRunId: input.childRunId,
        label,
        clicked,
        targetMatched: Boolean(targetCard),
        apiCalls,
        taskActionEvents,
        instrumentation,
        effect,
        continuationMessageObserved,
        visibleButtonsBeforeClick,
        targetCardText: targetCard?.innerText?.slice(0, 1200) || null,
        before: {
          currentScopeId: before.currentScopeId,
          runtime: before.runtime,
          taskCards: before.taskCards.slice(0, 6),
        },
        after: {
          currentScopeId: after.currentScopeId,
          runtime: after.runtime,
          taskCards: after.taskCards.slice(0, 6),
          toolTrace: after.toolTrace.slice(-8),
          messages: after.messages.slice(-4).map((message) => ({
            type: message.type,
            content: String(message.content || '').slice(0, 800),
          })),
        },
      }
    } finally {
      restoreFns.reverse().forEach((restore) => restore())
      if (previousTaskActionEvents === undefined) {
        delete window.__READY_AGENT_TASK_ACTION_EVENTS__
      } else {
        window.__READY_AGENT_TASK_ACTION_EVENTS__ = previousTaskActionEvents
      }
    }
  })()

  function cssAttrValue(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  }

  function findTargetTaskCard(target) {
    const selectors = []
    if (target.scopeId && target.taskId) {
      selectors.push(
        `[data-ready-task-card="true"][data-ready-task-scope-id="${cssAttrValue(target.scopeId)}"][data-ready-task-id="${cssAttrValue(target.taskId)}"]`,
      )
    }
    if (target.scopeId && target.childRunId) {
      selectors.push(
        `[data-ready-task-card="true"][data-ready-task-scope-id="${cssAttrValue(target.scopeId)}"][data-ready-task-child-run-id="${cssAttrValue(target.childRunId)}"]`,
      )
    }
    for (const selector of selectors) {
      const card = document.querySelector(selector)
      if (card) return card
    }
    return null
  }

  function findActionButton(card, labels) {
    return [...card.querySelectorAll('button[data-ready-task-action="continue-child-run"]')]
      .find((candidate) => labels.includes(candidate.innerText.trim())) || null
  }

  function cloneForReport(value) {
    try { return JSON.parse(JSON.stringify(value)) } catch { return String(value) }
  }

  function observedSuccessfulResumeRun(calls, target) {
    return calls.some((call) => {
      if (call?.key !== 'resumeRun') return false
      const arg = call.args?.[0] || {}
      return call.result?.success === true
        && arg.scopeId === target.scopeId
        && (!target.taskId || arg.taskId === target.taskId)
        && (!target.childRunId || arg.continuationIntent?.childRunId === target.childRunId)
    })
  }

  function observedTaskActionResume(events, target) {
    return events.some((event) =>
      event?.action === 'continue-child-run'
      && event?.observed === 'resumeRun'
      && event?.scopeId === target.scopeId
      && (!target.taskId || event?.taskId === target.taskId)
      && (!target.childRunId || event?.childRunId === target.childRunId)
      && event?.success === true)
  }
}
