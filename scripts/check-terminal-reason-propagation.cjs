#!/usr/bin/env node

const { existsSync, readdirSync, readFileSync } = require('node:fs')
const { join, relative, resolve } = require('node:path')

const ts = require('typescript')

const DEFAULT_SOURCE_DIRS = [
  'src/main/modules/agent-control',
  'src/main/modules/claude-bridge',
  'src/renderer/modules/agent',
]

const TERMINAL_STATUSES = new Set([
  'checkpoint',
  'done',
  'cancelled',
  'error',
])

main()

function main() {
  if (require.main !== module) return
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = checkTerminalReasonPropagation(options)
    if (result.violations.length > 0) {
      console.error('terminal reason propagation check failed:')
      for (const violation of result.violations) {
        console.error(`- ${violation.file}:${violation.line}:${violation.column} ${violation.message}`)
      }
      process.exit(1)
    }
    console.log('terminal reason propagation: ok')
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
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') {
      const value = argv[i + 1]
      if (!value) throw new Error(usage('Missing value for --root.'))
      options.root = resolve(value)
      i += 1
    } else if (arg === '--source-dir') {
      const value = argv[i + 1]
      if (!value) throw new Error(usage('Missing value for --source-dir.'))
      options.sourceDirs = [value]
      i += 1
    } else {
      throw new Error(usage(`Unknown argument "${arg}".`))
    }
  }
  return options
}

function usage(message) {
  return [
    message,
    'Usage: node scripts/check-terminal-reason-propagation.cjs [--root <path>] [--source-dir <path>]',
  ].join('\n')
}

function checkTerminalReasonPropagation({
  root = resolve(__dirname, '..'),
  sourceDirs = DEFAULT_SOURCE_DIRS,
} = {}) {
  const rootDir = resolve(root)
  const files = listScanFiles(rootDir, sourceDirs)
  const violations = []
  for (const filePath of files) {
    const relativeFile = normalizePath(relative(rootDir, filePath))
    const sourceText = readFileSync(filePath, 'utf8')
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)
    visitSourceFile({ sourceFile, relativeFile, violations })
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

function visitSourceFile({ sourceFile, relativeFile, violations }) {
  function visit(node) {
    if (ts.isCallExpression(node) && isEmitStatusCall(node)) {
      const violationMessage = terminalReasonViolationMessage(node)
      if (violationMessage) {
        addViolation({
          sourceFile,
          relativeFile,
          node,
          violations,
          message: violationMessage,
        })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
}

function isEmitStatusCall(node) {
  if (ts.isIdentifier(node.expression)) return node.expression.text === 'emitStatus'
  return ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'emitStatus'
}

function terminalReasonViolationMessage(node) {
  const firstArg = node.arguments[0]
  if (!firstArg) return null

  const literalStatus = readStringLiteral(firstArg)
  if (literalStatus) {
    if (!TERMINAL_STATUSES.has(literalStatus)) return null
    if (hasExplicitTerminalReasonArgument(node.arguments[1])) return null
    return `terminal emitStatus('${literalStatus}') must pass terminalReason explicitly`
  }

  if (ts.isObjectLiteralExpression(firstArg)) {
    const status = readObjectStringProperty(firstArg, 'status')
    if (!status || !TERMINAL_STATUSES.has(status)) return null
    if (hasExplicitObjectProperty(firstArg, 'terminalReason')) return null
    return `terminal emitStatus({ status: '${status}' }) must include terminalReason explicitly`
  }

  return null
}

function hasExplicitTerminalReasonArgument(node) {
  return Boolean(node && !isNullishLiteral(node))
}

function hasExplicitObjectProperty(objectLiteral, propertyName) {
  for (const property of objectLiteral.properties) {
    if (!isNamedProperty(property, propertyName)) continue
    if (ts.isPropertyAssignment(property)) return !isNullishLiteral(property.initializer)
    if (ts.isShorthandPropertyAssignment(property)) return true
  }
  return false
}

function readObjectStringProperty(objectLiteral, propertyName) {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property) || !isNamedProperty(property, propertyName)) continue
    return readStringLiteral(property.initializer)
  }
  return null
}

function isNamedProperty(property, propertyName) {
  const name = property.name
  if (!name) return false
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text === propertyName
  return false
}

function readStringLiteral(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

function isNullishLiteral(node) {
  return node.kind === ts.SyntaxKind.NullKeyword
    || (ts.isIdentifier(node) && node.text === 'undefined')
    || node.kind === ts.SyntaxKind.VoidExpression
}

function addViolation({ sourceFile, relativeFile, node, violations, message }) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  violations.push({
    file: relativeFile,
    line: position.line + 1,
    column: position.character + 1,
    message,
  })
}

function normalizePath(value) {
  return value.split('\\').join('/')
}

module.exports = {
  checkTerminalReasonPropagation,
}
