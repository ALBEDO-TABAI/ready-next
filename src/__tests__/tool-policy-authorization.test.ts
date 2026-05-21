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

import type { AIModelConfig } from '../shared/ai-providers'
import { classifyIntent } from '../main/modules/agent-control/intent-classifier'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import {
  prepareInitialRun,
  type ReconciledRunCapabilities,
} from '../main/modules/agent-control/domain-adapters/run-capability-controller'
import {
  getPolicyOpenAIToolBundle,
  type ToolPolicy,
} from '../main/modules/agent-control/execution-tool-config'
import {
  buildAuthorizationFromIdentity,
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
  filterToolsByAuthorization,
} from '../main/modules/agent-control/skills/skill-tool-authorization'
import { ToolGateway } from '../main/modules/agent-control/tools-runtime/tool-gateway'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'

const BASE_CONFIG: AIModelConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o',
  toolUseMode: 'auto',
  visionMode: 'auto',
  nativeVideoMode: 'auto',
}

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
// (2) buildAuthorizationFromIdentity — source / reason mapping
// ---------------------------------------------------------------------------

test('buildAuthorizationFromIdentity: identity.mode=skill source=explicit_user_mention → authorization.source=explicit', () => {
  const auth = buildAuthorizationFromIdentity(
    { mode: 'skill', skillId: 'video-expert-analyzer', source: 'explicit_user_mention' },
    { preferredSkillToolNames: ['skill_video_expert_pipeline'], allPrimitiveToolNames: ['skill_run_shell'] },
  )
  assert.equal(auth.mode, 'selected')
  if (auth.mode === 'selected') {
    assert.equal(auth.source, 'explicit')
    assert.equal(auth.skillId, 'video-expert-analyzer')
    assert.equal(auth.allowedTypedActions.has('skill_video_expert_pipeline'), true)
    assert.equal(auth.allowedPrimitives.has('skill_run_shell'), true)
  }
})

test('buildAuthorizationFromIdentity: source=run_state_resource → authorization.source=trusted_resume', () => {
  const auth = buildAuthorizationFromIdentity(
    { mode: 'skill', skillId: 'video-expert-analyzer', source: 'run_state_resource' },
    { preferredSkillToolNames: [], allPrimitiveToolNames: [] },
  )
  if (auth.mode === 'selected') {
    assert.equal(auth.source, 'trusted_resume')
  } else {
    assert.fail('expected selected')
  }
})

test('buildAuthorizationFromIdentity: source=prior_tool_use_lookback → authorization.source=active_task', () => {
  const auth = buildAuthorizationFromIdentity(
    { mode: 'skill', skillId: 'lets-go-rss', source: 'prior_tool_use_lookback' },
    { preferredSkillToolNames: [], allPrimitiveToolNames: [] },
  )
  if (auth.mode === 'selected') {
    assert.equal(auth.source, 'active_task')
  } else {
    assert.fail('expected selected')
  }
})

test('buildAuthorizationFromIdentity: source=reference_hint / skill_history → authorization.source=active_task', () => {
  const hint = buildAuthorizationFromIdentity(
    { mode: 'skill', skillId: 'foo', source: 'reference_hint' },
    { preferredSkillToolNames: [], allPrimitiveToolNames: [] },
  )
  const history = buildAuthorizationFromIdentity(
    { mode: 'skill', skillId: 'foo', source: 'skill_history' },
    { preferredSkillToolNames: [], allPrimitiveToolNames: [] },
  )
  if (hint.mode === 'selected' && history.mode === 'selected') {
    assert.equal(hint.source, 'active_task')
    assert.equal(history.source, 'active_task')
  } else {
    assert.fail('expected both selected')
  }
})

test('buildAuthorizationFromIdentity: identity.mode=none reason=no_skill_signal → mode:none with same reason', () => {
  const auth = buildAuthorizationFromIdentity(
    { mode: 'none', reason: 'no_skill_signal' },
    { preferredSkillToolNames: [], allPrimitiveToolNames: [] },
  )
  assert.equal(auth.mode, 'none')
  if (auth.mode === 'none') {
    assert.equal(auth.reason, 'no_skill_signal')
  }
})

test('buildAuthorizationFromIdentity: identity.mode=none reason=config_repair_no_recoverable_task → preserved', () => {
  const auth = buildAuthorizationFromIdentity(
    { mode: 'none', reason: 'config_repair_no_recoverable_task' },
    { preferredSkillToolNames: [], allPrimitiveToolNames: [] },
  )
  if (auth.mode === 'none') {
    assert.equal(auth.reason, 'config_repair_no_recoverable_task')
  } else {
    assert.fail('expected none')
  }
})

test('buildAuthorizationFromIdentity: unknown identity reason → fall back to no_skill_signal (still denies)', () => {
  const auth = buildAuthorizationFromIdentity(
    { mode: 'none', reason: 'made_up_reason' as never },
    { preferredSkillToolNames: [], allPrimitiveToolNames: [] },
  )
  if (auth.mode === 'none') {
    assert.equal(auth.reason, 'no_skill_signal')
  } else {
    assert.fail('expected none')
  }
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


// ---------------------------------------------------------------------------
// (4) prepareInitialRun (W3b.2 fix) — allowedToolNames and toolResolution
//     are computed with authorization filter in place.
// ---------------------------------------------------------------------------

// Build inputs that ACTUALLY make the skills group visible by mimicking
// the `@[<skill name>]` mention pattern the run-capability-controller
// existing tests use (`prepareInitialRun exposes only selected skill
// tools when a skill is selected`). With `preferredSkillToolNames`
// non-empty AND user text containing an explicit skill mention, the
// capability layer enables the skills group; the registry then
// returns `skill_ask_user` (a real primitive) plus anything in
// `preferredSkillToolNames` that resolves through the live registry.
//
// The userText input is DELIBERATELY one the existing test fixture
// already verifies makes skills group visible (see
// run-capability-controller.test.ts:151-189).
function buildSkillVisibleInputs(
  authorization: ReconciledRunCapabilities['toolPolicy']['authorization'],
  preferredSkillToolNames: string[] | null = ['skill_ask_user'],
) {
  const userText = '@[Video Copy Analyzer] 分析这个视频文案'
  const requestEnvelope = buildRequestEnvelope({ userText })
  return {
    config: BASE_CONFIG,
    capabilityProfile: 'local_chat' as const,
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames,
    executionIntentContext: {
      requestEnvelope,
      intentClassification: classifyIntent(requestEnvelope),
      contextualUserInput: userText,
      userInstructionText: userText,
      hasDocumentEnvironment: false,
      hasWidgetTargetContext: false,
      explicitWidgetCreateIntent: false,
      documentWidgetTaskKind: null,
      documentWidgetProfile: null,
    },
    browserDecisionMode: 'free_tool_loop' as const,
    runtimeAvailability: {
      browserHostAvailable: true,
      feishuConnected: true,
    },
    hostContext: { userText },
    // Intentionally NO sessionId — `filterSkillPrimitivesBySession`'s
    // `shouldExposeSkillPrimitive` falls back to "show all primitives" when
    // sessionId is undefined, which keeps `skill_ask_user` in the visible
    // skills list. Mirrors the run-capability-controller test fixture at
    // `prepareInitialRun exposes only selected skill tools when a skill is
    // selected` (line 151-189).
    authorization,
  }
}

test('prepareInitialRun: skills group visible + authorization=mode:none → skill_ask_user STRIPPED from allowedToolNames', () => {
  // Real W3b.2 fix coverage: skills group is visible AND a skill tool is
  // present in the baseline. With mode:none authorization, the registry
  // filter MUST strip it from prepared.allowedToolNames (which is built
  // from `getPolicyOpenAIToolBundle` BEFORE turn-engine's post-call
  // mutation — the W3b.2.1 fix is what makes this consistent).
  const auth = buildExplicitNoSkillAuthorization('no_skill_signal')
  const prepared = prepareInitialRun(buildSkillVisibleInputs(auth))
  const skillNames = prepared.allowedToolNames.filter((n) => n.startsWith('skill_'))
  assert.deepEqual(
    skillNames,
    [],
    `mode:none must strip ALL skill_* in allowedToolNames; got: ${skillNames.join(', ')}`,
  )
  assert.equal(prepared.toolPolicy.authorization, auth, 'toolPolicy.authorization carried through')
})

test('prepareInitialRun: skills group visible + authorization=mode:selected (allowed=skill_ask_user) → skill_ask_user RETAINED, others not added', () => {
  // mode:selected with allowedPrimitives=['skill_ask_user'] retains the
  // authorized primitive in allowedToolNames. The fixture has nothing
  // else to leak (no extra skill tools beyond ask_user), but the
  // assertion proves the filter doesn't false-positive strip authorized
  // tools.
  const auth = buildSelectedSkillToolAuthorization({
    skillId: 'video-copy-analyzer',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_ask_user'],
    source: 'explicit',
    reason: 'user_named_skill',
  })
  const prepared = prepareInitialRun(buildSkillVisibleInputs(auth, ['skill_ask_user']))
  assert.ok(
    prepared.allowedToolNames.includes('skill_ask_user'),
    `authorized primitive MUST remain in allowedToolNames; got: ${prepared.allowedToolNames.join(', ')}`,
  )
  // Any other skill_* tools that registered themselves but aren't in
  // allowedTypedActions/allowedPrimitives must not appear.
  const otherSkillNames = prepared.allowedToolNames.filter((n) => n.startsWith('skill_') && n !== 'skill_ask_user')
  assert.deepEqual(
    otherSkillNames,
    [],
    `unauthorized skill_* leaked: ${otherSkillNames.join(', ')}`,
  )
})

// ---------------------------------------------------------------------------
// (5) Stage 4 W3b.3 — `filterPreferredSkill*Tools` and
//     `mergeForceDocumentAllowedNames` accept authorization as a defense-
//     in-depth layer alongside the existing `preferredSkillToolNames` filter.
//     If the registry filter is bypassed for any reason, these helpers still
//     enforce authorization at the policy layer (and, for force-document
//     mode, at the merge step). Direct unit coverage is required because
//     the prepareInitialRun chain has both layers active simultaneously —
//     stripping at gateway leaves nothing for these helpers to strip.
// ---------------------------------------------------------------------------

test('filterPreferredSkillAnthropicTools: authorization=mode:none → strips skill_* even if in preferredSkillToolNames', async () => {
  const { filterPreferredSkillAnthropicTools } = await import(
    '../main/modules/agent-control/execution-tool-skill-filters'
  )
  const tools: Array<Record<string, unknown>> = [
    { name: 'document_open_tab' },
    { name: 'skill_video_expert_pipeline' },
    { name: 'skill_run_shell' },
  ]
  const filtered = filterPreferredSkillAnthropicTools(
    tools,
    ['skill_video_expert_pipeline', 'skill_run_shell'],
    buildExplicitNoSkillAuthorization('no_skill_signal'),
  )
  assert.deepEqual(
    filtered.map((t) => t.name),
    ['document_open_tab'],
    'mode:none must strip skill_* even when listed in preferredSkillToolNames',
  )
})

test('filterPreferredSkillAnthropicTools: authorization=mode:selected → keeps skill_* only when in preferredSkillToolNames AND authorized (intersection)', async () => {
  const { filterPreferredSkillAnthropicTools } = await import(
    '../main/modules/agent-control/execution-tool-skill-filters'
  )
  const tools: Array<Record<string, unknown>> = [
    { name: 'document_open_tab' },
    { name: 'skill_video_expert_pipeline' }, // in both sets
    { name: 'skill_run_shell' }, // in preferred, NOT in allowed
    { name: 'skill_read_artifact' }, // in allowed, NOT in preferred
  ]
  const auth = buildSelectedSkillToolAuthorization({
    skillId: 'video-expert-analyzer',
    allowedTypedActions: ['skill_video_expert_pipeline'],
    allowedPrimitives: ['skill_read_artifact'],
    source: 'explicit',
    reason: 'user_named_skill',
  })
  const filtered = filterPreferredSkillAnthropicTools(
    tools,
    ['skill_video_expert_pipeline', 'skill_run_shell'],
    auth,
  )
  const names = filtered.map((t) => t.name).sort()
  assert.deepEqual(names, ['document_open_tab', 'skill_video_expert_pipeline'].sort(),
    `expected intersection of preferred ∩ authorized only; got: ${names.join(', ')}`)
})

test('filterPreferredSkillOpenAITools: authorization=mode:none → strips skill_* under OpenAI tool shape', async () => {
  const { filterPreferredSkillOpenAITools } = await import(
    '../main/modules/agent-control/execution-tool-skill-filters'
  )
  const tools: Array<Record<string, unknown>> = [
    { function: { name: 'document_open_tab' } },
    { function: { name: 'skill_video_expert_pipeline' } },
    { function: { name: 'skill_run_shell' } },
  ]
  const filtered = filterPreferredSkillOpenAITools(
    tools,
    ['skill_video_expert_pipeline', 'skill_run_shell'],
    buildExplicitNoSkillAuthorization('no_skill_signal'),
  )
  const names = filtered
    .map((t) => (t.function as { name?: unknown } | undefined)?.name)
    .filter((n): n is string => typeof n === 'string')
  assert.deepEqual(names, ['document_open_tab'])
})

test('mergeForceDocumentAllowedNames: authorization=mode:none → does NOT merge skill names into forced-document allowlist', async () => {
  const { mergeForceDocumentAllowedNames } = await import(
    '../main/modules/agent-control/execution-tool-skill-filters'
  )
  const baseAllowed = new Set(['document_open_tab', 'document_save_tab'])
  const merged = mergeForceDocumentAllowedNames(
    baseAllowed,
    ['skill_video_expert_pipeline', 'skill_run_shell'],
    buildExplicitNoSkillAuthorization('no_skill_signal'),
  )
  assert.deepEqual(
    Array.from(merged).sort(),
    ['document_open_tab', 'document_save_tab'].sort(),
    'mode:none must NOT merge skill_* into the force-document allowlist',
  )
})

test('mergeForceDocumentAllowedNames: authorization=mode:selected → merges only authorized skill names', async () => {
  const { mergeForceDocumentAllowedNames } = await import(
    '../main/modules/agent-control/execution-tool-skill-filters'
  )
  const baseAllowed = new Set(['document_open_tab'])
  const auth = buildSelectedSkillToolAuthorization({
    skillId: 'video-expert-analyzer',
    allowedTypedActions: ['skill_video_expert_pipeline'],
    allowedPrimitives: [],
    source: 'explicit',
    reason: 'user_named_skill',
  })
  const merged = mergeForceDocumentAllowedNames(
    baseAllowed,
    ['skill_video_expert_pipeline', 'skill_run_shell'], // skill_run_shell NOT authorized
    auth,
  )
  assert.deepEqual(
    Array.from(merged).sort(),
    ['document_open_tab', 'skill_video_expert_pipeline'].sort(),
    'only authorized skill names should be merged into force-document allowlist',
  )
})

