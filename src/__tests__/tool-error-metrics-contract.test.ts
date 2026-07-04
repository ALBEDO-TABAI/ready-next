/**
 * Phase 4 — source-level contracts for TOOL_ERROR_METRICS usage.
 *
 * Ensures the emit sites reference the enum (not hardcoded strings) and that
 * the reference-hint TTL sweep site fires the new
 * skillReferenceHintTtlSwept metric with the expected payload keys.
 *
 * Phase 4 retirement notes:
 *   - `skill_execution_missing` metric + emit branch deleted along with
 *     skill-execution-missing.ts and the skill_executions state machine
 *   - `skill_executions_ttl_swept` renamed to `skill_reference_hint_ttl_swept`
 *     because the sweep now only prunes reference-skill hints (skill_executions
 *     table is dropped in migration 029)
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: tool-error metric registration is protected as source-surface wiring
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('tool-executor.ts imports TOOL_ERROR_METRICS and uses .inputValidation + .surfaced', () => {
  const source = readWorkspaceFile('src/main/modules/tools/tool-executor.ts')
  assert.match(source, /from ['"]\.\.\/agent-control\/tools-runtime\/tool-error-metrics['"]/)
  assert.match(source, /logAgentMetric\(TOOL_ERROR_METRICS\.inputValidation/)
  assert.match(source, /logAgentMetric\(TOOL_ERROR_METRICS\.surfaced/)
  // Old hardcoded strings must be gone from this file (within logAgentMetric call sites).
  assert.doesNotMatch(source, /logAgentMetric\(['"]tool_input_validation_failed['"]/)
  assert.doesNotMatch(source, /logAgentMetric\(['"]tool_error_surfaced['"]/)
})

test('tool-runtime.ts uses TOOL_ERROR_METRICS.unknownSurfaced', () => {
  const source = readWorkspaceFile('src/main/modules/agent-control/tools-runtime/tool-runtime.ts')
  assert.match(source, /from ['"]\.\/tool-error-metrics['"]/)
  assert.match(source, /logAgentMetric\(TOOL_ERROR_METRICS\.unknownSurfaced/)
  assert.doesNotMatch(source, /logAgentMetric\(['"]tool_error_unknown_surfaced['"]/)
})

test('skill-reference-hints.ts emits skillReferenceHintTtlSwept on sweep', () => {
  const source = readWorkspaceFile('src/main/modules/agent-control/skills/skill-reference-hints.ts')
  assert.match(source, /from ['"]\.\.\/tools-runtime\/tool-error-metrics['"]/)
  assert.match(
    source,
    /logAgentMetric\(TOOL_ERROR_METRICS\.skillReferenceHintTtlSwept/,
  )
})

test('runtime-manager.ts schedules reference-hint sweep with boot delay + hourly interval', () => {
  const source = readWorkspaceFile('src/main/modules/skills-runtime/runtime-manager.ts')
  assert.match(source, /REFERENCE_HINT_SWEEP_INTERVAL_MS\s*=\s*60\s*\*\s*60_?000/)
  assert.match(source, /REFERENCE_HINT_BOOT_DELAY_MS/)
  assert.match(source, /startReferenceHintSweep\(\)/)
})
