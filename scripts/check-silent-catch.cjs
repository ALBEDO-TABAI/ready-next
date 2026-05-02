#!/usr/bin/env node

const { createHash } = require('node:crypto')
const { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join, relative, resolve } = require('node:path')

const ts = require('typescript')

const DEFAULT_SCAN_ROOTS = [
  'src/main/modules/agent-control',
  'src/main/modules/skills-runtime',
  'src/main/modules/tools',
  'src/renderer',
]
const DEFAULT_BASELINE = 'scripts/snapshots/silent-catch-baseline.json'
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])

main()

function main() {
  if (require.main !== module) return
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.update) {
      const entries = scanSilentCatches(options)
      writeBaseline(options, entries)
      console.log(`silent catch baseline updated: ${entries.length} entries`)
      return
    }
    const result = checkSilentCatch(options)
    if (!result.ok) {
      console.error('silent catch check failed:')
      for (const violation of result.violations) {
        console.error(`- ${violation.file}:${violation.line} ${violation.message}`)
      }
      process.exit(1)
    }
    console.log(`silent catch: ok (${result.baselineEntries.length} baseline entries)`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

function parseArgs(argv) {
  const options = {
    root: resolve(__dirname, '..'),
    baselinePath: DEFAULT_BASELINE,
    update: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --root.')
      options.root = resolve(value)
      i += 1
    } else if (arg === '--baseline') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --baseline.')
      options.baselinePath = value
      i += 1
    } else if (arg === '--update') {
      options.update = true
    } else {
      throw new Error(`Unknown argument "${arg}".`)
    }
  }
  return options
}

function checkSilentCatch(options = {}) {
  const root = resolve(options.root || resolve(__dirname, '..'))
  const baselinePath = options.baselinePath === null
    ? null
    : resolve(root, options.baselinePath || DEFAULT_BASELINE)
  const baselineResult = readBaseline(baselinePath)
  const baselineKeys = new Set(baselineResult.entries.map(entryKey))
  const violations = [...baselineResult.violations]

  for (const entry of scanSilentCatches({ ...options, root })) {
    if (baselineKeys.has(entryKey(entry))) continue
    violations.push({
      ...entry,
      message: 'silent catch without metric/log/throw/comment or baseline entry',
    })
  }

  return {
    ok: violations.length === 0,
    baselineEntries: baselineResult.entries,
    violations,
  }
}

function scanSilentCatches(options = {}) {
  const root = resolve(options.root || resolve(__dirname, '..'))
  const files = listScanFiles(root)
  const entries = []
  for (const filePath of files) {
    const relativeFile = normalizePath(relative(root, filePath))
    const sourceText = readFileSync(filePath, 'utf8')
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)
    visitSourceFile({ relativeFile, sourceFile, sourceText, entries })
  }
  return entries
}

function visitSourceFile({ relativeFile, sourceFile, sourceText, entries }) {
  function visit(node) {
    if (ts.isCatchClause(node) && !catchHasEvidence(node, sourceFile, sourceText)) {
      entries.push(makeEntry({ relativeFile, sourceFile, sourceText, node }))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function catchHasEvidence(node, sourceFile, sourceText) {
  const bodyText = sourceText.slice(node.block.getStart(sourceFile), node.block.end)
  if (/silent-catch:\s*\S/.test(bodyText)) return true

  let hasEvidence = false
  function visit(child) {
    if (hasEvidence) return
    if (ts.isThrowStatement(child)) {
      hasEvidence = true
      return
    }
    if (ts.isCallExpression(child) && isLoggingOrMetricCall(child)) {
      hasEvidence = true
      return
    }
    ts.forEachChild(child, visit)
  }
  visit(node.block)
  return hasEvidence
}

function isLoggingOrMetricCall(node) {
  const name = callName(node.expression)
  return /(?:log|warn|error|metric|emit.*partial)/i.test(name)
}

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) {
    return `${callName(expression.expression)}.${expression.name.text}`
  }
  return ''
}

function makeEntry({ relativeFile, sourceFile, sourceText, node }) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  const snippet = sourceText.slice(node.getStart(sourceFile), node.end)
  return {
    file: relativeFile,
    line: position.line + 1,
    snippetHash: hashSnippet(snippet),
  }
}

function hashSnippet(snippet) {
  const normalized = snippet.replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

function readBaseline(baselinePath) {
  if (baselinePath === null || !existsSync(baselinePath)) {
    return { entries: [], violations: [] }
  }
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const entries = Array.isArray(parsed.entries) ? parsed.entries : []
  const violations = []
  for (const entry of entries) {
    if (
      typeof entry.file !== 'string'
      || typeof entry.line !== 'number'
      || typeof entry.snippetHash !== 'string'
      || entry.snippetHash.length === 0
    ) {
      violations.push({
        file: typeof entry.file === 'string' ? entry.file : '<baseline>',
        line: typeof entry.line === 'number' ? entry.line : 0,
        message: 'baseline entry must include file, line, and snippetHash',
      })
    }
  }
  return {
    entries,
    violations,
  }
}

function writeBaseline(options, entries) {
  const root = resolve(options.root || resolve(__dirname, '..'))
  const baselinePath = resolve(root, options.baselinePath || DEFAULT_BASELINE)
  mkdirSync(dirname(baselinePath), { recursive: true })
  writeFileSync(
    baselinePath,
    `${JSON.stringify({
      version: 1,
      identity: 'schema is {file,line,snippetHash}; matching uses file + snippetHash so line drift does not false-clear entries',
      entries,
    }, null, 2)}\n`,
  )
}

function listScanFiles(root) {
  const files = []
  for (const scanRoot of DEFAULT_SCAN_ROOTS) {
    const absoluteRoot = resolve(root, scanRoot)
    if (existsSync(absoluteRoot)) files.push(...listTypeScriptFiles(absoluteRoot))
  }
  return files
}

function listTypeScriptFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(path))
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extensionOf(entry.name))) {
      files.push(path)
    }
  }
  return files
}

function extensionOf(file) {
  const index = file.lastIndexOf('.')
  return index === -1 ? '' : file.slice(index)
}

function normalizePath(value) {
  return value.split('\\').join('/')
}

function entryKey(entry) {
  return `${entry.file}:${entry.snippetHash}`
}

module.exports = {
  checkSilentCatch,
  hashSnippet,
  scanSilentCatches,
}
