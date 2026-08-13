import assert from 'node:assert/strict'
import test from 'node:test'
import {
  driverApi,
  fireOnError,
  fireOnScopeRunEvent,
  fixtureState,
  getSessionSlice,
  infrastructureTimeoutReports,
  seedTwoSessions,
  useAgent,
} from './runtime-driver-test-fixtures'

test('X2.1 #4 — terminal error on active session: composer unlocks + stop button gone', () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  fireOnError({
    agent: 'butler',
    sessionId: 'session-A',
    scopeId: 'scope-A',
    runId: 'req-A',
    error: 'HTTP 402: insufficient balance',
    type: 'runtime',
    errorKind: 'quota_exceeded',
    recoverable: false,
  })

  const state = useAgent.getState()
  const slice = getSessionSlice(state, 'session-A')
  assert.equal(slice.isStreaming, false, 'session-A slice isStreaming cleared')
  assert.equal(slice.composerLocked, false, 'session-A slice composerLocked cleared')
  assert.equal(slice.foregroundBusy, false, 'session-A slice foregroundBusy cleared')
  assert.equal(slice.streamingRequestId, null, 'session-A slice streamingRequestId cleared (Stop button hidden)')
  assert.equal(slice.streamingMessageId, null, 'session-A slice streamingMessageId cleared')
  // Top-level mirror reflects active session unlock.
  assert.equal(state.composerLocked, false, 'top-level composerLocked mirror cleared')
  assert.equal(state.streamingRequestId, null, 'top-level streamingRequestId mirror cleared')
})

// ---------------------------------------------------------------------------
// Test X2.1 #5 — session/scope mismatch guard: terminal events must unlock
// the session that was locked at send start, even if currentScopeId has
// moved mid-send.
// ---------------------------------------------------------------------------

test('X2.1 #5 — mid-send scope switch: terminal still unlocks the originating session', () => {
  // session-A is locked on scope-A; user has clicked into session-B (scope-B).
  // The active session is now session-B. The terminal error for scope-A arrives.
  seedTwoSessions({
    activeSessionId: 'session-B',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  // sanity check: session-A is still locked before the error fires.
  const before = useAgent.getState()
  const sliceABefore = getSessionSlice(before, 'session-A')
  assert.equal(sliceABefore.composerLocked, true, 'pre-condition: session-A locked')
  assert.equal(before.currentScopeId, 'scope-B', 'pre-condition: user switched to scope-B')

  fireOnError({
    agent: 'butler',
    sessionId: 'session-A',
    scopeId: 'scope-A',
    runId: 'req-A',
    error: 'HTTP 402: insufficient balance',
    type: 'runtime',
    errorKind: 'quota_exceeded',
    recoverable: false,
  })

  const state = useAgent.getState()
  const sliceA = getSessionSlice(state, 'session-A')
  assert.equal(sliceA.composerLocked, false, 'session-A unlocks even though it is not the active session')
  assert.equal(sliceA.isStreaming, false, 'session-A isStreaming cleared')
  assert.equal(sliceA.foregroundBusy, false, 'session-A foregroundBusy cleared')
  assert.equal(sliceA.streamingRequestId, null, 'session-A streamingRequestId cleared (Stop button hidden when returning)')
  assert.equal(sliceA.streamingMessageId, null, 'session-A streamingMessageId cleared')

  // The active session (B) was never locked — its slice should remain
  // unchanged (no spurious side effects on the wrong session).
  const sliceB = getSessionSlice(state, 'session-B')
  assert.equal(sliceB.composerLocked, false, 'session-B composer stays unlocked (never locked)')
  assert.equal(sliceB.streamingRequestId, null, 'session-B streamingRequestId untouched')
})

// ---------------------------------------------------------------------------
// Test X2.6 — infrastructure_timeout safety net.
//
// If no renderer-visible event arrives within 60s, ask main for the run's
// authoritative state. Active/paused runs stay locked and are probed later;
// missing runs unlock quietly; stale probes that identify a replacement run
// stay locked under that replacement identity. An unreachable main eventually
// unlocks with an honest unknown-state notice.
//
// The driver exposes `armInfrastructureWatchdog(scopeId, requestId,
// { timeoutMs })` as a test seam so we can fire it on a 1ms budget
// instead of actually waiting 60 seconds.
// ---------------------------------------------------------------------------

test('X2.6 — infrastructure_timeout fires after timeout with no terminal event', async () => {
  infrastructureTimeoutReports.length = 0
  fixtureState.infrastructureTimeoutReportResult = { success: false, error: 'ipc unavailable' }
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 10 })

  // B step 2: an unreachable main (report returns null) is RETRIED once before
  // the renderer gives up; wait past the retry window (~2s) + headroom.
  await new Promise((resolve) => setTimeout(resolve, 2300))

  const state = useAgent.getState()
  const slice = getSessionSlice(state, 'session-A')
  assert.equal(slice.composerLocked, false, 'infrastructure_timeout unlocks the originating session')
  assert.equal(slice.isStreaming, false, 'infrastructure_timeout clears isStreaming')
  assert.equal(slice.foregroundBusy, false, 'infrastructure_timeout clears foregroundBusy')
  assert.equal(slice.streamingRequestId, null, 'infrastructure_timeout clears streamingRequestId (Stop button hidden)')
  assert.equal(slice.scopeRunStates['scope-A']?.phase, 'error', 'infrastructure_timeout marks the active run terminal')
  assert.equal(slice.scopeRunStates['scope-A']?.terminalReason, 'infra_error', 'unreachable main → infra_error')
  // reported TWICE (initial + one retry) before declaring main unreachable
  assert.equal(infrastructureTimeoutReports.length, 2, 'reports the stuck request, then retries once')
  assert.deepEqual(infrastructureTimeoutReports[0], { scopeId: 'scope-A', requestId: 'req-A', elapsedMs: 10 })
  assert.equal(state.composerLocked, false, 'active mirror also unlocks after infrastructure_timeout')
  assert.equal(state.foregroundBusy, false, 'active mirror foregroundBusy is not resurrected by a stale planning run')

  // B step 2: the surfaced message states HONEST uncertainty — it must NOT claim
  // the request "已自动恢复" (that false claim invited duplicate resends).
  const honestMsg = state.messages.find((m: { content: string }) =>
    typeof m.content === 'string' && m.content.includes('联系不上后台'))
  assert.ok(honestMsg, 'an honest unknown-state message is appended for the active scope')
  const falseRecoveryMsg = state.messages.find((m: { content: string }) =>
    typeof m.content === 'string' && m.content.includes('已自动恢复'))
  assert.equal(falseRecoveryMsg, undefined, 'renderer must NOT claim local recovery')
})

test('X2.6 — main-confirmed missing run unlocks without a lost-track message', async () => {
  infrastructureTimeoutReports.length = 0
  fixtureState.infrastructureTimeoutReportResult = { success: true, data: { state: 'not_found' } }
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 10 })

  await new Promise((resolve) => setTimeout(resolve, 50))

  const state = useAgent.getState()
  assert.deepEqual(
    infrastructureTimeoutReports,
    [{ scopeId: 'scope-A', requestId: 'req-A', elapsedMs: 10 }],
    'timeout still reports to main with request-id authority',
  )
  const lostTrackMsg = state.messages.find((m: { content: string }) =>
    typeof m.content === 'string' && m.content.includes('Ready 跟丢了'))
  assert.equal(lostTrackMsg, undefined, 'main confirmed the run is gone, so renderer must not claim it lost the request')
  assert.equal(getSessionSlice(state, 'session-A').composerLocked, false, 'composer unlocks after main confirms no active run')
})

test('X2.6 — stale watchdog adopts the replacement run and never unlocks it', async () => {
  infrastructureTimeoutReports.length = 0
  fixtureState.infrastructureTimeoutReportResult = {
    success: true,
    data: { state: 'stale', activeRunId: 'req-new' },
  }
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-old',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-old', { timeoutMs: 10 })
  await new Promise((resolve) => setTimeout(resolve, 50))

  const state = useAgent.getState()
  const slice = getSessionSlice(state, 'session-A')
  assert.deepEqual(infrastructureTimeoutReports, [
    { scopeId: 'scope-A', requestId: 'req-old', elapsedMs: 10 },
  ])
  assert.equal(slice.composerLocked, true)
  assert.equal(slice.foregroundBusy, true)
  assert.equal(slice.isStreaming, true)
  assert.equal(slice.streamingRequestId, 'req-new')
  assert.equal(slice.scopeRunStates['scope-A']?.requestId, 'req-new')
  assert.notEqual(slice.scopeRunStates['scope-A']?.phase, 'error')

  driverApi.clearInfrastructureWatchdog('scope-A', 'req-new')
})

test('X2.6 — malformed stale response stays fail-closed instead of unlocking the run', async () => {
  infrastructureTimeoutReports.length = 0
  fixtureState.infrastructureTimeoutReportResult = {
    success: true,
    data: { state: 'stale' },
  }
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 10 })
  await new Promise((resolve) => setTimeout(resolve, 2300))

  const state = useAgent.getState()
  const slice = getSessionSlice(state, 'session-A')
  assert.deepEqual(infrastructureTimeoutReports, [
    { scopeId: 'scope-A', requestId: 'req-A', elapsedMs: 10 },
  ], 'a malformed affirmative response is not retried as an unreachable main')
  assert.equal(slice.composerLocked, true)
  assert.equal(slice.foregroundBusy, true)
  assert.equal(slice.isStreaming, true)
  assert.equal(slice.streamingRequestId, 'req-A')
  assert.notEqual(slice.scopeRunStates['scope-A']?.phase, 'error')
  assert.notEqual(slice.scopeRunStates['scope-A']?.terminalReason, 'infra_error')
  assert.equal(
    state.messages.some((message: { content: unknown }) => (
      typeof message.content === 'string' && message.content.includes('联系不上后台')
    )),
    false,
  )

  driverApi.clearInfrastructureWatchdog('scope-A', 'req-A')
})

test('X2.6 — contradictory not_found response with an active run stays fail-closed', async () => {
  infrastructureTimeoutReports.length = 0
  fixtureState.infrastructureTimeoutReportResult = {
    success: true,
    data: { state: 'not_found', activeRunId: 'req-live' },
  }
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 10 })
  await new Promise((resolve) => setTimeout(resolve, 100))

  const slice = getSessionSlice(useAgent.getState(), 'session-A')
  assert.deepEqual(infrastructureTimeoutReports, [
    { scopeId: 'scope-A', requestId: 'req-A', elapsedMs: 10 },
  ])
  assert.equal(slice.composerLocked, true)
  assert.equal(slice.foregroundBusy, true)
  assert.equal(slice.isStreaming, true)
  assert.equal(slice.streamingRequestId, 'req-A')
  assert.notEqual(slice.scopeRunStates['scope-A']?.phase, 'error')
  assert.notEqual(slice.scopeRunStates['scope-A']?.terminalReason, 'main_no_progress_timeout')

  driverApi.clearInfrastructureWatchdog('scope-A', 'req-A')
})

test('X2.6 — paused_user_input keeps the run alive and the composer locked', async () => {
  infrastructureTimeoutReports.length = 0
  fixtureState.infrastructureTimeoutReportResult = { success: true, data: { state: 'paused_user_input' } }
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 10 })

  await new Promise((resolve) => setTimeout(resolve, 50))

  const state = useAgent.getState()
  const slice = getSessionSlice(state, 'session-A')
  assert.deepEqual(
    infrastructureTimeoutReports,
    [{ scopeId: 'scope-A', requestId: 'req-A', elapsedMs: 10 }],
    'renderer still reports the timeout edge to main',
  )
  assert.equal(slice.composerLocked, true, 'normal composer stays locked while the ask card owns the reply')
  assert.equal(slice.isStreaming, true, 'waiting for user input remains an active run')
  assert.equal(slice.foregroundBusy, true, 'foreground run is not finalized locally')
  assert.equal(slice.streamingRequestId, 'req-A', 'Stop button / run identity is not cleared')
  assert.equal(slice.scopeRunStates['scope-A']?.phase, 'responding', 'paused user input is not rendered as an error')
  const timeoutMsg = state.messages.find((m: { content: string }) =>
    typeof m.content === 'string' && (m.content.includes('联系不上后台') || m.content.includes('超时')))
  assert.equal(timeoutMsg, undefined, 'paused user input does not surface a timeout/lost-track message')
})

test('X2.6 — a main-confirmed active run survives the one-minute renderer probe', async () => {
  infrastructureTimeoutReports.length = 0
  fixtureState.infrastructureTimeoutReportResult = { success: true, data: { state: 'active' } }
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 10 })
  await new Promise((resolve) => setTimeout(resolve, 2300))

  const slice = getSessionSlice(useAgent.getState(), 'session-A')
  assert.deepEqual(infrastructureTimeoutReports, [
    { scopeId: 'scope-A', requestId: 'req-A', elapsedMs: 10 },
  ], 'an active acknowledgement re-arms the long watchdog instead of retrying the bootstrap probe')
  assert.equal(slice.composerLocked, true)
  assert.equal(slice.isStreaming, true)
  assert.equal(slice.foregroundBusy, true)
  assert.equal(slice.streamingRequestId, 'req-A')
  assert.notEqual(slice.scopeRunStates['scope-A']?.phase, 'error')
})

test('X2.6 — hung main timeout report still releases the renderer lock', async () => {
  infrastructureTimeoutReports.length = 0
  fixtureState.infrastructureTimeoutReportResult = new Promise(() => undefined)
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 10 })

  // A hung report resolves at the 5s ack window; B step 2 then RETRIES once
  // (another ~5s ack + 2s delay) before declaring main unreachable. Under the
  // full parallel suite the event loop can be stalled past several expired
  // timers at once, so wait for the observable terminal state instead of
  // racing the implementation with one fixed wall-clock sleep.
  const deadline = Date.now() + 30_000
  while (
    Date.now() < deadline
    && (
      infrastructureTimeoutReports.length < 2
      || getSessionSlice(useAgent.getState(), 'session-A').composerLocked
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  const state = useAgent.getState()
  const slice = getSessionSlice(state, 'session-A')
  assert.equal(infrastructureTimeoutReports.length, 2, 'renderer reports then retries once before giving up')
  assert.deepEqual(infrastructureTimeoutReports[0], { scopeId: 'scope-A', requestId: 'req-A', elapsedMs: 10 })
  assert.equal(slice.composerLocked, false, 'hung+unreachable main cannot keep the composer locked forever')
  assert.equal(slice.isStreaming, false, 'hung main report cannot keep the session streaming')
  assert.equal(slice.streamingRequestId, null, 'hung main report clears the in-flight request handle')
  // honest uncertainty, never a false recovery claim
  const honestMsg = state.messages.find((m: { content: string }) =>
    typeof m.content === 'string' && m.content.includes('联系不上后台'))
  assert.ok(honestMsg, 'an honest unknown-state message is surfaced when main stays unreachable')
  const falseRecoveryMsg = state.messages.find((m: { content: string }) =>
    typeof m.content === 'string' && m.content.includes('已自动恢复'))
  assert.equal(falseRecoveryMsg, undefined, 'renderer must NOT claim local recovery')
})

test('B step 1 — a slow-but-alive main answer keeps the active run alive', async () => {
  infrastructureTimeoutReports.length = 0
  // Resolve at ~2.5s: under the OLD 1s ack this raced out → null → false
  // "lost track" recovery; under the 5s ack the alive main is heard.
  fixtureState.infrastructureTimeoutReportResult = new Promise((resolve) =>
    setTimeout(() => resolve({ success: true, data: { state: 'active' } }), 2500))
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 10 })
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const state = useAgent.getState()
  // Assert only renderer-observable facts: the alive main was reached (reported),
  // no false "lost track" message, and the active composer remains locked.
  const lostTrackMsg = state.messages.find((m: { content: string }) =>
    typeof m.content === 'string' && m.content.includes('Ready 跟丢了'))
  assert.equal(lostTrackMsg, undefined, 'a slow-but-alive main must NOT be mistaken for lost track')
  assert.deepEqual(
    infrastructureTimeoutReports,
    [{ scopeId: 'scope-A', requestId: 'req-A', elapsedMs: 10 }],
    'the alive main was actually reached (report delivered) within the 5s ack window',
  )
  assert.equal(getSessionSlice(state, 'session-A').composerLocked, true, 'main-confirmed active run remains locked')
})

test('B step 2 race — a main terminal event arriving DURING the report wait cancels retry, no false unknown-state', async () => {
  infrastructureTimeoutReports.length = 0
  // Report stays pending ~250ms so a terminal event can land mid-await.
  fixtureState.infrastructureTimeoutReportResult = new Promise((resolve) =>
    setTimeout(() => resolve({ success: false, error: 'still null' }), 250))
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 10 })
  // Let the watchdog fire and enter the (pending) report await.
  await new Promise((resolve) => setTimeout(resolve, 60))
  // Main's REAL terminal event lands while the report is still pending — its
  // handler clears the watchdog. The fix must detect this after the await and
  // NOT re-arm a retry nor overwrite the terminal with a local unknown-state.
  fireOnError({
    agent: 'butler', sessionId: 'session-A', scopeId: 'scope-A', runId: 'req-A',
    error: 'HTTP 402: insufficient balance', type: 'runtime', errorKind: 'quota_exceeded', recoverable: false,
  })
  // Wait past the report resolution AND the retry delay (~2s) to be sure no
  // retry fired.
  await new Promise((resolve) => setTimeout(resolve, 2600))

  const state = useAgent.getState()
  assert.equal(infrastructureTimeoutReports.length, 1, 'no retry report after a terminal event cancels the watchdog')
  const honestMsg = state.messages.find((m: { content: string }) =>
    typeof m.content === 'string' && m.content.includes('联系不上后台'))
  assert.equal(honestMsg, undefined, 'terminal-during-report-wait must NOT surface the unreachable notice')
  assert.notEqual(getSessionSlice(state, 'session-A').scopeRunStates['scope-A']?.terminalReason, 'infra_error',
    'main\'s real terminal must not be overwritten by a local infra_error')
})


test('X2.6 — runtime liveness extends the bootstrap watchdog window', async () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 20 })

  fireOnScopeRunEvent({
    type: 'started',
    scopeId: 'scope-A',
    sessionId: 'scope-A',
    agent: 'butler',
    runId: 'req-A',
    phase: 'planning',
    latestText: '正在理解需求',
    timestamp: new Date().toISOString(),
  })

  await new Promise((resolve) => setTimeout(resolve, 80))
  driverApi.clearInfrastructureWatchdog('scope-A', 'req-A')

  const state = useAgent.getState()
  const lostTrackMsg = state.messages.find((m: { content: string }) =>
    typeof m.content === 'string' && m.content.includes('Ready 跟丢了'))
  assert.equal(lostTrackMsg, undefined, 'active runtime liveness does not trip the bootstrap lost-track toast')
  assert.equal(getSessionSlice(state, 'session-A').scopeRunStates['scope-A']?.phase, 'planning')
})


test('manual suspend scope event unlocks the composer without inventing an assistant reply', () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  fireOnScopeRunEvent({
    type: 'updated',
    scopeId: 'scope-A',
    sessionId: 'scope-A',
    agent: 'butler',
    runId: 'req-A',
    taskId: 'task-A',
    phase: 'takeover',
    terminalReason: 'manual_suspend',
    interactionState: 'human_takeover',
    waitingFor: 'confirmation',
    resumableActions: ['continue', 'cancel'],
    blockedReason: '请完成页面验证 · 完成后继续任务',
    timestamp: '2026-07-20T00:00:00.000Z',
  })

  const state = useAgent.getState()
  const slice = getSessionSlice(state, 'session-A')
  assert.equal(slice.isStreaming, false)
  assert.equal(slice.foregroundBusy, false)
  assert.equal(slice.composerLocked, false)
  assert.equal(slice.streamingRequestId, null)
  assert.equal(slice.messages.length, 0)
  assert.equal(slice.scopeRunStates['scope-A']?.phase, 'takeover')
  assert.equal(slice.scopeRunStates['scope-A']?.terminalReason, 'manual_suspend')
  assert.equal(slice.scopeRunStates['scope-A']?.blockedReason, '请完成页面验证 · 完成后继续任务')
})


test('X2.6 — terminal event before timeout disarms the watchdog', async () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 20 })

  // Fire a real terminal error BEFORE the timer expires.
  fireOnError({
    agent: 'butler',
    sessionId: 'session-A',
    scopeId: 'scope-A',
    runId: 'req-A',
    error: 'HTTP 402: insufficient balance',
    type: 'runtime',
    errorKind: 'quota_exceeded',
    recoverable: false,
  })

  // Now wait past the watchdog window — it should not fire because the
  // terminal handler cleared it.
  await new Promise((resolve) => setTimeout(resolve, 80))

  const state = useAgent.getState()
  // The "Ready 跟丢了" message must NOT appear — the watchdog was
  // disarmed by the terminal event.
  const lostTrackMsg = state.messages.find((m: { content: string }) =>
    typeof m.content === 'string' && m.content.includes('Ready 跟丢了'))
  assert.equal(lostTrackMsg, undefined, 'no spurious infrastructure_timeout toast after a real terminal event')
})

test('X2.6 — explicit clearInfrastructureWatchdog disarms by scope', async () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 20 })
  // Clear immediately (e.g. user clicked Stop).
  driverApi.clearInfrastructureWatchdog('scope-A', 'req-A')

  await new Promise((resolve) => setTimeout(resolve, 80))

  const state = useAgent.getState()
  const lostTrackMsg = state.messages.find((m: { content: string }) =>
    typeof m.content === 'string' && m.content.includes('Ready 跟丢了'))
  assert.equal(lostTrackMsg, undefined, 'clearInfrastructureWatchdog disarms the timer')
})
