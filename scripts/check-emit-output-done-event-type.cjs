#!/usr/bin/env node

const { existsSync, readdirSync, readFileSync } = require('node:fs')
const { join, relative, resolve } = require('node:path')

const DEFAULT_SOURCE_DIRS = [
  'src/main/modules/agent-control',
  'src/main/modules/claude-bridge',
]

main()

function main() {
  if (require.main !== module) return
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = checkEmitOutputDoneEventType(options)
    if (result.violations.length > 0) {
      console.error('emit output doneEventType check failed:')
      for (const violation of result.violations) {
        console.error(`- ${violation.file}:${violation.line} ${violation.message}`)
      }
      process.exit(1)
    }
    console.log('emit output doneEventType: ok')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

function parseArgs(argv) {
  const options = {
    root: resolve(__dirname, '..'),
    sourceDirs: DEFAULT_SOURCE_DIRS,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') {
      const value = argv[index + 1]
      if (!value) throw new Error(usage('Missing value for --root.'))
      options.root = resolve(value)
      index += 1
    } else if (arg === '--source-dir') {
      const value = argv[index + 1]
      if (!value) throw new Error(usage('Missing value for --source-dir.'))
      options.sourceDirs = [value]
      index += 1
    } else {
      throw new Error(usage(`Unknown argument "${arg}".`))
    }
  }
  return options
}

function usage(message) {
  return [
    message,
    'Usage: node scripts/check-emit-output-done-event-type.cjs [--root <path>] [--source-dir <path>]',
  ].join('\n')
}

function checkEmitOutputDoneEventType({
  root = resolve(__dirname, '..'),
  sourceDirs = DEFAULT_SOURCE_DIRS,
} = {}) {
  const rootDir = resolve(root)
  const files = listScanFiles(rootDir, sourceDirs)
  const violations = []
  for (const filePath of files) {
    const text = readFileSync(filePath, 'utf8')
    const file = normalizePath(relative(rootDir, filePath))
    const lines = text.split(/\r?\n/)
    lines.forEach((line, index) => {
      if (line.includes('doneEventType')) {
        violations.push({
          file,
          line: index + 1,
          message: 'doneEventType is retired; final output event type must derive from status',
        })
      }
    })
  }
  return { violations }
}

function listScanFiles(rootDir, sourceDirs) {
  const files = []
  for (const sourceDir of sourceDirs) {
    const fullPath = resolve(rootDir, sourceDir)
    if (existsSync(fullPath)) files.push(...listTypeScriptFiles(fullPath))
  }
  return files
}

function listTypeScriptFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath)
    }
  }
  return files
}

function normalizePath(value) {
  return value.split('\\').join('/')
}

module.exports = {
  checkEmitOutputDoneEventType,
}
