import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('document mode switch uses pointer capture instead of global mouseup drag completion', () => {
  const source = readWorkspaceFile('src/renderer/components/document/DraggableModeSwitch.tsx')

  assert.match(source, /onPointerDown=\{handlePointerDown\}/)
  assert.match(source, /setPointerCapture/)
  assert.match(source, /releasePointerCapture/)
  assert.match(source, /onPointerMove=\{handlePointerMove\}/)
  assert.match(source, /onPointerUp=\{handlePointerUp\}/)
  assert.match(source, /onPointerCancel=\{handlePointerCancel\}/)
  assert.match(source, /onLostPointerCapture=\{handleLostPointerCapture\}/)
  assert.doesNotMatch(source, /document\.addEventListener\('mousemove'/)
  assert.doesNotMatch(source, /document\.addEventListener\('mouseup'/)
})
