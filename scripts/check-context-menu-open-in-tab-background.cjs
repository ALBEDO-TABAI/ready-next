#!/usr/bin/env node
'use strict'

// Phase 0 (2026-07-07-vertical-tab-open-in-new-tab-fix): the right-click
// "在新标签页打开链接/图片" items must open in the BACKGROUND. The fix spans two
// files and has TWO silent-regression vectors that typecheck alone cannot catch:
//   1. A call site reverting to the foreground `createTab(url)` form. (A lone
//      call-site revert to `createTab(url)` compiles fine and silently reopens
//      the "tab never appears in strip" bug.)
//   2. The ipc-handler host wiring reverting to `(url) => this.createTab(url)`,
//      which drops the options argument on the floor. TypeScript accepts an arrow
//      that ignores extra params, so this regression is invisible to the compiler
//      while making the call sites' {background:true} a no-op.
// This static gate locks both. It is deliberately identifier-agnostic (menu items
// are located by their stable user-facing labels, and param/URL-variable names are
// wildcards) so behavior-identical reformats do NOT false-fail the browser lane —
// only a real foreground revert / background:false / options-drop / missing item
// trips it. The load-bearing mechanism (background create → browser:tabOpened
// {activate:false} → renderer lists without preempting) is behavior-tested in
// src/__tests__/browser-tab-lifecycle-tabopened.test.ts.

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

// createTab(<any identifier>, { ... background: true ... }) — URL variable name irrelevant.
const BACKGROUND_CALL = /createTab\(\s*[A-Za-z_$][\w$]*\s*,\s*\{[^}]*background:\s*true[^}]*\}\s*\)/

const OPEN_IN_TAB_ITEMS = [
  { label: '在新标签页打开链接', code: 'link_open_in_tab' },
  { label: '在新标签页打开图片', code: 'image_open_in_tab' },
]

function check({ root = ROOT } = {}) {
  const errors = []
  const readAt = (relPath) => fs.readFileSync(path.join(root, relPath), 'utf8')

  const menu = stripComments(readAt('src/main/modules/browser-engine/context-menu-service.ts'))
  const ipc = stripComments(readAt('src/main/modules/browser-engine/browser-controller-composition.ts'))

  // 1 & 2. Each "open in new tab" menu item — located by its stable user-facing
  // label — must call createTab with { background: true } inside its click handler.
  // Scoping to the label (not the URL variable) detects a per-item foreground
  // revert / background:false / deletion while tolerating a variable rename.
  for (const item of OPEN_IN_TAB_ITEMS) {
    const at = menu.indexOf(`label: '${item.label}'`)
    if (at === -1) {
      errors.push(`${item.code}_menu_item_missing`)
      continue
    }
    // Bound the window to THIS item's click handler by stopping at the next menu
    // item label, so a fixed-size window can never bleed into a sibling item's
    // createTab call and false-pass (e.g. read the neighbour's background:true).
    const nextLabel = menu.indexOf('label: ', at + 1)
    const end = nextLabel === -1 ? at + 300 : Math.min(nextLabel, at + 300)
    const clickWindow = menu.slice(at, end)
    if (!BACKGROUND_CALL.test(clickWindow)) {
      errors.push(`${item.code}_not_background`)
    }
  }

  // 3. Host interface must accept an options bag carrying `background` (param name
  //    irrelevant). Belt-and-suspenders against a silent re-narrowing to
  //    createTab(url) — which typecheck would also catch at the call sites.
  if (!/createTab\(\s*\w+:\s*string\s*,\s*\w+\?:\s*\{[^}]*background\?:\s*boolean/.test(menu)) {
    errors.push('context_menu_host_createtab_not_widened')
  }

  // 4. The contextMenuService host wiring must FORWARD two args (not drop options).
  //    Scoped to the contextMenuService construction so the other, intentionally
  //    url-only, host wirings (BrowserCapabilityService / split-view host) can't
  //    mask a regression here. Param names are wildcards.
  const anchor = ipc.indexOf('new BrowserContextMenuService(')
  if (anchor === -1) {
    errors.push('context_menu_service_construction_not_found')
  } else {
    const window = ipc.slice(anchor, anchor + 600)
    if (!/createTab:\s*\(\s*\w+\s*,\s*\w+\s*\)\s*=>\s*this\.createTab\(\s*\w+\s*,\s*\w+\s*\)/.test(window)) {
      errors.push('ipc_context_menu_wiring_drops_options')
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-context-menu-open-in-tab-background] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-context-menu-open-in-tab-background] OK')
}

module.exports = { check }
