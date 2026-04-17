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

test('phase2 promotes structured tool execution into ToolRuntime', () => {
  const toolDefinition = readWorkspaceFile('src/main/modules/agent-control/tool-definition.ts')
  const toolResultTypes = readWorkspaceFile('src/main/modules/agent-control/tool-result-types.ts')
  const toolRegistry = readWorkspaceFile('src/main/modules/agent-control/tool-registry.ts')
  const toolGateway = readWorkspaceFile('src/main/modules/agent-control/tool-gateway.ts')
  const toolRuntime = readWorkspaceFile('src/main/modules/agent-control/tool-runtime.ts')
  const toolExecutionHooks = readWorkspaceFile('src/main/modules/agent-control/tool-execution-hooks.ts')
  const toolRuntimeContextBuilder = readWorkspaceFile('src/main/modules/agent-control/tool-runtime-context-builder.ts')
  const toolExecutor = readWorkspaceFile('src/main/modules/tools/tool-executor.ts')
  const executionLoopOrchestrator = readWorkspaceFile('src/main/modules/agent-control/execution-loop-orchestrator.ts')

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

  assertMatchesAll(toolRuntime, [
    {
      label: 'tool runtime should exist during phase2',
      pattern: /export class ToolRuntime/,
    },
    {
      label: 'tool runtime should own batch execution during phase2',
      pattern: /async executeBatch\(params:/,
    },
    {
      label: 'tool runtime should still group parallel-safe tools during phase2',
      pattern: /const groups = groupParallelSafeToolCalls\(params\.toolCalls\)/,
    },
    {
      label: 'tool runtime should only require registered tool definitions on the default executor path during phase2',
      pattern: /requireRegisteredTool:\s*!params\.executeTool[\s\S]*if \(options\?\.requireRegisteredTool && !defaultToolGateway\.getToolDefinition\(toolName\)\)/,
    },
    {
      label: 'tool runtime should recover timeout and host failures into structured results during phase2',
      pattern: /classified\.kind === 'timeout_tool' \|\| classified\.kind === 'host_unavailable' \|\| classified\.kind === 'auth'/,
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
      label: 'tool executor should still resolve formal tool definitions during phase2',
      pattern: /const definition = defaultToolGateway\.getToolDefinition\(toolName\)/,
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
      pattern: /Tool not allowed in current context: \$\{toolName\}/,
    },
  ])
  assert.doesNotMatch(toolExecutor, /toolName\.startsWith\('browser_'\)/)

  assertMatchesAll(executionLoopOrchestrator, [
    {
      label: 'execution loop should keep a ToolRuntime instance during phase2',
      pattern: /private readonly toolRuntime: ToolRuntime/,
    },
    {
      label: 'execution loop should return structured tool results during phase2',
      pattern: /executeTool: \(toolCall: ParallelToolCall\) => Promise<ToolExecutionOutput \| string>/,
    },
    {
      label: 'execution loop should delegate batch execution into ToolRuntime during phase2',
      pattern: /return this\.toolRuntime\.executeBatch\(/,
    },
  ])
})

test('phase0 freezes the target ToolRuntime contract in design docs', () => {
  const roadmap = readWorkspaceFile('docs/superpowers/plans/2026-04-17-ready-agent-runtime-realignment-roadmap.md')
  const design = readWorkspaceFile('docs/superpowers/specs/2026-04-17-ready-agent-runtime-realignment-design.md')
  const gapAnalysis = readWorkspaceFile('docs/superpowers/specs/2026-04-17-claude-code-vs-ready-agent-gap-analysis.md')
  const study = readWorkspaceFile('docs/superpowers/specs/2026-04-17-claude-code-agent-architecture-study.md')

  assertMatchesAll(roadmap, [
    {
      label: 'roadmap should freeze tool definition fields before refactor',
      pattern: /`domain \/ kind \/ concurrency \/ interrupt \/ timeout \/ resultShape`/,
    },
    {
      label: 'roadmap should freeze ToolRuntime as the future batch execution truth layer',
      pattern: /让 `ToolRuntime` 成为“批量工具执行真相层”/,
    },
    {
      label: 'roadmap should freeze structured tool results as a requirement',
      pattern: /让工具结果开始返回结构化对象/,
    },
  ])

  assertMatchesAll(design, [
    {
      label: 'design should freeze ToolRuntime as the evolution of gateway executor and schemas',
      pattern: /这一层建议从当前 `ToolGateway \+ tool-executor \+ tool schema` 演进而来/,
    },
    {
      label: 'design should freeze Tool Definition Registry as a first-class ToolRuntime responsibility',
      pattern: /1\. \*\*Tool Definition Registry\*\*/,
    },
    {
      label: 'design should freeze Tool Execution Runtime as a first-class ToolRuntime responsibility',
      pattern: /3\. \*\*Tool Execution Runtime\*\*/,
    },
    {
      label: 'design should freeze permissions, concurrency, interrupt, timeout, structured results, and cleanup inside ToolRuntime',
      pattern: /- 权限[\s\S]*- 并发调度[\s\S]*- 中断策略[\s\S]*- 超时[\s\S]*- 结果结构化[\s\S]*- cleanup hook/,
    },
    {
      label: 'design should freeze formal tool definition fields for later phases',
      pattern: /- `name`[\s\S]*- `domain`[\s\S]*- `kind: read \| write \| interactive \| job`[\s\S]*- `isConcurrencySafe`[\s\S]*- `interruptBehavior`[\s\S]*- `supportsTextBridge`[\s\S]*- `resultShape`[\s\S]*- `projectionHint`[\s\S]*- `timeoutProfile`/,
    },
    {
      label: 'design should require upgrading from string prefix dispatch to behavior contracts',
      pattern: /从“字符串前缀分发”升级到“工具行为契约”/,
    },
  ])

  assertMatchesAll(gapAnalysis, [
    {
      label: 'gap analysis should freeze ToolGateway as a directory rather than a runtime',
      pattern: /Ready 现在有“工具目录”，但还没有“工具运行时”/,
    },
    {
      label: 'gap analysis should freeze string results as a structural problem',
      pattern: /字符串结果必须让位给结构化结果/,
    },
  ])

  assertMatchesAll(study, [
    {
      label: 'study should freeze tool contracts as first-class objects',
      pattern: /Claude Code 最关键的抽象不是 capability group，也不是 domain executor，而是 `Tool`/,
    },
    {
      label: 'study should freeze interrupt behavior inside the tool contract',
      pattern: /- `interruptBehavior`/,
    },
    {
      label: 'study should freeze concurrency safety inside the tool contract',
      pattern: /- `isConcurrencySafe`/,
    },
  ])
})
