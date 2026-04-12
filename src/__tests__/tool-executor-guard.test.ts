import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('tool executor rejects tool calls outside the current allowlist', () => {
  const executor = readWorkspaceFile('src/main/modules/tools/tool-executor.ts')
  const builder = readWorkspaceFile('src/main/modules/agent-control/tool-runtime-context-builder.ts')
  const directChat = readWorkspaceFile('src/main/modules/claude-bridge/direct-chat.ts')

  assert.match(executor, /allowedToolNames\?: Set<string> \| string\[\] \| null/)
  assert.match(executor, /if \(allowedToolNames && !allowedToolNames\.has\(toolName\)\) \{[\s\S]*Tool not allowed in current context/)
  assert.match(builder, /allowedToolNames\?: Set<string> \| string\[\] \| null/)
  assert.match(builder, /allowedToolNames:\s*params\.allowedToolNames \|\| null/)
  assert.match(directChat, /allowedToolNames:\s*preparedRunCapabilities\.allowedToolNames/)
  assert.match(directChat, /allowedToolNames:\s*reconciledRunCapabilities\.allowedToolNames/)
  assert.doesNotMatch(directChat, /const allowedToolNamesForPolicy = new Set\(/)
  assert.doesNotMatch(directChat, /allowedToolNames:\s*\['system_run_openclaw'\]/)
})
