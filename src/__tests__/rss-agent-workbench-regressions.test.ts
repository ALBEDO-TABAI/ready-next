import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: RSS agent workbench regression pins cross-mode source wiring
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('rss feed keeps compact toolbar controls while article rows stay on the shared glass sheet', () => {
  const rssFeed = readWorkspaceFile('src/renderer/components/rss/RSSFeed.tsx')
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')
  const styles = readRendererStyles()

  assert.match(rssFeed, /const calendarPillButtonStyle = \{/)
  assert.match(rssFeed, /className="rss-feed-surface content-surface-panel/)
  assert.match(rssFeed, /className="rss-toolbar-actions flex items-center"/)
  assert.match(rssFeed, /className="rss-toolbar-select appearance-none cursor-pointer transition-colors duration-150"/)
  assert.match(rssFeed, /className="rss-toolbar-select appearance-none cursor-pointer/)
  // 浮层升级为专属液态面板类（rss-source-menu-panel，样式在 index.css 玻璃带）
  assert.match(rssFeed, /className="rss-source-menu-panel overflow-hidden rounded-\[12px\]"/)
  assert.match(rssFeed, /ready-floating-menu-item/)
  assert.match(rssFeed, /className="rss-toolbar-icon-button"/)
  assert.match(rssFeed, /<ListTodo className="h-\[14px\] w-\[14px\]"/)
  assert.match(rssFeed, /<RefreshCw/)
  assert.match(rssFeed, /rss-toolbar-active-dot/)
  assert.match(styles, /\.rss-toolbar-icon-button \{/)
  assert.match(styles, /\.rss-toolbar-select:hover \{/)
  assert.match(rssFeed, /border: '1px solid transparent'/)
  assert.match(rssFeed, /color: 'var\(--text-body\)'/)
  assert.match(rssFeed, /background: 'transparent'/)
  assert.match(rssMode, /className=\{`rss-feed-sheet content-surface-panel/)
  assert.match(styles, /\.rss-mode-shell \.rss-feed-sheet \{/)
  assert.match(styles, /\.rss-mode-shell \.rss-feed-surface,/)
  assert.match(styles, /background:\s*transparent !important;/)
  assert.doesNotMatch(rssFeed, /bg-\[var\(--bg-primary\)\]/)
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
  assert.match(chatInput, /background: 'var\(--color-blue\)'/)
  assert.doesNotMatch(chatPanelBody, /id="chat-input-shell"/)
})

test('browser and rss share one support panel width constant to reduce mode switching jump', () => {
  const chrome = readWorkspaceFile('src/renderer/modules/workbench/chrome.ts')
  const browserSidePanel = readWorkspaceFile('src/renderer/components/browser/BrowserSidePanel.tsx')
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')

  assert.match(chrome, /export const WORKBENCH_SUPPORT_PANEL_WIDTH = 300/)
  assert.match(browserSidePanel, /WORKBENCH_SUPPORT_PANEL_WIDTH/)
  assert.match(rssMode, /WORKBENCH_SUPPORT_PANEL_WIDTH/)
})

test('rss analysis task menu uses a solid floating surface with relaxed status rows', () => {
  const rssFeed = readWorkspaceFile('src/renderer/components/rss/RSSFeed.tsx')

  assert.match(rssFeed, /className="rss-feed-surface content-surface-panel rss-workbench-surface relative/)
  // 任务菜单同波升级为 rss-task-menu-panel 专属液态面板
  assert.match(rssFeed, /className="rss-task-menu-panel overflow-hidden rounded-\[18px\]"/)
  assert.match(rssFeed, /position: 'absolute'/)
  assert.match(rssFeed, /top: 'calc\(100% \+ 10px\)'/)
  assert.match(rssFeed, /right: 0/)
  assert.match(rssFeed, /zIndex: 30/)
  assert.match(rssFeed, /width: 384/)
  assert.match(rssFeed, /maxWidth: 'min\(384px, calc\(100vw - 48px\)\)'/)
  assert.match(rssFeed, /data-tooltip=\{taskMenuOpen \? undefined : '任务'\}/)
  assert.match(rssFeed, /\{taskMenuPanel\}/)
  assert.doesNotMatch(rssFeed, /\{taskMenuPanel\}\s*\n\s*\{\/\* Item List \*\/\}/)
  assert.match(rssFeed, /var\(--surface-floating-bg\) 96%/)
  // 玻璃/背景滤镜职责移交共享 LiquidFloatingPanel（液态玻璃系统组件），面板不再内联 backdropFilter
  assert.match(rssFeed, /<LiquidFloatingPanel/)
  assert.match(rssFeed, /import \{ LiquidFloatingPanel \} from '\.\.\/ui\/liquid-glass\/LiquidFloatingPanel'/)
  assert.match(rssFeed, /function taskStageTone/)
  assert.match(rssFeed, /function taskDetailText/)
  assert.match(rssFeed, /if \(!message \|\| job\.status === 'success'\) return ''/)
  assert.match(rssFeed, /job\.progress >= 100 && \/完成\|已完成\/\.test\(message\)/)
  assert.match(rssFeed, /status === 'success'[\s\S]*<Check className="h-\[13px\] w-\[13px\]/)
  assert.match(rssFeed, /className="flex items-center justify-between border-b"/)
  assert.match(rssFeed, /padding: '19px 20px 19px 23px'/)
  assert.match(rssFeed, /className="rss-feed-scroll"/)
  assert.match(rssFeed, /gap:\s*8/)
  assert.match(rssFeed, /padding: '12px 11px 14px'/)
  assert.match(rssFeed, /className="rss-task-menu-row group rounded-\[16px\] transition-colors hover:bg-\[var\(--bg-hover\)\]"/)
  assert.match(rssFeed, /minHeight: 62/)
  assert.match(rssFeed, /padding: '10px 12px'/)
  assert.match(rssFeed, /className="flex h-6 items-center justify-center"/)
  assert.match(rssFeed, /className="text-\[12px\] font-semibold"/)
  assert.match(rssFeed, /className="mt-1\.5 flex min-w-0 items-center gap-1\.5 text-\[11px\]"/)
  assert.match(rssFeed, /className="mt-1\.5 truncate text-\[11px\]"/)
  assert.match(rssFeed, /columnGap: 14/)
  assert.match(rssFeed, /gridTemplateColumns: '20px minmax\(0, 1fr\) 64px'/)
  assert.match(rssFeed, /className="flex items-center justify-end gap-1\.5 opacity-70/)
  assert.match(rssFeed, /className="flex h-6 w-6 items-center justify-center rounded-\[8px\]/)
  assert.match(rssFeed, /<AnalysisProgressRing/)
  assert.match(rssFeed, /{roundedProgress}%/)
  assert.match(rssFeed, /className="shrink-0 rounded-full px-1\.5 py-\[1px\]"/)
  assert.match(rssFeed, /{analysisJobs\.length} 条记录 · {activeJobsCount} 个进行中/)
  assert.doesNotMatch(rssFeed, /className="border transition-colors"/)
  assert.doesNotMatch(rssFeed, /rounded-full border px-1\.5/)
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
