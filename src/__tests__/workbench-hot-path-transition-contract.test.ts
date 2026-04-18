import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench hot-path surfaces avoid transition-all on interactive chrome', () => {
  const hotPathFiles = [
    'src/renderer/components/agent/ChatInput.tsx',
    'src/renderer/components/agent/ChatMessages.tsx',
    'src/renderer/components/document/DocumentTabRail.tsx',
    'src/renderer/components/layout/FileTree.tsx',
    'src/renderer/components/rss/PreviewBrowser.tsx',
    'src/renderer/components/rss/RSSFeed.tsx',
    'src/renderer/pages/modes/RSSMode.tsx',
  ]

  for (const path of hotPathFiles) {
    assert.doesNotMatch(readWorkspaceFile(path), /transition-all/)
  }
})
