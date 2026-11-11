// In-process driver for one live task-layer attempt (W7-T2). Runs inside the built Ready Next
// Main process (see attempt-app.mjs) and talks to the real renderer through the same
// window.electronAPI the assistant panel uses: no remote debugging port, no UI clicks.
import { app, BrowserWindow, session } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { blockingResults, modelRequestCount, tokensForAttempt, toolCalls } from './metrics.mjs'

const require = createRequire(import.meta.url)
const HUMAN_BLOCK_KINDS = [
  'challenge_required',
  'login_required',
  'auth_required',
  'verification_required',
  'credential_confirmation_required'
]
const UNATTENDED_ANSWER = '我现在不在电脑前，请你按自己的判断继续完成任务，不要再问我。'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const quote = (value) => JSON.stringify(value)

async function withTimeout(promise, ms, label) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise(
        (_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms) }
      ),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitFor(read, timeoutMs, label, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await read()
      if (last) return last
    } catch (error) {
      last = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`${label} not reached within ${timeoutMs}ms${last instanceof Error ? `: ${last.message}` : ''}`)
}

function isMainRenderer(window) {
  const url = window.webContents.getURL()
  if (!/\/renderer\/index\.html/.test(url)) return false
  const hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''
  return hash === '' || hash === '#/' || hash.startsWith('#/workbench')
}

/** Run an async renderer expression and return its JSON result. */
function rendererCall(window) {
  return (body, timeoutMs = 60_000) => withTimeout(
    window.webContents.executeJavaScript(
      `(async () => { ${body} })().then((value) => JSON.stringify(value ?? null))`,
      true
    )
      .then((text) => JSON.parse(text)),
    timeoutMs,
    'renderer call',
  )
}

async function prepareWorkbench(js, spec) {
  await waitFor(
    () => js('return Boolean(window.electronAPI?.agent?.sendScoped && window.electronAPI?.browser?.createTab)'),
    90_000,
    'renderer API'
  )
  const vault = await js(`return window.electronAPI.vault.set(${quote(spec.workspaceDir)})`)
  if (vault && vault.ok === false) throw new Error(`vault.set failed: ${JSON.stringify(vault)}`)
  await waitFor(() => js(`
    const current = document.querySelector('[data-workbench-mode-panel="browser"][data-mode-visual-state="current"]')
    if (current) return true
    window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'browser', placement: 'open', presentation: 'immediate' } }))
    return false
  `), 60_000, 'browser workbench', 400)
  // A fresh profile opens its own blank start tab first; open ours after it so ours stays active.
  await waitFor(
    async () => (await js('return window.electronAPI.browser.getTabs()'))?.length > 0,
    30_000,
    'startup tab'
  )
  if (spec.cookie) {
    await session.fromPartition('persist:browser').cookies.set({
      url: spec.cookie.url, name: spec.cookie.name, value: spec.cookie.value, path: spec.cookie.path
        || '/', httpOnly: spec.cookie.httpOnly !== false,
    })
  }
  const created = await js(`return window.electronAPI.browser.createTab(${quote(spec.startUrl)})`)
  if (!created?.success || !created.tabId) throw new Error(`createTab failed: ${JSON.stringify(created)}`)
  await waitFor(async () => {
    const tabs = await js('return window.electronAPI.browser.getTabs()')
    const tab = (tabs || []).find((item) => item.id === created.tabId)
    return tab && tab.active && !tab.loading ? tab : null
  }, 45_000, 'start page loaded and active')
  return created.tabId
}

async function readSurface(js, alias) {
  const surface = await js(
    `return window.electronAPI.agent.readCodexActionSurface({ aliasId: ${quote(alias.aliasId)}, aliasGeneration: ${alias.aliasGeneration}, workbenchMode: 'browser' })`
  )
  if (!surface?.success || surface.data?.state !== 'active_head')
    throw new Error(`action surface unavailable: ${JSON.stringify(surface)?.slice(0, 400)}`)
  return surface.data
}

async function prepareSession(js, spec) {
  const created = await js('return window.electronAPI.agent.createSession({})')
  if (!created?.ok || !created.aliasId) throw new Error(`createSession failed: ${JSON.stringify(created)}`)
  const alias = { aliasId: created.aliasId, aliasGeneration: created.aliasGeneration }
  let surface = await readSurface(js, alias)
  const project = await js(
    `return window.electronAPI.agent.setProjectDirectory(${quote(alias.aliasId)}, ${quote(spec.workspaceDir)}, ${surface.scopeEpoch})`
  )
  if (project && project.success === false) throw new Error(`setProjectDirectory failed: ${JSON.stringify(project)}`)
  const mode = await js(
    `return window.electronAPI.agent.setActionAuthorizationMode(${quote(alias.aliasId)}, ${quote(spec.authorizationMode)}, ${surface.scopeEpoch})`
  )
  if (mode && mode.success === false) throw new Error(`setActionAuthorizationMode failed: ${JSON.stringify(mode)}`)
  surface = await readSurface(js, alias)
  return { alias, surface }
}

function buildRequest(spec, alias, surface) {
  const head = surface.head
  const attachments = spec.attachments.map((item, index) => ({
    id: `eval-attachment-${index + 1}`,
    name: item.name,
    path: item.path,
    size: item.size,
    ext: item.name.split('.').pop() || '',
  }))
  const requestId = `eval-${spec.taskId}-${spec.attempt}-${Date.now().toString(36)}`
  return {
    scopeId: alias.aliasId,
    requestId,
    expectedAliasGeneration: head.actionHeadIdentity?.aliasGeneration ?? alias.aliasGeneration,
    expectedMessageVisibilityEpoch: surface.scopeEpoch,
    message: spec.prompt,
    actionAdmissionRef: head.actionHeadIdentity ? {
      headProjectionDigest: head.evidenceDigest,
      actionProjectionVersion: head.actionProjectionVersion,
      actionHeadIdentity: head.actionHeadIdentity,
    } : undefined,
    resources: attachments.map((item) => ({
      kind: 'local_file', id: item.id, name: item.name, path: item.path, size: item.size, ext: item.ext,
      rendererType: /^(csv|xls|xlsx)$/i.test(item.ext)
        ? 'spreadsheet'
        : /^(png|jpe?g|gif|webp)$/i.test(item.ext) ? 'image' : /^(md|txt|json)$/i.test(item.ext) ? 'text' : 'other',
    })),
    userMessage: {
      id: `${requestId}-user`,
      content: spec.prompt,
      timestamp: new Date().toISOString(),
      meta: {
        sourceKind: 'local',
        sourceId: 'app',
        threadKey: alias.aliasId,
        direction: 'local-input',
        workbenchMode: 'browser',
        actionAuthorizationMode: spec.authorizationMode,
        ...(attachments.length
          ? { attachments: attachments.map((item) => ({ ...item, type: 'document', source: 'file' })) }
          : {}),
      },
      attachmentConfirmation: {
        selectedCount: attachments.length,
        metadataCount: attachments.length,
        inputIncludedCount: attachments.length,
        inputFailedCount: 0,
      },
    },
  }
}

/** Answer whatever the run asks while nobody is at the computer, counting each as an intervention. */
async function answerPending(js, counters) {
  const listed = await js('return window.electronAPI.agentInteraction.listPendingAskUserQuestions()', 15_000).catch(
    () => null
  )
  const cards = Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : []
  for (const card of cards) {
    if (counters.handledCards.has(card.cardId)) continue
    counters.handledCards.add(card.cardId)
    const questions = Array.isArray(card.questions) ? card.questions : []
    const confirmation = questions.length === 1 && questions[0].id === 'frozen_call_confirm'
    if (confirmation) counters.confirmations += 1
    else counters.questions += 1
    const answers = questions.map((question) => ({
      id: question.id,
      answer: confirmation ? '确认执行' : UNATTENDED_ANSWER,
    }))
    const submitted = await js(
      `return window.electronAPI.agentInteraction.submitAskUserQuestions(${quote({ cardId: card.cardId, answers })})`,
      15_000
    ).catch(
      (error) => ({ success: false, error: String(error) })
    )
    if (submitted && submitted.success === false) {
      counters.notes.push(`card ${card.cardId} answer rejected (${submitted.error || 'unknown'}), cancelled`)
      await js(
        `return window.electronAPI.agentInteraction.cancelAskUserQuestions(${quote({ cardId: card.cardId, reason: 'eval_unattended' })})`,
        15_000
      ).catch(
        () => null
      )
    }
  }
}

async function stopRun(js, alias, readyRunId) {
  const surface = await readSurface(js, alias).catch(() => null)
  const gate = surface?.lifecycle?.actions?.stop
  if (!gate?.requestRef || gate.requestRef.targetReadyRunId !== readyRunId) return false
  const result = await js(`return window.electronAPI.agent.kill(${quote({
    aliasId: alias.aliasId, aliasGeneration: alias.aliasGeneration, workbenchMode: 'browser', readyRunId, actionRequestRef: gate.requestRef,
  })})`).catch(() => null)
  return Boolean(result?.ok)
}

function openDatabase(profileDir) {
  const Database = require('better-sqlite3')
  return new Database(join(profileDir, 'ready.db'), { readonly: true, fileMustExist: true })
}

async function attempt(spec) {
  const counters = { confirmations: 0, questions: 0, handledCards: new Set(), notes: [] }
  const result = { status: 'error', taskId: spec.taskId, attempt: spec.attempt, notes: counters.notes }
  const window = await waitFor(() => BrowserWindow.getAllWindows().find(isMainRenderer) || null, 120_000, 'main window')
  const js = rendererCall(window)
  result.tabId = await prepareWorkbench(js, spec)
  const { alias, surface } = await prepareSession(js, spec)
  const request = buildRequest(spec, alias, surface)
  result.readyRunId = request.requestId
  if (spec.plumbing) result.requestShape = { keys: Object.keys(request), resources: request.resources.length }
  const started = Date.now()
  await js(`
    window.__readyBrowserEval = { state: 'sending' }
    window.electronAPI.agent.sendScoped(${quote(request)}).then(
      (response) => { window.__readyBrowserEval = { state: 'done', response } },
      (error) => { window.__readyBrowserEval = { state: 'error', error: String(error && error.message || error) } },
    )
    return true
  `)
  const db = openDatabase(spec.profileDir)
  const codexHome = join(spec.profileDir, 'codex-runtime', 'codex-home')
  const deadline = started + spec.limits.maxMinutes * 60_000
  let stopReason = null
  let sent = null
  try {
    while (!sent) {
      await sleep(2_000)
      const state = await js('return window.__readyBrowserEval', 20_000).catch(() => null)
      if (state && state.state !== 'sending') { sent = state; break }
      await answerPending(js, counters)
      if (!stopReason) {
        const steps = toolCalls(db, request.requestId).total
        const tokens = tokensForAttempt({ codexHome, db })
        if (Date.now() > deadline) stopReason = 'timeout'
        else if (steps > spec.limits.maxSteps) stopReason = 'step_limit'
        else if (tokens && tokens.total > spec.maxTokensPerAttempt) stopReason = 'token_limit'
        if (stopReason) {
          counters.notes.push(`stopping run: ${stopReason}`)
          const stopped = await stopRun(js, alias, request.requestId)
          if (!stopped) counters.notes.push('stop request was not accepted')
        }
      } else if (Date.now() > deadline + 120_000) {
        counters.notes.push('run did not finish within two minutes after the stop request')
        break
      }
    }
    result.durationMs = Date.now() - started
    const response = sent?.response || null
    result.disposition = response?.disposition || sent?.state || 'unfinished'
    result.terminal = response?.productTurnReceipt?.terminal || null
    result.failureKind = response?.errorKind || response?.productTurnReceipt?.failure?.kind || sent?.error || null
    result.finalText = String(response?.responseText || response?.canonicalMessage?.content || '')
    const calls = toolCalls(db, request.requestId)
    result.steps = calls.total
    result.toolsByName = calls.byTool
    result.tokens = tokensForAttempt({ codexHome, db })
    result.modelRequests = modelRequestCount(db)
    result.blocking = blockingResults(db)
    const humanBlocks = HUMAN_BLOCK_KINDS.reduce((sum, kind) => sum + (result.blocking[kind] || 0), 0)
    result.interventions = {
      total: counters.confirmations + counters.questions + humanBlocks,
      confirmations: counters.confirmations,
      questions: counters.questions,
      humanBlocks,
      foregroundRefusals: (result.blocking.foreground_required || 0) + (result.blocking.browser_surface_required || 0),
    }
    result.status = stopReason
      || (result.disposition === 'rejected_before_persistence' || result.disposition === 'ingress_persistence_failed'
        ? 'rejected'
        : 'completed')
  } finally {
    db.close()
  }
  return result
}

export function startDriver(spec) {
  app.whenReady().then(async () => {
    let result
    try {
      result = await attempt(spec)
    } catch (error) {
      result = {
        status: 'error',
        taskId: spec.taskId,
        attempt: spec.attempt,
        error: error instanceof Error ? error.stack || error.message : String(error)
      }
    }
    mkdirSync(spec.attemptDir, { recursive: true })
    writeFileSync(join(spec.attemptDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
    // Quit normally so Ready stops its Codex sidecar and closes its database; force after 20 s.
    setTimeout(() => app.exit(result.status === 'error' ? 2 : 0), 20_000).unref()
    app.quit()
  })
}
