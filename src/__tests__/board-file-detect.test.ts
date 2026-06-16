import assert from 'node:assert/strict'
import test from 'node:test'

import { isReadyBoardFile } from '../shared/ready-board'
import {
  getDocumentPaneDropPath,
  isDocumentPaneOpenablePath,
} from '../renderer/modules/document/documentPaneDrop'
import { isLocalHtmlFilePath } from '../renderer/modules/browser/localHtmlFileOpen'

function fakeDataTransfer(data: Record<string, string>): DataTransfer {
  return {
    types: Object.keys(data),
    files: [],
    getData: (type: string) => data[type] || '',
  } as unknown as DataTransfer
}

test('isReadyBoardFile detects only .readyboard paths', () => {
  assert.equal(isReadyBoardFile('/tmp/refs.readyboard'), true)
  assert.equal(isReadyBoardFile('/tmp/refs.READYBOARD'), true)
  assert.equal(isReadyBoardFile('/tmp/refs.board.html'), false)
  assert.equal(isReadyBoardFile('/tmp/page.html'), false)
  assert.equal(isReadyBoardFile('/tmp/board.htm'), false)
})

test('document pane accepts board files before last-extension filtering', () => {
  const path = '/tmp/references.readyboard'
  assert.equal(isDocumentPaneOpenablePath(path), true)
  assert.equal(getDocumentPaneDropPath(fakeDataTransfer({
    'application/x-ready-drag': JSON.stringify({
      type: 'file',
      path,
      name: 'references.readyboard',
      ext: 'readyboard',
      isDirectory: false,
    }),
  })), path)
})

test('plain local html remains a browser file, while readyboard does not', () => {
  assert.equal(isDocumentPaneOpenablePath('/tmp/page.html'), false)
  assert.equal(isLocalHtmlFilePath('/tmp/page.html'), true)
  assert.equal(isLocalHtmlFilePath('/tmp/references.readyboard'), false)
  assert.equal(isLocalHtmlFilePath('/tmp/references.board.html'), true)
})
