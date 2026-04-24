/**
 * Phase 4 — source-level contracts for TOOL_ERROR_METRICS usage.
 *
 * Ensures the 4 existing emit sites reference the enum (not hardcoded
 * strings), that the two new emit sites exist, and that the sweep site
 * fires ttlSwept with the expected payload keys.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('tool-executor.ts imports TOOL_ERROR_METRICS and uses .inputValidation + .surfaced', () => {
  const source = readWorkspaceFile('src/main/modules/tools/tool-executor.ts')
  assert.match(source, /from ['"]\.\.\/agent-control\/tool-error-metrics['"]/)
  assert.match(source, /logAgentMetric\(TOOL_ERROR_METRICS\.inputValidation/)
  assert.match(source, /logAgentMetric\(TOOL_ERROR_METRICS\.surfaced/)
  // Old hardcoded strings must be gone from this file (within logAgentMetric call sites).
  assert.doesNotMatch(source, /logAgentMetric\(['"]tool_input_validation_failed['"]/)
  assert.doesNotMatch(source, /logAgentMetric\(['"]tool_error_surfaced['"]/)
})

test('tool-executor.ts no longer emits skill_execution_missing (Phase 4 PR2 retirement)', () => {
  const source = readWorkspaceFile('src/main/modules/tools/tool-executor.ts')
  // The retired metric must NOT be referenced anywhere in the dispatch
  // executor. `skillExecutionMissing` was the stale-executionId beacon for
  // the 6 LLM-facing state-machine tools; with those tools deleted, the
  // metric is unreachable and has been dropped from TOOL_ERROR_METRICS.
  assert.doesNotMatch(source, /skillExecutionMissing/)
  assert.doesNotMatch(source, /kind\s*===\s*['"]skill_execution_missing['"]/)
})

test('tool-runtime.ts uses TOOL_ERROR_METRICS.unknownSurfaced', () => {
  const source = readWorkspaceFile('src/main/modules/agent-control/tool-runtime.ts')
  assert.match(source, /from ['"]\.\/tool-error-metrics['"]/)
  assert.match(source, /logAgentMetric\(TOOL_ERROR_METRICS\.unknownSurfaced/)
  assert.doesNotMatch(source, /logAgentMetric\(['"]tool_error_unknown_surfaced['"]/)
})

test('turn-engine.ts uses TOOL_ERROR_METRICS.resolutionViolation', () => {
  const source = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')
  assert.match(source, /from ['"]\.\/tool-error-metrics['"]/)
  assert.match(source, /logAgentMetric\(TOOL_ERROR_METRICS\.resolutionViolation/)
  assert.doesNotMatch(source, /logAgentMetric\(['"]tool_resolution_violation_post_arbitration['"]/)
})

test('runtime-manager.ts retired the skill_executions TTL sweep (Phase 4 PR3)', () => {
  const source = readWorkspaceFile('src/main/modules/skills-runtime/runtime-manager.ts')
  // The `skill_executions` table + its TTL sweep are removed. The
  // `purgeExpiredExecutions` call, the `ttlSwept` metric emit, and the
  // `TTL_RETENTION_DAYS / TTL_SWEEP_INTERVAL_MS / TTL_BOOT_DELAY_MS` trio
  // must all be gone.
  assert.doesNotMatch(source, /purgeExpiredExecutions/)
  assert.doesNotMatch(source, /TOOL_ERROR_METRICS\.ttlSwept/)
  assert.doesNotMatch(source, /TTL_RETENTION_DAYS/)
  assert.doesNotMatch(source, /TTL_SWEEP_INTERVAL_MS/)
  assert.doesNotMatch(source, /TTL_BOOT_DELAY_MS/)
  assert.doesNotMatch(source, /startTtlSweep/)
})

test('runtime-manager.ts keeps reference-hint sweep on its own schedule', () => {
  const source = readWorkspaceFile('src/main/modules/skills-runtime/runtime-manager.ts')
  // PR3 split the reference-hint sweep away from the retired TTL sweep.
  // It still runs at the same cadence (30s boot delay + hourly interval)
  // but through a dedicated `startReferenceHintSweep()` method.
  assert.match(source, /startReferenceHintSweep\(\)/)
  assert.match(source, /REFERENCE_HINT_SWEEP_INTERVAL_MS/)
  assert.match(source, /REFERENCE_HINT_BOOT_DELAY_MS/)
  assert.match(source, /sweepExpiredReferenceSkillHints\(\)/)
})
