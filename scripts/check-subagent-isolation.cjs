#!/usr/bin/env node

const { builtinModules } = require('node:module')
const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs')
const { dirname, relative, resolve } = require('node:path')

const ts = require('typescript')

const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?|mjs|cjs)$/
const SUB_AGENT_DIR = 'src/main/modules/agent-control/sub-agent'
const ALLOWED_AGENT_CONTROL_FILES = new Set([
  'src/main/modules/agent-control/metrics.ts',
  'src/main/modules/agent-control/run-cleanup-registry.ts',
  'src/main/modules/agent-control/tool-error-metrics.ts',
])
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => name.replace(/^node:/, '')),
])
const FORBIDDEN_RE = /(^|\/)(?:skill-child[^/]*|turn-engine)(?:\.[^/]*)?$|runtime-manager/

main()

function main() {
  if (require.main !== module) return
  const options = parseArgs(process.argv.slice(2))
  const result = checkSubagentIsolation(options)
  if (result.ok) {
    console.log(result.skipped
      ? `subagent isolation: skipped (missing ${SUB_AGENT_DIR})`
      : 'subagent isolation: ok')
    return
  }
  console.error(result.errors.join('\n'))
  process.exit(1)
}

function checkSubagentIsolation({ root = resolve(__dirname, '..') } = {}) {
  const subagentAbs = resolve(root, SUB_AGENT_DIR)
  if (!existsSync(subagentAbs)) {
    return { ok: true, skipped: true, errors: [] }
  }

  const errors = []
  for (const file of listSourceFiles(subagentAbs)) {
    const relFile = normalizePath(relative(root, file))
    const sourceText = readFileSync(file, 'utf8')
    for (const specifier of extractModuleSpecifiers(relFile, sourceText)) {
      const verdict = classifySpecifier({ root, relFile, specifier: specifier.value })
      if (verdict.ok) continue
      errors.push(formatError(relFile, specifier, verdict.reason))
    }
  }

  return { ok: errors.length === 0, skipped: false, errors }
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
    'Usage: node scripts/check-subagent-isolation.cjs [--root <path>]',
  ].join('\n')
}

function listSourceFiles(dir) {
  const files = []
  walk(dir)
  return files.sort()

  function walk(currentDir) {
    for (const entry of readdirSync(currentDir)) {
      const abs = resolve(currentDir, entry)
      const stat = statSync(abs)
      if (stat.isDirectory()) {
        walk(abs)
      } else if (stat.isFile() && SOURCE_EXT_RE.test(entry)) {
        files.push(abs)
      }
    }
  }
}

function extractModuleSpecifiers(filePath, sourceText) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  )
  const specifiers = []

  visit(sourceFile)
  return specifiers

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && isStringLiteralLike(node.moduleSpecifier)) {
      pushSpecifier(node.moduleSpecifier)
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && isStringLiteralLike(node.arguments[0])) {
        pushSpecifier(node.arguments[0])
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && isStringLiteralLike(node.arguments[0])) {
        pushSpecifier(node.arguments[0])
      }
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && isStringLiteralLike(node.moduleReference.expression)) {
      pushSpecifier(node.moduleReference.expression)
    } else if (ts.isImportTypeNode(node) && isStringLiteralLike(node.argument?.literal)) {
      pushSpecifier(node.argument.literal)
    }
    ts.forEachChild(node, visit)
  }

  function pushSpecifier(node) {
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    specifiers.push({
      value: node.text,
      line: pos.line + 1,
      column: pos.character + 1,
    })
  }
}

function classifySpecifier({ root, relFile, specifier }) {
  if (isNodeBuiltin(specifier)) return { ok: true }

  const relResolved = resolveSpecifier({ root, relFile, specifier })
  const checkValue = relResolved || normalizePath(specifier)
  if (FORBIDDEN_RE.test(checkValue) || FORBIDDEN_RE.test(normalizePath(specifier))) {
    return { ok: false, reason: `forbidden dependency "${specifier}"` }
  }

  if (!relResolved) {
    return { ok: false, reason: `non-allowlisted package import "${specifier}"` }
  }
  if (isWithinSubagent(relResolved)) return { ok: true }
  if (ALLOWED_AGENT_CONTROL_FILES.has(relResolved)) return { ok: true }

  return { ok: false, reason: `non-allowlisted dependency "${specifier}" resolves to ${relResolved}` }
}

function resolveSpecifier({ root, relFile, specifier }) {
  if (!specifier.startsWith('.')) return null
  const absBase = resolve(root, dirname(relFile), specifier)
  const resolved = resolveExistingSourcePath(absBase)
  return normalizePath(relative(root, resolved))
}

function resolveExistingSourcePath(absBase) {
  const candidates = [
    absBase,
    `${absBase}.ts`,
    `${absBase}.tsx`,
    `${absBase}.js`,
    `${absBase}.mjs`,
    `${absBase}.cjs`,
    resolve(absBase, 'index.ts'),
    resolve(absBase, 'index.tsx'),
    resolve(absBase, 'index.js'),
    resolve(absBase, 'index.mjs'),
    resolve(absBase, 'index.cjs'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return absBase
}

function isNodeBuiltin(specifier) {
  if (specifier.startsWith('node:')) return BUILTINS.has(specifier) || BUILTINS.has(specifier.slice(5))
  return BUILTINS.has(specifier)
}

function isWithinSubagent(path) {
  return path === SUB_AGENT_DIR || path.startsWith(`${SUB_AGENT_DIR}/`)
}

function formatError(file, specifier, reason) {
  return `${file}:${specifier.line}:${specifier.column} ${reason}`
}

function getScriptKind(filePath) {
  if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) return ts.ScriptKind.TSX
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function isStringLiteralLike(node) {
  return Boolean(node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)))
}

function normalizePath(filePath) {
  return String(filePath || '').replaceAll('\\', '/')
}

module.exports = {
  checkSubagentIsolation,
  extractModuleSpecifiers,
}
