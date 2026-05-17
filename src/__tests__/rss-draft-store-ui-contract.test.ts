import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('rss mode clears only inbox items while preserving starred entries and supports explicit single-item removal', () => {
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')
  const rssWarmLoader = readWorkspaceFile('src/renderer/modules/rss/rssWarmLoader.ts')

  assert.match(rssMode, /preserveStarred:\s*true/)
  assert.match(rssMode, /preserveStarred:\s*false/)
  assert.match(rssWarmLoader, /inboxVisible:\s*item\.inboxVisible \?\? true/)
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

test('rss add-source flow exposes a glass submenu and can prefill from the active browser page', () => {
  const rssFeed = readWorkspaceFile('src/renderer/components/rss/RSSFeed.tsx')
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')
  const addSourceModal = readWorkspaceFile('src/renderer/components/rss/AddSourceModal.tsx')

  assert.doesNotMatch(rssFeed, /展开添加源菜单/)
  assert.match(rssMode, /browserPresetUrl=/)
  assert.match(rssMode, /browserPresetName=/)
  assert.match(rssMode, /browserPresetLabel=/)
  assert.match(rssMode, /selectedSourceId:\s*source\.id/)
  assert.match(rssMode, /正在刷新全部 RSS 源/)
  assert.match(rssMode, /\$\{selectedSourceEntry\.name\} 正在刷新/)
  assert.match(addSourceModal, /从当前页面带入/)
  assert.match(addSourceModal, /或者手动填写/)
  assert.match(addSourceModal, /interface AddSourceSuccessInfo/)
  assert.match(addSourceModal, /onSuccess\(result\?\.data as AddSourceSuccessInfo/)
  assert.match(addSourceModal, /paddingLeft:\s*CONTENT_INSET,\s*paddingRight:\s*10/)
  assert.match(addSourceModal, /padding:\s*'8px 10px'/)
  assert.doesNotMatch(addSourceModal, /手动输入链接/)
  assert.doesNotMatch(addSourceModal, /选择填入方式/)
  assert.match(addSourceModal, /当前页面信息已带入/)
  assert.doesNotMatch(addSourceModal, /Quick Fill/)
  assert.doesNotMatch(addSourceModal, />Add Source</)
  assert.doesNotMatch(addSourceModal, /rgba\(17, 24, 39, 0\.22\)/)
  assert.doesNotMatch(addSourceModal, /color-red-light/)
  assert.doesNotMatch(addSourceModal, /color-blue-light/)
})
