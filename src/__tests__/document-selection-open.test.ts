import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldHandleSelectedDocument } from '../renderer/modules/document/documentSelectionOpen'
import type { DocTab } from '../renderer/stores/useDocTabs'

const tabs: DocTab[] = [
  { id: 'active', path: '/workspace/current.md', title: 'current.md', content: '', isDirty: false },
  { id: 'other', path: '/workspace/other.md', title: 'other.md', content: '', isDirty: false },
]

test('hidden keep-alive document mode never handles file selection', () => {
  assert.equal(shouldHandleSelectedDocument({
    isActive: false,
    selectedFile: '/workspace/other.md',
    tabs,
    activeTabId: 'active',
  }), false)
})

test('a target already activated by file tree is not opened or recorded twice', () => {
  assert.equal(shouldHandleSelectedDocument({
    isActive: true,
    selectedFile: '/workspace/current.md',
    tabs,
    activeTabId: 'active',
  }), false)
})

test('selection-only document links remain actionable in the visible mode', () => {
  assert.equal(shouldHandleSelectedDocument({
    isActive: true,
    selectedFile: '/workspace/other.md',
    tabs,
    activeTabId: 'active',
  }), true)
})

test('a board remains active when file tree already prepared the selected document in background', () => {
  const boardTabs: DocTab[] = [
    { id: 'board', path: '/workspace/canvas.canvas', title: 'canvas', content: '', isDirty: false },
    tabs[1],
  ]
  assert.equal(shouldHandleSelectedDocument({
    isActive: true,
    selectedFile: '/workspace/other.md',
    tabs: boardTabs,
    activeTabId: 'board',
  }), false)
})
