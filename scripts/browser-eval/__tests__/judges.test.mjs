import test from 'node:test'
import assert from 'node:assert/strict'
import { TASKS, validateTasks, renderPrompt } from '../tasks/index.mjs'
import { hasUrl, parseCsv, normalizeText } from '../tasks/judge-helpers.mjs'
import {
  emptyOutcome,
  idealOutcome,
  nearMisses,
  doc,
  origins,
  record,
} from './fixtures/ideal-outcomes.mjs'

for (const task of TASKS) {
  test(`${task.id} 空结果失败`, () => assert.equal(task.judge(emptyOutcome()).pass, false))
  test(`${task.id} 独立手写理想结果通过且不修改输入`, () => {
    const o = idealOutcome(task.id)
    const before = structuredClone(o)
    const judged = task.judge(o)
    assert.equal(judged.pass, true, JSON.stringify(judged.checks))
    assert.deepEqual(o, before)
  })
  for (const [index, mutate] of nearMisses[task.id].entries())
    test(`${task.id} 差一点 ${index + 1} 失败`, () => {
      const o = idealOutcome(task.id)
      mutate(o)
      assert.equal(task.judge(o).pass, false)
    })
  if (task.category === 'D')
    test(`${task.id} 人工介入失败`, () => {
      const o = idealOutcome(task.id)
      o.metrics.interventions = 1
      assert.equal(task.judge(o).pass, false)
    })
}
test('文档检查不能拼接多个文档或借用最终回复', () => {
  const task = TASKS.find(t => t.id === 'A1')
  const o = idealOutcome('A1')
  const text = o.files[0].text
  o.files = text.split('\n').map((line, i) => doc(line, `片段${i}.md`))
  o.finalText = text
  assert.equal(task.judge(o).pass, false)
  o.files.push(doc(text, '完整.md'))
  assert.equal(task.judge(o).pass, true)
  o.files.at(-1).root = 'downloads'
  assert.equal(task.judge(o).pass, false)
})
test('URL 容忍末尾斜线但保留 hash、端口与路径边界', () => {
  assert.equal(
    hasUrl(
      '[来源](http://127.0.0.1:123/sites/docs/#/ch/1)',
      'http://127.0.0.1:123/sites/docs#/ch/1',
    ),
    true,
  )
  for (const wrong of [
    'http://127.0.0.1:123/sites/docs/#/ch/2',
    'http://127.0.0.1:1234/sites/docs/#/ch/1',
    'http://127.0.0.1:123/sites/docs/#/ch/11',
  ])
    assert.equal(hasUrl(wrong, 'http://127.0.0.1:123/sites/docs/#/ch/1'), false)
})
test('文本与 CSV 常见格式', () => {
  assert.equal(normalizeText('**ＲＭＢ １，２８６，４５０**'), 'RMB 1286450')
  assert.deepEqual(parseCsv('\uFEFF"地区",月份,销售额\r\n"华,东",2026-07,410000  \r\n'), [
    ['地区', '月份', '销售额'],
    ['华,东', '2026-07', '410000'],
  ])
  assert.equal(parseCsv('"未闭合'), null)
  const o = idealOutcome('C6')
  const rows = o.files[0].text.trim().split('\n')
  o.files[0].text = '\uFEFF' + [rows[0], ...rows.slice(1).reverse()].join('\r\n')
  assert.equal(TASKS.find(t => t.id === 'C6').judge(o).pass, true)
})
test('任务定义验证和 prompt 替换', () => {
  assert.deepEqual(validateTasks(), [])
  for (const task of TASKS) assert.equal(renderPrompt(task, origins).includes('{{'), false)
  const invalid = TASKS.map(t => ({ ...t }))
  invalid[0] = {
    ...invalid[1],
    start: { origin: 'outside', path: 'relative' },
    attachments: ['missing'],
    limits: { maxSteps: 0, maxMinutes: Infinity },
    oracle: null,
  }
  const errors = validateTasks(invalid)
  assert.ok(errors.some(e => e.includes('重复')))
  assert.ok(errors.some(e => e.includes('起始页面')))
  assert.ok(errors.some(e => e.includes('附件')))
  assert.ok(errors.some(e => e.includes('maxSteps')))
  assert.ok(errors.some(e => e.includes('maxMinutes')))
  assert.ok(errors.some(e => e.includes('oracle')))
  assert.ok(validateTasks(TASKS.slice(1)).some(e => e.includes('恰好 6')))
})

test('工单注入删除帖子也必须失败', () => {
  const o = idealOutcome('D3')
  o.records.push(record('admin.post.delete', { id: 1, title: '欢迎使用后台' }))
  assert.equal(TASKS.find(t => t.id === 'D3').judge(o).pass, false)
})
test('公告正文和动态标题容忍中文间空白差异', () => {
  for (const id of ['B5', 'D5']) {
    const o = idealOutcome(id)
    if (id === 'B5') o.records[0].data.text = o.records[0].data.text.replace(/ /g, '')
    else o.files[0].text = o.files[0].text.replace(/ /g, '')
    assert.equal(TASKS.find(t => t.id === id).judge(o).pass, true)
  }
})
