import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('document mode toggle follows refined iOS Segmented Control style', () => {
  const documentMode = readWorkspaceFile('src/renderer/pages/modes/DocumentMode.tsx')
  const modeSwitch = readWorkspaceFile('src/renderer/components/document/DraggableModeSwitch.tsx')
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(documentMode, /<DraggableModeSwitch\s+mode=\{editorMode\}\s+onChange=\{handleEditorModeChange\}/)
  assert.match(documentMode, /const handleEditorModeChange = useCallback/)
  assert.match(documentMode, /captureVisibleDocumentScrollPositions\(\)[\s\S]*?setEditorMode\(nextMode\)/)
  assert.match(modeSwitch, /className="draggable-mode-switch"/)
  assert.match(modeSwitch, /draggable-mode-switch__thumb/)
  assert.match(modeSwitch, /draggable-mode-switch__label/)
  assert.match(modeSwitch, /position < 0\.5 \? 'is-active' : ''/)

  // 更小巧的尺寸
  assert.match(styles, /\.draggable-mode-switch\s*\{[\s\S]*?height:\s*30px/)
  assert.match(styles, /\.draggable-mode-switch\s*\{[\s\S]*?padding:\s*2px/)
  // 滑块紧贴边缘 (100% - 4px)
  assert.match(styles, /\.draggable-mode-switch__thumb\s*\{[\s\S]*?width:\s*calc\(\(100% - 4px\) \/ 2\)/)
  assert.match(styles, /\.draggable-mode-switch__thumb\s*\{[\s\S]*?top:\s*2px/)
  assert.match(styles, /\.draggable-mode-switch__thumb\s*\{[\s\S]*?left:\s*2px/)
  // 滑块边缘高光
  assert.match(styles, /\.draggable-mode-switch__thumb::before\s*\{[\s\S]*?border:/)
  assert.match(styles, /\.draggable-mode-switch__thumb::after\s*\{[\s\S]*?background:\s*linear-gradient/)
  // 更小的字号
  assert.match(styles, /\.draggable-mode-switch__label\s*\{[\s\S]*?font-size:\s*11px/)
  assert.match(styles, /\.draggable-mode-switch__label\.is-active\s*\{[\s\S]*?font-weight:\s*500/)
})
