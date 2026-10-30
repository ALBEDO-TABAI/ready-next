import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FILE_APPEARANCE_COLORS,
  normalizeFileAppearanceIcon,
  normalizeFileAppearanceMap,
  removeFileAppearancePath,
  withFileAppearanceColor,
  withFileAppearanceIcon,
} from '../renderer/stores/fileAppearance'

test('file appearance exposes the seven Finder-like color choices', () => {
  assert.deepEqual(
    FILE_APPEARANCE_COLORS.map((color) => color.key),
    ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'],
  )
})

test('file appearance normalizes colors and short custom icons', () => {
  const normalized = normalizeFileAppearanceMap({
    '/workspace/a.md': { color: 'red', icon: '  🎬  ' },
    '/workspace/b.md': { color: 'pink', icon: '' },
    '/workspace/c.md': { icon: 'ABCDZ' },
  })

  assert.deepEqual(normalized, {
    '/workspace/a.md': { color: 'red', icon: '🎬' },
    '/workspace/c.md': { icon: 'ABCD' },
  })
  assert.equal(normalizeFileAppearanceIcon('   '), null)
})

test('file appearance updates color and icon independently', () => {
  const withColor = withFileAppearanceColor({}, '/workspace/a.md', 'blue')
  const withIcon = withFileAppearanceIcon(withColor, '/workspace/a.md', '📁')
  const colorCleared = withFileAppearanceColor(withIcon, '/workspace/a.md', null)

  assert.deepEqual(withIcon, {
    '/workspace/a.md': { color: 'blue', icon: '📁' },
  })
  assert.deepEqual(colorCleared, {
    '/workspace/a.md': { icon: '📁' },
  })
})

test('file appearance removes the deleted folder from the file-tree projection', () => {
  assert.deepEqual(removeFileAppearancePath({
    '/workspace/folder': { color: 'green' },
    '/workspace/folder/child.md': { icon: '📝' },
    '/workspace/other.md': { color: 'gray' },
  }, '/workspace/folder'), { '/workspace/other.md': { color: 'gray' } })
})
// Object persistence and internal/external move behavior are covered by
// ready-object-presentation-renderer.test.ts through the real workspace store.
