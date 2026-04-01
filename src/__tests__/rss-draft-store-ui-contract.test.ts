import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('rss mode clears only inbox items while preserving starred entries and supports explicit single-item removal', () => {
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')

  assert.match(rssMode, /preserveStarred:\s*true/)
  assert.match(rssMode, /preserveStarred:\s*false/)
  assert.match(rssMode, /inboxVisible:\s*item\.inboxVisible \?\? true/)
})

test('settings exposes an rss draft-store management section with reset controls', () => {
  const settings = readWorkspaceFile('src/renderer/pages/Settings.tsx')
  const preload = readWorkspaceFile('src/preload/index.ts')

  assert.match(settings, /id:\s*'rss-storage'/)
  assert.match(settings, /RSSDraftStoreSettingsPanel/)
  assert.match(settings, /清空全部底稿/)
  assert.match(settings, /重置此源/)
  assert.match(preload, /getDraftStoreSources/)
  assert.match(preload, /clearDraftStore/)
})
