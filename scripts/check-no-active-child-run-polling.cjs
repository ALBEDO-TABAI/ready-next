#!/usr/bin/env node
/**
 * Stage O §3.4 gate.
 *
 * The renderer must NOT poll `agent.listActiveChildRuns(...)` from a
 * `setInterval(...)` body. Stage O retires the 2-second timer in favor
 * of the `agent:taskProjectionsChanged` push event; reintroducing a
 * timer slides back to the pre-Stage-O behavior (UI flicker, missed
 * states, IPC churn).
 *
 * Allowed escape hatch: a setInterval block that has the literal
 * comment `// gate-allow:active-child-run-debug` within the 5 lines
 * preceding the `setInterval(` call. This exists so a future debug
 * panel can opt-in explicitly without weakening the rule.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const SCAN_ROOT = 'src/renderer/'

const ALLOW_MARKER = 'gate-allow:active-child-run-debug'

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

/**
 * Walk text from `start` (a `setInterval(` index) using paren depth so
 * we can locate the matching `)`. Returns the body slice (between the
 * opening `(` and matching `)`) plus the end index.
 */
function captureCallBody(text, callStart) {
  let i = callStart
  while (i < text.length && text[i] !== '(') i += 1
  if (text[i] !== '(') return null
  const open = i
  let depth = 0
  let inString = null
  for (let j = i; j < text.length; j += 1) {
    const ch = text[j]
    if (inString) {
      if (ch === '\\') { j += 1; continue }
      if (ch === inString) inString = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return { body: text.slice(open + 1, j), end: j }
    }
  }
  return null
}

function precedingLines(text, idx, count) {
  const before = text.slice(0, idx)
  const lines = before.split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - count - 1)).join('\n')
}

function main() {
  const violations = []
  const dir = path.join(ROOT, SCAN_ROOT)
  if (!fs.existsSync(dir)) {
    console.log('check-no-active-child-run-polling: ok (no renderer dir)')
    return
  }

  const callRe = /\bsetInterval\s*\(/g
  for (const file of listFiles(dir)) {
    const rel = relposix(file)
    if (rel.includes('/__tests__/')) continue
    const text = fs.readFileSync(file, 'utf8')
    let m
    while ((m = callRe.exec(text))) {
      const captured = captureCallBody(text, m.index)
      if (!captured) continue
      const body = captured.body
      if (!/listActiveChildRuns\s*\(/.test(body)) continue
      const before = precedingLines(text, m.index, 5)
      if (before.includes(ALLOW_MARKER)) continue
      // Compute line of the setInterval call.
      const line = text.slice(0, m.index).split(/\r?\n/).length
      violations.push({
        file: rel,
        line,
        kind: 'polling_listActiveChildRuns',
        detail: 'setInterval body calls listActiveChildRuns — Stage O retired the 2s timer; subscribe to agent:taskProjectionsChanged or add `// gate-allow:active-child-run-debug` to opt-in for a debug surface',
      })
    }
  }

  if (violations.length === 0) {
    console.log('check-no-active-child-run-polling: ok')
    return
  }
  console.error('check-no-active-child-run-polling: violations:')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.kind}] ${v.detail}`)
  }
  process.exit(1)
}

main()
