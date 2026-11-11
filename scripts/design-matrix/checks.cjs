// In-page checks for the W1 design matrix. `collect` runs inside the renderer via page.evaluate,
// so it must stay self-contained (no closures over Node values).
//
// Each check returns violations as stable signatures (selector-like strings), so a list that
// grows by ten identical rows still counts once. The matrix totals distinct signatures per check.

// Paper and well are the W1 materials. Until the W2 shell lands, each mode's legacy content
// surface stands in for the paper; the list is ordered, first visible match wins.
const LEGACY_SHEETS = {
  document: ['.ink-doc-app main.ink-main', '.rn-library', '.ink-doc-app'],
  rss: ['.rss-article-reader', '.rss-feed-sheet', '.rss-workbench-body'],
  calendar: ['.ready-calendar main.main', '.ready-calendar'],
  browser: ['[data-ready-native-surface="browser"]', '[data-browser-content-frame]'],
}

function collect(input) {
  const { mode, legacySheets, checkLayout } = input
  const W = window.innerWidth
  const H = window.innerHeight
  const root = document.documentElement
  const css = getComputedStyle(root)
  const token = name => css.getPropertyValue(name).trim()

  const visible = el => {
    if (!el || !el.isConnected) return false
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    if (r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05
  }
  const signature = el => {
    const parts = []
    let node = el
    for (let depth = 0; node && node !== document.body && depth < 3; depth += 1) {
      const cls = typeof node.className === 'string'
        ? node.className.split(/\s+/).filter(c => c && !/[:[\]/]/.test(c)).slice(0, 2).join('.')
        : ''
      const label = node.getAttribute?.('aria-label')
      parts.unshift(`${node.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${label && depth === 0 ? `[${label.slice(0, 16)}]` : ''}`)
      node = node.parentElement
    }
    return parts.join('>')
  }
  const box = el => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }
  }

  // Canvas-normalise a colour string to "r,g,b,a" so token values and computed values compare.
  const probe = document.createElement('canvas').getContext('2d')
  const norm = value => {
    if (!value || value === 'transparent' || value === 'none') return null
    probe.fillStyle = '#000'
    probe.fillStyle = value
    const v = probe.fillStyle
    if (v.startsWith('#')) {
      const n = parseInt(v.slice(1), 16)
      return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},1`
    }
    const m = v.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const [r, g, b, a = '1'] = m[1].split(',').map(s => s.trim())
    return `${r},${g},${b},${Number(a).toFixed(2).replace(/\.?0+$/, '') || '0'}`
  }
  const rgbOnly = value => (value ? value.split(',').slice(0, 3).join(',') : null)

  const result = { size: `${W}x${H}`, theme: root.dataset.theme ?? null, transparency: root.dataset.transparency ?? null, measures: {}, violations: {} }
  const add = (check, sig) => {
    if (!result.violations[check]) result.violations[check] = []
    if (!result.violations[check].includes(sig)) result.violations[check].push(sig)
  }

  // ---- regions ----
  const pick = selectors => {
    for (const selector of selectors) {
      const el = [...document.querySelectorAll(selector)].find(visible)
      if (el) return { selector, el }
    }
    return null
  }
  const sheet = pick(['.rn-sheet', '.rn-well', ...(legacySheets ?? [])])
  const assistant = pick(['[data-shell-region="assistant"]', '[data-chat-panel-root]'])
  const composer = pick(['[data-chat-composer-shell="true"]'])
  if (sheet) result.measures.sheet = { selector: sheet.selector, ...box(sheet.el) }
  if (assistant) result.measures.assistant = box(assistant.el)
  if (composer) result.measures.composer = box(composer.el)

  if (checkLayout) {
    if (!sheet) add('contentWidth', `${mode}:no-content-surface`)
    else {
      const width = sheet.el.getBoundingClientRect().width
      const ratio = width / W
      const assistantOpen = Boolean(assistant && assistant.el.getBoundingClientRect().width > 40)
      result.measures.contentRatio = Number(ratio.toFixed(3))
      result.measures.assistantOpen = assistantOpen
      // G1: at the wide size the paper takes at least half the window with the assistant open,
      // 68% with it closed; at the narrow size it keeps at least 560px.
      const wide = W >= 1300
      const pass = wide ? ratio >= (assistantOpen ? 0.5 : 0.68) : width >= 560
      if (!pass) add('contentWidth', `${mode}:${wide ? 'wide' : 'narrow'}`)
      // DL11a: equal bands above and below the paper; the composer's bottom edge sits on the paper's.
      const r = sheet.el.getBoundingClientRect()
      const top = Math.round(r.top)
      const bottom = Math.round(H - r.bottom)
      result.measures.bands = { top, bottom }
      if (Math.abs(top - bottom) > 2) add('bandSymmetry', `${mode}:${top}/${bottom}`)
      if (composer && assistantOpen) {
        const delta = Math.round(composer.el.getBoundingClientRect().bottom - r.bottom)
        result.measures.composerDelta = delta
        if (Math.abs(delta) > 2) add('composerAlign', `${mode}`)
      }
    }
  }

  // ---- overflow: the page itself never scrolls sideways; the paper never clips sideways ----
  const scroller = document.scrollingElement
  if (scroller && scroller.scrollWidth > W + 1) add('overflow', 'document')
  if (sheet) {
    const cs = getComputedStyle(sheet.el)
    if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && sheet.el.scrollWidth > sheet.el.clientWidth + 1) add('overflow', signature(sheet.el))
  }

  // ---- UI font (DL7): chrome text uses the first family of --rn-font-ui; the mono family only
  // for numbers, the serif family for at most one display moment per screen. Book spines are
  // objects with their own cloth typography, not interface text. ----
  const uiFamily = (token('--rn-font-ui').split(',')[0] || '').replace(/['"]/g, '').trim()
  const monoFamily = (token('--rn-font-mono').split(',')[0] || '').replace(/['"]/g, '').trim()
  const serifFamily = (token('--rn-font-serif').split(',')[0] || '').replace(/['"]/g, '').trim()
  const contentScopes = '[contenteditable="true"], [data-ready-block-editor], .document-preview-layout, .note-preview-shell, .rss-article-body, .rss-article-content, .rn-reader-page, .rn-library .page, .rn-library .spine, pre, code, kbd, samp, svg, canvas, iframe, webview'
  const textElements = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue || !node.nodeValue.trim()) continue
    const el = node.parentElement
    if (!el || textElements.includes(el)) continue
    if (el.closest(contentScopes)) continue
    if (!visible(el)) continue
    textElements.push(el)
  }
  result.measures.uiFamily = uiFamily
  let displaySerifs = 0
  for (const el of textElements) {
    const first = getComputedStyle(el).fontFamily.split(',')[0].replace(/['"]/g, '').trim()
    if (first === uiFamily) continue
    if (first === monoFamily && /^[\d\s:.,/%+\-–—()#×xX]+$/.test(el.textContent.trim())) continue
    if (first === serifFamily && displaySerifs === 0) { displaySerifs += 1; continue }
    add('uiFont', `${signature(el)}{${first}}`)
  }

  // ---- current item: carries the signal colour (G4). The rail follows its own white-glyph rule. ----
  const accents = new Set([token('--rn-accent'), token('--rn-accent-text'), token('--rn-accent-soft')].map(norm).filter(Boolean).map(rgbOnly))
  result.measures.accent = token('--rn-accent')
  const currentSelector = '[aria-current]:not([aria-current="false"]), [aria-selected="true"], [data-active="true"], [data-state="active"]'
  const carriesAccent = el => {
    const nodes = [el, ...el.querySelectorAll('*')].slice(0, 40)
    for (const node of nodes) {
      for (const pseudo of [null, '::before', '::after']) {
        if (pseudo && node !== el) continue
        const cs = getComputedStyle(node, pseudo)
        for (const prop of ['color', 'backgroundColor', 'borderLeftColor', 'borderBottomColor', 'borderTopColor', 'outlineColor', 'fill', 'stroke', 'textDecorationColor']) {
          const value = rgbOnly(norm(cs[prop]))
          if (value && accents.has(value)) return true
        }
        const shadow = cs.boxShadow
        if (shadow && shadow !== 'none') {
          for (const match of shadow.matchAll(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/gi)) if (accents.has(rgbOnly(norm(match[0])))) return true
        }
      }
    }
    return false
  }
  for (const el of document.querySelectorAll(currentSelector)) {
    if (!visible(el)) continue
    if (el.closest('[data-liquid-shell="icon-rail"], [data-shell-region="rail"]')) continue
    // Menu and listbox options show keyboard selection, not "where you are"; they are not the signal.
    if (['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox'].includes(el.getAttribute('role'))) continue
    if (!carriesAccent(el)) add('currentAccent', signature(el))
  }

  // ---- native controls: no browser default appearance ----
  // Chromium's ButtonFace in light and dark.
  const buttonFace = new Set(['239,239,239', '240,240,240', '233,233,237', '107,107,107', '59,59,59'])
  for (const el of document.querySelectorAll('button, input, select, textarea')) {
    if (!visible(el)) continue
    if (el.closest('[contenteditable="true"]')) continue
    const cs = getComputedStyle(el)
    const appearance = cs.appearance || cs.webkitAppearance
    const type = el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : el.tagName.toLowerCase()
    if (type === 'hidden' || type === 'file') continue
    const borderStyles = [cs.borderTopStyle, cs.borderLeftStyle]
    const defaultBorder = borderStyles.some(s => s === 'outset' || s === 'inset')
    const bg = rgbOnly(norm(cs.backgroundColor))
    let flagged = false
    if (type === 'button' || type === 'submit' || type === 'reset' || el.tagName === 'BUTTON') {
      flagged = defaultBorder || (bg && buttonFace.has(bg) && appearance !== 'none')
    } else if (['checkbox', 'radio', 'range', 'color', 'select'].includes(type)) {
      flagged = appearance !== 'none' && appearance !== 'base-select'
    } else {
      const uaBorder = cs.borderTopStyle === 'solid' && rgbOnly(norm(cs.borderTopColor)) === '118,118,118'
      flagged = defaultBorder || (appearance !== 'none' && uaBorder)
    }
    if (flagged) add('nativeControls', `${signature(el)}{${type}}`)
  }
  const active = document.activeElement
  if (active && active !== document.body && visible(active)) {
    const cs = getComputedStyle(active)
    if (cs.outlineStyle === 'auto') add('focusRing', signature(active))
  }

  return result
}

// Contrast of the four ink levels on paper, the glass fallback (stage) and the float material,
// composited over the stage. Runs once per theme/transparency combination.
function contrast() {
  const css = getComputedStyle(document.documentElement)
  const token = name => css.getPropertyValue(name).trim()
  const probe = document.createElement('canvas').getContext('2d')
  const rgba = value => {
    if (!value) return null
    probe.fillStyle = '#000'
    probe.fillStyle = value
    const v = probe.fillStyle
    if (v.startsWith('#')) { const n = parseInt(v.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1] }
    const m = v.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const p = m[1].split(',').map(s => Number(s.trim()))
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
  }
  const over = (top, bottom) => [0, 1, 2].map(i => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1)
  const lum = c => {
    const ch = c.slice(0, 3).map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
  }
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }
  const stage = rgba(token('--rn-stage')) || [235, 235, 238, 1]
  const grounds = {
    sheet: over(rgba(token('--rn-sheet')) || rgba(token('--rn-paper')) || stage, stage),
    stage,
    float: over(rgba(token('--rn-float')) || [252, 252, 253, 0.82], stage),
  }
  const inks = { body: '--rn-ink', secondary: '--rn-ink-2', hint: '--rn-ink-3' }
  const minimum = { body: 4.5, secondary: 4.5, hint: 3 }
  const out = { values: {}, violations: [] }
  for (const [groundName, ground] of Object.entries(grounds)) {
    for (const [level, name] of Object.entries(inks)) {
      const ink = rgba(token(name))
      if (!ink) { out.violations.push(`${level}@${groundName}:missing`); continue }
      const value = Number(ratio(over(ink, ground), ground).toFixed(2))
      out.values[`${level}@${groundName}`] = value
      if (value < minimum[level]) out.violations.push(`${level}@${groundName}:${value}`)
    }
  }
  return out
}

module.exports = { collect, contrast, LEGACY_SHEETS }
