import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench panel scroll areas hide scrollbar thumbs until the user hovers the panel', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')
  const scheduleStyles = readWorkspaceFile('src/renderer/styles/schedule-x.css')
  const fileTree = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const globalSearch = readWorkspaceFile('src/renderer/components/layout/GlobalSearchPanel.tsx')
  const skillsPanel = readWorkspaceFile('src/renderer/components/layout/SkillsCenterPanel.tsx')
  const browserSidePanel = readWorkspaceFile('src/renderer/components/browser/BrowserSidePanel.tsx')
  const calendarMode = readWorkspaceFile('src/renderer/pages/modes/CalendarMode.tsx')
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')
  const pdfViewer = readWorkspaceFile('src/renderer/components/document/PdfViewer.tsx')
  const imageGallery = readWorkspaceFile('src/renderer/components/document/ImageGallery.tsx')

  assert.match(styles, /\.panel-hover-scrollbar\s*\{/)
  assert.match(styles, /\.panel-hover-scrollbar::-webkit-scrollbar-thumb\s*\{/)
  assert.match(styles, /background:\s*transparent;/)
  assert.match(styles, /\.panel-hover-scrollbar:hover::-webkit-scrollbar-thumb\s*\{/)
  assert.match(styles, /scrollbar-color:\s*transparent transparent;/)

  assert.match(fileTree, /panel-hover-scrollbar/)
  assert.match(chatPanel, /panel-hover-scrollbar/)
  assert.match(globalSearch, /panel-hover-scrollbar/)
  assert.match(skillsPanel, /panel-hover-scrollbar/)
  assert.match(browserSidePanel, /panel-hover-scrollbar/)
  assert.match(calendarMode, /panel-hover-scrollbar/)
  assert.match(markdownEditor, /panel-hover-scrollbar document-editor-surface flex-1 overflow-auto/)
  assert.match(markdownEditor, /panel-hover-scrollbar document-preview-surface flex-1 overflow-auto/)
  assert.match(pdfViewer, /panel-hover-scrollbar flex-1 overflow-auto/)
  assert.match(imageGallery, /panel-hover-scrollbar flex-1 flex items-center justify-center overflow-auto/)

  assert.match(scheduleStyles, /\.sx__calendar-wrapper ::-webkit-scrollbar-thumb\s*\{/)
  assert.match(scheduleStyles, /\.sx__calendar-wrapper:hover ::-webkit-scrollbar-thumb\s*\{/)
})
