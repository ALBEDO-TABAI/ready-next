import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('OpenAIExecutionClient keeps Kimi Coding tool requests on the documented header contract', () => {
  const source = readWorkspaceFile('src/main/modules/claude-bridge/openai-execution-client.ts')

  assert.match(source, /from '\.\/execution-fallback-policy'/)
  assert.match(source, /resolveFallbackPlan\(/)
  assert.match(source, /annotateFallbackResult\(/)
  assert.match(source, /if \(isKimiCodingBase\) \{/)
  assert.match(source, /headers\.Authorization = `Bearer \$\{params\.config\.apiKey\}`/)
  assert.match(source, /headers\['x-api-key'\] = params\.config\.apiKey/)
  assert.match(source, /headers\['User-Agent'\] = 'KimiCLI\/1\.14\.0'/)
})
