import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: projection bridge import path is protected as integration wiring
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('agent task projections are exposed through main IPC, preload, and renderer typings', () => {
  const ipcHandler = readWorkspaceFile('src/main/modules/claude-bridge/ipc/task-projection-group.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const rendererTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')

  assert.match(ipcHandler, /ipcMain\.handle\('agent:listTaskProjections'/)
  assert.match(ipcHandler, /ipcMain\.handle\('agent:getTaskProjection'/)
  assert.match(ipcHandler, /deps\.listTaskProjections\(scopeId\)/)
  assert.match(ipcHandler, /deps\.getTaskProjection\(taskId\)/)

  assert.match(preload, /listTaskProjections:\s*\(scopeId: string\)\s*=>\s*ipcRenderer\.invoke\('agent:listTaskProjections', \{ scopeId \}\)/)
  assert.match(preload, /getTaskProjection:\s*\(taskId: string\)\s*=>\s*ipcRenderer\.invoke\('agent:getTaskProjection', \{ taskId \}\)/)

  assert.match(rendererTypes, /type TaskProjectionRecordData\s*=/)
  assert.match(rendererTypes, /interface ScopeRunSummaryData \{[\s\S]*taskId\?: string \| null/)
  assert.match(rendererTypes, /listTaskProjections:\s*\(scopeId: string\)\s*=>\s*Promise<IPCResponse<TaskProjectionRecordData\[]>>/)
  assert.match(rendererTypes, /getTaskProjection:\s*\(taskId: string\)\s*=>\s*Promise<IPCResponse<TaskProjectionRecordData>>/)
})
