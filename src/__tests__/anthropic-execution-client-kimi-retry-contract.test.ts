import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('AnthropicExecutionClient retries kimi coding tool requests after transient failures', () => {
  const source = readWorkspaceFile('src/main/modules/claude-bridge/anthropic-execution-client.ts')

  assert.match(source, /annotateFallbackResult/)
  assert.match(source, /mode:\s*'kimi_coding'/)
  assert.match(source, /this\.shouldUseKimiCodingDefaults\(params\.baseUrl\)/)
  assert.match(source, /requestWithTools\(/)
  assert.match(source, /kind:\s*'kimi_coding_retry'/)
})
