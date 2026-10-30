import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { Database } from '../renderer/modules/document/database/Database'
import { definition, memoryAPI } from './utils/database-memory-fixture'
import { mountDatabase, input, click, drop } from './utils/database-view-fixture'


test('DB-B seven real views edit through the service; board/date drops change only their field', async t => {
  const f = memoryAPI(), ui = await mountDatabase(t)
  for (const view of definition.views) {
    await ui.render(<Database databaseId="db" initialViewId={view.id} api={f.api} key={view.id} />)
    assert.equal(ui.host.querySelector('[data-view-type]')?.getAttribute('data-view-type'), view.type, ui.host.textContent ?? '')
    await click(ui, '[data-row-id="row-0"] [data-field-id="text"]')
    await input(ui, '[aria-label="字段值"]', view.id)
    await click(ui, '[aria-label="保存单元格"]')
    assert.deepEqual(f.calls.filter(c => c.type === 'setFields').at(-1), { type: 'setFields', databaseId: 'db', rowId: 'row-0', expectedVersion: f.rows[0].version.slice(0, -1), set: { text: view.id } })
    if (view.type === 'board') {
      await drop(ui, '[data-row-id="row-0"]', '[data-group="完成"]')
      assert.deepEqual(f.calls.filter(c => c.type === 'setFields').at(-1)?.set, { status: '完成' })
    }
    if (view.type === 'calendar' || view.type === 'timeline') {
      await input(ui, '[aria-label="显示月份"]', '2026-10')
      await drop(ui, '[data-row-id="row-0"]', '[data-date="2026-10-20"]')
      assert.deepEqual(f.calls.filter(c => c.type === 'setFields').at(-1)?.set, { date: { start: '2026-10-20', end: '2026-10-22' } })
    }
    await click(ui, '[aria-label="新建行"]')
    await input(ui, '[aria-label="页面标题"]', `新建-${view.id}`)
    await click(ui, '[aria-label="确认新建"]')
    assert.equal(f.calls.filter(c => c.type === 'createRow').at(-1)?.title, `新建-${view.id}`)
  }
})

test('DB-B view settings persist in the definition; personal state never writes the definition', async t => {
  const f = memoryAPI(), ui = await mountDatabase(t)
  await ui.render(<Database databaseId="db" api={f.api} />)
  await click(ui, '[aria-label="视图设置"]')
  await click(ui, '[aria-label="添加筛选"]')
  await input(ui, '[aria-label="筛选字段 1"]', 'score')
  await input(ui, '[aria-label="筛选条件 1"]', 'gte')
  await input(ui, '[aria-label="筛选值 1"]', '2')
  await click(ui, '[aria-label="添加排序"]')
  await input(ui, '[aria-label="排序字段 1"]', 'score')
  await input(ui, '[aria-label="排序方向 1"]', 'desc')
  await input(ui, '[aria-label="分组字段"]', 'status')
  await click(ui, '[aria-label="添加列计算"]')
  await input(ui, '[aria-label="计算字段 1"]', 'score')
  await input(ui, '[aria-label="计算方式 1"]', 'sum')
  await click(ui, '[aria-label="保存视图设置"]')
  const request = f.calls.findLast(c => c.type === 'setDefinition')
  assert.ok(request && request.type === 'setDefinition')
  assert.deepEqual(request.definition.views[0].filters, [{ field: 'score', operator: 'gte', value: 2 }])
  assert.deepEqual(request.definition.views[0].sorts, [{ field: 'score', direction: 'desc' }])
  assert.equal(request.definition.views[0].groupBy, 'status')
  assert.deepEqual(request.definition.views[0].calculations, [{ field: 'score', operation: 'sum' }])
  assert.equal(ui.host.querySelector('[data-row-id="row-0"]'), null)
  assert.ok(ui.host.querySelector('[data-row-id="row-1"]'))
  const count = f.calls.filter(c => c.type === 'setDefinition').length
  await click(ui, '[data-view-id="list"]')
  assert.equal(f.calls.filter(c => c.type === 'setDefinition').length, count)
  assert.equal(f.calls.findLast(c => c.type === 'setState')?.state.currentViewId, 'list')
})

test('DB-B typed editors, readonly formula, multi-select drag preserves other options, date timezone preserved', async t => {
  const f = memoryAPI(), ui = await mountDatabase(t)
  await ui.render(<Database databaseId="db" api={f.api} />)
  for (const [field, value, expected] of [['score', '0', 0], ['url', 'https://example.com/', 'https://example.com/'], ['status', '完成', '完成']] as const) {
    await click(ui, `[data-row-id="row-0"] [data-field-id="${field}"]`)
    await input(ui, '[aria-label="字段值"]', value); await click(ui, '[aria-label="保存单元格"]')
    assert.deepEqual(f.calls.findLast(c => c.type === 'setFields')?.set, { [field]: expected })
  }
  assert.equal(ui.host.querySelector('[data-row-id="row-0"] [data-field-id="formula"]')?.getAttribute('aria-readonly'), 'true')
  await click(ui, '[data-row-id="row-0"] [data-field-id="check"]'); await click(ui, '[aria-label="字段值"]'); await click(ui, '[aria-label="保存单元格"]')
  assert.deepEqual(f.calls.findLast(c => c.type === 'setFields')?.set, { check: true })
  await click(ui, '[data-row-id="row-0"] [data-field-id="tags"]'); await click(ui, '.rdb-options label:nth-child(3) input'); await click(ui, '[aria-label="保存单元格"]')
  assert.deepEqual(f.calls.findLast(c => c.type === 'setFields')?.set, { tags: ['甲', '乙', '丙'] })
  await click(ui, '[data-row-id="row-0"] [data-field-id="relation"]'); await click(ui, '.rdb-options input'); await click(ui, '[aria-label="保存单元格"]')
  assert.deepEqual(f.calls.findLast(c => c.type === 'setFields')?.set, { relation: ['[[目标页]]'] })
  await click(ui, '[data-row-id="row-0"] [data-field-id="date"]')
  await input(ui, '[aria-label="开始日期"]', '2026-10-15T23:30:00+09:00'); await input(ui, '[aria-label="结束日期"]', '2026-10-17T23:30:00+09:00'); await click(ui, '[aria-label="保存单元格"]')
  await click(ui, '[data-view-id="calendar"]'); await input(ui, '[aria-label="显示月份"]', '2026-10'); await drop(ui, '[data-row-id="row-0"]', '[data-date="2026-10-20"]')
  assert.deepEqual(f.calls.findLast(c => c.type === 'setFields')?.set, { date: { start: '2026-10-20T23:30:00+09:00', end: '2026-10-22T23:30:00+09:00' } })
  await click(ui, '[data-view-id="board"]'); await click(ui, '[aria-label="视图设置"]'); await input(ui, '[aria-label="分组字段"]', 'tags'); await click(ui, '[aria-label="保存视图设置"]')
  await drop(ui, '[data-group="甲"] [data-row-id="row-0"]', '[data-group="丙"]')
  assert.deepEqual(f.calls.findLast(c => c.type === 'setFields')?.set, { tags: ['乙', '丙'] })
})

test('DB-B a failed create retries the same operation; rejected writes remain errors', async t => {
  const f = memoryAPI(), ui = await mountDatabase(t)
  const original = f.api.request
  let rejected = false
  const attempts: string[] = []
  f.api.request = async request => {
    if (request.type === 'createRow') {
      attempts.push(request.operationId)
      if (!rejected) { rejected = true; return { ok: false, code: 'write_failed', message: '磁盘写入失败' } }
    }
    return original(request)
  }
  await ui.render(<Database databaseId="db" api={f.api} />)
  await click(ui, '[aria-label="新建行"]'); await input(ui, '[aria-label="页面标题"]', '重试页面'); await click(ui, '[aria-label="确认新建"]')
  assert.match(ui.host.querySelector('[role="alert"]')?.textContent ?? '', /磁盘写入失败/)
  await click(ui, '[aria-label="确认新建"]')
  assert.equal(attempts.length, 2); assert.equal(attempts[0], attempts[1])
  assert.equal(f.rows.filter(row => row.title === '重试页面').length, 1)
})
