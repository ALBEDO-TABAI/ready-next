import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

type Fixture = {
  id: string
  category: string
  title: string
  userRequest: string
  standardBaseline: string[]
  hostCriteria: string[]
  expectedOutputs: string[]
  allowedTools: string[]
  forbiddenSideEffects: string[]
  maxBudget: {
    totalTokens: number
    wallClockMs: number
    extraModelCalls: number
    workers: number
  }
}

const fixturePath = fileURLToPath(new URL('./fixtures/dynamic-delivery/fixtures.json', import.meta.url))
const payload = JSON.parse(readFileSync(fixturePath, 'utf8')) as { version: number; fixtures: Fixture[] }
const expectedCategories = [
  'research',
  'content_creation',
  'visual_video',
  'document_edit',
  'explicit_skill',
  'high_risk_action',
]

test('dynamic delivery fixture matrix is exactly six categories with two cases each', () => {
  assert.equal(payload.version, 1)
  assert.equal(payload.fixtures.length, 12)
  assert.equal(new Set(payload.fixtures.map((fixture) => fixture.id)).size, 12)

  const counts = new Map<string, number>()
  for (const fixture of payload.fixtures) {
    counts.set(fixture.category, (counts.get(fixture.category) ?? 0) + 1)
  }
  assert.deepEqual([...counts.keys()].sort(), [...expectedCategories].sort())
  for (const category of expectedCategories) assert.equal(counts.get(category), 2, category)
})

test('every fixture has a complete baseline, acceptance contract, outputs and closed budget', () => {
  for (const fixture of payload.fixtures) {
    assert.ok(fixture.id.trim(), 'id')
    assert.ok(fixture.title.trim(), `${fixture.id}: title`)
    assert.ok(fixture.userRequest.trim(), `${fixture.id}: userRequest`)
    for (const field of ['standardBaseline', 'hostCriteria', 'expectedOutputs', 'allowedTools', 'forbiddenSideEffects'] as const) {
      assert.ok(fixture[field].length > 0, `${fixture.id}: ${field}`)
      assert.ok(fixture[field].every((item) => typeof item === 'string' && item.trim()), `${fixture.id}: ${field} values`)
    }

    assert.ok(Number.isInteger(fixture.maxBudget.totalTokens) && fixture.maxBudget.totalTokens > 0)
    assert.ok(Number.isInteger(fixture.maxBudget.wallClockMs) && fixture.maxBudget.wallClockMs > 0)
    assert.ok(Number.isInteger(fixture.maxBudget.extraModelCalls) && fixture.maxBudget.extraModelCalls >= 0)
    assert.ok(Number.isInteger(fixture.maxBudget.workers) && fixture.maxBudget.workers >= 0)
    assert.ok(fixture.maxBudget.totalTokens <= 120000, `${fixture.id}: token hard cap`)
    assert.ok(fixture.maxBudget.wallClockMs <= 300000, `${fixture.id}: wall-clock hard cap`)
    assert.ok(fixture.maxBudget.extraModelCalls <= 8, `${fixture.id}: call hard cap`)
    assert.ok(fixture.maxBudget.workers <= 3, `${fixture.id}: worker hard cap`)
  }
})

test('fixtures preserve owner-only effects and high-risk confirmation boundaries', () => {
  for (const fixture of payload.fixtures) {
    assert.ok(fixture.allowedTools.every((tool) => tool.startsWith('owner:')), `${fixture.id}: owner-only tools`)
    assert.ok(fixture.forbiddenSideEffects.includes('worker_tool_use'), `${fixture.id}: workers remain tool-free`)
  }

  const documentCases = payload.fixtures.filter((fixture) => fixture.category === 'document_edit')
  assert.ok(documentCases.every((fixture) => fixture.forbiddenSideEffects.includes('worker_document_write')))

  const skillCases = payload.fixtures.filter((fixture) => fixture.category === 'explicit_skill')
  assert.ok(skillCases.every((fixture) => fixture.forbiddenSideEffects.includes('worker_selected_skill_action')))

  const highRiskCases = payload.fixtures.filter((fixture) => fixture.category === 'high_risk_action')
  for (const fixture of highRiskCases) {
    assert.ok(fixture.allowedTools.includes('owner:confirmation'), `${fixture.id}: confirmation remains with owner`)
    assert.ok(fixture.forbiddenSideEffects.includes('worker_external_action'), `${fixture.id}: no worker action`)
    assert.ok(fixture.forbiddenSideEffects.some((effect) => effect.endsWith('_without_confirmation')))
  }
})
