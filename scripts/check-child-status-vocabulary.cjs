#!/usr/bin/env node

const { existsSync, readdirSync, readFileSync } = require('node:fs')
const { join, relative, resolve } = require('node:path')

const ts = require('typescript')

const DEFAULT_SOURCE_DIR = 'src/main/modules/agent-control'
const CANONICAL_TYPES_FILE = 'src/main/modules/agent-control/skills/skill-child-run-types.ts'
const TURN_ENGINE_FILE = 'src/main/modules/agent-control/turn-engine.ts'
const CLOSE_STATUS_LITERALS = new Set([
  'completed',
  'failed',
  'killed',
  'blocked',
  'recoverable_paused',
  'budget_paused',
])
const STATUS_OBJECT_NAMES = new Set(['close', 'closeEvent', 'live'])
const STATUS_IDENTIFIER_NAMES = new Set(['childStatus'])
const W0_WHITELIST_FUNCTIONS = new Set([
  'renderChildCommandOutcome',
  'subAgentReasonForChildClose',
  // Stage 6 — pure status→label/state mappers consume close.status as their
  // sole input and return a deterministic projection. They are not making
  // policy decisions, only translating; allowing the literal switch keeps
  // them readable while still funnelling status writes through the L1/L2
  // ledger contracts.
  'closeMessage',
  'lifecycleStateForChildClose',
  'lifecycleReasonForChildClose',
])

main()

function main() {
  if (require.main !== module) return
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = checkChildStatusVocabulary(options)
    if (result.violations.length > 0) {
      console.error('child status vocabulary check failed:')
      for (const violation of result.violations) {
        console.error(`- ${violation.file}:${violation.line}:${violation.column} ${violation.message}`)
      }
      process.exit(1)
    }
    console.log('child status vocabulary: ok')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

function parseArgs(argv) {
  const options = {
    root: resolve(__dirname, '..'),
    sourceDir: DEFAULT_SOURCE_DIR,
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
      options.sourceDir = value
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
    'Usage: node scripts/check-child-status-vocabulary.cjs [--root <path>] [--source-dir <path>]',
  ].join('\n')
}

function checkChildStatusVocabulary({ root = resolve(__dirname, '..'), sourceDir = DEFAULT_SOURCE_DIR } = {}) {
  const rootDir = resolve(root)
  const sourceRoot = resolve(rootDir, sourceDir)
  if (!existsSync(sourceRoot)) throw new Error(`missing source directory: ${sourceDir}`)

  const files = listTypeScriptFiles(sourceRoot)
  const violations = []
  for (const filePath of files) {
    const relativeFile = normalizePath(relative(rootDir, filePath))
    const sourceText = readFileSync(filePath, 'utf8')
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)
    visitSourceFile({ sourceFile, relativeFile, violations })
  }
  return { violations }
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
    if (
      relativeFile !== CANONICAL_TYPES_FILE
      && ts.isIdentifier(node)
      && node.text === 'TERMINAL_CHILD_CLOSE_STATUSES'
      && isDeclarationName(node)
    ) {
      addViolation({
        sourceFile,
        relativeFile,
        node,
        violations,
        message: 'duplicate TERMINAL_CHILD_CLOSE_STATUSES; import the canonical helper from skill-child-run-types.ts',
      })
    }

    if (
      ts.isBinaryExpression(node)
      && isStatusLiteralComparison(node)
      && !isW0WhitelistedStatusDecision(node, relativeFile)
    ) {
      addViolation({
        sourceFile,
        relativeFile,
        node,
        violations,
        message: 'forbidden status literal decision; use a helper from skill-child-run-types.ts',
      })
    }

    if (
      ts.isSwitchStatement(node)
      && isCloseStatusExpression(node.expression)
      && !isW0WhitelistedStatusDecision(node, relativeFile)
    ) {
      addViolation({
        sourceFile,
        relativeFile,
        node: node.expression,
        violations,
        message: 'forbidden status literal switch; use a helper from skill-child-run-types.ts',
      })
    }

    if (
      relativeFile === TURN_ENGINE_FILE
      && ts.isBinaryExpression(node)
      && isChildCloseEventAssignment(node)
      && !isNullLiteral(node.right)
      && isInsideResumeBranch(node)
    ) {
      addViolation({
        sourceFile,
        relativeFile,
        node,
        violations,
        message: 'forbidden resume childCloseEvent assignment; apply resumed.freshContractFields wholesale',
      })
    }

    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function isDeclarationName(node) {
  const parent = node.parent
  return Boolean(
    parent
      && (
        (ts.isVariableDeclaration(parent) && parent.name === node)
        || (ts.isBindingElement(parent) && parent.name === node)
        || (ts.isParameter(parent) && parent.name === node)
        || (ts.isFunctionDeclaration(parent) && parent.name === node)
      ),
  )
}

function isStatusLiteralComparison(node) {
  if (
    node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
    && node.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken
  ) {
    return false
  }
  return (
    isStatusDecisionOperand(node.left) && isCloseStatusLiteral(node.right)
  ) || (
    isCloseStatusLiteral(node.left) && isStatusDecisionOperand(node.right)
  )
}

function isStatusDecisionOperand(node) {
  return isCloseStatusExpression(node) || isChildStatusIdentifier(node)
}

function isCloseStatusExpression(node) {
  return ts.isPropertyAccessExpression(node)
    && node.name.text === 'status'
    && ts.isIdentifier(node.expression)
    && STATUS_OBJECT_NAMES.has(node.expression.text)
}

function isChildStatusIdentifier(node) {
  return ts.isIdentifier(node) && STATUS_IDENTIFIER_NAMES.has(node.text)
}

function isChildCloseEventAssignment(node) {
  return node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(node.left)
    && node.left.name.text === 'childCloseEvent'
}

function isNullLiteral(node) {
  return node.kind === ts.SyntaxKind.NullKeyword
}

function isInsideResumeBranch(node) {
  let current = node.parent
  while (current) {
    if (
      ts.isIfStatement(current)
      && current.expression.getText().includes('isSkillResumeTurnDetected')
    ) {
      return true
    }
    current = current.parent
  }
  return false
}

function isCloseStatusLiteral(node) {
  return ts.isStringLiteralLike(node) && CLOSE_STATUS_LITERALS.has(node.text)
}

function isW0WhitelistedStatusDecision(node, relativeFile) {
  if (relativeFile === 'src/main/modules/agent-control/turn-engine.ts') {
    const functionName = enclosingFunctionName(node)
    if (functionName && W0_WHITELIST_FUNCTIONS.has(functionName)) return true
    return isInsideVariableNamed(node, 'turnTerminalReason')
  }

  if (relativeFile === 'src/main/modules/agent-control/skills/skill-child-sub-agent.ts') {
    return enclosingFunctionName(node) === 'subAgentReasonForChildClose'
  }

  // Stage 6 — pure status→label/state mappers in skill-child-runner.ts are
  // allowed to switch on close.status (see W0_WHITELIST_FUNCTIONS rationale).
  if (relativeFile === 'src/main/modules/agent-control/skills/skill-child-runner.ts') {
    const functionName = enclosingFunctionName(node)
    if (functionName && W0_WHITELIST_FUNCTIONS.has(functionName)) return true
  }

  return false
}

function enclosingFunctionName(node) {
  let current = node.parent
  while (current) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current))
      && current.name
    ) {
      return current.name.text
    }
    current = current.parent
  }
  return null
}

function isInsideVariableNamed(node, name) {
  let current = node.parent
  while (current) {
    if (
      ts.isVariableDeclaration(current)
      && ts.isIdentifier(current.name)
      && current.name.text === name
    ) {
      return true
    }
    current = current.parent
  }
  return false
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

function normalizePath(path) {
  return path.replaceAll('\\', '/')
}

module.exports = {
  checkChildStatusVocabulary,
  parseArgs,
}
