#!/usr/bin/env node
/**
 * Stage U PR U2.4 — fire-and-forget catch swallow gate.
 *
 * Per `architectural-principles.md §6` + `CLAUDE.md §2`, fire-and-forget
 * promises (void X.catch(()=>undefined) and siblings) must surface failures
 * via metric / log / throw / callback. This gate flags 5 forms:
 *   1. `void <expr>.catch(() => undefined)`
 *   2. `<expr>.catch(noop|()=>null)` at statement position
 *   3. `<expr>.catch(() => {})` at statement position
 *   4. `<expr>.finally(...).catch(<silent>)` chain
 *   5. `void window.electronAPI.<x>(...)` reused within 5 lines
 *
 * Accepts: side-effecting handler bodies; `// fire-and-forget: <reason>`
 * or `// silent-catch: <reason>` annotation within ~15 lines; consumed
 * positions (await / const x = / return / sub-expression); allowlist
 * entries in `scripts/check-no-fire-and-forget.allowlist.json`. Skips
 * test files (`src/__tests__/`, `*.test.*`).
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { stripCommentsOnly } = require('./_lib_strip_code_strings_and_comments.cjs')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const SCAN_ROOTS = ['src/main', 'src/preload', 'src/renderer', 'src/shared']
const SCAN_EXT = new Set(['.ts', '.tsx', '.cts', '.mts'])
const ALLOWLIST_PATH = 'scripts/check-no-fire-and-forget.allowlist.json'
const FILE_SKIPS = [/^src\/__tests__\//, /^scripts\/__tests__\//, /\.test\.[cm]?tsx?$/, /\.spec\.[cm]?tsx?$/]
const OVERRIDE_COMMENT = /\/\/\s*(fire-and-forget|silent-catch)\s*:\s*\S+/

function* walk(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) yield full
  }
}

const rel = (root, full) => path.relative(root, full).split(path.sep).join('/')
const isFileSkipped = (p) => FILE_SKIPS.some((rx) => rx.test(p))

function loadAllowlist(root) {
  const p = path.join(root, ALLOWLIST_PATH)
  if (!fs.existsSync(p)) return { entries: [], lookup: new Set() }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  const entries = Array.isArray(raw.entries) ? raw.entries : []
  for (const e of entries) {
    if (typeof e.file !== 'string' || typeof e.line !== 'number' || typeof e.reason !== 'string' || e.reason.trim().length === 0) {
      throw new Error(`Invalid allowlist entry (must have {file, line, reason}): ${JSON.stringify(e)}`)
    }
  }
  return { entries, lookup: new Set(entries.map((e) => `${e.file}:${e.line}`)) }
}

function lineAt(source, offset) {
  let line = 1
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === '\n') line++
  return line
}

function matchParen(source, open) {
  let depth = 0
  let quote = null
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (quote) { if (ch === '\\') { i++; continue } if (ch === quote) quote = null; continue }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) return i }
  }
  return -1
}

/**
 * Returns true if the handler-arg source is provably silent — no
 * side-effect call, no throw, no assignment. Returns `() => undefined`,
 * `() => null`, `() => {}`, bare `noop` identifier, etc.
 */
function isSilentHandler(argSrc) {
  const s = argSrc.trim()
  if (/^(noop|swallow|ignore|asUndefined|asNull)$/.test(s)) return true
  if (/^\(\s*[^)]*\)\s*=>\s*(undefined|null|void\s+0)\s*$/.test(s)) return true
  if (/^[A-Za-z_$][\w$]*\s*=>\s*(undefined|null|void\s+0)\s*$/.test(s)) return true
  if (/^\(\s*[^)]*\)\s*=>\s*\(\s*(undefined|null)\s*\)\s*$/.test(s)) return true
  const blockMatch = s.match(/^(?:\(\s*[^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{([\s\S]*)\}\s*$/)
  if (blockMatch) {
    const body = blockMatch[1].trim()
    if (body === '') return true
    const stmts = body.split(';').map((t) => t.trim()).filter(Boolean)
    return stmts.every((st) => /^return(\s+(undefined|null))?$/.test(st))
  }
  return false
}

const CONT_TRAILING = new Set([',', '(', '[', '+', '-', '*', '/', '%', '&', '|', '^', '?', ':', '=', '<', '>'])
const OBJLIT_PREV = new Set([':', '=', ',', '(', '[', '?'])
const OBJLIT_KW = new Set(['return', 'yield', 'throw'])

/** Returns `{start, subExpression}` for the statement containing `dotIdx`. */
function statementStartFor(source, dotIdx) {
  let i = dotIdx - 1
  let depth = 0
  let quote = null
  while (i >= 0) {
    const ch = source[i]
    if (quote) {
      if (ch === '\\') { i--; continue }
      if (ch === quote) quote = null
      i--; continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; i--; continue }
    if (ch === ')' || ch === ']' || ch === '}') { depth++; i--; continue }
    if (ch === '(' || ch === '[') {
      if (depth === 0) return { start: i + 1, subExpression: true }
      depth--; i--; continue
    }
    if (ch === '{') {
      if (depth === 0) {
        let k = i - 1
        while (k >= 0 && /\s/.test(source[k])) k--
        const prev = k >= 0 ? source[k] : ''
        if (OBJLIT_PREV.has(prev)) return { start: i + 1, subExpression: true }
        if (prev === '>' && source[k - 1] === '=') return { start: i + 1, subExpression: true }
        if (/[A-Za-z_$0-9]/.test(prev)) {
          let p = k
          while (p >= 0 && /[A-Za-z_$0-9]/.test(source[p])) p--
          if (OBJLIT_KW.has(source.slice(p + 1, k + 1))) return { start: i + 1, subExpression: true }
        }
        return { start: i + 1, subExpression: false }
      }
      depth--; i--; continue
    }
    if (depth > 0) { i--; continue }
    if (ch === ';') return { start: i + 1, subExpression: false }
    if (ch === '\n') {
      // Continuation if next non-ws starts with `.`/`?.`.
      let k = i + 1
      while (k < source.length && (source[k] === ' ' || source[k] === '\t')) k++
      if (source[k] === '.' || (source[k] === '?' && source[k + 1] === '.')) { i--; continue }
      // Continuation if prev line ends with a binary/sub-expr operator.
      let j = i - 1
      while (j >= 0 && (source[j] === ' ' || source[j] === '\t' || source[j] === '\r')) j--
      if (j >= 0 && CONT_TRAILING.has(source[j])) { i--; continue }
      return { start: i + 1, subExpression: false }
    }
    i--
  }
  return { start: 0, subExpression: false }
}

function classifyPosition(source, dotIdx) {
  const { start, subExpression } = statementStartFor(source, dotIdx)
  if (subExpression) return 'consumed'
  const prefix = source.slice(start, dotIdx).replace(/^\s+/, '')
  if (/^void\s/.test(prefix)) return 'void'
  if (/^(await|return|throw|yield|new|typeof|const|let|var)\s/.test(prefix)) return 'consumed'
  if (containsTopLevelAssignment(prefix)) return 'consumed'
  return 'statement'
}

function containsTopLevelAssignment(text) {
  let depth = 0
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; continue }
    if (depth !== 0) continue
    if (ch === '=') {
      const prev = text[i - 1]
      const next = text[i + 1]
      if (prev === '=' || prev === '!' || prev === '<' || prev === '>') continue
      if (next === '=' || next === '>') continue
      return true
    }
  }
  return false
}

function* findCatchCalls(source) {
  const re = /\.catch\s*\(/g
  let m
  while ((m = re.exec(source)) !== null) {
    const dotIdx = m.index
    const openParen = source.indexOf('(', dotIdx)
    const close = matchParen(source, openParen)
    if (close === -1) continue
    yield { dotIdx, openParen, close, argSrc: source.slice(openParen + 1, close) }
  }
}

function scanFile(relPath, rawSource) {
  const violations = []
  const stripped = stripCommentsOnly(rawSource)
  const rawLines = rawSource.split('\n')

  for (const call of findCatchCalls(stripped)) {
    if (!isSilentHandler(call.argSrc)) continue
    const position = classifyPosition(stripped, call.dotIdx)
    if (position === 'consumed') continue
    const lineNo = lineAt(stripped, call.dotIdx)
    // Look 15 lines back / 3 lines forward for override comment so
    // multi-line chains can place the annotation at the chain head.
    const ctxStart = Math.max(0, lineNo - 15)
    const ctxEnd = Math.min(rawLines.length, lineNo + 3)
    if (OVERRIDE_COMMENT.test(rawLines.slice(ctxStart, ctxEnd).join('\n'))) continue
    violations.push({
      file: relPath,
      line: lineNo,
      form: position === 'void' ? 'void-catch-swallow' : 'statement-catch-swallow',
      snippet: stripped.slice(call.dotIdx, call.close + 1).replace(/\s+/g, ' ').slice(0, 160),
    })
  }

  // Form 5: void window.electronAPI.<x>() reused within 5 lines.
  const voidElectron = /void\s+window\.electronAPI\.([A-Za-z_$][\w$.]*)\s*\(/g
  let em
  while ((em = voidElectron.exec(stripped)) !== null) {
    const id = em[1]
    const lineNo = lineAt(stripped, em.index)
    const lines = stripped.split('\n')
    const window5 = lines.slice(lineNo, lineNo + 5).join('\n')
    const last = id.split('.').pop()
    const reuse = new RegExp(`\\b${last}\\b`)
    if (!reuse.test(window5)) continue
    const ctxStart = Math.max(0, lineNo - 15)
    const ctxEnd = Math.min(rawLines.length, lineNo + 3)
    if (OVERRIDE_COMMENT.test(rawLines.slice(ctxStart, ctxEnd).join('\n'))) continue
    violations.push({ file: relPath, line: lineNo, form: 'void-electron-reuse', snippet: em[0].slice(0, 160) })
  }
  return violations
}

function checkNoFireAndForget({ root = REPO_DEFAULT } = {}) {
  const { lookup: allowlist, entries: allowlistEntries } = loadAllowlist(root)
  const violations = []
  for (const r of SCAN_ROOTS) {
    const abs = path.join(root, r)
    for (const full of walk(abs)) {
      const relPath = rel(root, full)
      if (isFileSkipped(relPath)) continue
      const raw = fs.readFileSync(full, 'utf8')
      for (const v of scanFile(relPath, raw)) {
        if (allowlist.has(`${v.file}:${v.line}`)) continue
        violations.push(v)
      }
    }
  }
  return { ok: violations.length === 0, violations, allowlistEntries }
}

function main() {
  const { ok, violations, allowlistEntries } = checkNoFireAndForget()
  if (ok) {
    console.log(`[check-no-fire-and-forget] OK (${allowlistEntries.length} allowlist entries)`)
    return 0
  }
  console.error('[check-no-fire-and-forget] FAIL — fire-and-forget catch swallows hide infra failures.')
  console.error('  Remediate by adding a metric/log/throw inside the handler, or annotate with')
  console.error('  `// fire-and-forget: <reason>` on the line above or inside the catch body, or')
  console.error('  add an entry to scripts/check-no-fire-and-forget.allowlist.json with a reason.')
  for (const v of violations) console.error(`  ${v.file}:${v.line} [${v.form}] ${v.snippet}`)
  return 1
}

if (require.main === module) process.exit(main())

module.exports = { checkNoFireAndForget, scanFile, isSilentHandler }
