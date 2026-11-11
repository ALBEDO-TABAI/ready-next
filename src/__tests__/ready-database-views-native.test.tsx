import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { writeFileSync, readFileSync } from 'node:fs'
import { Database } from '../renderer/modules/document/database/Database'
import { InlineDatabase } from '../renderer/modules/document/database/InlineDatabase'
import { readDatabase } from '../shared/document-database'
import { applyDocumentOperation, readDocumentSource } from '../shared/document-operations'
import { databaseFixture } from './utils/database-native-fixture'
import { mountDatabase, input, click, drop } from './utils/database-view-fixture'
import { definition } from './utils/database-memory-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { installDocumentDirectoryChangeBridge, resetDocumentDirectoryChangeBridgeForTests } from '../renderer/modules/document/directoryChangeBridge'

// The view follows the disk (no 刷新 button, W3 §4.4): a test announces a write the way the directory watcher does.
function directoryChanges(t: test.TestContext) {
  let emit: ((event: { paths: string[]; timestamp: number }) => void) | null = null
  installDocumentDirectoryChangeBridge({ onDirectoryChange: handler => { emit = handler; return () => { emit = null } } })
  t.after(() => resetDocumentDirectoryChangeBridgeForTests())
  return async (path: string) => {
    await act(async () => { emit?.({ paths: [path], timestamp: Date.now() }); await new Promise(resolve => setTimeout(resolve, 450)) })
  }
}

test('DB-B native: seven real views and inline share files; edits, moves, creation, external refresh, personal state', async t => {
  if (skipIfSqliteUnavailable(t, 'M5-B real database views')) return
  const f = databaseFixture(), ui = await mountDatabase(t), changed = directoryChanges(t)
  t.after(() => f.close())
  const rowSelector = `[data-row-id="${f.ids[0]}"]`
  const original = f.read()
  for (const view of definition.views) {
    await ui.render(<Database key={view.id} databaseId={f.databaseId} api={f.api} initialViewId={view.id} />)
    if (view.type === 'calendar' || view.type === 'timeline') await input(ui, '[aria-label="显示月份"]', '2026-10')
    await click(ui, `${rowSelector} [data-field-id="text"]`)
    await input(ui, '[aria-label="字段值"]', view.id)
    await click(ui, '[aria-label="保存单元格"]')
    assert.equal(readDocumentSource(f.read()).frontmatter.文本, view.id)
    assert.ok(f.read().endsWith('正文保持\n')); assert.ok(f.read().includes('# 保留注释'))
    assert.deepEqual(readDocumentSource(f.read()).frontmatter.未知, { keep: true })
    if (view.type === 'board') {
      const before = f.read()
      await drop(ui, rowSelector, '[data-group="完成"]')
      assert.equal(f.read(), before.replace('状态: 待办', '状态: 完成'))
    }
    if (view.type === 'calendar' || view.type === 'timeline') {
      const before = readDocumentSource(f.read()).frontmatter
      await drop(ui, rowSelector, '[data-date="2026-10-20"]')
      assert.deepEqual(readDocumentSource(f.read()).frontmatter, { ...before, 日期: { start: '2026-10-20', end: '2026-10-22' } })
    }
    await click(ui, '[aria-label="新建行"]'); await input(ui, '[aria-label="页面标题"]', `新建-${view.id}`); await click(ui, '[aria-label="确认新建"]')
    assert.equal(readDocumentSource(readFileSync(`${f.root}/库/新建-${view.id}.md`, 'utf8')).body, '')
    assert.ok(f.service.read(f.databaseId).rows.some(row => row.title === `新建-${view.id}`))
    const projected = f.service.query(f.databaseId, view.id).rows.find(row => row.id === f.ids[0])!
    assert.deepEqual(projected.cells.text, { status: 'value', value: view.id })
  }
  await ui.render(<InlineDatabase target="库" viewName="table" api={f.api} />)
  assert.ok(ui.host.querySelector('.is-inline'))
  await click(ui, `${rowSelector} [data-field-id="text"]`); await input(ui, '[aria-label="字段值"]', '内联编辑'); await click(ui, '[aria-label="保存单元格"]')
  assert.equal(readDocumentSource(f.read()).frontmatter.文本, '内联编辑')
  await ui.render(<Database databaseId={f.databaseId} api={f.api} initialViewId="table" />)
  assert.equal(ui.host.querySelector(`${rowSelector} [data-field-id="text"]`)?.textContent, '内联编辑')
  writeFileSync(f.paths[0], f.read().replace('文本: 内联编辑', '文本: 外部修改'))
  await changed(f.paths[0])
  assert.equal(ui.host.querySelector(`${rowSelector} [data-field-id="text"]`)?.textContent, '外部修改')
  await click(ui, `${rowSelector} .rdb-title`); assert.equal(f.opened.at(-1), f.ids[0])
  await click(ui, '[aria-label="视图设置"]'); await input(ui, '[aria-label="分组字段"]', 'status'); await click(ui, '[aria-label="保存视图设置"]')
  assert.equal(readDatabase(readFileSync(f.databasePath, 'utf8')).views[0].groupBy, 'status')
  const beforePersonal = readFileSync(f.databasePath, 'utf8')
  await act(async () => ui.host.querySelector('[aria-label="调整列宽 text"]')!.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) })
  const personal = await f.service.request({ type: 'getState', databaseId: f.databaseId })
  assert.equal(personal.widths.text, 180)
  await click(ui, '[data-view-id="list"]')
  assert.equal(readFileSync(f.databasePath, 'utf8'), beforePersonal)
  assert.equal(JSON.parse(f.db.prepare('SELECT state_json FROM document_database_state WHERE database_id=?').get<{ state_json: string }>(f.databaseId)!.state_json).currentViewId, 'list')
  assert.equal(original.includes('分数: 1'), true)
})

test('DB-B native: stale cell conflicts; dirty receipt is visibly unsaved until actual disk readback', async t => {
  if (skipIfSqliteUnavailable(t, 'M5-B conflict and buffer')) return
  let dirty = false, buffer = ''
  const f = databaseFixture(2, async request => {
    if (!dirty) return { ok: true, tabs: [] }
    if (request.phase === 'prepare') buffer = applyDocumentOperation(buffer, request.operation)
    return { ok: true, tabs: [{ id: 'dirty-tab', path: request.path, content: buffer, isDirty: true }], content: buffer }
  }), ui = await mountDatabase(t), changed = directoryChanges(t)
  t.after(() => f.close())
  const cell = `[data-row-id="${f.ids[0]}"] [data-field-id="text"]`
  await ui.render(<Database databaseId={f.databaseId} api={f.api} />)
  await click(ui, cell); await input(ui, '[aria-label="字段值"]', '旧版本编辑')
  writeFileSync(f.paths[0], f.read().replace('文本: 原文', '文本: 外部新版本'))
  const external = f.read()
  await click(ui, '[aria-label="保存单元格"]')
  assert.match(ui.host.querySelector('.rdb-status')?.textContent ?? '', /冲突/); assert.equal(f.read(), external)
  await click(ui, '[aria-label="重新读取数据库"]')
  dirty = true; buffer = external + '未保存正文\n'
  await click(ui, cell); await input(ui, '[aria-label="字段值"]', '缓冲值'); await click(ui, '[aria-label="保存单元格"]')
  assert.match(ui.host.querySelector('.rdb-status')?.textContent ?? '', /已合入未保存缓冲/)
  assert.equal(f.read(), external); assert.match(buffer, /文本: 缓冲值/)
  assert.equal(ui.host.querySelector(cell)?.textContent, '缓冲值')
  await click(ui, '[aria-label="重新读取数据库"]'); assert.match(ui.host.querySelector('.rdb-status')?.textContent ?? '', /未保存缓冲/)
  dirty = false; writeFileSync(f.paths[0], buffer)
  await changed(f.paths[0]); assert.match(ui.host.querySelector('.rdb-status')?.textContent ?? '', /已保存/)
  assert.equal(ui.host.querySelector(cell)?.textContent, '缓冲值'); assert.ok(f.read().endsWith('未保存正文\n'))
})
