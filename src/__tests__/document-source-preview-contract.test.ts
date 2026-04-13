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
