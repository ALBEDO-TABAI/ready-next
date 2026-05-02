import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: settings capability runtime wiring spans main/preload/renderer surfaces
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('settings capability status is sourced from a main-process runtime snapshot instead of renderer inference', () => {
  const settingsPage = readWorkspaceFile('src/renderer/pages/Settings.tsx')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const rendererTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const agentIPC = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime.ts')

  assert.match(settingsPage, /window\.electronAPI\.agent\.getCapabilityRuntimeSnapshot\(capabilityRuntimeConfig\)/)
  assert.match(settingsPage, /capabilityRuntimeSnapshot/)
  assert.doesNotMatch(settingsPage, /const getCapabilityStatus = useCallback\(/)
  assert.doesNotMatch(
    settingsPage,
    /await refreshRuntimeSummary\(\)\s*await refreshCapabilityRuntimeSnapshot\(\)/,
  )

  assert.match(preload, /getCapabilityRuntimeSnapshot:\s*\(config\?: unknown\) => ipcRenderer\.invoke\('agent:getCapabilityRuntimeSnapshot', config\)/)
  assert.match(rendererTypes, /getCapabilityRuntimeSnapshot: \(config\?: unknown\) => Promise<IPCResponse<CapabilityRuntimeSnapshotData>>/)
  assert.match(agentIPC, /ipcMain\.handle\('agent:getCapabilityRuntimeSnapshot'/)
  assert.match(runtime, /async getCapabilityRuntimeSnapshot\(configOverride\?: AIModelConfig\)/)
})
