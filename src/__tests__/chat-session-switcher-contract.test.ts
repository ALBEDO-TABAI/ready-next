import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat header keeps channel switching separate while folding history browsing into the merged recall menu', () => {
  const chatHeader = readWorkspaceFile('src/renderer/components/agent/ChatHeader.tsx')

  assert.match(chatHeader, /import \{ createPortal \} from 'react-dom'/)
  assert.match(chatHeader, /data-chat-session-switcher="true"/)
  assert.match(chatHeader, /data-chat-session-menu="true"/)
  assert.match(chatHeader, /data-chat-session-title="true"/)
  assert.match(chatHeader, /data-chat-session-title="true"[\s\S]*color: 'var\(--text-body\)'/)
  assert.match(chatHeader, /title="会话来源"/)
  assert.match(chatHeader, /MessageSquare/)
  assert.doesNotMatch(chatHeader, /PanelRightClose/)
  assert.match(chatHeader, /const portalRoot = typeof document !== 'undefined' \? document.body : null/)
  assert.match(chatHeader, /createPortal\(/)
  assert.match(chatHeader, /position: 'fixed' as const/)
  assert.match(chatHeader, /channelOptions\.map/)
  assert.match(chatHeader, /sessionRecallResults\.map/)
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
  assert.match(chatHeader, /History/)
  assert.doesNotMatch(chatHeader, /ios-segmented-control/)
  assert.doesNotMatch(chatHeader, /filteredScopes\.map/)
  assert.doesNotMatch(chatHeader, /sessionSections\.map/)
})
