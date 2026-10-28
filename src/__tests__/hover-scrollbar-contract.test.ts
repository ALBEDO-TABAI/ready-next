import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench panel scroll areas hide scrollbar thumbs until the user hovers the panel', () => {
  const styles = readRendererStyles()
  const scheduleStyles = readWorkspaceFile('src/renderer/modules/calendar/workbench/styles/app.css')
  const fileTree = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')
  const chatMessages = readWorkspaceFile('src/renderer/components/agent/ChatMessages.tsx')
  const globalSearch = readWorkspaceFile('src/renderer/components/layout/GlobalSearchPanel.tsx')
  const skillsPanel = readWorkspaceFile('src/renderer/components/layout/SkillsCenterPanel.tsx')
  const browserSidePanel = readWorkspaceFile('src/renderer/components/browser/BrowserSidePanel.tsx')
  const calendarShell = readWorkspaceFile('src/renderer/modules/calendar/workbench/components/Sidebar.tsx')
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')
  const pdfViewer = readWorkspaceFile('src/renderer/components/document/PdfViewer.tsx')
  const imageGallery = readWorkspaceFile('src/renderer/components/document/ImageGallery.tsx')

  assert.match(styles, /\.panel-hover-scrollbar\s*\{/)
  assert.match(styles, /\.panel-hover-scrollbar::-webkit-scrollbar-thumb\s*\{/)
  assert.match(styles, /background:\s*transparent;/)
  assert.match(styles, /\.panel-hover-scrollbar:hover::-webkit-scrollbar-thumb\s*\{/)
  assert.match(styles, /scrollbar-color:\s*transparent transparent;/)

  assert.match(fileTree, /panel-hover-scrollbar/)
  assert.match(chatMessages, /panel-hover-scrollbar/)
  assert.match(globalSearch, /panel-hover-scrollbar/)
  assert.match(skillsPanel, /panel-hover-scrollbar/)
  assert.match(browserSidePanel, /panel-hover-scrollbar/)
  assert.match(calendarShell, /panel-hover-scrollbar/)
  assert.match(markdownEditor, /panel-hover-scrollbar document-editor-surface flex-1 overflow-auto/)
  assert.match(markdownEditor, /panel-hover-scrollbar document-preview-surface flex-1 overflow-auto/)
  assert.match(pdfViewer, /panel-hover-scrollbar flex-1 overflow-auto/)
  assert.match(imageGallery, /panel-hover-scrollbar flex-1 flex items-center justify-center overflow-auto/)

  assert.match(scheduleStyles, /\.ready-calendar ::-webkit-scrollbar-thumb\s*\{/)
  assert.match(scheduleStyles, /\.ready-calendar:hover ::-webkit-scrollbar-thumb\s*\{/)
})
