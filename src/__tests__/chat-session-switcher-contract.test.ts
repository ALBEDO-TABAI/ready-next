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
  assert.match(chatHeader, /minHeight:\s*84/)
  assert.match(chatHeader, /const conversationSummary =/)
  assert.match(chatHeader, /lineHeight:\s*1\.3/)
  assert.match(chatHeader, /paddingRight:\s*4/)
  assert.match(chatHeader, /display:\s*'-webkit-box'/)
  assert.match(chatHeader, /WebkitLineClamp:\s*2/)
  assert.match(chatHeader, /WebkitBoxOrient:\s*'vertical'/)
  assert.match(chatHeader, /conversationSummary && \([\s\S]*formatTime\(conv\.updatedAt\)/)
  assert.match(chatHeader, /History/)
  assert.doesNotMatch(chatHeader, /ios-segmented-control/)
  assert.doesNotMatch(chatHeader, /filteredScopes\.map/)
  assert.doesNotMatch(chatHeader, /sessionSections\.map/)
})
