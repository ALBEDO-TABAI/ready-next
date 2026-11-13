import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHAT_HEADER_MENU_SECTION_LABEL_STYLE,
  CHAT_HEADER_MENU_META_STYLE,
  CHAT_HEADER_MENU_ROW_CLASS,
  buildChatHeaderFloatingMenuStyle,
  buildChatHeaderMenuItemStyle,
} from '../renderer/components/agent/chatHeaderMenuStyles'

test('chat header menu rows carry layout and --rn-* inks only; the float material comes from the panel', () => {
  const surfaceStyle = buildChatHeaderFloatingMenuStyle(300)
  const defaultItemStyle = buildChatHeaderMenuItemStyle()
  const activeItemStyle = buildChatHeaderMenuItemStyle({ selected: true })

  assert.equal(surfaceStyle.width, 300)
  assert.equal(surfaceStyle.padding, 8)
  // W1 DL4: no private surface (background, border, shadow, blur) — FloatPanel's .rn-float draws it.
  for (const key of ['background', 'border', 'boxShadow', 'backdropFilter', 'WebkitBackdropFilter'] as const) {
    assert.equal(surfaceStyle[key], undefined, `surface must not set ${key}`)
  }

  assert.equal(defaultItemStyle.padding, '10px 12px')
  assert.equal(defaultItemStyle.minHeight, 52)
  // An inline background would block the hover class, so only the selected source sets one.
  assert.equal(defaultItemStyle.background, undefined)
  assert.equal(activeItemStyle.background, 'var(--rn-fill-2)')
  assert.match(CHAT_HEADER_MENU_ROW_CLASS, /hover:bg-\[var\(--rn-fill\)\]/)

  assert.equal(CHAT_HEADER_MENU_SECTION_LABEL_STYLE.fontSize, 'var(--rn-fs-2xs)')
  assert.equal(CHAT_HEADER_MENU_SECTION_LABEL_STYLE.letterSpacing, '0.04em')
  assert.equal(CHAT_HEADER_MENU_SECTION_LABEL_STYLE.color, 'var(--rn-ink-3)')
  // V7: off-scale 10.5 moved onto the micro level (11px).
  assert.equal(CHAT_HEADER_MENU_META_STYLE.fontSize, 11)
  assert.equal(CHAT_HEADER_MENU_META_STYLE.color, 'var(--rn-ink-3)')
})
