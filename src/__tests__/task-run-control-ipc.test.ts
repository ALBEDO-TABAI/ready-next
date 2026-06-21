import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: task-run control IPC wiring lacks an electron-free behavior harness
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('task run control actions are exposed through runtime, IPC, preload, renderer types, and UI entry points', () => {
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime-core/runtime.ts')
  const runControlGroup = readWorkspaceFile('src/main/modules/claude-bridge/ipc/run-control-group.ts')
  const ipcHandler = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const rendererTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const agentStore = readWorkspaceFile('src/renderer/stores/useAgent.ts')
  const taskPanel = readWorkspaceFile('src/renderer/components/ready/TaskPanel.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const taskInteractionHandlers = readWorkspaceFile('src/renderer/components/agent/chat-panel/task-interaction/use-task-interaction-handlers.ts')

  assert.match(runtime, /async suspendRun\(/)
  assert.match(runtime, /async reportInfrastructureTimeout\(/)
  assert.match(runtime, /async resumeRun\(/)
  assert.match(runtime, /async respondToInteraction\(/)
  assert.match(runtime, /scopeRunSummary\?\.taskId/)
  assert.match(runtime, /scopeRunSummary\?\.taskContinuation\?\.taskId/)
  assert.match(runtime, /taskTitle:\s*target\.projection\?\.taskTitle/)
  assert.doesNotMatch(runtime, /taskTitle:\s*target\.projection\?\.taskId/)

  assert.match(runControlGroup, /ipcMain\.handle\('agent:suspendRun'/)
  assert.match(runControlGroup, /ipcMain\.handle\('agent:reportInfrastructureTimeout'/)
  assert.match(runControlGroup, /ipcMain\.handle\('agent:resumeRun'/)
  assert.match(runControlGroup, /ipcMain\.handle\('agent:respondToInteraction'/)

  assert.match(preload, /sendScoped:\s*\(\s*payload:\s*\{\s*scopeId: string/)
  assert.match(preload, /agent\?: string/)
  assert.match(preload, /continuationIntent\?: ContinuationIntentPayload \| null/)
  assert.match(preload, /ipcRenderer\.invoke\('agent:sendScoped', payload\)/)
  assert.match(preload, /suspendRun:\s*\(payload:\s*\{\s*scopeId: string; taskId\?: string \}\)\s*=>\s*ipcRenderer\.invoke\('agent:suspendRun', payload\)/)
  assert.match(preload, /reportInfrastructureTimeout:\s*\(payload:\s*\{\s*scopeId: string; requestId: string; elapsedMs\?: number \}\)\s*=>\s*ipcRenderer\.invoke\('agent:reportInfrastructureTimeout', payload\)/)
  assert.match(preload, /resumeRun:\s*\(payload:\s*\{/)
  assert.match(preload, /respondToInteraction:\s*\(payload:\s*\{/)
  assert.match(preload, /responseText\?: string/)
  assert.match(preload, /responseText: string/)

  assert.match(rendererTypes, /suspendRun:\s*\(payload:\s*\{/)
  assert.match(rendererTypes, /reportInfrastructureTimeout:\s*\(payload:\s*\{/)
  assert.match(rendererTypes, /resumeRun:\s*\(payload:\s*\{/)
  assert.match(rendererTypes, /respondToInteraction:\s*\(payload:\s*\{/)
  assert.match(rendererTypes, /sendScoped:\s*\(\s*payload:\s*\{/)
  assert.match(rendererTypes, /agent\?: string/)
  assert.match(rendererTypes, /continuationIntent\?: ContinuationIntentData \| null/)

  assert.match(agentStore, /pendingContinuationIntent:/)
  assert.match(agentStore, /setComposerDraft:/)
  assert.match(agentStore, /agent:\s*currentAgent/)
  assert.match(agentStore, /continuationIntent:\s*pendingContinuationIntent \|\| undefined/)
  assert.match(ipcHandler, /agent\?: string/)
  assert.match(runtime, /agent\?: string/)
  // The recoverable-scope wiring extracts agent/scopeId from the inbound
  // payload and forwards them to createLocalScope. Production now reads via
  // local arrow params (`(agent, scopeId) => this.createLocalScope(agent, scopeId)`)
  // — pin both shapes so a regression that drops the wiring still trips.
  assert.match(runtime, /this\.createLocalScope\((?:payload\.agent,\s*payload\.scopeId|agent,\s*scopeId)\)/)

  assert.match(taskPanel, /window\.electronAPI\.agent\.suspendRun\(/)
  assert.match(taskPanel, /window\.electronAPI\.agent\.resumeRun\(/)
  assert.match(taskPanel, /window\.electronAPI\.agent\.respondToInteraction\(/)
  assert.match(chatPanel, /useTaskInteractionHandlers/)
  assert.match(taskInteractionHandlers, /window\.electronAPI\.agent\.suspendRun\(/)
  assert.match(taskInteractionHandlers, /window\.electronAPI\.agent\.resumeRun\(/)
  assert.match(taskInteractionHandlers, /window\.electronAPI\.agent\.respondToInteraction\(/)
})

test('chat conversation deletion is routed through runtime cleanup before removing persisted records', () => {
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime-core/runtime.ts')
  const ipcHandler = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')

  assert.match(runtime, /deleteConversation\(scopeId: string\): void/)
  assert.match(runtime, /this\.scopeRunSummaries\.delete\(scopeId\)/)
  assert.match(runtime, /forgetSession\(scopeId\)/)
  assert.match(ipcHandler, /runtime!\.deleteConversation\(conversationId\)/)
  assert.doesNotMatch(ipcHandler, /chatRepository\.deleteConversation\(conversationId\)/)
})
