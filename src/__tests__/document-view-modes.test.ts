import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  getDefaultDocumentViewMode,
  getDocumentViewModeOptions,
  normalizeDocumentViewMode,
} from '../renderer/components/document/document-view-modes'

describe('document view modes', () => {
  it('uses source and rich for markdown-like documents', () => {
    const options = getDocumentViewModeOptions('/workspace/notes/today.md')

    assert.deepEqual(
      options.map((option) => option.mode),
      ['source', 'rich'],
    )
    assert.equal(getDefaultDocumentViewMode('/workspace/notes/today.md'), 'rich')
  })

  it('normalizes legacy preview requests to rich for markdown-like documents', () => {
    assert.equal(normalizeDocumentViewMode('/workspace/notes/today.md', 'preview'), 'rich')
  })

  it('keeps code and config files in raw source mode only', () => {
    const options = getDocumentViewModeOptions('/workspace/src/app.ts')

    assert.deepEqual(
      options.map((option) => option.mode),
      ['source'],
    )
    assert.equal(normalizeDocumentViewMode('/workspace/src/app.ts', 'preview'), 'source')
  })

  it('does not expose text-mode toggle options for binary documents', () => {
    const options = getDocumentViewModeOptions('/workspace/assets/cover.png')

    assert.deepEqual(options, [])
    assert.equal(getDefaultDocumentViewMode('/workspace/assets/cover.png'), 'rich')
    assert.equal(normalizeDocumentViewMode('/workspace/assets/cover.png', 'source'), 'rich')
  })
})
