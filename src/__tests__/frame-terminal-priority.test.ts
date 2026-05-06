/**
 * Stage M — `terminalReason` priority precedence on `TurnFramePatch` /
 * `TurnFrame`.
 *
 * The plan §2.2 asserts:
 *   - `cancelled_user` (rank 100) overrides everything.
 *   - `failed_skill` (80) overrides `done` (50) — defensive.
 *   - `done` (50) overrides every checkpoint.
 *   - `checkpoint_background` (30) overrides `checkpoint_budget` (20)
 *     overrides `checkpoint_user_input` (10) — fixes v2's silent-drop
 *     case where a provisional user-input checkpoint would otherwise win.
 *
 * Both `mergeTurnFramePatches` (intra-batch) and `applyTurnFramePatch`
 * (frame state) must honour the same ranking via `shouldApplyTerminalReason`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyTurnFramePatch,
  mergeTurnFramePatches,
  shouldApplyTerminalReason,
  TURN_TERMINAL_REASON_RANK,
  type TurnFrame,
  type TurnFramePatch,
  type TurnTerminalReason,
} from '../main/modules/agent-control/turn-frame'

function makeFrame(overrides?: Partial<TurnFrame>): TurnFrame {
  return {
    ids: { sessionId: 'scope-test', requestId: null },
    mode: 'general',
    userIntent: 'start',
    skill: null,
    liveness: 'unknown',
    progress: { stage: null, totalUnits: null, completedUnits: null, coverageRatio: null, fingerprint: null },
    steering: { mode: 'ask_model', requiredToolName: null, preferredToolNames: [], systemReminder: null, action: null },
    budget: { leaseEndIteration: null, hardCapIteration: null, exhausted: false },
    activeArtifactRoots: [],
    configValidation: null,
    terminalReason: null,
    ...overrides,
  }
}

test('TURN_TERMINAL_REASON_RANK: ordering invariants', () => {
  // Spot-check the documented relationships from plan §2.2.
  assert.ok(TURN_TERMINAL_REASON_RANK.cancelled_user > TURN_TERMINAL_REASON_RANK.cancelled_runtime)
  assert.ok(TURN_TERMINAL_REASON_RANK.cancelled_user > TURN_TERMINAL_REASON_RANK.done)
  assert.ok(TURN_TERMINAL_REASON_RANK.failed_skill > TURN_TERMINAL_REASON_RANK.done)
  assert.ok(TURN_TERMINAL_REASON_RANK.done > TURN_TERMINAL_REASON_RANK.checkpoint_background)
  assert.ok(TURN_TERMINAL_REASON_RANK.checkpoint_background > TURN_TERMINAL_REASON_RANK.checkpoint_budget)
  assert.ok(TURN_TERMINAL_REASON_RANK.checkpoint_budget > TURN_TERMINAL_REASON_RANK.checkpoint_user_input)
  assert.ok(TURN_TERMINAL_REASON_RANK.persistence_failed > TURN_TERMINAL_REASON_RANK.blocked_config)
  assert.ok(TURN_TERMINAL_REASON_RANK.blocked_config > TURN_TERMINAL_REASON_RANK.blocked_external)
  assert.ok(TURN_TERMINAL_REASON_RANK.blocked_external > TURN_TERMINAL_REASON_RANK.blocked_tool_error)
})

test('shouldApplyTerminalReason: null current accepts any reason', () => {
  assert.equal(shouldApplyTerminalReason(null, 'done'), true)
  assert.equal(shouldApplyTerminalReason(null, 'checkpoint_user_input'), true)
})

test('shouldApplyTerminalReason: equal rank accepts (idempotent re-emit stays benign)', () => {
  assert.equal(shouldApplyTerminalReason('done', 'done'), true)
  assert.equal(shouldApplyTerminalReason('checkpoint_budget', 'checkpoint_budget'), true)
})

test('shouldApplyTerminalReason: lower rank rejects (silent-drop guard inverted)', () => {
  // Provisional checkpoint_user_input must NOT later overwrite a real done.
  assert.equal(shouldApplyTerminalReason('done', 'checkpoint_user_input'), false)
  // checkpoint_user_input must NOT overwrite a higher-priority checkpoint_budget.
  assert.equal(shouldApplyTerminalReason('checkpoint_budget', 'checkpoint_user_input'), false)
  // done must NOT overwrite cancelled_user.
  assert.equal(shouldApplyTerminalReason('cancelled_user', 'done'), false)
})

test('shouldApplyTerminalReason: higher rank accepts', () => {
  // The v2 silent-drop case: provisional user-input then real budget close.
  assert.equal(shouldApplyTerminalReason('checkpoint_user_input', 'checkpoint_budget'), true)
  // checkpoint_budget then checkpoint_background (live worker).
  assert.equal(shouldApplyTerminalReason('checkpoint_budget', 'checkpoint_background'), true)
  // done then cancelled_user (user cancel always wins).
  assert.equal(shouldApplyTerminalReason('done', 'cancelled_user'), true)
  // done then failed_skill (defensive).
  assert.equal(shouldApplyTerminalReason('done', 'failed_skill'), true)
})

test('mergeTurnFramePatches: terminalReason ordering across patches in a single batch', () => {
  const patches: TurnFramePatch[] = [
    { terminalReason: 'checkpoint_user_input' },
    { terminalReason: 'checkpoint_budget' }, // higher rank — should win
    { terminalReason: 'done' }, // even higher — should win over budget
  ]
  const merged = mergeTurnFramePatches(patches)
  assert.equal(merged.terminalReason, 'done')
})

test('mergeTurnFramePatches: lower-rank later patch does NOT win', () => {
  const patches: TurnFramePatch[] = [
    { terminalReason: 'done' },
    { terminalReason: 'checkpoint_user_input' }, // lower rank — silent-drop guard kicks in
  ]
  const merged = mergeTurnFramePatches(patches)
  assert.equal(merged.terminalReason, 'done')
})

test('applyTurnFramePatch: provisional checkpoint_user_input then real checkpoint_budget — budget wins (the v2 silent-drop fix)', () => {
  let frame = makeFrame()
  frame = applyTurnFramePatch(frame, { terminalReason: 'checkpoint_user_input' })
  assert.equal(frame.terminalReason, 'checkpoint_user_input')
  frame = applyTurnFramePatch(frame, { terminalReason: 'checkpoint_budget' })
  assert.equal(frame.terminalReason, 'checkpoint_budget', 'higher-rank later patch must override')
})

test('applyTurnFramePatch: cancelled_user overrides any prior terminal', () => {
  const cases: TurnTerminalReason[] = [
    'done', 'failed_skill', 'checkpoint_budget', 'blocked_config',
  ]
  for (const earlier of cases) {
    let frame = makeFrame({ terminalReason: earlier })
    frame = applyTurnFramePatch(frame, { terminalReason: 'cancelled_user' })
    assert.equal(frame.terminalReason, 'cancelled_user', `cancelled_user must override ${earlier}`)
  }
})

test('applyTurnFramePatch: lower-rank patch does NOT regress the terminal reason', () => {
  let frame = makeFrame({ terminalReason: 'done' })
  frame = applyTurnFramePatch(frame, { terminalReason: 'checkpoint_user_input' })
  assert.equal(frame.terminalReason, 'done', 'lower-rank patch ignored')
})

test('applyTurnFramePatch: terminalReason patch with no actual change returns same frame reference', () => {
  const frame = makeFrame({ terminalReason: 'done' })
  const next = applyTurnFramePatch(frame, { terminalReason: 'done' })
  // Equal-rank patch is accepted by shouldApplyTerminalReason (idempotent),
  // but the value is unchanged so applyTurnFramePatch's no-op guard returns
  // the same reference.
  assert.equal(next, frame)
})

test('combined: budget exhaustion + checkpoint_budget terminal in one apply', () => {
  let frame = makeFrame()
  frame = applyTurnFramePatch(frame, {
    budget: { exhausted: true, leaseEndIteration: 30, hardCapIteration: 100 },
    terminalReason: 'checkpoint_budget',
  })
  assert.equal(frame.budget.exhausted, true)
  assert.equal(frame.budget.leaseEndIteration, 30)
  assert.equal(frame.terminalReason, 'checkpoint_budget')
})
