import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- Y0.7 §11.0b labeling acceptance: src/renderer/pages/Settings.tsx is a 3092-line React component coupled to Zustand + Electron IPC; no JSDOM harness for node-tests. Same waiver as settings-ai-layout-contract.test.ts.
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('settings mcp section registers "not shipped" label and inert Stage T plumbing reference', () => {
  // 合同随实现同步：2026-07-05 Settings.tsx 面板拆分，McpSettingsPanel 锚点移至 settings/McpSettingsPanel.tsx（双文件都扫，断言不变量不动）。
  const settingsPage = [
    readWorkspaceFile('src/renderer/pages/Settings.tsx'),
    readWorkspaceFile('src/renderer/pages/settings/McpSettingsPanel.tsx'),
  ].join('\n')

  // Section is registered in settingsData with id "mcp" + Plug2 icon
  assert.match(settingsPage, /id: 'mcp'/)
  assert.match(settingsPage, /icon:\s*Plug2/)
  assert.match(settingsPage, /Plug2/)

  // Section description in the sidebar advertises "not shipped" (Y0.7 §11.0b acceptance)
  assert.match(settingsPage, /本版本暂未发布 MCP transport \/ MCP not shipped in this release/)

  // McpSettingsPanel exists and is wired into the render switch
  assert.match(settingsPage, /function McpSettingsPanel\(\)/)
  assert.match(settingsPage, /currentSection\.id === 'mcp' && <McpSettingsPanel \/>/)

  // mcp is treated as a dynamic section so the generic settings-item map does not also render
  assert.match(settingsPage, /\['ai', 'remote-im', 'external-services', 'mcp',/)

  // The body of the panel shows the explicit "not shipped" headline in both CN and EN
  assert.match(settingsPage, /MCP 暂未发布 \/ MCP not shipped in this release/)
  assert.match(settingsPage, /See Stage Z roadmap for transport landing/)

  // The Stage T authorization plumbing is referenced as visibly inert (not removed)
  assert.match(settingsPage, /Stage T authorization plumbing — visibly inert/)
  assert.match(settingsPage, /src\/main\/modules\/mcp/)
  assert.match(settingsPage, /mcp-tools-authorization\.test\.ts/)
})

test('settings mcp install + configure controls are visibly disabled (no actionable install path)', () => {
  // 合同随实现同步：2026-07-05 Settings.tsx 面板拆分，McpSettingsPanel 锚点移至 settings/McpSettingsPanel.tsx（双文件都扫，断言不变量不动）。
  const settingsPage = [
    readWorkspaceFile('src/renderer/pages/Settings.tsx'),
    readWorkspaceFile('src/renderer/pages/settings/McpSettingsPanel.tsx'),
  ].join('\n')

  // The disabled placeholder card is rendered with aria-disabled and pointer-events: none
  assert.match(settingsPage, /aria-labelledby="mcp-install-disabled-heading"/)
  assert.match(settingsPage, /MCP server install \/ configure \(disabled\)/)
  assert.match(settingsPage, /pointerEvents: 'none'/)

  // Both placeholder controls carry `disabled` + `aria-disabled` and data attributes for the install + transport-configure affordances
  assert.match(settingsPage, /data-mcp-control="install-server"/)
  assert.match(settingsPage, /data-mcp-control="configure-transport"/)

  // The control labels are visibly Chinese with "（不可用）" to match the not-shipped framing
  assert.match(settingsPage, /安装 MCP server（不可用）/)
  assert.match(settingsPage, /配置 transport（不可用）/)

  // No onClick handler is wired to the placeholder install buttons (proves they are non-actionable)
  const installButtonBlock = settingsPage.match(
    /data-mcp-control="install-server"[\s\S]{0,400}?安装 MCP server（不可用）/,
  )
  assert.ok(installButtonBlock, 'install-server placeholder button must be present')
  assert.doesNotMatch(installButtonBlock[0], /onClick/)

  const configureButtonBlock = settingsPage.match(
    /data-mcp-control="configure-transport"[\s\S]{0,400}?配置 transport（不可用）/,
  )
  assert.ok(configureButtonBlock, 'configure-transport placeholder button must be present')
  assert.doesNotMatch(configureButtonBlock[0], /onClick/)
})
