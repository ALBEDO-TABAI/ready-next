import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('document edit mode uses raw text editing while preview mode keeps rendered markdown presentation', () => {
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')

  assert.match(markdownEditor, /viewMode === 'edit'/)
  assert.match(markdownEditor, /<textarea/)
  assert.match(markdownEditor, /value=\{tab\.content\}/)
  assert.match(markdownEditor, /onChange=\{handleRawEditorChange\}/)
  assert.match(markdownEditor, /viewMode === 'preview'/)
  assert.match(markdownEditor, /<NotePreview[\s\S]*content=\{tab\.content\}/)
})

test('document edit and preview modes share reading scroll position when remounted', () => {
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')
  const documentMode = readWorkspaceFile('src/renderer/pages/modes/DocumentMode.tsx')

  assert.match(markdownEditor, /const documentScrollKey = useMemo\(\(\) => tab\.path \|\| tab\.id, \[tab\.id, tab\.path\]\)/)
  assert.match(markdownEditor, /data-ready-document-scroll-key=\{documentScrollKey\}/)

  assert.match(documentMode, /captureVisibleDocumentScrollPositions\(\)/)
  assert.match(documentMode, /restoreVisibleDocumentScrollPositions\(\)/)
  assert.match(documentMode, /useLayoutEffect\(\(\) => \{/)
  assert.match(documentMode, /onChange=\{handleEditorModeChange\}/)
  assert.match(documentMode, /\[data-ready-document-scroll-key\]/)
  assert.match(documentMode, /findCurrentScrollElement\(scope\)/)
})
