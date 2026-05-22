/**
 * PR5 observability contract — the `skill_reference_inlined` metric has an
 * IPC push twin so the renderer can toast "skill loaded". Without this, the
 * Phase 3/4 hot path is invisible to the user: inline injection produces
 * zero tool_use events, so a working skill and an ignored skill look
 * identical.
 *
 * Source-level pins — exercising the full orchestrator path needs electron
 * + the full runtime, which `tsx --test` can't boot. These regex checks
 * lock the bridge wiring at both ends (main emit + IPC setup).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  _resetSkillReferenceInlinedBridgeForTests,
  emitSkillReferenceInlined,
  registerSkillReferenceInlinedEmitter,
  type SkillReferenceInlinedEvent,
} from '../main/modules/agent-control/skills/skill-reference-inlined-bridge'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('registerSkillReferenceInlinedEmitter wires the emitter; emit forwards verbatim', () => {
  _resetSkillReferenceInlinedBridgeForTests()
  const received: SkillReferenceInlinedEvent[] = []
  registerSkillReferenceInlinedEmitter((event) => {
    received.push(event)
  })

  const payload: SkillReferenceInlinedEvent = {
    sessionId: 'scope-1',
    skillId: 'novel-writer-system',
    skillName: 'Deep Novel System',
    source: 'direct_read',
    bytesInjected: 3586,
    truncated: false,
    at: 1_777_000_000_000,
  }
  emitSkillReferenceInlined(payload)

  assert.equal(received.length, 1)
  assert.deepEqual(received[0], payload)
})

test('emit is a no-op when the emitter is reset / never registered', () => {
  _resetSkillReferenceInlinedBridgeForTests()
  // Must not throw — the orchestrator emits regardless of whether the IPC
  // layer has registered yet (boot ordering: the orchestrator can fire during
  // the very first turn before setupAgentIPC registers).
  emitSkillReferenceInlined({
    sessionId: null,
    skillId: 'x',
    skillName: 'x',
    source: 'direct_read',
    bytesInjected: 0,
    truncated: false,
    at: 0,
  })
})

test('unregistering collapses back to no-op', () => {
  _resetSkillReferenceInlinedBridgeForTests()
  const received: SkillReferenceInlinedEvent[] = []
  registerSkillReferenceInlinedEmitter((event) => { received.push(event) })
  registerSkillReferenceInlinedEmitter(null)

  emitSkillReferenceInlined({
    sessionId: null,
    skillId: 'x',
    skillName: 'x',
    source: 'direct_read',
    bytesInjected: 0,
    truncated: false,
    at: 0,
  })
  assert.equal(received.length, 0)
})

test('orchestrator emits on both the direct-read and tool_fallback paths', () => {
  const src = readWorkspaceFile('src/main/modules/agent-control/skills/skill-context-orchestrator.ts')
  assert.match(src, /import\s*\{\s*emitSkillReferenceInlined\s*\}/)
  // There must be exactly 2 emit sites matching the 2 `logAgentMetric` sites
  // for `skill_reference_inlined`. If a future refactor moves one but not the
  // other, the symmetry breaks.
  const emitMatches = src.match(/emitSkillReferenceInlined\(\s*\{/g) || []
  assert.equal(emitMatches.length, 2, `expected 2 emit sites, found ${emitMatches.length}`)
  const metricMatches = src.match(/logAgentMetric\(\s*'skill_reference_inlined'/g) || []
  assert.equal(metricMatches.length, 2, 'metric sites drifted from emit sites')
})

test('ipc-handler registers the emitter with a mainWindow.webContents.send hook', () => {
  const src = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')
  assert.match(src, /registerSkillReferenceInlinedEmitter\(/)
  assert.match(src, /mainWindow\.webContents\.send\(\s*['"]skill:referenceInlined['"]/)
})

test('preload exposes onSkillReferenceInlined with an unsubscribe handle', () => {
  const src = readWorkspaceFile('src/preload/index.ts')
  assert.match(src, /onSkillReferenceInlined:/)
  assert.match(src, /ipcRenderer\.on\(\s*['"]skill:referenceInlined['"]/)
  assert.match(src, /ipcRenderer\.removeListener\(\s*['"]skill:referenceInlined['"]/)
})
