import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat history menu reserves scrollbar space and forces long conversation labels to truncate inside the content column', () => {
  const chatHeader = readWorkspaceFile('src/renderer/components/agent/ChatHeader.tsx')

  assert.match(chatHeader, /className="panel-hover-scrollbar flex flex-col"/)
  assert.match(chatHeader, /scrollbarGutter:\s*'stable'/)
  assert.match(chatHeader, /padding:\s*'2px 12px 0'/)
  assert.match(chatHeader, /justifyContent:\s*'flex-start'/)
  assert.match(chatHeader, /gridTemplateColumns:\s*'minmax\(0,\s*1fr\)\s+auto'/)
  assert.match(chatHeader, /overflow:\s*'hidden'/)
  assert.match(chatHeader, /width:\s*'100%'/)
  assert.match(chatHeader, /maxWidth:\s*'100%'/)
})
