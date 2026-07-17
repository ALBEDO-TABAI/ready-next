import assert from 'node:assert/strict'
import test from 'node:test'

import {
  installDocumentDirectoryChangeBridge,
  resetDocumentDirectoryChangeBridgeForTests,
  subscribeDocumentDirectoryChanges,
} from '../renderer/modules/document/directoryChangeBridge'

test('one renderer IPC listener fans directory changes out to independent document and file consumers', () => {
  resetDocumentDirectoryChangeBridgeForTests()
  let ipcSubscriptions = 0
  let ipcUnsubscriptions = 0
  let emit: ((event: { paths: string[]; timestamp: number }) => void) | null = null
  const api = {
    onDirectoryChange(handler: (event: { paths: string[]; timestamp: number }) => void) {
      ipcSubscriptions += 1
      emit = handler
      return () => {
        ipcUnsubscriptions += 1
        if (emit === handler) emit = null
      }
    },
  }

  installDocumentDirectoryChangeBridge(api)
  installDocumentDirectoryChangeBridge(api)
  const documentEvents: string[][] = []
  const fileEvents: string[][] = []
  const unsubscribeDocument = subscribeDocumentDirectoryChanges((event) => documentEvents.push(event.paths))
  subscribeDocumentDirectoryChanges((event) => fileEvents.push(event.paths))

  emit?.({ paths: ['/workspace/a.md'], timestamp: 1 })
  assert.equal(ipcSubscriptions, 1)
  assert.deepEqual(documentEvents, [['/workspace/a.md']])
  assert.deepEqual(fileEvents, [['/workspace/a.md']])

  unsubscribeDocument()
  emit?.({ paths: ['/workspace/b.md'], timestamp: 2 })
  assert.deepEqual(documentEvents, [['/workspace/a.md']])
  assert.deepEqual(fileEvents, [['/workspace/a.md'], ['/workspace/b.md']])

  resetDocumentDirectoryChangeBridgeForTests()
  assert.equal(ipcUnsubscriptions, 1)
})
