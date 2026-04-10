import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('KimiCodingClient owns coding-specific request and media upload helpers', () => {
  const source = readWorkspaceFile('src/main/modules/claude-bridge/kimi-coding-client.ts')

  assert.match(source, /export class KimiCodingClient/)
  assert.match(source, /from '\.\/execution-fallback-policy'/)
  assert.match(source, /resolveFallbackPlan\(/)
  assert.match(source, /async requestSimple\(/)
  assert.match(source, /async serializeMessages\(/)
  assert.match(source, /async uploadVideoToFiles\(/)
  assert.match(source, /getUserAgent\(/)
})
