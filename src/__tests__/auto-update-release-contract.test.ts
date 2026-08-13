import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {

  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('mac release builds publish update metadata to the public Ready release repository', () => {
  const builderConfig = readWorkspaceFile('electron-builder.yml')

  assert.match(builderConfig, /publish:\s*\n\s*provider: github\s*\n\s*owner: ALBEDO-TABAI\s*\n\s*repo: ready-releases/)
  assert.match(builderConfig, /releaseType: release/)
  assert.match(builderConfig, /-\s*target: zip\s*\n\s*arch:\s*\n\s*-\s*arm64/)
})

test('settings about page wires the update button to check, status, and install APIs', () => {
  const settingsPage = readWorkspaceFile('src/renderer/pages/Settings.tsx')

  assert.match(settingsPage, /appAPI\.checkUpdate\(\)/)
  assert.match(settingsPage, /appAPI\.installUpdate\(\)/)
  assert.match(settingsPage, /onUpdateStatus/)
  assert.match(settingsPage, /isUpdateButton \? updateButtonLabel : setting\.buttonLabel/)
  assert.match(settingsPage, /新版本 .* 已下载，点击重启安装/)
})
