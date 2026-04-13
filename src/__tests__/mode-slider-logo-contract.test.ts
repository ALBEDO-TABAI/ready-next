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
  assert.doesNotMatch(modeSlider, /\{isReady \? '工作台' : 'Ready'\}/)
})
