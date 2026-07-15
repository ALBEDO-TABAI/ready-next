import assert from 'node:assert/strict'
import test from 'node:test'

import {
  readFileEmergenceDocumentStateSignature,
  readFileEmergenceProjectContextSignature,
  selectFileEmergenceDocumentStateSignature,
  selectFileEmergenceProjectContextSignature,
} from '../renderer/modules/file-emergence/fileEmergenceTabContext'

function makeState() {
  return {
    tabs: [
      {
        id: 'doc-1',
        path: '/workspace/launch/brief.md',
        title: 'brief',
        content: 'large document body',
        isDirty: false,
        lastActivatedAt: 100,
        groupId: 'group-1',
      },
      {
        id: 'doc-2',
        path: '/workspace/launch/notes.md',
        title: 'notes',
        content: 'notes body',
        isDirty: false,
        lastActivatedAt: 90,
        groupId: 'group-1',
      },
    ],
    tabGroups: [{ id: 'group-1', name: ' Launch ' }],
    activeTabId: 'doc-1',
    splitTabId: null,
  }
}

test('file emergence project signature ignores document bodies and transient tab state', () => {
  const state = makeState()
  const initial = selectFileEmergenceProjectContextSignature(state)

  const transientChange = {
    ...state,
    tabs: state.tabs.map((tab, index) => index === 0
      ? { ...tab, content: 'completely different body', isDirty: true, lastActivatedAt: 999 }
      : tab),
    activeTabId: 'doc-2',
    splitTabId: 'doc-1',
  }

  assert.equal(selectFileEmergenceProjectContextSignature(transientChange), initial)
  assert.deepEqual(readFileEmergenceProjectContextSignature(initial), {
    tabGroups: [{
      name: 'Launch',
      paths: ['/workspace/launch/brief.md', '/workspace/launch/notes.md'],
    }],
  })
})

test('file emergence project signature changes when structural context changes', () => {
  const state = makeState()
  const initial = selectFileEmergenceProjectContextSignature(state)
  const renamed = {
    ...state,
    tabGroups: [{ id: 'group-1', name: 'Release' }],
  }
  const moved = {
    ...state,
    tabs: state.tabs.map((tab, index) => index === 0
      ? { ...tab, path: '/workspace/release/brief.md' }
      : tab),
  }

  assert.notEqual(selectFileEmergenceProjectContextSignature(renamed), initial)
  assert.notEqual(selectFileEmergenceProjectContextSignature(moved), initial)
})

test('file emergence document state excludes document bodies but keeps view metadata', () => {
  const state = makeState()
  const initial = selectFileEmergenceDocumentStateSignature(state)
  const bodyOnly = {
    ...state,
    tabs: state.tabs.map((tab, index) => index === 0 ? { ...tab, content: 'new body' } : tab),
  }
  const activated = { ...bodyOnly, activeTabId: 'doc-2' }

  assert.equal(selectFileEmergenceDocumentStateSignature(bodyOnly), initial)
  assert.notEqual(selectFileEmergenceDocumentStateSignature(activated), initial)
  assert.equal(readFileEmergenceDocumentStateSignature(initial).tabs[0]?.lastActivatedAt, 100)
})
