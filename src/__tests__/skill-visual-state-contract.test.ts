import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: skill visual state wiring spans renderer state and IPC surfaces without a stable DOM harness
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('reference skill hint is exposed from main process to the chat panel', () => {
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime-core/runtime.ts')
  const recallGroup = readWorkspaceFile('src/main/modules/claude-bridge/ipc/recall-group.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const electronTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const referenceSkillHintHook = readWorkspaceFile(
    'src/renderer/components/agent/chat-panel/reference-skill/use-reference-skill-hint.ts',
  )
  const chatPanelBody = readWorkspaceFile('src/renderer/components/agent/chat-panel/ChatPanelBody.tsx')

  assert.match(runtime, /getReferenceSkillHint\(scopeId: string\)/)
  // B8-D R2：TTL 逻辑随簇入 reference-hint-service（runtime 留一行委托）。
  const referenceHintService = readWorkspaceFile('src/main/modules/agent-control/runtime-core/reference-hint-service.ts')
  assert.match(referenceHintService, /REFERENCE_SKILL_HINT_TTL_MS/)
  assert.match(runtime, /this\.referenceHints\.getReferenceSkillHint\(/)
  assert.match(recallGroup, /agent:getReferenceSkillHint/)
  assert.match(preload, /getReferenceSkillHint:/)
  assert.match(electronTypes, /interface ReferenceSkillHintData/)
  assert.match(electronTypes, /getReferenceSkillHint:/)
  assert.match(referenceSkillHintHook, /getReferenceSkillHint/)
  assert.match(chatPanelBody, /data-reference-skill-hint/)
  assert.match(chatPanelBody, /技能上下文/)
  assert.match(chatPanelBody, /上下文已启用/)
  assert.doesNotMatch(chatPanelBody, /续做已启用/)
})

test('ChatPanel clears stale reference skill hint immediately when switching scope', () => {
  const referenceSkillHintHook = readWorkspaceFile(
    'src/renderer/components/agent/chat-panel/reference-skill/use-reference-skill-hint.ts',
  )

  assert.match(
    referenceSkillHintHook,
    /requestRevision\.current \+= 1\s*setReferenceSkillHint\(null\)/,
  )
  assert.match(referenceSkillHintHook, /activeSessionId,[\s\S]*currentScopeId,[\s\S]*messageVisibilityEpoch,/)
})

test('skill task cards can show VEA structured output paths', () => {
  const skillsTools = readWorkspaceFile('src/main/modules/tools/skills-tools.ts')
  const tracker = readWorkspaceFile('src/main/modules/agent-control/skills/skill-task-tracker.ts')
  const chatPanelBody = readWorkspaceFile('src/renderer/components/agent/chat-panel/ChatPanelBody.tsx')

  assert.match(skillsTools, /buildSkillRunArtifacts/)
  assert.match(skillsTools, /runStatePath/)
  assert.match(skillsTools, /sceneScoresPath/)
  assert.match(tracker, /artifacts\?: Array/)
  assert.match(tracker, /recentArtifacts/)
  assert.match(chatPanelBody, /data-session-recall-attachments/)
})

test('long running skill heartbeat can surface live run_state artifacts', () => {
  const projection = readWorkspaceFile('src/main/modules/agent-control/skills/skill-running-projection.ts')

  assert.match(projection, /run_state\.json/)
  assert.match(projection, /recentArtifacts/)
  assert.match(projection, /中间文件/)
})

test('skill action spawn receives the current turn agent context', () => {
  const contextBuilder = readWorkspaceFile('src/main/modules/agent-control/tools-runtime/tool-runtime-context-builder.ts')
  const toolExecutor = readWorkspaceFile('src/main/modules/tools/tool-executor.ts')
  const skillsTools = readWorkspaceFile('src/main/modules/tools/skills-tools.ts')
  const runtimeManager = readWorkspaceFile('src/main/modules/skills-runtime/runtime-manager.ts')
  const hostController = readWorkspaceFile('src/main/modules/skills-runtime/skill-host-controller.ts')

  assert.match(contextBuilder, /agentContext/)
  assert.match(
    toolExecutor,
    /executeSkillTool\(toolName, args, context\.sessionId, context\.registerRunCleanup, context\.abortSignal, context\.agentContext, \{\s*scopeId:/,
  )
  assert.match(skillsTools, /agentContext\?: AgentSpawnContext \| null/)
  // B8-P：SkillRunRequest 类型随顶层块入 runtime-manager-types.ts。
  const runtimeManagerTypes = readWorkspaceFile('src/main/modules/skills-runtime/runtime-manager-types.ts')
  assert.match(runtimeManagerTypes, /agentContext\?: AgentSpawnContext \| null/)
  assert.match(hostController, /agentContext \?\? await this\.readAgentContext\(\)/)
})

test('detached skill tasks expose only inspect, list, and cancel renderer contracts', () => {
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime-core/runtime.ts')
  const detachedGroup = readWorkspaceFile('src/main/modules/claude-bridge/ipc/detached-task-group.ts')
  const ipcHandler = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const electronTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const primitiveSchemas = readWorkspaceFile('src/main/modules/tools/skill-primitives/primitive-schemas.ts')

  assert.doesNotMatch(runtime, /startDetachedSkillAction/)
  assert.match(runtime, /inspectDetachedSkillTask/)
  assert.match(runtime, /cancelDetachedSkillTask/)
  // B8-D R1：scope 归属校验体随簇入 detached-skill-service（runtime 留委托）。
  const detachedService = readWorkspaceFile('src/main/modules/agent-control/runtime-core/detached-skill-service.ts')
  assert.match(detachedService, /task\.scopeId !== normalizedScopeId && task\.sessionId !== normalizedScopeId/)
  assert.match(runtime, /this\.detachedSkills\.inspectDetachedSkillTask\(/)
  assert.doesNotMatch(detachedGroup, /agent:startDetachedSkillAction/)
  assert.doesNotMatch(ipcHandler, /startDetachedSkillAction/)
  assert.match(detachedGroup, /agent:inspectDetachedSkillTask/)
  assert.match(detachedGroup, /agent:cancelDetachedSkillTask/)
  assert.match(detachedGroup, /scopeId is required/)
  assert.doesNotMatch(preload, /startDetachedSkillAction:/)
  assert.doesNotMatch(electronTypes, /startDetachedSkillAction:/)
  assert.match(electronTypes, /interface DetachedSkillTaskData/)
  const taskCard = readWorkspaceFile('src/renderer/components/agent/chat-panel/task/TaskCard.tsx')
  assert.match(taskCard, /取消后台任务/)
  assert.doesNotMatch(taskCard, /继续后台任务/)
  assert.match(primitiveSchemas, /skill_start_detached/)
  assert.match(primitiveSchemas, /skill_inspect_detached/)
  assert.match(primitiveSchemas, /skill_cancel_detached/)
})

test('structured projection events do not expose raw JSON as tool trace text', () => {
  const sdkToolExecutor = readWorkspaceFile('src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts')
  const ipcHandler = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')
  const outputBlock = ipcHandler.match(/orchestrator\.on\('output'[\s\S]*?orchestrator\.on\('status'/)
  assert.ok(outputBlock, 'expected orchestrator output bridge block')

  assert.match(sdkToolExecutor, /buildToolResultDetail\(normalized\)/)
  assert.match(sdkToolExecutor, /projectionPatch: normalized\.projectionPatch/)
  assert.match(sdkToolExecutor, /visibilityOwnerKind: 'context_background'/)
  assert.match(sdkToolExecutor, /visibilityOwnerLedger: \{ kind: 'run_meta'/)
  assert.doesNotMatch(outputBlock[0], /data\.type === 'tool_use' \|\| data\.type === 'tool_result'/)
  assert.doesNotMatch(outputBlock[0], /const toolText = typeof structured\?\.message/)
})
