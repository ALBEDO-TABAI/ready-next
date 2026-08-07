import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyLifecycleOperation,
  type LifecycleOperationFacts,
  type LifecycleOperationSnapshot,
} from '../shared/ipc-contracts/agent-lifecycle-snapshot'

const idle: LifecycleOperationFacts = {
  readyRunCreated: false,
  codexThreadId: null,
  codexTurnId: null,
  activeFence: null,
  threadStartUnreconciled: false,
  turnStartUnreconciled: false,
  productRunNonterminal: false,
  interruptStateUnknown: false,
  engineTerminalRecorded: false,
  readyCloseoutCommitted: false,
  readyTerminalWithoutNativeThread: false,
  allNativeThreadAttemptsSettled: false,
  hostFailureEvidenceComplete: false,
  hostFailureProductTerminalCommitted: false,
  manualCompactionState: 'none',
}

const cases: Array<[LifecycleOperationSnapshot, LifecycleOperationFacts]> = [
  ['idle_never_started', idle],
  ['idle_ready_terminal_no_native', {
    ...idle,
    readyRunCreated: true,
    readyTerminalWithoutNativeThread: true,
  }],
  ['idle_native_thread', {
    ...idle,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    allNativeThreadAttemptsSettled: true,
  }],
  ['thread_start_pending', { ...idle, readyRunCreated: true, threadStartUnreconciled: true }],
  ['turn_start_pending', {
    ...idle,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    turnStartUnreconciled: true,
  }],
  ['product_turn_interruptible', {
    ...idle,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    activeFence: 'product_turn',
    productRunNonterminal: true,
  }],
  ['product_turn_interrupt_unknown', {
    ...idle,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    activeFence: 'product_turn',
    productRunNonterminal: true,
    interruptStateUnknown: true,
  }],
  ['product_turn_engine_terminal_closeout_pending', {
    ...idle,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    activeFence: 'product_turn',
    engineTerminalRecorded: true,
  }],
  ['host_failure_closeout_pending', {
    ...idle,
    readyRunCreated: true,
    hostFailureEvidenceComplete: true,
  }],
  ['manual_compaction_pending', {
    ...idle,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    activeFence: 'manual_compaction',
    manualCompactionState: 'pending',
  }],
  ['manual_compaction_unknown', {
    ...idle,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    activeFence: 'manual_compaction',
    manualCompactionState: 'unknown',
  }],
]

test('lifecycle snapshot corpus hits every exact member once', () => {
  for (const [expected, facts] of cases) {
    assert.equal(classifyLifecycleOperation(facts), expected, expected)
  }
})

test('host failure closeout commit re-enters the matching idle member', () => {
  assert.equal(classifyLifecycleOperation({
    ...idle,
    readyRunCreated: true,
    readyTerminalWithoutNativeThread: true,
    hostFailureEvidenceComplete: true,
    hostFailureProductTerminalCommitted: true,
  }), 'idle_ready_terminal_no_native')
})

test('zero-match and multi-match fact sets fail as invariant_violation', () => {
  assert.equal(classifyLifecycleOperation({
    ...idle,
    readyRunCreated: true,
  }), 'invariant_violation')
  assert.equal(classifyLifecycleOperation({
    ...idle,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    hostFailureEvidenceComplete: true,
    activeFence: 'manual_compaction',
    manualCompactionState: 'pending',
  }), 'invariant_violation')
  assert.equal(classifyLifecycleOperation({
    ...idle,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    activeFence: 'product_turn',
    productRunNonterminal: true,
    engineTerminalRecorded: true,
    interruptStateUnknown: true,
  }), 'product_turn_engine_terminal_closeout_pending')
})
