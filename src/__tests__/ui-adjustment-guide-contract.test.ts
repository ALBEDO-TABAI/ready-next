import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // allow-source-grep: the guide and sidebar import wiring must point to the current owners; this contract checks documentation and source topology.
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('one shell sidebar hosts mode navigators and the UI guide points to their current owners', () => {
  const sidebar = readWorkspaceFile('src/renderer/modules/workbench/shell/ShellSidebar.tsx')
  const navigator = readWorkspaceFile('src/renderer/modules/document/navigator/DocumentNavigator.tsx')
  const workbench = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const workspaceStore = readWorkspaceFile('src/renderer/stores/useWorkspace.ts')
  const guidePath = resolve(process.cwd(), 'UI_ADJUSTMENT_GUIDE.md')

  assert.match(sidebar, /data-shell-sidebar="true"/)
  assert.match(sidebar, /createPortal\(/)
  assert.match(workbench, /<ShellSidebarSlotProvider value=\{sidebarSlot\.value\}>/)
  assert.match(navigator, /import FilesPanel from '\.\.\/\.\.\/\.\.\/components\/layout\/FilesPanel'/)
  assert.match(navigator, /<FilesPanel isVisible=\{visible && view === 'files'\}>/)
  assert.match(workspaceStore, /setSidePanelWidth: \(width: number\) => void/)
  assert.doesNotMatch(workspaceStore, /sidePanelVariant|setSidePanelVariant|SidePanelWidthKey/)
  assert.equal(existsSync(resolve(process.cwd(), 'src/renderer/components/layout/SearchPanel.tsx')), false)
  assert.equal(existsSync(guidePath), true)

  // allow-source-grep: documentation links must identify the actual sidebar and global-view owners.
  const guide = readFileSync(guidePath, 'utf8')
  for (const file of ['ShellSidebar.tsx', 'DocumentNavigator.tsx', 'FilesPanel.tsx', 'FindReplaceWorkspace.tsx', 'SkillsCenter.tsx', 'GraphWorkspace.tsx', 'CalendarWorkbenchShell.tsx', 'workbench-sliders.css']) {
    assert.ok(guide.includes(file), `guide must point to ${file}`)
  }
  assert.doesNotMatch(guide, /components\/layout\/SidePanel\.tsx/)
})
