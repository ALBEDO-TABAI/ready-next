import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('topbar and rail icon controls use direct-on-surface styling without extra capsules', () => {
  const chrome = readWorkspaceFile('src/renderer/modules/workbench/chrome.ts')
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const iconRail = readWorkspaceFile('src/renderer/components/layout/IconRail.tsx')
  const modeSlider = readWorkspaceFile('src/renderer/components/layout/ModeSlider.tsx')

  assert.match(chrome, /WORKBENCH_TOPBAR_PADDING_LEFT = 60/)
  assert.match(chrome, /WORKBENCH_TOPBAR_PADDING_RIGHT = 14/)

  assert.match(topBar, /ModeSlider/)
  assert.match(topBar, /className="mode-tab-button relative flex h-\[24px\] w-\[34px\] items-center justify-center rounded-\[10px\] transition-colors duration-150"/)
  assert.doesNotMatch(topBar, /className="glass-surface-card".*切换到浅色模式/s)
  assert.doesNotMatch(topBar, /className="glass-surface-card".*收起\/展开聊天面板/s)

  assert.doesNotMatch(iconRail, /glass-surface-card w-\[34px\] h-\[34px\]/)
  assert.match(iconRail, /hover:bg-\[var\(--bg-hover\)\]/)
  assert.match(modeSlider, /Ready/)
})
