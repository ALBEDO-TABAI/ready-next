import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const port = Number(process.env.READY_REMOTE_DEBUGGING_PORT || 9333)
const workspaceRoot = '/tmp/ready-stage-z-agent-panel-fixture/workspaces/current'
const probeName =
  process.env.SURFACE09_PROBE_NAME
  || `surface09-probe-${new Date().toISOString().replace(/[:.]/g, '-')}`
const probeDir = join(workspaceRoot, probeName)
const evidenceDir = resolve('docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/evidence')
const reportPath = join(evidenceDir, 'surface-09-skills-center-resumability-stage-z-resume-probe.json')

async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!response.ok) throw new Error(`CDP target list failed: ${response.status}`)
  return response.json()
}

async function connect(target) {
  let id = 0
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  const rejectPending = (error) => {
    for (const entry of pending.values()) {
      entry.reject(error)
    }
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
    rejectPending(new Error('CDP websocket closed before response'))
  })
  ws.addEventListener('error', () => {
    rejectPending(new Error('CDP websocket error before response'))
  })
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', resolveOpen, { once: true })
    ws.addEventListener('error', rejectOpen, { once: true })
  })
  const send = (method, params = {}) => new Promise((resolveSend, rejectSend) => {
    const callId = ++id
    pending.set(callId, { resolve: resolveSend, reject: rejectSend })
    try {
      ws.send(JSON.stringify({ id: callId, method, params }))
    } catch (error) {
      pending.delete(callId)
      rejectSend(error)
    }
  })
  await send('Runtime.enable')
  return { ws, send }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function evaluate(client, expression) {
  const result = await withTimeout(
    client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }),
    300_000,
    'Runtime.evaluate',
  )
  if (result.result?.exceptionDetails) {
    const details = result.result.exceptionDetails
    throw new Error(details.exception?.description || details.text || 'Runtime.evaluate failed')
  }
  const value = result.result?.result?.value
  return typeof value === 'string' ? JSON.parse(value) : value
}

function createProbeFixture() {
  mkdirSync(probeDir, { recursive: true })
  mkdirSync(join(probeDir, 'frames'), { recursive: true })
  mkdirSync(join(probeDir, 'scenes'), { recursive: true })
  const sceneScoresPath = join(probeDir, 'scene_scores.json')
  const runStatePath = join(probeDir, 'run_state.json')
  const framePath = join(probeDir, 'frames', 'scene_001.png')
  const sceneVideoPath = join(probeDir, 'scenes', 'scene_001.mp4')
  writeFileSync(sceneVideoPath, 'surface09 probe scene placeholder\n', 'utf8')
  writeFileSync(
    framePath,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'),
  )
  writeFileSync(sceneScoresPath, `${JSON.stringify({
    video_id: 'surface09_probe',
    title: 'Surface09 Probe',
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
      description: '用于 Surface09 续跑验证的完整测试场景。',
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
  return { probeDir, runStatePath, sceneScoresPath }
}

const fixture = createProbeFixture()
const prompt = [
  '请加载并使用 video-expert-analyzer skill，继续这个已经中断的 VEA 任务：',
  fixture.runStatePath,
  '请先检查 run_state，然后直接继续 score_batches，不要向用户提问。',
  '重点是验证后台子任务能启动并保留可续跑句柄。',
].join('\n')

const targets = await listTargets()
const mainTarget = targets.find((target) => (
  target.type === 'page'
  && /localhost:5173\/?$/.test(target.url)
  && !/browser-fastcard-overlay/.test(target.url)
))
if (!mainTarget) throw new Error('Ready workbench target not found')

const client = await connect(mainTarget)
let report
try {
  report = await evaluate(client, `
    (async () => {
      const h = window.__READY_AGENT_TEST__
      if (!h) throw new Error('missing __READY_AGENT_TEST__')
      await h.prepareWorkspace(${JSON.stringify(workspaceRoot)}, { reindex: false })
      const visibleSession = await h.createVisibleSession()
      let fallbackSession = null
      if (!visibleSession.ok) {
        fallbackSession = await h.newSession()
      }
      const sessionSummary = h.sessionSummary()
      const submit = await h.submit(${JSON.stringify(prompt)}, {
        waitForIdle: false,
        timeoutMs: 2000,
        allowStoreFallback: true,
      })
      const probeName = ${JSON.stringify(probeName)}
      const observations = []
      for (let i = 0; i < 180; i += 1) {
        const snap = await h.snapshot()
        const activeChildRuns = await window.electronAPI.agent.listActiveChildRuns()
        const pendingAsk = await window.electronAPI.skills.listPendingAskUser()
        const currentScopeId = snap.currentScopeId
        const childRunsForCurrentScope = (activeChildRuns?.data || []).filter((run) => (
          run?.scopeId === currentScopeId
          && [
            run?.outputDir,
            run?.runStatePath,
            run?.sceneScoresPath,
          ].some((value) => String(value || '').includes(probeName))
          && run?.status !== 'failed'
          && run?.closeStatus !== 'failed'
        ))
        const traceText = snap.toolTrace.map((item) => item.text).join('\\n')
        const body = document.body.innerText
        const item = {
          i,
          runtime: snap.runtime,
          composer: snap.composer,
          activeChildRuns,
          childRunsForCurrentScope,
          pendingAsk,
          toolTrace: snap.toolTrace.slice(-12),
          taskCards: snap.taskCards.slice(-5),
          messages: snap.messages.slice(-4).map((m) => ({
            type: m.type,
            content: String(m.content || '').slice(0, 800),
          })),
          bodyTail: body.slice(-1600),
        }
        observations.push(item)
        const hasActiveChildRun = childRunsForCurrentScope.length > 0
        const currentChildRun =
          childRunsForCurrentScope.find((run) => run?.status === 'running')
          || childRunsForCurrentScope[0]
          || null
        const currentChildTerminal = Boolean(
          currentChildRun
          && currentChildRun.status
          && currentChildRun.status !== 'running'
        )
        const breakReason =
          currentChildTerminal
            ? 'child_terminal'
            : pendingAsk?.length > 0
              ? 'pending_ask'
              : null
        item.breakReason = breakReason
        if (
          (hasActiveChildRun && currentChildTerminal)
          || pendingAsk?.length > 0
        ) break
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      return JSON.stringify({ visibleSession, fallbackSession, sessionSummary, submit, observations })
    })()
  `)
} finally {
  client.ws.close()
}

report.fixture = fixture
report.capturedAt = new Date().toISOString()
mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

const last = report.observations.at(-1)
console.log(JSON.stringify({
  reportPath,
  fixture,
  submitOk: report.submit?.ok,
  observations: report.observations.length,
  lastRuntime: last?.runtime,
  lastActiveChildRuns: last?.activeChildRuns,
  lastPendingAskCount: last?.pendingAsk?.length ?? null,
  lastToolTrace: last?.toolTrace,
}, null, 2))
