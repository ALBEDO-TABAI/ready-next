import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('frozen mode slider uses the provided ready wordmark asset instead of plain text for the Ready side', () => {
  const modeSlider = readWorkspaceFile('src/renderer/components/layout/ModeSlider.tsx')

  assert.ok(existsSync(resolve(process.cwd(), 'src/renderer/assets/ready-wordmark.png')))
  assert.match(modeSlider, /import readyWordmark from '\.\.\/\.\.\/assets\/ready-wordmark\.png'/)
  assert.match(modeSlider, /<img[\s\S]*src=\{readyWordmark\}/)
  assert.doesNotMatch(modeSlider, /motion\.button/)
  assert.doesNotMatch(modeSlider, /opacity-50/)
  assert.doesNotMatch(modeSlider, /cursor-not-allowed/)
  assert.doesNotMatch(modeSlider, /模式切换已禁用/)
  assert.doesNotMatch(modeSlider, /const handleToggle =/)
  assert.doesNotMatch(modeSlider, /工作台/)
  assert.doesNotMatch(modeSlider, /\{isReady \? '工作台' : 'Ready'\}/)
  assert.match(modeSlider, /paddingLeft:\s*19/)
  assert.match(modeSlider, /width:\s*69/)
})
