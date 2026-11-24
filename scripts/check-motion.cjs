#!/usr/bin/env node
// Motion language gate (docs/superpowers/plans/2026-11-24-ready-next-motion-language-implementation.md M6).
//
//   node scripts/check-motion.cjs [--list]
//
// In the Renderer, motion is timed and eased only with the --rn-* motion tokens (src/renderer/design/next/tokens.css):
//   css-duration   a literal duration in a transition/animation declaration (0s and 0ms are fine)
//   css-easing     a literal easing (ease, ease-out, cubic-bezier(…), …); `linear` and steps() are fine for an infinite loop
//   css-all        transition: all / transition-property: all
//   css-layout     a transition of a layout property (width, height, top, left, margin, padding, inset, …)
//   css-press      a local transition on .rn-btn / .rn-icon-btn without transform (it would drop the V9 press spring)
//   tw-duration    a Tailwind duration-<n> / ease-[…] / ease-linear class in TSX
//   ts-literal     a literal duration or easing in a TS/TSX motion value (style transition/animation strings, framer-motion
//                  `duration:`, Element.animate options)
// Exceptions live in scripts/check-motion-allowlist.json as { file, kind, max, reason }: a ceiling per file and kind.
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const ROOT = path.join(REPO, 'src/renderer')
const ALLOWLIST = path.join(__dirname, 'check-motion-allowlist.json')
const TOKEN_SOURCE = 'src/renderer/design/next/tokens.css'

const slash = file => path.relative(REPO, file).split(path.sep).join('/')
const blank = text => text.replace(/[^\r\n]/g, ' ')

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (entry.name === '__tests__' || entry.name === 'node_modules' || /\.test\.|\.d\.ts$/.test(entry.name)) return []
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : []
  })
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length

function stripCssComments(text) {
  return text.replace(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?\*\//g, match => match.startsWith('/*') ? blank(match) : match)
}

const MOTION_PROPS = /^(transition|transition-duration|transition-timing-function|transition-delay|transition-property|animation|animation-duration|animation-timing-function|animation-delay)$/i
const LAYOUT_PROPS = /^(width|height|min-width|min-height|max-width|max-height|top|left|right|bottom|inset(-\w+)?|margin(-\w+)?|padding(-\w+)?|flex-basis|flex|grid-template-columns|grid-template-rows|font-size|line-height|letter-spacing)$/i
const EASING_KEYWORD = /(?<![\w-])(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)(?![\w-])/gi
const EASING_FN = /(?<![\w-])(cubic-bezier|linear|steps)\s*\(/gi
const DURATION = /(?<![\w.-])(\d*\.?\d+)(ms|s)(?![\w-])/gi

/** Drops var(--x, fallback) fallbacks? No: a literal fallback still times the motion, so it counts. Removes only url(). */
function scrubValue(value) { return value.replace(/url\([^)]*\)/gi, m => blank(m)) }

function splitTopLevel(value) {
  const parts = []
  let depth = 0, start = 0
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) { parts.push(value.slice(start, i)); start = i + 1 }
  }
  parts.push(value.slice(start))
  return parts.map(part => part.trim()).filter(Boolean)
}

function scanCss(file, text, add) {
  const clean = stripCssComments(text)
  const declaration = /(^|[;{\s])([a-z-]+)\s*:\s*([^;{}]*)/gi
  for (const match of clean.matchAll(declaration)) {
    const prop = match[2]
    if (!MOTION_PROPS.test(prop)) continue
    const value = scrubValue(match[3])
    const at = match.index + match[1].length
    const line = lineOf(clean, at)
    const lower = prop.toLowerCase()
    const isAnimation = lower.startsWith('animation')
    if (lower === 'transition-property' && /(^|,)\s*all(\s|,|$)/i.test(value)) add('css-all', file, line, `${prop}: ${value.trim()}`)
    if (lower === 'transition' || lower === 'transition-property') {
      for (const part of splitTopLevel(value)) {
        // The property may stand anywhere in a shorthand part; a part without one transitions `all`.
        const names = part.replace(/\([^)]*\)/g, ' ').split(/\s+/).filter(word => /^-?[a-z][a-z-]*$/i.test(word)
          && !/^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|steps|cubic-bezier|var|calc|min|max|normal|allow-discrete)$/i.test(word))
        if (/^\s*(none|initial|inherit|unset|revert)\s*(!important)?\s*$/i.test(part)) continue
        if (lower === 'transition' && (names.length === 0 || names.some(name => name.toLowerCase() === 'all'))) add('css-all', file, line, `${prop}: ${part}`)
        if (names.some(name => LAYOUT_PROPS.test(name))) add('css-layout', file, line, `${prop}: … ${part}`)
      }
    }
    for (const part of isAnimation || lower === 'transition' ? splitTopLevel(value) : [value]) {
      const infinite = /\binfinite\b/i.test(part) || (isAnimation && /\binfinite\b/i.test(value))
      const durations = [...part.matchAll(DURATION)]
      // ≤ 1ms is the reduced-motion idiom for "at once" (e.g. `.01ms !important`)
      const msOf = d => Number(d[1]) * (d[2].toLowerCase() === 's' ? 1000 : 1)
      if (durations.some(d => msOf(d) > 1)) add('css-duration', file, line, `${prop}: … ${part}`)
      // An instant change (only 0s in the part, e.g. `visibility 0s linear var(--rn-d-1)`) has no curve to speak of.
      const instant = lower === 'transition' && durations.length > 0 && durations.every(d => msOf(d) <= 1)
      const keywords = [...part.matchAll(EASING_KEYWORD)].map(m => m[1].toLowerCase())
      const fns = [...part.matchAll(EASING_FN)].map(m => m[1].toLowerCase())
      // Discrete steps are not a curve; `linear` keeps a loop's speed even.
      const literal = [...keywords, ...fns].filter(name => !/^step/.test(name) && !(infinite && name === 'linear'))
      if (literal.length && !instant) add('css-easing', file, line, `${prop}: … ${part}`)
    }
  }
}

// css-press: a local `transition` on a button primitive must keep its press (V9): without `transform` in the list the
// :active scale snaps instead of springing back.
function scanPress(file, text, add) {
  const clean = stripCssComments(text)
  for (const block of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/\.rn-(icon-)?btn(?![\w-])/.test(block[1].replace(/:not\([^)]*\)/g, ''))) continue
    const transition = block[2].match(/(?:^|;)\s*transition\s*:\s*([^;]*)/i)
    if (!transition || /\b(transform|all|none)\b/i.test(transition[1])) continue
    add('css-press', file, lineOf(clean, block.index + block[1].length), `${block[1].trim().slice(0, 80)} { transition: ${transition[1].trim()} }`)
  }
}

function scanTsx(file, text, add) {
  // Tailwind classes with their own timing.
  if (file.endsWith('.tsx')) {
    for (const match of text.matchAll(/(?<![\w-])(duration-\d+|duration-\[[^\]]+\]|ease-\[[^\]]+\]|ease-linear)(?![\w-])/g)) {
      add('tw-duration', file, lineOf(text, match.index), match[1])
    }
  }
  // Style strings: transition: '…200ms…', animation: `…`
  for (const match of text.matchAll(/\b(transition|animation)(Duration|TimingFunction)?\s*:\s*(['"`])((?:(?!\3).)*)\3/g)) {
    const value = match[4]
    if (/(?<![\w.-])(?!0(?:ms|s)\b)\d*\.?\d+m?s(?![\w-])/.test(value) || /cubic-bezier\(|(?<![\w-])(ease|ease-in|ease-out|ease-in-out)(?![\w-])/.test(value)) {
      add('ts-literal', file, lineOf(text, match.index), match[0].slice(0, 120))
    }
  }
  // Element.animate(…, { duration: 1200, easing: 'ease-out' }) and framer-motion { duration: 0.2 } / ease arrays
  for (const match of text.matchAll(/\bduration\s*:\s*(\d*\.?\d+)(?![\w.])/g)) {
    const window = text.slice(Math.max(0, match.index - 400), match.index + 200)
    if (!/\.animate\s*\(|transition|motion|framer|animate=|exit=|initial=/.test(window)) continue
    if (Number(match[1]) === 0) continue
    add('ts-literal', file, lineOf(text, match.index), match[0])
  }
  for (const match of text.matchAll(/\beasing\s*:\s*(['"`])([^'"`]+)\1/g)) {
    if (/^var\(--rn-/.test(match[2])) continue
    add('ts-literal', file, lineOf(text, match.index), match[0])
  }
}

function collect() {
  const found = []
  const add = (kind, file, line, detail) => found.push({ kind, file: slash(file), line, detail })
  for (const file of filesUnder(ROOT)) {
    const rel = slash(file)
    if (rel === TOKEN_SOURCE) continue
    if (/\.css$/.test(file)) { const text = fs.readFileSync(file, 'utf8'); scanCss(file, text, add); scanPress(file, text, add) }
    else if (/\.(tsx?|jsx?)$/.test(file)) scanTsx(file, fs.readFileSync(file, 'utf8'), add)
  }
  return found
}

function main() {
  const list = process.argv.includes('--list')
  const found = collect()
  const allow = fs.existsSync(ALLOWLIST) ? JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')) : []
  const counts = new Map()
  for (const item of found) {
    const key = `${item.file}\u0000${item.kind}`
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const errors = []
  const notes = []
  for (const [key, count] of counts) {
    const [file, kind] = key.split('\u0000')
    const entry = allow.find(a => a.file === file && a.kind === kind)
    if (!entry) { errors.push(`${file}: ${count} × ${kind}`); continue }
    if (count > entry.max) errors.push(`${file}: ${count} × ${kind} (allowlist ceiling ${entry.max}: ${entry.reason})`)
    else if (count < entry.max) notes.push(`${file}: ${kind} ${count} < ceiling ${entry.max} — lower it in check-motion-allowlist.json`)
  }
  for (const entry of allow) {
    if (!counts.has(`${entry.file}\u0000${entry.kind}`)) notes.push(`${entry.file}: no ${entry.kind} left — remove the allowlist entry`)
    if (!entry.reason) errors.push(`${entry.file}: allowlist entry for ${entry.kind} has no reason`)
  }
  if (list || errors.length) {
    const shown = found.filter(item => list || !allow.some(a => a.file === item.file && a.kind === item.kind && (counts.get(`${item.file}\u0000${item.kind}`) || 0) <= a.max))
    for (const item of shown) console.log(`${item.file}:${item.line}  [${item.kind}]  ${item.detail.replace(/\s+/g, ' ').slice(0, 160)}`)
  }
  for (const note of notes) console.log(`note: ${note}`)
  if (errors.length) {
    console.error(`\nMotion gate failed (${errors.length}):\n  ${errors.join('\n  ')}\nUse the --rn-* motion tokens (tokens.css); see the motion language plan.`)
    return 1
  }
  console.log(`Motion gate ok (${found.length} allowlisted findings in ${allow.length} entries).`)
  return 0
}

if (require.main === module) process.exitCode = main()
module.exports = { collect, scanCss, scanTsx }
