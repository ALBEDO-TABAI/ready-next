import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench shell handles plain `·` and plain Tab only through a guarded panel shortcut helper', () => {
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const helper = readWorkspaceFile('src/renderer/modules/workbench/panel-shortcuts.ts')

  assert.match(workbenchMode, /import \{ resolveWorkbenchPanelShortcutAction \} from '\.\.\/modules\/workbench\/panel-shortcuts'/)
  assert.match(workbenchMode, /const handledAction = resolveWorkbenchPanelShortcutAction\(\{/)
  assert.match(workbenchMode, /selectionText:\s*window\.getSelection\(\)\?\.toString\(\) \?\? ''/)
  assert.match(workbenchMode, /renamingPath,/)
  assert.match(workbenchMode, /creatingType,/)
  assert.match(workbenchMode, /if \(!handledAction\) return/)
  assert.match(workbenchMode, /event\.preventDefault\(\)/)
  assert.match(workbenchMode, /if \(handledAction === 'toggle-sidebar'\) \{\s*handleToggleSidebarWithResize\(\)/)
  assert.match(workbenchMode, /handleToggleChatPanelWithResize\(\)/)

  assert.match(helper, /export type WorkbenchPanelShortcutAction = 'toggle-sidebar' \| 'toggle-chat'/)
  assert.match(helper, /key === 'Tab'/)
  assert.match(helper, /key === '·'/)
  assert.match(helper, /code === 'Backquote'/)
  assert.match(helper, /selectionText\.trim\(\)/)
  assert.match(helper, /INPUT'\s*,\s*'TEXTAREA'\s*,\s*'SELECT'/)
  assert.match(helper, /isContentEditable/)
})
