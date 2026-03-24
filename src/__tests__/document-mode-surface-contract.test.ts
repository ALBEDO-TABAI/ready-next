import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('document mode source/rich surface contracts', () => {
  it('removes the standalone preview branch from text document mode', () => {
    const pageSource = readWorkspaceFile('src/renderer/pages/modes/DocumentMode.tsx')
    const editorSource = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')

    assert.doesNotMatch(pageSource, /setEditorMode\('preview'\)/)
    assert.doesNotMatch(pageSource, /previewFocusWidgetTitle/)
    assert.doesNotMatch(editorSource, /viewMode === 'preview'/)
    assert.doesNotMatch(editorSource, /NotePreview/)
  })

  it('uses a result-only rich surface and keeps widget controls in source mode', () => {
    const editorSource = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')

    assert.match(editorSource, /RichDocumentView/)
    assert.match(editorSource, /DocumentWidgetBlockCard/)
    assert.match(editorSource, /document-source-widgets/)
  })
})
