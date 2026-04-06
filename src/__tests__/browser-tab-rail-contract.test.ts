import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser tab rail avoids nested buttons inside draggable tab buttons', () => {
  const source = readWorkspaceFile('src/renderer/components/browser/TabRail.tsx')

  const marker = "title={tabIsBookmarked ? '取消收藏' : '收藏此页面'}"
  const markerIndex = source.indexOf(marker)
  assert.notStrictEqual(markerIndex, -1, 'expected bookmark action title to exist')

  const spanStart = source.lastIndexOf('<span', markerIndex)
  const buttonStart = source.lastIndexOf('<button', markerIndex)
  assert.notStrictEqual(spanStart, -1, 'expected bookmark control to be wrapped by span')
  assert.ok(spanStart > buttonStart, 'bookmark control should not be introduced by button tag')

  const snippet = source.slice(spanStart, markerIndex + marker.length + 80)
  assert.match(snippet, /role="button"/)
  assert.doesNotMatch(snippet, /<button[\s\S]*title=\{tabIsBookmarked \? '取消收藏' : '收藏此页面'\}/)
})
