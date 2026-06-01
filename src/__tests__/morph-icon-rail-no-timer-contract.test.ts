import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('MorphIconRailGroup no longer drives thumb state through setTimeout chains', () => {
  const source = readWorkspaceFile('src/renderer/components/motion/MorphIconRailGroup.tsx')

  assert.doesNotMatch(source, /setTimeout/)
  assert.doesNotMatch(source, /THUMB_REOPEN_DELAY_MS/)
  assert.doesNotMatch(source, /THUMB_REST_SETTLE_MS/)
  assert.doesNotMatch(source, /slideTimerRef/)
  assert.doesNotMatch(source, /settleTimerRef/)
  assert.doesNotMatch(source, /thumbState/)
  // The rail container exposes expanded state via a data attribute for CSS to read.
  assert.match(source, /data-expanded=\{expanded \? 'true' : 'false'\}/)
})

test('workbench-sliders.css only sinks the icon rail thumb when the side panel is collapsed', () => {
  const css = readWorkspaceFile('src/renderer/styles/workbench-sliders.css')

  assert.match(css, /\.icon-rail-slider\[data-expanded='false'\] \.icon-rail-slider__thumb/)
  assert.doesNotMatch(css, /\.icon-rail-slider:has\(\.icon-rail-slider__button:active\) \.icon-rail-slider__thumb/)
  assert.doesNotMatch(css, /\.icon-rail-slider__thumb\.is-pressing/)
  assert.doesNotMatch(css, /\.icon-rail-slider__thumb\.is-resting/)
  assert.doesNotMatch(css, /\.icon-rail-slider__thumb\.is-elevated/)
})
