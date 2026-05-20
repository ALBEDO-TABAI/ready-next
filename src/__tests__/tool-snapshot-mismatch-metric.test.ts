import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { TOOL_ERROR_METRICS } from '../main/modules/agent-control/tools-runtime/tool-error-metrics'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

// R4 contract test: when openai-execution-client detects a mismatch between the
// expected allowedToolNames (from turn-engine / preparedRunCapabilities) and
// the recomputed list, it must emit a tool_snapshot_mismatch metric in addition
// to the existing log line. Without the metric, the log is only useful for
// manual debugging — no way to bucket long-tail frequency across sessions.

test('TOOL_ERROR_METRICS registers toolSnapshotMismatch with a stable snake_case name', () => {
  assert.equal(TOOL_ERROR_METRICS.toolSnapshotMismatch, 'tool_snapshot_mismatch')
})

test('openai-execution-client emits tool_snapshot_mismatch metric inside the mismatch branch', () => {
  const client = readWorkspaceFile('src/main/modules/claude-bridge/openai-execution-client.ts')

  // Metric must be imported from the central registry, not hard-coded.
  assert.match(client, /import \{ TOOL_ERROR_METRICS \} from '\.\.\/agent-control\/tool-error-metrics'/)
  assert.match(client, /import \{ logAgentMetric \} from '\.\.\/agent-control\/metrics'/)

  // The metric emission must be nested inside the `if (mismatch)` block, not
  // fired on every request. Pin this by requiring the emit to appear between
  // "if (mismatch)" and the next top-level statement.
  const mismatchBlock = client.match(/if \(mismatch\) \{[\s\S]*?\n {4}\}/)?.[0]
  assert.ok(mismatchBlock, 'expected an if (mismatch) block in openai-execution-client')
  assert.match(mismatchBlock!, /logAgentMetric\(TOOL_ERROR_METRICS\.toolSnapshotMismatch/)
  assert.match(mismatchBlock!, /expectedCount:/)
  assert.match(mismatchBlock!, /actualCount:/)
  assert.match(mismatchBlock!, /expectedSample:/)
  assert.match(mismatchBlock!, /actualSample:/)
  assert.match(mismatchBlock!, /provider:/)
})

test('tool_snapshot_mismatch metric emission is wrapped in try/catch to never break the request path', () => {
  const client = readWorkspaceFile('src/main/modules/claude-bridge/openai-execution-client.ts')
  // CLAUDE.md §6.11: metrics must never break the request. The try block
  // around the emission enforces this invariant.
  assert.match(client, /try \{\s*logAgentMetric\(TOOL_ERROR_METRICS\.toolSnapshotMismatch[\s\S]*?\}\s*catch\s*\{/)
})
