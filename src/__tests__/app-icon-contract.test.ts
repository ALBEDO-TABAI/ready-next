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

  assert.match(mainIndex, /nativeImage/)
  assert.match(mainIndex, /function resolveAppIconPath\(\)/)
  assert.match(mainIndex, /build\/icon\.png/)
  assert.match(mainIndex, /app\.dock\.setIcon\(/)
  assert.match(mainIndex, /icon:\s*resolveAppIconPath\(\)/)
})
