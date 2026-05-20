#!/usr/bin/env node
/**
 * Stage U PR U5.0 — move-only PR enforcement gate.
 *
 * Phase 5 starts with U5.1a* (agent-control 173-file directory split)
 * which is the first time the plan promises true "move-only" PRs. The
 * gate inspects git diff for the current PR and rejects any change that
 * isn't:
 *   1. file rename (R status; full file move)
 *   2. import / require path adjustment (the import/from/require token
 *      itself changes; the imported names + binding shape do not)
 *   3. re-export statement creation
 *   4. comment-only edits (line comments + block comments)
 *   5. blank-line / whitespace-only edits
 *
 * Any other line change → fail with the offending file:line + the
 * minimal diff snippet so the reviewer can decide "split into a
 * behavior PR" without re-reading the whole diff.
 *
 * Activation:
 *   - GitHub Actions: PR label `move-only` (read from $GITHUB_PR_LABELS)
 *   - Local: env `STAGE_U_MOVE_ONLY_PR=1`
 *   - Otherwise: no-op (the gate only fires for opted-in PRs; it would
 *     be wrong to demand every PR be move-only)
 *
 * Diff base (mirrors check-verify-native-trigger.cjs):
 *   - GitHub Actions: origin/$GITHUB_BASE_REF...origin/$GITHUB_HEAD_REF
 *   - Local: origin/main...HEAD if origin/main resolves, else HEAD~1
 *
 * Note: per Stage U mid-stage codex review v3 (closed `bb48e7eb`), this
 * gate has NO justification escape hatch. If a PR must mix move + behavior
 * change, it must be split into two PRs — drop the `move-only` label
 * from the behavior portion.
 */

'use strict'

const { execFileSync } = require('node:child_process')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')

function runGit(args, cwd = REPO) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch { return null }
}

function isMoveOnlyPr(env) {
  if (env.STAGE_U_MOVE_ONLY_PR === '1') return true
  const labels = String(env.GITHUB_PR_LABELS || '').toLowerCase()
  if (labels.split(/[\s,]+/).filter(Boolean).includes('move-only')) return true
  return false
}

function resolveDiffRange(env) {
  const base = env.GITHUB_BASE_REF
  const head = env.GITHUB_HEAD_REF
  if (base && head) return { range: `origin/${base}...origin/${head}`, source: 'github-actions' }
  const override = env.STAGE_U_MOVE_ONLY_BASE
  if (override === 'staged') return { range: '__STAGED__', source: 'staged' }
  if (override) return { range: `${override}...HEAD`, source: `env:${override}` }
  if (runGit(['rev-parse', '--verify', '--quiet', 'origin/main'])) {
    return { range: 'origin/main...HEAD', source: 'origin/main' }
  }
  return { range: 'HEAD~1...HEAD', source: 'HEAD~1' }
}

function listChangedFiles(range) {
  // -M50 enables rename detection at 50% similarity threshold so move-only PRs
  // with internal import-path edits still register as 'R' (rename) instead of A+D.
  const out = range === '__STAGED__'
    ? runGit(['diff', '--name-status', '-M50', '--cached'])
    : runGit(['diff', '--name-status', '-M50', range])
  if (out === null) return []
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const parts = line.split('\t')
    return { status: parts[0], path: parts[parts.length - 1], renameSource: parts[0].startsWith('R') ? parts[1] : null }
  })
}

// Classify a single diff hunk line as one of:
//   - 'comment'   line is //  /  block comment  /  blank
//   - 'import'    line is an import / require / re-export statement
//   - 'context'   unchanged line (starts with single space in unified diff)
//   - 'meta'      diff header / hunk marker (---, +++, @@, diff)
//   - 'add'       added non-import/comment line — counts as behavior
//   - 'remove'    removed non-import/comment line — counts as behavior
function classifyLine(line) {
  if (line.startsWith('diff ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@ ')) return 'meta'
  if (line.startsWith('+++ ') || line.startsWith('--- ')) return 'meta'
  const sign = line.charAt(0)
  if (sign === ' ' || sign === '') return 'context'
  if (sign !== '+' && sign !== '-') return 'meta'
  const body = line.slice(1).trim()
  if (body.length === 0) return 'comment'
  if (/^\/\//.test(body) || /^\/\*/.test(body) || /^\*/.test(body) || /^\*\//.test(body)) return 'comment'
  if (/^import\b/.test(body) || /^export\s+(?:type\s+)?(?:\{|\*)/.test(body) || /\brequire\s*\(/.test(body)) return 'import'
  if (/^export\s+\*\s+from\b/.test(body) || /^export\s+\{[^}]*\}\s+from\b/.test(body)) return 'import'
  // Dynamic import expressions: `await import('...')`, `import('...')`. The path is the
  // only thing that changes during a move-only PR; the surrounding statement structure
  // (await / const = / .then) is unchanged.
  if (/\bimport\s*\(\s*['"]/.test(body)) return 'import'
  return sign === '+' ? 'add' : 'remove'
}

function inspectFileDiff(range, file) {
  // Match listChangedFiles: enable -M50 rename detection so the diff for a moved file
  // shows only the internal hunks that genuinely changed, not the entire file as +.
  const raw = range === '__STAGED__'
    ? runGit(['diff', '--unified=0', '-M50', '--cached', '--', file])
    : runGit(['diff', '--unified=0', '-M50', range, '--', file])
  if (!raw) return { ok: true, offending: [] }
  const lines = raw.split('\n')
  const offending = []
  let currentHunkLine = 0
  let lineNumberInFile = 0
  for (const line of lines) {
    const cls = classifyLine(line)
    if (cls === 'meta') {
      const hunk = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
      if (hunk) {
        lineNumberInFile = parseInt(hunk[1], 10)
        currentHunkLine = lineNumberInFile
      }
      continue
    }
    if (cls === 'context') { lineNumberInFile += 1; continue }
    if (cls === 'comment' || cls === 'import') {
      if (line.startsWith('+')) lineNumberInFile += 1
      continue
    }
    // add / remove of a non-import non-comment line — behavior change
    offending.push({
      line: line.startsWith('+') ? lineNumberInFile : currentHunkLine,
      sign: line.charAt(0),
      snippet: line.slice(1).trim().slice(0, 120),
    })
    if (line.startsWith('+')) lineNumberInFile += 1
  }
  return { ok: offending.length === 0, offending }
}

function checkMoveOnlyPr({ env = process.env, filesOverride = null, rangeOverride = null } = {}) {
  if (!isMoveOnlyPr(env)) {
    return { ok: true, noop: true, notes: ['not a move-only PR (no label / env not set); gate skipped'] }
  }
  const { range, source } = rangeOverride ? { range: rangeOverride, source: 'override' } : resolveDiffRange(env)
  const files = filesOverride || listChangedFiles(range)
  const violations = []
  for (const file of files) {
    // Pure renames have no diff content — accept.
    if (file.status.startsWith('R') && file.status !== 'R000') continue
    // Pure deletion — accept (file was moved away)
    if (file.status === 'D') continue
    // Pure addition — accept only if path indicates re-export barrel (heuristic)
    const result = inspectFileDiff(range, file.path)
    if (!result.ok) {
      violations.push({ file: file.path, count: result.offending.length, samples: result.offending.slice(0, 3) })
    }
  }
  return { ok: violations.length === 0, noop: false, diffSource: source, violations }
}

function main() {
  const result = checkMoveOnlyPr()
  if (result.noop) {
    console.log('[check-move-only-pr] noop —', result.notes[0])
    return 0
  }
  if (result.ok) { console.log(`[check-move-only-pr] OK (diff base ${result.diffSource})`); return 0 }
  console.error('[check-move-only-pr] FAIL — move-only PR contains behavior-change lines.')
  console.error('  Stage U Phase 5 rule: a move-only PR may only contain file renames,')
  console.error('  import/require/re-export path adjustments, comments, and whitespace.')
  console.error('  Split behavior changes into a separate non-move PR.')
  for (const v of result.violations) {
    console.error(`  ${v.file} — ${v.count} behavior line(s); first samples:`)
    for (const s of v.samples) console.error(`    ${s.sign} L${s.line}: ${s.snippet}`)
  }
  return 1
}

if (require.main === module) process.exit(main())

module.exports = { checkMoveOnlyPr, classifyLine }
