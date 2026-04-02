import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat panel collapse reuses the waterfall motion structure instead of hard swapping content', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(chatPanel, /from 'framer-motion'/)
  assert.match(chatPanel, /const STREAM_EASE = \[0\.22, 1, 0\.36, 1\] as const/)
  assert.match(chatPanel, /const HEADER_STREAM_DURATION = 0\.22/)
  assert.match(chatPanel, /const CONTENT_STREAM_DURATION = 0\.26/)
  assert.match(chatPanel, /const REDUCED_STREAM_DURATION = 0\.12/)
  assert.match(chatPanel, /const HEADER_STREAM_OFFSET = 18/)
  assert.match(chatPanel, /const CONTENT_STREAM_OFFSET = 26/)
  assert.match(chatPanel, /AnimatePresence initial=\{false\} mode="wait"/)
  assert.match(chatPanel, /initial=\{\s*reduceMotion \? false : \{ y: HEADER_STREAM_OFFSET, opacity: 0\.01, clipPath: 'inset\(12% 0 0 0\)' \}\s*\}/)
  assert.match(chatPanel, /exit=\{\s*reduceMotion\s*\?\s*undefined\s*:\s*\{\s*y: -HEADER_STREAM_OFFSET,\s*opacity: 0\.01,\s*clipPath: 'inset\(28% 0 0 0\)'/)
  assert.match(chatPanel, /initial=\{\s*reduceMotion \? false : \{ y: CONTENT_STREAM_OFFSET, opacity: 0\.01, clipPath: 'inset\(10% 0 0 0\)' \}\s*\}/)
  assert.match(chatPanel, /exit=\{\s*reduceMotion\s*\?\s*undefined\s*:\s*\{\s*y: -CONTENT_STREAM_OFFSET,\s*opacity: 0\.01,\s*clipPath: 'inset\(22% 0 0 0\)'/)
  assert.match(chatPanel, /pointerEvents:\s*isPresent \? 'auto' : 'none'/)
  assert.match(chatPanel, /transition:\s*'width 260ms cubic-bezier\(0\.22, 1, 0\.36, 1\), min-width 260ms cubic-bezier\(0\.22, 1, 0\.36, 1\)'/)
  assert.match(chatPanel, /key="expanded-chat-panel"/)
  assert.match(chatPanel, /key="collapsed-chat-panel"/)
})
