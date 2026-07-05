import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('document edit textarea keeps the same transparent surface treatment as its surrounding editor shell', () => {
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')
  const styles = readRendererStyles()

  assert.match(markdownEditor, /className="[^"]*w-full min-h-full resize-none border-0 bg-transparent outline-none ready-input-slot-inner"/)
  assert.match(styles, /\.ready-input-slot-inner\s*\{[\s\S]*background:\s*transparent !important;/)
  assert.match(styles, /\.ready-app-shell textarea:not\(\.ready-input-slot-inner\)/)
})
