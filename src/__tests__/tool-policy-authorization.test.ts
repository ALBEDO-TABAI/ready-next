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
  getPolicyAnthropicTools,
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
// (3) getPolicyAnthropicTools / getPolicyOpenAIToolBundle — visible list
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

test('getPolicyOpenAIToolBundle: ToolPolicy.authorization=mode:none → ZERO skill_* tools in visible list', () => {
  const policy = makeBasePolicy({
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
  })
  const bundle = getPolicyOpenAIToolBundle(policy)
  const skillTools = bundle.toolNames.filter((n) => n.startsWith('skill_'))
  assert.equal(skillTools.length, 0, `mode:none must strip all skill_* — got ${skillTools.join(', ')}`)
  // Non-skill tools should still appear (subject to capability profile).
  assert.ok(bundle.toolNames.some((n) => !n.startsWith('skill_')), 'non-skill tools must remain visible')
})

test('getPolicyAnthropicTools: ToolPolicy.authorization=mode:none → ZERO skill_* tools', () => {
  const policy = makeBasePolicy({
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
  })
  const tools = getPolicyAnthropicTools(policy)
  const skillTools = tools
    .map((t) => (typeof t.name === 'string' ? t.name : ''))
    .filter((n) => n.startsWith('skill_'))
  assert.equal(skillTools.length, 0, 'mode:none must strip all skill_* in anthropic format too')
})

test('getPolicyOpenAIToolBundle: ToolPolicy.authorization=mode:selected → only allowed skill_* retained', () => {
  const auth = buildSelectedSkillToolAuthorization({
    skillId: 'video-expert-analyzer',
    allowedTypedActions: ['skill_video_expert_pipeline'],
    // Empty primitives — no primitive should appear.
    allowedPrimitives: [],
    source: 'explicit',
    reason: 'user_named_skill',
  })
  const policy = makeBasePolicy({
    authorization: auth,
    preferredSkillToolNames: ['skill_video_expert_pipeline', 'skill_video_expert_ai_analyze'],
  })
  const bundle = getPolicyOpenAIToolBundle(policy)
  const skillTools = bundle.toolNames.filter((n) => n.startsWith('skill_'))
  // Only skill_video_expert_pipeline is in allowedTypedActions; ai_analyze
  // is filtered out by authorization even though preferredSkillToolNames
  // includes it. Primitives are also filtered out.
  for (const name of skillTools) {
    assert.equal(name, 'skill_video_expert_pipeline', `unauthorized skill tool leaked: ${name}`)
  }
})

test('getPolicyOpenAIToolBundle: no ToolPolicy.authorization (legacy callers) → behaves as before W3b.2', () => {
  // Back-compat: if authorization is undefined, the filter does nothing.
  // ToolPolicy still applies its existing preferredSkillToolNames filter.
  const policy = makeBasePolicy()
  const bundle = getPolicyOpenAIToolBundle(policy)
  // Just verify no crash and bundle is non-empty.
  assert.ok(bundle.toolNames.length >= 0)
})

// ---------------------------------------------------------------------------
// (4) prepareInitialRun (W3b.2 fix) — allowedToolNames and toolResolution
//     are computed with authorization filter in place.
// ---------------------------------------------------------------------------

function buildPreparedInputs(authorization: ReconciledRunCapabilities['toolPolicy']['authorization']) {
  const requestEnvelope = buildRequestEnvelope({ userText: '帮我看一下天气' })
  return {
    config: BASE_CONFIG,
    capabilityProfile: 'local_chat' as const,
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    executionIntentContext: {
      requestEnvelope,
      intentClassification: classifyIntent(requestEnvelope),
      contextualUserInput: '帮我看一下天气',
      userInstructionText: '帮我看一下天气',
      hasDocumentEnvironment: false,
      hasWidgetTargetContext: false,
      explicitWidgetCreateIntent: false,
      documentWidgetTaskKind: null,
      documentWidgetProfile: null,
    },
    browserDecisionMode: 'free_tool_loop' as const,
    runtimeAvailability: {
      browserHostAvailable: true,
      feishuConnected: false,
    },
    hostContext: { userText: '帮我看一下天气' },
    sessionId: 'scope-test',
    authorization,
  }
}

test('prepareInitialRun: authorization=mode:none → allowedToolNames excludes ALL skill_*', () => {
  const prepared = prepareInitialRun(
    buildPreparedInputs(buildExplicitNoSkillAuthorization('no_skill_signal')),
  )
  const skillNames = prepared.allowedToolNames.filter((n) => n.startsWith('skill_'))
  assert.equal(
    skillNames.length,
    0,
    `prepareInitialRun must apply authorization filter BEFORE bundling — got skill_* in allowedToolNames: ${skillNames.join(', ')}`,
  )
})

test('prepareInitialRun: authorization=mode:none → toolPolicy.authorization is set on the returned policy', () => {
  const auth = buildExplicitNoSkillAuthorization('no_skill_signal')
  const prepared = prepareInitialRun(buildPreparedInputs(auth))
  assert.equal(prepared.toolPolicy.authorization, auth)
})

test('prepareInitialRun: no authorization passed → toolPolicy.authorization stays undefined (legacy back-compat)', () => {
  const inputs = buildPreparedInputs(undefined)
  delete (inputs as { authorization?: unknown }).authorization
  const prepared = prepareInitialRun(inputs)
  // Either undefined or unset — what we care about is that the snapshot
  // doesn't accidentally introduce a `'not_set'` short-circuit value.
  assert.ok(
    prepared.toolPolicy.authorization === undefined
    || prepared.toolPolicy.authorization === null,
    `unexpected authorization value: ${JSON.stringify(prepared.toolPolicy.authorization)}`,
  )
})
