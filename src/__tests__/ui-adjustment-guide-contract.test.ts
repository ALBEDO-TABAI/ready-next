import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('side panel routes to dedicated panel components and keeps a UI adjustment guide', () => {
  const sidePanel = readWorkspaceFile('src/renderer/components/layout/SidePanel.tsx')
  const workspaceStore = readWorkspaceFile('src/renderer/stores/useWorkspace.ts')
  const guidePath = resolve(process.cwd(), 'UI_ADJUSTMENT_GUIDE.md')

  assert.match(sidePanel, /import FilesPanel from '\.\/FilesPanel'/)
  assert.match(sidePanel, /<AnimatePresence/)
  assert.match(sidePanel, /<FilesPanel key=\{panelKey\} isVisible=\{isVisible\}>/)
  assert.doesNotMatch(sidePanel, /variant === 'calendar'/)

  assert.match(workspaceStore, /export type WorkspaceSidePanelVariant = SidePanelWidthKey \| 'hidden'/)
  assert.doesNotMatch(workspaceStore, /\['files', 'search', 'skills', 'calendar', 'hidden'\]/)

  assert.equal(existsSync(resolve(process.cwd(), 'src/renderer/components/layout/SearchPanel.tsx')), false)
  assert.equal(existsSync(guidePath), true)

  const guide = readFileSync(guidePath, 'utf8')
  assert.match(guide, /SidePanel\.tsx/)
  assert.match(guide, /FilesPanel\.tsx/)
  assert.match(guide, /CalendarWorkbenchShell\.tsx/)
  assert.match(guide, /workbench-sliders\.css/)
})
