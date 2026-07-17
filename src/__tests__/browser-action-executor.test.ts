import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserActionExecutor, normalizeBareBrowserToolError } from '../main/modules/tools/browser-action-executor'
import { BrowserWriteLeaseService } from '../main/modules/browser-engine/browser-write-lease'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'
import { OriginInteractionBudget } from '../main/modules/browser-engine/origin-interaction-budget'

test('action executor rejects removed public tools before dispatch', async () => {
  let dispatched = false
  const result = await new BrowserActionExecutor().execute({
    toolName: 'browser_read_page',
    args: {},
    dispatch: async () => {
      dispatched = true
      return 'unexpected'
    },
  })
  assert.equal(dispatched, false)
  assert.match(typeof result === 'string' ? result : result.text, /tool_not_registered/)
})

test('action executor opens one lease-protected write window around dispatch', async () => {
  let now = 1_000
  const service = new BrowserWriteLeaseService({ now: () => now, actionGraceMs: 10 })
  const lease = service.acquire({ surface: 'user-view', taskId: 't', runId: 'r' })
  if (isAgentBrowserError(lease)) throw new Error('expected lease')
  const executor = new BrowserActionExecutor()
  const result = await executor.execute({
    toolName: 'browser_click',
    args: { x: 10, y: 20 },
    leaseGate: { service, surface: 'user-view', leaseId: lease.leaseId },
    dispatch: async () => {
      assert.equal(service.recordUserSignal({ surface: 'user-view', source: 'navigation' }), false)
      return 'clicked'
    },
  })
  assert.equal(result, 'clicked')
  now += 20
  assert.equal(service.recordUserSignal({ surface: 'user-view', source: 'navigation' }), true, 'action window must close after dispatch')
})

test('action executor aborts and returns a structured deadline error', async () => {
  const executor = new BrowserActionExecutor()
  const result = await executor.execute({
    toolName: 'browser_read',
    args: {},
    deadlineMs: 5,
    dispatch: async (_invocation, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      throw signal.reason
    },
  })
  const text = typeof result === 'string' ? result : result.text
  assert.match(text, /browser_deadline_exceeded/)
})

test('deadline waits for a briefly non-cooperative dispatch before returning', async () => {
  let commits = 0
  const startedAt = Date.now()
  const result = await new BrowserActionExecutor().execute({
    toolName: 'browser_click',
    args: { x: 1, y: 1 },
    deadlineMs: 5,
    abortDrainMs: 100,
    dispatch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      commits += 1
      return 'late commit'
    },
  })
  const data = typeof result === 'string' ? JSON.parse(result) : result.data || {}
  assert.equal(data.errorKind, 'browser_deadline_exceeded')
  assert.equal(data.abortDrained, true)
  assert.ok(Date.now() - startedAt >= 35)
  assert.equal(commits, 1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(commits, 1, 'no old dispatch may commit after the executor returns')
})

test('a dispatch that outlives abort draining retains its lease action window until settlement', async () => {
  let now = 1_000
  const service = new BrowserWriteLeaseService({ now: () => now, actionGraceMs: 0 })
  const lease = service.acquire({ surface: 'user-view', taskId: 't', runId: 'r' })
  if (isAgentBrowserError(lease)) throw new Error('expected lease')
  let finish!: () => void
  const pending = new BrowserActionExecutor().execute({
    toolName: 'browser_click',
    args: { x: 1, y: 1 },
    leaseGate: { service, surface: 'user-view', leaseId: lease.leaseId },
    deadlineMs: 5,
    abortDrainMs: 50,
    dispatch: () => new Promise<string>((resolve) => { finish = () => resolve('done') }),
  })
  const result = await pending
  const data = typeof result === 'string' ? JSON.parse(result) : result.data || {}
  assert.equal(data.ownershipRetained, true)
  assert.equal(service.recordUserSignal({ surface: 'user-view', source: 'navigation' }), false)
  finish()
  await new Promise((resolve) => setTimeout(resolve, 0))
  now += 1
  assert.equal(service.recordUserSignal({ surface: 'user-view', source: 'navigation' }), true)
})

test('takeover is control-plane work and bypasses an origin challenge throttle', async () => {
  const budget = new OriginInteractionBudget()
  budget.record('https://example.test', { challenge: true, actionSucceeded: false })
  let dispatched = 0
  const result = await new BrowserActionExecutor().execute({
    toolName: 'browser_request_takeover',
    args: { reason: 'complete verification' },
    origin: 'https://example.test',
    interactionBudget: budget,
    dispatch: async () => { dispatched += 1; return 'takeover requested' },
  })
  assert.equal(result, 'takeover requested')
  assert.equal(dispatched, 1)
})

test('browser task control actions bypass and do not mutate the page-origin budget', async () => {
  const budget = new OriginInteractionBudget()
  budget.record('https://example.test', { challenge: true, actionSucceeded: false })
  const before = budget.getState('https://example.test')
  const result = await new BrowserActionExecutor().execute({
    toolName: 'browser_task',
    args: { action: 'resume', task_id: 'browser-task-1' },
    origin: 'https://example.test',
    interactionBudget: budget,
    dispatch: async () => JSON.stringify({ status: 'running' }),
  })
  assert.deepEqual(typeof result === 'string' ? JSON.parse(result) : result.data, { status: 'running' })
  assert.deepEqual(budget.getState('https://example.test'), before)
})

test('ordinary page text cannot permanently mark an origin as a login wall', async () => {
  const budget = new OriginInteractionBudget()
  await new BrowserActionExecutor().execute({
    toolName: 'browser_click',
    args: { x: 1, y: 1 },
    origin: 'https://example.test',
    interactionBudget: budget,
    dispatch: async () => '文章说明：如果没有账号，请先登录后再收藏。',
  })
  assert.equal(budget.getState('https://example.test').challengeBlocked, false)
})

test('authoritative network 429 and Retry-After govern the next origin write', async () => {
  let now = 1_000
  const budget = new OriginInteractionBudget(() => now)
  await new BrowserActionExecutor().execute({
    toolName: 'browser_click',
    args: { x: 1, y: 1 },
    origin: 'https://example.test',
    interactionBudget: budget,
    beginInteractionObservation: async () => async () => ({
      status: 429,
      retryAfter: 7,
      actionSucceeded: false,
    }),
    dispatch: async () => '{"ok":true}',
  })
  const state = budget.getState('https://example.test')
  assert.equal(state.consecutiveFailures, 1)
  assert.equal(state.cooldownUntil, 8_000)
})

test('only an explicit completion signal clears a recorded challenge', () => {
  const budget = new OriginInteractionBudget()
  budget.record('https://example.test', { challenge: true, actionSucceeded: false })
  budget.record('https://example.test', { actionSucceeded: true })
  assert.equal(budget.getState('https://example.test').challengeBlocked, true)
  budget.record('https://example.test', { challengeCleared: true, actionSucceeded: true })
  assert.equal(budget.getState('https://example.test').challengeBlocked, false)
})

test('lease takeover between admission and dispatch prevents the physical page write', async () => {
  const service = new BrowserWriteLeaseService()
  const lease = service.acquire({ surface: 'user-view', taskId: 't', runId: 'r' })
  if (isAgentBrowserError(lease)) throw new Error('expected lease')
  let physicalWrites = 0
  const interactionBudget = {
    runWrite: async (_origin: string, action: () => Promise<unknown>) => {
      service.recordUserSignal({ surface: 'user-view', source: 'pointer' })
      return { gate: { ok: true as const }, value: await action() }
    },
    record: () => undefined,
  } as unknown as OriginInteractionBudget
  const result = await new BrowserActionExecutor().execute({
    toolName: 'browser_click',
    args: { x: 1, y: 1 },
    origin: 'https://example.test',
    leaseGate: { service, surface: 'user-view', leaseId: lease.leaseId },
    interactionBudget,
    dispatch: async () => { physicalWrites += 1; return 'clicked' },
  })
  const data = typeof result === 'string' ? JSON.parse(result) : result.data || {}
  assert.equal(data.errorKind, 'lease_takeover')
  assert.equal(physicalWrites, 0)
})

test('bare browser errors map to one recovery path per failure class', () => {
  const cases = [
    ['Error: target ref is stale_snapshot', 'target_stale', 'browser_snapshot'],
    ['Error: selector matched multiple matches', 'target_ambiguous', 'browser_find'],
    ['Error: selector target not found', 'target_not_found', 'browser_find'],
    ['Error: url is required', 'invalid_arguments', 'correct'],
    ['Error: permission denied', 'authorization_denied', 'authorization'],
    ['Error: operation timed out', 'browser_operation_timeout', 'current tab state'],
    ['Error: alert dialog blocked action', 'dialog_blocked', 'browser_dialog'],
  ] as const
  for (const [message, kind, hint] of cases) {
    const result = normalizeBareBrowserToolError(message)
    assert.equal(typeof result, 'object')
    const data = typeof result === 'string' ? {} : result.data || {}
    assert.equal(data.errorKind, kind)
    assert.match(String(data.nextSuggestedAction), new RegExp(hint))
  }
})
