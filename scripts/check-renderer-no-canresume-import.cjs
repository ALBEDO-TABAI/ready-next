#!/usr/bin/env node
/**
 * Stage Q (Stage 11) — renderer must not import canResume helpers.
 *
 * Stage Q implementation plan §3.1: UI consumes the pre-computed
 * `projection.canResume` field that main derives at
 * `runtime.listTaskProjections()` / `runtime.getTaskProjection()`.
 * Renderer code must not import `canResumeShape` / `canResumeWithFs`
 * because the fs probe form requires node:fs (renderer shouldn't depend
 * on it) and the shape form would tempt UI to derive its own truth
 * diverging from main-side truth.
 *
 * Two scan passes (Codex review round 4):
 *
 *   PASS A — comments-only stripped (string contents intact):
 *     looks for import-path patterns whose match relies on the
 *     literal `'...resume-handle'` substring being preserved
 *     (`from '...'`, `import('...')`, `require('...')`).
 *
 *   PASS B — strings-and-comments stripped:
 *     looks for identifier-shaped patterns (`canResumeShape(`,
 *     `canResumeWithFs(`) so a string literal like
 *     `const s = 'canResumeShape('` does NOT false-positive.
 *
 * Newlines are preserved in both projections so byte offsets convert
 * back to original-source line numbers.
 *
 * Documented residual risk (accepted): runtime string-concat hiding
 * (`require('reso' + 'me-handle')`), barrel re-export under an alias
 * the gate doesn't recognize. Solving these requires AST analysis;
 * Stage Q PR-1+2 stays regex-based per implementation plan §3.1.
 *
 * `--root <path>` lets tests point the gate at a fixture tree.
 *
 * Exit 0 on clean; exit 1 with violations otherwise.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  stripCodeStringsAndComments,
  stripCommentsOnly,
  indexToLine,
  buildIsInsideStringMask,
} = require('./_lib_strip_code_strings_and_comments.cjs')

const REPO_DEFAULT = path.resolve(__dirname, '..')

// PATH_PATTERNS run against `stripCommentsOnly` output (string contents
// preserved). Allows `'`, `"`, AND backtick (`) delimiters since
// `import(\`...resume-handle\`)` is valid runtime form.
const PATH_PATTERNS = [
  {
    name: "static import from 'resume-handle' module",
    regex: /\bfrom\s+(['"`])[^'"`]*resume-handle\1/g,
  },
  {
    name: "dynamic import('resume-handle')",
    regex: /\bimport\s*\(\s*(['"`])[^'"`]*resume-handle\1/g,
  },
  {
    name: "require('resume-handle')",
    regex: /\brequire\s*\(\s*(['"`])[^'"`]*resume-handle\1/g,
  },
]

// IDENTIFIER_PATTERNS run against `stripCodeStringsAndComments` output
// (strings blanked) so `'canResumeShape('` literally inside a string
// doesn't false-positive.
//
// Forms covered:
//   - `canResumeShape(...)` direct call
//   - `canResumeShape?.(...)` optional call
//   - `canResumeShape.call(...)` / `.apply(...)` / `.bind(...)`
// Documented residual (accepted): `(canResumeShape)(...)` parenthesized
// reference, `[canResumeShape](...)` bracketed reference, dynamic
// destructure-then-call. AST-level scanning would close these.
const IDENTIFIER_PATTERNS = [
  {
    name: 'canResumeShape() direct/optional call',
    regex: /\bcanResumeShape\s*(?:\?\.)?\s*\(/g,
  },
  {
    name: 'canResumeShape.call/apply/bind',
    regex: /\bcanResumeShape\s*\.\s*(?:call|apply|bind)\s*\(/g,
  },
  {
    name: 'canResumeWithFs() direct/optional call',
    regex: /\bcanResumeWithFs\s*(?:\?\.)?\s*\(/g,
  },
  {
    name: 'canResumeWithFs.call/apply/bind',
    regex: /\bcanResumeWithFs\s*\.\s*(?:call|apply|bind)\s*\(/g,
  },
]

function listFiles(dir, exts = ['.ts', '.tsx']) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        stack.push(full)
      } else if (exts.includes(path.extname(entry.name))) {
        out.push(full)
      }
    }
  }
  return out
}

function scan(root) {
  const scanDir = path.join(root, 'src/renderer')
  if (!fs.existsSync(scanDir)) return { violations: [], skipped: true }
  const violations = []
  for (const file of listFiles(scanDir)) {
    let src
    try {
      src = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    // PASS A — keep strings intact for import path detection.
    // The match's *opening* keyword (`from` / `import` / `require`) must
    // itself be in code state, not nested inside another string literal
    // of the original source. Use the inside-string mask of the original
    // to skip false-positives from string literals that contain a full
    // import-form text (e.g. `const docs = "import('resume-handle')"`).
    const passA = stripCommentsOnly(src)
    const insideString = buildIsInsideStringMask(src)
    for (const { name, regex } of PATH_PATTERNS) {
      regex.lastIndex = 0
      let m
      while ((m = regex.exec(passA)) !== null) {
        if (insideString[m.index]) continue
        violations.push({
          file,
          line: indexToLine(src, m.index),
          pattern: name,
          preview: m[0].slice(0, 120).replace(/\s+/g, ' ').trim(),
        })
      }
    }
    // PASS B — blank strings to avoid identifier-in-string false positives.
    const passB = stripCodeStringsAndComments(src)
    for (const { name, regex } of IDENTIFIER_PATTERNS) {
      regex.lastIndex = 0
      let m
      while ((m = regex.exec(passB)) !== null) {
        violations.push({
          file,
          line: indexToLine(src, m.index),
          pattern: name,
          preview: m[0].slice(0, 120).replace(/\s+/g, ' ').trim(),
        })
      }
    }
  }
  return { violations, skipped: false }
}

function parseRoot(argv) {
  let root = REPO_DEFAULT
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && i + 1 < argv.length) {
      root = path.resolve(argv[i + 1])
      i++
    }
  }
  return root
}

function main() {
  const root = parseRoot(process.argv.slice(2))
  const { violations, skipped } = scan(root)
  if (skipped) {
    console.log('[check-renderer-no-canresume-import] OK (renderer dir absent)')
    return 0
  }
  if (violations.length === 0) {
    console.log('[check-renderer-no-canresume-import] OK')
    return 0
  }
  console.error('[check-renderer-no-canresume-import] FAIL')
  for (const v of violations) {
    console.error(`  ${path.relative(root, v.file)}:${v.line} — ${v.pattern}`)
    console.error(`    code: ${v.preview}`)
  }
  console.error('')
  console.error('Stage Q (Stage 11): renderer must not import resume-handle helpers.')
  console.error('Read pre-computed projection.canResume instead.')
  return 1
}

if (require.main === module) {
  process.exit(main())
}

module.exports = { main, scan }
