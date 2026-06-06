import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compactFileTreeDeleteTargets,
  computeNextFileTreeSelection,
} from '../renderer/components/layout/fileTreeSelection'

function pathsOf(selectedPaths: ReadonlySet<string>): string[] {
  return [...selectedPaths].sort()
}

const orderedPaths = [
  '/workspace/a.md',
  '/workspace/b.md',
  '/workspace/c.md',
  '/workspace/d.md',
]

test('file tree plain click selects only the clicked file and resets the range anchor', () => {
  const next = computeNextFileTreeSelection(
    {
      selectedPaths: new Set(['/workspace/a.md', '/workspace/b.md']),
      anchorPath: '/workspace/a.md',
    },
    {
      path: '/workspace/c.md',
      orderedPaths,
    },
  )

  assert.deepStrictEqual(pathsOf(next.selectedPaths), ['/workspace/c.md'])
  assert.equal(next.anchorPath, '/workspace/c.md')
})

test('file tree command click toggles individual files without clearing the rest', () => {
  const added = computeNextFileTreeSelection(
    {
      selectedPaths: new Set(['/workspace/a.md']),
      anchorPath: '/workspace/a.md',
    },
    {
      path: '/workspace/c.md',
      orderedPaths,
      metaKey: true,
    },
  )

  assert.deepStrictEqual(pathsOf(added.selectedPaths), ['/workspace/a.md', '/workspace/c.md'])
  assert.equal(added.anchorPath, '/workspace/c.md')

  const removed = computeNextFileTreeSelection(
    {
      selectedPaths: added.selectedPaths,
      anchorPath: added.anchorPath,
    },
    {
      path: '/workspace/a.md',
      orderedPaths,
      metaKey: true,
    },
  )

  assert.deepStrictEqual(pathsOf(removed.selectedPaths), ['/workspace/c.md'])
  assert.equal(removed.anchorPath, '/workspace/a.md')
})

test('file tree shift click selects the continuous visible range from the anchor', () => {
  const next = computeNextFileTreeSelection(
    {
      selectedPaths: new Set(['/workspace/a.md']),
      anchorPath: '/workspace/a.md',
    },
    {
      path: '/workspace/c.md',
      orderedPaths,
      shiftKey: true,
    },
  )

  assert.deepStrictEqual(pathsOf(next.selectedPaths), [
    '/workspace/a.md',
    '/workspace/b.md',
    '/workspace/c.md',
  ])
  assert.equal(next.anchorPath, '/workspace/a.md')
})

test('file tree command shift click appends a visible range to the current selection', () => {
  const next = computeNextFileTreeSelection(
    {
      selectedPaths: new Set(['/workspace/d.md']),
      anchorPath: '/workspace/a.md',
    },
    {
      path: '/workspace/b.md',
      orderedPaths,
      metaKey: true,
      shiftKey: true,
    },
  )

  assert.deepStrictEqual(pathsOf(next.selectedPaths), [
    '/workspace/a.md',
    '/workspace/b.md',
    '/workspace/d.md',
  ])
  assert.equal(next.anchorPath, '/workspace/a.md')
})

test('file tree bulk delete skips descendants when an ancestor folder is selected', () => {
  const targets = compactFileTreeDeleteTargets([
    { path: '/workspace/folder/child.md', name: 'child.md' },
    { path: '/workspace/folder', name: 'folder' },
    { path: '/workspace/other.md', name: 'other.md' },
    { path: '/workspace/folder/child.md', name: 'child.md' },
  ])

  assert.deepStrictEqual(targets, [
    { path: '/workspace/folder', name: 'folder' },
    { path: '/workspace/other.md', name: 'other.md' },
  ])
})
