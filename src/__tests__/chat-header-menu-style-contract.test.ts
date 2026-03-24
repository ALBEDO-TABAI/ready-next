import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  CHAT_HEADER_MENU_SECTION_LABEL_STYLE,
  CHAT_HEADER_MENU_META_STYLE,
  CHAT_HEADER_MENU_DELETE_BUTTON_STYLE,
  buildChatHeaderFloatingMenuStyle,
  buildChatHeaderMenuItemStyle,
} from '../renderer/components/agent/chatHeaderMenuStyles'

test('chat header dropdown menus use the lighter browser-like floating treatment', () => {
  const surfaceStyle = buildChatHeaderFloatingMenuStyle(300)
  const defaultItemStyle = buildChatHeaderMenuItemStyle()
  const activeItemStyle = buildChatHeaderMenuItemStyle({ selected: true })

  assert.equal(surfaceStyle.width, 300)
  assert.equal(surfaceStyle.borderRadius, 16)
  assert.equal(surfaceStyle.padding, 8)
  assert.match(String(surfaceStyle.background), /surface-floating-bg/)
  assert.match(String(surfaceStyle.boxShadow), /rgba\(15, 23, 42, 0\.16\)/)

  assert.equal(defaultItemStyle.borderRadius, 12)
  assert.equal(defaultItemStyle.padding, '10px 12px')
  assert.equal(defaultItemStyle.minHeight, 52)
  assert.equal(defaultItemStyle.background, 'transparent')

  assert.equal(activeItemStyle.background, 'var(--chat-menu-selected-bg, rgba(239,242,246,0.5))')
  assert.equal(activeItemStyle.border, '1px solid var(--chat-menu-selected-border, rgba(222,228,236,0.34))')

  assert.equal(CHAT_HEADER_MENU_SECTION_LABEL_STYLE.fontSize, 10)
  assert.equal(CHAT_HEADER_MENU_SECTION_LABEL_STYLE.letterSpacing, '0.04em')
  assert.equal(CHAT_HEADER_MENU_META_STYLE.fontSize, 10.5)
  assert.equal(CHAT_HEADER_MENU_DELETE_BUTTON_STYLE.opacity, 0.72)
})

test('chat header menus opt into the same layered glass treatment as browser floating surfaces', () => {
  const chatHeader = readFileSync(resolve(process.cwd(), 'src/renderer/components/agent/ChatHeader.tsx'), 'utf8')
  const styles = readFileSync(resolve(process.cwd(), 'src/renderer/styles/index.css'), 'utf8')

  assert.match(chatHeader, /glass-surface-floating chat-header-floating-menu/)
  assert.match(chatHeader, /chat-header-floating-menu-item/)
  assert.match(styles, /\.chat-header-floating-menu\s*\{/)
  assert.match(styles, /backdrop-filter:\s*blur\(calc\(var\(--lg-blur-strong\) \* 1\.24\)\)/)
  assert.match(styles, /background:\s*var\(--chat-menu-frost-bg, rgba\(236, 239, 243, 0\.84\)\) !important;/)
  assert.doesNotMatch(styles, /html\[data-skin='liquid-glass'\] \.chat-header-floating-menu\s*\{[^}]*radial-gradient/)
  assert.doesNotMatch(styles, /html\[data-skin='liquid-glass'\] \.chat-header-floating-menu-item\.is-selected\s*\{[^}]*linear-gradient/)
  assert.match(styles, /box-shadow:\s*\n\s*0 16px 34px rgba\(30, 46, 82, 0\.1\)/)
  assert.match(styles, /--chat-menu-frost-bg:\s*rgba\(236,\s*239,\s*243,\s*0\.84\);/)
  assert.match(styles, /--chat-menu-selected-bg:\s*rgba\(239,\s*242,\s*246,\s*0\.5\);/)
  assert.doesNotMatch(styles, /\.chat-header-floating-menu-item\.is-selected\s*\{[^}]*var\(--color-blue\)/)
})
