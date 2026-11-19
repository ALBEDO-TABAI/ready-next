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

test('main build entry is the splash-first boot entry, not the heavy app module', () => {
  const viteConfig = readWorkspaceFile('electron.vite.config.ts')

  assert.match(viteConfig, /index: resolve\(__dirname, 'src\/main\/boot-entry\.ts'\)/)
  // 重模块必须保持具名 entry：掉进 out/main/chunks/ 会让模块内
  // `join(__dirname, '../preload/…')` 等路径整体偏一级（renderer/preload 404）。
  assert.match(viteConfig, /app: resolve\(__dirname, 'src\/main\/index\.ts'\)/)
})

test('boot entry shows the splash before dynamically importing the heavy app module', () => {
  const bootEntry = readWorkspaceFile('src/main/boot-entry.ts')
  const splashIndex = bootEntry.indexOf('await createStartupSplashWindow()')
  const heavyImportIndex = bootEntry.indexOf("await import('./index')")

  assert.ok(splashIndex > 0)
  assert.ok(heavyImportIndex > splashIndex)
})

test('boot entry acquires the single-instance lock after userData override and before the heavy app boots', () => {
  const bootEntry = readWorkspaceFile('src/main/boot-entry.ts')
  const userDataIndex = bootEntry.indexOf("app.setPath('userData', READY_USER_DATA_DIR)")
  const lockIndex = bootEntry.indexOf('requestSingleInstanceLock()')
  const heavyImportIndex = bootEntry.indexOf("await import('./index')")

  // Lock is scoped to the resolved userData dir, so it must run AFTER the
  // override (isolated profiles keep their own lock) and BEFORE any boot work
  // that opens the shared SQLite. Two instances on one userData let the second
  // boot's reconciler reap the first process's in-flight run.
  assert.ok(lockIndex > 0, 'boot entry must acquire the single-instance lock')
  assert.ok(lockIndex > userDataIndex, 'lock must run after the userData override')
  assert.ok(heavyImportIndex > lockIndex, 'the heavy app module must load only after the lock is held')
  assert.match(bootEntry, /app\.exit\(0\)/)
})

test('a denied second instance focuses the running window instead of double-booting', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')
  assert.match(mainIndex, /app\.on\('second-instance'/)
})

test('boot entry static import graph stays tiny so the splash is not delayed', () => {
  const bootEntry = readWorkspaceFile('src/main/boot-entry.ts')
  // 白名单外的任何静态 import 都会把整棵依赖树求值成本压回 splash 之前。
  // 新增入口依赖必须先证明它是 pre-ready 必需且自身依赖树极小。
  const allowedImportSpecifiers = new Set([
    'dotenv',
    'path',
    'fs',
    'electron',
    './modules/browser-engine/popup-policy',
    './startup-splash-window',
    './boot-timing',
    './calendar-open-intents',
    // C15: the data-isolation guard must run before userData is touched; both depend only on fs/path.
    './ready-next-data-isolation',
    './modules/database-path',
    // Blink flags must read the one persisted setting before app ready (read-only, no migrations).
    './modules/browser-engine/webmcp-experiment',
  ])
  const staticImports = [...bootEntry.matchAll(/^import[^'"]+from ['"]([^'"]+)['"]/gm)].map((m) => m[1])

  assert.ok(staticImports.length > 0)
  for (const specifier of staticImports) {
    assert.ok(allowedImportSpecifiers.has(specifier), `unexpected static import in boot-entry.ts: ${specifier}`)
  }
})

test('workbench defers hidden mode preloads until the first surface is idle', () => {
  const outlet = readWorkspaceFile('src/renderer/components/layout/WorkbenchModeOutlet.tsx')

  assert.match(outlet, /requestIdleCallback/)
  assert.match(outlet, /setTimeout\(preloadModes,\s*1_500\)/)
  assert.doesNotMatch(outlet, /useLayoutEffect\(\(\) => \{\s*if \(hasPreloadedWorkbenchModes\) return\s*hasPreloadedWorkbenchModes = true\s*ALL_MODE_LOADERS/)
})

test('document navigator keeps files static while global find and skills load on demand', () => {
  const navigator = readWorkspaceFile('src/renderer/modules/document/navigator/DocumentNavigator.tsx')
  const workbench = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const app = readWorkspaceFile('src/renderer/App.tsx')

  assert.match(navigator, /import FilesPanel from '\.\.\/\.\.\/\.\.\/components\/layout\/FilesPanel'/)
  assert.match(workbench, /const FindReplaceWorkspace = lazy\(\(\) => import\('\.\.\/components\/search\/FindReplaceWorkspace'\)\)/)
  assert.match(app, /const SkillsCenter = lazy\(\(\) => import\('\.\/pages\/SkillsCenter'\)\)/)
  for (const source of [navigator, workbench, app]) {
    assert.doesNotMatch(source, /^import\s+(?!type\b).*\b(?:FindReplaceWorkspace|GlobalSearchPanel|SkillsCenter|SkillsCenterPanel)\b.*from/m)
  }
})
