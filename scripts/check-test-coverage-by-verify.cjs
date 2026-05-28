#!/usr/bin/env node
/**
 * Stage 5 — orphan-coverage hard gate (C1).
 *
 * Every test file under TEST_EXTENSIONS must be referenced (directly or via
 * glob) by some `verify:*` / `test:*` script in package.json — or appear in
 * scripts/test-coverage-exemptions.json with a non-empty reason + ISO date.
 *
 * Static, no third-party deps. Runs in < 200ms.
 */

const { readFileSync, existsSync, readdirSync, statSync, realpathSync } = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const EXEMPTIONS_PATH = path.join(ROOT, 'scripts/test-coverage-exemptions.json')

const TEST_EXTENSIONS = [
  'src/__tests__/**/*.test.ts',
  'src/__tests__/**/*.test.tsx',
  'src/__tests__/**/*.e2e.ts',
  'eslint-rules/__tests__/**/*.test.{mjs,ts}',
  'scripts/__tests__/**/*.test.cjs',
]

// Excluded from disk scan (scratch worktrees / generated dirs).
const DISK_EXCLUDE_PREFIXES = [
  'node_modules/',
  '.worktrees/',
  '.claude/worktrees/',
  'out/',
  'dist/',
  'build/',
]

// Stage 5.1 closure: coverage sources are walked only from `verify:*` /
// `verify` aggregators. A bare `test:*` entry that nothing in the verify
// chain calls is *not* a coverage source — otherwise a parked test bucket
// (e.g. `test:ui-contracts`) silently satisfies coverage without ever
// running in CI. Per-script chaining via `npm run` is still expanded
// recursively, so `verify:k` → `npm run test:k:gates` → … keeps working.
const COVERAGE_ROOT_RE = /^verify(?::|$)/

main()

function main() {
  if (require.main !== module) return
  const result = checkTestCoverageByVerify()
  if (result.ok) {
    console.log(`test coverage by verify: ok (disk=${result.diskCount}, referenced=${result.referencedCount}, exempt=${result.exemptCount})`)
    return
  }
  console.error('[check-test-coverage-by-verify] violations:')
  for (const v of result.violations) {
    console.error(`  ${v.kind}: ${v.path}${v.reason ? ` (${v.reason})` : ''}`)
  }
  console.error(
    `\nIf an orphan is intentional, add it to scripts/test-coverage-exemptions.json (exempt[]) with reason + since.\n` +
    `If a script entry should reference it, add it to package.json scripts[verify:* or test:*].\n`,
  )
  process.exit(1)
}

function checkTestCoverageByVerify({ root = ROOT } = {}) {
  const exemptions = loadExemptions(EXEMPTIONS_PATH)
  const exemptOrphans = new Set(exemptions.exempt.map((e) => normalizePosix(e.path)))

  // 1. Build referenced set from scripts.
  const referenced = new Set()
  const visited = new Set()
  for (const key of Object.keys(PKG.scripts || {})) {
    if (!COVERAGE_ROOT_RE.test(key)) continue
    expandReferenced(PKG.scripts, key, visited, referenced, root)
  }
  // The default `npm test` (script key `test`) and `test:k:gates`-style
  // scripts that are reachable only from `verify:*` are picked up via the
  // recursive `npm run X` walk inside expandReferenced. Top-level `test:*`
  // entries that no verify chain calls are deliberately NOT roots.

  // 2. Build disk set.
  const disk = new Set()
  for (const glob of TEST_EXTENSIONS) {
    for (const file of expandGlob(glob, root)) {
      const rel = normalizePosix(path.relative(root, file))
      if (DISK_EXCLUDE_PREFIXES.some((p) => rel.startsWith(p))) continue
      disk.add(rel)
    }
  }

  // 3. Diff.
  const violations = []
  for (const file of disk) {
    if (referenced.has(file)) continue
    if (exemptOrphans.has(file)) continue
    violations.push({ kind: 'orphan', path: file })
  }
  for (const file of exemptOrphans) {
    if (!disk.has(file)) {
      violations.push({ kind: 'ghost_exemption', path: file, reason: 'listed in exempt[] but not on disk' })
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    diskCount: disk.size,
    referencedCount: referenced.size,
    exemptCount: exemptOrphans.size,
  }
}

function loadExemptions(filePath) {
  if (!existsSync(filePath)) return { exempt: [], c4Exempt: [] }
  const data = JSON.parse(readFileSync(filePath, 'utf8'))
  if (!data || typeof data !== 'object') {
    throw new Error(`exemptions file is not an object: ${filePath}`)
  }
  const exempt = Array.isArray(data.exempt) ? data.exempt : []
  for (const entry of exempt) {
    if (typeof entry?.path !== 'string') throw new Error(`exempt[] entry missing path: ${JSON.stringify(entry)}`)
    if (typeof entry?.reason !== 'string' || entry.reason.trim().length < 10) {
      throw new Error(`exempt[] entry "${entry.path}" needs reason ≥ 10 chars`)
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.since || '')) {
      throw new Error(`exempt[] entry "${entry.path}" needs ISO since (YYYY-MM-DD)`)
    }
  }
  const c4Exempt = Array.isArray(data.c4Exempt) ? data.c4Exempt : []
  return { exempt, c4Exempt }
}

function expandReferenced(scripts, key, visited, out, root) {
  if (visited.has(key)) return
  visited.add(key)
  const value = scripts[key]
  if (!value) return
  for (const tok of tokenize(value)) {
    const npmRun = tok.match(/^npm\s+run\s+([\w:-]+)$/)
    if (npmRun) {
      const next = npmRun[1]
      if (!visited.has(next)) expandReferenced(scripts, next, visited, out, root)
      continue
    }
    if (looksLikeTestPath(tok)) {
      for (const file of expandGlob(tok, root)) {
        const rel = normalizePosix(path.relative(root, file))
        if (DISK_EXCLUDE_PREFIXES.some((p) => rel.startsWith(p))) continue
        out.add(rel)
      }
    }
    if (tok.includes('${') || /\$\w+/.test(tok)) {
      throw new Error(`unrecognized template token in script "${key}": ${tok}`)
    }
  }
}

// Cheap shell-style tokenizer: split on `&&` `||` `;` `|` and whitespace,
// keeping the test-path-like tokens. Strips matching surrounding quotes.
function tokenize(value) {
  // First split shell separators with placeholders.
  const SEP = /(\s+|&&|\|\||;|\|)/
  const parts = value.split(SEP).map((s) => s.trim()).filter(Boolean)
  const tokens = []
  let buf = []
  for (const p of parts) {
    if (p === '&&' || p === '||' || p === ';' || p === '|' || /^\s+$/.test(p)) {
      if (buf.length) { tokens.push(...buf); buf = [] }
    } else {
      let token = p
      if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
        token = token.slice(1, -1)
      }
      // Recombine `npm run X` across whitespace splits
      if ((tokens[tokens.length - 1] === 'npm' && (token === 'run')) || (tokens.length >= 2 && tokens[tokens.length - 2] === 'npm' && tokens[tokens.length - 1] === 'run')) {
        if (token === 'run') {
          tokens.push(token)
        } else {
          const last2 = tokens.splice(-2)
          tokens.push(`${last2.join(' ')} ${token}`)
        }
        continue
      }
      tokens.push(token)
    }
  }
  return tokens
}

function looksLikeTestPath(tok) {
  return (
    tok.endsWith('.test.ts') ||
    tok.endsWith('.test.tsx') ||
    tok.endsWith('.e2e.ts') ||
    tok.endsWith('.test.mjs') ||
    tok.endsWith('.test.cjs') ||
    /\*\.test\.[a-z]+$/.test(tok) ||
    /\*\*\/\*\.test\.[a-z]+$/.test(tok) ||
    (tok.includes('/__tests__/') && (tok.includes('*') || tok.endsWith('.ts') || tok.endsWith('.mjs') || tok.endsWith('.cjs')))
  )
}

// Mini glob — supports `*` (single segment, no /), `**` (multi segment),
// `[abc]` char classes, `{a,b}` simple braces. Sufficient for the patterns
// listed in TEST_EXTENSIONS and in package.json today.
function expandGlob(pattern, root) {
  // Brace expansion first: a{b,c}d → [abd, acd]
  const variants = expandBraces(pattern)
  const results = new Set()
  for (const variant of variants) {
    if (!variant.includes('*') && !variant.includes('?')) {
      const abs = path.resolve(root, variant)
      if (existsSync(abs) && statSync(abs).isFile()) results.add(realPath(abs))
      continue
    }
    const segments = variant.split('/')
    walk(root, segments, 0, results)
  }
  return [...results]
}

function expandBraces(pattern) {
  const m = pattern.match(/\{([^{}]+)\}/)
  if (!m) return [pattern]
  const before = pattern.slice(0, m.index)
  const after = pattern.slice(m.index + m[0].length)
  const opts = m[1].split(',')
  const out = []
  for (const opt of opts) {
    const expanded = expandBraces(`${before}${opt}${after}`)
    out.push(...expanded)
  }
  return out
}

function walk(currentDir, segments, idx, out) {
  if (idx >= segments.length) {
    if (existsSync(currentDir) && statSync(currentDir).isFile()) out.add(realPath(currentDir))
    return
  }
  const seg = segments[idx]
  if (!seg) { walk(currentDir, segments, idx + 1, out); return }

  if (seg === '**') {
    // ** matches zero or more path segments.
    walk(currentDir, segments, idx + 1, out) // zero
    if (!existsSync(currentDir)) return
    let entries
    try { entries = readdirSync(currentDir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      if (e.isDirectory()) walk(path.join(currentDir, e.name), segments, idx, out)
    }
    return
  }

  const re = segmentToRegex(seg)
  if (!existsSync(currentDir)) return
  let entries
  try { entries = readdirSync(currentDir, { withFileTypes: true }) } catch { return }
  const isLast = idx === segments.length - 1
  for (const e of entries) {
    if (!re.test(e.name)) continue
    const next = path.join(currentDir, e.name)
    if (isLast) {
      if (e.isFile()) out.add(realPath(next))
    } else if (e.isDirectory()) {
      walk(next, segments, idx + 1, out)
    }
  }
}

function segmentToRegex(seg) {
  let re = '^'
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]
    if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '[') {
      const close = seg.indexOf(']', i)
      if (close === -1) { re += '\\['; }
      else { re += seg.slice(i, close + 1); i = close }
    } else if ('.+^$|()\\'.includes(c)) re += '\\' + c
    else re += c
  }
  re += '$'
  return new RegExp(re)
}

function realPath(p) {
  try { return realpathSync(p) } catch { return p }
}

function normalizePosix(p) {
  return p.split(path.sep).join('/')
}

module.exports = {
  checkTestCoverageByVerify,
  TEST_EXTENSIONS,
  // exposed for unit tests
  _internals: {
    tokenize,
    expandGlob,
    expandReferenced,
    looksLikeTestPath,
    loadExemptions,
    normalizePosix,
  },
}
