#!/usr/bin/env node
/**
 * Stage 6 L5 gate. Asserts that canonical Chinese task-status labels live
 * exclusively in `task-status-vocabulary.ts`. Any other renderer file that
 * consumes a `ScopeRunState | TaskProjectionRecordData | ActiveChildRunSummaryData |
 * TaskCardRun`-shaped value must call into the vocabulary helpers; inlining
 * a canonical label is a violation.
 *
 * Scope (intentionally narrow):
 *   - Only renderer files (under `src/renderer/`) are scanned.
 *   - Only files that import any of:
 *       `ScopeRunState`, `TaskProjectionRecordData`,
 *       `ActiveChildRunSummaryData`, `TaskCardRun`
 *     from a renderer/agent or preload type-declaration path are scanned.
 *   - The vocabulary helper file itself (`task-status-vocabulary.ts`) is
 *     allowlisted.
 *   - Test files (`__tests__`) are skipped.
 *
 * The canonical label list is read from `__GATE_CANONICAL_LABELS` exported by
 * the vocabulary file. The gate parses that array literal so the gate and the
 * helper cannot drift out of sync.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const VOCAB_REL = 'src/renderer/modules/agent/task-status-vocabulary.ts'
const SCAN_ROOT = 'src/renderer/'

const TYPE_TRIGGERS = [
  'ScopeRunState',
  'TaskProjectionRecordData',
  'ActiveChildRunSummaryData',
  'TaskCardRun',
]

/**
 * Files exempt from the L5 gate. These render task-related data on a
 * non-agent surface (e.g. desktop pet) with intentionally different wording;
 * the canonical vocabulary helpers don't fit. Each entry must be a relative
 * POSIX path and must include a comment explaining why.
 */
const FILE_ALLOWLIST = new Set([
  // The pet activity surface uses a different label register
  // (`'正在思考'` vs `'进行中'`); only `'已停止'` happens to collide with the
  // canonical set. Keeping pet wording independent is intentional UX.
  'src/renderer/modules/pet/petActivitySnapshot.ts',
])

function listFiles(dirAbs) {
  const out = []
  const stack = [dirAbs]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      const p = path.join(cur, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
        stack.push(p)
      } else if (ent.isFile() && (ent.name.endsWith('.ts') || ent.name.endsWith('.tsx'))) {
        out.push(p)
      }
    }
  }
  return out
}

function relposix(p) {
  return path.relative(ROOT, p).split(path.sep).join('/')
}

function lineOf(text, idx) {
  return text.slice(0, idx).split(/\r?\n/).length
}

function readCanonicalLabels() {
  const abs = path.join(ROOT, VOCAB_REL)
  if (!fs.existsSync(abs)) {
    throw new Error(`L5 gate: vocabulary file missing at ${VOCAB_REL}`)
  }
  const text = fs.readFileSync(abs, 'utf8')
  const re = /__GATE_CANONICAL_LABELS[^[]*\[([^\]]+)\]/m
  const m = re.exec(text)
  if (!m) {
    throw new Error(`L5 gate: __GATE_CANONICAL_LABELS array literal not found in ${VOCAB_REL}`)
  }
  const inner = m[1]
  const labels = []
  const litRe = /'([^']+)'|"([^"]+)"/g
  let lit
  while ((lit = litRe.exec(inner))) {
    labels.push(lit[1] || lit[2])
  }
  return labels
}

function importsTrigger(text) {
  // Coarse: any import line mentions any trigger name. We don't need to
  // distinguish import type vs value; if a renderer file *types* against
  // these shapes, it's an agent-surface consumer and is in scope.
  for (const t of TYPE_TRIGGERS) {
    const re = new RegExp(`\\b${t}\\b`)
    if (re.test(text)) return true
  }
  return false
}

function main() {
  const violations = []
  let canonicalLabels
  try {
    canonicalLabels = readCanonicalLabels()
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
  if (canonicalLabels.length === 0) {
    console.error('L5 gate: __GATE_CANONICAL_LABELS is empty')
    process.exit(1)
  }
  const labelSet = new Set(canonicalLabels)

  const dir = path.join(ROOT, SCAN_ROOT)
  if (!fs.existsSync(dir)) {
    console.log('check-status-vocabulary-single-source: ok (no renderer dir)')
    return
  }

  for (const file of listFiles(dir)) {
    const rel = relposix(file)
    if (rel === VOCAB_REL) continue
    if (rel.includes('/__tests__/')) continue
    if (FILE_ALLOWLIST.has(rel)) continue
    const text = fs.readFileSync(file, 'utf8')
    if (!importsTrigger(text)) continue

    // Find every string literal containing a canonical label.
    const litRe = /['"`]([^'"`\n]+)['"`]/g
    let m
    while ((m = litRe.exec(text))) {
      const literal = m[1]
      if (labelSet.has(literal)) {
        violations.push({
          file: rel,
          line: lineOf(text, m.index),
          kind: 'inline_canonical_label',
          detail: `inline label "${literal}" — must call task-status-vocabulary helper`,
        })
      }
    }
  }

  if (violations.length === 0) {
    console.log(`check-status-vocabulary-single-source: ok (${canonicalLabels.length} canonical labels checked)`)
    return
  }
  console.error('check-status-vocabulary-single-source: violations:')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.kind}] ${v.detail}`)
  }
  process.exit(1)
}

main()
