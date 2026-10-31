import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { mountDatabase } from './utils/database-view-fixture'
import type { DocumentImportAPI, ImportReport, ImportStatus } from '../shared/document-import'
import { ImportWizard } from '../renderer/modules/document/import/ImportWizard'
import type { SaveToPickerProps } from '../renderer/modules/document/page-ui/SaveToPicker'

const report: ImportReport = { id: 'operation', sourceName: 'source.zip', sourceHash: 'hash', counts: { pages: 2, databases: 1, rows: 1, attachments: 1 }, pages: [{ path: '首页.md', source: 'source', database: false, row: false }], issues: [{ kind: 'missing', item: '首页', message: '缺失图片' }] }
const result: ImportStatus = { id: 'operation', state: 'incomplete', done: 4, total: 4, issues: report.issues, results: [{ objectId: 'page-id', path: '/vault/导入/首页.md', database: false }] }
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(button => button.textContent === label)
  assert.ok(button, label); assert.equal(button.disabled, false)
  await act(async () => { button.click() })
}
function Picker(props: Omit<SaveToPickerProps, 'trees'>) {
  return <button onClick={() => void props.onConfirm({ title: '导入', parentObjectId: 'folder-id', operationId: 'picker' }).then(reply => { if (reply.ok) props.onCancel() })}>确认位置</button>
}

test('DB6 wizard previews before writing, forwards selected parent identity, shows gaps and opens results', async t => {
  const ui = await mountDatabase(t), calls: string[] = [], opened: string[] = []
  let finish: ((value: { ok: true; value: ImportStatus }) => void) | undefined
  const api: DocumentImportAPI = {
    choose: async kind => { calls.push(kind); return { ok: true, value: { sourceId: 'source', name: 'source.zip' } } },
    preflight: async (id, location) => { assert.equal(id, 'source'); calls.push(location ? 'target' : 'preview'); if (location) assert.equal(location.parentObjectId, 'folder-id'); return { ok: true, value: { ...report, target: location ? { title: location.title, parentPath: '/vault' } : undefined } } },
    execute: async id => { assert.equal(id, 'operation'); calls.push('execute'); return new Promise(resolve => { finish = resolve }) },
    resume: async () => ({ ok: true, value: result }), status: async () => ({ ok: true, value: { ...result, state: 'running', done: 1 } }), list: async () => ({ ok: true, value: [] }),
  }
  await ui.render(<ImportWizard api={api} Picker={Picker} onClose={() => {}} open={async id => { opened.push(id) }} />)
  await click('选择 Notion ZIP'); assert.match(ui.host.textContent!, /2 页，1 个库，1 行，1 个附件/); assert.match(ui.host.textContent!, /缺失图片/)
  assert.deepEqual(calls, ['notion', 'preview'])
  await click('选择导入位置'); await click('确认位置'); assert.match(ui.host.textContent!, /目标：\/vault\/导入/)
  await click('开始导入'); assert.match(ui.host.textContent!, /正在导入/)
  assert.deepEqual(calls, ['notion', 'preview', 'target', 'execute'])
  await act(async () => { finish!({ ok: true, value: result }) })
  assert.match(ui.host.textContent!, /有缺失/); assert.doesNotMatch(ui.host.textContent!, /导入完成，已逐项核对/)
  await click('打开页面：首页.md'); assert.deepEqual(opened, ['page-id'])
})

test('DB6 wizard blocks target conflicts and resumes persisted interrupted operations', async t => {
  const ui = await mountDatabase(t); let resumed = 0
  const api: DocumentImportAPI = { choose: async () => ({ ok: true, value: { sourceId: 's', name: 's.zip' } }), preflight: async (_id, target) => ({ ok: true, value: { ...report, target: target ? { title: '导入', parentPath: '/vault' } : undefined, issues: target ? [{ kind: 'conflict', item: '导入.md', message: '不能覆盖' }] : [] } }), execute: async () => { throw new Error('must not execute') }, resume: async () => { resumed++; return { ok: true, value: result } }, status: async () => ({ ok: true, value: result }), list: async () => ({ ok: true, value: [{ ...result, state: 'interrupted' }] }) }
  await ui.render(<ImportWizard api={api} Picker={Picker} onClose={() => {}} />)
  await click('选择 Notion ZIP'); await click('选择导入位置'); await click('确认位置')
  assert.equal([...document.querySelectorAll('button')].find(button => button.textContent === '开始导入')!.disabled, true)
  await ui.render(<ImportWizard key="restart" api={api} Picker={Picker} onClose={() => {}} />)
  await click('继续导入'); assert.equal(resumed, 1); assert.match(ui.host.textContent!, /有缺失/)
})
