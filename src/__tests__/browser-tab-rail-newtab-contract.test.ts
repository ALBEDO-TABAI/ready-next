import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser tab rail keeps the new-tab button attached to the tab strip tail', () => {
  const source = readWorkspaceFile('src/renderer/components/browser/TabRail.tsx')

  assert.match(source, /<MorphTabStrip[\s\S]*onClick=\{\(\) => void onNewTab\(\)\}[\s\S]*<\/MorphTabStrip>/)
  assert.doesNotMatch(source, /<\/MorphTabStrip>[\s\S]*onClick=\{\(\) => void onNewTab\(\)\}/)
})
