import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const API_ACTIONS_BY_LABEL = new Map([
  ['继续生成报告', ['resumeRun']],
  ['继续处理', ['resumeRun']],
  ['继续运行', ['resumeRun']],
  ['取消', ['cancelChildRun']],
  ['取消后台任务', ['cancelDetachedSkillTask']],
  ['暂停任务', ['suspendRun']],
  ['确认继续', ['respondToInteraction']],
  ['暂不继续', ['respondToInteraction']],
])

function hasApiCall(report, keys) {
  return Array.isArray(report.apiCalls) && report.apiCalls.some((call) => keys.includes(call?.key))
}

function hasComposerChange(report) {
  return report.before?.composer?.inputValue !== report.after?.composer?.inputValue
    || report.before?.composer?.pendingSendCount !== report.after?.composer?.pendingSendCount
}

function hasOpenedScope(report) {
  return Boolean(report.after?.currentScopeId)
    && report.after.currentScopeId !== report.before?.currentScopeId
    && report.after.messageCount > report.before?.messageCount
}

function hasGenericObservableEffect(report) {
  return Array.isArray(report.apiCalls) && report.apiCalls.length > 0
    || hasComposerChange(report)
    || hasOpenedScope(report)
    || report.after?.messageCount > report.before?.messageCount
}

export function evaluateTaskCardActionEffect(report) {
  if (!report || report.ok !== true) return report
  const label = String(report.label || '')
  const expectedApiKeys = API_ACTIONS_BY_LABEL.get(label)
  const effect = expectedApiKeys
    ? {
        ok: hasApiCall(report, expectedApiKeys),
        expectation: `api:${expectedApiKeys.join('|')}`,
      }
    : label === '打开会话'
      ? {
          ok: hasOpenedScope(report),
          expectation: 'state:opened-scope',
        }
      : label === '继续后台任务' || label === '重试'
        ? {
            ok: hasComposerChange(report),
            expectation: 'state:composer-changed',
          }
        : {
            ok: hasGenericObservableEffect(report),
            expectation: 'generic-observable-effect',
          }
  if (effect.ok) return { ...report, effect }
  return {
    ...report,
    ok: false,
    error: 'no-action-effect',
    effect,
  }
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!response.ok) throw new Error(`CDP target list failed: ${response.status}`)
  return response.json()
}

async function connect(target) {
  let id = 0
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  const rejectPending = (error) => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id).resolve(message)
      pending.delete(message.id)
    }
  })
  ws.addEventListener('close', () => rejectPending(new Error('CDP websocket closed before response')))
  ws.addEventListener('error', () => rejectPending(new Error('CDP websocket error before response')))
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const callId = ++id
    pending.set(callId, { resolve, reject })
    try {
      ws.send(JSON.stringify({ id: callId, method, params }))
    } catch (error) {
      pending.delete(callId)
      reject(error)
    }
  })
  await send('Runtime.enable')
  return { ws, send }
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.result?.exceptionDetails) {
    const details = result.result.exceptionDetails
    throw new Error(details.exception?.description || details.text || 'Runtime.evaluate failed')
  }
  const value = result.result?.result?.value
  return typeof value === 'string' ? JSON.parse(value) : value
}

async function main() {
  const port = Number(process.env.READY_REMOTE_DEBUGGING_PORT || 9333)
  const label = process.argv[2] || ''
  const waitMs = Number(process.argv[3] || 2500)
  const outPath = process.argv[4] || ''
  const preAction = process.argv[5] || ''
  if (!label.trim()) throw new Error('button label is required')

  const targets = await listTargets(port)
  const mainTarget = targets.find((target) => (
    target.type === 'page'
    && /localhost:5173\/?$/.test(target.url)
    && !/browser-fastcard-overlay/.test(target.url)
  ))
  if (!mainTarget) throw new Error('Ready workbench target not found')

  const client = await connect(mainTarget)
  try {
    const rawReport = await evaluate(client, `
      (async () => {
        const label = ${JSON.stringify(label)}
        const waitMs = ${JSON.stringify(waitMs)}
        const preAction = ${JSON.stringify(preAction)}
      const h = window.__READY_AGENT_TEST__
      if (!h) throw new Error('missing __READY_AGENT_TEST__')
      let preActionResult = null
      if (preAction.split(',').includes('new-session-before')) {
        preActionResult = await h.createVisibleSession()
      }
      if (preAction.split(',').includes('expand-task-cards')) {
        for (const candidate of [...document.querySelectorAll('button')]) {
          const text = candidate.innerText.trim()
          if (text.includes('技能子任务') || text.includes('正在理解需求')) candidate.click()
        }
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      const apiCalls = []
      const restoreFns = []
      const wrap = (owner, key) => {
        if (!owner || typeof owner[key] !== 'function') return
        const original = owner[key].bind(owner)
        owner[key] = (...args) => {
          apiCalls.push({ key, args: args.map((arg) => {
            try { return JSON.parse(JSON.stringify(arg)) } catch { return String(arg) }
          }) })
          return original(...args)
        }
        restoreFns.push(() => { owner[key] = original })
      }
      wrap(window.electronAPI?.agent, 'resumeRun')
      wrap(window.electronAPI?.agent, 'cancelChildRun')
      wrap(window.electronAPI?.agent, 'cancelDetachedSkillTask')
      wrap(window.electronAPI?.agent, 'suspendRun')
      wrap(window.electronAPI?.agent, 'respondToInteraction')
      wrap(window.electronAPI?.agent, 'getConversationScopeMessages')
      const before = await h.snapshot()
      let buttons = [...document.querySelectorAll('button')]
      let button = buttons.find((candidate) => candidate.innerText.trim() === label)
      if (!button && preAction.split(',').includes('auto-expand-label')) {
        for (const candidate of buttons) {
          const text = candidate.innerText.trim()
          if (!text.includes('技能子任务') && !text.includes('正在理解需求')) continue
          candidate.click()
          await new Promise((resolve) => setTimeout(resolve, 250))
          buttons = [...document.querySelectorAll('button')]
          button = buttons.find((next) => next.innerText.trim() === label)
          if (button) break
        }
      }
      if (!button) {
        restoreFns.reverse().forEach((restore) => restore())
        return JSON.stringify({
          ok: false,
          error: 'button-missing',
          label,
          preAction,
          preActionResult,
          visibleButtons: buttons.map((candidate) => candidate.innerText.trim()).filter(Boolean),
          before,
        })
      }
      button.click()
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      restoreFns.reverse().forEach((restore) => restore())
      const after = await h.snapshot()
      return JSON.stringify({
        ok: true,
        label,
        preAction,
        preActionResult,
        apiCalls,
        before: {
          currentScopeId: before.currentScopeId,
          messageCount: before.messages.length,
          composer: before.composer,
          runtime: before.runtime,
          taskCards: before.taskCards.slice(0, 4),
        },
        after: {
          currentScopeId: after.currentScopeId,
          messageCount: after.messages.length,
          composer: after.composer,
          runtime: after.runtime,
          taskCards: after.taskCards.slice(0, 4),
          toolTrace: after.toolTrace.slice(-8),
          messages: after.messages.slice(-4).map((message) => ({
            type: message.type,
            content: String(message.content || '').slice(0, 600),
          })),
        },
      })
      })()
    `)
    const report = evaluateTaskCardActionEffect(rawReport)
    const serialized = JSON.stringify(report, null, 2)
    if (outPath) writeFileSync(outPath, `${serialized}\n`)
    console.log(serialized)
    process.exit(report.ok ? 0 : 1)
  } finally {
    client.ws.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
