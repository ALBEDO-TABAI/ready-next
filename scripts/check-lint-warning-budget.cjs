#!/usr/bin/env node

/**
 * Lint warning debt budget check.
 *
 * Reads per-rule budgets from `docs/superpowers/operations/lint-warning-debt-ledger.md`
 * (the markdown table headed "Rule | Total | tests | main | renderer | shared | scripts | Budget | ..."),
 * runs `npm run lint:check`, parses warnings by rule, and fails if any rule's actual
 * warning count exceeds its budget.
 *
 * Owning plan: docs/superpowers/plans/2026-05-22-W2-lint-warning-debt-ledger-implementation.md
 *
 * Usage:
 *   node scripts/check-lint-warning-budget.cjs            # run lint and compare
 *   node scripts/check-lint-warning-budget.cjs --raw <f>  # skip lint, parse from file
 */

'use strict'

const { spawnSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const REPO_ROOT = resolve(__dirname, '..')
const LEDGER_PATH = resolve(
  REPO_ROOT,
  'docs/superpowers/operations/lint-warning-debt-ledger.md',
)
const UNUSED_DISABLE_RULE = '(eslint-core)/unused-disable-directive'
const UNUSED_DISABLE_PREFIX = 'Unused eslint-disable directive'

function main() {
  const args = parseArgs(process.argv.slice(2))
  const budgets = readBudgets(LEDGER_PATH)
  const lintOutput = args.rawPath ? readRaw(args.rawPath) : runLint()
  const counts = parseWarnings(lintOutput)
  const report = buildReport(budgets, counts)

  printTable(report.rows)
  console.log('')
  console.log(
    `Total warnings observed: ${report.totalActual} (budget total: ${report.totalBudget})`,
  )

  if (report.failures.length > 0) {
    console.error('')
    console.error('FAIL: rules exceeded their budget:')
    for (const failure of report.failures) {
      console.error(
        `  - ${failure.rule}: actual=${failure.actual}, budget=${failure.budget}, delta=+${failure.delta}`,
      )
    }
    console.error('')
    console.error(
      'Add or grow the rule row in lint-warning-debt-ledger.md (with rationale) or fix the new warnings.',
    )
    process.exit(1)
  }

  console.log('')
  console.log('OK: all rules within budget.')
  process.exit(0)
}

function parseArgs(argv) {
  const out = { rawPath: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--raw') {
      out.rawPath = argv[++i]
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node scripts/check-lint-warning-budget.cjs [--raw <file>]',
      )
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return out
}

function readRaw(path) {
  const resolved = resolve(REPO_ROOT, path)
  if (!existsSync(resolved)) {
    throw new Error(`--raw path not found: ${resolved}`)
  }
  return readFileSync(resolved, 'utf8')
}

function runLint() {
  const result = spawnSync('npm', ['run', 'lint:check', '--silent'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  // ESLint exits non-zero on errors. Warning-only runs exit 0.
  // We tolerate either; rule-level errors are a separate gate (W1 baseline).
  return `${result.stdout || ''}\n${result.stderr || ''}`
}

function readBudgets(path) {
  if (!existsSync(path)) {
    throw new Error(`Ledger not found: ${path}`)
  }
  const text = readFileSync(path, 'utf8')
  const lines = text.split(/\r?\n/)

  const headerIdx = lines.findIndex(
    (line) =>
      /^\|\s*Rule\s*\|/.test(line) &&
      /\|\s*Total\s*\|/.test(line) &&
      /\|\s*Budget\s*\|/.test(line),
  )
  if (headerIdx === -1) {
    throw new Error(
      'Ledger table header (Rule|Total|...|Budget|...) not found in ledger markdown.',
    )
  }
  const headerCols = splitRow(lines[headerIdx])
  const ruleCol = headerCols.indexOf('Rule')
  const budgetCol = headerCols.indexOf('Budget')
  if (ruleCol === -1 || budgetCol === -1) {
    throw new Error('Ledger table missing Rule or Budget column.')
  }

  const budgets = new Map()
  // Skip header and separator row.
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('|')) break
    const cols = splitRow(line)
    if (cols.length <= Math.max(ruleCol, budgetCol)) continue
    const rule = cols[ruleCol].trim()
    const budgetRaw = cols[budgetCol].trim()
    if (!rule || !/^\d+$/.test(budgetRaw)) continue
    budgets.set(rule, Number.parseInt(budgetRaw, 10))
  }
  if (budgets.size === 0) {
    throw new Error('Ledger table parsed but no rule rows found.')
  }
  return budgets
}

function splitRow(line) {
  // Drop leading/trailing pipes, then split on `|`.
  const trimmed = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function parseWarnings(output) {
  const counts = new Map()
  const lines = output.split(/\r?\n/)
  const warnLine = /^\s+\d+:\d+\s+warning\s+(.*)$/
  for (const line of lines) {
    const m = line.match(warnLine)
    if (!m) continue
    const rest = m[1]
    if (rest.startsWith(UNUSED_DISABLE_PREFIX)) {
      bump(counts, UNUSED_DISABLE_RULE)
      continue
    }
    // ESLint default formatter pads with two spaces before the rule id at end of line.
    const sepIdx = rest.lastIndexOf('  ')
    if (sepIdx === -1) {
      bump(counts, '(unknown)/unparsed')
      continue
    }
    const ruleId = rest.slice(sepIdx + 2).trim()
    if (!/^[@\w/.-]+$/.test(ruleId)) {
      bump(counts, '(unknown)/unparsed')
      continue
    }
    bump(counts, ruleId)
  }
  return counts
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1)
}

function buildReport(budgets, counts) {
  const ruleNames = new Set([...budgets.keys(), ...counts.keys()])
  const rows = []
  const failures = []
  let totalBudget = 0
  let totalActual = 0
  for (const rule of ruleNames) {
    const budget = budgets.has(rule) ? budgets.get(rule) : 0
    const actual = counts.get(rule) || 0
    const delta = actual - budget
    totalBudget += budget
    totalActual += actual
    rows.push({ rule, budget, actual, delta })
    if (delta > 0) {
      failures.push({ rule, budget, actual, delta })
    }
  }
  rows.sort((a, b) => {
    if (b.actual !== a.actual) return b.actual - a.actual
    return a.rule.localeCompare(b.rule)
  })
  return { rows, failures, totalBudget, totalActual }
}

function printTable(rows) {
  const header = ['Rule', 'Budget', 'Actual', 'Delta']
  const widths = header.map((h) => h.length)
  const stringRows = rows.map((r) => [
    r.rule,
    String(r.budget),
    String(r.actual),
    (r.delta > 0 ? '+' : '') + String(r.delta),
  ])
  for (const row of stringRows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i], cell.length)
    })
  }
  const pad = (cell, i, isNumber) =>
    isNumber ? cell.padStart(widths[i], ' ') : cell.padEnd(widths[i], ' ')
  const fmt = (row) =>
    row
      .map((cell, i) => pad(cell, i, i !== 0))
      .join('  ')
  console.log(fmt(header))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const row of stringRows) {
    console.log(fmt(row))
  }
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.stack || err.message : String(err))
  process.exit(2)
}
