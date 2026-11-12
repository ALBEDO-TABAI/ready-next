import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('liquid workbench surfaces remove prominent borders and heavy highlights', () => {
  const styles = readRendererStyles()
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const statusBar = readWorkspaceFile('src/renderer/components/layout/StatusBar.tsx')
  const calendarShell = readWorkspaceFile('src/renderer/pages/modes/CalendarMode.tsx')

  // W1 T6: the liquid-skin borders and shadows (--lg-*) went with the shell alias layer; hairlines and shadows are --rn-*.
  assert.doesNotMatch(styles, /--lg-(?:border|shadow)-[a-z]+\s*:/)
  // B13 (W1 DL1, DL2, DL11a): the tab rows and the browser's address bar sit on the glass with no fill or blur; 资讯's
  // content is paper, and so is the browser's page (its frame paints no corner patches).
  assert.match(styles, /html:root \.workbench-tabs-surface \{\s*background:\s*transparent !important;\s*\}/)
  assert.match(styles, /\.rss-mode-shell \.rss-feed-sheet \{[\s\S]*?background:\s*var\(--rn-sheet\) !important;/)
  assert.doesNotMatch(styles, /\.browser-header-surface \{/)
  assert.match(styles, /box-shadow: none !important;/)

  assert.match(topBar, /borderBottom: '1px solid transparent'/)
  assert.doesNotMatch(statusBar, /borderTop:/)
  assert.match(calendarShell, /background:'transparent',boxShadow:'none'/)
})
