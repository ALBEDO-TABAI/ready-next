import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat header keeps session-window switching and history browsing as two separate controls', () => {
  const chatHeader = readWorkspaceFile('src/renderer/components/agent/ChatHeader.tsx')

  assert.match(chatHeader, /data-chat-session-switcher="true"/)
  assert.match(chatHeader, /data-chat-session-menu="true"/)
  assert.match(chatHeader, /channelOptions\.map/)
  assert.match(chatHeader, /filteredScopes\.map/)
  assert.match(chatHeader, /History/)
  assert.doesNotMatch(chatHeader, /ios-segmented-control/)
  assert.doesNotMatch(chatHeader, /sessionSections\.map/)
})
