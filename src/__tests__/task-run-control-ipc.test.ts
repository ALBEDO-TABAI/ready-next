import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: task-run control IPC wiring lacks an electron-free behavior harness
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('only exact child cancellation and watchdog controls remain public', () => {
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime-core/runtime.ts')
  const runControlGroup = readWorkspaceFile('src/main/modules/claude-bridge/ipc/run-control-group.ts')
  const lifecycleGroup = readWorkspaceFile('src/main/modules/claude-bridge/ipc/agent-lifecycle-group.ts')
  const ipcHandler = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const rendererTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const agentStore = readWorkspaceFile('src/renderer/stores/useAgent.ts')
  const sendOrchestration = readWorkspaceFile('src/renderer/stores/agent-send-orchestration.ts')
  const taskPanel = readWorkspaceFile('src/renderer/components/ready/TaskPanel.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const taskInteractionHandlers = readWorkspaceFile('src/renderer/components/agent/chat-panel/task-interaction/use-task-interaction-handlers.ts')

  assert.match(runtime, /async reportInfrastructureTimeout\(/)
  for (const channel of ['listActiveChildRuns', 'cancelChildRun', 'reportInfrastructureTimeout']) {
    assert.match(runControlGroup, new RegExp(`ipcMain\\.handle\\('agent:${channel}'`))
  }
  assert.match(lifecycleGroup, /parseSendScopedRequest\(rawPayload\)/)
  assert.match(lifecycleGroup, /parseSendScopedResponse\(await deps\.sendScoped\(payload\)\)/)
  assert.match(ipcHandler, /sendScoped:\s*\(payload\)\s*=>\s*runtime!\.sendScoped\(payload\)/)

  assert.match(preload, /type SendScopedRequest/)
  assert.match(preload, /sendScoped:\s*\(payload: SendScopedRequest\)/)
  assert.match(preload, /parseSendScopedRequest\(payload\)/)
  assert.match(rendererTypes, /SendScopedRequest,/)
  assert.match(rendererTypes, /sendScoped:\s*\(payload: SendScopedRequest\)/)

  const sendStart = sendOrchestration.indexOf("window.electronAPI.agent.sendScoped({")
  const sendEnd = sendOrchestration.indexOf('if (', sendStart)
  const sendCall = sendOrchestration.slice(sendStart, sendEnd)
  assert.ok(sendStart > 0 && sendEnd > sendStart)
  assert.match(sendCall, /scopeId:\s*activeScopeId/)
  assert.match(sendCall, /requestId/)
  assert.match(sendCall, /userMessage:/)
  assert.doesNotMatch(sendCall, /agent:|continuationIntent:|deliveryMode:|workspaceRoots:/)

  assert.match(taskPanel, /window\.electronAPI\.agent\.cancelDetachedSkillTask\(/)
  assert.match(taskPanel, /window\.electronAPI\.agent\.cancelChildRun\(/)
  assert.match(chatPanel, /useTaskInteractionHandlers/)
  assert.match(taskInteractionHandlers, /window\.electronAPI\.agent\.cancelDetachedSkillTask\(/)
  assert.match(taskInteractionHandlers, /window\.electronAPI\.agent\.cancelChildRun\(/)

  for (const retired of ['suspendRun', 'resumeRun', 'respondToInteraction', 'completeHumanTakeover']) {
    for (const value of [runtime, runControlGroup, ipcHandler, preload, rendererTypes, taskPanel, taskInteractionHandlers]) {
      assert.doesNotMatch(value, new RegExp(`\\b${retired}\\b`))
    }
  }
})
test('chat conversation deletion can only enter the Codex close lifecycle', () => {
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime-core/runtime.ts')
  const scopeStore = readWorkspaceFile(
    'src/main/modules/agent-control/runtime-core/conversation-scope-store.ts'
  )
  const ipcHandler = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const rendererTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const agentStore = readWorkspaceFile('src/renderer/stores/useAgent.ts')

  assert.match(agentStore, /deleteConversation:[\s\S]*?get\(\)\.closeSession\(visibleSessionId\)/)
  for (const source of [runtime, scopeStore, ipcHandler, preload, rendererTypes]) {
    assert.doesNotMatch(source, /chat:deleteConversation|\.deleteConversation\(conversationId\)|deleteConversation\(scopeId/)
  }
})
