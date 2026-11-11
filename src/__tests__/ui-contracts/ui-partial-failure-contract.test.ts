import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('rss skills and global search surface partial failures instead of silently swallowing them', () => {
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')
  const skillsPanel = readWorkspaceFile('src/renderer/components/layout/SkillsCenterPanel.tsx')
  const globalSearch = readWorkspaceFile('src/renderer/components/layout/GlobalSearchPanel.tsx')

  assert.match(rssMode, /backgroundWarning/)
  assert.match(rssMode, /onAutoRefreshCompleted/)
  assert.match(rssMode, /setAutoRefreshWarning\(getRSSAutoRefreshWarning\(snapshot\)\)/)
  assert.match(rssMode, /setAutoRefreshWarning\(getRSSFetchAllResultWarning\(result\)\)/)
  assert.doesNotMatch(rssMode, /silent fail on auto-refresh/)

  assert.match(skillsPanel, /interface LegacyImportedFolderParseResult/)
  assert.match(skillsPanel, /legacyFolders\.error/)
  assert.match(skillsPanel, /拖拽数据损坏/)
  assert.match(skillsPanel, /无法读取/)
  assert.match(skillsPanel, /pushMessage\(legacyFolders\.error\)/)

  // The library index (shared by find-and-replace and 设置 › 资料库) reduces each root's reindex response
  // and keeps a partly failed rebuild as a warning instead of discarding it.
  const libraryIndex = readWorkspaceFile('src/renderer/modules/search/useLibraryIndex.ts')
  assert.match(libraryIndex, /reduceReindexResponse/)
  assert.match(globalSearch, /useLibraryIndex\(\)/)
  assert.match(libraryIndex, /if \(outcome\.error\) errors\.push\(outcome\.error\)/)
  assert.match(libraryIndex, /搜索结果可能不完整/)
})
