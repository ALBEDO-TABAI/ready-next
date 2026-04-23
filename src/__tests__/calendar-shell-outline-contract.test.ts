import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('schedule-x calendar shell drops the default outer border so week view relies on surface hierarchy instead', () => {
  const scheduleCss = readWorkspaceFile('src/renderer/styles/schedule-x.css')

  assert.match(
    scheduleCss,
    /\.sx__calendar\s*\{[^}]*border:\s*none !important;/,
  )
})
