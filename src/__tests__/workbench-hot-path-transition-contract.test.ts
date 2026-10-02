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
    'src/renderer/components/calendar/CalendarAssistantPanel.tsx',
    'src/renderer/components/calendar/EventModal.tsx',
    'src/renderer/components/calendar/NewEventMenu.tsx',
    'src/renderer/components/document/DocumentTabRail.tsx',
    'src/renderer/components/layout/FileTree.tsx',
    'src/renderer/components/rss/RSSArticleReader.tsx',
    'src/renderer/components/rss/RSSFeed.tsx',
    'src/renderer/pages/modes/RSSMode.tsx',
    'src/renderer/styles/tiptap.css',
  ]

  for (const path of hotPathFiles) {
    assert.doesNotMatch(readWorkspaceFile(path), /transition-all/)
    assert.doesNotMatch(readWorkspaceFile(path), /transition:\s*all/)
  }
})
