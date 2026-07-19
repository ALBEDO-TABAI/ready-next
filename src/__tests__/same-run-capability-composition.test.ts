import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activateBrowserCapabilityForCurrentRun,
  installSameRunSkillActivation,
} from '../main/modules/agent-control/runtime-core/same-run-skill-activation'
import type { ToolBridgeRuntimeContext } from '../main/modules/agent-control/runtime-core/agent-sdk-types'
import {
  buildPreparedSkillTurnTruth,
  revalidateSavedSkillAuthorization,
} from '../main/modules/agent-control/skills/prepared-skill-turn'
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
} from '../main/modules/agent-control/skills/skill-tool-authorization'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'

function definition(
  name: string,
  groupId: ToolDefinition['groupId'],
  domain: ToolDefinition['domain'],
): ToolDefinition {
  return {
    name,
    groupId,
    domain,
    kind: 'read',
    concurrency: 'parallel_read_safe',
    interruptBehavior: 'abort_signal',
    timeoutProfile: 'default',
    supportsTextBridge: true,
    projectionHint: null,
    description: name,
    schema: { type: 'object', properties: {}, additionalProperties: false },
    executionVisibility: 'model',
    resultShape: 'json',
  }
}

function createFixture() {
  const completion = definition('declare_completion_criteria', 'agent_interaction', 'agent_interaction')
  const tagForge = definition('tag_forge_prepare_batch', 'file_management', 'file')
  const browser = definition('browser_snapshot', 'browser_interaction', 'browser')
  const authorization = buildSelectedSkillToolAuthorization({
    skillId: 'tag-forge',
    allowedTypedActions: [tagForge.name],
    allowedPrimitives: [],
    source: 'explicit',
    reason: 'test_tag_forge_selection',
  })
  const identity = {
    mode: 'skill' as const,
    relation: 'explicit' as const,
    skillId: 'tag-forge',
    skillName: 'Tag Forge',
    confidence: 'high' as const,
    source: 'explicit_user_mention' as const,
    contextText: '用 Tag Forge 给文件夹打标',
  }
  const allowedToolNames = [completion.name]
  const definitionByName = new Map([
    [completion.name, completion],
    [tagForge.name, tagForge],
    [browser.name, browser],
  ])
  const requiredCapabilityGroups = [completion.groupId]
  const checkpointRequiredCapabilityGroups = [completion.groupId]
  const checkpointRequiredToolNames = [completion.name]
  const runtimeContext = {
    activatedCapabilityGroups: [],
    skillSurfaceComposition: 'additive',
    exclusiveScopeRef: null,
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    preparedSkillTurn: null,
    allowedToolNames,
    definitionByName,
  } as unknown as ToolBridgeRuntimeContext

  installSameRunSkillActivation({
    runtimeContext,
    latentDefinitions: [tagForge],
    resolvePreparedSkill: () => ({ authorization, identity }),
    resolveComposition: () => ({
      composition: 'exclusive',
      exclusiveScopeRef: { kind: 'owner', ownerRunId: 'owner-old' },
    }),
    buildPreparedTruth: ({ authorization: selectedAuthorization, identity: selectedIdentity, surface }) =>
      buildPreparedSkillTurnTruth({
        authorization: selectedAuthorization,
        identity: selectedIdentity,
        requestOrResourceAnchorDigest: 'anchor-1',
        floors: {
          toolNames: new Set([tagForge.name]),
          reasons: ['skill_selected:tag-forge'],
        },
        surface,
      }),
    resolveExclusiveFloorToolNames: () => [tagForge.name],
    allowedToolNames,
    definitionByName,
    requiredCapabilityGroups,
    checkpointRequiredCapabilityGroups,
    checkpointRequiredToolNames,
  })

  const activateBrowser = () => activateBrowserCapabilityForCurrentRun({
    runtimeContext,
    latentDefinitions: [browser],
    allowedToolNames,
    definitionByName,
    requiredCapabilityGroups,
    checkpointRequiredCapabilityGroups,
    checkpointRequiredToolNames,
  })

  return {
    authorization,
    browser,
    completion,
    tagForge,
    runtimeContext,
    allowedToolNames,
    requiredCapabilityGroups,
    checkpointRequiredCapabilityGroups,
    checkpointRequiredToolNames,
    activateBrowser,
  }
}

function assertExclusiveSurface(fixture: ReturnType<typeof createFixture>): void {
  assert.equal(fixture.runtimeContext.skillSurfaceComposition, 'exclusive')
  assert.deepEqual(fixture.allowedToolNames, [
    fixture.tagForge.name,
    fixture.completion.name,
  ])
  assert.equal(fixture.requiredCapabilityGroups.includes('browser_interaction'), false)
  assert.equal(fixture.checkpointRequiredCapabilityGroups.includes('browser_interaction'), false)
  assert.equal(fixture.checkpointRequiredToolNames.includes(fixture.browser.name), false)
  assert.deepEqual(fixture.runtimeContext.activatedCapabilityGroups, ['browser'])
}

test('Tag Forge stays exclusive whether Browser is activated before or after the skill', () => {
  const browserFirst = createFixture()
  assert.deepEqual(browserFirst.activateBrowser().map((tool) => tool.name), [browserFirst.browser.name])
  assert.deepEqual(
    browserFirst.runtimeContext.activateSkillForCurrentRun?.('tag-forge')?.map((tool) => tool.name),
    [browserFirst.tagForge.name, browserFirst.completion.name],
  )
  assertExclusiveSurface(browserFirst)

  const skillFirst = createFixture()
  assert.deepEqual(
    skillFirst.runtimeContext.activateSkillForCurrentRun?.('tag-forge')?.map((tool) => tool.name),
    [skillFirst.tagForge.name, skillFirst.completion.name],
  )
  assert.deepEqual(skillFirst.activateBrowser(), [])
  assertExclusiveSurface(skillFirst)
})

test('an exact owner transition closes Tag Forge exclusivity and restores the recorded Browser group', () => {
  const fixture = createFixture()
  fixture.runtimeContext.activateSkillForCurrentRun?.('tag-forge')
  fixture.activateBrowser()
  const saved = fixture.runtimeContext.preparedSkillTurn

  const revalidated = revalidateSavedSkillAuthorization({
    saved,
    currentLegalAuthorization: fixture.authorization,
    currentlyAvailableToolNames: new Set([
      fixture.tagForge.name,
      fixture.completion.name,
      fixture.browser.name,
    ]),
    currentSurface: {
      composition: 'exclusive',
      exclusiveScopeRef: { kind: 'owner', ownerRunId: 'owner-new' },
    },
    requestOrResourceAnchorDigest: 'anchor-1',
    ownerTransition: {
      fromOwnerRunId: 'owner-old',
      toOwnerRunId: 'owner-new',
      receiptClaimed: true,
    },
  })

  assert.equal(revalidated.status, 'ready')
  if (revalidated.status !== 'ready') return
  assert.deepEqual(revalidated.effectiveSurface, {
    composition: 'additive',
    exclusiveScopeRef: null,
  })
  fixture.runtimeContext.skillSurfaceComposition = revalidated.effectiveSurface.composition
  fixture.runtimeContext.exclusiveScopeRef = revalidated.effectiveSurface.exclusiveScopeRef
  assert.deepEqual(fixture.runtimeContext.activatedCapabilityGroups, ['browser'])
  assert.deepEqual(fixture.activateBrowser().map((tool) => tool.name), [fixture.browser.name])
  assert.equal(fixture.allowedToolNames.includes(fixture.browser.name), true)
})
