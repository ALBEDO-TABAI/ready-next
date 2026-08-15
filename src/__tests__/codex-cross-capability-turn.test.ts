import assert from 'node:assert/strict'
import test from 'node:test'

import { composeCodexTurnToolSnapshot } from '../main/modules/agent-control/codex-runtime/codex-tool-surface-composition'
import { buildBrowserAdmissionAuthoritySnapshot } from '../main/modules/agent-control/codex-runtime/codex-browser-admission'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { workbenchTestSnapshot } from './codex-workbench-surface-test-tools'

const pageRef = {
  tabId: 'tab-current',
  physicalTargetToken: 'physical-current',
  mainFrameDocumentToken: 'document-current',
}

const surface = [
  'web_search_domains',
  'web_search',
  'web_fetch',
  'browser_snapshot',
  'browser_find',
  'browser_read',
  'browser_screenshot',
  'browser_wait',
  'browser_status',
  'browser_click',
  'browser_type',
  'browser_research',
  'calendar_list_window',
  'calendar_create_event',
  'document_read_section',
]

function composeFor(instruction: string, workbenchMode: 'browser' | 'document' = 'browser') {
  void instruction
  return composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot(surface, ['document_read_section']),
    authorizationId: 'auth-cross-capability',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    workbenchMode,
    browserAdmission: workbenchMode === 'browser'
      ? buildBrowserAdmissionAuthoritySnapshot({
          authorityId: 'cross-capability',
          activeWorkbenchMode: 'browser',
          currentBrowserPageRef: pageRef,
        })
      : buildBrowserAdmissionAuthoritySnapshot({
          authorityId: 'cross-capability-document',
          activeWorkbenchMode: 'document',
        }),
  })
}

test('one turn can authorize public research and current-page read together', () => {
  const names = composeFor('先总结当前页，再查广州周末天气核对').readyTurnToolAuthorization.allowedToolNames
  assert.ok(names.includes('web_search'))
  assert.ok(names.includes('browser_read'))
  assert.ok(names.includes('browser_snapshot'))
  assert.ok(names.includes('browser_click'))
  assert.equal(names.includes('browser_research'), false)
})

test('a weather sentence on a bound page does not strip public research', () => {
  const names = composeFor('查广州周末天气').readyTurnToolAuthorization.allowedToolNames
  assert.ok(names.includes('web_search'))
  assert.ok(names.includes('web_fetch'))
  assert.ok(names.includes('browser_read'))
})

test('leaving the current page unused still leaves public research authorized', () => {
  const names = composeFor('当前页面放着不用管，请查广州周末天气').readyTurnToolAuthorization.allowedToolNames
  assert.ok(names.includes('web_search'))
  assert.ok(names.includes('browser_read'))
})

test('document weather keeps public research and no current-page tools', () => {
  const names = composeFor('查广州周末天气', 'document').readyTurnToolAuthorization.allowedToolNames
  assert.ok(names.includes('web_search'))
  assert.equal(names.some((name) => name.startsWith('browser_')), false)
})

test('ambiguous calendar keeps Ready local calendar, Feishu CLI primitives, and ask_user', () => {
  const authorization = {
    mode: 'none' as const,
    reason: 'no_skill_signal' as const,
    candidateSkillPrimitives: {
      skillId: 'lark-cli',
      primitives: ['skill_run_shell', 'skill_read_artifact', 'skill_ask_user'],
    },
  }
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot([
      ...surface,
      'skill_run_shell',
      'skill_read_artifact',
      'skill_ask_user',
      'ask_user_questions',
    ], ['document_read_section']),
    authorizationId: 'auth-calendar-sources',
    authorization,
    workbenchMode: 'calendar',
  })
  const names = composed.readyTurnToolAuthorization.allowedToolNames
  assert.ok(names.includes('calendar_list_window'))
  assert.ok(names.includes('skill_run_shell'))
  assert.ok(names.includes('ask_user_questions'))
  assert.equal(composed.readyTurnToolAuthorization.skillAuthorization.mode, 'none')
})
