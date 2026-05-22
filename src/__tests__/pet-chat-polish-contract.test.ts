import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { buildTaskCardViewModel } from '../renderer/modules/agent/taskCardViewModel'
import {
  filterUserVisibleToolTraceEvents,
  sanitizeInternalAgentDisplayText,
} from '../renderer/modules/agent/toolTraceVisibility'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('pet-facing chat hides internal skill/tool failure details from user-visible trace cards', () => {
  const events = filterUserVisibleToolTraceEvents([
    {
      id: 'raw-json',
      kind: 'result' as const,
      text: '工具调用 {"returned":0,"degraded":false,"items":[]}',
      timestamp: new Date(),
    },
    {
      id: 'skill-failure',
      kind: 'result' as const,
      text: '工具 skill_inspect_run_state 失败: Provide outputDir',
      timestamp: new Date(),
    },
    {
      id: 'useful',
      kind: 'call' as const,
      text: '正在整理今日待办',
      timestamp: new Date(),
    },
  ])

  assert.deepEqual(events.map((event) => event.id), ['useful'])
  assert.equal(
    sanitizeInternalAgentDisplayText('Artifact not found: outputs', '正在继续处理'),
    '正在继续处理',
  )
  const vm = buildTaskCardViewModel({
    scopeId: 'scope-1',
    phase: 'tool_running',
    title: '技能执行 · lifepho',
    taskSummary: 'Artifact not found: outputs',
    updatedAt: new Date().toISOString(),
  }, undefined)
  assert.equal(vm.title, '正在处理任务')
  assert.equal(vm.summary, '正在继续处理')
})

test('chat selected text exposes direct copy and sticky-note context actions', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const chatPanelBody = readWorkspaceFile('src/renderer/components/agent/chat-panel/ChatPanelBody.tsx')
  const chatMessages = readWorkspaceFile('src/renderer/components/agent/ChatMessages.tsx')
  const contextMenu = readWorkspaceFile('src/renderer/components/layout/ContextMenu.tsx')

  assert.match(chatPanelBody, /ContextMenu/)
  assert.match(chatPanelBody, /贴到便利贴/)
  assert.match(chatPanel, /electronAPI\.pet\.pushStickyNote/)
  assert.match(chatPanel, /electronAPI\.pet\.show\(\)/)
  assert.match(chatPanel, /closest\('\[data-chat-panel-root="true"\]'\)/)
  assert.match(chatPanel, /boundary:\s*rect/)
  assert.match(chatPanelBody, /boundary=\{agentSelectionMenu\.boundary\}/)
  assert.match(chatPanelBody, /portal/)
  assert.match(chatMessages, /onAgentSelectionContextMenu/)
  assert.match(chatMessages, /window\.getSelection\(\)\?\.toString\(\)/)
  assert.match(chatMessages, /onContextMenu/)
  assert.doesNotMatch(contextMenu, /lockBrowserView/)
  assert.doesNotMatch(contextMenu, /BROWSER_OVERLAY_LOCK_EVENT/)
  assert.match(contextMenu, /createPortal/)
  assert.match(contextMenu, /boundary\?: \{ left: number; top: number; right: number; bottom: number \}/)
  assert.match(contextMenu, /const minX = Math\.max\(8, boundary\?\.left \?\? 8\)/)
  assert.match(contextMenu, /const maxX = Math\.max\(minX,/)
  assert.match(contextMenu, /glass-surface-floating ready-floating-menu/)
  assert.match(contextMenu, /ready-floating-menu-item/)
  assert.match(contextMenu, /hoveredItemId/)
  assert.match(contextMenu, /pointerEvents:\s*'auto'/)
  assert.match(contextMenu, /zIndex:\s*10000/)
  assert.match(contextMenu, /onPointerDown/)
  assert.match(contextMenu, /activateItem\(item\)/)
  assert.match(contextMenu, /onMouseDown=\{\(event\) => event\.stopPropagation\(\)\}/)
  assert.match(contextMenu, /onContextMenu=\{\(event\) => event\.stopPropagation\(\)\}/)
})

test('pet sticky notes preserve longer content and can expand inside the floating window', () => {
  const schema = readWorkspaceFile('src/main/modules/tools/schemas/pet-schemas.ts')
  const manager = readWorkspaceFile('src/main/modules/pet/pet-window-manager.ts')
  const petWindow = readWorkspaceFile('src/renderer/pages/PetWindow.tsx')
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(schema, /body:\s*z\.string\(\)\.min\(1\)\.max\(1200\)/)
  assert.match(manager, /STICKY_BODY_MAX_LENGTH\s*=\s*1200/)
  assert.match(petWindow, /expandedStickyIds/)
  assert.match(petWindow, /is-expanded/)
  assert.match(styles, /\.pet-sticky\.is-expanded\s*\{[^}]*max-height:/s)
  assert.match(styles, /\.pet-sticky\.is-expanded\s+\.pet-sticky-content span\s*\{[^}]*white-space:\s*pre-wrap/s)
  assert.match(styles, /\.pet-sticky\.is-expanded\s+\.pet-sticky-content span\s*\{[^}]*overflow-y:\s*auto/s)
})
