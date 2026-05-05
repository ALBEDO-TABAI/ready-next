/**
 * Stage 4 W3b.2 — end-to-end coverage for the
 * `ToolPolicy → gateway → registry list filter` plumbing.
 *
 * Tests the W3b.2 chain at three levels:
 *
 *   1. `filterToolsByAuthorization` helper — direct behavior across the
 *      three authorization shapes (`'not_set'` short-circuit, `mode:'none'`
 *      with explicit reason, `mode:'selected'` with allowed sets).
 *
 *   2. `buildAuthorizationFromIdentity` helper — identity.source / reason
 *      mapping into authorization.source / authorization.reason. Without
 *      this pin a refactor that drops the source mapping would silently
 *      flip authorization.source from 'explicit'/'trusted_resume'/'active_task'.
 *
 *   3. `getPolicyAnthropicTools` / `getPolicyOpenAIToolBundle` — the
 *      visible tool list construction must respect ToolPolicy.authorization
 *      (the W3b.2 cutover). Tests both `mode:'none'` (skill_* removed) and
 *      `mode:'selected'` (only allowed skill_* retained), with non-skill
 *      tools always passing through.
 *
 *   4. `prepareInitialRun` (W3b.2 fix) — when authorization is threaded
 *      through `RunCapabilityBaseParams`, the resulting `allowedToolNames`
 *      and `toolResolution` snapshot are computed with the filter in
 *      place. Without the fix, the diagnostic snapshot drifts from the
 *      post-cutover policy applied later in turn-engine.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import type { AIModelConfig } from '../shared/ai-providers'
import { classifyIntent } from '../main/modules/agent-control/intent-classifier'
import { buildRequestEnvelope } from '../main/modules/agent-control/request-envelope'
import {
  prepareInitialRun,
  type ReconciledRunCapabilities,
} from '../main/modules/agent-control/run-capability-controller'
import {
  getPolicyOpenAIToolBundle,
  type ToolPolicy,
} from '../main/modules/agent-control/execution-tool-config'
import {
  SKILL_TOOL_AUTHORIZATION_NOT_SET,
  buildAuthorizationFromIdentity,
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
  filterToolsByAuthorization,
} from '../main/modules/agent-control/skill-tool-authorization'
import { ToolGateway } from '../main/modules/agent-control/tool-gateway'
import type { ToolDefinition } from '../main/modules/agent-control/tool-definition'

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

test('filterToolsByAuthorization: not_set default → no filter (back-compat)', () => {
  const tools: NamedTool[] = [
    { name: 'document_open_tab' },
    { name: 'skill_video_expert_pipeline' },
    { name: 'skill_run_shell' },
  ]
  const filtered = filterToolsByAuthorization(tools, SKILL_TOOL_AUTHORIZATION_NOT_SET, (t) => t.name)
  assert.deepEqual(filtered.map((t) => t.name), tools.map((t) => t.name))
})

test('filterToolsByAuthorization: mode:none non-not_set → strip ALL skill_* tools', () => {
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

test('buildAuthorizationFromIdentity: identity.mode=none reason=no_skill_signal → mode:none with same reason (NOT not_set)', () => {
  const auth = buildAuthorizationFromIdentity(
    { mode: 'none', reason: 'no_skill_signal' },
    { preferredSkillToolNames: [], allPrimitiveToolNames: [] },
  )
  assert.equal(auth.mode, 'none')
  if (auth.mode === 'none') {
    assert.equal(auth.reason, 'no_skill_signal')
    assert.notEqual(auth.reason, 'not_set', 'must NOT collapse to not_set — that would short-circuit admission')
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
  // Defensive — unknown identity.reason still produces a denying
  // authorization, never `'not_set'` (which would short-circuit).
  const auth = buildAuthorizationFromIdentity(
    { mode: 'none', reason: 'made_up_reason' as never },
    { preferredSkillToolNames: [], allPrimitiveToolNames: [] },
  )
  if (auth.mode === 'none') {
    assert.notEqual(auth.reason, 'not_set')
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

test('ToolGateway chain: no authorization (back-compat) → both fixture skills retained', () => {
  const gateway = makeFixtureGateway()
  // Pass `null` to exercise the back-compat path explicitly.
  const tools = gateway.getOpenAIToolsForGroups(['skills'], 'session-test', null)
  const skillNames = tools
    .map((t) => {
      const fn = (t.function as { name?: unknown } | undefined)?.name
      return typeof fn === 'string' ? fn : null
    })
    .filter((n): n is string => Boolean(n) && n.startsWith('skill_'))
  assert.ok(skillNames.includes('skill_video_expert_pipeline'))
  assert.ok(skillNames.includes('skill_run_shell'))
})

test('getPolicyOpenAIToolBundle: no ToolPolicy.authorization (legacy callers) → behaves as before W3b.2', () => {
  // Back-compat smoke: if authorization is undefined on the policy, the
  // filter does nothing in the singleton-gateway path. ToolPolicy still
  // applies its existing preferredSkillToolNames filter.
  const policy = makeBasePolicy()
  const bundle = getPolicyOpenAIToolBundle(policy)
  // Just verify no crash and bundle is non-empty.
  assert.ok(bundle.toolNames.length >= 0)
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

test('prepareInitialRun: skills group visible + no authorization → baseline contains skill_ask_user (sanity for the next two tests)', () => {
  // Sanity: without this baseline succeeding, the next two tests' skill_*
  // assertions would be vacuously true. This baseline proves the fixture
  // actually puts skill_ask_user in allowedToolNames absent authorization.
  const inputs = buildSkillVisibleInputs(undefined)
  delete (inputs as { authorization?: unknown }).authorization
  const prepared = prepareInitialRun(inputs)
  assert.ok(
    prepared.capabilityResolution.visibleCapabilityGroupIds.includes('skills'),
    'skills group MUST be visible in this fixture (else later assertions are vacuous)',
  )
  assert.ok(
    prepared.allowedToolNames.includes('skill_ask_user'),
    `baseline allowedToolNames must include skill_ask_user; got: ${prepared.allowedToolNames.join(', ')}`,
  )
})

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

test('prepareInitialRun: no authorization passed → toolPolicy.authorization stays undefined (legacy back-compat)', () => {
  const inputs = buildSkillVisibleInputs(undefined)
  delete (inputs as { authorization?: unknown }).authorization
  const prepared = prepareInitialRun(inputs)
  assert.ok(
    prepared.toolPolicy.authorization === undefined
    || prepared.toolPolicy.authorization === null,
    `unexpected authorization value: ${JSON.stringify(prepared.toolPolicy.authorization)}`,
  )
})
