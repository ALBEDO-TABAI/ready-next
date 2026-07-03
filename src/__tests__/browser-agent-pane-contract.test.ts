import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- renderer layout contract: agent tab visibility is a BrowserView bounds trigger
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('agent browser pane only opens for active agent-view supervision tasks', () => {
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')
  const panel = readWorkspaceFile('src/renderer/components/browser/AgentBrowserSupervisionPanel.tsx')
  const supervision = readWorkspaceFile('src/main/modules/browser-engine/ipc-supervision.ts')

  assert.match(browserMode, /agentRuntimeTab\?\.activity === 'running'/)
  assert.match(browserMode, /`agent-tab:\$\{agentSupervision\.agentTabId\}`/)
  assert.match(browserMode, /agentPaneVisible = Boolean\(agentSupervision\.agentTabId && agentPaneTaskId/)
  assert.doesNotMatch(browserMode, /terminalAgentTasks/)
  assert.match(browserMode, /const visibleAgentTask = activeAgentTasks\[0\] \|\| null/)
  assert.match(supervision, /const activeTasks = tasks\.filter/)
  assert.match(supervision, /getActiveForegroundBrowserWorkflowSession/)
  assert.match(supervision, /foregroundWorkflowTask/)
  assert.match(supervision, /foregroundAgentTabId \|\|/)
  assert.match(supervision, /isBrowserSupervisionVisibleTaskStatus/)
  assert.match(browserMode, /isBrowserSupervisionVisibleTaskStatus/)
  assert.match(panel, /isBrowserSupervisionVisibleTaskStatus/)
  assert.match(panel, /browserTaskStatusLabel/)
  assert.match(supervision, /tasks: activeTasks/)
  assert.match(panel, /variant === 'collapsedRail'/)
  assert.match(panel, /controlState === 'active'[\s\S]*\? '浏览中'/)
})
