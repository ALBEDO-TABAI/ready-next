import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('AnthropicExecutionClient owns anthropic simple and tool request paths', () => {
  const source = readWorkspaceFile('src/main/modules/claude-bridge/anthropic-execution-client.ts')

  assert.match(source, /export class AnthropicExecutionClient/)
  assert.match(source, /from '\.\/execution-fallback-policy'/)
  assert.match(source, /resolveFallbackPlan\(/)
  assert.match(source, /async requestSimple\(/)
  assert.match(source, /async requestWithTools\(/)
  assert.match(source, /buildHeaders\(/)
  assert.match(source, /resolveModel\(/)
})
