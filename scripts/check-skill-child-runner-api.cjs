#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs')
const { relative, resolve } = require('node:path')

const ts = require('typescript')

const DEFAULT_SOURCE = 'src/main/modules/agent-control/skills/skill-child-runner.ts'
const DEFAULT_SNAPSHOT = 'scripts/snapshots/skill-child-runner-api.snapshot.json'
const INTERNAL_TEST_MARKER_EXPORTS = new Set([
  '__breaksInvariants',
  '__noProductionInvariantBreach',
])

main()

function main() {
  if (require.main !== module) return
  try {
    const options = parseArgs(process.argv.slice(2))
    const actual = collectSkillChildRunnerApi(options)
    if (options.print) {
      console.log(JSON.stringify(actual, null, 2))
      return
    }

    const snapshotPath = resolve(options.root, options.snapshot)
    if (!existsSync(snapshotPath)) {
      console.error(`missing API snapshot: ${options.snapshot}`)
      console.error(JSON.stringify(actual, null, 2))
      process.exit(1)
    }

    const expected = JSON.parse(readFileSync(snapshotPath, 'utf8'))
    if (stableJson(actual.exports) !== stableJson(expected.exports)) {
      console.error('skill-child-runner public API changed')
      console.error('Expected:')
      console.error(JSON.stringify(expected.exports, null, 2))
      console.error('Actual:')
      console.error(JSON.stringify(actual.exports, null, 2))
      process.exit(1)
    }

    console.log('skill-child-runner api: ok')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

function parseArgs(argv) {
  const options = {
    root: resolve(__dirname, '..'),
    source: DEFAULT_SOURCE,
    snapshot: DEFAULT_SNAPSHOT,
    print: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') {
      const value = argv[i + 1]
      if (!value) throw new Error(usage('Missing value for --root.'))
      options.root = resolve(value)
      i += 1
    } else if (arg === '--source') {
      const value = argv[i + 1]
      if (!value) throw new Error(usage('Missing value for --source.'))
      options.source = value
      i += 1
    } else if (arg === '--snapshot') {
      const value = argv[i + 1]
      if (!value) throw new Error(usage('Missing value for --snapshot.'))
      options.snapshot = value
      i += 1
    } else if (arg === '--print') {
      options.print = true
    } else {
      throw new Error(usage(`Unknown argument "${arg}".`))
    }
  }
  return options
}

function usage(message) {
  return [
    message,
    'Usage: node scripts/check-skill-child-runner-api.cjs [--root <path>] [--source <path>] [--snapshot <path>] [--print]',
  ].join('\n')
}

function collectSkillChildRunnerApi({ root, source }) {
  const sourcePath = resolve(root, source)
  if (!existsSync(sourcePath)) throw new Error(`missing source file: ${source}`)

  const program = ts.createProgram([sourcePath], {
    allowJs: false,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  })
  const checker = program.getTypeChecker()
  const sourceFile = program.getSourceFile(sourcePath)
  if (!sourceFile) throw new Error(`failed to parse source file: ${source}`)

  const exports = []
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && statement.name) {
      const type = checker.getTypeAtLocation(statement.name)
      const signature = type.getCallSignatures()[0]
      exports.push({
        kind: 'function',
        name: statement.name.text,
        signature: signature
          ? checker.signatureToString(signature, statement, ts.TypeFormatFlags.NoTruncation)
          : '',
      })
      continue
    }

    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue
        if (INTERNAL_TEST_MARKER_EXPORTS.has(declaration.name.text)) continue
        exports.push({
          kind: 'const',
          name: declaration.name.text,
          initializer: declaration.initializer?.getText(sourceFile) ?? null,
        })
      }
      continue
    }

    if (ts.isInterfaceDeclaration(statement) && hasExportModifier(statement)) {
      exports.push({ kind: 'interface', name: statement.name.text })
      continue
    }

    if (ts.isTypeAliasDeclaration(statement) && hasExportModifier(statement)) {
      exports.push({ kind: 'type', name: statement.name.text })
      continue
    }

    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        exports.push({
          kind: 'reexport',
          name: element.name.text,
          propertyName: element.propertyName?.text ?? null,
          moduleSpecifier: statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
            ? statement.moduleSpecifier.text
            : null,
        })
      }
    }
  }

  return {
    version: 1,
    source: relative(root, sourcePath).replaceAll('\\', '/'),
    exports,
  }
}

function hasExportModifier(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
}

function stableJson(value) {
  return JSON.stringify(value)
}

module.exports = {
  collectSkillChildRunnerApi,
}
