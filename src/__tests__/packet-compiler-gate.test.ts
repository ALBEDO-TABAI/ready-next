/**
 * EP3-PK2 — dispatch compiler gate + tree validation: the threshold is
 * CODE (direct_answer/short_task NEVER packetized, multi_step/research
 * need multiple targets); a fake-LLM packet tree is validated whole-or-
 * nothing; the parent aggregation criteria are a fixed code template.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decidePacketCompilation,
  parseCompiledPacketTree,
  buildAggregationCriteria,
  buildCompilePacketsPrompt,
  MAX_CHILD_PACKETS,
} from '../main/modules/agent-control/quality/packet-compiler'
import { TASK_TYPES } from '../shared/task-types'

test('threshold matrix: only multi_step_task/research with ≥2 targets compile; direct_answer NEVER', () => {
  const expectations: Record<string, boolean> = {
    multi_step_task: true,
    research: true,
    direct_answer: false,
    short_task: false,
    media_task: false,
    browser_transaction: false,
    continuation: false,
  }
  assert.deepEqual(Object.keys(expectations).sort(), [...TASK_TYPES].sort(), 'matrix covers every task type')
  for (const taskType of TASK_TYPES) {
    const multi = decidePacketCompilation({ taskType, targetCount: 3 })
    assert.equal(
      multi.decision,
      expectations[taskType] ? 'compile' : 'skip',
      `${taskType} with 3 targets → ${expectations[taskType] ? 'compile' : 'skip'} (${multi.reason})`,
    )
    const single = decidePacketCompilation({ taskType, targetCount: 1 })
    assert.equal(single.decision, 'skip', `${taskType} single target never compiles`)
  }
  // 一包都嫌多: no target count rescues direct_answer/short_task
  assert.equal(decidePacketCompilation({ taskType: 'direct_answer', targetCount: 10 }).decision, 'skip')
  assert.match(decidePacketCompilation({ taskType: 'direct_answer', targetCount: 10 }).reason, /never_packetized/)
  assert.equal(decidePacketCompilation({ taskType: 'short_task', targetCount: 10 }).decision, 'skip')
  assert.equal(decidePacketCompilation({ taskType: 'multi_step_task', targetCount: NaN }).decision, 'skip')
})

test('fake-LLM legal tree passes; parent criteria come from the fixed code template', () => {
  const raw = JSON.stringify({
    parentTitle: '三平台行情汇总',
    children: [
      { title: '小红书采集', deliverable: '采集结果文件', contextRefs: ['card:xhs-script-detection'] },
      { title: '微博采集', deliverable: '采集结果文件', contextRefs: [] },
      { title: '汇总报告', deliverable: '对比报告 markdown', contextRefs: ['packet:parent'] },
    ],
  })
  const result = parseCompiledPacketTree(raw)
  assert.ok(result.ok, `legal tree accepted: ${result.ok ? '' : result.reason}`)
  if (result.ok) {
    assert.equal(result.tree.children.length, 3)
    assert.equal(result.tree.children[0].contextRefs[0], 'card:xhs-script-detection')
  }
  // code-fenced output is tolerated
  assert.ok(parseCompiledPacketTree('```json\n' + raw + '\n```').ok)

  const criteria = buildAggregationCriteria()
  assert.deepEqual(criteria.map((entry) => entry.id), ['c1', 'c2', 'c3'])
  assert.ok(criteria.every((entry) => entry.source === 'template'), '验收权与执行权分离：判据是代码模板')
  assert.match(criteria[0].text, /Check-in/)
  assert.match(criteria[1].text, /proof/)
})

test('bad trees are rejected WHOLE — never partially applied', () => {
  const child = (over: Record<string, unknown> = {}) =>
    ({ title: '子包', deliverable: '产出', contextRefs: [], ...over })
  const tree = (over: Record<string, unknown>) =>
    JSON.stringify({ parentTitle: '父包', children: [child()], ...over })

  const cases: Array<[string, string, RegExp]> = [
    ['prose', '我觉得拆三个包比较好', /not_json/],
    ['array root', '[]', /not_an_object/],
    ['missing parent title', tree({ parentTitle: '' }), /missing_parent_title/],
    ['zero children', tree({ children: [] }), /no_children/],
    ['five children', tree({ children: Array.from({ length: MAX_CHILD_PACKETS + 1 }, () => child()) }), /too_many_children/],
    ['coordination packet (no deliverable)', tree({ children: [child({ deliverable: '' })] }), /missing_deliverable.*协调包非法/],
    ['nested children', tree({ children: [child({ children: [child()] })] }), /nested_children/],
    ['retelling ref', tree({ children: [child({ contextRefs: ['转'.repeat(301)] })] }), /child_refs_invalid/],
    ['one bad child kills the tree', tree({ children: [child(), child({ deliverable: '' })] }), /missing_deliverable/],
  ]
  for (const [label, raw, pattern] of cases) {
    const result = parseCompiledPacketTree(raw)
    assert.equal(result.ok, false, `${label} rejected`)
    if (!result.ok) assert.match(result.reason, pattern, `${label} reason carries the cause`)
  }
})

test('compile prompt carries the verbatim request, the knowledge index, and the discipline', () => {
  const prompt = buildCompilePacketsPrompt({
    request: '同时盯三个平台的行情并出对比报告 REQ_MARKER',
    knowledgeIndex: '- 小红书风控严格 INDEX_MARKER',
  })
  assert.ok(prompt.includes('REQ_MARKER'), 'user request injected verbatim')
  assert.ok(prompt.includes('INDEX_MARKER'), 'knowledge index injected')
  assert.ok(prompt.includes('一包') && prompt.includes('交付物'), 'one-deliverable discipline present')
  assert.ok(prompt.includes('引用'), 'refs-not-retellings discipline present')
  const empty = buildCompilePacketsPrompt({ request: 'r', knowledgeIndex: '' })
  assert.ok(!empty.includes('{{knowledge_index}}'), 'empty index still substitutes the variable')
})
