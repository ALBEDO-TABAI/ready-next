import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import {
  browserInputEnvironmentReadiness,
  browserInputReadiness,
} from '../main/modules/browser-engine/browser-input-readiness'
import type { BrowserHostPresentationState } from '../main/modules/browser-engine/host-layout-service'
import { resolveTrustedBrowserEnvironment } from '../main/modules/agent-control/runtime-core/trusted-browser-environment'

function controllerFor(
  hostPresentation: BrowserHostPresentationState,
  options: { foreground?: boolean; active?: boolean } = {},
): BrowserController {
  return {
    getBrowserInputEnvironment: () => ({
      mainWindowForeground: options.foreground ?? false,
      hostPresentation,
      tabActive: options.active ?? false,
    }),
    getPhysicalTargetToken: () => 'physical-tab-a',
  } as unknown as BrowserController
}

const readyDocument = { ready: true, focused: true, activeElementEditable: true }

test('pointer needs a visible foreground host while target-bound CDP keyboard does not', async () => {
  const pointer = await browserInputReadiness(
    controllerFor('parked', { foreground: true, active: true }),
    'tab-a',
    'trusted_pointer',
    readyDocument,
  )
  assert.equal(pointer.ready, false)
  assert.equal(pointer.reason, 'host_not_presented')

  const keyboard = await browserInputReadiness(
    controllerFor('hidden', { foreground: false, active: false }),
    'tab-a',
    'trusted_keyboard',
    { ready: true, focused: false, activeElementEditable: true },
  )
  assert.equal(keyboard.ready, true)
  assert.equal(keyboard.hostPresentation, 'hidden')
})

test('direct text accepts a focused editable document on an attached parked host', async () => {
  const readiness = await browserInputReadiness(
    controllerFor('parked', { foreground: false, active: false }),
    'tab-a',
    'direct_text',
    readyDocument,
  )
  assert.equal(readiness.ready, true)
  assert.equal(readiness.hostPresentation, 'parked')
})

test('direct text remains available whenever the exact physical target exists', async () => {
  const hidden = await browserInputReadiness(
    controllerFor('hidden'),
    'tab-a',
    'direct_text',
    readyDocument,
  )
  assert.equal(hidden.ready, true)
  assert.equal(hidden.hostPresentation, 'hidden')

  const detached = await browserInputReadiness(
    controllerFor('detached'),
    'tab-a',
    'direct_text',
    readyDocument,
  )
  assert.equal(detached.ready, true)
  assert.equal(detached.hostPresentation, 'detached')

  const unavailable = controllerFor('detached')
  unavailable.getPhysicalTargetToken = () => null
  const missingTarget = await browserInputReadiness(
    unavailable,
    'tab-a',
    'direct_text',
    readyDocument,
  )
  assert.equal(missingTarget.ready, false)
  assert.equal(missingTarget.reason, 'physical_target_unavailable')
})

test('direct text requires an exact editable focus owner but not prior document focus', async () => {
  const unfocused = await browserInputReadiness(
    controllerFor('parked'),
    'tab-a',
    'direct_text',
    { ready: true, focused: false, activeElementEditable: true },
  )
  assert.equal(unfocused.ready, true)

  const nonEditable = await browserInputReadiness(
    controllerFor('parked'),
    'tab-a',
    'direct_text',
    { ready: true, focused: true, activeElementEditable: false },
  )
  assert.equal(nonEditable.ready, false)
  assert.equal(nonEditable.reason, 'editable_focus_required')
})

test('environment readiness keeps hidden target-bound keyboard available to compound actions', () => {
  const hiddenKeyboard = browserInputEnvironmentReadiness(
    controllerFor('hidden'),
    'tab-a',
    'trusted_keyboard',
  )
  assert.equal(hiddenKeyboard.ready, true)
  assert.equal(hiddenKeyboard.hostPresentation, 'hidden')

  const hiddenText = browserInputEnvironmentReadiness(
    controllerFor('hidden'),
    'tab-a',
    'direct_text',
  )
  assert.equal(hiddenText.ready, true)
})

test('Browser workbench keeps its trusted page identity while an overlay detaches the host', async () => {
  const environment = await resolveTrustedBrowserEnvironment({
    getActiveTab: () => ({ id: 'tab-overlay', profile: 'default' }),
    getBrowserInputEnvironment: () => {
      throw new Error('host presentation must not gate page identity')
    },
    getPhysicalTargetToken: () => 'physical-overlay',
    executeJS: async () => ({
      url: 'https://example.test/current',
      title: 'Current page',
      timeOrigin: 42,
      mutationRevision: 0,
      frameDocumentToken: 'document-overlay',
    }),
  } as unknown as BrowserController)

  assert.deepEqual(environment, {
    workbenchMode: 'browser',
    browserPageRef: {
      tabId: 'tab-overlay',
      physicalTargetToken: 'physical-overlay',
      mainFrameId: '0',
      mainFrameDocumentToken: 'document-overlay',
      profileId: 'default',
    },
  })
})
