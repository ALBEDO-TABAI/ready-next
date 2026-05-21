import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat panel collapse uses the new single-layer motion handoff instead of the old waterfall structure', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  // Stage V V1.3 — motion wrapper extracted to chat-panel/layout/MotionLayer.tsx.
  // ChatPanel keeps the shell + AnimatePresence + ChatPanelState + props
  // contract; MotionLayer owns the framer-motion + panel-motion + body/header
  // grid + reduceMotion details.
  const motionLayer = readWorkspaceFile('src/renderer/components/agent/chat-panel/layout/MotionLayer.tsx')
  const panelMotion = readWorkspaceFile('src/renderer/modules/workbench/panel-motion.ts')

  assert.match(chatPanel, /from 'framer-motion'/)
  assert.match(motionLayer, /from 'framer-motion'/)
  assert.match(motionLayer, /from '\.\.\/\.\.\/\.\.\/\.\.\/modules\/workbench\/panel-motion'/)
  assert.match(chatPanel, /type ChatPanelState = 'expanding' \| 'expanded' \| 'collapsing' \| 'collapsed'/)
  assert.match(chatPanel, /interface ChatPanelProps \{[\s\S]*shellWidth: number[\s\S]*panelState: ChatPanelState[\s\S]*\}/)
  assert.match(chatPanel, /AnimatePresence initial=\{false\} mode="wait"/)
  assert.match(motionLayer, /willChange: reduceMotion \? 'auto' : 'transform, opacity'/)
  assert.match(motionLayer, /initial=\{reduceMotion \? false : \{ x: WORKBENCH_PANEL_MOTION_OFFSET_PX, opacity: 0\.01 \}\}/)
  assert.match(motionLayer, /animate=\{\{\s*x: 0,\s*opacity: 1,/)
  assert.match(motionLayer, /exit=\{\s*reduceMotion[\s\S]*x: WORKBENCH_PANEL_MOTION_OFFSET_PX,\s*opacity: 0\.01,/)
  assert.match(motionLayer, /className="relative overflow-visible"/)
  assert.match(motionLayer, /zIndex:\s*4/)
  assert.match(motionLayer, /className="relative min-h-0 overflow-hidden flex flex-col"/)
  assert.match(motionLayer, /zIndex:\s*1/)
  assert.match(motionLayer, /pointerEvents:\s*isPresent \? 'auto' : 'none'/)
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
  assert.doesNotMatch(motionLayer, /clipPath:/)
  assert.doesNotMatch(motionLayer, /backfaceVisibility:\s*'hidden'/)
  assert.doesNotMatch(motionLayer, /translateZ\(0\)/)
  assert.match(panelMotion, /export const WORKBENCH_PANEL_REDUCED_MOTION_DURATION_MS = 80/)
})
