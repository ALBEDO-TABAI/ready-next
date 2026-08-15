import assert from 'node:assert/strict'
import test from 'node:test'

import { composeCodexTurnToolSnapshot } from '../main/modules/agent-control/codex-runtime/codex-tool-surface-composition'
import { resolveReadyCapabilityTurnAvailability } from '../main/modules/agent-control/codex-runtime/codex-capability-turn-availability'
import { TAG_FORGE_EXCLUSIVE_TOOL_NAMES } from '../main/modules/agent-control/codex-runtime/codex-product-action-map'
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
} from '../main/modules/agent-control/skills/skill-tool-authorization'
import { workbenchTestSnapshot } from './codex-workbench-surface-test-tools'

const FEISHU_CANDIDATE = {
  skillId: 'lark-cli',
  primitives: ['skill_run_shell', 'skill_read_artifact', 'skill_ask_user'],
} as const

const DUAL_SOURCE_SURFACE = [
  'calendar_list_window',
  'calendar_capture_session',
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
  'skill_run_shell',
  'skill_read_artifact',
  'skill_ask_user',
  'ask_user_questions',
  'web_search',
  'web_fetch',
]

function composeDualSource(input: {
  authorization: ReturnType<typeof buildExplicitNoSkillAuthorization> | ReturnType<typeof buildSelectedSkillToolAuthorization>
  workbenchMode?: 'browser' | 'document' | 'calendar'
  exclusiveAllowSet?: readonly string[] | null
  surface?: readonly string[]
  allowed?: readonly string[]
}) {
  const surface = [...(input.surface || DUAL_SOURCE_SURFACE)]
  if (!surface.includes('document_read_section')) surface.push('document_read_section')
  for (const name of TAG_FORGE_EXCLUSIVE_TOOL_NAMES) {
    if (!surface.includes(name)) surface.push(name)
  }
  const surfaceNames = new Set(surface)
  return composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot(surface, input.allowed ? [...input.allowed] : ['document_read_section']),
    authorizationId: 'auth-calendar-source',
    authorization: input.authorization,
    workbenchMode: input.workbenchMode || 'document',
    exclusiveAllowSet: input.exclusiveAllowSet,
    capabilityAvailability: resolveReadyCapabilityTurnAvailability({
      publicResearchProviderAvailable: surfaceNames.has('web_search') || surfaceNames.has('web_fetch'),
      calendarHostAvailable: surfaceNames.has('calendar_list_window')
        || surfaceNames.has('calendar_capture_session')
        || surfaceNames.has('calendar_create_event'),
      calendarProductMapped: surfaceNames.has('calendar_create_event'),
      workbenchMode: input.workbenchMode || 'document',
      tagForgeExclusive: input.exclusiveAllowSet != null,
    }),
  })
}

test('ambiguous calendar request keeps both sources and ask_user on the same frozen turn', () => {
  const authorization = buildExplicitNoSkillAuthorization('no_skill_signal', {
    candidateSkillPrimitives: FEISHU_CANDIDATE,
  })
  for (const workbenchMode of ['document', 'browser', 'calendar'] as const) {
    const names = composeDualSource({ authorization, workbenchMode }).readyTurnToolAuthorization.allowedToolNames
    assert.ok(names.includes('calendar_list_window'), workbenchMode)
    assert.ok(names.includes('skill_run_shell'), workbenchMode)
    assert.ok(names.includes('ask_user_questions'), workbenchMode)
    assert.ok(names.includes('web_search'), workbenchMode)
  }
})

test('answering a source question does not need a new capability grant', () => {
  const authorization = buildExplicitNoSkillAuthorization('no_skill_signal', {
    candidateSkillPrimitives: FEISHU_CANDIDATE,
  })
  const before = composeDualSource({ authorization, workbenchMode: 'document' })
  const after = composeDualSource({ authorization, workbenchMode: 'document' })
  assert.deepEqual(
    [...before.readyTurnToolAuthorization.allowedToolNames].sort(),
    [...after.readyTurnToolAuthorization.allowedToolNames].sort(),
  )
  assert.ok(after.readyTurnToolAuthorization.allowedToolNames.includes('calendar_list_window'))
  assert.ok(after.readyTurnToolAuthorization.allowedToolNames.includes('skill_run_shell'))
  assert.ok(after.readyTurnToolAuthorization.allowedToolNames.includes('ask_user_questions'))
})

test('only Ready local calendar does not invent a Feishu ask', () => {
  const composed = composeDualSource({
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    workbenchMode: 'document',
    surface: [
      'calendar_list_window',
      'calendar_create_event',
      'ask_user_questions',
      'web_search',
    ],
  })
  const names = composed.readyTurnToolAuthorization.allowedToolNames
  assert.ok(names.includes('calendar_list_window'))
  assert.equal(names.includes('skill_run_shell'), false)
  assert.equal(names.includes('ask_user_questions'), false)
})

test('only Feishu candidate does not invent a local-calendar ask', () => {
  const composed = composeDualSource({
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal', {
      candidateSkillPrimitives: FEISHU_CANDIDATE,
    }),
    workbenchMode: 'document',
    surface: [
      'skill_run_shell',
      'skill_read_artifact',
      'skill_ask_user',
      'ask_user_questions',
      'web_search',
    ],
  })
  const names = composed.readyTurnToolAuthorization.allowedToolNames
  assert.ok(names.includes('skill_run_shell'))
  assert.equal(names.includes('calendar_list_window'), false)
  assert.equal(names.includes('ask_user_questions'), false)
})

test('explicit both-sources request can keep local calendar and Feishu primitives together', () => {
  const names = composeDualSource({
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal', {
      candidateSkillPrimitives: FEISHU_CANDIDATE,
    }),
    workbenchMode: 'document',
  }).readyTurnToolAuthorization.allowedToolNames
  assert.ok(names.includes('calendar_list_window'))
  assert.ok(names.includes('calendar_create_event'))
  assert.ok(names.includes('skill_run_shell'))
})

test('write confirmation stays a separate tool from source selection', () => {
  const names = composeDualSource({
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal', {
      candidateSkillPrimitives: FEISHU_CANDIDATE,
    }),
    workbenchMode: 'calendar',
  }).readyTurnToolAuthorization.allowedToolNames
  assert.ok(names.includes('calendar_create_event'))
  assert.ok(names.includes('ask_user_questions'))
  assert.ok(names.includes('calendar_list_window'))
})

test('selected additive lark-cli does not strip Ready local calendar or ask_user', () => {
  const authorization = buildSelectedSkillToolAuthorization({
    skillId: 'lark-cli',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_run_shell', 'skill_read_artifact', 'skill_ask_user'],
    source: 'explicit',
    reason: 'explicit_user_mention',
  })
  const names = composeDualSource({
    authorization,
    workbenchMode: 'calendar',
    allowed: [
      'calendar_list_window',
      'skill_run_shell',
      'skill_read_artifact',
      'skill_ask_user',
      'ask_user_questions',
      'web_search',
    ],
  }).readyTurnToolAuthorization.allowedToolNames
  assert.ok(names.includes('calendar_list_window'))
  assert.ok(names.includes('skill_run_shell'))
  assert.ok(names.includes('ask_user_questions'))
  assert.ok(names.includes('web_search'))
})

test('Tag Forge exclusive still replaces calendar and Feishu candidates', () => {
  const names = composeDualSource({
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal', {
      candidateSkillPrimitives: FEISHU_CANDIDATE,
    }),
    workbenchMode: 'calendar',
    exclusiveAllowSet: TAG_FORGE_EXCLUSIVE_TOOL_NAMES,
  }).readyTurnToolAuthorization.allowedToolNames
  assert.equal(names.includes('calendar_list_window'), false)
  assert.equal(names.includes('skill_run_shell'), false)
  assert.equal(names.includes('ask_user_questions'), false)
  assert.ok(names.includes('tag_forge_prepare_batch'))
})
