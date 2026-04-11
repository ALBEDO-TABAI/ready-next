import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat input does not submit on Enter while input method composition is active', () => {
  const source = readWorkspaceFile('src/renderer/components/agent/ChatInput.tsx')

  assert.match(source, /e\.key === 'Enter' && !e\.shiftKey/)
  assert.match(source, /e\.nativeEvent\.isComposing|e\.isComposing/)
  assert.match(source, /nativeKeyCode === 229|nativeWhich === 229|keyCode\s*===\s*229|which\s*===\s*229/)
  assert.match(source, /onCompositionStart=/)
  assert.match(source, /onCompositionEnd=/)
})
