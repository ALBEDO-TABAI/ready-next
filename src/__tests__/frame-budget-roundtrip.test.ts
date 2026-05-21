/**
 * Stage M — `framePatch.budget` round-trip contract.
 *
 * Producers (lease controller via `produceBudgetPatch`, lazily added in M2b)
 * emit `TurnFramePatch.budget`; `mergeTurnFramePatches` last-write-wins per
 * scalar; `applyTurnFramePatch` writes the values into `frame.budget`.
 * Steering and dispatch downstream read `frame.budget` only.
 *
 * This test pins the merge / apply contract for the `budget` field. M2b
 * extends coverage to the runtime steering migration.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyTurnFramePatch,
  mergeTurnFramePatches,
  type TurnFrame,
  type TurnFramePatch,
} from '../main/modules/agent-control/runtime-core/turn-frame'

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

test('mergeTurnFramePatches: budget last-write-wins per scalar', () => {
  const patches: TurnFramePatch[] = [
    { budget: { leaseEndIteration: 50, hardCapIteration: 220, exhausted: false } },
    { budget: { leaseEndIteration: 60, exhausted: true } }, // hardCapIteration omitted -> stays 220 from earlier write
  ]
  const merged = mergeTurnFramePatches(patches)
  assert.deepEqual(merged.budget, {
    leaseEndIteration: 60,
    hardCapIteration: 220,
    exhausted: true,
  })
})

test('mergeTurnFramePatches: explicit null in budget patch resets the field', () => {
  const patches: TurnFramePatch[] = [
    { budget: { leaseEndIteration: 50, hardCapIteration: 220 } },
    { budget: { leaseEndIteration: null } },
  ]
  const merged = mergeTurnFramePatches(patches)
  assert.equal(merged.budget?.leaseEndIteration, null)
  assert.equal(merged.budget?.hardCapIteration, 220)
})

test('applyTurnFramePatch: budget write updates frame.budget; coalesces missing fields with current frame values', () => {
  const frame = makeFrame({
    budget: { leaseEndIteration: 50, hardCapIteration: 220, exhausted: false },
  })
  const next = applyTurnFramePatch(frame, { budget: { exhausted: true } })
  assert.deepEqual(next.budget, { leaseEndIteration: 50, hardCapIteration: 220, exhausted: true })
  assert.notEqual(next, frame, 'returns a new frame when budget changed')
})

test('applyTurnFramePatch: budget patch that does not change values returns the same frame reference', () => {
  const frame = makeFrame({
    budget: { leaseEndIteration: 50, hardCapIteration: 220, exhausted: true },
  })
  const next = applyTurnFramePatch(frame, {
    budget: { leaseEndIteration: 50, hardCapIteration: 220, exhausted: true },
  })
  assert.equal(next, frame, 'no-op patch returns the input frame')
})

test('applyTurnFramePatch: budget exhausted: true is durable across same-turn patches', () => {
  let frame = makeFrame()
  frame = applyTurnFramePatch(frame, { budget: { leaseEndIteration: 30, hardCapIteration: 100 } })
  assert.equal(frame.budget.exhausted, false)
  frame = applyTurnFramePatch(frame, { budget: { exhausted: true } })
  assert.equal(frame.budget.exhausted, true)
  assert.equal(frame.budget.leaseEndIteration, 30, 'earlier scalar persists when later patch omits it')
})

test('applyTurnFramePatch: empty budget object is a no-op (consistent with hasBudget guard)', () => {
  const frame = makeFrame({ budget: { leaseEndIteration: 7, hardCapIteration: 220, exhausted: false } })
  const next = applyTurnFramePatch(frame, { budget: {} })
  assert.equal(next, frame)
})
