import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat panel collapse uses the new single-layer motion handoff instead of the old waterfall structure', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const panelMotion = readWorkspaceFile('src/renderer/modules/workbench/panel-motion.ts')

  assert.match(chatPanel, /from 'framer-motion'/)
  assert.match(chatPanel, /from '\.\.\/\.\.\/modules\/workbench\/panel-motion'/)
  assert.match(chatPanel, /type ChatPanelState = 'expanding' \| 'expanded' \| 'collapsing' \| 'collapsed'/)
  assert.match(chatPanel, /interface ChatPanelProps \{[\s\S]*shellWidth: number[\s\S]*panelState: ChatPanelState[\s\S]*\}/)
  assert.match(chatPanel, /AnimatePresence initial=\{false\} mode="wait"/)
  assert.match(chatPanel, /willChange: reduceMotion \? 'auto' : 'transform, opacity'/)
  assert.match(chatPanel, /initial=\{\s*reduceMotion \? false : \{ x: WORKBENCH_PANEL_MOTION_OFFSET_PX, opacity: 0\.01 \}\s*\}/)
  assert.match(chatPanel, /animate=\{\{\s*x: 0,\s*opacity: 1,/)
  assert.match(chatPanel, /exit=\{\s*reduceMotion[\s\S]*x: WORKBENCH_PANEL_MOTION_OFFSET_PX,\s*opacity: 0\.01,/)
  assert.match(chatPanel, /className="relative overflow-visible"/)
  assert.match(chatPanel, /zIndex:\s*4/)
  assert.match(chatPanel, /className="relative min-h-0 overflow-hidden flex flex-col"/)
  assert.match(chatPanel, /zIndex:\s*1/)
  assert.match(chatPanel, /pointerEvents:\s*isPresent \? 'auto' : 'none'/)
  assert.match(chatPanel, /width: shellWidth,/)
  assert.match(chatPanel, /minWidth: shellWidth,/)
  assert.match(chatPanel, /const showExpandedPanel = panelState !== 'collapsed'/)
  assert.match(chatPanel, /panelState === 'collapsed' \? \(/)
  assert.doesNotMatch(chatPanel, /transition:\s*'width 260ms cubic-bezier\(0\.22, 1, 0\.36, 1\), min-width 260ms cubic-bezier\(0\.22, 1, 0\.36, 1\)'/)
  assert.doesNotMatch(chatPanel, /const \{ chatPanelVisible, chatPanelWidth, toggleChatPanel \} = useWorkspace\(\)/)
  assert.doesNotMatch(chatPanel, /HEADER_STREAM_DURATION/)
  assert.doesNotMatch(chatPanel, /CONTENT_STREAM_DURATION/)
  assert.doesNotMatch(chatPanel, /HEADER_STREAM_OFFSET/)
  assert.doesNotMatch(chatPanel, /CONTENT_STREAM_OFFSET/)
  assert.doesNotMatch(chatPanel, /clipPath:/)
  assert.doesNotMatch(chatPanel, /backfaceVisibility:\s*'hidden'/)
  assert.doesNotMatch(chatPanel, /translateZ\(0\)/)
  assert.match(panelMotion, /export const WORKBENCH_PANEL_REDUCED_MOTION_DURATION_MS = 80/)
})
