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

test('workbench-sliders.css keeps no icon rail thumb after the flush-rail redesign', () => {
  const css = readWorkspaceFile('src/renderer/styles/workbench-sliders.css')

  // 2026-10-30 图标列贴边化：thumb 及其按压/休眠态全部退役；收起侧栏时由按钮 is-remembered 保留激活字形。
  assert.doesNotMatch(css, /\.icon-rail-slider__thumb/)
  assert.match(css, /\.icon-rail-slider__button:is\(\.is-active, \.is-remembered\)/)
})
