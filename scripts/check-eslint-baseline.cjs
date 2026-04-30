#!/usr/bin/env node

const { existsSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs')
const { relative, resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
const BASELINE_PATH = resolve(ROOT, 'eslint-rules/baseline.json')
const UPDATE = process.argv.includes('--update')
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?|mjs|cjs)$/
const SKIP_DIRS = new Set(['.git', '.vite', 'dist', 'node_modules', 'out'])

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

async function main() {
  const {
    findingKey,
    scanA0RuleViolations,
  } = await import('../eslint-rules/a0-rule-utils.mjs')

  const current = []
  for (const file of listSourceFiles(ROOT)) {
    const sourceText = readFileSync(resolve(ROOT, file), 'utf8')
    current.push(...scanA0RuleViolations({ filePath: file, sourceText }))
  }
  current.sort(compareEntries)

  if (UPDATE) {
    writeBaseline(current)
    console.log(`Updated eslint-rules/baseline.json with ${current.length} entries.`)
    return
  }

  if (!existsSync(BASELINE_PATH)) {
    throw new Error('Missing eslint-rules/baseline.json. Run node scripts/check-eslint-baseline.cjs --update first.')
  }

  const baseline = readBaseline()
  const baselineByKey = new Map()
  const duplicateKeys = []
  for (const entry of baseline.entries) {
    const key = findingKey(entry)
    if (baselineByKey.has(key)) duplicateKeys.push(key)
    baselineByKey.set(key, entry)
  }
  if (duplicateKeys.length > 0) {
    throw new Error(`Duplicate baseline entries:\n${duplicateKeys.join('\n')}`)
  }

  const currentByKey = new Map(current.map((entry) => [findingKey(entry), entry]))
  const newEntries = current.filter((entry) => !baselineByKey.has(findingKey(entry)))
  const staleEntries = baseline.entries.filter((entry) => !currentByKey.has(findingKey(entry)))

  if (newEntries.length > 0 || staleEntries.length > 0) {
    const lines = []
    if (newEntries.length > 0) {
      lines.push('New A0 ESLint violations not in baseline:')
      lines.push(...newEntries.map(formatEntry))
    }
    if (staleEntries.length > 0) {
      lines.push('Stale A0 ESLint baseline entries; remove or regenerate them:')
      lines.push(...staleEntries.map(formatEntry))
    }
    throw new Error(lines.join('\n'))
  }

  console.log(`A0 ESLint baseline ok (${current.length} entries).`)
}

function listSourceFiles(root) {
  const files = []
  walk(resolve(root, 'src'))
  if (existsSync(resolve(root, 'scripts'))) walk(resolve(root, 'scripts'))
  return files.sort()

  function walk(dir) {
    const base = dir.split('/').pop()
    if (SKIP_DIRS.has(base)) return
    for (const entry of readdirSync(dir)) {
      const abs = resolve(dir, entry)
      const stat = statSync(abs)
      if (stat.isDirectory()) {
        walk(abs)
      } else if (stat.isFile() && SOURCE_EXT_RE.test(entry)) {
        files.push(relative(root, abs).replaceAll('\\', '/'))
      }
    }
  }
}

function readBaseline() {
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  const entries = Array.isArray(parsed.entries) ? parsed.entries : []
  return { ...parsed, entries }
}

function writeBaseline(entries) {
  const payload = {
    version: 1,
    identity: 'file + rule + snippetHash; line is display-only',
    entries: entries.map((entry) => ({
      file: entry.file,
      rule: entry.rule,
      snippetHash: entry.snippetHash,
      line: entry.line,
      snippet: entry.snippet,
    })),
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`)
}

function compareEntries(a, b) {
  return a.file.localeCompare(b.file)
    || a.rule.localeCompare(b.rule)
    || a.line - b.line
    || a.snippetHash.localeCompare(b.snippetHash)
}

function formatEntry(entry) {
  return `- ${entry.file}:${entry.line} ${entry.rule} ${entry.snippetHash} ${entry.snippet}`
}
