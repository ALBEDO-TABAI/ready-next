import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import ts from 'typescript'

import type { CodexRuntimeComposition } from '../../main/modules/agent-control/codex-runtime/codex-runtime-composition'
import type { CodexActionSurfaceEnvelope } from '../../shared/ipc-contracts/agent-runtime'

/**
 * Executes the exact `ingressPort` / `startIdentityPort` closures declared in
 * `codex-runtime-production-composition.ts` against caller-supplied
 * dependencies. Callers may pass a stub repository (isolated port behaviour) or
 * a real `CodexBindingRepository` (production prepare joined to real admission).
 *
 * It runs the production AST, not a copy: no source-string assertion or
 * re-implementation stands in for the behaviour under test.
 */
export type CodexProductionPorts = Pick<CodexRuntimeComposition, 'ingressPort' | 'startIdentityPort' | 'aliasBindingPort'> & {
  readActionSurface: (input: { aliasId: string; aliasGeneration: number; workbenchMode?: 'browser' | 'document' | 'rss' | 'calendar' }) => CodexActionSurfaceEnvelope
}

const productionUrl = new URL(
  '../../main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts',
  import.meta.url,
)

const REQUIRED_VARIABLES = ['ingressPort', 'startIdentityPort', 'releasePreparedReservation']
// Locals the ports reach only on deeper paths (real repository, action surface
// reads). Extracted when present so callers are not silently limited to the
// shallow stub path; never asserted, so the harness stays valid if a name moves.
const OPTIONAL_VARIABLES = [
  'readActionSurface',
  'publishCodexActionSurfaceInvalidation',
  'resolveProductHeadContractBlocker',
  'issuedBeginNewContextActions',
  'MAX_ISSUED_BEGIN_NEW_CONTEXT_ACTIONS',
  'aliasBindingPort',
  'issueBeginNewContextAction',
]
const EXTRACTED_VARIABLES = [...REQUIRED_VARIABLES, ...OPTIONAL_VARIABLES]
const EXTRACTED_FUNCTIONS = ['activeProfile', 'isoNow', 'stableErrorCode']

let productionFactory: Promise<(dependencies: Record<string, unknown>) => CodexProductionPorts> | undefined

export function createCodexProductionPorts(
  dependencies: Record<string, unknown>,
): Promise<CodexProductionPorts> {
  productionFactory ??= (async () => {
    // allow-source-grep: Executes the actual AST closures; every assertion in
    // the callers is behavioural (returned ingress, SQLite rollback, readback).
    const source = readFileSync(productionUrl, 'utf8')
    const parsed = ts.createSourceFile('production.ts', source, ts.ScriptTarget.Latest, true)
    const bindings: Record<string, unknown> = {}
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause || statement.importClause.isTypeOnly) continue
      const specifier = (statement.moduleSpecifier as ts.StringLiteral).text
      const resolved = new URL(`${specifier}.ts`, productionUrl)
      const imported = await import(specifier.startsWith('.')
        ? (existsSync(resolved) ? resolved : new URL(`${specifier}/index.ts`, productionUrl)).href
        : specifier)
      const clause = statement.importClause
      if (clause.name) bindings[clause.name.text] = imported.default
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly) continue
          bindings[element.name.text] = imported[element.propertyName?.text || element.name.text]
        }
      }
    }
    const declarations = new Map<string, string>()
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && EXTRACTED_VARIABLES.includes(node.name.text)) {
        declarations.set(node.name.text, `const ${node.name.text} = ${node.initializer.getText(parsed)};`)
      }
      if (ts.isFunctionDeclaration(node) && node.name
        && EXTRACTED_FUNCTIONS.includes(node.name.text)) declarations.set(node.name.text, node.getText(parsed))
      ts.forEachChild(node, visit)
    }
    visit(parsed)
    for (const name of REQUIRED_VARIABLES) assert.ok(declarations.has(name), `production_declaration_missing:${name}`)
    return (deps) => {
      const ordered = [...EXTRACTED_VARIABLES, ...EXTRACTED_FUNCTIONS]
        .filter((name) => declarations.has(name) && !Object.hasOwn(deps, name))
        .map((name) => declarations.get(name) as string)
      const compiled = ts.transpileModule(
        [...ordered, 'return { ingressPort, startIdentityPort, aliasBindingPort, readActionSurface };'].join('\n'),
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
      ).outputText
      const environment = { ...bindings, ...deps }
      return Function(...Object.keys(environment), compiled)(...Object.values(environment)) as CodexProductionPorts
    }
  })()
  return productionFactory.then((factory) => factory(dependencies))
}
