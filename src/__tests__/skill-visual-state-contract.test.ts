import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: skill visual state wiring spans renderer state and IPC surfaces without a stable DOM harness
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('reference skill hint is exposed from main process to the chat panel', () => {
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime.ts')
  const ipcHandler = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const electronTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(runtime, /getReferenceSkillHint\(scopeId: string\)/)
  assert.match(runtime, /REFERENCE_SKILL_HINT_TTL_MS/)
  assert.match(ipcHandler, /agent:getReferenceSkillHint/)
  assert.match(preload, /getReferenceSkillHint:/)
  assert.match(electronTypes, /interface ReferenceSkillHintData/)
  assert.match(electronTypes, /getReferenceSkillHint:/)
  assert.match(chatPanel, /getReferenceSkillHint/)
  assert.match(chatPanel, /data-reference-skill-hint/)
  assert.match(chatPanel, /技能上下文/)
  assert.match(chatPanel, /上下文已启用/)
  assert.doesNotMatch(chatPanel, /续做已启用/)
})

test('ChatPanel clears stale reference skill hint immediately when switching scope', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(
    chatPanel,
    /useEffect\(\(\) => \{\s*setReferenceSkillHint\(null\)\s*\}, \[currentScopeId\]\)/,
  )
})

test('skill task cards can show VEA structured output paths', () => {
  const skillsTools = readWorkspaceFile('src/main/modules/tools/skills-tools.ts')
  const tracker = readWorkspaceFile('src/main/modules/agent-control/skill-task-tracker.ts')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(skillsTools, /buildSkillRunArtifacts/)
  assert.match(skillsTools, /runStatePath/)
  assert.match(skillsTools, /sceneScoresPath/)
  assert.match(tracker, /artifacts\?: Array/)
  assert.match(tracker, /recentArtifacts/)
  assert.match(chatPanel, /data-session-recall-attachments/)
})

test('long running skill heartbeat can surface live run_state artifacts', () => {
  const turnEngine = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')
  const projection = readWorkspaceFile('src/main/modules/agent-control/skill-running-projection.ts')

  assert.match(turnEngine, /buildLongSkillRunningProjection/)
  assert.match(turnEngine, /toolInput:\s*toolCall\.input/)
  assert.match(projection, /run_state\.json/)
  assert.match(projection, /recentArtifacts/)
  assert.match(projection, /中间文件/)
})

test('skill action spawn receives the current turn agent context', () => {
  const turnEngine = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')
  const contextBuilder = readWorkspaceFile('src/main/modules/agent-control/tools-runtime/tool-runtime-context-builder.ts')
  const toolExecutor = readWorkspaceFile('src/main/modules/tools/tool-executor.ts')
  const skillsTools = readWorkspaceFile('src/main/modules/tools/skills-tools.ts')
  const runtimeManager = readWorkspaceFile('src/main/modules/skills-runtime/runtime-manager.ts')
  const hostController = readWorkspaceFile('src/main/modules/skills-runtime/skill-host-controller.ts')

  assert.match(turnEngine, /buildAgentSpawnContextFromAIConfig/)
  assert.match(contextBuilder, /agentContext/)
  assert.match(
    toolExecutor,
    /executeSkillTool\(toolName, args, context\.sessionId, context\.registerRunCleanup, context\.abortSignal, context\.agentContext, \{\s*scopeId:/,
  )
  assert.match(skillsTools, /agentContext\?: AgentSpawnContext \| null/)
  assert.match(runtimeManager, /agentContext\?: AgentSpawnContext \| null/)
  assert.match(hostController, /agentContext \?\? await this\.readAgentContext\(\)/)
})

test('detached skill tasks have IPC and renderer API contracts', () => {
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime.ts')
  const ipcHandler = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const electronTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const primitiveSchemas = readWorkspaceFile('src/main/modules/tools/skill-primitives/primitive-schemas.ts')

  assert.match(runtime, /startDetachedSkillAction/)
  assert.match(runtime, /inspectDetachedSkillTask/)
  assert.match(runtime, /cancelDetachedSkillTask/)
  assert.match(runtime, /task\.scopeId !== normalizedScopeId && task\.sessionId !== normalizedScopeId/)
  assert.match(ipcHandler, /agent:startDetachedSkillAction/)
  assert.match(ipcHandler, /agent:inspectDetachedSkillTask/)
  assert.match(ipcHandler, /agent:cancelDetachedSkillTask/)
  assert.match(ipcHandler, /scopeId is required/)
  assert.match(preload, /startDetachedSkillAction:/)
  assert.match(electronTypes, /interface DetachedSkillTaskData/)
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  assert.match(chatPanel, /取消后台任务/)
  assert.match(chatPanel, /继续后台任务/)
  assert.match(primitiveSchemas, /skill_start_detached/)
  assert.match(primitiveSchemas, /skill_inspect_detached/)
  assert.match(primitiveSchemas, /skill_cancel_detached/)
})

test('structured projection events do not expose raw JSON as tool trace text', () => {
  const ipcHandler = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')
  const outputBlock = ipcHandler.match(/orchestrator\.on\('output'[\s\S]*?runtime\?\.recordScopeRunEvent/)
  assert.ok(outputBlock, 'expected orchestrator output bridge block')

  assert.match(outputBlock[0], /const structuredText =/)
  assert.match(outputBlock[0], /structured\?\.taskSummary/)
  assert.match(outputBlock[0], /structured\?\.taskTitle/)
  assert.match(outputBlock[0], /structured \? \(structuredText \|\| '状态已更新'\) : \(data\.chunk \|\| ''\)/)
  assert.doesNotMatch(outputBlock[0], /const toolText = typeof structured\?\.message === 'string' \? structured\.message : \(data\.chunk \|\| ''\)/)
})
