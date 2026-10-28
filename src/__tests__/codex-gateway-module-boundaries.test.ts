import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const root = resolve('src/main/modules/agent-control/codex-runtime')

function runtimeDependencies(source: string): string[] {
  const file = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true)
  return file.statements.flatMap((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.importClause?.isTypeOnly) return []
      const bindings = node.importClause?.namedBindings
      if (!node.importClause?.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.every((item) => item.isTypeOnly)) return []
      return [node.moduleSpecifier.text]
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) return [node.moduleSpecifier.text]
    return []
  })
}

function assertAcyclic(graph: Map<string, string[]>): void {
  const completed = new Set<string>()
  const visiting = new Set<string>()
  const visit = (name: string) => {
    if (completed.has(name) || !graph.has(name)) return
    assert.ok(!visiting.has(name), `gateway runtime import cycle at ${name}`)
    visiting.add(name)
    graph.get(name)!.forEach(visit)
    visiting.delete(name)
    completed.add(name)
  }
  graph.forEach((_deps, name) => visit(name))
}

test('gateway responsibilities remain bounded and protocol code cannot own persistence or the listener', () => {
  const files = readdirSync(root).filter((name) => (
    name.startsWith('codex-model-gateway')
    || name.startsWith('codex-provider-') && !name.includes('readiness')
    || name === 'codex-zai-responses.ts'
  ))
  const graph = new Map<string, string[]>()
  for (const name of files) {
    // allow-source-grep: module size and the runtime import graph are static architecture boundaries with no runtime observer
    const source = readFileSync(resolve(root, name), 'utf8')
    assert.ok(source.trimEnd().split('\n').length < 1000, `${name} must remain one bounded responsibility`)
    const imports = runtimeDependencies(source)
    graph.set(`./${name.replace(/\.ts$/, '')}`, imports)
    if (name === 'codex-model-gateway-native-stream.ts') {
      assert.ok(!imports.some((path) => path.includes('gateway-chat')), 'native Responses must not load the Chat stream implementation')
    }
    // codex-provider-text owns the one-shot, tool-free gateway request shared by the connection test and RSS background judgments.
    if (!['codex-model-gateway.ts', 'codex-model-gateway-authority.ts', 'codex-model-gateway-repository.ts', 'codex-provider-connection-test.ts', 'codex-provider-text.ts'].includes(name)) {
      assert.ok(!imports.includes('./codex-model-gateway'), `${name} must not depend on the HTTP service`)
      assert.ok(!imports.some((path) => /repository|authority|settings-engine|node:(?:fs|http)|electron/.test(path)), `${name} must not own application state or the listener`)
    }
  }
  assertAcyclic(graph)
})

test('the architecture check rejects runtime cycles but permits erased type-only dependencies', () => {
  assert.deepEqual(runtimeDependencies("import type { Port } from './owner'\nimport { type Shape } from './owner'\nimport { check } from './validation'"), ['./validation'])
  assert.throws(() => assertAcyclic(new Map([['owner', ['stream']], ['stream', ['owner']]])), /runtime import cycle/)
})
