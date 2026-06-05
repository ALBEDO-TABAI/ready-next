import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- renderer layout contract: agent tab visibility is a BrowserView bounds trigger
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('agent browser pane opens when the agent tab is running even before a task card exists', () => {
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')
  const panel = readWorkspaceFile('src/renderer/components/browser/AgentBrowserSupervisionPanel.tsx')

  assert.match(browserMode, /agentRuntimeTab\?\.activity === 'running'/)
  assert.match(browserMode, /`agent-tab:\$\{agentSupervision\.agentTabId\}`/)
  assert.match(browserMode, /agentPaneVisible = Boolean\(agentSupervision\.agentTabId && agentPaneTaskId/)
  assert.match(panel, /variant === 'collapsedRail'/)
  assert.match(panel, /controlState === 'active'[\s\S]*\? '浏览中'/)
})
