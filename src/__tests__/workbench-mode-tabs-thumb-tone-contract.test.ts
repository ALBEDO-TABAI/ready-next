import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench mode tabs thumb base stays only slightly darker than the edge highlight', () => {
  const styles = readWorkspaceFile('src/renderer/styles/workbench-sliders.css')

  assert.match(
    styles,
    /\.draggable-mode-tabs__thumb\s*\{[\s\S]*?linear-gradient\(180deg,\s*rgba\(244,\s*242,\s*237,\s*0\.76\)\s*0%,\s*rgba\(233,\s*229,\s*221,\s*0\.72\)\s*100%\s*\)/,
  )

  assert.match(
    styles,
    /html\[data-skin='liquid-glass'\]\s+\.draggable-mode-tabs__thumb\s*\{[\s\S]*?linear-gradient\(180deg,\s*rgba\(244,\s*242,\s*237,\s*0\.76\)\s*0%,\s*rgba\(233,\s*229,\s*221,\s*0\.72\)\s*100%\s*\)/,
  )

  assert.match(
    styles,
    /\.draggable-mode-tabs__icon\s*\{[\s\S]*?z-index:\s*3;/,
  )
})
