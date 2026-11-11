import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('frozen mode slider renders the Ready brand dot instead of the wordmark image or plain text', () => {
  const modeSlider = readWorkspaceFile('src/renderer/components/layout/ModeSlider.tsx')

  // 8ab48cd7 style(ui): checkpoint liquid glass polish — Ready 侧从 wordmark 图片改为 14px 品牌圆点
  //（背景走唯一的 --rn-accent token；wordmark 资产保留在仓库但不再被 ModeSlider 引用）。
  assert.ok(existsSync(resolve(process.cwd(), 'src/renderer/assets/ready-wordmark.png')))
  assert.doesNotMatch(modeSlider, /import readyWordmark/)
  assert.doesNotMatch(modeSlider, /<img/)
  assert.match(modeSlider, /role="img"/)
  assert.match(modeSlider, /aria-label="Ready"/)
  assert.match(modeSlider, /width: 14,\s+height: 14,\s+borderRadius: 999,/)
  assert.match(modeSlider, /background: 'var\(--rn-accent\)'/)
  assert.doesNotMatch(modeSlider, /motion\.button/)
  assert.doesNotMatch(modeSlider, /opacity-50/)
  assert.doesNotMatch(modeSlider, /cursor-not-allowed/)
  assert.doesNotMatch(modeSlider, /模式切换已禁用/)
  assert.doesNotMatch(modeSlider, /const handleToggle =/)
  assert.doesNotMatch(modeSlider, /工作台/)
  assert.doesNotMatch(modeSlider, /\{isReady \? '工作台' : 'Ready'\}/)
  assert.match(modeSlider, /w-\[96px\]/)
  assert.match(modeSlider, /justify-end/)
  assert.doesNotMatch(modeSlider, /paddingLeft/)
  assert.match(modeSlider, /marginRight:\s*-1/)
})
