import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench init, calendar loading, and markdown loading expose real failures instead of silently faking success', () => {
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const calendarMode = readWorkspaceFile('src/renderer/pages/modes/CalendarMode.tsx')
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')

  assert.match(workbenchMode, /workspaceInitError/)
  assert.doesNotMatch(workbenchMode, /fallback to mock files/)
  assert.doesNotMatch(workbenchMode, /await refreshFiles\(\)/)

  assert.match(calendarMode, /loadError/)
  assert.doesNotMatch(calendarMode, /setEvents\(createDefaultEvents\(\)\)/)
  assert.doesNotMatch(calendarMode, /setSources\(DEFAULT_SOURCES\)/)
  assert.doesNotMatch(calendarMode, /setIsMock\(true\)/)

  assert.match(markdownEditor, /loadError/)
  assert.doesNotMatch(markdownEditor, /# 暂不支持该格式/)
  assert.doesNotMatch(markdownEditor, /# 文件读取失败/)
  assert.match(markdownEditor, /文件暂不支持直接编辑/)
  assert.match(markdownEditor, /文档加载失败/)
})
