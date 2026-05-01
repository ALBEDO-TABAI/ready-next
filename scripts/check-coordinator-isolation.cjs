#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs')
const { relative, resolve } = require('node:path')

const ts = require('typescript')

const PRODUCT_IDS = new Set(['browser', 'document', 'skill', 'rss', 'calendar', 'feishu'])
const PRODUCT_TRIGGER_MODULES = new Set(['browser', 'document', 'skill', 'rss', 'calendar', 'feishu'])
const FORBIDDEN_TURN_ENGINE_IMPORT_RE = /(?:^|\/)(?:tools\/browser-tools|document-domain-helpers|document-task-pipeline(?:-executor)?|skills-tools)$/
const TURN_ENGINE_PATH = 'src/main/modules/agent-control/turn-engine.ts'
const PROMPT_ASSEMBLY_PATH = 'src/main/modules/agent-control/prompt-assembly.ts'

main()

function main() {
  if (require.main !== module) return
  const options = parseArgs(process.argv.slice(2))
  const result = checkCoordinatorIsolation(options)
  if (result.ok) {
    console.log('coordinator isolation: ok')
    return
  }
  console.error(result.errors.join('\n'))
  process.exit(1)
}

function checkCoordinatorIsolation({ root = resolve(__dirname, '..') } = {}) {
  const errors = []
  checkTurnEngine({ root, errors })
  checkPromptAssembly({ root, errors })
  return { ok: errors.length === 0, errors }
}

function checkTurnEngine({ root, errors }) {
  const filePath = TURN_ENGINE_PATH
  const abs = resolve(root, filePath)
  if (!existsSync(abs)) {
    errors.push(`${filePath}: missing file`)
    return
  }
  const sourceText = readFileSync(abs, 'utf8')
  const sourceFile = createSourceFile(filePath, sourceText)
  visit(sourceFile)

  function visit(node) {
    if (ts.isImportDeclaration(node) && isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      const normalized = normalizeImportSpecifier(filePath, specifier)
      if (FORBIDDEN_TURN_ENGINE_IMPORT_RE.test(normalized)) {
        errors.push(formatNodeError(sourceFile, node.moduleSpecifier, `forbidden import "${specifier}"`))
      }
    }
    if (
      ts.isBinaryExpression(node)
      && (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const leftId = getComparedAdapterId(node.left)
      const rightId = getComparedProductId(node.right)
      const rightAdapterId = getComparedAdapterId(node.right)
      const leftProductId = getComparedProductId(node.left)
      if ((leftId && rightId) || (rightAdapterId && leftProductId)) {
        errors.push(formatNodeError(sourceFile, node, 'adapter id comparison leaked into turn-engine'))
      }
    }
    ts.forEachChild(node, visit)
  }
}

function checkPromptAssembly({ root, errors }) {
  const filePath = PROMPT_ASSEMBLY_PATH
  const abs = resolve(root, filePath)
  if (!existsSync(abs)) {
    errors.push(`${filePath}: missing file`)
    return
  }
  const sourceText = readFileSync(abs, 'utf8')
  const sourceFile = createSourceFile(filePath, sourceText)
  visit(sourceFile)

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'TRIGGERS') {
      const initializer = node.initializer
      if (initializer && ts.isArrayLiteralExpression(initializer)) {
        for (const element of initializer.elements) {
          if (!ts.isObjectLiteralExpression(element)) continue
          const moduleValue = readStringProperty(element, 'module')
          if (moduleValue && PRODUCT_TRIGGER_MODULES.has(moduleValue)) {
            errors.push(formatNodeError(sourceFile, element, `product trigger module "${moduleValue}" remains in TRIGGERS`))
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
}

function parseArgs(argv) {
  const options = {
    root: resolve(__dirname, '..'),
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') {
      const value = argv[i + 1]
      if (!value) throw new Error(usage('Missing value for --root'))
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
    'Usage: node scripts/check-coordinator-isolation.cjs [--root <path>]',
  ].join('\n')
}

function createSourceFile(filePath, sourceText) {
  return ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function normalizeImportSpecifier(filePath, specifier) {
  if (!specifier.startsWith('.')) return specifier.replaceAll('\\', '/')
  const resolved = relative(
    process.cwd(),
    resolve(process.cwd(), filePath, '..', specifier),
  )
  return resolved.replaceAll('\\', '/')
}

function getComparedAdapterId(node) {
  if (!ts.isPropertyAccessExpression(node)) return null
  return node.name.text === 'id' ? node.name.text : null
}

function getComparedProductId(node) {
  if (!isStringLiteralLike(node)) return null
  return PRODUCT_IDS.has(node.text) ? node.text : null
}

function readStringProperty(objectNode, propertyName) {
  for (const property of objectNode.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = property.name
    if (!name || !ts.isIdentifier(name) || name.text !== propertyName) continue
    return isStringLiteralLike(property.initializer) ? property.initializer.text : null
  }
  return null
}

function formatNodeError(sourceFile, node, message) {
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return `${sourceFile.fileName}:${pos.line + 1}:${pos.character + 1} ${message}`
}

function isStringLiteralLike(node) {
  return Boolean(node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)))
}

module.exports = {
  checkCoordinatorIsolation,
}
