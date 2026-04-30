#!/usr/bin/env node

const { existsSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs')
const { relative, resolve } = require('node:path')

const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?|mjs|cjs)$/
const SKIP_DIRS = new Set(['.git', '.vite', 'dist', 'node_modules', 'out'])
const AREA_POLICY = {
  'a1-gate': 'Must clear before A1 admission',
  'ui-history': 'Frozen; count never grows but cleanup not blocking',
  'other-a0': 'Non-source-grep A0 baseline entries; outside A0.5 cleanup scope',
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

async function main() {
  const {
    A05_AREA_VALUES,
    classifyA05Area,
    findingKey,
    scanA0RuleViolations,
  } = await import('../eslint-rules/a0-rule-utils.mjs')
  const options = parseArgs(process.argv.slice(2), A05_AREA_VALUES)
  const root = options.root
  const baselinePath = resolve(root, 'eslint-rules/baseline.json')

  const current = []
  for (const file of listSourceFiles(root)) {
    const sourceText = readFileSync(resolve(root, file), 'utf8')
    current.push(...scanA0RuleViolations({ filePath: file, sourceText }))
  }
  current.sort(compareEntries)

  if (options.update) {
    writeBaseline(baselinePath, current, classifyA05Area)
    console.log(`Updated eslint-rules/baseline.json with ${current.length} entries.`)
    return
  }

  if (!existsSync(baselinePath)) {
    throw new Error('Missing eslint-rules/baseline.json. Run node scripts/check-eslint-baseline.cjs --update first.')
  }

  const baseline = readBaseline(baselinePath)
  validateBaselineSchema(baseline, { allowedAreas: A05_AREA_VALUES, classifyA05Area })
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

  if (options.area) {
    reportArea({
      area: options.area,
      max: options.max,
      current,
      baseline: baseline.entries,
      classifyA05Area,
    })
    return
  }

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

function parseArgs(argv, allowedAreas) {
  const options = {
    root: resolve(__dirname, '..'),
    update: false,
    area: null,
    max: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--update') {
      options.update = true
    } else if (arg === '--root') {
      const value = argv[i + 1]
      if (!value) throw new Error(usage('Missing value for --root'))
      options.root = resolve(value)
      i += 1
    } else if (arg === '--area') {
      const value = argv[i + 1]
      if (!value || !allowedAreas.has(value)) throw new Error(usage(`Unknown area "${value || ''}".`))
      options.area = value
      i += 1
    } else if (arg === '--max') {
      const value = argv[i + 1]
      if (!/^\d+$/.test(String(value || ''))) throw new Error(usage(`Invalid --max "${value || ''}".`))
      options.max = Number(value)
      i += 1
    } else {
      throw new Error(usage(`Unknown argument "${arg}".`))
    }
  }
  if (options.max !== null && !options.area) {
    throw new Error(usage('--max requires --area.'))
  }
  return options
}

function usage(message) {
  return [
    message,
    'Usage: node scripts/check-eslint-baseline.cjs [--root <path>] [--update] [--area a1-gate|ui-history|other-a0] [--max <count>]',
  ].join('\n')
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

function readBaseline(baselinePath) {
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const entries = Array.isArray(parsed.entries) ? parsed.entries : []
  return { ...parsed, entries }
}

function writeBaseline(baselinePath, entries, classifyA05Area) {
  const payload = {
    version: 2,
    identity: 'file + rule + snippetHash; line is display-only',
    areaPolicy: AREA_POLICY,
    entries: entries.map((entry) => ({
      file: entry.file,
      rule: entry.rule,
      snippetHash: entry.snippetHash,
      line: entry.line,
      snippet: entry.snippet,
      area: classifyA05Area(entry),
    })),
  }
  writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`)
}

function validateBaselineSchema(baseline, { allowedAreas, classifyA05Area }) {
  if (baseline.version === 2) {
    for (const entry of baseline.entries) {
      if (!Object.prototype.hasOwnProperty.call(entry, 'area')) {
        throw new Error(`Missing baseline area for ${formatEntry(entry)}`)
      }
      if (!allowedAreas.has(entry.area)) {
        throw new Error(`Invalid baseline area "${entry.area}" for ${formatEntry(entry)}`)
      }
      const expected = classifyA05Area(entry)
      if (entry.area !== expected) {
        throw new Error(`Baseline area mismatch for ${formatEntry(entry)}: expected ${expected}, got ${entry.area}`)
      }
    }
  }
}

function reportArea({ area, max, current, baseline, classifyA05Area }) {
  const currentEntries = current.filter((entry) => classifyA05Area(entry) === area)
  const baselineEntries = baseline.filter((entry) => entry.area === area)
  const byFile = new Map()
  for (const entry of currentEntries) {
    byFile.set(entry.file, (byFile.get(entry.file) || 0) + 1)
  }
  console.log(`${area} current entries: ${currentEntries.length}`)
  console.log(`${area} baseline entries: ${baselineEntries.length}`)
  console.log(`files: ${byFile.size}`)
  for (const [file, count] of [...byFile.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    console.log(`${file}: ${count}`)
  }
  if (max !== null && currentEntries.length > max) {
    throw new Error(`${area} current entries ${currentEntries.length} exceeds max ${max}`)
  }
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
