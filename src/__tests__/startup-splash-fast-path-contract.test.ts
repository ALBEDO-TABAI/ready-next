import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed startup-path contract: boot ordering and lazy preload guards are static wiring constraints.
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('startup splash is shown before boot cleanup and database checks', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')
  const splashIndex = mainIndex.indexOf('await createStartupSplashWindow()')
  const reapIndex = mainIndex.indexOf('const result = reapOrphans()')
  const databaseGateIndex = mainIndex.indexOf('assertPrimaryDatabaseReady()')

  assert.ok(splashIndex > 0)
  assert.ok(reapIndex > splashIndex)
  assert.ok(databaseGateIndex > splashIndex)
})

test('startup splash uses sparse logo dots instead of revealing a complete wordmark during loading', () => {
  const splashHtml = readWorkspaceFile('src/main/startup-splash-html.ts')

  assert.match(splashHtml, /createReadyLogoDotPattern/)
  assert.match(splashHtml, /resolveLogoDotOpacity/)
  assert.doesNotMatch(splashHtml, /createInlineWordmark/)
  assert.doesNotMatch(splashHtml, /ready-startup-wordmark/)
  assert.doesNotMatch(splashHtml, /clip-path/)
})

test('workbench defers hidden mode preloads until the first surface is idle', () => {
  const outlet = readWorkspaceFile('src/renderer/components/layout/WorkbenchModeOutlet.tsx')

  assert.match(outlet, /requestIdleCallback/)
  assert.match(outlet, /setTimeout\(preloadModes,\s*1_500\)/)
  assert.doesNotMatch(outlet, /useLayoutEffect\(\(\) => \{\s*if \(hasPreloadedWorkbenchModes\) return\s*hasPreloadedWorkbenchModes = true\s*ALL_MODE_LOADERS/)
})

test('side panel keeps only the default files panel on the startup path', () => {
  const sidePanel = readWorkspaceFile('src/renderer/components/layout/SidePanel.tsx')

  assert.match(sidePanel, /import FilesPanel from '\.\/FilesPanel'/)
  assert.match(sidePanel, /lazy\(\(\) => import\('\.\/GlobalSearchPanel'\)\)/)
  assert.match(sidePanel, /lazy\(\(\) => import\('\.\/SkillsCenterPanel'\)\)/)
  assert.match(sidePanel, /lazy\(\(\) => import\('\.\/BacklinksCenterPanel'\)\)/)
  assert.match(sidePanel, /lazy\(\(\) => import\('\.\/GraphCenterPanel'\)\)/)
  assert.doesNotMatch(sidePanel, /import GlobalSearchPanel from/)
  assert.doesNotMatch(sidePanel, /import SkillsCenterPanel from/)
})
