#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const DEFAULT_OUT_DIR = 'docs/superpowers/audits/2026-05-24-stage-z-closeout/evidence/agent-panel-mimo-rerun-after-projection-tooltrace-fix'
const DEFAULT_FIXTURE_ROOT = '/tmp/ready-stage-z-agent-panel-fixture/workspaces/current'
const DEFAULT_SUITE = 'mimo'

const options = parseArgs(process.argv.slice(2))
const outDir = resolve(options.outDir || DEFAULT_OUT_DIR)
mkdirSync(outDir, { recursive: true })
const fixtureRoot = resolve(options.fixtureRoot || DEFAULT_FIXTURE_ROOT)
prepareFixture(fixtureRoot)

const target = await findReadyTarget(options.port)
const client = await connectCdp(target.webSocketDebuggerUrl)
try {
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  await enableHarness(client)
  await waitForHarness(client)
  await captureScreenshot(client, join(outDir, 'agent-panel-mimo-start.png'))
  const report = await runHarnessCases(client, fixtureRoot)
  report.startedAt = new Date().toISOString()
  report.target = { title: target.title, url: target.url }
  report.fixtureRoot = fixtureRoot
  report.outDir = outDir
  if (options.suite === 'surface20-agent-interaction') {
    augmentSurface20LogEvidence(report)
  }
  report.ok = report.cases.every((item) => item.ok)
  const reportPath = join(outDir, 'agent-panel-mimo-acceptance.json')
  const markdownPath = join(outDir, 'agent-panel-mimo-acceptance.md')
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(markdownPath, renderMarkdown(report))
  await captureScreenshot(client, join(outDir, 'agent-panel-mimo-after.png'))
  console.log(JSON.stringify({
    ok: report.ok,
    reportPath,
    markdownPath,
    cases: report.cases.map((item) => ({
      id: item.id,
      ok: item.ok,
      inputMode: item.inputMode,
      observedToolNames: item.observedToolNames,
      diagnostics: item.diagnostics.map((diagnostic) => diagnostic.id),
    })),
    config: report.config,
  }, null, 2))
  process.exit(report.ok ? 0 : 1)
} finally {
  client.close()
}

function parseArgs(argv) {
  const parsed = {
    port: 9333,
    outDir: DEFAULT_OUT_DIR,
    fixtureRoot: DEFAULT_FIXTURE_ROOT,
    suite: DEFAULT_SUITE,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--port') {
      parsed.port = Number(argv[++index] || parsed.port)
    } else if (arg === '--out-dir') {
      parsed.outDir = argv[++index] || parsed.outDir
    } else if (arg === '--fixture-root') {
      parsed.fixtureRoot = argv[++index] || parsed.fixtureRoot
    } else if (arg === '--suite') {
      parsed.suite = argv[++index] || parsed.suite
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return parsed
}

function prepareFixture(root) {
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, 'events'), { recursive: true })
  writeFileSync(
    join(root, 'events', '北岸夜跑.md'),
    [
      '# 北岸夜跑',
      '',
      '## 预算',
      '北岸夜跑预算共 4.0 万元，主要用于报备、物料、安保、摄影和应急。',
      '',
      '## 备注',
      '验收标记：MIMO_FILE_SEARCH_STAGE_Z。',
      '',
    ].join('\n'),
  )
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
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  })
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', resolveOpen, { once: true })
    ws.addEventListener('error', rejectOpen, { once: true })
  })
  return {
    send(method, params = {}) {
      return new Promise((resolveSend) => {
        const id = ++nextId
        pending.set(id, resolveSend)
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close() {
      ws.close()
    },
  }
}

async function enableHarness(client) {
  await evaluate(client, [
    'localStorage.setItem("ready.agentPanelTest", "1")',
    'localStorage.setItem("ready:agent:test", "1")',
    'try { window.__READY_AGENT_TEST__?.dispose?.() } catch (_) {}',
    'location.reload()',
    'true',
  ].join(';'))
}

async function waitForHarness(client) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    const result = await evaluate(client, 'Boolean(window.__READY_AGENT_TEST__?.createVisibleSession)')
    if (result === true) return
    await delay(250)
  }
  throw new Error('Agent panel test harness did not become available.')
}

async function runHarnessCases(client, fixtureRoot) {
  const source = `(${pageRunner.toString()})(${JSON.stringify({ fixtureRoot, suite: options.suite })})`
  return evaluate(client, source)
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

function augmentSurface20LogEvidence(report) {
  const logPath = join(tmpdir(), 'ready-tools.log')
  const diagnostics = []
  let tail = ''
  try {
    tail = readFileSync(logPath, 'utf8').split(/\r?\n/).slice(-800).join('\n')
  } catch (error) {
    diagnostics.push({
      id: 'ready_tools_log_missing',
      severity: 'error',
      layer: 'runtime',
      message: `无法读取 ready-tools.log：${error instanceof Error ? error.message : String(error)}`,
      evidence: { logPath },
    })
  }
  const capabilityLines = tail.split(/\r?\n/)
    .filter((line) => line.includes('[tool_capability]'))
  const agentInteractionLines = capabilityLines.filter((line) =>
    line.includes('visibleCapabilityGroups=')
    && line.includes('agent_interaction')
    && line.includes('preferredSkillTools=none'))
  const mixedSkillAuthorizationLines = agentInteractionLines.filter((line) =>
    /skill_authorization|authorization_denied|tool_not_registered/.test(line))
  if (tail && agentInteractionLines.length === 0) {
    diagnostics.push({
      id: 'agent_interaction_capability_log_missing',
      severity: 'error',
      layer: 'runtime',
      message: 'ready-tools.log 没有记录独立的 agent_interaction 能力维度。',
      evidence: { logPath, capabilityLines: capabilityLines.slice(-20) },
    })
  }
  if (mixedSkillAuthorizationLines.length > 0) {
    diagnostics.push({
      id: 'agent_interaction_skill_authorization_mixed',
      severity: 'error',
      layer: 'runtime',
      message: 'agent_interaction 能力记录和 skill 授权语义混在一起。',
      evidence: { lines: mixedSkillAuthorizationLines.slice(-10) },
    })
  }
  report.toolsLogEvidence = {
    logPath,
    capabilityLines: capabilityLines.slice(-30),
    agentInteractionLines: agentInteractionLines.slice(-10),
  }
  report.cases.push({
    id: 'surface20-tools-log-capability',
    ok: diagnostics.length === 0,
    inputMode: 'log',
    observedToolNames: [],
    diagnostics,
    before: null,
    after: null,
    assistantMessages: [],
    events: [],
    extra: {
      logPath,
      agentInteractionLineCount: agentInteractionLines.length,
    },
  })
}

async function pageRunner(input) {
  const harness = window.__READY_AGENT_TEST__
  if (!harness) throw new Error('missing __READY_AGENT_TEST__')
  const configResult = await window.electronAPI?.settings?.getAIConfig?.()
  const rawConfig = configResult?.success ? configResult.data : null
  const config = rawConfig
    ? {
      provider: rawConfig.provider,
      model: rawConfig.model,
      baseUrl: rawConfig.baseUrl,
      apiKeyConfigured: Boolean(rawConfig.apiKey),
    }
    : null
  const cases = []

  if (input.suite === 'surface12-map') {
    cases.push(await runCase({
      id: 'surface12-route-map-only',
      text: '请只规划一条北京从中关村到三里屯的驾车路线。不要做历史研究，也不要改用网页搜索来回答路线。',
      options: {
        mode: 'dom',
        timeoutMs: 360000,
        expectedToolNames: ['map_plan_route'],
        forbiddenToolNames: ['web_search'],
        autoAnswerAskUser: true,
      },
      assertions: [
        (summary) => /amap_not_configured|高德地图 API Key 还没配置|缺少高德地图 API Key/.test(summary.visibleText)
          ? '地图路线仍然缺少高德配置'
          : null,
        (summary) => /中关村|三里屯|路线|驾车/.test(summary.visibleText)
          ? null
          : '纯路线回复没有包含可见路线结果',
      ],
    }))

    cases.push(await runCase({
      id: 'surface12-research-not-map',
      text: '请调研中关村和三里屯这两个区域的历史关系和发展差异，整理 3 点结论。不要规划出行路线。',
      options: {
        mode: 'dom',
        timeoutMs: 360000,
        expectedToolNames: ['web_search'],
        forbiddenToolNames: ['map_plan_route'],
      },
      assertions: [
        (summary) => /中关村|三里屯/.test(summary.visibleText)
          ? null
          : '研究回复没有围绕中关村和三里屯',
        (summary) => /驾车路线|主要路线步骤|总距离|预计用时|沿.+行驶/.test(summary.visibleText)
          ? '纯研究回复疑似变成路线规划'
          : null,
      ],
    }))

    cases.push(await runCase({
      id: 'surface12-location-research-not-map',
      text: '比较北京几个 IT 园区的产业特色和适合入驻的公司类型，位置可以提到，但不要做导航。',
      options: {
        mode: 'dom',
        timeoutMs: 360000,
        expectedToolNames: ['web_search'],
        forbiddenToolNames: ['map_plan_route'],
      },
      assertions: [
        (summary) => /IT|园区|产业|公司/.test(summary.visibleText)
          ? null
          : '地点研究回复没有包含园区产业比较',
      ],
    }))

    cases.push(await runCase({
      id: 'surface12-research-plus-route',
      text: '请先推荐一家三里屯适合聊天的咖啡店，再规划我从中关村开车过去的路线。需要同时给出推荐理由和路线摘要。',
      options: {
        mode: 'dom',
        timeoutMs: 360000,
        expectedToolNames: ['web_search', 'map_plan_route'],
        autoAnswerAskUser: true,
      },
      assertions: [
        (summary) => /咖啡|推荐/.test(summary.visibleText)
          ? null
          : '组合任务没有给出咖啡店推荐',
        (summary) => /中关村|三里屯|路线|驾车/.test(summary.visibleText)
          ? null
          : '组合任务没有给出路线摘要',
      ],
    }))

    cases.push(await runCase({
      id: 'surface12-ambiguous-map-card',
      text: '帮我规划一条上海从人民广场到虹桥火车站的驾车路线；如果地点有歧义，请用选项卡让我选。',
      options: {
        mode: 'dom',
        timeoutMs: 360000,
        expectedToolNames: ['map_plan_route', 'ask_user_questions'],
        forbiddenToolNames: ['web_search'],
        autoAnswerAskUser: true,
      },
      assertions: [
        (summary) => summary.observedToolNames.includes('ask_user_questions')
          ? null
          : '地点歧义没有弹出 ask_user_questions 选项卡',
        (summary) => /人民广场|虹桥火车站|路线|驾车/.test(summary.visibleText)
          ? null
          : '歧义选择后没有输出路线摘要',
      ],
    }))

    return { ok: false, config, cases, events: harness.events() }
  }

  if (input.suite === 'surface07-panel') {
    cases.push(await runProbeCase('surface07-cold-start-composer-ready', async () => {
      const summary = await harness.snapshot()
      return {
        snapshot: summarizeSnapshot(summary),
        assertions: [
          summary.composer.locked ? '冷启动后输入框仍然锁定' : null,
          summary.runtime.foregroundBusy ? '冷启动后 Agent 仍显示忙碌' : null,
          summary.composer.pendingSendCount !== 0 ? '冷启动后仍有待发送消息' : null,
        ],
      }
    }))

    cases.push(await runProbeCase('surface07-new-chat-fresh-session', async () => {
      const before = await harness.snapshot()
      const after = await harness.newSession()
      return {
        before: summarizeSnapshot(before),
        after: summarizeSnapshot(after),
        assertions: [
          after.currentScopeId && after.currentScopeId !== before.currentScopeId ? null : '新对话没有切到新的 scope',
          after.composer.inputValue === '' ? null : '新对话输入框不是空的',
          after.composer.locked ? '新对话输入框仍然锁定' : null,
          after.messages.some((message) => message.type === 'agent' && /新的对话已开始/.test(message.content))
            ? null
            : '新对话没有出现欢迎消息',
        ],
      }
    }))

    cases.push(await runProbeCase('surface07-visible-session-cap-and-active-mirror', async () => {
      const attempts = []
      for (let i = 0; i < 4; i += 1) {
        attempts.push(await harness.createVisibleSession())
      }
      const summary = harness.sessionSummary()
      return {
        attempts: attempts.map((item) => ({ ok: item.ok, id: item.id || null, error: item.error || null })),
        summary,
        assertions: [
          summary.sessionOrder.length <= 3 ? null : '可见会话超过 3 个',
          summary.activeSessionId && summary.sessionOrder.includes(summary.activeSessionId)
            ? null
            : '活跃会话不在可见列表里',
          attempts.some((item) => item.error === 'session limit reached')
            ? null
            : '第 4 个可见会话没有被上限拦住',
        ],
      }
    }))

    const originalConfig = rawConfig
    cases.push(await runCaseWithTemporaryAIConfig({
      originalConfig,
      id: 'surface07-failed-send-unlocks-composer',
      temporaryConfig: originalConfig
        ? {
          ...originalConfig,
          apiKey: 'sk-ready-stage-z-invalid-key',
        }
        : null,
      definition: {
        id: 'surface07-failed-send-unlocks-composer',
        text: '请只回复一句：这条消息用于失败发送后解锁测试。',
        options: {
          mode: 'dom',
          timeoutMs: 120000,
          forbiddenToolNames: [
            'document_new_tab',
            'document_open_tab',
            'file_search',
            'map_plan_route',
            'web_search',
          ],
        },
        assertions: [
          (summary) => summary.result.after.composer.locked ? '失败发送结束后输入框仍然锁定' : null,
          (summary) => summary.result.after.runtime.foregroundBusy ? '失败发送结束后 Agent 仍显示忙碌' : null,
          (summary) => summary.result.after.runtime.toolTraceStatus === 'running' ? '失败发送结束后工具轨迹仍显示运行中' : null,
          (summary) => summary.result.after.composer.pendingSendCount !== 0 ? '失败发送结束后仍有待发送消息' : null,
        ],
        allowedDiagnosticIds: [
          'send_failed_message',
          'active_run_error',
          'non_done_terminal_reason',
        ],
        extra: {
          originalConfig: originalConfig
            ? {
              provider: originalConfig.provider,
              model: originalConfig.model,
              baseUrl: originalConfig.baseUrl,
              apiKeyConfigured: Boolean(originalConfig.apiKey),
            }
            : null,
        },
      },
    }))

    return { ok: false, config, cases, events: harness.events() }
  }

  if (input.suite === 'surface20-agent-interaction') {
    const ensureVisibleActiveSession = async () => {
      const summary = harness.sessionSummary()
      if (summary.activeSessionId && summary.sessionOrder.includes(summary.activeSessionId)) {
        return { ok: true, id: summary.activeSessionId, summary }
      }
      return harness.createVisibleSession()
    }

    const waitForPendingAskCard = async (timeoutMs) => {
      const startedAt = Date.now()
      while (Date.now() - startedAt < timeoutMs) {
        const current = await harness.snapshot()
        const observedToolNames = Array.from(new Set(current.toolTrace
          .filter((item) => item.kind === 'call')
          .map((item) => {
            const match = String(item.text || '').trim().match(/^([a-zA-Z0-9_:-]+)\s*(?:\(|:)/)
            return match?.[1] || null
          })
          .filter(Boolean)))
        const pendingCard = current.messages.find((message) =>
          message.type === 'ask_user_questions'
          && message.askUserQuestionsStatus === 'pending')
        if (pendingCard) return { snapshot: current, observedToolNames, pendingCard }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
      }
      const current = await harness.snapshot()
      return { snapshot: current, observedToolNames: [], pendingCard: null }
    }

    const hasPendingAskCard = (snapshot) => snapshot.messages.some((message) =>
      message.type === 'ask_user_questions'
      && message.askUserQuestionsStatus === 'pending')

    const hasRouteResultMessage = (snapshot, routePattern) => snapshot.messages.some((message) =>
      message.type !== 'user'
      && message.type !== 'ask_user_questions'
      && routePattern.test(String(message.content || '')))

    const resolveActiveSessionRoute = async ({ routePattern, timeoutMs = 360000, maxAnswers = 5 }) => {
      const startedAt = Date.now()
      const answers = []
      let lastSnapshot = await harness.snapshot()
      let error = null

      while (Date.now() - startedAt < timeoutMs) {
        if (hasRouteResultMessage(lastSnapshot, routePattern) && !hasPendingAskCard(lastSnapshot)) {
          return { success: true, answers, snapshot: lastSnapshot }
        }
        if (answers.length >= maxAnswers) {
          error = `超过 ${maxAnswers} 轮地点选项卡后仍未完成路线`
          break
        }

        const answer = await harness.answerPendingAskUserQuestions({ strategy: 'first' })
        if (answer?.success) {
          answers.push(answer)
        } else if (answer && answer.error !== 'no pending ask_user_questions card') {
          return { success: false, answers, snapshot: lastSnapshot, error: answer.error || 'answer failed' }
        }

        const waitStartedAt = Date.now()
        while (Date.now() - waitStartedAt < Math.min(60000, timeoutMs - (Date.now() - startedAt))) {
          lastSnapshot = await harness.snapshot()
          if (hasPendingAskCard(lastSnapshot)) break
          if (hasRouteResultMessage(lastSnapshot, routePattern)) {
            return { success: true, answers, snapshot: lastSnapshot }
          }
          const busy = Boolean(lastSnapshot.runtime?.foregroundBusy || lastSnapshot.composer?.locked)
          if (!busy && answer?.success) {
            error = '提交选项卡后运行已空闲，但没有看到路线结果'
            break
          }
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
        }
        if (error) break
      }

      return {
        success: false,
        answers,
        snapshot: lastSnapshot,
        error: error || '等待路线结果超时',
      }
    }

    const runPendingAskCase = async ({ id, text, resetScope }) => {
      if (resetScope) {
        const visible = await ensureVisibleActiveSession()
        if (!visible.ok) {
          return {
            id,
            ok: false,
            inputMode: 'dom',
            observedToolNames: [],
            diagnostics: [{
              id: 'visible_session_unavailable',
              severity: 'error',
              layer: 'renderer',
              message: `无法准备可见会话：${visible.error || 'unknown'}`,
              evidence: { summary: visible.summary },
            }],
            before: null,
            after: null,
            assistantMessages: [],
            events: harness.events(),
            extra: {},
          }
        }
        await harness.newSession()
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
      }
      await harness.waitForIdle?.({ timeoutMs: 30_000, pollMs: 100 })
      harness.clearEvents()
      const submitResult = await harness.submit(text, {
        mode: 'dom',
        waitForIdle: false,
        allowStoreFallback: true,
        awaitStoreSend: false,
      })
      const pending = await waitForPendingAskCard(360000)
      const diagnostics = submitResult.diagnostics.filter((item) =>
        item.id !== 'send_returned_without_run_evidence'
        && item.id !== 'send_coalescing_pending'
        && item.id !== 'send_returned_without_user_message'
        && item.id !== 'tool_call_without_result'
        && item.id !== 'non_done_terminal_reason')
      if (!pending.pendingCard) {
        diagnostics.push({
          id: 'pending_ask_user_card_missing',
          severity: 'error',
          layer: 'renderer',
          message: '地点歧义没有留下待回答的 ask_user_questions 选项卡。',
          evidence: { messages: pending.snapshot.messages.slice(-8), tools: pending.observedToolNames },
        })
      }
      for (const expected of ['map_plan_route', 'ask_user_questions']) {
        if (pending.observedToolNames.includes(expected)) continue
        diagnostics.push({
          id: 'expected_tool_not_called',
          severity: 'error',
          layer: 'tool',
          message: `测试要求调用 ${expected}，但面板工具轨迹中没有出现。`,
          evidence: { expectedToolName: expected, observedToolNames: pending.observedToolNames },
        })
      }
      if (pending.observedToolNames.includes('web_search')) {
        diagnostics.push({
          id: 'forbidden_tool_called',
          severity: 'error',
          layer: 'tool',
          message: '地点歧义流程不应改用网页搜索。',
          evidence: { observedToolNames: pending.observedToolNames },
        })
      }
      return {
        id,
        ok: diagnostics.every((item) => item.severity !== 'error'),
        inputMode: submitResult.inputMode,
        observedToolNames: pending.observedToolNames,
        diagnostics,
        before: summarizeSnapshot(submitResult.before),
        after: summarizeSnapshot(pending.snapshot),
        assistantMessages: pending.snapshot.messages
          .filter((message) => message.type !== 'user')
          .map((message) => String(message.content || '').slice(0, 1000)),
        events: harness.events(),
        extra: {
          activeSessionId: harness.sessionSummary().activeSessionId,
          currentScopeId: pending.snapshot.currentScopeId,
          pendingCardId: pending.pendingCard?.id || null,
        },
      }
    }

    const first = await runPendingAskCase({
      id: 'surface20-session-a-pending-card',
      text: '帮我规划一条上海从人民广场到虹桥火车站的驾车路线；如果地点有歧义，请用选项卡让我选，不要自己猜。',
      resetScope: true,
    })
    cases.push(first)
    const sessionA = first.extra?.activeSessionId || harness.sessionSummary().activeSessionId

    let secondSession = await harness.createVisibleSession()
    let secondScopePrepared = false
    if (!secondSession.ok) {
      const fallbackId = harness.sessionSummary().sessionOrder.find((id) => id !== sessionA)
      if (fallbackId) {
        secondSession = await harness.activateSession(fallbackId)
        if (secondSession.ok) {
          await harness.newSession()
          secondScopePrepared = true
        }
      }
    }
    if (!secondSession.ok) {
      cases.push({
        id: 'surface20-create-second-visible-session',
        ok: false,
        inputMode: 'dom',
        observedToolNames: [],
        diagnostics: [{
          id: 'second_session_unavailable',
          severity: 'error',
          layer: 'renderer',
          message: `无法创建或切换第二个可见会话：${secondSession.error || 'unknown'}`,
          evidence: { summary: secondSession.summary },
        }],
        before: null,
        after: null,
        assistantMessages: [],
        events: harness.events(),
        extra: {},
      })
      return { ok: false, config, cases, events: harness.events() }
    }
    if (!secondScopePrepared) {
      await harness.newSession()
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
    }

    const second = await runPendingAskCase({
      id: 'surface20-session-b-pending-card',
      text: '帮我规划一条北京从国贸到西站的驾车路线；如果地点有歧义，请弹出选项卡让我选择，不要改用网页搜索。',
      resetScope: false,
    })
    cases.push(second)
    const sessionB = second.extra?.activeSessionId || harness.sessionSummary().activeSessionId
    const twoSessionSummary = harness.sessionSummary()
    cases.push(await runProbeCase('surface20-two-session-pending-isolation', async () => {
      const targetSessions = [sessionA, sessionB].filter(Boolean)
      return {
        summary: twoSessionSummary,
        targetSessions,
        assertions: [
          targetSessions.length === 2 && targetSessions[0] !== targetSessions[1]
            ? null
            : '没有形成两个不同的可见会话',
          targetSessions.every((id) =>
            twoSessionSummary.sessions.find((session) => session.id === id)?.pendingAskUserCount === 1)
            ? null
            : '两个会话没有各自保留 1 张待回答选项卡',
        ],
      }
    }))

    const resolvedB = await resolveActiveSessionRoute({ routePattern: /国贸|西站|路线|驾车/ })
    cases.push(await runProbeCase('surface20-answer-active-session-resolves-card', async () => ({
      resolvedB: {
        success: resolvedB.success,
        answerCount: resolvedB.answers.length,
        error: resolvedB.error || null,
      },
      snapshot: summarizeSnapshot(resolvedB.snapshot),
      assertions: [
        resolvedB.answers.length > 0 ? null : '当前会话没有提交任何选项卡',
        resolvedB.success ? null : `当前会话路线没有完成：${resolvedB.error || 'unknown'}`,
        resolvedB.snapshot.messages.some((message) =>
          message.type === 'ask_user_questions'
          && message.askUserQuestionsStatus === 'submitted')
          ? null
          : '提交答案后当前会话选项卡没有折叠为已提交',
        hasRouteResultMessage(resolvedB.snapshot, /国贸|西站|路线|驾车/)
          ? null
          : '提交答案后当前会话没有继续输出路线结果',
      ],
    })))

    const activationA = sessionA ? await harness.activateSession(sessionA) : null
    const resolvedA = activationA?.ok
      ? await resolveActiveSessionRoute({ routePattern: /人民广场|虹桥火车站|路线|驾车/ })
      : { success: false, answers: [], snapshot: activationA?.snapshot || await harness.snapshot(), error: activationA?.error || 'session A missing' }
    cases.push(await runProbeCase('surface20-background-session-card-survives-and-resolves', async () => ({
      activationA,
      resolvedA: {
        success: resolvedA.success,
        answerCount: resolvedA.answers.length,
        error: resolvedA.error || null,
      },
      snapshot: summarizeSnapshot(resolvedA.snapshot),
      assertions: [
        activationA?.ok ? null : `切回第一个会话失败：${activationA?.error || 'unknown'}`,
        resolvedA.answers.length > 0 ? null : '第一个会话没有提交任何选项卡',
        resolvedA.success ? null : `第一个会话路线没有完成：${resolvedA.error || 'unknown'}`,
        resolvedA.snapshot.messages.some((message) =>
          message.type === 'ask_user_questions'
          && message.askUserQuestionsStatus === 'submitted')
          ? null
          : '后台会话选项卡没有在切回后提交成功',
        hasRouteResultMessage(resolvedA.snapshot, /人民广场|虹桥火车站|路线|驾车/)
          ? null
          : '后台会话提交答案后没有继续输出路线结果',
      ],
    })))

    return { ok: cases.every((item) => item.ok), config, cases, events: harness.events() }
  }

  cases.push(await runCase({
    id: 'mimo-direct-panel-input',
    text: '请只用一句中文回复：Ready Mimo 面板测试收到。不要调用工具。',
    options: {
      mode: 'dom',
      timeoutMs: 360000,
      forbiddenToolNames: [
        'document_new_tab',
        'document_open_tab',
        'file_search',
        'map_plan_route',
        'web_search',
      ],
    },
    assertions: [
      (summary) => summary.visibleText.includes('Ready Mimo 面板测试收到')
        ? null
        : '没有看到 Mimo 直接回复确认文本',
    ],
  }))

  const workspace = await harness.prepareWorkspace(input.fixtureRoot, { reindex: true })
  cases.push(await runCase({
    id: 'mimo-file-search-index',
    text: '在当前工作区搜索“北岸夜跑预算”，打开相关文档，并告诉我预算数字。必须基于文件内容回答，不要编造。',
    options: {
      mode: 'dom',
      timeoutMs: 360000,
      expectedToolNames: ['file_search'],
    },
    assertions: [
      () => workspace.ok ? null : `工作区索引准备失败：${workspace.error || 'unknown'}`,
      (summary) => summary.visibleText.includes('4.0 万元')
        ? null
        : '文件搜索回复没有包含 fixture 中的预算数字',
      (summary) => /未找到|没有找到|没找到/.test(summary.visibleText)
        ? '文件搜索回复声称没有找到相关文档'
        : null,
    ],
    extra: { workspace },
  }))

  cases.push(await runCase({
    id: 'mimo-map-route-panel-input',
    text: '帮我规划一条上海从人民广场到虹桥火车站的驾车路线；如果地图服务缺少配置，请明确说缺少配置，不要改用网页搜索。',
    options: {
      mode: 'dom',
      timeoutMs: 360000,
      expectedToolNames: ['map_plan_route', 'ask_user_questions'],
      forbiddenToolNames: ['web_search'],
      autoAnswerAskUser: true,
    },
    assertions: [
      (summary) => /amap_not_configured|高德地图 API Key 还没配置|缺少高德地图 API Key/.test(summary.visibleText)
        ? '地图路线仍然缺少高德配置'
        : null,
      (summary) => summary.observedToolNames.includes('ask_user_questions')
        ? null
        : '地点歧义没有弹出 ask_user_questions 选项卡',
      (summary) => /人民广场|虹桥火车站|路线|驾车/.test(summary.visibleText)
        ? null
        : '地图路线回复没有包含可见路线结果',
    ],
  }))

  return { ok: false, config, cases, events: harness.events() }

  async function runCase(definition) {
    await harness.newSession()
    await harness.waitForIdle?.({ timeoutMs: 30_000, pollMs: 100 })
    harness.clearEvents()
    const submitOptions = { ...(definition.options || {}) }
    const autoAnswerAskUser = submitOptions.autoAnswerAskUser === true
    delete submitOptions.autoAnswerAskUser
    let submitSettled = false
    const submitPromise = harness.submit(definition.text, submitOptions)
      .finally(() => {
        submitSettled = true
      })
    const askUserAnswer = autoAnswerAskUser
      ? await answerPendingAskUserDuringRun(harness, submitOptions.timeoutMs || 360000, () => submitSettled)
      : null
    const result = await submitPromise
    const observedToolNames = Array.from(new Set(result.after.toolTrace
      .filter((item) => item.kind === 'call')
      .map((item) => {
        const match = String(item.text || '').trim().match(/^([a-zA-Z0-9_:-]+)\s*(?:\(|:)/)
        return match?.[1] || null
      })
      .filter(Boolean)))
    const visibleMessages = result.after.messages
      .filter((message) => message.type !== 'user' && message.type !== 'ask_user_questions')
      .map((message) => String(message.content || '').slice(0, 1000))
    const visibleText = visibleMessages.join('\n')
    for (const assertion of definition.assertions || []) {
      const message = assertion({ result, observedToolNames, visibleMessages, visibleText })
      if (!message) continue
      result.diagnostics.push({
        id: 'visible_result_mismatch',
        severity: 'error',
        layer: 'renderer',
        message,
        evidence: { visibleText: visibleText.slice(0, 1200) },
      })
    }
    const allowedDiagnosticIds = new Set(definition.allowedDiagnosticIds || [])
    const blockingDiagnostics = result.diagnostics.filter((item) => (
      item.severity === 'error' && !allowedDiagnosticIds.has(item.id)
    ))
    return {
      id: definition.id,
      ok: blockingDiagnostics.length === 0,
      inputMode: result.inputMode,
      observedToolNames,
      diagnostics: result.diagnostics,
      before: summarizeSnapshot(result.before),
      after: summarizeSnapshot(result.after),
      assistantMessages: visibleMessages,
      events: harness.events(),
      extra: {
        ...(definition.extra || {}),
        askUserAnswer,
      },
    }
  }

  async function runProbeCase(id, probe) {
    const diagnostics = []
    let extra = {}
    try {
      const result = await probe()
      extra = { ...result }
      for (const message of result.assertions || []) {
        if (!message) continue
        diagnostics.push({
          id: 'surface07_probe_mismatch',
          severity: 'error',
          layer: 'renderer',
          message,
          evidence: result,
        })
      }
      delete extra.assertions
    } catch (error) {
      diagnostics.push({
        id: 'surface07_probe_exception',
        severity: 'error',
        layer: 'renderer',
        message: error instanceof Error ? error.message : String(error),
        evidence: {},
      })
    }
    return {
      id,
      ok: diagnostics.every((item) => item.severity !== 'error'),
      inputMode: 'dom',
      observedToolNames: [],
      diagnostics,
      before: null,
      after: null,
      assistantMessages: [],
      events: harness.events(),
      extra,
    }
  }

  async function runCaseWithTemporaryAIConfig({ originalConfig, temporaryConfig, definition }) {
    if (!originalConfig || !temporaryConfig) {
      return {
        id: definition.id,
        ok: false,
        inputMode: 'dom',
        observedToolNames: [],
        diagnostics: [{
          id: 'ai_config_missing',
          severity: 'error',
          layer: 'runtime',
          message: 'AI config unavailable for temporary failed-send test.',
          evidence: {},
        }],
        before: null,
        after: null,
        assistantMessages: [],
        events: harness.events(),
        extra: definition.extra || {},
      }
    }
    const settings = window.electronAPI?.settings
    if (!settings?.setAIConfig) {
      return {
        id: definition.id,
        ok: false,
        inputMode: 'dom',
        observedToolNames: [],
        diagnostics: [{
          id: 'ai_config_api_missing',
          severity: 'error',
          layer: 'runtime',
          message: 'settings.setAIConfig unavailable for temporary failed-send test.',
          evidence: {},
        }],
        before: null,
        after: null,
        assistantMessages: [],
        events: harness.events(),
        extra: definition.extra || {},
      }
    }
    let restoreError = null
    try {
      await settings.setAIConfig(temporaryConfig)
      const item = await runCase(definition)
      item.extra = {
        ...(item.extra || {}),
        temporaryConfig: {
          provider: temporaryConfig.provider,
          model: temporaryConfig.model,
          baseUrl: temporaryConfig.baseUrl,
          apiKeyConfigured: Boolean(temporaryConfig.apiKey),
        },
      }
      return item
    } finally {
      try {
        await settings.setAIConfig(originalConfig)
      } catch (error) {
        restoreError = error instanceof Error ? error.message : String(error)
      }
      if (restoreError) {
        // The returned case may already be gone; surface the failure through a
        // harness event by forcing a diagnostic in the next snapshot path.
        console.error('[surface07-panel] failed to restore AI config', restoreError)
      }
    }
  }

  async function answerPendingAskUserDuringRun(harnessApi, timeoutMs, shouldStop) {
    const startedAt = Date.now()
    const answers = []
    while (Date.now() - startedAt < Math.max(1000, timeoutMs)) {
      const answer = await harnessApi.answerPendingAskUserQuestions?.({ strategy: 'first' })
      if (answer?.success) {
        answers.push(answer)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
        if (shouldStop()) return { success: true, answers }
        continue
      }
      if (/No pending card with this id/i.test(String(answer?.error || ''))) {
        if (shouldStop()) return { success: true, answers, alreadySubmitted: true }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
        continue
      }
      if (answer && answer.error !== 'no pending ask_user_questions card') return answer
      if (shouldStop()) {
        return answers.length > 0
          ? { success: true, answers }
          : { success: false, error: 'no pending ask_user_questions card before run completed' }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
    }
    return answers.length > 0
      ? { success: true, answers, timeoutAfterAnswers: true }
      : { success: false, error: 'no pending ask_user_questions card before timeout' }
  }

  function summarizeSnapshot(snapshot) {
    return {
      currentScopeId: snapshot.currentScopeId,
      messageCount: snapshot.messages.length,
      taskCardCount: snapshot.taskCards.length,
      composer: snapshot.composer,
      runtime: snapshot.runtime,
      toolTraceCount: snapshot.toolTrace.length,
      diagnostics: snapshot.diagnostics,
    }
  }
}

function renderMarkdown(report) {
  const lines = [
    '# Agent Panel Mimo Acceptance',
    '',
    `- overall: ${report.ok ? 'pass' : 'fail'}`,
    `- model: ${report.config?.model || 'unknown'}`,
    `- provider: ${report.config?.provider || 'unknown'}`,
    `- baseUrl: ${report.config?.baseUrl || 'unknown'}`,
    `- apiKeyConfigured: ${report.config?.apiKeyConfigured ? 'yes' : 'no'}`,
    '',
    '## Cases',
    '',
  ]
  for (const item of report.cases) {
    lines.push(`### ${item.id}`)
    lines.push('')
    lines.push(`- status: ${item.ok ? 'pass' : 'fail'}`)
    lines.push(`- inputMode: ${item.inputMode}`)
    lines.push(`- observedToolNames: ${item.observedToolNames.join(', ') || 'none'}`)
    lines.push(`- diagnostics: ${item.diagnostics.map((diagnostic) => diagnostic.id).join(', ') || 'none'}`)
    if (item.assistantMessages.length) {
      lines.push('- assistant:')
      lines.push('```')
      lines.push(item.assistantMessages.join('\n---\n'))
      lines.push('```')
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}
