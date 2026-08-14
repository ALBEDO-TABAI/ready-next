import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import {
  browserInputEnvironmentReadiness,
  browserInputReadiness,
} from '../main/modules/browser-engine/browser-input-readiness'
import { requireTrustedPointerDelivery } from '../main/modules/tools/browser-input-actions'
import type { BrowserHostPresentationState } from '../main/modules/browser-engine/host-layout-service'
import {
  resolveTrustedBrowserEnvironment,
  resolveTrustedBrowserReference,
} from '../main/modules/agent-control/runtime-core/trusted-browser-environment'

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

test('explicit Browser reference reads the named tab and rejects a page identity change during capture', async () => {
  let frameToken = 'document-v1'
  const controller = {
    getTabList: () => [
      { id: 'tab-background', profile: 'profile-a', url: 'https://example.test/background' },
      { id: 'tab-active', profile: 'profile-a', url: 'https://example.test/active' },
    ],
    getActiveTab: () => ({ id: 'tab-active', profile: 'profile-a' }),
    getPhysicalTargetToken: (tabId: string) => `physical:${tabId}`,
    executeJS: async (tabId: string) => ({
      url: tabId === 'tab-background' ? 'https://example.test/background' : 'https://example.test/active',
      title: 'Background page',
      timeOrigin: 42,
      mutationRevision: 0,
      frameDocumentToken: frameToken,
    }),
    getTabContext: async (tabId: string) => ({
      title: 'Background page',
      url: tabId === 'tab-background' ? 'https://example.test/background' : 'https://example.test/active',
      domain: 'example.test',
      heading: 'Exact heading',
      selection: '',
      excerpt: 'Exact body',
      capturedAt: 1,
    }),
  } as unknown as BrowserController

  const exact = await resolveTrustedBrowserReference(controller, 'tab-background')
  assert.equal(exact?.environment.browserPageRef?.tabId, 'tab-background')
  assert.equal(exact?.context.excerpt, 'Exact body')

  let reads = 0
  const drifting = {
    ...controller,
    executeJS: async (tabId: string) => {
      reads += 1
      frameToken = reads === 1 ? 'document-v1' : 'document-v2'
      return {
        url: tabId === 'tab-background' ? 'https://example.test/background' : 'https://example.test/active',
        title: 'Background page',
        timeOrigin: 42,
        mutationRevision: 0,
        frameDocumentToken: frameToken,
      }
    },
  } as unknown as BrowserController
  assert.equal(await resolveTrustedBrowserReference(drifting, 'tab-background'), null)
})

test('hidden pointer preflight rejects without dispatching', async () => {
  const result = await requireTrustedPointerDelivery(
    controllerFor('hidden', { foreground: false, active: false }),
    'tab-a',
  )
  assert.ok(result)
  assert.equal(result.data?.ok, false)
  assert.equal(result.data?.dispatch, 'rejected')
  assert.equal(result.data?.delivery, 'not_delivered')
  assert.equal(result.data?.errorKind, 'browser_surface_required')
})

test('pointer delivery rejects when the readiness probe itself waits across a hide', async () => {
  const { dispatchTrustedPointer } = await import('../main/modules/tools/browser-input-actions')
  let presentation: 'visible' | 'hidden' = 'visible'
  let dispatched = 0
  const controller = {
    getBrowserInputEnvironment: () => ({
      mainWindowForeground: presentation === 'visible',
      hostPresentation: presentation,
      tabActive: presentation === 'visible',
    }),
    getPhysicalTargetToken: () => 'physical-tab-a',
    executeJS: async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      presentation = 'hidden'
      return { ready: true, focused: true, activeElementEditable: false }
    },
    dispatchMouse: async () => {
      dispatched += 1
    },
  } as unknown as BrowserController
  const blocked = await dispatchTrustedPointer(controller, 'tab-a', {
    type: 'mouseMoved',
    x: 1,
    y: 1,
    button: 'none',
    buttons: 0,
  })
  assert.ok(blocked)
  assert.equal(blocked.data?.ok, false)
  assert.equal(dispatched, 0)
})

function flippingDocumentController(): {
  controller: BrowserController
  dispatched: () => number
} {
  let frameToken = 'document-v1'
  let dispatched = 0
  return {
    dispatched: () => dispatched,
    controller: {
      getBrowserInputEnvironment: () => ({
        mainWindowForeground: true,
        hostPresentation: 'visible',
        tabActive: true,
      }),
      getPhysicalTargetToken: () => 'physical-tab-a',
      executeJS: async () => {
        const token = frameToken
        frameToken = 'document-v2'
        return {
          ready: true,
          focused: true,
          activeElementEditable: false,
          url: 'https://example.test',
          title: 'Example',
          timeOrigin: 1,
          mutationRevision: 0,
          frameDocumentToken: token,
        }
      },
      normalizedToCss: async () => ({ x: 12, y: 18, width: 120, height: 80 }),
      dispatchMouse: async () => {
        dispatched += 1
      },
      getTabList: () => [{ id: 'tab-a', url: 'https://example.test', title: 'Example', active: true }],
    } as unknown as BrowserController,
  }
}

const pinnedPageRef = {
  tabId: 'tab-a',
  physicalTargetToken: 'physical-tab-a',
  mainFrameDocumentToken: 'document-v1',
}

function actToolContext(controller: BrowserController) {
  return {
    controller,
    mutationBoundary: {
      invokeTransport: <T>(transport: () => T) => transport(),
      recordMechanicalFact: () => undefined,
      runSearchStep: async (_phase: string, run: () => Promise<unknown>) => run(),
    },
    attachBrowserToolOutput: <T>(value: T) => value,
    trustedPageRef: pinnedPageRef,
  }
}

test('click does not dispatch after the document generation changes during coordinate resolve', async () => {
  const { executeBrowserActTool } = await import('../main/modules/tools/browser-act-tools')
  const fixture = flippingDocumentController()
  const result = await executeBrowserActTool(
    'click_coordinate',
    { tab_id: 'tab-a', x: 500, y: 500 },
    actToolContext(fixture.controller),
  )
  const data = result && typeof result === 'object' ? result.data : null
  assert.equal(fixture.dispatched(), 0)
  assert.equal(data?.errorKind, 'browser_reference_stale')
})

test('click-then-type does not dispatch after the document generation changes during coordinate resolve', async () => {
  const { executeBrowserActTool } = await import('../main/modules/tools/browser-act-tools')
  const fixture = flippingDocumentController()
  const result = await executeBrowserActTool(
    'type_coordinate',
    { tab_id: 'tab-a', x: 500, y: 500, text: 'hello' },
    actToolContext(fixture.controller),
  )
  const data = result && typeof result === 'object' ? result.data : null
  assert.equal(fixture.dispatched(), 0)
  assert.equal(data?.errorKind, 'browser_reference_stale')
})

test('pointer delivery rejects when the document generation changes on the same tab', async () => {
  const { executeBrowserActTool } = await import('../main/modules/tools/browser-act-tools')
  const fixture = flippingDocumentController()
  const result = await executeBrowserActTool(
    'hover',
    { tab_id: 'tab-a', x: 500, y: 500 },
    actToolContext(fixture.controller),
  )
  const data = result && typeof result === 'object' ? result.data : null
  assert.equal(fixture.dispatched(), 0)
  assert.equal(data?.errorKind, 'browser_reference_stale')
})

test('collect_scroll does not dispatch after the pinned document generation changes', async () => {
  const { executeBrowserCollectionTool } = await import('../main/modules/tools/browser-collection-tools')
  const fixture = flippingDocumentController()
  let wheels = 0
  Object.assign(fixture.controller, {
    scrollCollect: async (
      _tabId: string | null,
      options: { beforeScroll?: () => Promise<void> },
    ) => {
      await options.beforeScroll?.()
      wheels += 1
      await fixture.controller.dispatchMouse('tab-a', { type: 'mouseWheel', x: 1, y: 1, deltaX: 0, deltaY: 1 })
      return { template: 'card_list', items: [], scrolls: wheels, reachedEnd: true }
    },
  })
  const result = await executeBrowserCollectionTool('collect_scroll', { tab_id: 'tab-a' }, {
    controller: fixture.controller,
    mutationBoundary: actToolContext(fixture.controller).mutationBoundary,
    taskExecutionContext: { trustedPageRef: pinnedPageRef },
  })
  const data = result && typeof result === 'object' ? result.data : null
  assert.equal(wheels, 0)
  assert.equal(fixture.dispatched(), 0)
  assert.equal(data?.errorKind, 'browser_reference_stale')
  assert.equal(data?.dispatch, 'rejected')
  assert.equal(data?.delivery, 'not_delivered')
  assert.equal(data?.mayHaveCommitted, false)
  assert.equal(data?.effect, 'not_applicable')
})

test('collect_scroll reports already sent wheels when later admission is withdrawn', async () => {
  const { executeBrowserCollectionTool } = await import('../main/modules/tools/browser-collection-tools')
  let writable = true
  let wheels = 0
  const controller = {
    getBrowserInputEnvironment: () => ({
      mainWindowForeground: true,
      hostPresentation: 'visible',
      tabActive: true,
    }),
    getPhysicalTargetToken: () => 'physical-tab-a',
    executeJS: async () => ({ ready: true, focused: true, activeElementEditable: false }),
    scrollCollect: async (
      _tabId: string | null,
      options: { beforeScroll?: () => Promise<void> },
    ) => {
      await options.beforeScroll?.()
      wheels += 1
      writable = false
      try {
        await options.beforeScroll?.()
      } catch (error) {
        if (error && typeof error === 'object') {
          (error as { dispatchedScrolls?: number }).dispatchedScrolls = wheels
        }
        throw error
      }
      return { template: 'card_list', items: [], scrolls: wheels, reachedEnd: true }
    },
  } as unknown as BrowserController
  const result = await executeBrowserCollectionTool('collect_scroll', { tab_id: 'tab-a' }, {
    controller,
    mutationBoundary: {
      invokeTransport: (transport) => {
        if (!writable) {
          throw Object.assign(new Error('browser_workflow_write_fenced'), {
            name: 'BrowserMutationFenceError',
          })
        }
        return transport()
      },
      recordMechanicalFact: () => undefined,
      runSearchStep: async (_phase, run) => run(),
    },
  })
  const data = result && typeof result === 'object' ? result.data : null
  assert.equal(wheels, 1)
  assert.equal(data?.errorKind, 'browser_workflow_write_fenced')
  assert.equal(data?.dispatch, 'accepted')
  assert.equal(data?.delivery, 'unknown')
  assert.equal(data?.mayHaveCommitted, true)
  assert.equal(data?.needsObservation, true)
  assert.equal(data?.dispatchedScrolls, 1)
  assert.equal(data?.effect, 'unknown')
  assert.notEqual(data?.effect, 'not_applicable')
})

test('press_key does not dispatch after the pinned document generation changes', async () => {
  const { executeBrowserActTool } = await import('../main/modules/tools/browser-act-tools')
  const fixture = flippingDocumentController()
  let keys = 0
  Object.assign(fixture.controller, {
    dispatchKey: async () => {
      keys += 1
    },
  })
  const result = await executeBrowserActTool(
    'press_key',
    { tab_id: 'tab-a', key: 'Enter' },
    actToolContext(fixture.controller),
  )
  const data = result && typeof result === 'object' ? result.data : null
  assert.equal(keys, 0)
  assert.equal(data?.errorKind, 'browser_reference_stale')
  assert.notEqual(data?.mayHaveCommitted, true)
})

test('press_key Enter that navigates on keydown is not settled as zero execution', async () => {
  const { executeBrowserActTool } = await import('../main/modules/tools/browser-act-tools')
  let frameToken = 'document-v1'
  let keys = 0
  const controller = {
    getBrowserInputEnvironment: () => ({
      mainWindowForeground: true,
      hostPresentation: 'visible',
      tabActive: true,
    }),
    getPhysicalTargetToken: () => 'physical-tab-a',
    executeJS: async () => ({
      ready: true,
      focused: true,
      activeElementEditable: true,
      url: frameToken === 'document-v1' ? 'https://example.test/form' : 'https://example.test/done',
      title: frameToken === 'document-v1' ? 'Form' : 'Done',
      timeOrigin: frameToken === 'document-v1' ? 1 : 2,
      mutationRevision: frameToken === 'document-v1' ? 0 : 1,
      frameDocumentToken: frameToken,
    }),
    dispatchKey: async () => {
      keys += 1
      frameToken = 'document-v2'
    },
    getTabList: () => [{ id: 'tab-a', url: 'https://example.test/form', title: 'Form', active: true }],
  } as unknown as BrowserController
  const result = await executeBrowserActTool(
    'press_key',
    { tab_id: 'tab-a', key: 'Enter' },
    actToolContext(controller),
  )
  const data = result && typeof result === 'object' ? result.data : null
  assert.equal(keys, 1)
  assert.equal(data?.ok, false)
  assert.equal(data?.errorKind, 'browser_reference_stale')
  assert.equal(data?.dispatch, 'accepted')
  assert.equal(data?.delivery, 'unknown')
  assert.equal(data?.effect, 'unknown')
  assert.equal(data?.mayHaveCommitted, true)
  assert.equal(data?.needsObservation, true)
  assert.equal(data?.dispatchedKeys, 1)
  assert.notEqual(data?.effect, 'not_applicable')
})

test('text and key sends refuse a successor document after a completed click', async () => {
  const {
    bindTrustedPointerExpected,
    dispatchTrustedText,
    sendKeyStroke,
    TrustedPointerBlockedError,
  } = await import('../main/modules/tools/browser-input-actions')
  let typed = 0
  let keys = 0
  const controller = {
    getBrowserInputEnvironment: () => ({
      mainWindowForeground: true,
      hostPresentation: 'visible',
      tabActive: true,
    }),
    getPhysicalTargetToken: () => 'physical-tab-a',
    executeJS: async () => ({
      ready: true,
      focused: true,
      activeElementEditable: true,
      url: 'https://example.test/v2',
      title: 'Successor',
      timeOrigin: 2,
      mutationRevision: 1,
      frameDocumentToken: 'document-v2',
    }),
    typeTextDirectly: async () => {
      typed += 1
    },
    dispatchKey: async () => {
      keys += 1
    },
  } as unknown as BrowserController
  const release = bindTrustedPointerExpected({
    physicalTargetToken: 'physical-tab-a',
    mainFrameDocumentToken: 'document-v1',
  })
  try {
    await assert.rejects(
      () => dispatchTrustedText(controller, 'tab-a', 'hello'),
      (error: unknown) => error instanceof TrustedPointerBlockedError
        && error.output.data?.errorKind === 'browser_reference_stale',
    )
    await assert.rejects(
      () => sendKeyStroke(controller, 'tab-a', 'Enter'),
      (error: unknown) => error instanceof TrustedPointerBlockedError
        && error.output.data?.errorKind === 'browser_reference_stale',
    )
    assert.equal(typed, 0)
    assert.equal(keys, 0)
  } finally {
    release()
  }
})

test('hover re-reads visibility after coordinate resolve and does not dispatch', async () => {
  const { executeBrowserActTool } = await import('../main/modules/tools/browser-act-tools')
  let presentation: 'visible' | 'hidden' = 'visible'
  let dispatched = 0
  const controller = {
    getBrowserInputEnvironment: () => ({
      mainWindowForeground: presentation === 'visible',
      hostPresentation: presentation,
      tabActive: presentation === 'visible',
    }),
    getPhysicalTargetToken: () => 'physical-tab-a',
    executeJS: async () => ({ ready: true, focused: true, activeElementEditable: false }),
    normalizedToCss: async () => {
      presentation = 'hidden'
      return { x: 12, y: 18, width: 120, height: 80 }
    },
    dispatchMouse: async () => {
      dispatched += 1
    },
    getTabList: () => [{ id: 'tab-a', url: 'https://example.test', title: 'Example', active: true }],
  } as unknown as BrowserController
  const result = await executeBrowserActTool('hover', { tab_id: 'tab-a', x: 500, y: 500 }, {
    controller,
    mutationBoundary: {
      invokeTransport: (transport) => transport(),
      recordMechanicalFact: () => undefined,
      runSearchStep: async (_phase, run) => run(),
    },
    attachBrowserToolOutput: (value) => value,
  })
  const data = result && typeof result === 'object' ? result.data : null
  assert.equal(dispatched, 0)
  assert.equal(data?.ok, false)
  assert.equal(data?.dispatch, 'rejected')
  assert.equal(data?.delivery, 'not_delivered')
})

test('collect_scroll re-reads visibility before later scrolls', async () => {
  const { executeBrowserCollectionTool } = await import('../main/modules/tools/browser-collection-tools')
  let presentation: 'visible' | 'hidden' = 'visible'
  let beforeScrolls = 0
  const controller = {
    getBrowserInputEnvironment: () => ({
      mainWindowForeground: presentation === 'visible',
      hostPresentation: presentation,
      tabActive: presentation === 'visible',
    }),
    getPhysicalTargetToken: () => 'physical-tab-a',
    executeJS: async () => ({ ready: true, focused: true, activeElementEditable: false }),
    scrollCollect: async (
      _tabId: string | null,
      options: { beforeScroll?: () => Promise<void> },
    ) => {
      await options.beforeScroll?.()
      beforeScrolls += 1
      presentation = 'hidden'
      await options.beforeScroll?.()
      beforeScrolls += 1
      return { template: 'card_list', items: [], scrolls: 1, reachedEnd: true }
    },
  } as unknown as BrowserController
  const result = await executeBrowserCollectionTool('collect_scroll', { tab_id: 'tab-a' }, {
    controller,
    mutationBoundary: {
      invokeTransport: (transport) => transport(),
      recordMechanicalFact: () => undefined,
      runSearchStep: async (_phase, run) => run(),
    },
  })
  const data = result && typeof result === 'object' ? result.data : null
  assert.equal(beforeScrolls, 1)
  assert.equal(data?.ok, false)
  assert.equal(data?.dispatch, 'rejected')
})
