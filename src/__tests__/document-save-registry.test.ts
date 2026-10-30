import assert from 'node:assert/strict'
import test from 'node:test'

import {
  registerDocumentSaveHandler,
  resetDocumentSaveRegistryForTests,
  runRegisteredDocumentSave,
} from '../renderer/modules/document/documentSaveRegistry'
import { saveDocumentTabSnapshot } from '../renderer/modules/document/documentSaveRuntime'

test('document save registry dispatches only the requested tab owner', async () => {
  resetDocumentSaveRegistryForTests()
  const saved: string[] = []
  const unregisterLeft = registerDocumentSaveHandler('left', () => { saved.push('left') })
  const unregisterRight = registerDocumentSaveHandler('right', () => { saved.push('right') })

  assert.equal(await runRegisteredDocumentSave('right'), true)
  assert.deepEqual(saved, ['right'])
  unregisterRight()
  assert.equal(await runRegisteredDocumentSave('right'), false)
  unregisterLeft()
  resetDocumentSaveRegistryForTests()
})

test('document save commits only the snapshot written and preserves newer typing', async () => {
  let releaseWrite: (() => void) | null = null
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
  let currentContent = 'snapshot'
  let dirty = true
  const save = saveDocumentTabSnapshot({
    tab: { id: 'doc', path: '/tmp/doc.md', title: 'doc.md', content: currentContent },
    api: {
      writeFile: async () => {
        await writeGate
        return { success: true }
      },
      saveFileAs: async () => ({ success: false }),
    },
    setTabPath: () => undefined,
    renameTab: () => undefined,
    commitTabSaveSnapshot: (_id, expectedContent) => {
      if (currentContent !== expectedContent) return false
      dirty = false
      return true
    },
  })

  currentContent = 'newer typing'
  releaseWrite?.()
  assert.deepEqual(await save, { status: 'stale', path: '/tmp/doc.md' })
  assert.equal(dirty, true)
})

test('untitled document opens the finalize dialog; disk failures remain visible', async () => {
  const { useDraftUI } = await import('../renderer/modules/document/drafts/runtime')
  let writes = 0
  const saved = await saveDocumentTabSnapshot({
    tab: { id: 'draft', path: null, title: 'Draft.md', content: '# Draft' },
    api: { writeFile: async () => { writes++; return { success: false } }, saveFileAs: async () => { writes++; return { success: false } } },
    setTabPath: () => assert.fail('must await finalize'), renameTab: () => assert.fail('must await finalize'),
    commitTabSaveSnapshot: () => assert.fail('must await finalize'),
  })
  assert.equal(saved.status, 'cancelled')
  assert.equal(useDraftUI.getState().saveTabId, 'draft')
  assert.equal(writes, 0)

  const failed = await saveDocumentTabSnapshot({
    tab: { id: 'doc', path: '/tmp/doc.md', title: 'doc.md', content: 'body' },
    api: {
      writeFile: async () => ({ success: false, error: 'disk full' }),
      saveFileAs: async () => ({ success: false }),
    },
    setTabPath: () => undefined,
    renameTab: () => undefined,
    commitTabSaveSnapshot: () => false,
  })
  assert.deepEqual(failed, { status: 'error', error: 'disk full' })
})
