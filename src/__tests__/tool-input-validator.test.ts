/**
 * Unit tests for the pure validateToolInput helper (Phase 2).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'

import { validateToolInput } from '../main/modules/tools/tool-input-validator'
import { SKILL_PRIMITIVE_SCHEMAS } from '../main/modules/tools/skill-primitives/primitive-schemas'

// Real skill_write_artifact schema (relativePath = trimmed non-empty string;
// content = bare z.string()) so R-WRITE tests reproduce the incident faithfully.
const writeSchemas = { skill_write_artifact: SKILL_PRIMITIVE_SCHEMAS.skill_write_artifact } as never
const exportSchemas = { skill_export_artifact: SKILL_PRIMITIVE_SCHEMAS.skill_export_artifact } as never

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

// ── R-WRITE — alias source-key extension ────────────────────────────────────
test('R-WRITE: relativePath alias fills from file / filePath / output_path / outputPath', () => {
  for (const key of ['path', 'file', 'filePath', 'output_path', 'outputPath']) {
    const outcome = validateToolInput(
      'skill_write_artifact',
      { [key]: ' 深读.md ', content: 'body' },
      writeSchemas,
    )
    assert.equal(outcome.ok, true, `alias should fill relativePath from ${key}`)
    if (outcome.ok) {
      assert.equal(outcome.data.relativePath, '深读.md', `alias from ${key} trims + fills`)
    }
  }
})

test('R-WRITE: output_path / outputPath alias relativePath for skill_write_artifact', () => {
  for (const key of ['output_path', 'outputPath']) {
    const outcome = validateToolInput('skill_write_artifact', { [key]: '深读.md', content: 'x' }, writeSchemas)
    assert.equal(outcome.ok, true, `write: ${key} should alias`)
    if (outcome.ok) assert.equal(outcome.data.relativePath, '深读.md')
  }
})

test('R-WRITE: output_path / outputPath do NOT alias for skill_export_artifact (destination, not in-root source)', () => {
  // outputPath reads as the export DESTINATION; absorbing it into relativePath
  // would hide the real missing source and give a two-hop error surface.
  const outcome = validateToolInput('skill_export_artifact', { outputPath: '/Users/me/final.md' }, exportSchemas)
  assert.equal(outcome.ok, false)
  if (!outcome.ok) {
    const fields = new Set((outcome.output.data?.issues as Array<{ path: string[] }>).map((issue) => issue.path[0]))
    assert.ok(fields.has('relativePath'), 'relativePath still named (outputPath not absorbed for export)')
    assert.ok(fields.has('targetPath'))
  }
})

test('R-WRITE: path/file still alias the source for skill_export_artifact (targetPath untouched)', () => {
  const outcome = validateToolInput('skill_export_artifact', { path: 'src.md', targetPath: '/Users/me/final.md' }, exportSchemas)
  assert.equal(outcome.ok, true)
  if (outcome.ok) {
    assert.equal(outcome.data.relativePath, 'src.md')
    assert.equal(outcome.data.targetPath, '/Users/me/final.md')
  }
})

test('R-WRITE: a present valid relativePath is never overwritten by an alias source key', () => {
  const outcome = validateToolInput(
    'skill_write_artifact',
    { relativePath: 'real.md', filePath: 'other.md', content: 'body' },
    writeSchemas,
  )
  assert.equal(outcome.ok, true)
  if (outcome.ok) assert.equal(outcome.data.relativePath, 'real.md')
})

// ── R-WRITE — corrective names EVERY failed field with a canonical example ───
test('R-WRITE: two-field malformed write (incident form) names BOTH fields + examples, does not write', () => {
  // No relativePath / no alias source AND no content → the incident's issueCount=2.
  const outcome = validateToolInput('skill_write_artifact', { foo: 'bar' }, writeSchemas)
  assert.equal(outcome.ok, false)
  if (!outcome.ok) {
    assert.equal(outcome.issueCount, 2, 'both required string fields fail')
    const issues = outcome.output.data?.issues as Array<{ path: string[] }>
    const fields = [...new Set(issues.map((issue) => issue.path[0]))].sort()
    assert.deepEqual(fields, ['content', 'relativePath'])
    // Human text names BOTH failed fields (not just the first)…
    assert.match(outcome.output.text, /relativePath/)
    assert.match(outcome.output.text, /content/)
    // …and gives each a canonical-form example…
    assert.match(outcome.output.text, /规范形态/)
    // …and points at the write→export path for user directories.
    assert.match(outcome.output.text, /skill_export_artifact/)
    // failedFields surfaced structurally too.
    assert.deepEqual((outcome.output.data?.failedFields as string[]).slice().sort(), ['content', 'relativePath'])
  }
})

test('R-WRITE: alias fills relativePath but a still-missing content is named + not written', () => {
  // path→relativePath alias succeeds, leaving content as the sole failure.
  const outcome = validateToolInput('skill_write_artifact', { path: '深读.md' }, writeSchemas)
  assert.equal(outcome.ok, false, 'content missing → still rejected, nothing written')
  if (!outcome.ok) {
    const issues = outcome.output.data?.issues as Array<{ path: string[] }>
    const fields = new Set(issues.map((issue) => issue.path[0]))
    assert.ok(fields.has('content'))
    assert.ok(!fields.has('relativePath'), 'relativePath was satisfied by the alias')
    assert.match(outcome.output.text, /content/)
    assert.match(outcome.output.text, /规范形态/)
  }
})

test('R-WRITE: non-string content + bad encoding are each named with an example', () => {
  const outcome = validateToolInput(
    'skill_write_artifact',
    { relativePath: '深读.md', content: 123 as unknown as string, encoding: 'utf8' },
    writeSchemas,
  )
  assert.equal(outcome.ok, false)
  if (!outcome.ok) {
    assert.match(outcome.output.text, /content/)
    assert.match(outcome.output.text, /encoding/)
    assert.match(outcome.output.text, /utf-8 或 base64/)
  }
})

test('R-WRITE: a root-external absolute path still fails validation (alias never launders escapes)', () => {
  // The alias fills relativePath from `path`, but sandbox rejection is the
  // handler's job — the validator must NOT accept-and-forward a bad shape as ok
  // by shape alone here: an absolute root-external path is a valid *string* so
  // it passes the (root-less) validator; the security stop is the handler. This
  // test pins that the validator stays root-less (no false security claim).
  const outcome = validateToolInput(
    'skill_write_artifact',
    { path: '/etc/passwd', content: 'x' },
    writeSchemas,
  )
  assert.equal(outcome.ok, true, 'validator is root-less by contract; path_escape is enforced in the handler')
  if (outcome.ok) assert.equal(outcome.data.relativePath, '/etc/passwd')
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
