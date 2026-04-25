import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { RunCleanupRegistry } from '../main/modules/agent-control/run-cleanup-registry'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('run cleanup registry drains registered callbacks exactly once', async () => {
  const registry = new RunCleanupRegistry()
  let cleanupCalls = 0
  registry.register('run-cleanup', async () => {
    cleanupCalls += 1
  })

  await registry.drain('run-cleanup')
  await registry.drain('run-cleanup')

  assert.equal(cleanupCalls, 1)
})

test('orchestrator cancellation path and tool contexts are wired to the run cleanup registry', () => {
  const orchestrator = readWorkspaceFile('src/main/modules/agent-control/orchestrator.ts')
  const directChat = readWorkspaceFile('src/main/modules/claude-bridge/direct-chat.ts')
  const toolContextBuilder = readWorkspaceFile('src/main/modules/agent-control/tool-runtime-context-builder.ts')
  const toolExecutor = readWorkspaceFile('src/main/modules/tools/tool-executor.ts')
  const skillTools = readWorkspaceFile('src/main/modules/tools/skills-tools.ts')

  assert.match(orchestrator, /private readonly runCleanupRegistry = new RunCleanupRegistry\(\)/)
  assert.match(orchestrator, /registerRunCleanup\(runId: string, cleanup: RunCleanupCallback\)/)
  assert.match(orchestrator, /void this\.drainRunCleanup\(runId\)/)
  assert.match(directChat, /setRunCleanupRegistry\(/)
  assert.match(directChat, /registerRunCleanup: \(cleanup\) => \{/)
  assert.match(toolContextBuilder, /registerRunCleanup\?: \(cleanup: \(\) => void \| Promise<void>\) => void/)
  assert.match(toolExecutor, /executeSkillTool\(toolName, args, context\.sessionId, context\.registerRunCleanup\)/)
  assert.match(skillTools, /registerRunCleanup\?: \(cleanup: \(\) => void \| Promise<void>\) => void/)
  // Phase 4: the `registerRunCleanup(() => manager.cancelExecution(...))`
  // pattern was removed when the skill_executions state machine was retired.
  // Skill primitives (run_shell / ask_user / artifacts) don't need a cleanup
  // hook because they either complete in-line or bind their lifetime to the
  // AbortSignal already wired through the tool context.
})
