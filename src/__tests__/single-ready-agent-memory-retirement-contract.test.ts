import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

function read(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
}

test('Ready exposes one fixed assistant identity and no selector surface', () => {
  const chatInput = read('renderer/components/agent/ChatInput.tsx')
  const taskPanel = read('renderer/components/ready/TaskPanel.tsx')
  const readyMode = read('renderer/pages/ReadyMode.tsx')
  const readyConversation = read('renderer/components/ready/MeetingChat.tsx')
  const agentTypes = read('renderer/modules/agent/types.ts')
  const settings = read('renderer/pages/Settings.tsx')
  const createSessionContract = read('shared/ipc-contracts/agent-runtime.ts')
  const lifecycleStore = read('main/modules/agent-control/codex-runtime/codex-product-lifecycle-store.ts')

  assert.doesNotMatch(chatInput, /onAgentSelect|showAgentSelect|currentAgentDisplayName/)
  assert.doesNotMatch(taskPanel, /AgentSelector|AgentTagRow/)
  assert.doesNotMatch(readyMode, /LiveFollowPanel|isFollowMode|实时跟随/)
  assert.doesNotMatch(readyConversation, /多位 Agent|位 Agent 参与|\.selected/)
  assert.doesNotMatch(agentTypes, /selected:\s*boolean/)
  assert.equal(existsSync(new URL('../renderer/components/ready/LiveFollowPanel.tsx', import.meta.url)), false)
  assert.doesNotMatch(settings, /AgentSettingsHub|MemorySettingsSection|UserProfileEditor/)
  assert.doesNotMatch(settings, /id:\s*['"](?:agent|user-profiles)['"]/)
  assert.match(settings, /id:\s*['"]memory['"]/)
  assert.match(settings, /ReadyMemorySettingsPanel/)
  assert.match(createSessionContract, /CreateSessionRequest\s*=\s*Record<string, never>/)
  assert.match(createSessionContract, /createSessionRequestSchema[^=]*=\s*z\.object\(\{\}\)\.strict\(\)/)
  assert.match(lifecycleStore, /MAIN_AGENT_ID/)
})

test('specialist and retired memory capabilities are absent while Ready memory is live', () => {
  const preload = read('preload/index.ts')
  const ipcHandler = read('main/modules/claude-bridge/ipc-handler.ts')
  const capabilityGroups = read('shared/ai-capability-groups.ts')
  const toolRegistry = read('main/modules/agent-control/tools-runtime/tool-registry.ts')
  const runtime = read('main/modules/agent-control/runtime-core/runtime.ts')
  const migrations = read('main/modules/migrations.ts')

  assert.doesNotMatch(preload, /listRegistry|systemStudio|specialistBlueprint|agentPersonality|userProfile/)
  assert.doesNotMatch(preload, /agent:memory:|agent:trigger:|agent:beliefCards:/)
  assert.match(preload, /agent:readReadyMemory/)
  assert.doesNotMatch(ipcHandler, /agentRegistryGroup|agentSystemStudioGroup|agentSpecialistBlueprintGroup/)
  assert.doesNotMatch(ipcHandler, /memoryGroup|triggerGroup|beliefCardGroup/)
  assert.match(ipcHandler, /readyMemoryGroup\.register/)
  assert.match(capabilityGroups, /id:\s*'memory'[\s\S]*?availability:\s*'active'/)
  assert.match(capabilityGroups, /id:\s*'memory'[\s\S]*?defaultMode:\s*'auto'/)
  assert.match(capabilityGroups, /id:\s*'memory'[\s\S]*?defaultProfiles:\s*\['local_chat'\]/)
  assert.match(capabilityGroups, /id:\s*'memory'[\s\S]*?settingsVisible:\s*false/)
  assert.match(toolRegistry, /memory:\s*\{\s*staticToolNames:\s*READY_MEMORY_TOOL_NAMES/)
  assert.doesNotMatch(runtime, /memoryLifecycle\.start|CrystallizeScheduler|runCrystallizeRound|runBeliefDecayRound/)
  assert.match(runtime, /migrateLegacyBeliefCardStorage\(app\.getPath\('userData'\)\)/)
  assert.match(runtime, /BELIEF_CARD_STORAGE_DIRNAME/)
  assert.ok(
    runtime.indexOf("migrateLegacyBeliefCardStorage(app.getPath('userData'))") < runtime.indexOf('shell.trashItem(retiredFiles.legacyRoot)'),
    'belief cards must migrate before the retired directory is trashed',
  )
  assert.match(migrations, /name:\s*'112_single_ready_identity_cleanup'/)
  assert.match(migrations, /name:\s*'113_ready_memory_truth'/)
  assert.match(migrations, /name:\s*'114_drop_retired_memory_truth'/)
  assert.match(migrations, /enqueueEligibleRetiredCodexThreadArchiveIntents\(db\)/)
})
