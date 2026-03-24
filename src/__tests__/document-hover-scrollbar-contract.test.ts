import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('document mode scroll areas keep scrollbar thumbs hidden until hover', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')
  const pdfViewer = readWorkspaceFile('src/renderer/components/document/PdfViewer.tsx')
  const imageGallery = readWorkspaceFile('src/renderer/components/document/ImageGallery.tsx')

  assert.match(styles, /\.panel-hover-scrollbar\s*\{/)
  assert.match(styles, /\.panel-hover-scrollbar:hover::-webkit-scrollbar-thumb\s*\{/)
  assert.match(markdownEditor, /panel-hover-scrollbar document-editor-surface flex-1 overflow-auto/)
  assert.match(markdownEditor, /panel-hover-scrollbar document-preview-surface flex-1 overflow-auto/)
  assert.match(pdfViewer, /panel-hover-scrollbar flex-1 overflow-auto/)
  assert.match(imageGallery, /panel-hover-scrollbar flex-1 flex items-center justify-center overflow-auto/)
})
