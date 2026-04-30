import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: tool executor guard wiring is a dispatch-layer source contract
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('tool executor rejects tool calls outside the current allowlist', () => {
  const executor = readWorkspaceFile('src/main/modules/tools/tool-executor.ts')
  const builder = readWorkspaceFile('src/main/modules/agent-control/tool-runtime-context-builder.ts')
  const turnEngine = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')

  assert.match(executor, /allowedToolNames\?: Set<string> \| string\[\] \| null/)
  // R3: definition check MUST come before the allowlist check so the model
  // can distinguish "unknown tool" (fabricated name) from "tool not allowed"
  // (real but restricted this turn). See tool-not-allowed-message.ts rationale.
  assert.match(
    executor,
    /const definition = defaultToolRegistry\.getToolDefinitionForExecution\(toolName\)[\s\S]*const allowedToolNames = normalizeAllowedToolSet\(context\.allowedToolNames\)[\s\S]*if \(definition\.requiresExplicitAllowlist && !allowedToolNames\?\.has\(toolName\)\)[\s\S]*if \(allowedToolNames && !allowedToolNames\.has\(toolName\)\)/,
  )
  assert.match(executor, /buildUnknownToolMessage\(toolName\)/)
  assert.match(executor, /buildToolNotAllowedMessage\(toolName, allowedToolNames\)/)
  assert.match(builder, /allowedToolNames\?: Set<string> \| string\[\] \| null/)
  assert.match(builder, /allowedToolNames:\s*params\.allowedToolNames \|\| null/)
  assert.match(turnEngine, /const preparedToolContext = buildHostToolContext\(preparedRunCapabilities\.allowedToolNames\)/)
  assert.match(turnEngine, /const routedAllowedToolNames = selectedDomainPrepareResult\?\.allowedToolNames \|\| reconciledRunCapabilities\.allowedToolNames/)
  assert.match(turnEngine, /const hostToolContext = buildHostToolContext\(routedAllowedToolNames\)/)
  assert.match(turnEngine, /const toolContext = buildHostToolContext\(routedAllowedToolNames, scope\)/)
  assert.doesNotMatch(turnEngine, /const allowedToolNamesForPolicy = new Set\(/)
  assert.doesNotMatch(turnEngine, /allowedToolNames:\s*\['system_run_openclaw'\]/)
})
