import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const port = Number(process.env.READY_REMOTE_DEBUGGING_PORT || 9333)
const outPath = resolve(process.argv[2] || 'outputs/agent-audit/live/p7c-browser-live-proof-report.json')
const timeoutMs = Number(process.env.READY_P7C_LIVE_TIMEOUT_MS || 120_000)

async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!response.ok) throw new Error(`CDP target list failed: ${response.status}`)
  return response.json()
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function findReadyRendererTarget(waitMs) {
  const deadline = Date.now() + waitMs
  let lastError = null
  do {
    try {
      const targets = await listTargets()
      const readyTarget = targets.find((item) => (
        item.type === 'page'
        && item.webSocketDebuggerUrl
        && typeof item.url === 'string'
        && item.url.startsWith('http://localhost:5173/')
        && !/browser-lock-overlay/.test(item.url)
        && !/browser-fastcard-overlay/.test(item.url)
      ))
      if (readyTarget) return readyTarget
      lastError = new Error(`Ready renderer target not found among ${targets.length} target(s)`)
    } catch (error) {
      lastError = error
    }
    await sleep(500)
  } while (Date.now() < deadline)
  const message = lastError instanceof Error ? lastError.message : String(lastError || 'unknown error')
  const cause = lastError instanceof Error && lastError.cause ? `; cause=${lastError.cause}` : ''
  throw new Error(`no debuggable Ready renderer target on port ${port}: ${message}${cause}`)
}

async function connect(target) {
  let id = 0
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id).resolve(message)
      pending.delete(message.id)
    }
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

function buildProbeExpression(waitMs) {
  return `(
    async () => {
      const api = window.electronAPI?.browser
      if (!api?.getTabs || !api?.getAgentSupervisionState || !api?.onLeaseChanged || !api?.switchTab) {
        return JSON.stringify({ ok: false, error: 'missing-browser-live-proof-api' })
      }
      if (
        !api.p7cLiveProofStartUserViewLease
        || !api.p7cLiveProofCreateManualTab
        || !api.p7cLiveProofPrepareForegroundProbe
        || !api.p7cLiveProofSampleActiveTabState
        || !api.p7cLiveProofCheckWriteDenied
        || !api.p7cLiveProofClear
      ) {
        return JSON.stringify({ ok: false, error: 'missing-p7c-live-proof-api' })
      }
      const fail = async (error, detail = null) => {
        await api.p7cLiveProofClear().catch(() => undefined)
        return JSON.stringify({ ok: false, scope: 'P7c2-foreground-preservation-and-takeover', error, detail })
      }
      await api.p7cLiveProofClear()

      const proofTab = await api.p7cLiveProofCreateManualTab()
      if (!proofTab?.success || !proofTab.tabId) {
        return await fail('failed-to-create-proof-tab', proofTab?.error || null)
      }
      const switchTarget = await api.p7cLiveProofCreateManualTab()
      if (!switchTarget?.success || !switchTarget.tabId) {
        return await fail('failed-to-create-tab-switch-target', switchTarget?.error || null)
      }
      const primedSwitchBack = await api.switchTab(proofTab.tabId)
      if (!primedSwitchBack?.success) {
        return await fail('failed-to-prime-proof-tab-active-state', primedSwitchBack?.error || null)
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
      const prepared = await api.p7cLiveProofPrepareForegroundProbe()
      if (!prepared?.success || !prepared.state) {
        return await fail('failed-to-prepare-foreground-probe', prepared?.error || null)
      }
      const before = prepared.state
      const started = await api.p7cLiveProofStartUserViewLease()
      if (!started?.success || started.tabId !== before.tabId) {
        return await fail('failed-to-start-user-view-lease', started?.error || { started, expectedTabId: before.tabId })
      }
      const startedAt = performance.now()
      let takeoverPayload = null
      const takeoverPromise = new Promise((resolve) => {
        const timer = window.setTimeout(() => {
          off?.()
          resolve(null)
        }, ${Number(waitMs)})
        const off = api.onLeaseChanged((snapshot) => {
          const userSurface = snapshot?.surfaces?.['user-view']
          if (userSurface?.state !== 'takeover') return
          takeoverPayload = snapshot
          window.clearTimeout(timer)
          off?.()
          resolve({ snapshot, latencyMs: Math.max(0, performance.now() - startedAt) })
        })
      })

      const switchedAway = await api.switchTab(switchTarget.tabId)
      if (!switchedAway?.success) {
        return await fail('failed-to-switch-away-from-proof-tab', switchedAway?.error || null)
      }
      const takeoverResult = await takeoverPromise
      const denied = await api.p7cLiveProofCheckWriteDenied()
      const switchedBack = await api.switchTab(before.tabId)
      if (!switchedBack?.success) {
        return await fail('failed-to-switch-back-to-proof-tab', switchedBack?.error || null)
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
      const afterSample = await api.p7cLiveProofSampleActiveTabState()
      if (!afterSample?.success || !afterSample.state) {
        return await fail('failed-to-sample-after-state', afterSample?.error || null)
      }
      const after = afterSample.state
      const sawLeaseTakeover = denied?.success === true && denied.errorKind === 'lease_takeover'
      const focusPreserved = Boolean(before.focusToken && before.focusToken === after.focusToken)
      const scrollPreserved = Number(before.scrollY) === Number(after.scrollY)
      const tabPreserved = before.tabId === after.tabId && before.url === after.url
      await api.p7cLiveProofClear()
      return JSON.stringify({
        ok: Boolean(takeoverResult && sawLeaseTakeover && tabPreserved && focusPreserved && scrollPreserved),
        scope: 'P7c2-foreground-preservation-and-takeover',
        generatedAt: new Date().toISOString(),
        error: takeoverResult
          ? (sawLeaseTakeover
            ? (tabPreserved && focusPreserved && scrollPreserved ? null : 'foreground-state-not-preserved')
            : 'missing-lease-takeover-denial')
          : 'timed-out-waiting-for-user-view-takeover',
        assertions: {
          userViewReclaimEnforced: {
            ok: sawLeaseTakeover,
            userSignal: 'tab-switch',
            errorKind: sawLeaseTakeover ? 'lease_takeover' : null,
          },
          leasePushBeforePoll: {
            ok: Boolean(takeoverResult && takeoverResult.latencyMs < 2500),
            latencyMs: takeoverResult ? Math.round(takeoverResult.latencyMs) : null,
          },
          activeTabUnchangedAfterTakeover: {
            ok: tabPreserved,
            before,
            after,
          },
          activeTabFocusPreserved: {
            ok: focusPreserved,
            before: { focusToken: before.focusToken },
            after: { focusToken: after.focusToken },
          },
          activeTabScrollPreserved: {
            ok: scrollPreserved,
            before: { scrollY: before.scrollY, scrollX: before.scrollX },
            after: { scrollY: after.scrollY, scrollX: after.scrollX },
          },
          backgroundAgentTabDidNotStealActive: {
            ok: Boolean(before && after && before.tabId === after.tabId),
            beforeTabId: before?.tabId || null,
            afterTabId: after?.tabId || null,
          },
          fullIsolationDeferred: {
            ok: true,
            separatePartitionImplemented: false,
          },
        },
        debug: {
          started,
          denied,
          switchTarget,
          primedSwitchBack,
          switchedAway,
          switchedBack,
          takeoverSnapshot: takeoverPayload,
        },
      })
    }
  )()`
}

async function main() {
  const target = await findReadyRendererTarget(Math.min(timeoutMs, 20_000))
  const client = await connect(target)
  try {
    const report = await evaluate(client, buildProbeExpression(timeoutMs))
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
    if (!report.ok) {
      console.error(`[p7c-live-proof] wrote failing report: ${outPath}`)
      console.error(`[p7c-live-proof] ${report.error || 'unknown failure'}`)
      process.exit(1)
    }
    console.log(`[p7c-live-proof] wrote ${outPath}`)
  } finally {
    client.ws.close()
  }
}

main().catch((error) => {
  console.error(`[p7c-live-proof] ${error instanceof Error ? (error.stack || error.message) : String(error)}`)
  process.exit(1)
})
