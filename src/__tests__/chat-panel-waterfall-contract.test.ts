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
  assert.match(chatPanel, /type ChatPanelState = 'expanding' \| 'expanded' \| 'collapsing' \| 'collapsed'/)
  assert.match(chatPanel, /interface ChatPanelProps \{[\s\S]*shellWidth: number[\s\S]*panelState: ChatPanelState[\s\S]*\}/)
  assert.match(chatPanel, /const STREAM_EASE = \[0\.22, 1, 0\.36, 1\] as const/)
  assert.match(chatPanel, /const HEADER_STREAM_DURATION = 0\.22/)
  assert.match(chatPanel, /const CONTENT_STREAM_DURATION = 0\.26/)
  assert.match(chatPanel, /const REDUCED_STREAM_DURATION = 0\.12/)
  assert.match(chatPanel, /const HEADER_STREAM_OFFSET = 18/)
  assert.match(chatPanel, /const CONTENT_STREAM_OFFSET = 26/)
  assert.match(chatPanel, /className="relative overflow-visible"/)
  assert.match(chatPanel, /zIndex:\s*4/)
  assert.match(chatPanel, /className="relative min-h-0 overflow-hidden"/)
  assert.match(chatPanel, /zIndex:\s*1/)
  assert.match(chatPanel, /motionState: 'enter' \| 'idle' \| 'exit'/)
  assert.match(chatPanel, /const isExiting = motionState === 'exit'/)
  assert.match(chatPanel, /initial=\{\s*reduceMotion\s*\?\s*false\s*:\s*\{\s*y:\s*HEADER_STREAM_OFFSET,\s*opacity:\s*0\.01,\s*clipPath:\s*'inset\(12% 0 0 0\)'\s*\}\s*\}/)
  assert.match(chatPanel, /initial=\{\s*reduceMotion\s*\?\s*false\s*:\s*\{\s*y:\s*CONTENT_STREAM_OFFSET,\s*opacity:\s*0\.01,\s*clipPath:\s*'inset\(10% 0 0 0\)'\s*\}\s*\}/)
  assert.match(chatPanel, /animate=\{\s*isExiting[\s\S]*y: -HEADER_STREAM_OFFSET[\s\S]*clipPath: 'inset\(28% 0 0 0\)'/)
  assert.match(chatPanel, /animate=\{\s*isExiting[\s\S]*y: -CONTENT_STREAM_OFFSET[\s\S]*clipPath: 'inset\(22% 0 0 0\)'/)
  assert.match(chatPanel, /pointerEvents:\s*isPresent \? 'auto' : 'none'/)
  assert.match(chatPanel, /width: shellWidth,/)
  assert.match(chatPanel, /minWidth: shellWidth,/)
  assert.match(chatPanel, /const showExpandedPanel = panelState !== 'collapsed'/)
  assert.match(chatPanel, /const motionState = panelState === 'collapsing' \? 'exit' : panelState === 'expanding' \? 'enter' : 'idle'/)
  assert.match(chatPanel, /panelState === 'collapsed' \? \(/)
  assert.doesNotMatch(chatPanel, /transition:\s*'width 260ms cubic-bezier\(0\.22, 1, 0\.36, 1\), min-width 260ms cubic-bezier\(0\.22, 1, 0\.36, 1\)'/)
  assert.doesNotMatch(chatPanel, /const \{ chatPanelVisible, chatPanelWidth, toggleChatPanel \} = useWorkspace\(\)/)
})
