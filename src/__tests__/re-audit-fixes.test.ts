import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  isSkillTaskProjectionLive,
  readSkillTaskProjection,
  recordSkillTaskEvent,
  clearSkillTaskProjection,
} from '../main/modules/agent-control/skills/skill-task-tracker'
import {
  choosePrimitiveSkillId,
  shouldExposeSkillPrimitive,
} from '../main/modules/tools/skill-tool-session-gate'

// RE-AUDIT — fixes applied after the second-pass audit caught:
//   4.3 — projection signal too permissive (terminal state still exposed primitives)
//   5.1 followup — orchestrator's hardcoded primitive list missed skill_inspect_run_state
//   5.4 — emitter cleanup missing
//   4.2 — restored continuation budget didn't get inheritance pass
//   3.2 — false-positive trade-off documented
//   bonus — _resetLastReferenceSkillHintsForTests now also clears emitter

const TURN_ENGINE_PATH = new URL('../main/modules/agent-control/turn-engine.ts', import.meta.url)
const SKILLS_TOOLS_PATH = new URL('../main/modules/tools/skills-tools.ts', import.meta.url)
const SKILL_CONTEXT_ORCHESTRATOR_PATH = new URL('../main/modules/agent-control/skills/skill-context-orchestrator.ts', import.meta.url)
const IPC_HANDLER_PATH = new URL('../main/modules/claude-bridge/ipc-handler.ts', import.meta.url)
const HINT_MODULE_PATH = new URL('../main/modules/agent-control/skills/skill-reference-hints.ts', import.meta.url)

function readSource(url: URL): string {
  return readFileSync(url, 'utf8')
}

// ---------------------------------------------------------------------------
// FIX 4.3 — isSkillTaskProjectionLive collapses terminal projections to false
// ---------------------------------------------------------------------------

test('FIX 4.3 — isSkillTaskProjectionLive returns true for running step', () => {
  clearSkillTaskProjection()
  recordSkillTaskEvent({
    sessionId: 'sess-A',
    skillId: 'video-expert-analyzer',
    toolName: 'skill_run_shell',
    status: 'running',
    message: 'starting pipeline',
  })
  const projection = readSkillTaskProjection({ sessionId: 'sess-A' })
  assert.equal(isSkillTaskProjectionLive(projection), true)
})

test('FIX 4.3 — isSkillTaskProjectionLive returns true for blocked step', () => {
  clearSkillTaskProjection()
  recordSkillTaskEvent({
    sessionId: 'sess-B',
    skillId: 'video-expert-analyzer',
    toolName: 'skill_ask_user',
    status: 'blocked',
    message: 'awaiting input',
  })
  assert.equal(
    isSkillTaskProjectionLive(readSkillTaskProjection({ sessionId: 'sess-B' })),
    true,
  )
})

test('FIX 4.3 — isSkillTaskProjectionLive collapses to false on done step (the regression that motivated this fix)', () => {
  clearSkillTaskProjection()
  recordSkillTaskEvent({
    sessionId: 'sess-C',
    skillId: 'video-expert-analyzer',
    toolName: 'skill_run_shell',
    status: 'done',
    message: 'finished',
  })
  const projection = readSkillTaskProjection({ sessionId: 'sess-C' })
  // projection STILL exists in the map (no automatic clearSkillTaskProjection
  // on terminal status) but the live check correctly returns false.
  assert.notEqual(projection, null, 'projection persists after done')
  assert.equal(isSkillTaskProjectionLive(projection), false, 'but is no longer live')
})

test('FIX 4.3 — error step is also terminal (collapses to false)', () => {
  clearSkillTaskProjection()
  recordSkillTaskEvent({
    sessionId: 'sess-D',
    skillId: 'video-expert-analyzer',
    toolName: 'skill_run_shell',
    status: 'error',
    message: 'oops',
  })
  assert.equal(
    isSkillTaskProjectionLive(readSkillTaskProjection({ sessionId: 'sess-D' })),
    false,
  )
})

test('FIX 4.3 — null / empty projection is not live', () => {
  assert.equal(isSkillTaskProjectionLive(null), false)
  assert.equal(isSkillTaskProjectionLive(undefined), false)
})

test('FIX 4.3 — primitive gate uses live check (not raw projection !== null)', () => {
  // Build a fake gate scenario: hint NOT armed, but projection in done state.
  // Old behavior would have exposed primitives. New behavior must NOT.
  let gateLive = false
  const exposed = shouldExposeSkillPrimitive(
    'sess-X',
    () => false,
    () => false,
    () => gateLive,
  )
  assert.equal(exposed, false, 'live=false → not exposed')
  gateLive = true
  const exposed2 = shouldExposeSkillPrimitive(
    'sess-X',
    () => false,
    () => false,
    () => gateLive,
  )
  assert.equal(exposed2, true, 'live=true → exposed')
})

test('FIX 4.3 wiring — skills-tools dispatch wraps readSkillTaskProjection in isSkillTaskProjectionLive', () => {
  const source = readSource(SKILLS_TOOLS_PATH)
  // Source-pin the new wrapper so a future refactor that reverts to the
  // permissive form gets caught.
  assert.match(
    source,
    /isSkillTaskProjectionLive\(readSkillTaskProjection\(\{\s*sessionId:\s*sid\s*\}\)\)/,
  )
  assert.match(source, /isSkillTaskProjectionLive,/, 'helper is imported')
  // The OLD form must be gone from the dispatch site (allowed elsewhere
  // since the function itself is still legitimate to call).
  const dispatchBlock = source.match(/function getSkillToolDefs\(sessionId\?: string\)[\s\S]{0,800}/)
  assert.ok(dispatchBlock)
  assert.doesNotMatch(
    dispatchBlock![0],
    /readSkillTaskProjection\(\{\s*sessionId:\s*sid\s*\}\)\s*!==\s*null/,
    'old permissive form must be gone from dispatch',
  )
})

test('Stage 3 — primitive skill id can come from the TurnFrame before hint or task-run fallbacks', () => {
  assert.equal(
    choosePrimitiveSkillId({
      frameSkillId: 'video-expert-analyzer',
      activeContextSkillId: null,
      referenceHintSkillId: 'lets-go-rss',
      latestTaskRunSkillId: 'novel-writer-system',
    }),
    'video-expert-analyzer',
  )
  assert.equal(
    choosePrimitiveSkillId({
      frameSkillId: null,
      activeContextSkillId: 'video-expert-analyzer',
      referenceHintSkillId: 'lets-go-rss',
      latestTaskRunSkillId: null,
    }),
    'video-expert-analyzer',
  )
})

// ---------------------------------------------------------------------------
// FIX 5.1 followup — orchestrator preferred-tools list includes the new primitive
// ---------------------------------------------------------------------------

test('FIX 5.1 followup — REFERENCE_SKILL_PRIMITIVE_TOOL_NAMES includes skill_inspect_run_state', () => {
  const source = readSource(SKILL_CONTEXT_ORCHESTRATOR_PATH)
  // Find the array literal and assert membership.
  const block = source.match(/const REFERENCE_SKILL_PRIMITIVE_TOOL_NAMES\s*=\s*\[[\s\S]*?\]/)
  assert.ok(block, 'list exists')
  assert.match(block![0], /'skill_inspect_run_state'/)
  // Sanity: the existing primitives must still be present (the fix didn't
  // accidentally drop them).
  for (const name of [
    'skill_ask_user',
    'skill_run_shell',
    'skill_write_artifact',
    'skill_read_artifact',
    'skill_start_detached',
    'skill_inspect_detached',
    'skill_cancel_detached',
  ]) {
    assert.match(block![0], new RegExp(`'${name}'`), `${name} preserved`)
  }
})

// ---------------------------------------------------------------------------
// FIX 5.4 — cleanupAgentRuntime releases the emitter
// ---------------------------------------------------------------------------

test('FIX 5.4 — cleanupAgentRuntime calls setReferenceHintChangeEmitter(null)', () => {
  const source = readSource(IPC_HANDLER_PATH)
  const block = source.match(/export async function cleanupAgentRuntime[\s\S]*?\n\}/)
  assert.ok(block)
  assert.match(
    block![0],
    /setReferenceHintChangeEmitter\(null\)/,
    'emitter must be released so window closure can be GC-ed',
  )
})

// ---------------------------------------------------------------------------
// FIX 4.2 — restored continuation budget also gets inheritance pass
// ---------------------------------------------------------------------------

test('FIX 4.2 — continuation override no longer gates on absent budgetRuntime', () => {
  const source = readSource(TURN_ENGINE_PATH)
  // The OLD condition was `chain === 'continuation' && !taskExecutionRoute.continuation?.budgetRuntime`.
  // The NEW condition is just `chain === 'continuation'` — restored runtimes
  // also get the inheritance pass when their saved maxIter is below what the
  // original taskType would justify.
  assert.doesNotMatch(
    source,
    /taskExecutionRoute\.chain\s*===\s*'continuation'\s*\n?\s*&&\s*!\s*taskExecutionRoute\.continuation\?\.budgetRuntime/,
    'old "no saved runtime" gate must be gone',
  )
  // The override condition stays guarded by `inheritedSeed.maxIterations >
  // (previousMaxIterations ?? 0)` so this is not unconditionally larger.
  assert.match(source, /inheritedSeed\.maxIterations\s*>\s*\(previousMaxIterations\s*\?\?\s*0\)/)
  // The metric now also reports whether we saw a restored runtime (so dashboards
  // can split the asymmetric vs symmetric inheritance cases).
  assert.match(source, /hadRestoredRuntime:\s*Boolean\(taskExecutionRoute\.continuation\?\.budgetRuntime\)/)
})

// ---------------------------------------------------------------------------
// DOC 3.2 — TOOL_CALL_TEXT_PATTERN trade-off documented
// ---------------------------------------------------------------------------

test('DOC 3.2 — TOOL_CALL_TEXT_PATTERN comment names the false-positive trade-off', () => {
  // Screenshot-bug hotfix moved the pattern + helpers to a dedicated module
  // (`tool-call-text-guard.ts`) to break the turn-engine ↔ turn-transcript
  // circular dep. The doc lives there now; turn-engine.ts re-exports.
  const guardSource = readSource(new URL('../main/modules/agent-control/tools-runtime/tool-call-text-guard.ts', import.meta.url))
  const block = guardSource.match(/\/\*\*[\s\S]*?\*\/\s*export const TOOL_CALL_TEXT_PATTERN/)
  assert.ok(block, 'doc block exists in tool-call-text-guard module')
  assert.match(block![0], /Trade-off/i)
  assert.match(block![0], /tool_call_text_intercepted/, 'metric is named so reviewers can verify the false-positive rate')
})

// ---------------------------------------------------------------------------
// FIX bonus — _resetLastReferenceSkillHintsForTests also clears emitter
// ---------------------------------------------------------------------------

test('FIX bonus — _resetLastReferenceSkillHintsForTests resets the emitter too', () => {
  const source = readSource(HINT_MODULE_PATH)
  const block = source.match(/export function _resetLastReferenceSkillHintsForTests[\s\S]*?\}\s*\n/)
  assert.ok(block)
  assert.match(block![0], /lastReferenceSkillBySession\.clear\(\)/)
  assert.match(block![0], /hintChangeEmitter\s*=\s*null/, 'emitter must be reset to prevent cross-file test leakage')
})
