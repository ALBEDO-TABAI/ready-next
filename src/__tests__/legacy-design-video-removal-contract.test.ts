import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('active workbench and runtime guidance no longer advertise removed design and video modules', () => {
  const modeStore = readWorkspaceFile('src/renderer/stores/useMode.ts')
  const promptAssembly = readWorkspaceFile('src/main/modules/agent-control/prompt-assembly.ts')
  const toolGateway = readWorkspaceFile('src/main/modules/agent-control/tool-gateway.ts')
  const directChat = readWorkspaceFile('src/main/modules/claude-bridge/direct-chat.ts')

  assert.match(modeStore, /export type WorkbenchMode = 'browser' \| 'document' \| 'rss' \| 'calendar'/)
  assert.doesNotMatch(promptAssembly, /browser\/document\/design\/video\/rss\/calendar\/system/)
  assert.doesNotMatch(promptAssembly, /docs\/video-rules\.md/)
  assert.doesNotMatch(promptAssembly, /video-render/)
  assert.doesNotMatch(toolGateway, /group: 'design'/)
  assert.doesNotMatch(toolGateway, /group: 'video'/)
  assert.doesNotMatch(directChat, /design_update_selected/)
  assert.doesNotMatch(directChat, /design_run_task_controller/)
})

test('collaboration docs only describe the four live workbench modules', () => {
  const documentation = readWorkspaceFile('DOCUMENTATION.md')
  const progress = readWorkspaceFile('PROGRESS.md')

  assert.doesNotMatch(documentation, /src\/renderer\/pages\/modes\/DesignMode\.tsx/)
  assert.doesNotMatch(documentation, /src\/renderer\/pages\/modes\/VideoMode\.tsx/)
  assert.doesNotMatch(progress, /design_update_selected/)
  assert.doesNotMatch(progress, /design\/video\/rss\/calendar/)
  assert.doesNotMatch(progress, /browser\/document\/design\/video/)
})
