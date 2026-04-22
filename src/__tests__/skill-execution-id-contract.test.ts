/**
 * Phase 4 — source-level contract for skill execution id prefix migration.
 *
 * Ensures createExecution() uses the new `generateSkillExecutionId()` + retry
 * loop instead of raw randomUUID(), and that the retry pre-checks uniqueness
 * to guard against the ON CONFLICT(id) DO UPDATE upsert silently overwriting
 * a colliding row.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('execution-state-store exports generateSkillExecutionId returning e-{8hex}', () => {
  const source = readWorkspaceFile('src/main/modules/skills-runtime/execution-state-store.ts')
  assert.match(source, /export function generateSkillExecutionId\(\)/)
  assert.match(source, /`e-\$\{randomBytes\(4\)\.toString\('hex'\)\}`/)
})

test('createExecution uses generateSkillExecutionId + pre-check retry loop', () => {
  const source = readWorkspaceFile('src/main/modules/skills-runtime/execution-state-store.ts')
  const createExecutionBody = source.match(/createExecution\([\s\S]*?\}\s*\n\s{2}\}/)
  assert.ok(createExecutionBody, 'createExecution body must be locatable')
  const body = createExecutionBody![0]
  assert.match(body, /let\s+id\s*=\s*generateSkillExecutionId\(\)/)
  assert.match(body, /attempts\s*<\s*3/)
  assert.match(body, /SELECT id FROM skill_executions WHERE id = \?/)
  // randomUUID must not be used for the execution's primary id any more —
  // it can still appear elsewhere in the file (e.g. step record ids).
  assert.doesNotMatch(body, /const\s+id\s*=\s*randomUUID\(\)/)
})

test('purgeExpiredExecutions deletes children before parent (CASCADE no-op workaround)', () => {
  const source = readWorkspaceFile('src/main/modules/skills-runtime/execution-state-store.ts')
  // Pull a generous window starting at the method signature — `purgeExpiredExecutions`
  // has branches + multiple returns so naive {}-balancing via regex is fragile.
  const startIdx = source.indexOf('purgeExpiredExecutions(retentionDays')
  assert.ok(startIdx > 0, 'purgeExpiredExecutions signature must be present')
  const body = source.slice(startIdx, startIdx + 2500)
  // Order must be: artifacts → steps → executions (children first).
  const artifactsIdx = body.indexOf('DELETE FROM skill_execution_artifacts')
  const stepsIdx = body.indexOf('DELETE FROM skill_execution_steps')
  const parentIdx = body.indexOf('DELETE FROM skill_executions WHERE id IN')
  assert.ok(artifactsIdx > 0 && stepsIdx > 0 && parentIdx > 0, 'all three DELETEs must be present')
  assert.ok(artifactsIdx < parentIdx, 'artifacts DELETE must precede parent')
  assert.ok(stepsIdx < parentIdx, 'steps DELETE must precede parent')
  // Terminal filter must be present — active rows never swept.
  assert.match(body, /status IN \('completed', 'failed', 'cancelled'\)/)
  assert.match(body, /finished_at IS NOT NULL/)
  assert.match(body, /finished_at < \?/)
})
