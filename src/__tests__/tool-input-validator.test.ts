/**
 * Unit tests for the pure validateToolInput helper (Phase 2).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'

import { validateToolInput } from '../main/modules/tools/tool-input-validator'

test('validateToolInput passes through when no schema is registered', () => {
  const outcome = validateToolInput('unmapped_tool', { anything: 1 }, {})
  assert.equal(outcome.ok, true)
  if (outcome.ok) {
    assert.deepEqual(outcome.data, { anything: 1 })
  }
})

test('validateToolInput returns parsed (coerced) data on success', () => {
  const schema = z.object({
    name: z.string().trim().min(1),
    amount: z.coerce.number(),
  })
  const outcome = validateToolInput(
    'some_tool',
    { name: '  hello  ', amount: '42' },
    { some_tool: schema },
  )
  assert.equal(outcome.ok, true)
  if (outcome.ok) {
    assert.deepEqual(outcome.data, { name: 'hello', amount: 42 })
  }
})

test('validateToolInput normalizes skill artifact path alias before schema validation', () => {
  const schema = z.object({
    relativePath: z.string().trim().min(1),
    content: z.string(),
  })
  const outcome = validateToolInput(
    'skill_write_artifact',
    { path: ' 方案.md ', content: 'hello' },
    { skill_write_artifact: schema },
  )
  assert.equal(outcome.ok, true)
  if (outcome.ok) {
    assert.deepEqual(outcome.data, {
      relativePath: '方案.md',
      content: 'hello',
    })
  }
})

test('validateToolInput keeps path alias scoped to skill artifact tools', () => {
  const schema = z.object({
    relativePath: z.string().trim().min(1),
    content: z.string(),
  })
  const outcome = validateToolInput(
    'some_tool',
    { path: '方案.md', content: 'hello' },
    { some_tool: schema },
  )
  assert.equal(outcome.ok, false)
  if (!outcome.ok) {
    assert.equal(outcome.firstPath, 'relativePath')
  }
})

test('validateToolInput builds a structured error with errorKind input_validation on failure', () => {
  const schema = z.object({
    executionId: z.string().trim().min(1),
    count: z.number(),
  })
  const outcome = validateToolInput(
    'skill_submit_input',
    { executionId: '', count: 'not-a-number' },
    { skill_submit_input: schema },
  )
  assert.equal(outcome.ok, false)
  if (!outcome.ok) {
    assert.equal(outcome.output.shape, 'json')
    assert.equal(outcome.output.data?.errorKind, 'input_validation')
    assert.equal(outcome.output.data?.toolName, 'skill_submit_input')
    assert.ok(typeof outcome.firstCode === 'string' && outcome.firstCode.length > 0)
    assert.equal(outcome.issueCount >= 1, true)
    assert.match(outcome.output.text, /工具 skill_submit_input 输入校验失败/)
  }
})

test('validateToolInput caps reported issues at 10 and serializes as plain JSON', () => {
  const schema = z.object({
    fields: z.array(z.string()),
  })
  const payload = { fields: Array.from({ length: 20 }, () => 123 as unknown as string) }
  const outcome = validateToolInput('some_tool', payload, { some_tool: schema })
  assert.equal(outcome.ok, false)
  if (!outcome.ok) {
    const reportedIssues = outcome.output.data?.issues as Array<Record<string, unknown>>
    assert.ok(Array.isArray(reportedIssues))
    assert.equal(reportedIssues.length <= 10, true)
    for (const issue of reportedIssues) {
      assert.ok(Array.isArray(issue.path))
      assert.equal(typeof issue.code, 'string')
      assert.equal(typeof issue.message, 'string')
      // Must be JSON-safe
      JSON.stringify(issue)
    }
    // issueCount should reflect total, not capped
    assert.equal(outcome.issueCount >= 20, true)
  }
})

test('validateToolInput root-level errors display (root) instead of empty path', () => {
  const schema = z.object({ executionId: z.string() })
  // Pass a non-object to force a root-level validation error
  const outcome = validateToolInput('tool_x', 'not an object' as unknown as Record<string, unknown>, { tool_x: schema })
  assert.equal(outcome.ok, false)
  if (!outcome.ok) {
    assert.match(outcome.output.text, /\(root\)|executionId/)
  }
})
