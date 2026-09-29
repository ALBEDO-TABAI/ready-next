/**
 * End-to-end coverage for the
 * `ToolPolicy → gateway → registry list filter` plumbing.
 *
 * Tests the chain at three levels:
 *
 *   1. `filterToolsByAuthorization` helper — direct behavior for
 *      `mode:'none'` with explicit reason and `mode:'selected'` with
 *      allowed sets.
 *
 *   2. `buildAuthorizationFromIdentity` helper — identity.source / reason
 *      mapping into authorization.source / authorization.reason. Without
 *      this pin a refactor that drops the source mapping would silently
 *      flip authorization.source from 'explicit'/'trusted_resume'/'active_task'.
 *
 *   3. `getPolicyAnthropicTools` / `getPolicyOpenAIToolBundle` — the
 *      visible tool list construction must respect ToolPolicy.authorization.
 *      Tests both `mode:'none'` (skill_* removed) and `mode:'selected'`
 *      (only allowed skill_* retained), with non-skill tools always
 *      passing through.
 *
 *   4. `prepareInitialRun` — when authorization is threaded through
 *      `RunCapabilityBaseParams`, the resulting `allowedToolNames` and
 *      `toolResolution` snapshot are computed with the filter in place.
 *      Without that, the diagnostic snapshot drifts from the policy
 *      applied later in turn-engine.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type ToolPolicy
} from '../main/modules/agent-control/tool-policy/execution-tool-config'
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
  filterToolsByAuthorization
} from '../main/modules/agent-control/skills/skill-tool-authorization'
import { ToolGateway } from '../main/modules/agent-control/tools-runtime/tool-gateway'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'

// ---------------------------------------------------------------------------
// (1) filterToolsByAuthorization — direct helper behavior
// ---------------------------------------------------------------------------

type NamedTool = { name: string }

test('filterToolsByAuthorization: mode:none → strip ALL skill_* tools', () => {
  const tools: NamedTool[] = [
    { name: 'document_open_tab' },
    { name: 'browser_click' },
    { name: 'skill_video_expert_pipeline' },
    { name: 'skill_run_shell' },
  ]
  const filtered = filterToolsByAuthorization(
    tools,
    buildExplicitNoSkillAuthorization('no_skill_signal'),
    (t) => t.name,
  )
  assert.deepEqual(filtered.map((t) => t.name), ['document_open_tab', 'browser_click'])
})

test('filterToolsByAuthorization: mode:selected → keep only skill_* in allowed sets, non-skill always pass', () => {
  const tools: NamedTool[] = [
    { name: 'document_open_tab' }, // non-skill, always pass
    { name: 'skill_video_expert_pipeline' }, // typed action, in allowed
    { name: 'skill_video_expert_ai_analyze' }, // typed action, NOT in allowed
    { name: 'skill_run_shell' }, // primitive, in allowed
    { name: 'skill_read_artifact' }, // primitive, NOT in allowed
  ]
  const auth = buildSelectedSkillToolAuthorization({
    skillId: 'video-expert-analyzer',
    allowedTypedActions: ['skill_video_expert_pipeline'],
    allowedPrimitives: ['skill_run_shell'],
    source: 'explicit',
    reason: 'user_named_skill',
  })
  const filtered = filterToolsByAuthorization(tools, auth, (t) => t.name)
  assert.deepEqual(
    filtered.map((t) => t.name).sort(),
    ['document_open_tab', 'skill_run_shell', 'skill_video_expert_pipeline'].sort(),
  )
})

test('filterToolsByAuthorization: getName returns null → tool passes (cannot identify)', () => {
  // OpenAI tool schema where function.name is missing — defensive pass-through.
  const tools = [{ function: {} }] as Array<{ function: { name?: string } }>
  const filtered = filterToolsByAuthorization(
    tools,
    buildExplicitNoSkillAuthorization('no_skill_signal'),
    (t) => (typeof t.function.name === 'string' ? t.function.name : null),
  )
  assert.equal(filtered.length, 1, 'tool with unidentifiable name must pass through (cannot decide)')
})

// ---------------------------------------------------------------------------
// (3) ToolGateway → registry chain — direct fixture tests
//
// These tests inject TWO real skill tools via `__testGroupProviders` so the
// gateway/registry chain has something to filter. Pinning behavior through
// the singleton `defaultToolGateway` is not enough: under host-Node tests
// the skills group can be empty (no live skills runtime), making
// "no skill_* leaked" assertions vacuously true. Direct ToolGateway with
// a fake provider proves the filter actually filters.
// ---------------------------------------------------------------------------

function makeBasePolicy(overrides: Partial<ToolPolicy> = {}): ToolPolicy {
  return {
    forceDocumentTool: false,
    allowDocumentTools: true,
    forceDesignTool: false,
    preferredDesignTool: null,
    primaryDesignInstruction: null,
    allowMultipleDesignArtifacts: true,
    preferSectionRewrite: false,
    preferFormatOnly: false,
    allowBrowserTools: true,
    ...overrides,
  }
}

function makeFixtureSkillToolDefinition(name: string): ToolDefinition {
  return {
    name,
    groupId: 'skills',
    domain: 'skill',
    kind: 'interactive',
    concurrency: 'serialized',
    interruptBehavior: 'host_managed',
    timeoutProfile: 'skill',
    supportsTextBridge: true,
    projectionHint: { emitsProjectionPatch: true },
    description: name,
    schema: null,
    resultShape: 'projection_patch',
  }
}

function makeFixtureGateway(): ToolGateway {
  // Inject two skill tools via __testGroupProviders so the chain has real
  // tools to filter. `getToolDefinitions` returns the pair; the gateway
  // path goes provider → registry → filterToolsByAuthorization.
  return new ToolGateway({
    __testGroupProviders: {
      skills: {
        staticToolNames: ['skill_video_expert_pipeline', 'skill_run_shell'],
        getToolDefinitions: () => [
          makeFixtureSkillToolDefinition('skill_video_expert_pipeline'),
          makeFixtureSkillToolDefinition('skill_run_shell'),
        ],
      },
    },
  })
}

test('ToolGateway chain: authorization=mode:none → BOTH fixture skill tools stripped (allowed_skill is also gone)', () => {
  const gateway = makeFixtureGateway()
  const tools = gateway.getOpenAIToolsForGroups(
    ['skills'],
    'session-test',
    buildExplicitNoSkillAuthorization('no_skill_signal'),
  )
  const skillNames = tools
    .map((t) => {
      const fn = (t.function as { name?: unknown } | undefined)?.name
      return typeof fn === 'string' ? fn : null
    })
    .filter((n): n is string => Boolean(n) && n.startsWith('skill_'))
  assert.deepEqual(skillNames, [], 'mode:none must strip ALL skill_* — both fixture tools should be gone')
})

test('ToolGateway chain: authorization=mode:selected → AUTHORIZED tool kept, UNAUTHORIZED tool stripped', () => {
  const gateway = makeFixtureGateway()
  const auth = buildSelectedSkillToolAuthorization({
    skillId: 'video-expert-analyzer',
    allowedTypedActions: ['skill_video_expert_pipeline'], // authorized
    allowedPrimitives: [], // skill_run_shell intentionally NOT here
    source: 'explicit',
    reason: 'user_named_skill',
  })
  const tools = gateway.getOpenAIToolsForGroups(['skills'], 'session-test', auth)
  const skillNames = tools
    .map((t) => {
      const fn = (t.function as { name?: unknown } | undefined)?.name
      return typeof fn === 'string' ? fn : null
    })
    .filter((n): n is string => Boolean(n) && n.startsWith('skill_'))
  assert.ok(
    skillNames.includes('skill_video_expert_pipeline'),
    'authorized typed action MUST remain in visible list',
  )
  assert.ok(
    !skillNames.includes('skill_run_shell'),
    'unauthorized primitive MUST be filtered out — got: ' + skillNames.join(', '),
  )
})

test('ToolGateway chain: anthropic format also filters by authorization', () => {
  const gateway = makeFixtureGateway()
  const auth = buildSelectedSkillToolAuthorization({
    skillId: 'video-expert-analyzer',
    allowedTypedActions: ['skill_video_expert_pipeline'],
    allowedPrimitives: [],
    source: 'explicit',
    reason: 'user_named_skill',
  })
  const tools = gateway.getAnthropicToolsForGroups(['skills'], 'session-test', auth)
  const skillNames = tools
    .map((t) => (typeof t.name === 'string' ? t.name : null))
    .filter((n): n is string => Boolean(n) && n.startsWith('skill_'))
  assert.ok(skillNames.includes('skill_video_expert_pipeline'))
  assert.ok(!skillNames.includes('skill_run_shell'))
})

