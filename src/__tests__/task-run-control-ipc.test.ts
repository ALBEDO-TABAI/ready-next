import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('task run control actions are exposed through runtime, IPC, preload, renderer types, and UI entry points', () => {
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime.ts')
  const ipcHandler = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const rendererTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const taskPanel = readWorkspaceFile('src/renderer/components/ready/TaskPanel.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(runtime, /async suspendRun\(/)
  assert.match(runtime, /async resumeRun\(/)
  assert.match(runtime, /async respondToInteraction\(/)

  assert.match(ipcHandler, /ipcMain\.handle\('agent:suspendRun'/)
  assert.match(ipcHandler, /ipcMain\.handle\('agent:resumeRun'/)
  assert.match(ipcHandler, /ipcMain\.handle\('agent:respondToInteraction'/)

  assert.match(preload, /suspendRun:\s*\(payload:\s*\{\s*scopeId: string; taskId\?: string \}\)\s*=>\s*ipcRenderer\.invoke\('agent:suspendRun', payload\)/)
  assert.match(preload, /resumeRun:\s*\(payload:\s*\{\s*scopeId: string; taskId\?: string; requestId\?: string; responseText\?: string \}\)\s*=>\s*ipcRenderer\.invoke\('agent:resumeRun', payload\)/)
  assert.match(preload, /respondToInteraction:\s*\(payload:\s*\{\s*scopeId: string; taskId\?: string; requestId\?: string; responseText: string \}\)\s*=>\s*ipcRenderer\.invoke\('agent:respondToInteraction', payload\)/)

  assert.match(rendererTypes, /suspendRun:\s*\(payload:\s*\{/)
  assert.match(rendererTypes, /resumeRun:\s*\(payload:\s*\{/)
  assert.match(rendererTypes, /respondToInteraction:\s*\(payload:\s*\{/)

  assert.match(taskPanel, /window\.electronAPI\.agent\.suspendRun\(/)
  assert.match(taskPanel, /window\.electronAPI\.agent\.resumeRun\(/)
  assert.match(taskPanel, /window\.electronAPI\.agent\.respondToInteraction\(/)
  assert.match(chatPanel, /window\.electronAPI\.agent\.suspendRun\(/)
  assert.match(chatPanel, /window\.electronAPI\.agent\.resumeRun\(/)
  assert.match(chatPanel, /window\.electronAPI\.agent\.respondToInteraction\(/)
})
