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

test('tool-executor.ts emits skill_execution_missing metric when kind matches', () => {
  const source = readWorkspaceFile('src/main/modules/tools/tool-executor.ts')
  assert.match(
    source,
    /if\s*\(kind\s*===\s*['"]skill_execution_missing['"]\)[\s\S]*logAgentMetric\(TOOL_ERROR_METRICS\.skillExecutionMissing/,
  )
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

test('runtime-manager.ts emits ttlSwept metric with deleted/retentionDays/cutoff', () => {
  const source = readWorkspaceFile('src/main/modules/skills-runtime/runtime-manager.ts')
  assert.match(source, /from ['"]\.\.\/agent-control\/tool-error-metrics['"]/)
  assert.match(source, /store\.purgeExpiredExecutions\(/)
  const sweepBlock = source.match(/logAgentMetric\(TOOL_ERROR_METRICS\.ttlSwept,[\s\S]*?\}\)/)
  assert.ok(sweepBlock, 'ttlSwept emit block must be present')
  const body = sweepBlock![0]
  assert.match(body, /deleted/)
  assert.match(body, /retentionDays/)
  assert.match(body, /cutoff/)
})

test('runtime-manager.ts schedules TTL sweep with boot delay + hourly interval', () => {
  const source = readWorkspaceFile('src/main/modules/skills-runtime/runtime-manager.ts')
  assert.match(source, /TTL_RETENTION_DAYS\s*=\s*7/)
  assert.match(source, /TTL_SWEEP_INTERVAL_MS\s*=\s*60\s*\*\s*60_?000/)
  assert.match(source, /TTL_BOOT_DELAY_MS/)
  assert.match(source, /startTtlSweep\(\)/)
  assert.match(source, /setTimeout\(sweep, SkillsRuntimeManager\.TTL_BOOT_DELAY_MS\)/)
  assert.match(source, /setInterval\(sweep, SkillsRuntimeManager\.TTL_SWEEP_INTERVAL_MS\)/)
})
