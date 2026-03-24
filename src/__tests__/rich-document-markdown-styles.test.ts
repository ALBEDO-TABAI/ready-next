import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('rich document markdown styles', () => {
  it('keeps explicit ordered and unordered list markers in the rich surface', () => {
    const source = readWorkspaceFile('src/renderer/styles/index.css')

    assert.match(source, /\.note-preview-markdown-ul\s*\{[\s\S]*list-style-type:\s*disc;/)
    assert.match(source, /\.note-preview-markdown-ol\s*\{[\s\S]*list-style-type:\s*decimal;/)
    assert.match(source, /\.note-preview-markdown-li\s*\{[\s\S]*display:\s*list-item;/)
    assert.match(source, /\.note-preview-markdown-li > p\s*\{[\s\S]*margin:\s*0;/)
  })

  it('keeps code blocks visually aligned with the editor surface', () => {
    const source = readWorkspaceFile('src/renderer/styles/index.css')

    assert.match(source, /\.note-preview-markdown-pre\s*\{[\s\S]*border:\s*1px solid/)
    assert.match(source, /\.note-preview-markdown-pre\s*\{[\s\S]*line-height:\s*1\.6;/)
    assert.match(source, /\.note-preview-markdown-code\s*\{[\s\S]*font-family:/)
  })
})
