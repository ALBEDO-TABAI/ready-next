import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {

  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('settings capability status is sourced from a main-process runtime snapshot instead of renderer inference', () => {
  // 合同随实现同步：2026-07-05 Settings.tsx 面板拆分，能力快照锚点移至 settings/AISettingsPanel.tsx（双文件都扫，断言不变量不动）。
  const settingsPage = [
    readWorkspaceFile('src/renderer/pages/Settings.tsx'),
    readWorkspaceFile('src/renderer/pages/settings/AISettingsPanel.tsx'),
  ].join('\n')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const rendererTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const agentIPC = readWorkspaceFile('src/main/modules/claude-bridge/ipc/agent-runtime-group.ts')
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime-core/runtime.ts')

  assert.match(settingsPage, /window\.electronAPI\.agent\.getCapabilityRuntimeSnapshot\(capabilityRuntimeConfig\)/)
  assert.match(settingsPage, /capabilityRuntimeSnapshot/)
  assert.match(settingsPage, /刷新状态/)
  assert.match(settingsPage, /未刷新/)
  assert.doesNotMatch(settingsPage, /const getCapabilityStatus = useCallback\(/)
  assert.doesNotMatch(
    settingsPage,
    /setTimeout\(\(\) => \{\s*void refreshCapabilityRuntimeSnapshot\(\)\s*\}/,
  )
  assert.doesNotMatch(
    settingsPage,
    /await refreshRuntimeSummary\(\)\s*await refreshCapabilityRuntimeSnapshot\(\)/,
  )

  assert.match(preload, /getCapabilityRuntimeSnapshot:\s*\(config\?: unknown\) => ipcRenderer\.invoke\('agent:getCapabilityRuntimeSnapshot', config\)/)
  assert.match(rendererTypes, /getCapabilityRuntimeSnapshot: \(config\?: unknown\) => Promise<IPCResponse<CapabilityRuntimeSnapshotData>>/)
  assert.match(agentIPC, /ipcMain\.handle\('agent:getCapabilityRuntimeSnapshot'/)
  assert.match(runtime, /async getCapabilityRuntimeSnapshot\(configOverride\?: AIModelConfig\)/)
})

test('settings runtime panel does not expose the retired Claude SDK label', () => {
  // 合同随实现同步：2026-07-05 Settings.tsx 面板拆分，运行时面板内容移至 settings/AISettingsPanel.tsx（双文件都扫，doesNotMatch 不变量覆盖拆分面）。
  const settingsPage = [
    readWorkspaceFile('src/renderer/pages/Settings.tsx'),
    readWorkspaceFile('src/renderer/pages/settings/AISettingsPanel.tsx'),
  ].join('\n')
  const rendererTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime-core/runtime.ts')

  assert.doesNotMatch(settingsPage, /Claude SDK/)
  assert.doesNotMatch(rendererTypes, /claude-sdk/)
  assert.match(runtime, /orchestrator:\s*this\.orchestrator\.getRuntimeKernel\(\)/)
})
