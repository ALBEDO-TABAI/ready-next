import assert from 'node:assert/strict'
import test from 'node:test'
import { saveUntitledDocTabToDirectory } from '../renderer/modules/document/untitledDocSave'
import { completeDraftSave, requestDraftSave, useDraftUI } from '../renderer/modules/document/drafts/runtime'
import { useDocTabs } from '../renderer/stores/useDocTabs'
import { readReadyRefTransfer } from '../shared/ready-ref'

test('tab drop waits for the shared picker receipt; cancellation leaves the draft intact', async () => {
  const tab = { id: 'drop', path: null, title: '新文档', content: '未保存正文', isDirty: true }
  useDocTabs.setState({ tabs: [tab], activeTabId: tab.id })
  let settled = false
  const cancelled = saveUntitledDocTabToDirectory(tab.id, '/vault/父页').then(result => { settled = true; return result })
  await Promise.resolve()
  assert.equal(settled, false, 'a drop cannot claim the file has been saved')
  assert.equal(useDraftUI.getState().saveTabId, tab.id)
  assert.equal(useDraftUI.getState().saveParentPath, '/vault/父页')
  completeDraftSave(null)
  assert.deepEqual(await cancelled, { success: false, reason: 'cancelled', error: '已取消保存，草稿已保留' })
  assert.deepEqual(useDocTabs.getState().tabs[0], tab)
  const saved = saveUntitledDocTabToDirectory(tab.id, '/vault')
  completeDraftSave('/vault/用户选的标题.md')
  assert.deepEqual(await saved, { success: true, path: '/vault/用户选的标题.md', fileName: '用户选的标题.md' })
  useDocTabs.setState({ tabs: [{ ...tab, path: '/vault/已有.md' }] })
  assert.deepEqual(await saveUntitledDocTabToDirectory(tab.id, '/vault'), { success: false, reason: 'not-untitled' })
  assert.equal(useDraftUI.getState().saveTabId, null)
})

test('a draft tab is not falsely represented as a saved page reference', () => {
  const payload = JSON.stringify({ type: 'untitled-doc-tab', tabId: 'doc-9', title: '新文档' })
  assert.equal(readReadyRefTransfer({ getData: type => type === 'application/x-ready-ref' ? payload : '' }), null)
})


test('a previous picker completion cannot close a newer save request', async () => {
  const previous = requestDraftSave('old-tab', '/vault/old')
  const previousId = useDraftUI.getState().saveRequestId
  const current = requestDraftSave('new-tab', '/vault/new')
  assert.equal(await previous, null)
  completeDraftSave('/vault/old/saved.md', previousId)
  assert.equal(useDraftUI.getState().saveTabId, 'new-tab')
  completeDraftSave(null)
  assert.equal(await current, null)
})
