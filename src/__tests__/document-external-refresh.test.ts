import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isPathWithinChangedDirectory,
  isReloadableTextDocumentPath,
  shouldRefreshDocumentTabForDirectoryChange,
} from '../renderer/modules/document/documentExternalRefresh'

test('document external refresh targets clean markdown tabs under changed directories', () => {
  assert.equal(isReloadableTextDocumentPath('/workspace/out/文案分析报告.md'), true)
  assert.equal(isReloadableTextDocumentPath('/workspace/out/video.mp4'), false)

  assert.equal(
    shouldRefreshDocumentTabForDirectoryChange(
      { path: '/workspace/out/文案分析报告.md', isDirty: false },
      ['/workspace/out'],
    ),
    true,
  )
  assert.equal(
    shouldRefreshDocumentTabForDirectoryChange(
      { path: '/workspace/out/文案分析报告.md', isDirty: true },
      ['/workspace/out'],
    ),
    false,
  )
  assert.equal(
    shouldRefreshDocumentTabForDirectoryChange(
      { path: '/workspace/other/文案分析报告.md', isDirty: false },
      ['/workspace/out'],
    ),
    false,
  )
})

test('document external refresh path matching handles Windows separators', () => {
  assert.equal(
    isPathWithinChangedDirectory('C:\\workspace\\out\\文案分析报告.md', 'C:\\workspace\\out'),
    true,
  )
  assert.equal(
    isPathWithinChangedDirectory('C:\\workspace\\outside\\文案分析报告.md', 'C:\\workspace\\out'),
    false,
  )
})
