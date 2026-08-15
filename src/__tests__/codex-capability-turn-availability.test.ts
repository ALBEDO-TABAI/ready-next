import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveReadyCapabilityTurnAvailability } from '../main/modules/agent-control/codex-runtime/codex-capability-turn-availability'
import { composeCodexTurnToolSnapshot } from '../main/modules/agent-control/codex-runtime/codex-tool-surface-composition'
import { buildBrowserAdmissionAuthoritySnapshot } from '../main/modules/agent-control/codex-runtime/codex-browser-admission'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { workbenchTestSnapshot } from './codex-workbench-surface-test-tools'

const pageRef = {
  tabId: 'tab-current',
  physicalTargetToken: 'physical-current',
  mainFrameDocumentToken: 'document-current',
}

const typedRef = {
  tabId: 'tab-cited',
  physicalTargetToken: 'physical-cited',
  mainFrameDocumentToken: 'document-cited',
}

test('structure facts decide availability without reading user language', () => {
  const weatherOnPage = resolveReadyCapabilityTurnAvailability({
    publicResearchProviderAvailable: true,
    calendarHostAvailable: true,
    calendarProductMapped: true,
    workbenchMode: 'browser',
    currentBrowserPageRef: pageRef,
  })
  assert.deepEqual(weatherOnPage.availableGroupIds, [
    'browser_current_act',
    'browser_current_read',
    'calendar_read',
    'calendar_write',
    'public_research',
  ])
  assert.deepEqual(weatherOnPage.explicitFloorGroupIds, [])

  const typedRead = resolveReadyCapabilityTurnAvailability({
    publicResearchProviderAvailable: true,
    calendarHostAvailable: false,
    calendarProductMapped: false,
    workbenchMode: 'document',
    explicitBrowserReadRefs: [typedRef],
  })
  assert.ok(typedRead.availableGroupIds.includes('browser_current_read'))
  assert.ok(typedRead.availableGroupIds.includes('public_research'))
  assert.equal(typedRead.availableGroupIds.includes('browser_current_act'), false)
  assert.deepEqual(typedRead.explicitFloorGroupIds, ['browser_current_read'])
  assert.equal(typedRead.unavailableReasons.browser_current_act, 'typed_reference_is_read_only')

  const noPage = resolveReadyCapabilityTurnAvailability({
    publicResearchProviderAvailable: true,
    calendarHostAvailable: false,
    calendarProductMapped: false,
    workbenchMode: 'browser',
  })
  assert.deepEqual(noPage.availableGroupIds, ['public_research'])
  assert.equal(noPage.unavailableReasons.browser_current_read, 'page_ref_missing')
  assert.equal(noPage.unavailableReasons.browser_current_act, 'page_ref_missing')
})

test('calendar workbench or calendar resource is a read floor, not a write floor', () => {
  const workbench = resolveReadyCapabilityTurnAvailability({
    publicResearchProviderAvailable: true,
    calendarHostAvailable: true,
    calendarProductMapped: true,
    workbenchMode: 'calendar',
  })
  assert.ok(workbench.availableGroupIds.includes('calendar_write'))
  assert.deepEqual(workbench.explicitFloorGroupIds, ['calendar_read'])

  const resource = resolveReadyCapabilityTurnAvailability({
    publicResearchProviderAvailable: false,
    calendarHostAvailable: true,
    calendarProductMapped: true,
    workbenchMode: 'document',
    hasCalendarResource: true,
  })
  assert.deepEqual(resource.explicitFloorGroupIds, ['calendar_read'])
  assert.equal(resource.availableGroupIds.includes('public_research'), false)
})

test('pageRef is not an act floor and two turns do not share availability', () => {
  const first = resolveReadyCapabilityTurnAvailability({
    publicResearchProviderAvailable: true,
    calendarHostAvailable: false,
    calendarProductMapped: false,
    currentBrowserPageRef: pageRef,
  })
  const second = resolveReadyCapabilityTurnAvailability({
    publicResearchProviderAvailable: true,
    calendarHostAvailable: false,
    calendarProductMapped: false,
  })
  assert.ok(first.availableGroupIds.includes('browser_current_act'))
  assert.equal(first.explicitFloorGroupIds.includes('browser_current_act'), false)
  assert.equal(second.availableGroupIds.includes('browser_current_act'), false)
  assert.notEqual(first.availabilityDigest, second.availabilityDigest)
})

test('availability is not written into additionalContext or user text', () => {
  const availability = resolveReadyCapabilityTurnAvailability({
    publicResearchProviderAvailable: true,
    calendarHostAvailable: true,
    calendarProductMapped: true,
    currentBrowserPageRef: pageRef,
  })
  const additionalContext = {
    doc: { kind: 'application', value: 'resource-ref' },
  }
  assert.equal(JSON.stringify(additionalContext).includes(availability.availabilityDigest), false)
  assert.equal(JSON.stringify(additionalContext).includes('browser_current_act'), false)
  assert.equal(JSON.stringify(additionalContext).includes('availableGroupIds'), false)
})

test('compose can keep public research and current-page read together', () => {
  const surface = [
    'web_search',
    'web_fetch',
    'web_search_domains',
    'browser_read',
    'browser_snapshot',
    'browser_click',
    'browser_research',
    'document_read_section',
  ]
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot(surface, ['document_read_section']),
    authorizationId: 'auth-coexist',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    workbenchMode: 'browser',
    browserAdmission: buildBrowserAdmissionAuthoritySnapshot({
      authorityId: 'coexist',
      activeWorkbenchMode: 'browser',
      currentBrowserPageRef: pageRef,
    }),
  })
  const names = composed.readyTurnToolAuthorization.allowedToolNames
  assert.ok(names.includes('web_search'))
  assert.ok(names.includes('browser_read'))
  assert.ok(names.includes('browser_click'))
  assert.equal(names.includes('browser_research'), false)
})
