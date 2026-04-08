import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('rss feed mirrors calendar header button styling while article rows stay on the shared glass sheet', () => {
  const rssFeed = readWorkspaceFile('src/renderer/components/rss/RSSFeed.tsx')
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(rssFeed, /const calendarPrimaryButtonStyle = \{/)
  assert.match(rssFeed, /const calendarPillButtonStyle = \{/)
  assert.match(rssFeed, /className="rss-feed-surface content-surface-panel/)
  assert.match(rssFeed, /background: 'color-mix\(in srgb, var\(--surface-card-bg\) 28%, transparent\)'/)
  assert.match(rssFeed, /border: '1px solid var\(--border-input\)'/)
  assert.match(rssFeed, /color: 'var\(--text-body\)'/)
  assert.match(rssFeed, /background: 'transparent'/)
  assert.match(rssMode, /className=\{`rss-feed-sheet content-surface-panel/)
  assert.match(styles, /\.rss-mode-shell \.rss-feed-sheet,/)
  assert.match(styles, /\.rss-mode-shell \.rss-feed-surface,/)
  assert.match(styles, /background:\s*transparent !important;/)
  assert.doesNotMatch(rssFeed, /bg-\[var\(--bg-primary\)\]/)
})

test('chat composer keeps a visible shell and a primary send button after liquid glass restyle', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const chatInput = readWorkspaceFile('src/renderer/components/agent/ChatInput.tsx')

  assert.match(chatPanel, /const composerShellStyle = \{/)
  assert.match(chatInput, /data-chat-composer-shell="true"/)
  assert.match(chatPanel, /background:\s*'var\(--input-slot-bg\)'/)
  assert.match(chatPanel, /border: isDragOver \? '2px solid var\(--text-muted\)' : '1px solid var\(--input-slot-border\)'/)
  assert.match(chatPanel, /boxShadow: isDragOver[\s\S]*var\(--input-slot-shadow-focus\)[\s\S]*: 'var\(--input-slot-shadow\)'/)
  assert.match(chatInput, /background: 'var\(--color-blue\)'/)
  assert.doesNotMatch(chatPanel, /id="chat-input-shell"/)
})

test('browser and rss share one support panel width constant to reduce mode switching jump', () => {
  const chrome = readWorkspaceFile('src/renderer/modules/workbench/chrome.ts')
  const browserSidePanel = readWorkspaceFile('src/renderer/components/browser/BrowserSidePanel.tsx')
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')

  assert.match(chrome, /export const WORKBENCH_SUPPORT_PANEL_WIDTH = 300/)
  assert.match(browserSidePanel, /WORKBENCH_SUPPORT_PANEL_WIDTH/)
  assert.match(rssMode, /WORKBENCH_SUPPORT_PANEL_WIDTH/)
})

test('skills center and global search inherit the file manager side panel surface instead of nesting a second glass sheet', () => {
  const skillsPanel = readWorkspaceFile('src/renderer/components/layout/SkillsCenterPanel.tsx')
  const globalSearch = readWorkspaceFile('src/renderer/components/layout/GlobalSearchPanel.tsx')

  assert.doesNotMatch(skillsPanel, /className="content-surface-panel relative flex h-full min-h-0 flex-col"/)
  assert.doesNotMatch(globalSearch, /className="content-surface-panel flex h-full min-h-0 flex-col"/)
  assert.doesNotMatch(skillsPanel, /backdropFilter: 'blur\(18px\) saturate\(138%\)'/)
  assert.doesNotMatch(globalSearch, /backdropFilter: 'blur\(18px\) saturate\(138%\)'/)
  assert.match(skillsPanel, /background: selected \? 'var\(--bg-hover\)' : 'transparent'/)
  assert.match(skillsPanel, /background: importDropActive \? PANEL_COLORS\.blueLight : 'transparent'/)
  assert.match(globalSearch, /background: 'transparent'/)
  assert.doesNotMatch(globalSearch, /className="content-surface-card w-full rounded-\[8px\] border px-\[8px\] py-\[6px\] text-left transition-colors hover:bg-\[var\(--bg-hover\)\]"/)
})
