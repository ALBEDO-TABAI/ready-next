/**
 * EP2-Q2 — criteria template engine (02 §3.2). Two-dimensional lookup:
 * task_type base templates × module overlays. Key drift against the HEAD
 * TASK_TYPES enum is a hard failure (模板键错配 = 框架落空).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { TASK_TYPES } from '../shared/task-types'
import {
  CRITERIA_BASE_TASK_TYPES,
  CRITERIA_OVERLAY_MODULES,
  resolveCriteria,
  appendModelCriteria,
  markNotApplicable,
} from '../main/modules/agent-control/quality/criteria-templates'

test('template keys match the HEAD TASK_TYPES enum exactly (drift guard, both directions)', () => {
  assert.deepEqual([...CRITERIA_BASE_TASK_TYPES].sort(), [...TASK_TYPES].sort())
  assert.deepEqual([...CRITERIA_OVERLAY_MODULES].sort(), ['browser', 'document', 'skill'])
})

test('full matrix coverage: every task_type × module resolves to a non-empty criteria set', () => {
  const modules = ['browser', 'skill', 'document', 'system', 'rss', 'unknown-module']
  for (const taskType of TASK_TYPES) {
    for (const module of modules) {
      const resolved = resolveCriteria(taskType, module)
      assert.ok(resolved.items.length >= 1, `${taskType}×${module} must yield at least one criteria item`)
      for (const item of resolved.items) {
        assert.ok(item.id && item.text, `${taskType}×${module} items carry id+text`)
      }
    }
  }
})

test('module overlays append on top of the base — never replace it', () => {
  const base = resolveCriteria('multi_step_task', 'system')
  const overlaid = resolveCriteria('multi_step_task', 'browser')
  for (const item of base.items) {
    assert.ok(overlaid.items.some((candidate) => candidate.id === item.id), `base item ${item.id} survives overlay`)
  }
  assert.ok(overlaid.items.length > base.items.length, 'browser overlay adds collection criteria')
  assert.ok(overlaid.items.some((item) => item.text.includes('项数达标') || item.text.includes('空结果')))
})

test('browser_transaction uses transaction confirmation criteria, not browser collection overlay', () => {
  const resolved = resolveCriteria('browser_transaction', 'browser')
  assert.deepEqual(resolved.items.map((item) => item.id), ['t1'])
  assert.equal(resolved.items[0].kind, 'transaction_confirmed')
  assert.equal(resolved.items.some((item) => item.kind === 'collection_verdict'), false)
  assert.equal(resolved.items.some((item) => item.kind === 'result_parseable'), false)
})

test('direct_answer: assistant_response digest is the proof expectation, with the action-declaration escape hatch sealed', () => {
  const resolved = resolveCriteria('direct_answer', 'system')
  assert.equal(resolved.proofExpectation, 'assistant_response_digest')
  assert.equal(resolved.actionDeclarationReclassify, 'short_task', 'action declaration in a direct_answer turn re-judges as short_task')
  assert.ok(resolved.items.some((item) => item.kind === 'response_digest'))
})

test('not_applicable requires an explicit reason — silent removal is impossible', () => {
  const resolved = resolveCriteria('short_task', 'system')
  const item = resolved.items[0]
  assert.throws(() => markNotApplicable(item, ''), /reason/)
  assert.throws(() => markNotApplicable(item, '   '), /reason/)
  const marked = markNotApplicable(item, '用户改为口头确认，无需工具')
  assert.equal(marked.notApplicable?.reason, '用户改为口头确认，无需工具')
  assert.equal(item.notApplicable, undefined, 'marking is non-mutating')
})

test('model additions append after template items and can never delete or override them', () => {
  const resolved = resolveCriteria('research', 'system')
  const merged = appendModelCriteria(resolved.items, [
    { text: '报告必须包含竞品对比表' },
    { text: '', }, // empty text is dropped, not an error
  ])
  for (const item of resolved.items) {
    assert.ok(merged.some((candidate) => candidate.id === item.id && candidate.text === item.text), 'template items intact')
  }
  const added = merged.filter((item) => item.source === 'model')
  assert.equal(added.length, 1)
  assert.ok(added[0].id.startsWith('m'), 'model items get their own id namespace')

  // a model "addition" colliding with a template id cannot override it
  const hijack = appendModelCriteria(resolved.items, [{ text: '篡改', id: resolved.items[0].id } as never])
  const original = hijack.find((item) => item.id === resolved.items[0].id)
  assert.equal(original?.text, resolved.items[0].text)
})

test('skill s1/skill_run_state is exempted for direct AND primitive-only runs, kept for child_loop/python (P0-2)', () => {
  const s1Of = (form?: 'direct' | 'child_loop' | 'python' | null) =>
    resolveCriteria('short_task', 'skill', form === undefined ? undefined : { skillExecutionForm: form })
      .items.find((item) => item.id === 's1')

  // child-bearing forms keep the real run_state contract (NOT loosened)
  assert.equal(s1Of('child_loop')?.notApplicable, undefined, 'child_loop keeps s1 (has run_state contract)')
  assert.equal(s1Of('python')?.notApplicable, undefined, 'python keeps s1 (has run_state contract)')

  // direct + primitive-only (null / unset) are exempted — s1 is structurally
  // unsatisfiable for them and must not force-fail a successful run
  assert.ok(s1Of('direct')?.notApplicable?.reason, 'direct skill exempts s1')
  assert.ok(s1Of(null)?.notApplicable?.reason, 'primitive-only (null form) exempts s1')
  assert.ok(s1Of(undefined)?.notApplicable?.reason, 'primitive-only (unset form) exempts s1')
  assert.match(String(s1Of(null)?.notApplicable?.reason), /primitive/, 'primitive exemption carries an explicit reason')

  // exemption is scoped to the skill module only
  assert.equal(resolveCriteria('short_task', 'system').items.find((i) => i.id === 's1'), undefined, 'no s1 outside skill module')
})
