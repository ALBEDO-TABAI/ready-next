import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- hard runtime wiring contract: AgentControlRuntime construction requires Electron and the app database.
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('runtime reflection path delegates short conversations to ReflectionService', () => {
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime-core/runtime.ts')
  const methodMatch = runtime.match(/private async reflectOnConversation\([\s\S]*?\n {2}private toChannelKey/)

  assert.ok(methodMatch, 'reflectOnConversation method should be found')
  const method = methodMatch[0]
  assert.match(method, /this\.db\.getChatMessages\(scope\.id\)/)
  assert.match(method, /this\.reflectionService\.reflectOnConversation\(/)

  const beforeDelegation = method.slice(0, method.indexOf('this.reflectionService.reflectOnConversation('))
  assert.doesNotMatch(
    beforeDelegation,
    /messages\.length\s*<\s*2[\s\S]*?return\s+null/,
    'runtime must not skip short conversations before ReflectionService can log reflection_outcome',
  )
})

test('runtime reflection infrastructure failures emit reflection_outcome', () => {
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime-core/runtime.ts')
  const methodMatch = runtime.match(/private async reflectOnConversation\([\s\S]*?\n {2}private toChannelKey/)

  assert.ok(methodMatch, 'reflectOnConversation method should be found')
  const method = methodMatch[0]
  assert.match(method, /catch \(error\) \{[\s\S]*?logAgentMetric\('reflection_outcome'/)
  assert.match(method, /decision:\s*'error'/)
  assert.match(method, /scopeId:\s*scope\.id/)
  assert.match(method, /agent:\s*scope\.agent/)
})
