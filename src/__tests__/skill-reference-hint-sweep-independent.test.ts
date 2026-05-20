/**
 * B plan Phase 4 — the reference-hint TTL sweep is now driven by its own
 * setTimeout + setInterval chain in SkillsRuntimeManager.startReferenceHintSweep().
 * Before PR1-D, the sweep piggy-backed on the retired skill_executions TTL
 * sweep; after retirement it must keep running independently so idle hints
 * don't linger in-process indefinitely.
 *
 * Source-level contract: verifies the independent sweep wiring is present in
 * runtime-manager.ts. Behavioral coverage of the sweep function itself lives
 * in skill-reference-hints-ttl.test.ts.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { mock } from 'node:test'

import {
  rememberLastReferenceSkill,
  sweepExpiredReferenceSkillHints,
  _resetLastReferenceSkillHintsForTests,
  REFERENCE_SKILL_HINT_TTL_MS,
  getLastReferenceSkill,
  setReferenceHintChangeEmitter,
} from '../main/modules/agent-control/skills/skill-reference-hints'
import { SkillsRuntimeManager } from '../main/modules/skills-runtime/runtime-manager'

test('runtime-manager reference-hint sweep removes stale hints on its boot timer', () => {
  _resetLastReferenceSkillHintsForTests()
  const root = mkdtempSync(join(tmpdir(), 'reference-hint-sweep-'))
  const now = 1_800_000_000_000
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now })

  const manager = new SkillsRuntimeManager({
    runtimeRoot: root,
    startBackgroundTasks: false,
  })
  const changes: Array<{ sessionId: string; change: string }> = []
  setReferenceHintChangeEmitter((sessionId, change) => {
    changes.push({ sessionId, change })
  })

  try {
    rememberLastReferenceSkill('session-stale', { id: 'novel_writer_system', name: 'Novel' })
    mock.timers.setTime(now + REFERENCE_SKILL_HINT_TTL_MS + 1)
    ;(manager as unknown as { startReferenceHintSweep: () => void }).startReferenceHintSweep()

    mock.timers.tick(29_999)
    assert.deepEqual(changes.map((item) => item.change), ['armed'])

    mock.timers.tick(1)
    assert.equal(getLastReferenceSkill('session-stale'), null)
    assert.deepEqual(changes, [
      { sessionId: 'session-stale', change: 'armed' },
      { sessionId: 'session-stale', change: 'cleared' },
    ])
  } finally {
    manager.stopReferenceHintSweep()
    setReferenceHintChangeEmitter(null)
    mock.timers.reset()
    rmSync(root, { recursive: true, force: true })
    _resetLastReferenceSkillHintsForTests()
  }
})

test('sweepExpiredReferenceSkillHints is safe on empty state and keeps the TTL contract', () => {
  _resetLastReferenceSkillHintsForTests()

  // Sanity: sweeping an empty map returns 0 without throwing and emits the metric.
  const removed = sweepExpiredReferenceSkillHints()
  assert.equal(removed, 0)
  // TTL constant is sane.
  assert.equal(REFERENCE_SKILL_HINT_TTL_MS, 30 * 60 * 1000)
})

test('runtime-manager reference-hint sweep start is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'reference-hint-sweep-idempotent-'))
  const capture = captureTimerRegistration()
  const warns = captureConsoleWarn()
  const manager = new SkillsRuntimeManager({
    runtimeRoot: root,
    startBackgroundTasks: false,
  })
  try {
    ;(manager as unknown as { startReferenceHintSweep: () => void }).startReferenceHintSweep()
    ;(manager as unknown as { startReferenceHintSweep: () => void }).startReferenceHintSweep()

    assert.equal(capture.timeouts(), 1)
    assert.equal(capture.intervals(), 1)
    assert.match(warns.messages().join('\n'), /reference-hint sweep already running/)
  } finally {
    manager.stopReferenceHintSweep()
    capture.restore()
    warns.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime-manager outputDir sweep start is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'output-dir-sweep-idempotent-'))
  const capture = captureTimerRegistration()
  const warns = captureConsoleWarn()
  const manager = new SkillsRuntimeManager({
    runtimeRoot: root,
    startBackgroundTasks: false,
  })
  try {
    ;(manager as unknown as { startOutputDirSweep: () => void }).startOutputDirSweep()
    ;(manager as unknown as { startOutputDirSweep: () => void }).startOutputDirSweep()

    assert.equal(capture.timeouts(), 1)
    assert.equal(capture.intervals(), 1)
    assert.match(warns.messages().join('\n'), /outputDir sweep already running/)
  } finally {
    manager.stopOutputDirSweep()
    capture.restore()
    warns.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

function captureTimerRegistration(): {
  timeouts: () => number
  intervals: () => number
  restore: () => void
} {
  const originalSetTimeout = globalThis.setTimeout
  const originalSetInterval = globalThis.setInterval
  const originalClearTimeout = globalThis.clearTimeout
  const originalClearInterval = globalThis.clearInterval
  let timeouts = 0
  let intervals = 0
  globalThis.setTimeout = ((..._args: Parameters<typeof setTimeout>) => {
    timeouts += 1
    return { kind: 'timeout', id: timeouts } as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  globalThis.setInterval = ((..._args: Parameters<typeof setInterval>) => {
    intervals += 1
    return { kind: 'interval', id: intervals } as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  globalThis.clearTimeout = ((_handle?: ReturnType<typeof setTimeout>) => {}) as typeof clearTimeout
  globalThis.clearInterval = ((_handle?: ReturnType<typeof setInterval>) => {}) as typeof clearInterval
  return {
    timeouts: () => timeouts,
    intervals: () => intervals,
    restore: () => {
      globalThis.setTimeout = originalSetTimeout
      globalThis.setInterval = originalSetInterval
      globalThis.clearTimeout = originalClearTimeout
      globalThis.clearInterval = originalClearInterval
    },
  }
}

function captureConsoleWarn(): {
  messages: () => string[]
  restore: () => void
} {
  const originalWarn = console.warn
  const messages: string[] = []
  console.warn = (...args: unknown[]) => {
    messages.push(args.map(String).join(' '))
  }
  return {
    messages: () => messages,
    restore: () => { console.warn = originalWarn },
  }
}
