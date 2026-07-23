'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const { check } = require('../check-context-menu-open-in-tab-background.cjs')

function writeFixture(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
}

// A helper to build a context-menu-service fixture with the two open-in-tab items.
function menuSource({ iface, linkCall, imageCall }) {
  return `
    interface BrowserContextMenuHost {
      ${iface}
    }
    const template = [
      { label: '在新标签页打开链接', click: () => { void ${linkCall}.catch(() => {}) } },
      { label: '在新标签页打开图片', click: () => { void ${imageCall}.catch(() => {}) } },
    ]
  `
}

function ipcSource(wiring) {
  return `
    this.contextMenuService = new BrowserContextMenuService({
      ${wiring},
    })
  `
}

test('context-menu open-in-tab background gate passes the current workspace', () => {
  const result = check()
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate rejects a full foreground regression (call sites + interface + wiring)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-ctxmenu-bg-gate-'))
  writeFixture(root, {
    'src/main/modules/browser-engine/context-menu-service.ts': menuSource({
      iface: 'createTab(url: string): Promise<{ success: boolean }>',
      linkCall: 'this.host.createTab(linkUrl)',
      imageCall: 'this.host.createTab(imageUrl)',
    }),
    'src/main/modules/browser-engine/browser-controller-composition.ts': ipcSource('createTab: (url) => this.createTab(url)'),
  })
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.includes('link_open_in_tab_not_background'))
  assert.ok(result.errors.includes('image_open_in_tab_not_background'))
  assert.ok(result.errors.includes('context_menu_host_createtab_not_widened'))
  assert.ok(result.errors.includes('ipc_context_menu_wiring_drops_options'))
})

test('gate catches the silent options-drop even when call sites are correct', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-ctxmenu-bg-gate-'))
  writeFixture(root, {
    'src/main/modules/browser-engine/context-menu-service.ts': menuSource({
      iface: 'createTab(url: string, options?: { background?: boolean }): Promise<{ success: boolean }>',
      linkCall: 'this.host.createTab(linkUrl, { background: true })',
      imageCall: 'this.host.createTab(imageUrl, { background: true })',
    }),
    'src/main/modules/browser-engine/browser-controller-composition.ts': ipcSource('createTab: (url) => this.createTab(url)'),
  })
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(
    result.errors.includes('ipc_context_menu_wiring_drops_options'),
    'wiring guard must fire independently of the call-site guards',
  )
  assert.ok(!result.errors.includes('link_open_in_tab_not_background'))
  assert.ok(!result.errors.includes('image_open_in_tab_not_background'))
  assert.ok(!result.errors.includes('context_menu_host_createtab_not_widened'))
})

test('gate catches background:false masquerading as an options bag', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-ctxmenu-bg-gate-'))
  writeFixture(root, {
    'src/main/modules/browser-engine/context-menu-service.ts': menuSource({
      iface: 'createTab(url: string, options?: { background?: boolean }): Promise<{ success: boolean }>',
      linkCall: 'this.host.createTab(linkUrl, { background: false })',
      imageCall: 'this.host.createTab(imageUrl, { background: true })',
    }),
    'src/main/modules/browser-engine/browser-controller-composition.ts': ipcSource('createTab: (url, options) => this.createTab(url, options)'),
  })
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.includes('link_open_in_tab_not_background'))
  assert.ok(!result.errors.includes('image_open_in_tab_not_background'))
})

test('gate detects a deleted open-in-tab menu item (not just a foreground revert)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-ctxmenu-bg-gate-'))
  writeFixture(root, {
    'src/main/modules/browser-engine/context-menu-service.ts': `
      interface BrowserContextMenuHost {
        createTab(url: string, options?: { background?: boolean }): Promise<{ success: boolean }>
      }
      const template = [
        { label: '在新标签页打开链接', click: () => { void this.host.createTab(linkUrl, { background: true }).catch(() => {}) } },
      ]
    `,
    'src/main/modules/browser-engine/browser-controller-composition.ts': ipcSource('createTab: (url, options) => this.createTab(url, options)'),
  })
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(
    result.errors.includes('image_open_in_tab_menu_item_missing'),
    'label-scoped check must notice the image item is gone',
  )
})

test('gate does NOT false-fail on behavior-identical reformats (P3 regression guard)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-ctxmenu-bg-gate-'))
  writeFixture(root, {
    // URL hoisted to a local alias; interface + wiring params renamed. All no-ops.
    'src/main/modules/browser-engine/context-menu-service.ts': menuSource({
      iface: 'createTab(target: string, opts?: { background?: boolean }): Promise<{ success: boolean }>',
      linkCall: '(() => { const link = linkUrl; return this.host.createTab(link, { background: true }) })()',
      imageCall: '(() => { const pic = imageUrl; return this.host.createTab(pic, { background: true }) })()',
    }),
    'src/main/modules/browser-engine/browser-controller-composition.ts': ipcSource('createTab: (u, o) => this.createTab(u, o)'),
  })
  const result = check({ root })
  assert.equal(result.ok, true, `reformats must not false-fail: ${result.errors.join(', ')}`)
})
