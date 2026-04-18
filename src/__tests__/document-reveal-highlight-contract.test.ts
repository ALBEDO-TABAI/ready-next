import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('document reveal highlight uses a short non-glowing emphasis instead of a long paint-heavy flash', () => {
  const tiptapEditor = readWorkspaceFile('src/renderer/components/document/TiptapEditor.tsx')
  const tiptapCss = readWorkspaceFile('src/renderer/styles/tiptap.css')

  assert.match(tiptapEditor, /\}, 1000\)/)
  assert.match(tiptapCss, /\.ready-doc-reveal-highlight\s*\{[^}]*outline:\s*1px solid/)
  assert.match(tiptapCss, /\.ready-doc-reveal-highlight\s*\{[^}]*animation:\s*ready-doc-reveal-flash 1s ease-out;/)
  assert.match(tiptapCss, /@keyframes ready-doc-reveal-flash/)
  assert.doesNotMatch(tiptapCss, /\.ready-doc-reveal-highlight\s*\{[^}]*box-shadow:/)
  assert.doesNotMatch(tiptapCss, /@keyframes ready-doc-reveal-flash\s*\{[^}]*box-shadow:/)
  assert.doesNotMatch(tiptapCss, /animation:\s*ready-doc-reveal-flash 1\.6s ease-out;/)
})
