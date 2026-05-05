import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('electron packaging includes project-owned app icon assets instead of falling back to the default electron icon', () => {
  const builderConfig = readWorkspaceFile('electron-builder.yml')

  assert.match(builderConfig, /buildResources:\s*build/)
  assert.ok(existsSync(resolve(process.cwd(), 'build/icon.icns')))
  assert.ok(existsSync(resolve(process.cwd(), 'build/icon.png')))
  assert.ok(existsSync(resolve(process.cwd(), 'build/icon.ico')))
})

test('main process applies the project-owned icon during development instead of default electron branding', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')
  const packageJson = JSON.parse(readWorkspaceFile('package.json')) as {
    scripts: Record<string, string>
  }
  const syncScript = readWorkspaceFile('scripts/sync-dev-icon.mjs')

  assert.match(mainIndex, /nativeImage/)
  assert.match(mainIndex, /function resolveAppIconPath\(\)/)
  assert.match(mainIndex, /build\/icon\.png/)
  assert.match(mainIndex, /const READY_APP_NAME = 'Ready'/)
  assert.match(mainIndex, /app\.setName\(READY_APP_NAME\)/)
  assert.match(mainIndex, /function ensureRegularDockApp\(\): void/)
  assert.match(mainIndex, /ensureRegularDockApp\(\)/)
  assert.match(mainIndex, /app\.dock\.setIcon\(/)
  assert.match(mainIndex, /icon:\s*resolveAppIconPath\(\)/)
  assert.ok(
    mainIndex.indexOf('ensureRegularDockApp()') < mainIndex.indexOf('app.whenReady()'),
    'Ready must opt into a regular Dock app before app.whenReady() registers with LaunchServices',
  )
  assert.equal(
    packageJson.scripts.dev,
    'node ./scripts/sync-dev-icon.mjs && npm run rebuild:native && npm run native:check && electron-vite dev',
  )
  assert.equal(
    packageJson.scripts.build,
    'npm run rebuild:native && npm run native:check && npm run typecheck && electron-vite build',
  )
  assert.equal(packageJson.scripts['native:check'], 'node scripts/check-better-sqlite3-electron-abi.cjs')
  assert.match(syncScript, /node_modules\/electron\/dist\/Electron\.app\/Contents\/Resources\/electron\.icns/)
  assert.match(syncScript, /node_modules\/electron\/dist\/Electron\.app\/Contents\/Info\.plist/)
  assert.match(syncScript, /CFBundleDisplayName/)
  assert.match(syncScript, /CFBundleName/)
  assert.match(syncScript, /CFBundleIdentifier/)
  assert.match(syncScript, /com\.ready\.app\.dev/)
  assert.match(syncScript, /plutil/)
  assert.match(syncScript, /copyFileSync/)
  assert.match(syncScript, /process\.platform !== 'darwin'/)
})
