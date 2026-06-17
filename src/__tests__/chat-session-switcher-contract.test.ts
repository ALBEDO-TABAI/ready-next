import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat header opens one source/history switcher from the title and source button', () => {
  const chatHeader = readWorkspaceFile('src/renderer/components/agent/ChatHeader.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(chatHeader, /import \{ createPortal \} from 'react-dom'/)
  assert.match(chatHeader, /data-chat-session-switcher="true"/)
  assert.match(chatHeader, /data-chat-session-menu="true"/)
  assert.match(chatHeader, /data-chat-session-title="true"/)
  assert.match(chatHeader, /data-chat-session-title="true"[\s\S]*color: 'var\(--text-body\)'/)
  assert.match(chatHeader, /data-chat-session-title="true"[\s\S]*width:\s*'100%'[\s\S]*WebkitMaskImage: 'linear-gradient\(to right, #000 calc\(100% - 28px\), transparent 100%\)'/)
  assert.match(chatHeader, /title="会话来源"/)
  assert.match(chatHeader, /MessageSquare/)
  assert.match(chatHeader, /ChevronRight/)
  assert.doesNotMatch(chatHeader, /PanelRightClose/)
  assert.match(chatHeader, /const portalRoot = typeof document !== 'undefined' \? document.body : null/)
  assert.match(chatHeader, /createPortal\(/)
  assert.match(chatHeader, /position: 'fixed' as const/)
  assert.match(chatHeader, /Both header entry points open the same source\/history switcher/)
  assert.match(chatHeader, /handleHistoryToggle\('title'\)/)
  assert.match(chatHeader, /handleHistoryToggle\('scope'\)/)
  assert.match(chatHeader, /channelOptions\.map/)
  assert.match(chatHeader, /expandedChannelKeys/)
  assert.match(chatHeader, /toggleChannelHistory\(channel\.key\)/)
  assert.match(chatHeader, /aria-expanded=\{expanded\}/)
  assert.match(chatHeader, /sessionRecallResults\.filter/)
  assert.match(chatHeader, /item\.sourceKind === channel\.sourceKind && item\.sourceId === channel\.sourceId/)
  assert.match(chatHeader, /placeholder="搜旧会话标题、消息、任务摘要或附件名"/)
  assert.match(chatHeader, /onAttachSessionRecall/)
  assert.match(chatHeader, /onLoadConversation/)
  assert.match(chatHeader, /const recallActionRailWidth = 72/)
  assert.match(chatHeader, /width:\s*recallActionRailWidth,\s*flexShrink:\s*0/)
  assert.match(chatHeader, /width:\s*44,\s*height:\s*32/)
  assert.match(chatHeader, /gap:\s*8,\s*maxHeight:\s*300,\s*overflow:\s*'auto'/)
  assert.match(chatHeader, /minHeight:\s*64/)
  assert.match(chatHeader, /const conversationSummary =/)
  assert.match(chatHeader, /lineHeight:\s*1\.3/)
  assert.match(chatHeader, /paddingRight:\s*4/)
  // The conversation summary renders as a single line that fades out on the
  // right (mask gradient) rather than wrapping/clamping to two lines.
  assert.doesNotMatch(chatHeader, /WebkitLineClamp/)
  assert.doesNotMatch(chatHeader, /WebkitBoxOrient/)
  assert.match(chatHeader, /maskImage: 'linear-gradient\(to right, #000 calc\(100% - 24px\), transparent 100%\)'/)
  // Each row carries a status dot (color-keyed) left of the title and a
  // "更多" menu (rename/delete) replacing the bare delete button.
  assert.match(chatHeader, /SESSION_DOT_COLOR\[dotStatus\]/)
  assert.match(chatHeader, /data-row-menu-trigger="true"/)
  assert.match(chatHeader, /重命名/)
  assert.match(chatHeader, /formatTime\(conv\.updatedAt\)[\s\S]*conversationSummary && \(/)
  assert.doesNotMatch(chatHeader, /showScopeSelect/)
  assert.doesNotMatch(chatHeader, /scopeMenuPosition/)
  assert.doesNotMatch(chatHeader, /boxShadow: '0 0 0 4px rgba\(255,255,255,0\.24\)'/)
  assert.match(chatPanel, /sessionRecallResults=\{sessionRecallResults\}/)
  assert.doesNotMatch(chatPanel, /sessionRecallResults=\{visibleSessionRecallResults\}/)
  assert.match(chatHeader, /History/)
  assert.doesNotMatch(chatHeader, /ios-segmented-control/)
  assert.doesNotMatch(chatHeader, /filteredScopes\.map/)
  assert.doesNotMatch(chatHeader, /sessionSections\.map/)
})

test('chat header row action menu survives history panel repositioning', () => {
  const chatHeader = readWorkspaceFile('src/renderer/components/agent/ChatHeader.tsx')

  assert.match(chatHeader, /const rowMenuTriggerRef = useRef<HTMLButtonElement \| null>\(null\)/)
  assert.match(chatHeader, /const computeRowMenuPosition = useCallback/)
  assert.match(chatHeader, /const rowTrigger = rowMenuTriggerRef\.current/)
  assert.match(chatHeader, /document\.body\.contains\(rowTrigger\)/)
  assert.match(chatHeader, /return \{ \.\.\.current, position \}/)
  assert.match(chatHeader, /const trigger = event\.currentTarget/)
  assert.match(chatHeader, /rowMenuTriggerRef\.current = trigger/)
  assert.doesNotMatch(
    chatHeader,
    /const syncMenuPositions = \(\) => \{\s*\/\/ A fixed-positioned row menu detaches from its trigger on scroll\/resize\.\s*setRowMenu\(null\)/,
  )
})
