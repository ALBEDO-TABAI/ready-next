#!/usr/bin/env node

const { existsSync, readdirSync, readFileSync } = require('node:fs')
const { join, relative, resolve } = require('node:path')

const ts = require('typescript')

const FLAG_HELPERS = new Set([
  'isChildResumeEnabled',
  'isChildInternalStrictAdmissionEnabled',
  'isChildRunCircuitBreakerEnabled',
])

const DEFAULT_AGENT_CONTROL_DIR = 'src/main/modules/agent-control'
const TOOL_EXECUTOR_FILE = 'src/main/modules/tools/tool-executor.ts'
const WHITELIST_FILES = new Set([
  'src/main/modules/agent-control/runtime-core/turn-feature-flags.ts',
  'src/main/modules/agent-control/skills/skill-child-feature-flags.ts',
  'src/main/modules/agent-control/tools-runtime/tool-definition.ts',
  'src/main/modules/agent-control/child-run/child-run-circuit-breaker.ts',
])

main()

function main() {
  if (require.main !== module) return
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = checkTurnFeatureFlags(options)
    if (result.violations.length > 0) {
      console.error('turn feature flags check failed:')
      for (const violation of result.violations) {
        console.error(`- ${violation.file}:${violation.line}:${violation.column} ${violation.message}`)
      }
      process.exit(1)
    }
    console.log('turn feature flags: ok')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

function parseArgs(argv) {
  const options = { root: resolve(__dirname, '..') }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') {
      const value = argv[i + 1]
      if (!value) throw new Error(usage('Missing value for --root.'))
      options.root = resolve(value)
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
    'Usage: node scripts/check-turn-feature-flags.cjs [--root <path>]',
  ].join('\n')
}

function checkTurnFeatureFlags({ root = resolve(__dirname, '..') } = {}) {
  const rootDir = resolve(root)
  const files = listScanFiles(rootDir)
  const violations = []
  for (const filePath of files) {
    const relativeFile = normalizePath(relative(rootDir, filePath))
    const sourceText = readFileSync(filePath, 'utf8')
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)
    visitSourceFile({ sourceFile, relativeFile, violations })
  }
  return { violations }
}

function listScanFiles(rootDir) {
  const files = []
  const agentControlRoot = resolve(rootDir, DEFAULT_AGENT_CONTROL_DIR)
  if (existsSync(agentControlRoot)) files.push(...listTypeScriptFiles(agentControlRoot))
  const toolExecutor = resolve(rootDir, TOOL_EXECUTOR_FILE)
  if (existsSync(toolExecutor)) files.push(toolExecutor)
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
  if (WHITELIST_FILES.has(relativeFile)) return

  function visit(node) {
    if (ts.isImportSpecifier(node) && FLAG_HELPERS.has(node.name.text)) {
      addViolation({
        sourceFile,
        relativeFile,
        node,
        violations,
        message: `forbidden flag helper import: ${node.name.text}; use snapshotTurnFeatureFlags at an entry boundary`,
      })
    }

    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && FLAG_HELPERS.has(node.expression.text)
    ) {
      addViolation({
        sourceFile,
        relativeFile,
        node: node.expression,
        violations,
        message: `forbidden flag helper call: ${node.expression.text}; use a TurnFeatureFlags snapshot`,
      })
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
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
  checkTurnFeatureFlags,
}
