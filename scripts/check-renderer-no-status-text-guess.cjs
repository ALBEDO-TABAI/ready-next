#!/usr/bin/env node
/**
 * Stage O §3.2 gate.
 *
 * Forbids the renderer from translating runtime data into Chinese task
 * status sentences, OR from reverse-parsing such sentences back into
 * state via `.includes()` / `.endsWith()` / `.startsWith()` patterns
 * inside a decision context (an `if (...)`, `return ...`, `set...(...)`,
 * or `switch (...)` on the same line).
 *
 * Scope: same trigger as the L5 vocabulary gate — only renderer files
 * that import a `TaskProjectionRecordData | ActiveChildRunSummaryData |
 * TaskCardRun` shape are scanned. This avoids false positives on
 * unrelated dialogs (e.g. `提交失败` in `SkillAskUserPrompt.tsx`,
 * `取消后台任务` button text in `ChatPanel.tsx`).
 *
 * Two violation categories:
 *
 * (A) Bare canonical-phrase literal in a non-vocabulary file.
 *     The 5 phrases are: `'后台任务已完成' | '后台任务已取消' |
 *     '后台任务失败' | '后台任务等待继续' | '后台任务正在运行'`. They
 *     are the literal output of the retired `childRunTaskSummary(row)`
 *     helper; reintroducing them is exactly the "guess state from text"
 *     pattern Stage O retires.
 *
 * (B) Reverse `.includes('完成'|'失败'|'等待'|'后台')` /
 *     `.endsWith('中')` / `.startsWith('已')` on a line that ALSO
 *     contains `if (`, `return `, `set<Identifier>(`, or `switch (`.
 *     These are state-decision contexts; even if the input came through
 *     the vocabulary helpers, parsing the label back into state is
 *     wrong (the canonical mapping is one-way).
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const SCAN_ROOT = 'src/renderer/'

const TYPE_TRIGGERS = [
  'TaskProjectionRecordData',
  'ActiveChildRunSummaryData',
  'TaskCardRun',
]

const FILE_ALLOWLIST = new Set([
  // Single-source vocabulary file is allowed to contain the phrases
  // (placeholder constant + canonical labels).
  'src/renderer/modules/agent/task-status-vocabulary.ts',
])

const FORBIDDEN_PHRASES = [
  '后台任务已完成',
  '后台任务已取消',
  '后台任务失败',
  '后台任务等待继续',
  '后台任务正在运行',
]

const REVERSE_INCLUDES_RE = /\.includes\(\s*['"](?:完成|失败|等待|后台)['"]\s*\)/
const REVERSE_ENDSWITH_RE = /\.endsWith\(\s*['"]中['"]\s*\)/
const REVERSE_STARTSWITH_RE = /\.startsWith\(\s*['"]已['"]\s*\)/
const DECISION_CONTEXT_RE = /\b(?:if\s*\(|return\s|set[A-Z][\w]*\s*\(|switch\s*\()/

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

function importsTrigger(text) {
  for (const t of TYPE_TRIGGERS) {
    const re = new RegExp(`\\b${t}\\b`)
    if (re.test(text)) return true
  }
  return false
}

function main() {
  const violations = []
  const dir = path.join(ROOT, SCAN_ROOT)
  if (!fs.existsSync(dir)) {
    console.log('check-renderer-no-status-text-guess: ok (no renderer dir)')
    return
  }

  for (const file of listFiles(dir)) {
    const rel = relposix(file)
    if (FILE_ALLOWLIST.has(rel)) continue
    if (rel.includes('/__tests__/')) continue
    const text = fs.readFileSync(file, 'utf8')
    if (!importsTrigger(text)) continue

    // (A) Forbidden full canonical phrases.
    for (const phrase of FORBIDDEN_PHRASES) {
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`['"\`]${escaped}['"\`]`, 'g')
      let m
      while ((m = re.exec(text))) {
        violations.push({
          file: rel,
          line: lineOf(text, m.index),
          kind: 'forbidden_phrase',
          detail: `inline canonical phrase "${phrase}" — must come from task-status-vocabulary helper`,
        })
      }
    }

    // (B) Reverse-includes / endsWith / startsWith in decision context.
    const lines = text.split(/\r?\n/)
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
      const line = lines[lineIdx]
      const reverseHit = REVERSE_INCLUDES_RE.test(line)
        || REVERSE_ENDSWITH_RE.test(line)
        || REVERSE_STARTSWITH_RE.test(line)
      if (!reverseHit) continue
      if (!DECISION_CONTEXT_RE.test(line)) continue
      violations.push({
        file: rel,
        line: lineIdx + 1,
        kind: 'reverse_text_decision',
        detail: 'reverse-includes/endsWith/startsWith on Chinese status fragment in decision context',
      })
    }
  }

  if (violations.length === 0) {
    console.log('check-renderer-no-status-text-guess: ok')
    return
  }
  console.error('check-renderer-no-status-text-guess: violations:')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.kind}] ${v.detail}`)
  }
  process.exit(1)
}

main()
