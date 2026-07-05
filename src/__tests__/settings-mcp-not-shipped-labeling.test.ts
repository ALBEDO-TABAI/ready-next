import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- Phase M 管理面验收：Settings 页是 Zustand + Electron IPC 耦合的大型 React 组件，node-test 无 JSDOM harness；沿用 settings-ai-layout-contract.test.ts 的同一豁免。
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

// 合同随实现同步（2026-07-05 Phase M 管理面）：stdio transport 已实装并带
// 设置页真管理面，本文件从"not shipped 占位钉"整体重锚为"管理面已通电钉"。
// 原 Y0.7 §11.0b 占位合同（MCP 暂未发布 / 控件全禁用）随占位面板一并退役。

test('settings mcp section is a live management panel (not-shipped placeholder retired)', () => {
  const settingsPage = [
    readWorkspaceFile('src/renderer/pages/Settings.tsx'),
    readWorkspaceFile('src/renderer/pages/settings/McpSettingsPanel.tsx'),
  ].join('\n')

  // Section is registered in settingsData with id "mcp" + Plug2 icon
  assert.match(settingsPage, /id: 'mcp'/)
  assert.match(settingsPage, /icon:\s*Plug2/)

  // Sidebar description advertises the shipped stdio integration
  assert.match(settingsPage, /接入外部 MCP server（stdio）/)

  // McpSettingsPanel exists and stays wired into the render switch
  assert.match(settingsPage, /function McpSettingsPanel\(\)/)
  assert.match(settingsPage, /currentSection\.id === 'mcp' && <McpSettingsPanel \/>/)
  assert.match(settingsPage, /\['ai', 'remote-im', 'external-services', 'mcp',/)

  // The not-shipped framing is fully gone (both CN and EN variants)
  assert.doesNotMatch(settingsPage, /MCP 暂未发布/)
  assert.doesNotMatch(settingsPage, /not shipped in this release/)
  assert.doesNotMatch(settingsPage, /Stage Z roadmap/)
  assert.doesNotMatch(settingsPage, /（不可用）/)
})

test('settings mcp management panel wires status, config save and reload through the preload API', () => {
  const panel = readWorkspaceFile('src/renderer/pages/settings/McpSettingsPanel.tsx')

  // Live controls with stable data attributes
  assert.match(panel, /data-mcp-control="refresh-status"/)
  assert.match(panel, /data-mcp-control="config-editor"/)
  assert.match(panel, /data-mcp-control="save-config"/)
  assert.match(panel, /data-mcp-control="save-and-reload"/)

  // All three preload API members are consumed
  assert.match(panel, /window\.electronAPI\?\.mcp/)
  assert.match(panel, /api\.getStatus\(\)/)
  assert.match(panel, /api\.saveConfig\(configDraft\)/)
  assert.match(panel, /api\.reload\(\)/)

  // Per-server status rendering (connection dot + tool count + error)
  assert.match(panel, /data-mcp-server=\{server\.serverId\}/)
  assert.match(panel, /server\.toolCount/)
  assert.match(panel, /server\.lastError/)

  // Invalid config entries are surfaced with reasons, never silently dropped
  assert.match(panel, /skipped/)
})

test('mcp ipc group registers status/saveConfig/reload with symmetric dispose', () => {
  const group = readWorkspaceFile('src/main/modules/claude-bridge/ipc/mcp-group.ts')
  assert.match(group, /ipcMain\.handle\('mcp:status'/)
  assert.match(group, /ipcMain\.handle\('mcp:saveConfig'/)
  assert.match(group, /ipcMain\.handle\('mcp:reload'/)
  assert.match(group, /removeHandler\(channel\)/)

  const preload = readWorkspaceFile('src/preload/index.ts')
  assert.match(preload, /getStatus: \(\) => ipcRenderer\.invoke\('mcp:status'\)/)
  assert.match(preload, /saveConfig: \(json: string\) => ipcRenderer\.invoke\('mcp:saveConfig', \{ json \}\)/)
  assert.match(preload, /reload: \(\) => ipcRenderer\.invoke\('mcp:reload'\)/)
})
