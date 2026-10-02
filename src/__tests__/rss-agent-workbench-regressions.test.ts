import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: RSS agent workbench regression pins cross-mode source wiring
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('rss feed keeps compact toolbar controls in the top bar while article rows stay on the shared glass sheet', () => {
  const rssFeed = readWorkspaceFile('src/renderer/components/rss/RSSFeed.tsx')
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')
  const styles = readRendererStyles()

  // Tools live in the canvas top bar (like Document's path bar) only while the list is the visible view.
  assert.match(rssFeed, /<RSSTopbarTools show=\{toolsVisible\}>/)
  assert.match(rssMode, /toolsVisible=\{surfaceActive && feedVisible\}/)
  assert.match(rssFeed, /className="rss-feed-surface content-surface-panel/)
  assert.match(rssFeed, /className="rss-toolbar-actions flex items-center"/)
  assert.match(rssFeed, /className="rss-toolbar-icon-button"/)
  assert.match(rssFeed, /<RefreshCw/)
  assert.match(rssFeed, /rss-toolbar-active-dot/)
  assert.match(rssFeed, /aria-label="更多操作"/)
  // The source filter is a quiet menu, not a native select, so each row can host its delete control.
  assert.match(rssFeed, /className="rss-quiet-select"/)
  assert.match(rssFeed, /className="rss-source-menu-panel overflow-hidden rounded-\[12px\]"/)
  assert.match(rssFeed, /ready-floating-menu-item/)
  assert.match(styles, /\.rss-toolbar-icon-button \{/)
  assert.match(styles, /\.rss-toolbar-icon-button\[data-tooltip\]::after \{/)
  assert.match(rssFeed, /background: 'transparent'/)
  assert.match(rssMode, /className=\{`rss-feed-sheet content-surface-panel/)
  assert.match(styles, /\.rss-mode-shell \.rss-feed-sheet \{/)
  assert.match(styles, /\.rss-mode-shell \.rss-feed-surface,/)
  assert.match(styles, /background:\s*transparent !important;/)
  assert.doesNotMatch(rssFeed, /bg-\[var\(--bg-primary\)\]/)
  // The list itself never pulls in the chat composer; reference/export entries come from RSSMode.
  assert.doesNotMatch(rssFeed, /chat-input-bridge|RSSReferenceButton/)
  assert.match(rssMode, /renderMoreActions=/)
})

test('chat composer keeps a visible shell and a primary send button after liquid glass restyle', () => {
  const chatPanelBody = readWorkspaceFile('src/renderer/components/agent/chat-panel/ChatPanelBody.tsx')
  const chatMessages = readWorkspaceFile('src/renderer/components/agent/ChatMessages.tsx')
  const chatInput = readWorkspaceFile('src/renderer/components/agent/ChatInput.tsx')

  assert.match(chatPanelBody, /const composerShellStyle = \{/)
  assert.match(chatPanelBody, /const composerOverlayRef = useRef<HTMLDivElement \| null>\(null\)/)
  assert.match(chatPanelBody, /bottomOverlayInset=\{composerBottomInset\}/)
  assert.match(chatMessages, /data-chat-bottom-overlay-spacer="true"/)
  assert.match(chatInput, /data-chat-composer-shell="true"/)
  // 2026-06-10: 玻璃材质收口到 LiquidLens；外壳透明、仅拖拽态有描边。
  assert.match(chatPanelBody, /background:\s*'transparent'/)
  assert.match(chatPanelBody, /border: isDragOver \? '2px solid var\(--color-blue\)' : '1px solid transparent'/)
  assert.match(chatPanelBody, /boxShadow:\s*'none'/)
  assert.match(chatInput, /<LiquidLens/)
  assert.match(chatInput, /data-ready-agent-send="true"/)
  assert.match(chatInput, /aria-label=\{sendBlockedReason \|\| '发送'\}/)
  assert.match(chatInput, /background: '#0f0f0f'/)
  assert.doesNotMatch(chatPanelBody, /id="chat-input-shell"/)
})

test('rss analysis task menu uses a solid floating surface with relaxed status rows', () => {
  const rssFeed = readWorkspaceFile('src/renderer/components/rss/RSSFeed.tsx')

  assert.match(rssFeed, /className="rss-feed-surface content-surface-panel rss-workbench-surface relative/)
  assert.match(rssFeed, /className="rss-task-menu-panel overflow-hidden rounded-\[18px\]"/)
  assert.match(rssFeed, /position: 'absolute'/)
  assert.match(rssFeed, /top: 'calc\(100% \+ 6px\)'/)
  // Pane-relative placement and clipping are exercised by run-rss-layout-acceptance.cjs.
  assert.match(rssFeed, /zIndex: 30/)
  assert.match(rssFeed, /width: 384/)
  assert.match(rssFeed, /data-tooltip=\{taskMenuOpen \? undefined : '任务'\}/)
  assert.match(rssFeed, /\{taskMenuPanel\}/)
  assert.match(rssFeed, /<LiquidFloatingPanel/)
  assert.match(rssFeed, /import \{ LiquidFloatingPanel \} from '\.\.\/ui\/liquid-glass\/LiquidFloatingPanel'/)
  assert.match(rssFeed, /function taskStageTone/)
  assert.match(rssFeed, /function taskDetailText/)
  assert.match(rssFeed, /if \(!message \|\| job\.status === 'success'\) return ''/)
  assert.match(rssFeed, /job\.progress >= 100 && \/完成\|已完成\/\.test\(message\)/)
  assert.match(rssFeed, /<AnalysisProgressRing/)
  assert.match(rssFeed, /{roundedProgress}%/)
  assert.match(rssFeed, /{analysisJobs\.length} 条记录 · {activeJobsCount} 个进行中/)
  // Quiet rows: status is text weight, not colored pills; no divider under the header.
  assert.doesNotMatch(rssFeed, /className="flex items-center justify-between border-b"/)
  assert.doesNotMatch(rssFeed, /rounded-full px-1\.5/)
  assert.doesNotMatch(rssFeed, /className="border transition-colors"/)
  assert.doesNotMatch(rssFeed, /status === 'success'[\s\S]{0,240}<circle/)
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
