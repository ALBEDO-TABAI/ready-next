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
  const turnEngine = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')

  assert.match(executor, /allowedToolNames\?: Set<string> \| string\[\] \| null/)
  assert.match(executor, /if \(allowedToolNames && !allowedToolNames\.has\(toolName\)\) \{[\s\S]*Tool not allowed in current context/)
  assert.match(executor, /const definition = defaultToolGateway\.getToolDefinition\(toolName\)/)
  assert.match(executor, /if \(allowedToolNames && !allowedToolNames\.has\(toolName\)\) \{[\s\S]*const definition = defaultToolGateway\.getToolDefinition\(toolName\)/)
  assert.match(builder, /allowedToolNames\?: Set<string> \| string\[\] \| null/)
  assert.match(builder, /allowedToolNames:\s*params\.allowedToolNames \|\| null/)
  assert.match(turnEngine, /const preparedToolContext = buildHostToolContext\(preparedRunCapabilities\.allowedToolNames\)/)
  assert.match(turnEngine, /const routedAllowedToolNames = selectedDomainPrepareResult\?\.allowedToolNames \|\| reconciledRunCapabilities\.allowedToolNames/)
  assert.match(turnEngine, /const hostToolContext = buildHostToolContext\(routedAllowedToolNames\)/)
  assert.match(turnEngine, /const toolContext = buildHostToolContext\(routedAllowedToolNames, scope\)/)
  assert.doesNotMatch(turnEngine, /const allowedToolNamesForPolicy = new Set\(/)
  assert.doesNotMatch(turnEngine, /allowedToolNames:\s*\['system_run_openclaw'\]/)
})
