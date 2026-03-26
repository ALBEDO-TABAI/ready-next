import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('side panel uses a shared waterfall handoff shell instead of hard swapping panel bodies', () => {
  const sidePanel = readWorkspaceFile('src/renderer/components/layout/SidePanel.tsx')
  const filesPanel = readWorkspaceFile('src/renderer/components/layout/FilesPanel.tsx')
  const globalSearch = readWorkspaceFile('src/renderer/components/layout/GlobalSearchPanel.tsx')
  const skillsPanel = readWorkspaceFile('src/renderer/components/layout/SkillsCenterPanel.tsx')

  assert.match(sidePanel, /from 'framer-motion'/)
  assert.match(sidePanel, /AnimatePresence/)
  assert.match(sidePanel, /useIsPresent/)
  assert.match(sidePanel, /usePresenceData/)
  assert.match(sidePanel, /const PANEL_STACK_ORDER: Record<RenderableSidePanelVariant, number> = \{/)
  assert.match(sidePanel, /const HEADER_STREAM_DURATION = 0\.32/)
  assert.match(sidePanel, /const CONTENT_STREAM_DURATION = 0\.4/)
  assert.match(sidePanel, /const transitionDirection = useMemo/)
  assert.match(sidePanel, /const delta = PANEL_STACK_ORDER\[variant\] - PANEL_STACK_ORDER\[lastVisibleVariantRef\.current\]/)
  assert.match(sidePanel, /const resolvedDirection = \(\(presenceDirection \?\? direction\) as PanelDirection\) \|\| 1/)
  assert.match(sidePanel, /const layerZIndex = isPresent \? 1 : 2/)
  assert.match(sidePanel, /custom=\{sidebarVisible \? transitionDirection : 1\}/)
  assert.match(sidePanel, /panelWidth: number/)
  assert.match(sidePanel, /width: panelWidth,/)
  assert.match(sidePanel, /minWidth: panelWidth,/)
  assert.match(sidePanel, /initial=\{\s*reduceMotion \? false : \{ y: resolvedDirection > 0 \? '100%' : '-100%' \}\s*\}/)
  assert.match(sidePanel, /exit=\{\s*reduceMotion\s*\?\s*undefined\s*:\s*\{\s*y: resolvedDirection > 0 \? '-100%' : '100%'/)
  assert.doesNotMatch(sidePanel, /opacity:\s*0/)
  assert.match(filesPanel, /children\?: \(slots: SidePanelSlots\) => ReactNode/)
  assert.match(globalSearch, /children\?: \(slots: SidePanelSlots\) => ReactNode/)
  assert.match(skillsPanel, /children\?: \(slots: SidePanelSlots\) => ReactNode/)
})
