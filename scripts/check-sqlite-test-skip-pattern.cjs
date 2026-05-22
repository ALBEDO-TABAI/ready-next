#!/usr/bin/env node
/**
 * Stage 5 — sqlite-direct-skip (C3) + sqlite-transitive-skip (C4) hard gate.
 *
 * Audits every test file under TEST_EXTENSIONS:
 *   - C3: a "direct" sqlite loader (require / await import / side-effect import /
 *     value `from 'better-sqlite3'`) requires `skipIfSqliteUnavailable(...)`
 *     usage. `import type` is excluded.
 *   - C4: a transitive value import that reaches any module in
 *     `nativeBackedModules` requires the same helper, unless the test is in
 *     `c4Exempt` (see scripts/test-coverage-exemptions.json).
 *
 * Static, no third-party deps; meant to run under host Node in < 200ms.
 */

const { readFileSync, existsSync, readdirSync, statSync, realpathSync } = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const EXEMPTIONS_PATH = path.join(ROOT, 'scripts/test-coverage-exemptions.json')

const TEST_EXTENSIONS = [
  'src/__tests__/**/*.test.ts',
  'src/__tests__/**/*.e2e.ts',
  // eslint-rules / scripts test dirs do not import better-sqlite3 today; if
  // they ever do, extend this list.
]

const DISK_EXCLUDE_PREFIXES = [
  'node_modules/',
  '.worktrees/',
  '.claude/worktrees/',
  'out/',
  'dist/',
  'build/',
]

const SQLITE_LOAD_FORMS = [
  /\brequire\(\s*['"]better-sqlite3['"]\s*\)/,
  /\bawait\s+import\(\s*['"]better-sqlite3['"]\s*\)/,
  // side-effect import — `import 'better-sqlite3'` (no `from`)
  /^\s*import\s+['"]better-sqlite3['"]/m,
]

// Stage U moved db-worker.ts to database/worker.ts; the NATIVE_GREP_DIRS
// sweep below picks the new file up automatically because it imports
// better-sqlite3 literally. The seed list stays narrow (just database.ts)
// so we do not change the C4-transitive coverage surface as a side effect
// of recording the rename.
const NATIVE_SEED = ['src/main/modules/database.ts']
const NATIVE_GREP_DIRS = ['src/main', 'src/shared', 'src/preload']

// Reuse the gate's expandGlob helper to avoid re-implementing.
const orphanGate = require('./check-test-coverage-by-verify.cjs')
const { expandGlob, normalizePosix } = orphanGate._internals

main()

function main() {
  if (require.main !== module) return
  const result = checkSqliteSkipPattern()
  if (result.ok) {
    console.log(
      `sqlite skip pattern: ok (tested=${result.testedCount}, native-backed=${result.nativeCount}, c4Exempt=${result.exemptCount})`,
    )
    return
  }
  console.error('[check-sqlite-test-skip-pattern] violations:')
  for (const v of result.violations) {
    console.error(`  ${v.kind} (${v.reason}): ${v.path}${v.line ? ` line ~${v.line}` : ''}`)
  }
  console.error(
    `\nFix by importing skipIfSqliteUnavailable from src/__tests__/utils/sqlite-skip.ts and\n` +
    `calling it at the start of every outer test() block. For C4 false positives where\n` +
    `the test only injects a fake DB and never lets the module load sqlite, register the\n` +
    `file in scripts/test-coverage-exemptions.json under c4Exempt[] with a reason.\n`,
  )
  process.exit(1)
}

function checkSqliteSkipPattern({ root = ROOT } = {}) {
  const c4ExemptRel = loadC4Exempt(EXEMPTIONS_PATH)
  const c4ExemptSet = new Set(c4ExemptRel.map((p) => normalizePosix(p)))

  const nativeBackedModules = buildNativeBackedModules(root)

  const testFiles = []
  for (const glob of TEST_EXTENSIONS) {
    for (const abs of expandGlob(glob, root)) {
      const rel = normalizePosix(path.relative(root, abs))
      if (DISK_EXCLUDE_PREFIXES.some((p) => rel.startsWith(p))) continue
      testFiles.push({ abs, rel })
    }
  }

  const violations = []
  // Track which c4Exempt entries are actually used — Codex r2 patch B:
  // exempt entries that no longer match real C4-transitive detection are
  // stale (e.g. import was removed) and must surface so the registry can't
  // silently grow false hides.
  const usedExempt = new Set()
  const diskRels = new Set()
  let nativeCount = 0
  for (const { abs, rel } of testFiles) {
    diskRels.add(rel)
    const src = readFileSync(abs, 'utf8')
    const direct = isDirectSqliteLoader(src)
    const rawTransitive = !direct && reachesNativeBackedModule(abs, root, nativeBackedModules)
    if (rawTransitive && c4ExemptSet.has(rel)) {
      usedExempt.add(rel)
    }
    const transitive = rawTransitive && !c4ExemptSet.has(rel)
    if (!direct && !transitive) continue
    nativeCount++

    const reasonLabel = direct ? 'C3-direct' : 'C4-transitive'
    if (!hasSkipHelperImport(src)) {
      violations.push({ kind: 'missing_helper', reason: reasonLabel, path: rel })
      continue
    }
    // Per-block enforcement scope: C3-direct only.
    //   - C3-direct: the file itself loads better-sqlite3, so every block is
    //     plausibly sqlite-touching → guard each block.
    //   - C4-transitive: many blocks in these files use fakes and never
    //     trigger native load; forcing per-block helper would lose host-Node
    //     coverage for fake-only paths. File-level helper presence is enough.
    if (direct) {
      const unguarded = findUnguardedTestBlocks(src)
      for (const u of unguarded) {
        violations.push({ kind: 'unguarded_block', reason: reasonLabel, path: rel, line: u.line })
      }
    }
  }

  // c4Exempt staleness sweep (Codex r2 patch B).
  for (const rel of c4ExemptSet) {
    if (!diskRels.has(rel)) {
      violations.push({ kind: 'stale_c4_exempt', reason: 'file_missing_on_disk', path: rel })
      continue
    }
    if (!usedExempt.has(rel)) {
      violations.push({
        kind: 'stale_c4_exempt',
        reason: 'no_longer_C4_transitive',
        path: rel,
      })
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    testedCount: testFiles.length,
    nativeCount,
    exemptCount: c4ExemptSet.size,
  }
}

function loadC4Exempt(filePath) {
  if (!existsSync(filePath)) return []
  const data = JSON.parse(readFileSync(filePath, 'utf8'))
  const list = Array.isArray(data?.c4Exempt) ? data.c4Exempt : []
  for (const entry of list) {
    if (typeof entry?.path !== 'string') throw new Error(`c4Exempt entry missing path: ${JSON.stringify(entry)}`)
    if (typeof entry?.reason !== 'string' || entry.reason.trim().length < 10) {
      throw new Error(`c4Exempt entry "${entry.path}" needs reason ≥ 10 chars`)
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.since || '')) {
      throw new Error(`c4Exempt entry "${entry.path}" needs ISO since (YYYY-MM-DD)`)
    }
  }
  return list.map((e) => e.path)
}

function buildNativeBackedModules(root) {
  const result = new Set()
  for (const seed of NATIVE_SEED) {
    const abs = path.join(root, seed)
    if (existsSync(abs)) result.add(realPathSafe(abs))
  }
  for (const dir of NATIVE_GREP_DIRS) {
    const abs = path.join(root, dir)
    if (!existsSync(abs)) continue
    grepDirForLiteral(abs, 'better-sqlite3', result)
  }
  return result
}

function grepDirForLiteral(dir, literal, out) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      grepDirForLiteral(full, literal, out)
      continue
    }
    if (!e.isFile()) continue
    if (!/\.(ts|tsx|cts|mts|js|cjs|mjs)$/.test(e.name)) continue
    let content
    try { content = readFileSync(full, 'utf8') } catch { continue }
    if (content.includes(literal)) out.add(realPathSafe(full))
  }
}

function isDirectSqliteLoader(src) {
  for (const rgx of SQLITE_LOAD_FORMS) {
    if (rgx.test(src)) return true
  }
  for (const rawLine of src.split(/\r?\n/)) {
    if (isDirectFromBetterSqlite3(rawLine)) return true
  }
  return false
}

function isDirectFromBetterSqlite3(line) {
  if (/^\s*import\s+type\s+/.test(line)) return false
  const namedGroup = line.match(/^\s*import\s*\{\s*([^}]+)\s*\}\s*from\s*['"]better-sqlite3['"]/)
  if (namedGroup) {
    const allTypeOnly = namedGroup[1]
      .split(',')
      .map((s) => s.trim())
      .every((s) => s.startsWith('type '))
    if (allTypeOnly) return false
  }
  return /\bfrom\s+['"]better-sqlite3['"]/.test(line)
}

function reachesNativeBackedModule(testAbs, root, nativeBackedModules) {
  // BFS over value-import graph with cycle protection and a depth cap.
  // Stage 5 post-impl review (codex r1) NACK'd a depth-1 narrowing because it
  // missed wrapper-of-wrapper transitive cases. The right policy is "walk the
  // graph + use c4Exempt for proven-safe false positives" — a noisier gate
  // surface is acceptable because each c4Exempt entry forces a written reason.
  const MAX_DEPTH = 4
  const seen = new Set()
  let frontier = [testAbs]
  let depth = 0
  while (frontier.length && depth <= MAX_DEPTH) {
    const next = []
    for (const cur of frontier) {
      const canon = realPathSafe(cur)
      if (seen.has(canon)) continue
      seen.add(canon)
      if (depth > 0 && nativeBackedModules.has(canon)) return true
      let src
      try { src = readFileSync(cur, 'utf8') } catch { continue }
      for (const spec of extractValueRelativeImports(src, cur)) {
        const resolved = resolveLocalImport(spec, cur, root)
        if (resolved) next.push(resolved)
      }
    }
    frontier = next
    depth++
  }
  return false
}

function extractValueRelativeImports(src, _fromFile) {
  const out = new Set()
  // strip `import type ... from '...'` lines first
  const stripped = src
    .split(/\r?\n/)
    .filter((line) => !/^\s*import\s+type\s+/.test(line))
    .map((line) => {
      // `import { type X } from '...'` — drop entirely if all-type-only
      const m = line.match(/^\s*import\s*\{\s*([^}]+)\s*\}\s*from\s*['"]([^'"]+)['"]/)
      if (!m) return line
      const allTypeOnly = m[1]
        .split(',')
        .map((s) => s.trim())
        .every((s) => s.startsWith('type '))
      return allTypeOnly ? '' : line
    })
    .join('\n')

  const importRe = /\bfrom\s+['"]([^'"]+)['"]/g
  const requireRe = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
  const dynamicRe = /\bawait\s+import\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const re of [importRe, requireRe, dynamicRe]) {
    let m
    while ((m = re.exec(stripped))) {
      const spec = m[1]
      if (!spec.startsWith('.')) continue // ignore node_modules / bare specifiers
      out.add(spec)
    }
  }
  return out
}

function resolveLocalImport(spec, fromFile, _root) {
  const dir = path.dirname(fromFile)
  const candidates = [
    path.resolve(dir, spec),
    path.resolve(dir, spec) + '.ts',
    path.resolve(dir, spec) + '.tsx',
    path.resolve(dir, spec) + '.mts',
    path.resolve(dir, spec) + '.cts',
    path.resolve(dir, spec, 'index.ts'),
    path.resolve(dir, spec, 'index.tsx'),
  ]
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  return null
}

function hasSkipHelperImport(src) {
  return /from\s+['"][^'"]*\/utils\/sqlite-skip['"]/.test(src) && /\bskipIfSqliteUnavailable\s*\(/.test(src)
}

function findUnguardedTestBlocks(src) {
  // Match `test(...)` / `it(...)` and modifier forms (`test.only`, `test.skip`,
  // `it.concurrent.only`, `test.each([...])(...)`, etc.). For curried forms
  // we structurally match the modifier args `(...)` and then start the
  // helper-guard scan from the curried call's title `(`. Fixed line windows
  // are unsafe (Codex r5 patch A: any window can be evaded by a longer
  // `test.each` table), so we walk paren depth here.
  const out = []
  const lines = src.split(/\r?\n/)
  const callOpen = /^\s*(?:test|it)(?:\.\w+)*\s*\(/
  for (let i = 0; i < lines.length; i++) {
    if (!callOpen.test(lines[i])) continue

    // Find the matching `)` for the first `(` of this call. If the form is
    // curried (followed by another `(` after balancing the args), advance
    // the search anchor to the curried `(`. Otherwise the first `(` IS the
    // title args.
    const argsStart = locateArgsStart(lines, i)
    if (argsStart === null) continue
    const argsEnd = matchClosingParen(lines, argsStart.line, argsStart.col)
    if (!argsEnd) continue

    let titleAnchorLine = argsStart.line
    const afterArgs = peekNextNonWhitespace(lines, argsEnd.line, argsEnd.col + 1)
    if (afterArgs && afterArgs.ch === '(') {
      // curried form — title is in the second args group.
      titleAnchorLine = afterArgs.line
      const curriedEnd = matchClosingParen(lines, afterArgs.line, afterArgs.col)
      if (!curriedEnd) continue
      const curriedSrc = sliceRange(lines, afterArgs.line, afterArgs.col, curriedEnd.line, curriedEnd.col + 1)
      if (!/['"`]/.test(curriedSrc)) continue
    } else {
      // direct form — title is the first argument; require a quote inside the
      // first args group.
      const directSrc = sliceRange(lines, argsStart.line, argsStart.col, argsEnd.line, argsEnd.col + 1)
      if (!/['"`]/.test(directSrc)) continue
    }

    // Helper guard scan: from the title anchor line through the call body's
    // closing brace. We allow up to 20 lines past the title; the helper guard
    // is virtually always the FIRST statement of the body so this is plenty.
    const guardWindow = lines.slice(titleAnchorLine, Math.min(titleAnchorLine + 20, lines.length)).join('\n')
    if (/\bskipIfSqliteUnavailable\s*\(/.test(guardWindow)) continue
    out.push({ line: i + 1 })
  }
  return out
}

function locateArgsStart(lines, fromLine) {
  // Find the first `(` from the call signature on or after fromLine.
  for (let li = fromLine; li < Math.min(fromLine + 4, lines.length); li++) {
    const line = lines[li]
    const idx = line.indexOf('(')
    if (idx >= 0) return { line: li, col: idx }
  }
  return null
}

function matchClosingParen(lines, openLine, openCol) {
  // Token-aware paren matcher (Codex r7 patch A v6). Skips:
  //   - single/double/template strings (with proper backslash parity)
  //   - line comments `//`
  //   - block comments `/* ... */`
  //   - regex literals `/.../` after operator/punct/start-of-statement
  // Detection of regex vs division uses the previous non-whitespace token: a
  // `/` is treated as a regex start when the previous non-ws char is one of
  // `( [ , ; = : ? ! & | + - * ~ ^ { } > <` or beginning-of-input.
  let depth = 0
  let inSingle = false
  let inDouble = false
  let inTpl = false
  let inLineComment = false
  let inBlockComment = false
  let inRegex = false
  let inRegexClass = false
  let prevSig = '' // last significant (non-ws/non-comment) char seen
  let prevWord = '' // last identifier-like word collected (Codex r8 v7)
  let curWord = ''
  const REGEX_PRECEDES_CHARS = new Set(['(', '[', '{', ',', ';', '=', ':', '?', '!', '&', '|', '+', '-', '*', '~', '^', '<', '>', '%', '/'])
  const REGEX_PRECEDES_KEYWORDS = new Set([
    'return', 'throw', 'yield', 'await', 'typeof', 'void', 'delete',
    'in', 'of', 'instanceof', 'new', 'do', 'else',
  ])

  function flushWord() {
    if (curWord) {
      prevWord = curWord
      // prevSig should reflect that an identifier/number was the last token
      // (Codex r9 patch A v8). Otherwise `return 1 / 2` would carry prevSig='{'
      // forward and treat `/` as regex even though `1` already consumed the
      // expression-start position. Use the last char of the word as a stand-in
      // for "non-operator significant char".
      prevSig = curWord[curWord.length - 1]
      curWord = ''
    }
  }

  for (let li = openLine; li < lines.length; li++) {
    const line = lines[li]
    const startCol = li === openLine ? openCol : 0
    inLineComment = false // resets per line
    for (let ci = startCol; ci < line.length; ci++) {
      const ch = line[ci]
      const next = ci + 1 < line.length ? line[ci + 1] : ''

      if (inLineComment) continue
      if (inBlockComment) {
        if (ch === '*' && next === '/') { inBlockComment = false; ci++ }
        continue
      }
      // String close: like regex close, treat the string as a value — clear
      // prevWord and set prevSig to a non-regex-preceding char.
      if (inSingle) {
        if (ch === "'" && !isEscaped(line, ci)) { inSingle = false; prevWord = ''; prevSig = 'A' }
        continue
      }
      if (inDouble) {
        if (ch === '"' && !isEscaped(line, ci)) { inDouble = false; prevWord = ''; prevSig = 'A' }
        continue
      }
      if (inTpl) {
        if (ch === '`' && !isEscaped(line, ci)) { inTpl = false; prevWord = ''; prevSig = 'A' }
        continue
      }
      if (inRegex) {
        if (ch === '\\') { ci++; continue } // skip escaped char
        if (ch === '[') inRegexClass = true
        else if (ch === ']') inRegexClass = false
        else if (ch === '/' && !inRegexClass && !isEscaped(line, ci)) {
          while (ci + 1 < line.length && /[gimsuy]/.test(line[ci + 1])) ci++
          inRegex = false
          // Codex r10 patch A v9: a closed regex acts like a value; clear
          // prevWord so a following `/` divides instead of starting another
          // regex, and set prevSig to a non-REGEX_PRECEDES char.
          prevWord = ''
          prevSig = 'A'
        }
        continue
      }

      if (ch === '/' && next === '/') { inLineComment = true; ci++; flushWord(); continue }
      if (ch === '/' && next === '*') { inBlockComment = true; ci++; flushWord(); continue }
      if (ch === '/') {
        const wordPrefix = curWord || prevWord
        const isKwRegex = wordPrefix && REGEX_PRECEDES_KEYWORDS.has(wordPrefix)
        const isCharRegex = !curWord && (prevSig === '' || REGEX_PRECEDES_CHARS.has(prevSig))
        if (isKwRegex || isCharRegex) {
          inRegex = true
          flushWord()
          continue
        }
        // division operator
        flushWord()
        prevSig = ch
        continue
      }

      // identifier accumulation
      if (/[A-Za-z_$]/.test(ch) || (curWord && /[A-Za-z0-9_$]/.test(ch))) {
        curWord += ch
        continue
      }

      if (ch === "'") { inSingle = true; flushWord(); prevWord = ''; prevSig = ch; continue }
      if (ch === '"') { inDouble = true; flushWord(); prevWord = ''; prevSig = ch; continue }
      if (ch === '`') { inTpl = true; flushWord(); prevWord = ''; prevSig = ch; continue }
      if (ch === '(') { depth++; flushWord(); prevWord = ''; prevSig = ch; continue }
      if (ch === ')') {
        depth--
        if (depth === 0) return { line: li, col: ci }
        flushWord()
        prevWord = ''
        prevSig = ch
        continue
      }
      if (/\s/.test(ch)) {
        flushWord()
        // do NOT clear prevWord on whitespace — it must survive `return /...` →
        // `return ` whitespace precedes the `/`.
        continue
      }
      flushWord()
      // Punctuation/operator: prevWord no longer represents "immediately
      // preceding word" — clear so a later `/` doesn't incorrectly inherit.
      prevWord = ''
      prevSig = ch
    }
    flushWord()
  }
  return null
}

function isEscaped(line, idx) {
  let n = 0
  let k = idx - 1
  while (k >= 0 && line[k] === '\\') { n++; k-- }
  return n % 2 === 1
}

function peekNextNonWhitespace(lines, fromLine, fromCol) {
  let li = fromLine
  let ci = fromCol
  while (li < lines.length) {
    const line = lines[li]
    while (ci < line.length) {
      const ch = line[ci]
      if (!/\s/.test(ch)) return { line: li, col: ci, ch }
      ci++
    }
    li++
    ci = 0
  }
  return null
}

function sliceRange(lines, startLine, startCol, endLine, endCol) {
  if (startLine === endLine) return lines[startLine].slice(startCol, endCol)
  const parts = [lines[startLine].slice(startCol)]
  for (let li = startLine + 1; li < endLine; li++) parts.push(lines[li])
  parts.push(lines[endLine].slice(0, endCol))
  return parts.join('\n')
}

function realPathSafe(p) {
  try { return realpathSync(p) } catch { return p }
}

module.exports = {
  checkSqliteSkipPattern,
  isDirectSqliteLoader,
  isDirectFromBetterSqlite3,
  SQLITE_LOAD_FORMS,
  _internals: {
    hasSkipHelperImport,
    findUnguardedTestBlocks,
    extractValueRelativeImports,
    buildNativeBackedModules,
    reachesNativeBackedModule,
  },
}
