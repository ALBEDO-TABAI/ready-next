import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import {
  aggregateGroundedPerformance,
  compareGroundedPerformance,
  enrichProviderPerformanceEvidence,
} from './browser-grounded-performance-evidence.mjs'

const remoteDebuggingPort = Number(process.env.READY_REMOTE_DEBUGGING_PORT || 9333)
const rendererUrl = String(process.env.READY_RENDERER_URL || '').trim()
const outputDir = resolve(process.argv[2] || 'outputs/browser-grounded-orchestration-live')
const reportPath = resolve(outputDir, 'browser-grounded-orchestration-live-report.json')
const proofMode = String(process.env.READY_GROUNDED_PROOF_MODE || 'verify').trim()
const correctnessRepeats = positiveInteger(process.env.READY_GROUNDED_CORRECTNESS_REPEATS, 3)
const performanceRepeats = positiveInteger(process.env.READY_GROUNDED_PERFORMANCE_REPEATS, 20)
const caseFilter = String(process.env.READY_GROUNDED_CASE_FILTER || '').trim()
const baselineReportPath = process.env.READY_GROUNDED_BASELINE_REPORT
  ? resolve(process.env.READY_GROUNDED_BASELINE_REPORT)
  : null
const metricsLogPath = process.env.READY_GROUNDED_METRICS_LOG
  ? resolve(process.env.READY_GROUNDED_METRICS_LOG)
  : null
const baselineMetricsLogPath = process.env.READY_GROUNDED_BASELINE_METRICS_LOG
  ? resolve(process.env.READY_GROUNDED_BASELINE_METRICS_LOG)
  : null
const userDataDir = process.env.READY_USER_DATA_DIR ? resolve(process.env.READY_USER_DATA_DIR) : null
const databasePath = process.env.READY_DB_PATH
  ? resolve(process.env.READY_DB_PATH)
  : userDataDir
    ? resolve(userDataDir, 'ready.db')
    : null

const fixtureManifest = [
  fixture('en-nav-list', 'en', 'navigation', 'list', 'Amber Atlas', 'amber atlas'),
  fixture('en-spa-grid', 'en', 'spa', 'grid', 'Cobalt Ledger', 'cobalt ledger'),
  { ...fixture('en-nav-table', 'en', 'navigation', 'table', 'Ivory Signal', 'ivory signal'), simpleRead: true },
  fixture('zh-spa-cards', 'zh', 'spa', 'cards', '青岚档案', '青岚档案'),
  fixture('zh-nav-list', 'zh', 'navigation', 'list', '松影记录', '松影记录'),
  fixture('zh-spa-icon', 'zh', 'spa', 'icon', '星河索引', '星河索引'),
  fixture('ja-nav-grid', 'ja', 'navigation', 'grid', '蒼い航路', '蒼い航路'),
  fixture('ja-spa-table', 'ja', 'spa', 'table', '白樺記録', '白樺記録'),
  fixture('ja-nav-cards', 'ja', 'navigation', 'cards', '月影台帳', '月影台帳'),
  { ...fixture('it-spa-list', 'it', 'spa', 'list', 'Atlante Verde', 'atlante verde'), latentRoute: true },
  fixture('it-nav-icon', 'it', 'navigation', 'icon', 'Registro Corallo', 'registro corallo'),
  {
    ...fixture('it-spa-triple', 'it', 'spa', 'cards', 'Archivio Smeraldo', 'archivio smeraldo'),
    goals: [
      { query: 'archivio smeraldo', exists: true },
      { query: 'taccuino rame', exists: true },
      { query: 'documento inesistente', exists: false },
    ],
  },
]

// Compare orchestration overhead on an identical read-only page. The legacy
// runtime cannot complete the generic multi-step fixture at all, so using it
// as a latency baseline would reward a fast failure rather than useful work.
const performanceFixtureIds = ['en-nav-table']
const pageWriteEventKinds = new Set(['beforeinput', 'input', 'change', 'keydown', 'click', 'submit', 'scroll'])

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function fixture(id, locale, transport, structure, title, query) {
  return { id, locale, transport, structure, title, goals: [{ query, exists: true }] }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex')
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function stableDigest(value) {
  return sha256(stableJson(value))
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function sqlQuote(value) {
  return `'${String(value || '').replaceAll("'", "''")}'`
}

function parseJson(raw, fallback = null) {
  try {
    return JSON.parse(String(raw || ''))
  } catch {
    return fallback
  }
}

function localizedLabels(locale) {
  if (locale === 'zh') return {
    search: '搜索档案', submit: '搜索', results: '搜索结果', empty: '没有匹配结果',
    open: '打开记录', code: '校验码', metric: '可信度', detail: '记录详情',
  }
  if (locale === 'ja') return {
    search: '記録を検索', submit: '検索', results: '検索結果', empty: '一致する結果はありません',
    open: '記録を開く', code: '確認コード', metric: '信頼度', detail: '記録の詳細',
  }
  if (locale === 'it') return {
    search: 'Cerca archivio', submit: 'Cerca', results: 'Risultati', empty: 'Nessun risultato trovato',
    open: 'Apri record', code: 'Codice di verifica', metric: 'Affidabilita', detail: 'Dettaglio record',
  }
  return {
    search: 'Search records', submit: 'Search', results: 'Search results', empty: 'No matching result',
    open: 'Open record', code: 'Verification code', metric: 'Confidence', detail: 'Record detail',
  }
}

function buildPrompt(fixtureCase) {
  const queries = fixtureCase.goals.map((goal) => goal.query)
  const jsonContract = '{"results":[{"query":"...","status":"found|not_found","verificationCode":"... or null","metric":123 or null}]}'
  if (fixtureCase.simpleRead) {
    return `Read the verification code and confidence shown in the current page's “${queries[0]}” record. Do not change the page. Return only this JSON: ${jsonContract}`
  }
  if (fixtureCase.locale === 'zh') {
    return `只在当前网站完成这些目标：依次搜索 ${queries.map((query) => `“${query}”`).join('、')}，打开最匹配的记录，并读取详情页的校验码和可信度。找不到的目标必须标为 not_found，不能猜测。最终只返回这个 JSON 结构，顺序与目标一致：${jsonContract}`
  }
  if (fixtureCase.locale === 'ja') {
    return `現在のサイトだけを使って、${queries.map((query) => `「${query}」`).join('、')} を順番に検索し、最も一致する記録を開いて、詳細ページの確認コードと信頼度を読んでください。見つからない項目は推測せず not_found にしてください。最後は次の JSON だけを同じ順序で返してください: ${jsonContract}`
  }
  if (fixtureCase.locale === 'it') {
    return `Usa soltanto il sito corrente. Cerca in ordine ${queries.map((query) => `“${query}”`).join(', ')}, apri il record piu pertinente e leggi il codice di verifica e l'affidabilita nella pagina di dettaglio. Se un obiettivo non esiste, usa not_found senza inventare dati. Restituisci soltanto questo JSON nello stesso ordine: ${jsonContract}`
  }
  return `Use only the current site. Search for ${queries.map((query) => `“${query}”`).join(', ')} in order, open the best matching record, and read its verification code and confidence from the detail page. If a goal does not exist, return not_found without guessing. Return only this JSON in the same order: ${jsonContract}`
}

function createFixtureInstance(fixtureCase, phase, repeat) {
  const key = `${fixtureCase.id}-${phase}-${repeat}-${randomBytes(5).toString('hex')}`
  return {
    key,
    fixture: fixtureCase,
    phase,
    repeat,
    createdAt: Date.now(),
    goals: fixtureCase.goals.map((goal, index) => ({
      ...goal,
      marker: goal.exists ? `READY-${randomBytes(8).toString('hex').toUpperCase()}` : null,
      metric: goal.exists ? 300 + index * 47 + Number.parseInt(randomBytes(1).toString('hex'), 16) : null,
    })),
    events: [],
    searchRequests: [],
    detailRequests: [],
  }
}

function goalForQuery(instance, query) {
  const normalized = String(query || '').trim().toLocaleLowerCase()
  return instance.goals.find((goal) => goal.query.toLocaleLowerCase() === normalized) || null
}

function resultMarkup(instance, query) {
  const labels = localizedLabels(instance.fixture.locale)
  const goal = goalForQuery(instance, query)
  if (!goal?.exists) return `<p role="status" data-empty="true">${escapeHtml(labels.empty)}</p>`
  const href = `/detail/${encodeURIComponent(instance.key)}?query=${encodeURIComponent(goal.query)}`
  const anchor = `<a data-result-query="${escapeHtml(goal.query)}" href="${href}">${escapeHtml(labels.open)}: ${escapeHtml(goal.query)}</a>`
  if (instance.fixture.structure === 'grid') {
    return `<section aria-label="${escapeHtml(labels.results)}" class="grid"><article><h2>${escapeHtml(goal.query)}</h2>${anchor}</article></section>`
  }
  if (instance.fixture.structure === 'table') {
    return `<table aria-label="${escapeHtml(labels.results)}"><tbody><tr><th>${escapeHtml(goal.query)}</th><td>${anchor}</td></tr></tbody></table>`
  }
  if (instance.fixture.structure === 'cards' || instance.fixture.structure === 'icon') {
    return `<section aria-label="${escapeHtml(labels.results)}"><div class="card"><h3>${escapeHtml(goal.query)}</h3><p>${escapeHtml(instance.fixture.title)}</p>${anchor}</div></section>`
  }
  return `<ol aria-label="${escapeHtml(labels.results)}"><li><strong>${escapeHtml(goal.query)}</strong> ${anchor}</li></ol>`
}

function probeScript(instance, extra = '') {
  return `<script>
    (() => {
      const endpoint = ${JSON.stringify(`/event/${instance.key}`)}
      const emit = (kind, detail = {}) => {
        const payload = JSON.stringify({ kind, detail, clientAt: Date.now(), href: location.href })
        try { navigator.sendBeacon(endpoint, new Blob([payload], { type: 'application/json' })) }
        catch { fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, keepalive: true }).catch(() => {}) }
      }
      for (const kind of ['beforeinput', 'input', 'change', 'keydown', 'click', 'submit']) {
        document.addEventListener(kind, (event) => emit(kind, {
          tag: event.target?.tagName || null,
          name: event.target?.getAttribute?.('name') || null,
          value: typeof event.target?.value === 'string' ? event.target.value : null,
          key: event.key || null,
          query: event.target instanceof HTMLFormElement ? new FormData(event.target).get('q') : null,
          href: event.target instanceof HTMLAnchorElement ? event.target.href : null,
          text: event.target instanceof Element ? (event.target.textContent || '').trim().slice(0, 240) : null,
        }), true)
      }
      window.addEventListener('scroll', () => emit('scroll', { x: scrollX, y: scrollY }), { passive: true })
      window.__READY_GROUNDED_FIXTURE__ = { key: ${JSON.stringify(instance.key)}, markerDigest: ${JSON.stringify(sha256(instance.goals.map((goal) => goal.marker).join('|')))} }
      ${extra}
    })()
  </script>`
}

function renderMainPage(instance, query) {
  const labels = localizedLabels(instance.fixture.locale)
  const action = `/case/${encodeURIComponent(instance.key)}`
  const input = `<input id="fixture-query" name="q" type="search" value="${escapeHtml(query)}" aria-label="${escapeHtml(labels.search)}" autocomplete="off">`
  const button = instance.fixture.structure === 'icon'
    ? `<button type="submit" aria-label="${escapeHtml(labels.submit)}" title="${escapeHtml(labels.submit)}">⌕</button>`
    : `<button type="submit">${escapeHtml(labels.submit)}</button>`
  const simpleGoal = instance.fixture.simpleRead ? instance.goals[0] : null
  const initialResults = simpleGoal
    ? `<article aria-label="${escapeHtml(simpleGoal.query)}"><h2>${escapeHtml(simpleGoal.query)}</h2><dl><dt>${escapeHtml(labels.code)}</dt><dd data-verification-code>${escapeHtml(simpleGoal.marker)}</dd><dt>${escapeHtml(labels.metric)}</dt><dd data-confidence>${simpleGoal.metric}</dd></dl></article>`
    : instance.fixture.transport === 'navigation' && query
      ? resultMarkup(instance, query)
      : `<p role="status">${escapeHtml(labels.search)}</p>`
  const spaScript = instance.fixture.transport === 'spa'
    ? `
      const form = document.querySelector('form')
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        const query = new FormData(form).get('q') || ''
        const response = await fetch('/api/${instance.key}?q=' + encodeURIComponent(query))
        const payload = await response.json()
        await new Promise((resolve) => setTimeout(resolve, 80))
        document.querySelector('#results').innerHTML = payload.html
        history.replaceState({}, '', '/case/${instance.key}?q=' + encodeURIComponent(query))
        emit('site_effect', { query, resultCount: payload.resultCount })
      })
    `
    : ''
  return `<!doctype html><html lang="${instance.fixture.locale}"><head><meta charset="utf-8"><title>${escapeHtml(instance.fixture.title)}</title><style>
    body{font:16px system-ui;margin:32px;max-width:920px;line-height:1.5}form{display:flex;gap:10px;align-items:end;margin:22px 0}label{display:grid;gap:6px}input{min-width:340px;padding:10px}button,a{font:inherit}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.card,article,li,td,th{padding:14px}.card,article{border:1px solid #bbb;border-radius:10px}table{border-collapse:collapse}td,th{border:1px solid #bbb}
  </style></head><body><main><h1>${escapeHtml(instance.fixture.title)}</h1><form action="${action}" method="get" role="search"><label>${escapeHtml(labels.search)}${input}</label>${button}</form><div id="results" aria-live="polite">${initialResults}</div></main>${probeScript(instance, spaScript)}</body></html>`
}

function renderDetailPage(instance, query) {
  const labels = localizedLabels(instance.fixture.locale)
  const goal = goalForQuery(instance, query)
  if (!goal?.exists) return null
  return `<!doctype html><html lang="${instance.fixture.locale}"><head><meta charset="utf-8"><title>${escapeHtml(query)}</title><style>body{font:16px system-ui;margin:32px;max-width:760px;line-height:1.6}dl{padding:18px;background:#eef3ff}dt{font-weight:700}</style></head><body><main><p>${escapeHtml(labels.detail)}</p><h1>${escapeHtml(query)}</h1><dl><dt>${escapeHtml(labels.code)}</dt><dd data-verification-code>${escapeHtml(goal.marker)}</dd><dt>${escapeHtml(labels.metric)}</dt><dd data-confidence>${goal.metric}</dd></dl></main>${probeScript(instance, `emit('detail_loaded', { query: ${JSON.stringify(query)} })`)}</body></html>`
}

async function readRequestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function startFixtureServer(instances) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const segments = url.pathname.split('/').filter(Boolean)
    const route = segments[0] || ''
    const key = decodeURIComponent(segments[1] || '')
    const instance = instances.get(key)
    if (!instance) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }
    if (route === 'event' && request.method === 'POST') {
      const event = parseJson(await readRequestBody(request), {}) || {}
      instance.events.push({
        kind: String(event.kind || 'unknown'),
        detail: event.detail && typeof event.detail === 'object' ? event.detail : {},
        clientAt: Number(event.clientAt) || Date.now(),
        serverAt: Date.now(),
        href: String(event.href || ''),
      })
      response.writeHead(204)
      response.end()
      return
    }
    if (route === 'api') {
      const query = url.searchParams.get('q') || ''
      instance.searchRequests.push({ query, at: Date.now(), transport: 'spa' })
      const goal = goalForQuery(instance, query)
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ html: resultMarkup(instance, query), resultCount: goal?.exists ? 1 : 0 }))
      return
    }
    if (route === 'detail') {
      const query = url.searchParams.get('query') || ''
      const html = renderDetailPage(instance, query)
      if (!html) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('not found')
        return
      }
      instance.detailRequests.push({ query, at: Date.now() })
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(html)
      return
    }
    if (route === 'case') {
      const query = url.searchParams.get('q') || ''
      if (query && instance.fixture.transport === 'navigation') {
        instance.searchRequests.push({ query, at: Date.now(), transport: 'navigation' })
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(renderMainPage(instance, query))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server did not expose a TCP port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  }
}

async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/list`)
  if (!response.ok) throw new Error(`CDP target list failed: ${response.status}`)
  return response.json()
}

async function findRendererTarget(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const targets = await listTargets().catch(() => [])
    const target = targets.find((item) => item.type === 'page' && (
      rendererUrl
        ? item.url === rendererUrl
        : /^http:\/\/localhost:\d+\/$/.test(String(item.url || ''))
    ))
    if (target?.webSocketDebuggerUrl) return target
    await sleep(300)
  }
  throw new Error('Ready renderer target not found')
}

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  let sequence = 0
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message || 'CDP call failed'))
    else entry.resolve(message.result)
  })
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', rejectOpen, { once: true })
  })
  const send = (method, params = {}) => new Promise((resolveSend, rejectSend) => {
    const id = ++sequence
    pending.set(id, { resolve: resolveSend, reject: rejectSend })
    socket.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  return { socket, send }
}

async function evaluate(client, expression, timeoutMs = 420_000) {
  let timer
  try {
    const result = await Promise.race([
      client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Runtime.evaluate timed out')), timeoutMs) }),
    ])
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime.evaluate failed')
    }
    const value = result.result?.value
    return typeof value === 'string' ? JSON.parse(value) : value
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function buildCaseExpression(fixtureUrl, prompt, latentRoute) {
  return `(
    async () => {
      const api = window.electronAPI?.browser
      const agent = window.electronAPI?.agent
      const harness = window.__READY_AGENT_TEST__
      if (!api?.createTab || !api?.switchTab || !api?.closeTab || !agent?.listTaskProjections || !agent?.getConversationScopeMessages || !harness?.submit) {
        return JSON.stringify({ ok: false, error: 'missing-live-browser-agent-or-harness-api' })
      }
      const requestedMode = ${latentRoute ? JSON.stringify('document') : JSON.stringify('browser')}
      const modeButton = document.querySelector('button[data-mode="' + requestedMode + '"]')
      if (!modeButton) return JSON.stringify({ ok: false, error: requestedMode + '-mode-button-not-found' })
      modeButton.click()
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
      const created = await api.createTab(${JSON.stringify(fixtureUrl)})
      const sourceTabId = created?.tabId
      if (!sourceTabId) return JSON.stringify({ ok: false, error: 'fixture-tab-not-created', created })
      try {
        await api.switchTab(sourceTabId)
        await new Promise((resolveWait) => setTimeout(resolveWait, 500))
        harness.clearAttachments?.()
        harness.clearEvents?.()
        if (!harness.sessionSummary().activeSessionId) {
          const visibleSession = await harness.createVisibleSession()
          if (!visibleSession.ok) {
            return JSON.stringify({ ok: false, error: visibleSession.error || 'visible-session-setup-failed' })
          }
        }
        await Promise.race([
          harness.newSession(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('new-session-timeout')), 10000)),
        ])
        const startedAt = Date.now()
        const result = await harness.submit(${JSON.stringify(prompt)}, {
          mode: 'dom',
          allowStoreFallback: false,
          timeoutMs: 360000,
          pollMs: 500,
        })
        await new Promise((resolveWait) => setTimeout(resolveWait, 250))
        const snapshot = await harness.snapshot()
        const scopeId = snapshot.currentScopeId
        const projectionsResult = scopeId ? await agent.listTaskProjections(scopeId) : null
        const messagesResult = scopeId ? await agent.getConversationScopeMessages(scopeId) : null
        return JSON.stringify({
          ok: result.ok,
          startedAt,
          finishedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          scopeId,
          sourceTabId,
          inputMode: result.inputMode,
          sendResult: result.sendResult,
          toolTrace: snapshot.toolTrace,
          diagnostics: result.diagnostics,
          activeRun: snapshot.runtime.activeRun,
          taskCards: snapshot.taskCards,
          projections: projectionsResult?.success ? projectionsResult.data : [],
          projectionError: projectionsResult?.success ? null : projectionsResult?.error || null,
          messages: messagesResult?.success ? messagesResult.data : [],
          messageError: messagesResult?.success ? null : messagesResult?.error || null,
          visibleMessages: snapshot.messages,
          harnessEvents: harness.events?.() || [],
        })
      } finally {
        if (${latentRoute ? 'true' : 'false'}) {
          document.querySelector('button[data-mode="browser"]')?.click()
          await new Promise((resolveWait) => setTimeout(resolveWait, 300))
        }
        await api.closeTab(sourceTabId).catch(() => {})
      }
    }
  )()`
}

function sqliteRows(sql) {
  if (!databasePath || !existsSync(databasePath)) return []
  const output = execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', databasePath, sql], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  }).trim()
  return output ? parseJson(output, []) : []
}

function readDatabaseEvidence(scopeId, runId) {
  if (!scopeId || !databasePath || !existsSync(databasePath)) return { available: false, error: 'ready_db_unavailable' }
  try {
    const projections = sqliteRows(`SELECT task_id, scope_id, run_id, parent_task_id, task_type, module, status, interaction_state, revision, dependency_generation, request_anchor_json, updated_at FROM task_projections WHERE scope_id = ${sqlQuote(scopeId)} ORDER BY created_at ASC;`)
    const browserTasks = sqliteRows(`SELECT b.id, b.kind, b.status, b.parent_task_id, b.created_by_run_id, b.revision, b.active_execution_binding_json, b.payload_json, b.checkpoint_json, b.result_json, b.error, b.started_at, b.updated_at, b.finished_at FROM browser_tasks b JOIN task_projections p ON p.task_id = b.parent_task_id WHERE p.scope_id = ${sqlQuote(scopeId)} ORDER BY b.created_at ASC;`)
    const messages = sqliteRows(`SELECT id, conversation_id, role, content, timestamp, meta_json FROM chat_messages WHERE conversation_id = ${sqlQuote(scopeId)} ORDER BY timestamp ASC;`)
    const runMeta = runId
      ? sqliteRows(`SELECT run_id, task_id, scope_id, status, terminal_reason, duration_ms, input_tokens, output_tokens, total_tokens, provider_diagnostics_json, budget_json, created_at, updated_at FROM run_meta WHERE run_id = ${sqlQuote(runId)} LIMIT 1;`)[0] || null
      : sqliteRows(`SELECT run_id, task_id, scope_id, status, terminal_reason, duration_ms, input_tokens, output_tokens, total_tokens, provider_diagnostics_json, budget_json, created_at, updated_at FROM run_meta WHERE scope_id = ${sqlQuote(scopeId)} ORDER BY updated_at DESC LIMIT 1;`)[0] || null
    return {
      available: true,
      projections: projections.map((row) => ({
        ...row,
        requestAnchor: parseJson(row.request_anchor_json, null),
      })),
      browserTasks: browserTasks.map((row) => ({
        ...row,
        activeExecutionBinding: parseJson(row.active_execution_binding_json, null),
        payload: parseJson(row.payload_json, {}),
        checkpoint: parseJson(row.checkpoint_json, null),
        result: parseJson(row.result_json, null),
      })),
      messages: messages.map((row) => ({ ...row, meta: parseJson(row.meta_json, {}) })),
      runMeta: runMeta ? {
        ...runMeta,
        providerDiagnostics: parseJson(runMeta.provider_diagnostics_json, null),
        budget: parseJson(runMeta.budget_json, null),
      } : null,
    }
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function extractJsonObject(text) {
  const normalized = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = normalized.indexOf('{')
  const end = normalized.lastIndexOf('}')
  return start >= 0 && end > start ? parseJson(normalized.slice(start, end + 1), null) : null
}

function countByQuery(records) {
  const counts = new Map()
  for (const record of records) {
    const key = String(record.query || '').trim().toLocaleLowerCase()
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}

function compactCaseResult(instance, rawResult, databaseEvidence, architectureRequired) {
  const messages = Array.isArray(rawResult?.messages) ? rawResult.messages : []
  const dbMessages = databaseEvidence.available ? databaseEvidence.messages : []
  const canonicalCandidates = dbMessages.filter((message) => message.role === 'assistant' && String(message.id).startsWith('assistant:'))
  const fallbackAssistant = [...messages].reverse().find((message) => message.role === 'assistant') || null
  const canonical = canonicalCandidates[canonicalCandidates.length - 1] || fallbackAssistant
  const outcome = extractJsonObject(canonical?.content)
  const outcomeResults = Array.isArray(outcome?.results) ? outcome.results : []
  const goalChecks = instance.goals.map((goal, index) => {
    const actual = outcomeResults[index] && typeof outcomeResults[index] === 'object' ? outcomeResults[index] : {}
    const queryMatches = String(actual.query || '').trim().toLocaleLowerCase() === goal.query.toLocaleLowerCase()
    if (!goal.exists) {
      return {
        query: goal.query,
        expected: 'not_found',
        ok: queryMatches && actual.status === 'not_found' && actual.verificationCode == null && actual.metric == null,
      }
    }
    return {
      query: goal.query,
      expected: 'found',
      ok: queryMatches
        && actual.status === 'found'
        && actual.verificationCode === goal.marker
        && Number(actual.metric) === goal.metric,
    }
  })
  const searchCounts = countByQuery(instance.searchRequests)
  const detailCounts = countByQuery(instance.detailRequests)
  const submitCounts = countByQuery(instance.events
    .filter((event) => event.kind === 'submit')
    .map((event) => ({ query: event.detail?.query })))
  const detailClickCounts = countByQuery(instance.events
    .filter((event) => event.kind === 'click' && event.detail?.tag === 'A')
    .map((event) => {
      try {
        return { query: new URL(String(event.detail?.href || '')).searchParams.get('query') || '' }
      } catch {
        return { query: '' }
      }
    }))
  const duplicateDispatches = instance.goals.reduce((total, goal) => {
    const key = goal.query.toLocaleLowerCase()
    const expectedSearches = instance.fixture.simpleRead ? 0 : 1
    const expectedDetails = instance.fixture.simpleRead ? 0 : goal.exists ? 1 : 0
    return total + Math.max(0, (searchCounts.get(key) || 0) - expectedSearches) + Math.max(0, (detailCounts.get(key) || 0) - expectedDetails)
  }, 0)
  const fixtureGoalChecks = instance.goals.map((goal) => {
    const key = goal.query.toLocaleLowerCase()
    const expectedSearches = instance.fixture.simpleRead ? 0 : 1
    const expectedDetails = instance.fixture.simpleRead ? 0 : goal.exists ? 1 : 0
    return {
      query: goal.query,
      searches: searchCounts.get(key) || 0,
      submits: submitCounts.get(key) || 0,
      detailClicks: detailClickCounts.get(key) || 0,
      detailLoads: detailCounts.get(key) || 0,
      ok: (searchCounts.get(key) || 0) === expectedSearches
        && (submitCounts.get(key) || 0) === expectedSearches
        && (detailClickCounts.get(key) || 0) <= expectedDetails
        && (detailCounts.get(key) || 0) === expectedDetails,
    }
  })

  const workflowChildren = databaseEvidence.available
    ? databaseEvidence.browserTasks.filter((task) => task.kind === 'browser_workflow')
    : []
  const child = workflowChildren[0] || null
  const journal = child?.payload?.browserWorkflowActionJournal || null
  const observationResources = Array.isArray(child?.payload?.browserWorkflowObservationResources)
    ? child.payload.browserWorkflowObservationResources
    : []
  const settled = Array.isArray(journal?.settledOutcomes) ? journal.settledOutcomes : []
  const observations = Array.isArray(journal?.observationReceipts) ? journal.observationReceipts : []
  const sequences = settled.map((entry) => Number(entry.actionSeq)).filter(Number.isFinite)
  const journalSequenceValid = (sequences.length > 0 || instance.fixture.simpleRead)
    && sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1])
    && new Set(sequences).size === sequences.length
  const settledByActionId = new Map(settled.map((entry) => [entry.actionId, entry]))
  const observedActionIds = observations.flatMap((receipt) => (
    Array.isArray(receipt.causalActions)
      ? receipt.causalActions.map((action) => action.actionId)
      : []
  ))
  const observationCausalityValid = observations.every((receipt) => {
    const causalActions = Array.isArray(receipt.causalActions) ? receipt.causalActions : []
    const highest = causalActions.reduce((value, action) => Math.max(value, Number(action.actionSeq) || 0), 0)
    return highest === Number(receipt.observedAfterActionSeq || 0)
      && causalActions.every((action) => {
        const settledEntry = settledByActionId.get(action.actionId)
        return Boolean(settledEntry)
          && Number(settledEntry.actionSeq) === Number(action.actionSeq)
          && JSON.stringify(settledEntry.outcome?.identity || null) === JSON.stringify(action.predecessorIdentity || null)
          && JSON.stringify(settledEntry.outcome?.successorIdentity || null) === JSON.stringify(action.successorIdentity || null)
      })
  })
    && new Set(observedActionIds).size === observedActionIds.length
    && settled
      .filter((entry) => entry.outcome?.needsObservation === true)
      .every((entry) => observedActionIds.includes(entry.actionId))
  const resourceById = new Map(observationResources.map((resource) => [resource.resourceId, resource]))
  const observationResourcesValid = observations.length === observationResources.length
    && observations.every((receipt) => {
      const resource = resourceById.get(receipt.resourceId)
      if (!resource || resource.taskId !== child?.id) return false
      if (resource.operationId !== receipt.operationId || resource.ownerRunId !== receipt.ownerRunId) return false
      if (JSON.stringify(resource.identity || null) !== JSON.stringify(receipt.identity || null)) return false
      if (sha256(resource.content) !== resource.contentDigest) return false
      if (resource.provenanceDigest !== stableDigest({
        taskId: child.id,
        operationId: receipt.operationId,
        ownerRunId: receipt.ownerRunId,
        identity: receipt.identity,
        resultDigest: receipt.resultDigest,
        observedAt: receipt.observedAt,
      })) return false
      const parsedContent = parseJson(resource.content, null)
      if (!parsedContent) return false
      return receipt.resultDigest === stableDigest(parsedContent)
    })
  const finalSettledAt = settled.reduce((latest, entry) => Math.max(latest, Date.parse(entry.settledAt || '') || 0), 0)
  const latePageWrites = finalSettledAt > 0
    ? instance.events.filter((event) => pageWriteEventKinds.has(event.kind) && event.clientAt > finalSettledAt + 5)
    : []
  const parent = databaseEvidence.available
    ? databaseEvidence.projections.find((projection) => !projection.parent_task_id && (!rawResult?.activeRun?.taskId || projection.task_id === rawResult.activeRun.taskId))
      || databaseEvidence.projections.find((projection) => !projection.parent_task_id)
      || null
    : null
  const ipcCanonicalCandidates = messages.filter((message) => (
    message.role === 'assistant' && String(message.id).startsWith('assistant:')
  ))
  const ipcCanonical = ipcCanonicalCandidates[ipcCanonicalCandidates.length - 1] || null
  const visibleCanonicalCandidates = (Array.isArray(rawResult?.visibleMessages) ? rawResult.visibleMessages : [])
    .filter((message) => message.type === 'agent' && message.id === canonical?.id)
  const visibleCanonical = visibleCanonicalCandidates[visibleCanonicalCandidates.length - 1] || null
  const canonicalDigest = canonical ? sha256(JSON.stringify({
    id: canonical.id,
    conversationId: canonical.conversation_id || canonical.conversationId,
    role: canonical.role,
    content: canonical.content,
    timestamp: canonical.timestamp,
    meta: canonical.meta || {},
  })) : null
  const ipcCanonicalDigest = ipcCanonical ? sha256(JSON.stringify({
    id: ipcCanonical.id,
    conversationId: ipcCanonical.conversation_id || ipcCanonical.conversationId,
    role: ipcCanonical.role,
    content: ipcCanonical.content,
    timestamp: ipcCanonical.timestamp,
    meta: ipcCanonical.meta || {},
  })) : null
  const returnedDigest = rawResult?.sendResult?.canonicalMessageDigest || null
  const visibleMetaKeys = Array.isArray(visibleCanonical?.metaKeys) ? visibleCanonical.metaKeys : []
  const persistedMetaKeys = Object.keys(canonical?.meta || {}).sort()
  const canonicalReadbackOk = architectureRequired
    ? canonicalCandidates.length === 1
      && ipcCanonicalCandidates.length === 1
      && visibleCanonicalCandidates.length === 1
      && Boolean(canonical?.id)
      && ipcCanonicalDigest === canonicalDigest
      && visibleCanonical.id === canonical.id
      && visibleCanonical.content === canonical.content
      && visibleCanonical.timestamp === canonical.timestamp
      && JSON.stringify(visibleMetaKeys) === JSON.stringify(persistedMetaKeys)
      && (!returnedDigest || returnedDigest === canonicalDigest)
    : Boolean(canonical?.content)
  const canonicalReadbackEvidence = {
    persistedCandidateCount: canonicalCandidates.length,
    ipcCandidateCount: ipcCanonicalCandidates.length,
    visibleCandidateCount: visibleCanonicalCandidates.length,
    canonicalMessageId: canonical?.id || null,
    persistedDigest: canonicalDigest,
    ipcDigest: ipcCanonicalDigest,
    returnedDigest,
    persistedIpcDigestMatched: Boolean(canonicalDigest) && ipcCanonicalDigest === canonicalDigest,
    visibleMessageMatched: Boolean(visibleCanonical)
      && visibleCanonical.id === canonical?.id
      && visibleCanonical.content === canonical?.content
      && visibleCanonical.timestamp === canonical?.timestamp
      && JSON.stringify(visibleMetaKeys) === JSON.stringify(persistedMetaKeys),
  }
  const runMetaTerminal = Boolean(databaseEvidence.runMeta)
    && databaseEvidence.runMeta.status === 'done'
    && databaseEvidence.runMeta.task_id === parent?.task_id
    && databaseEvidence.runMeta.scope_id === (rawResult?.scopeId || null)
  const canonicalOwnerReadback = Boolean(canonical)
    && canonical.meta?.taskId === parent?.task_id
    && canonical.meta?.runId === databaseEvidence.runMeta?.run_id
  const architectureChecks = {
    databaseAvailable: databaseEvidence.available,
    oneBrowserWorkflowChild: workflowChildren.length === 1 && databaseEvidence.browserTasks.length === 1,
    childCompleted: child?.status === 'completed',
    parentCompleted: parent?.status === 'completed' && parent?.interaction_state !== 'running',
    journalSettled: Boolean(journal)
      && journal.activeAction == null
      && (instance.fixture.simpleRead ? observations.length > 0 : settled.length > 0),
    journalSequenceValid,
    observationCausalityValid,
    observationReadback: observations.length > 0 && observationResourcesValid,
    observationResourcesValid,
    canonicalReadback: canonicalReadbackOk,
    canonicalOwnerReadback,
    runMetaTerminal,
    latePageWrites: latePageWrites.length,
  }
  const architectureOk = !architectureRequired || (
    architectureChecks.databaseAvailable
    && architectureChecks.oneBrowserWorkflowChild
    && architectureChecks.childCompleted
    && architectureChecks.parentCompleted
    && architectureChecks.journalSettled
    && architectureChecks.journalSequenceValid
    && architectureChecks.observationCausalityValid
    && architectureChecks.observationReadback
    && architectureChecks.observationResourcesValid
    && architectureChecks.canonicalReadback
    && architectureChecks.canonicalOwnerReadback
    && architectureChecks.runMetaTerminal
    && architectureChecks.latePageWrites === 0
  )
  const toolTrace = Array.isArray(rawResult?.toolTrace) ? rawResult.toolTrace : []
  const toolCalls = [...new Map(toolTrace
    .filter((item) => item.kind === 'call')
    .map((item) => [`${item.kind}:${item.timestamp}:${item.text}`, item])).values()]
  const sourceMessageId = parent?.requestAnchor?.sourceMessageId || null
  const sourceMessage = sourceMessageId
    ? dbMessages.find((message) => message.id === sourceMessageId)
    : dbMessages.find((message) => message.role === 'user')
  const canonicalDurationMs = sourceMessage?.timestamp && canonical?.timestamp
    ? Math.max(0, Date.parse(canonical.timestamp) - Date.parse(sourceMessage.timestamp))
    : null
  const firstProgressAt = [
    ...instance.searchRequests.map((item) => item.at),
    ...instance.events.filter((event) => pageWriteEventKinds.has(event.kind)).map((event) => event.clientAt),
  ].filter(Number.isFinite).sort((left, right) => left - right)[0] || null
  const diagnosticErrors = (rawResult?.diagnostics || []).filter((diagnostic) => diagnostic.severity === 'error')
  const markerLeak = instance.goals.some((goal) => goal.marker && buildPrompt(instance.fixture).includes(goal.marker))
  const ok = rawResult?.ok === true
    && diagnosticErrors.length === 0
    && !markerLeak
    && goalChecks.every((check) => check.ok)
    && fixtureGoalChecks.every((check) => check.ok)
    && duplicateDispatches === 0
    && architectureOk
  return {
    id: instance.fixture.id,
    locale: instance.fixture.locale,
    transport: instance.fixture.transport,
    structure: instance.fixture.structure,
    phase: instance.phase,
    repeat: instance.repeat,
    ok,
    harnessOk: rawResult?.ok === true,
    scopeId: rawResult?.scopeId || null,
    runId: rawResult?.activeRun?.requestId || databaseEvidence.runMeta?.run_id || null,
    parentTaskId: parent?.task_id || rawResult?.activeRun?.taskId || null,
    promptDigest: sha256(buildPrompt(instance.fixture)),
    markerDigest: sha256(instance.goals.map((goal) => goal.marker).join('|')),
    markerLeak,
    goalChecks,
    fixtureGoalChecks,
    duplicateDispatches,
    latePageWrites: latePageWrites.map((event) => ({ kind: event.kind, clientAt: event.clientAt, detail: event.detail })),
    architectureChecks,
    canonicalReadbackEvidence,
    metrics: {
      durationMs: Number(rawResult?.durationMs) || null,
      runtimeDurationMs: Number(databaseEvidence.runMeta?.duration_ms) || null,
      canonicalDurationMs: Number.isFinite(canonicalDurationMs) ? canonicalDurationMs : null,
      firstProgressMs: firstProgressAt && rawResult?.startedAt ? Math.max(0, firstProgressAt - rawResult.startedAt) : null,
      toolCalls: toolCalls.length,
      inputTokens: Number(databaseEvidence.runMeta?.input_tokens) || null,
      totalTokens: Number(databaseEvidence.runMeta?.total_tokens) || null,
      settledActions: settled.length,
      observations: observations.length,
    },
    toolNames: [...new Set(toolCalls.map((item) => String(item.text || '').split('(')[0].trim()).filter(Boolean))],
    diagnostics: rawResult?.diagnostics || [],
    error: rawResult?.error || databaseEvidence.error || null,
  }
}

const selectedManifest = caseFilter
  ? fixtureManifest.filter((item) => item.id.includes(caseFilter))
  : fixtureManifest
const runCorrectness = proofMode !== 'baseline'
const runPerformance = proofMode !== 'correctness'
const architectureRequired = proofMode !== 'baseline'
const instances = new Map()
const fixtureServer = await startFixtureServer(instances)
const report = {
  generatedAt: new Date().toISOString(),
  proofMode,
  inputTokenAccounting: 'cumulative_provider_requests_v1',
  remoteDebuggingPort,
  rendererUrl: rendererUrl || null,
  databasePath,
  metricsLogPath,
  fixtureOrigin: fixtureServer.origin,
  manifest: selectedManifest.map((item) => ({
    id: item.id,
    locale: item.locale,
    transport: item.transport,
    structure: item.structure,
    simpleRead: Boolean(item.simpleRead),
    latentRoute: Boolean(item.latentRoute),
    goals: item.goals.map((goal) => ({ query: goal.query, exists: goal.exists })),
  })),
  expectedCorrectnessRuns: runCorrectness ? selectedManifest.length * correctnessRepeats : 0,
  expectedPerformanceRuns: runPerformance ? performanceFixtureIds.filter((id) => selectedManifest.some((item) => item.id === id)).length * performanceRepeats : 0,
  correctnessCases: [],
  performanceCases: [],
}

let client
try {
  const rendererTarget = await findRendererTarget()
  client = await connect(rendererTarget)
  const bootstrap = await evaluate(client, `(async () => {
    const harness = window.__READY_AGENT_TEST__
    if (!harness) return { ok: false, error: 'Ready agent test harness is not enabled' }
    const summary = harness.sessionSummary()
    if (summary.activeSessionId) return { ok: true, reused: true }
    return harness.createVisibleSession()
  })()`, 15_000)
  if (!bootstrap?.ok) throw new Error(bootstrap?.error || 'failed to prepare visible Agent session')

  const runInstance = async (fixtureCase, phase, repeat) => {
    const instance = createFixtureInstance(fixtureCase, phase, repeat)
    instances.set(instance.key, instance)
    const prompt = buildPrompt(fixtureCase)
    if (instance.goals.some((goal) => goal.marker && prompt.includes(goal.marker))) {
      throw new Error(`hidden marker leaked into prompt for ${fixtureCase.id}`)
    }
    const rawResult = await evaluate(
      client,
      buildCaseExpression(`${fixtureServer.origin}/case/${instance.key}`, prompt, Boolean(fixtureCase.latentRoute)),
      420_000,
    )
    await sleep(250)
    const databaseEvidence = readDatabaseEvidence(rawResult?.scopeId, rawResult?.activeRun?.requestId)
    return compactCaseResult(instance, rawResult, databaseEvidence, architectureRequired)
  }

  if (runCorrectness) {
    for (const fixtureCase of selectedManifest) {
      for (let repeat = 1; repeat <= correctnessRepeats; repeat += 1) {
        report.correctnessCases.push(await runInstance(fixtureCase, 'correctness', repeat))
      }
    }
  }
  if (runPerformance) {
    const performanceFixtures = selectedManifest.filter((item) => performanceFixtureIds.includes(item.id))
    for (const fixtureCase of performanceFixtures) {
      await runInstance(fixtureCase, 'warmup', 0)
      for (let repeat = 1; repeat <= performanceRepeats; repeat += 1) {
        report.performanceCases.push(await runInstance(fixtureCase, 'performance', repeat))
      }
    }
  }
  enrichProviderPerformanceEvidence(report.performanceCases, metricsLogPath)
  report.performance = aggregateGroundedPerformance(report.performanceCases)
  if (proofMode === 'verify') {
    if (!baselineReportPath || !existsSync(baselineReportPath)) {
      report.performanceComparison = { ok: false, error: 'READY_GROUNDED_BASELINE_REPORT is required in verify mode' }
    } else if (!metricsLogPath || !existsSync(metricsLogPath)) {
      report.performanceComparison = { ok: false, error: 'READY_GROUNDED_METRICS_LOG is required in verify mode' }
    } else if (!baselineMetricsLogPath || !existsSync(baselineMetricsLogPath)) {
      report.performanceComparison = { ok: false, error: 'READY_GROUNDED_BASELINE_METRICS_LOG is required in verify mode' }
    } else {
      const baselineReport = parseJson(readFileSync(baselineReportPath, 'utf8'), {})
      const baselineCases = structuredClone(Array.isArray(baselineReport.performanceCases)
        ? baselineReport.performanceCases
        : [])
      enrichProviderPerformanceEvidence(baselineCases, baselineMetricsLogPath)
      const baselinePerformance = aggregateGroundedPerformance(baselineCases)
      report.baselineReportPath = baselineReportPath
      report.baselineMetricsLogPath = baselineMetricsLogPath
      report.performanceComparison = compareGroundedPerformance(
        report.performance,
        baselinePerformance,
        { requiredSamples: performanceRepeats },
      )
    }
  }
  const correctnessOk = !runCorrectness || (
    report.correctnessCases.length === report.expectedCorrectnessRuns
    && report.correctnessCases.every((item) => item.ok)
  )
  const performanceOk = !runPerformance || (
    report.performanceCases.length === report.expectedPerformanceRuns
    && report.performance.successRate === 1
    && (proofMode !== 'verify' || report.performanceComparison?.ok === true)
  )
  report.ok = correctnessOk && performanceOk
} catch (error) {
  report.ok = false
  report.error = error instanceof Error ? error.message : String(error)
} finally {
  client?.socket.close()
  await fixtureServer.close()
}

mkdirSync(outputDir, { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({
  ok: report.ok,
  proofMode,
  reportPath,
  manifestCases: report.manifest.length,
  correctnessRuns: report.correctnessCases.length,
  performanceRuns: report.performanceCases.length,
  correctnessFailures: report.correctnessCases.filter((item) => !item.ok).map((item) => `${item.id}#${item.repeat}`),
  performance: report.performance || null,
  performanceComparison: report.performanceComparison || null,
  error: report.error || null,
}, null, 2))
process.exitCode = report.ok ? 0 : 1
