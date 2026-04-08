import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser inactive tab actions stay out of nested button markup', () => {
  const source = readWorkspaceFile('src/renderer/components/browser/TabRail.tsx')

  assert.match(source, /<MorphTabButton[\s\S]*title=\{tabIsBookmarked \? '取消收藏' : '收藏此页面'\}/)
  assert.match(source, /role="button"/)
  assert.doesNotMatch(source, /<button[\s\S]{0,260}onToggleBookmarkForTab\(tab\)/)
})
