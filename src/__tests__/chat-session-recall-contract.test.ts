import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: session recall wiring spans chat storage and IPC without a stable behavior harness
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat panel wires session recall search and attach APIs into the inline chat flow', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const chatHeader = readWorkspaceFile('src/renderer/components/agent/ChatHeader.tsx')
  const recallHook = readWorkspaceFile('src/renderer/components/agent/chat-panel/recall-state/use-channel-session-recall.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const electronTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  // 合同随实现同步（Phase C C4/C5，2026-07-05）：DirectChatEngine 退役，
  // 主进程侧 session recall 接线锚点移至 ipc-handler.ts（runtime facade →
  // session-recall-facade.ts）。
  const ipcHandler = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')

  assert.match(recallHook, /searchSessionRecall/)
  assert.match(recallHook, /listAttachedSessionRecallContexts/)
  assert.match(recallHook, /attachSessionRecallContext/)
  assert.match(recallHook, /detachSessionRecallContext/)
  assert.match(recallHook, /sessionRecallResults/)
  assert.match(recallHook, /attachedSessionRecallCapsules/)
  // 合同随实现同步（裁决项②，2026-07-05）：23d6ec9a 会话来源历史菜单合并
  // 把"可见性过滤"从 ChatPanel 的单一当前频道过滤下沉进 ChatHeader 的
  // **逐频道**过滤（语义更强）；ChatPanel 改传原始结果。不变量本体
  // （recall 命中必须按频道 scope 过滤后展示）改钉 ChatHeader。
  assert.match(chatPanel, /sessionRecallResults=\{sessionRecallResults\}/)
  assert.match(
    chatHeader,
    /sessionRecallResults\.filter\(\s*\(item\) => item\.sourceKind === channel\.sourceKind && item\.sourceId === channel\.sourceId,?\s*\)/,
  )
  assert.match(chatPanel, /attachedSessionRecallConversationIds=/)
  assert.doesNotMatch(chatPanel, /搜索旧会话/)

  assert.match(chatHeader, /placeholder="搜旧会话标题、消息、任务摘要或附件名"/)
  // 同上：map 面从原始列表移至逐频道 channelResults。
  assert.match(chatHeader, /channelResults\.map|channelResults\s*\.map/)
  assert.match(chatHeader, /onAttachSessionRecall/)

  assert.match(preload, /searchSessionRecall:/)
  assert.match(preload, /listAttachedSessionRecallContexts:/)
  assert.match(preload, /attachSessionRecallContext:/)
  assert.match(preload, /detachSessionRecallContext:/)

  assert.match(electronTypes, /searchSessionRecall:/)
  assert.match(electronTypes, /listAttachedSessionRecallContexts:/)
  assert.match(electronTypes, /attachSessionRecallContext:/)
  assert.match(electronTypes, /detachSessionRecallContext:/)

  assert.match(ipcHandler, /searchSessionRecall:\s*\(payload/)
  assert.match(ipcHandler, /listRecentSessions:\s*\(payload/)
  assert.match(ipcHandler, /getMemoryRepository:\s*\(\)/)
  assert.match(ipcHandler, /getPromptAssembly:\s*\(\)/)
})
