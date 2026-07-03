import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function assertMatchesAll(
  content: string,
  expectations: Array<{ label: string; pattern: RegExp }>,
): void {
  for (const expectation of expectations) {
    assert.match(content, expectation.pattern, expectation.label)
  }
}

test('tools-runtime keeps the structured tool execution contract (definitions, registry, gateway, executor)', () => {
  const toolDefinition = readWorkspaceFile('src/main/modules/agent-control/tools-runtime/tool-definition.ts')
  const toolResultTypes = readWorkspaceFile('src/main/modules/agent-control/tools-runtime/tool-result-types.ts')
  const toolRegistry = readWorkspaceFile('src/main/modules/agent-control/tools-runtime/tool-registry.ts')
  const toolGateway = readWorkspaceFile('src/main/modules/agent-control/tools-runtime/tool-gateway.ts')
  const toolExecutionHooks = readWorkspaceFile('src/main/modules/agent-control/tools-runtime/tool-execution-hooks.ts')
  const toolRuntimeContextBuilder = readWorkspaceFile('src/main/modules/agent-control/tools-runtime/tool-runtime-context-builder.ts')
  const toolExecutor = readWorkspaceFile('src/main/modules/tools/tool-executor.ts')

  assertMatchesAll(toolDefinition, [
    {
      label: 'tool definition should export the formal domain type during phase1',
      pattern: /export type ToolDomain =/,
    },
    {
      label: 'tool definition should export the formal kind type during phase1',
      pattern: /export type ToolKind =/,
    },
    {
      label: 'tool definition should export the formal concurrency type during phase1',
      pattern: /export type ToolConcurrency =/,
    },
    {
      label: 'tool definition should export the formal interrupt behavior type during phase1',
      pattern: /export type ToolInterruptBehavior =/,
    },
    {
      label: 'tool definition should export the formal timeout profile type during phase1',
      pattern: /export type ToolTimeoutProfile =/,
    },
    {
      label: 'tool definition should export ToolDefinition during phase1',
      pattern: /export interface ToolDefinition \{/,
    },
    {
      label: 'tool definition should include text-bridge support metadata during phase1',
      pattern: /supportsTextBridge:\s*boolean/,
    },
    {
      label: 'tool definition should include projection hint metadata during phase1',
      pattern: /projectionHint:\s*ToolProjectionHint \| null/,
    },
    {
      label: 'tool definition should include unified description metadata during phase1',
      pattern: /description:\s*string/,
    },
    {
      label: 'tool definition should include unified neutral schema metadata during phase1',
      pattern: /schema:\s*ToolDefinitionSchema \| null/,
    },
  ])

  assertMatchesAll(toolResultTypes, [
    {
      label: 'tool result types should export ToolResultShape during phase1',
      pattern: /export type ToolResultShape =/,
    },
  ])

  assertMatchesAll(toolRegistry, [
    {
      label: 'tool registry should exist during phase1',
      pattern: /export class ToolRegistry/,
    },
    {
      label: 'tool registry should expose tool definition lookups during phase1',
      pattern: /getToolDefinition\(toolName: string\)/,
    },
    {
      label: 'tool registry should expose listToolDefinitions during phase1',
      pattern: /listToolDefinitions\(\): ToolDefinition\[\]/,
    },
  ])

  assertMatchesAll(toolGateway, [
    {
      label: 'tool gateway should still expose tool descriptors during phase1',
      pattern: /export interface ToolDescriptor \{/,
    },
    {
      label: 'tool gateway should still expose capability-group registry entries during phase1',
      pattern: /export interface CapabilityGroupRegistryEntry extends CapabilityGroupDefinition \{/,
    },
    {
      label: 'tool gateway should expose getToolDefinition during phase1',
      pattern: /getToolDefinition\(id: string\): ToolDefinition \| null/,
    },
    {
      label: 'tool gateway should expose listToolDefinitions during phase1',
      pattern: /listToolDefinitions\(\): ToolDefinition\[\]/,
    },
  ])
  assert.match(toolGateway, /ToolRegistry/)
  assert.match(toolGateway, /resultShape/)
  assert.match(toolGateway, /interruptBehavior/)

  assertMatchesAll(toolResultTypes, [
    {
      label: 'tool result types should keep ToolResultShape during phase2',
      pattern: /export type ToolResultShape =/,
    },
    {
      label: 'tool result types should add ToolInteractionHint during phase2',
      pattern: /export type ToolInteractionHint =/,
    },
    {
      label: 'tool result types should export ToolExecutionOutput during phase2',
      pattern: /export interface ToolExecutionOutput \{/,
    },
    {
      label: 'tool result types should keep projectionPatch and interactionHint on structured outputs',
      pattern: /projectionPatch:\s*Record<string, unknown> \| null[\s\S]*interactionHint:\s*ToolInteractionHint \| null/,
    },
    {
      label: 'tool result types should expose output normalization helpers during phase2',
      pattern: /export function normalizeToolExecutionOutput\(/,
    },
  ])

  assertMatchesAll(toolExecutionHooks, [
    {
      label: 'tool execution hooks should define ToolExecutionHooks during phase2',
      pattern: /export interface ToolExecutionHooks \{/,
    },
    {
      label: 'tool execution hooks should expose interruption hook during phase2',
      pattern: /onBatchInterrupted\?/,
    },
  ])

  assertMatchesAll(toolRuntimeContextBuilder, [
    {
      label: 'tool runtime context builder should build ToolRuntimeContext during phase2',
      pattern: /export function buildToolRuntimeContext\(params:/,
    },
    {
      label: 'tool runtime context builder should expose a thin tool executor view during phase2',
      pattern: /export function toToolExecutorContext\(context: ToolRuntimeContext\): ToolContext/,
    },
    {
      label: 'tool runtime context builder should still forward allowed tool names during phase2',
      pattern: /allowedToolNames:\s*params\.allowedToolNames \|\| null/,
    },
  ])

  assertMatchesAll(toolExecutor, [
    {
      label: 'tool executor should now return structured tool results during phase2',
      pattern: /export async function executeToolCall\([\s\S]*\): Promise<ToolExecutionOutput>/,
    },
    {
      // The lookup helper was renamed to `getToolDefinitionForExecution` and
      // moved off the gateway onto the `defaultToolRegistry` directly.
      label: 'tool executor should still resolve formal tool definitions during phase2',
      pattern: /const definition = defaultToolRegistry\.getToolDefinitionForExecution\(toolName\)/,
    },
    {
      label: 'tool executor should dispatch through the definition domain during phase2',
      pattern: /switch \(definition\.domain\)/,
    },
    {
      label: 'tool executor should normalize raw text tool outputs during phase2',
      pattern: /normalizeToolExecutionOutput\(/,
    },
    {
      label: 'tool executor should still reject tools outside the allowlist during phase2',
      pattern: /buildToolNotAllowedMessage\(toolName, allowedToolNames\)/,
    },
    {
      label: 'tool executor should distinguish unknown (unregistered) tools from restricted ones',
      pattern: /buildUnknownToolMessage\(toolName\)/,
    },
  ])
  assert.doesNotMatch(toolExecutor, /toolName\.startsWith\('browser_'\)/)
  assert.doesNotMatch(toolExecutor, /withToolExecutionTimeout/)
})
