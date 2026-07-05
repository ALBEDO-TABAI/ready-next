import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function findCssBlock(source: string, selector: string): string {
  const start = source.indexOf(selector)
  assert.notEqual(start, -1, `${selector} should exist`)
  const open = source.indexOf('{', start)
  assert.notEqual(open, -1, `${selector} should have a declaration block`)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    if (character === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  assert.fail(`${selector} declaration block should close`)
}

test('workbench mode tabs thumb base stays only slightly darker than the edge highlight', () => {
  // thumb 规则已从 workbench-sliders.css 归并进 index.css（滑块样式泛化整合）
  const styles = readRendererStyles()
  const liquidThumb = findCssBlock(styles, "html[data-skin='liquid-glass'] .draggable-mode-tabs__thumb")

  assert.match(
    styles,
    /\.draggable-mode-tabs__thumb\s*\{[\s\S]*?linear-gradient\(180deg,\s*rgba\(244,\s*242,\s*237,\s*0\.76\)\s*0%,\s*rgba\(233,\s*229,\s*221,\s*0\.72\)\s*100%\s*\)/,
  )

  assert.match(liquidThumb, /radial-gradient\(ellipse 110% 62% at 50% -12%/)
  assert.doesNotMatch(liquidThumb, /rgba\(244,\s*242,\s*237,\s*0\.76\)/)
  assert.doesNotMatch(liquidThumb, /rgba\(233,\s*229,\s*221,\s*0\.72\)/)

  assert.match(
    styles,
    /\.draggable-mode-tabs__icon\s*\{[\s\S]*?z-index:\s*3;/,
  )
})
