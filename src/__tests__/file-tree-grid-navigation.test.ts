import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { computeNextGridHistory } from '../renderer/components/layout/gridNavigation'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('grid navigation history appends new folders and clears stale forward entries', () => {
  const history = ['/workspace/projects', '/workspace/projects/ready']

  const next = computeNextGridHistory(history, 1, '/workspace/projects/ready/docs')

  assert.deepStrictEqual(next.entries, [
    '/workspace/projects',
    '/workspace/projects/ready',
    '/workspace/projects/ready/docs',
  ])
  assert.strictEqual(next.index, 2)
})

test('grid navigation history does not duplicate the current directory', () => {
  const next = computeNextGridHistory(['/workspace/projects'], 0, '/workspace/projects')

  assert.deepStrictEqual(next.entries, ['/workspace/projects'])
  assert.strictEqual(next.index, 0)
})

test('side panel search slot reserves its left edge for grid history buttons and keeps the search icon on the right', () => {
  const filesPanel = readWorkspaceFile('src/renderer/components/layout/FilesPanel.tsx')

  assert.match(filesPanel, /title="后退"/)
  assert.match(filesPanel, /title="前进"/)
  assert.match(filesPanel, /viewMode === 'grid'/)
  assert.match(filesPanel, /Search className="h-\[13px\] w-\[13px\][^"]*"/)
  // B13: the search field is the shared Input primitive; the icon still follows it on the right.
  assert.match(filesPanel, /<Input[\s\S]*?\/>\s*<Search/)
})
