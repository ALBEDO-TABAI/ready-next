import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Folder, Link } from 'lucide-react'

import MorphIconRailGroup from '../renderer/components/motion/MorphIconRailGroup'
import { FolderFilled } from '../renderer/design/next/icons'

const items = [
  { id: 'folder', label: '文件', icon: Folder, activeIcon: FolderFilled },
  { id: 'backlinks', label: '反向链接', icon: Link },
]

function renderRail(activeId: string, expanded: boolean): string {
  return renderToStaticMarkup(createElement(MorphIconRailGroup, { items, activeId, expanded, layoutId: 'icon-rail-test' }))
}

function buttonFor(markup: string, label: string): string {
  const match = markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>[\\s\\S]*?</button>`))
  assert.ok(match, `${label} button should render`)
  return match[0]
}

test('closed-shape rail items carry a filled glyph that the active state swaps in', () => {
  const folder = buttonFor(renderRail('folder', true), '文件')

  assert.match(folder, /class="icon-rail-slider__button\s*is-active"/)
  assert.match(folder, /aria-pressed="true"/)
  assert.match(folder, /data-active-glyph="fill"/)
  assert.match(folder, /class="[^"]*icon-rail-slider__glyph is-outline[^"]*"/)
  assert.match(folder, /class="[^"]*icon-rail-slider__glyph is-filled[^"]*"/)
})

test('open-stroke rail items have no filled glyph and fall back to the stroke treatment', () => {
  const link = buttonFor(renderRail('backlinks', true), '反向链接')

  assert.match(link, /is-active/)
  assert.match(link, /data-active-glyph="stroke"/)
  assert.match(link, /icon-rail-slider__glyph is-outline/)
  assert.doesNotMatch(link, /is-filled/)
})

test('collapsed side panel keeps the selected item remembered instead of active', () => {
  const markup = renderRail('folder', false)
  const folder = buttonFor(markup, '文件')

  assert.match(folder, /is-remembered/)
  assert.doesNotMatch(folder, /is-active/)
  assert.match(folder, /aria-pressed="false"/)
  assert.doesNotMatch(buttonFor(markup, '反向链接'), /is-(?:active|remembered)/)
})
