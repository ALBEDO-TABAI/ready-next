import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

import * as repositoryModule from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import { CodexBindingRepository } from '../main/modules/agent-control/codex-runtime/codex-binding-repository'

// 2026-10-07: the binding repository (10819 lines, one class) and the runtime composition (one 5228-line closure)
// were split by responsibility without changing behavior. These are the boundaries that keep them split.
const runtimeRoot = resolve('src/main/modules/agent-control/codex-runtime')
const repositoryRoot = resolve(runtimeRoot, 'binding-repository')
const compositionRoot = resolve(runtimeRoot, 'composition')
const MAX_LINES = 1000

// Lower layers first. A module may import (at runtime) only modules of a strictly lower layer; `context`, `types`
// and `shared` are the base every layer may use. Public operations of other modules are reached through the
// repository instance (`context.self`), exactly as `this.x(...)` was, so they are not imports.
const REPOSITORY_LAYERS = [
  ['types', 'shared', 'context'],
  ['core'],
  ['turns', 'process-leases'],
  ['uncommitted-tails'],
  ['native-history'],
  ['continuity'],
  ['lifecycle-heads', 'publication-receipts', 'browser-verifier'],
  ['publication-barrier', 'lifecycle-transitions', 'interrupts'],
  ['admission', 'start-dispatch', 'manual-compaction', 'gateway-binding', 'recovery'],
  ['closeout-product'],
  ['closeout-terminal'],
]

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
}

function runtimeImports(file: ts.SourceFile): string[] {
  return file.statements.flatMap((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return []
    if (node.importClause?.isTypeOnly) return []
    const bindings = node.importClause?.namedBindings
    if (!node.importClause?.name && bindings && ts.isNamedImports(bindings)
      && bindings.elements.every((item) => item.isTypeOnly)) return []
    return [node.moduleSpecifier.text]
  })
}

function lineCount(path: string): number {
  return readFileSync(path, 'utf8').trimEnd().split('\n').length
}

function findAll(node: ts.Node, test: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = []
  const visit = (current: ts.Node) => {
    if (test(current)) found.push(current)
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

const REPOSITORY_LAYER_OF = new Map(REPOSITORY_LAYERS.flatMap((layer, index) => layer.map((name) => [name, index] as const)))

/** Every way a repository module can break the split; empty when the module keeps it. */
function repositoryModuleViolations(name: string, source: string): string[] {
  const violations: string[] = []
  if (!REPOSITORY_LAYER_OF.has(name)) return [`${name}: no layer assigned`]
  if (source.trimEnd().split('\n').length >= MAX_LINES) violations.push(`${name}: ${MAX_LINES} lines or more`)
  const file = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true)
  if (findAll(file, (node) => node.kind === ts.SyntaxKind.ThisKeyword).length > 0) violations.push(`${name}: uses this`)
  if (name !== 'context' && findAll(file, ts.isClassDeclaration).length > 0) violations.push(`${name}: declares a class`)
  for (const specifier of runtimeImports(file)) {
    if (specifier === '../codex-binding-repository') violations.push(`${name}: imports the repository at runtime`)
    if (!specifier.startsWith('./')) continue
    const target = specifier.slice(2)
    const targetLayer = REPOSITORY_LAYER_OF.get(target)
    if (targetLayer === undefined) violations.push(`${name}: imports unknown ${target}`)
    else if (targetLayer !== 0 && targetLayer >= REPOSITORY_LAYER_OF.get(name)!) {
      violations.push(`${name}: imports ${target} from the same or a higher layer`)
    }
  }
  return violations
}

// Each is one function (`closeCandidateOwned`, `prepareIngress`) whose internal split is deferred by the split plan;
// the cap keeps it from growing. Every other composition module stays below MAX_LINES.
const COMPOSITION_LINE_CAPS = new Map([['candidate-closeout', 1050], ['ingress-prepare', 1025]])
// Modules a composition module may import at runtime: helpers with no composition state. Everything else it needs
// arrives through its factory's dependencies, so the order of creation lives in one place and cannot cycle.
const COMPOSITION_RUNTIME_SIBLINGS = new Set(['support'])

/** Every way a composition module can break the split; empty when the module keeps it. */
function compositionModuleViolations(name: string, source: string): string[] {
  const violations: string[] = []
  const cap = COMPOSITION_LINE_CAPS.get(name) ?? MAX_LINES
  if (source.trimEnd().split('\n').length >= cap) violations.push(`${name}: ${cap} lines or more`)
  const file = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true)
  if (findAll(file, (node) => node.kind === ts.SyntaxKind.ThisKeyword).length > 0) violations.push(`${name}: uses this`)
  if (findAll(file, ts.isClassDeclaration).length > 0) violations.push(`${name}: declares a class`)
  for (const specifier of runtimeImports(file)) {
    if (specifier === '../codex-runtime-production-composition') violations.push(`${name}: imports the composition entry`)
    if (specifier.startsWith('./') && !COMPOSITION_RUNTIME_SIBLINGS.has(specifier.slice(2))) {
      violations.push(`${name}: imports ${specifier.slice(2)} at runtime instead of receiving it`)
    }
  }
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Let)) {
      violations.push(`${name}: keeps module state`)
    }
    if (!ts.isFunctionDeclaration(statement) || !statement.body) continue
    const factoryLets = statement.body.statements.filter((inner) => ts.isVariableStatement(inner)
      && (inner.declarationList.flags & ts.NodeFlags.Let))
    if (factoryLets.length > 0) violations.push(`${name}: ${statement.name?.text} keeps shared state outside live`)
  }
  return violations
}

function moduleNames(root: string): string[] {
  return readdirSync(root).filter((name) => name.endsWith('.ts')).map((name) => name.slice(0, -3))
}

test('binding repository modules are functions over one context, layered without cycles', () => {
  const violations = moduleNames(repositoryRoot).flatMap((name) => (
    // allow-source-grep: module layering, this/class use and line caps are static architecture boundaries with no runtime observer
    repositoryModuleViolations(name, readFileSync(resolve(repositoryRoot, `${name}.ts`), 'utf8'))
  ))
  assert.deepEqual(violations, [])
})

test('composition modules are factories over explicit dependencies, sharing state only through live', () => {
  const violations = moduleNames(compositionRoot).flatMap((name) => (
    // allow-source-grep: runtime imports, shared mutable state and line caps are static architecture boundaries with no runtime observer
    compositionModuleViolations(name, readFileSync(resolve(compositionRoot, `${name}.ts`), 'utf8'))
  ))
  assert.deepEqual(violations, [])
  assert.ok(lineCount(resolve(runtimeRoot, 'codex-runtime-production-composition.ts')) < MAX_LINES)
})

test('the repository class only delegates: no SQL, one context call per operation', () => {
  const path = resolve(runtimeRoot, 'codex-binding-repository.ts')
  assert.ok(lineCount(path) < MAX_LINES, 'codex-binding-repository.ts stays below the line cap')
  const file = parse(path)
  const sql = findAll(file, (node) => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && ['prepare', 'exec'].includes(node.expression.name.text))
  assert.deepEqual(sql.length, 0, 'the repository class owns no SQL')
  const repositoryClass = file.statements.find((node) => ts.isClassDeclaration(node)
    && node.name?.text === 'CodexBindingRepository') as ts.ClassDeclaration
  for (const member of repositoryClass.members) {
    if (!ts.isMethodDeclaration(member) || !member.body) continue
    const [statement, ...rest] = member.body.statements
    const name = member.name.getText(file)
    assert.equal(rest.length, 0, `${name} is a single delegation`)
    assert.ok(statement && ts.isReturnStatement(statement) && statement.expression
      && ts.isCallExpression(statement.expression), `${name} returns one call`)
    const first = (statement.expression as ts.CallExpression).arguments[0]
    assert.equal(first?.getText(file), 'this.context', `${name} hands the shared context to its operation`)
  }
})

test('the repository keeps the public surface it had before the split', () => {
  const snapshot = JSON.parse(readFileSync(resolve(repositoryRoot, 'public-surface.json'), 'utf8')) as {
    publicMethods: string[]
    runtimeExports: string[]
  }
  const methods = Object.getOwnPropertyNames(CodexBindingRepository.prototype).filter((name) => name !== 'constructor')
  assert.deepEqual(methods.sort(), [...snapshot.publicMethods].sort())
  const exported = Object.keys(repositoryModule)
  assert.deepEqual(snapshot.runtimeExports.filter((name) => !exported.includes(name)), [])
})

test('the module checks reject upward and runtime sibling imports, this, classes, hidden state and oversized files', () => {
  assert.deepEqual(repositoryModuleViolations('core', "import { recover } from './recovery'"),
    ['core: imports recovery from the same or a higher layer'])
  assert.deepEqual(repositoryModuleViolations('admission', "import { gateway } from './gateway-binding'"),
    ['admission: imports gateway-binding from the same or a higher layer'])
  assert.deepEqual(repositoryModuleViolations('admission', "import type { Gateway } from './gateway-binding'"), [])
  assert.deepEqual(repositoryModuleViolations('turns', "import { CodexBindingRepository } from '../codex-binding-repository'"),
    ['turns: imports the repository at runtime'])
  assert.deepEqual(repositoryModuleViolations('turns', 'export function read() { return this }\nclass Hidden {}'),
    ['turns: uses this', 'turns: declares a class'])
  assert.deepEqual(repositoryModuleViolations('turns', 'const value = 1\n'.repeat(MAX_LINES)), [`turns: ${MAX_LINES} lines or more`])
  assert.deepEqual(repositoryModuleViolations('unlisted', ''), ['unlisted: no layer assigned'])
  assert.deepEqual(compositionModuleViolations('lifecycle', "import { createIngressPort } from './ingress-port'"),
    ['lifecycle: imports ingress-port at runtime instead of receiving it'])
  assert.deepEqual(compositionModuleViolations('lifecycle', "import type { IngressPort } from './ingress-port'\nimport { isoNow } from './support'"), [])
  assert.deepEqual(compositionModuleViolations('lifecycle', 'let generation = 0\nexport function create() { let host = null; return { host } }'),
    ['lifecycle: keeps module state', 'lifecycle: create keeps shared state outside live'])
  assert.deepEqual(compositionModuleViolations('lifecycle', 'const value = 1\n'.repeat(MAX_LINES)), [`lifecycle: ${MAX_LINES} lines or more`])
  assert.deepEqual(compositionModuleViolations('ingress-prepare', 'const value = 1\n'.repeat(MAX_LINES)), [])
})
