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
  assert.ok(existsSync(resolve(process.cwd(), 'build/icon.svg')))
  assert.ok(existsSync(resolve(process.cwd(), 'src/renderer/assets/ready-wordmark.svg')))
  const iconSvg = readWorkspaceFile('build/icon.svg')
  // The icon is the wordmark "Ready" in Instrument Serif, ink on the white tile (scripts/make-app-icon.cjs).
  assert.match(iconSvg, /#0B0B0E/)
  assert.match(iconSvg, /#FFFFFF/)

  const backgroundMatch = iconSvg.match(/<rect x="([0-9.]+)" y="([0-9.]+)" width="([0-9.]+)" height="([0-9.]+)" rx="([0-9.]+)" fill="#FFFFFF" \/>/)
  assert.ok(backgroundMatch)
  assert.ok(Number(backgroundMatch[1]) >= 96)
  assert.ok(Number(backgroundMatch[2]) >= 96)
  assert.ok(Number(backgroundMatch[3]) >= 800)
  assert.ok(Number(backgroundMatch[4]) >= 800)
  assert.ok(Number(backgroundMatch[1]) + Number(backgroundMatch[3]) <= 1024 - 96)
  assert.ok(Number(backgroundMatch[2]) + Number(backgroundMatch[4]) <= 1024 - 96)

  const safeInset = 1024 * 0.2
  const word = iconSvg.match(/<text [^>]*font-family="'Ready Icon Serif'"[^>]*fill="#0B0B0E"[^>]*data-ink-box="([0-9.]+) ([0-9.]+) ([0-9.]+) ([0-9.]+)"[^>]*>Ready<\/text>/)
  assert.ok(word, 'the wordmark is a text element that records its ink box')
  const [inkX, inkY, inkWidth, inkHeight] = word.slice(1).map(Number)
  // Air on every side: the word's ink stays inside the safe area and is centred on the tile.
  assert.ok(inkX >= safeInset && inkY >= safeInset)
  assert.ok(inkX + inkWidth <= 1024 - safeInset && inkY + inkHeight <= 1024 - safeInset)
  assert.ok(Math.abs(inkX + inkWidth / 2 - 512) <= 1)
  assert.match(iconSvg, /@font-face \{ font-family: 'Ready Icon Serif'; src: url\(data:font\/woff2;base64,/)
})

test('main process applies the project-owned icon during development instead of default electron branding', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')
  const bootEntry = readWorkspaceFile('src/main/boot-entry.ts')
  const packageJson = JSON.parse(readWorkspaceFile('package.json')) as {
    scripts: Record<string, string>
  }
  const syncScript = readWorkspaceFile('scripts/sync-dev-icon.mjs')

  assert.match(mainIndex, /nativeImage/)
  assert.match(mainIndex, /function resolveAppIconPath\(\)/)
  assert.match(mainIndex, /build\/icon\.png/)
  assert.match(bootEntry, /app\.setName\('Ready Next'\)/)
  assert.match(mainIndex, /function ensureRegularDockApp\(\): void/)
  assert.match(mainIndex, /ensureRegularDockApp\(\)/)
  assert.match(mainIndex, /app\.dock\.setIcon\(/)
  assert.match(mainIndex, /icon:\s*resolveAppIconPath\(\)/)
  assert.ok(
    bootEntry.indexOf("app.setActivationPolicy('regular')") < bootEntry.indexOf('app.whenReady()'),
    'Ready must opt into a regular Dock app before app.whenReady() registers with LaunchServices',
  )
  assert.equal(
    packageJson.scripts.dev,
    'node ./scripts/sync-dev-icon.mjs && node scripts/ensure-native-dev.cjs && electron-vite dev',
  )
  assert.ok(existsSync(resolve(process.cwd(), 'scripts/ensure-native-dev.cjs')))
  assert.doesNotMatch(packageJson.scripts.dev, /npm run rebuild:native && npm run native:check/)
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
  assert.match(syncScript, /com\.ready\.app\.next\.dev/)
  assert.match(syncScript, /plutil/)
  assert.match(syncScript, /copyFileSync/)
  assert.match(syncScript, /process\.platform !== 'darwin'/)
})
