import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { parseBrowserSnapshotRef } from '../main/modules/browser-engine/browser-snapshot-service'
import { browserOriginInteractionBudget } from '../main/modules/browser-engine/origin-interaction-budget'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { __resetBrowserAgentPageMapForTests } from '../main/modules/tools/browser-observe-tools'
import { executeBrowserTool as executeBrowserToolImpl } from '../main/modules/tools/browser-tools'

type ToolContext = NonNullable<Parameters<typeof executeBrowserToolImpl>[8]>

async function executeBrowserTool(...args: Parameters<typeof executeBrowserToolImpl>) {
  const current: ToolContext = args[8] || {}
  args[8] = {
    ownerRunId: 'run-browser-tools-test',
    browserTaskId: 'browser-workflow-tools-test',
    parentTaskId: 'parent-browser-tools-test',
    inputSource: 'trusted_internal',
    ...current,
  }
  return executeBrowserToolImpl(...args)
}

function parseTool(output: unknown): Record<string, any> {
  if (typeof output === 'string') return JSON.parse(output) as Record<string, any>
  if (output && typeof output === 'object') {
    const value = output as { data?: unknown; text?: unknown }
    if (value.data && typeof value.data === 'object') return value.data as Record<string, any>
    if (typeof value.text === 'string') return JSON.parse(value.text) as Record<string, any>
  }
  throw new Error(`Unexpected tool output: ${String(output)}`)
}

type MockController = BrowserController & {
  calls: {
    mouse: Array<Record<string, unknown>>
    keys: Array<Record<string, unknown>>
    typed: string[]
  }
}

function createControllerMock(overrides: Partial<BrowserController> = {}): MockController {
  const calls = {
    mouse: [] as Array<Record<string, unknown>>,
    keys: [] as Array<Record<string, unknown>>,
    typed: [] as string[],
  }
  let actionSequence = 0
  let observationSequence = 0

  const defaultExecuteJS: BrowserController['executeJS'] = async (_tabId, code) => {
    const source = String(code || '')
    if (source.includes('__READY_BLOCKING_CHALLENGE_PROBE__')) {
      return { blocked: false, blockerCount: 0, matchedKinds: [], pageError: false, emptyShell: false }
    }
    if (source.includes('__READY_AGENT_PAGE_MAP__')) {
      return {
        identity: { url: 'https://example.com/form', title: 'Example Form' },
        viewport: { width: 1000, height: 800 },
        bodyText: 'Query Search Search',
        rawRoots: [{
          role: 'generic',
          children: [
            { role: 'textbox', name: 'Query', backendDOMNodeId: 1, frameId: '0' },
            { role: 'button', name: 'Search', backendDOMNodeId: 2, frameId: '0' },
            { role: 'button', name: 'Search', backendDOMNodeId: 3, frameId: '0' },
          ],
        }],
        riskFlags: {},
        structureHints: { iframes: [], shadowRoots: [], hiddenLoaded: [] },
      }
    }
    if (source.includes('__readyBrowserTargetIdentityV3')) {
      return {
        url: '',
        title: '',
        timeOrigin: 1,
        mutationRevision: 0,
        frameDocumentToken: 'document-tab-1',
      }
    }
    if (source.includes('activeElementEditable') && source.includes('document.hasFocus')) {
      return { ready: true, focused: true, activeElementEditable: true }
    }
    if (source.includes('__READY_FOCUSED_EDITABLE_PROBE__')) {
      return { kind: 'editable', tag: 'input', label: 'Query', maxLength: 200, singleLine: true }
    }
    if (source.includes('__READY_TYPED_INTO_PROBE__')) {
      const text = calls.typed.at(-1) || ''
      return { tag: 'input', label: 'Query', textHead: text, textLength: text.length, textMatchesExpected: true }
    }
    if (source.includes('changed: after !== state.before') && source.includes('__readyTextDeliveryProbe')) {
      return { count: 1, changed: true }
    }
    if (source.includes('globalThis.__readyTextDeliveryProbe = state')) return 'text-probe'
    if (source.includes('keydown: Number') && source.includes('__readySubmitDeliveryProbe')) {
      return { keydown: 1, submit: 0 }
    }
    if (source.includes('globalThis[key] = state') && source.includes('__readySubmitDeliveryProbe')) return 'submit-probe'
    if (source.includes('return Number(state.count') && source.includes('__readyKeyDeliveryProbe')) return 1
    if (source.includes('globalThis.__readyKeyDeliveryProbe = state')) return 'key-probe'
    if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
      return { label: '', inputLabel: 'Query', password: false, editable: true, tag: 'input' }
    }
    if (source.includes("document.readyState === 'interactive'")) return true
    if (source.includes('readyState') && source.includes('bodyTextLen')) {
      return { readyState: 'complete', bodyTextLen: 100, matched: true }
    }
    if (source.includes('window.location.href')) return 'https://example.com/form'
    return null
  }

  const controller = {
    calls,
    getActiveTab: () => ({ id: 'tab-1', title: 'Example Form', url: 'https://example.com/form', active: true }),
    getTabList: () => [{ id: 'tab-1', title: 'Example Form', url: 'https://example.com/form', active: true }],
    getPhysicalTargetToken: () => 'physical-tab-1',
    getBrowserInputEnvironment: () => ({
      mainWindowForeground: true,
      hostPresentation: 'visible' as const,
      tabActive: true,
    }),
    beginBrowserWorkflowAction: (input: Parameters<BrowserController['beginBrowserWorkflowAction']>[0]) => {
      actionSequence += 1
      return {
        actionId: `action-${actionSequence}`,
        actionSeq: actionSequence,
        identity: input.identity,
        ...(input.searchActionId ? { searchActionId: input.searchActionId } : {}),
      }
    },
    settleBrowserWorkflowAction: (_taskId: string, actionId: string, outcome: Parameters<BrowserController['settleBrowserWorkflowAction']>[2]) => ({
      receiptId: `receipt-${actionId}`,
      outcome,
    }),
    recordBrowserWorkflowObservation: (input: Parameters<BrowserController['recordBrowserWorkflowObservation']>[0]) => {
      observationSequence += 1
      return {
        receiptId: `observation-${observationSequence}`,
        observationSeq: observationSequence,
        operationId: input.operationId,
        ownerRunId: input.ownerRunId,
        observedAfterActionSeq: actionSequence,
        identity: input.identity,
        searchActionId: null,
        queryDigest: null,
        causalActions: [],
        resultDigest: input.resultDigest,
        observedAt: new Date(0).toISOString(),
      }
    },
    executeJS: defaultExecuteJS,
    callFunctionOnBackendNode: async (_tabId: string | null, _backendNodeId: number, _declaration: string, args: unknown[]) => {
      const operation = String(args[0] || 'probe')
      if (operation === 'focus') return { ok: true, kind: 'editable', tag: 'input', label: 'Query' }
      if (operation === 'select_all') return { ok: true, kind: 'text_control' }
      if (operation === 'read') return { matchCount: 1, content: calls.typed.at(-1) || 'Query' }
      return {
        matchCount: 1,
        disabled: false,
        target: {
          role: 'textbox',
          name: 'Query',
          editable: true,
          enabled: true,
          visible: true,
          box: { x: 100, y: 100, width: 300, height: 40 },
        },
        clickPoint: { x: 250, y: 120, vw: 1000, vh: 800 },
      }
    },
    normalizedToCss: async () => ({ x: 250, y: 120, width: 1000, height: 800 }),
    dispatchMouse: async (_tabId: string | null, payload: unknown) => {
      calls.mouse.push(payload as Record<string, unknown>)
    },
    dispatchKey: async (_tabId: string | null, payload: unknown) => {
      calls.keys.push(payload as Record<string, unknown>)
    },
    typeTextDirectly: async (_tabId: string | null, text: string) => {
      calls.typed.push(text)
    },
    getViewportMetrics: async () => ({ width: 1000, height: 800, pageX: 0, pageY: 0, scale: 1 }),
    screenshotAdvanced: async () => 'base64-image',
  } as unknown as MockController

  Object.assign(controller, overrides)
  if (overrides.executeJS) {
    const override = overrides.executeJS
    controller.executeJS = async (tabId, code) => {
      const value = await override(tabId, code)
      return value === null || value === undefined ? defaultExecuteJS(tabId, code) : value
    }
  }
  return controller
}

beforeEach(() => {
  __resetBrowserAgentPageMapForTests()
  browserOriginInteractionBudget.resetForTests()
})

afterEach(() => {
  __resetBrowserAgentPageMapForTests()
  browserOriginInteractionBudget.resetForTests()
})

describe('browser semantic tool facade', () => {
  it('navigation and keys do not require a public snapshot before their first action', async () => {
    let navigated = 0
    const controller = createControllerMock({ navigate: async () => { navigated += 1; return { success: true } } })
    const navigation = parseTool(await executeBrowserTool('browser_navigate', { url: 'https://example.test/new' }, controller))
    assert.equal(navigated, 1, JSON.stringify(navigation))
    assert.notEqual(navigation.ok, false)
    const freshController = createControllerMock()
    const key = parseTool(await executeBrowserTool('browser_press_key', { key: 'Enter' }, freshController))
    assert.equal(key.ok, true, JSON.stringify(key))
    assert.equal(key.delivery, 'delivered')
    assert.ok(freshController.calls.keys.length > 0)
  })
  it('opens a routed browser workflow in its task-owned background tab', async () => {
    const calls: string[] = []
    const controller = createControllerMock({
      createAgentWorkTab: async (browserTaskId, url, openerTabId) => {
        calls.push(`create:${browserTaskId}:${url}:${openerTabId}`)
        return { success: true, tabId: 'agent-weather-tab' }
      },
      waitForCondition: async () => ({ matched: true, elapsedMs: 0 }),
      getAgentWorkTab: () => 'agent-weather-tab',
      createTab: async () => {
        calls.push('create-visible-tab')
        return { success: true, tabId: 'visible-tab' }
      },
      switchTab: () => { throw new Error('must not switch the foreground tab') },
      getTabList: () => [{
        id: 'agent-weather-tab',
        title: 'Weather',
        url: 'https://example.test/weather',
        active: false,
        owner: 'agent',
      }],
      getPhysicalTargetToken: () => 'physical-agent-weather',
    })

    const opened = parseTool(await executeBrowserTool('browser_tabs', {
      action: 'open',
      url: 'https://example.test/weather',
    }, controller))

    assert.equal(opened.success, true)
    assert.equal(opened.tabId, 'agent-weather-tab')
    assert.equal(opened.outcome.postActionTabId, 'agent-weather-tab')
    assert.deepEqual(calls, [
      'create:browser-workflow-tools-test:https://example.test/weather:',
    ])
    assert.equal(controller.getActiveTab()?.id, 'tab-1')
  })

  it('returns opaque, current-document target references and ambiguity groups', async () => {
    const controller = createControllerMock()
    const snapshot = parseTool(await executeBrowserTool('browser_snapshot', {}, controller))
    const targets = snapshot.pageMap.targets as Array<{ targetId: string; name: string }>

    assert.equal(snapshot.pageIdentity.title, 'Example Form')
    assert.equal(targets.length, 3)
    assert.equal(parseBrowserSnapshotRef(targets[0]!.targetId)?.rawTargetId, '1:0:b1')
    assert.equal(snapshot.pageMap.structureHints, undefined)
    assert.deepEqual(
      snapshot.ambiguityGroups[0].targetIds.map((id: string) => parseBrowserSnapshotRef(id)?.rawTargetId),
      ['1:0:b2', '1:0:b3'],
    )

    const found = parseTool(await executeBrowserTool('browser_find', {
      query: 'Query',
      role: 'textbox',
      purpose: 'input',
      limit: 1,
    }, controller))
    assert.equal(found.ok, true)
    assert.equal(found.total, 1)
    assert.equal(found.unique, true)
    assert.equal(found.matches[0].targetId, targets[0]!.targetId)
  })

  it('uses the only editable current-site search target without reading its language', async () => {
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        const source = String(code || '')
        if (!source.includes('__READY_AGENT_PAGE_MAP__')) return null
        return {
          identity: { url: 'https://example.com/home', title: '資料庫' },
          viewport: { width: 1000, height: 800 },
          rawRoots: [{
            role: 'generic',
            children: [
              { role: 'textbox', name: '語句を入力', backendDOMNodeId: 1, frameId: '0' },
              { role: 'button', name: 'A', backendDOMNodeId: 2, frameId: '0' },
            ],
          }],
          riskFlags: {},
        }
      },
      callFunctionOnBackendNode: async (_tabId, _backendNodeId, _declaration, args) => {
        if (String(args[0]) === 'focus') return { ok: true, kind: 'editable', tag: 'input', label: '語句を入力' }
        if (String(args[0]) === 'select_all') return { ok: true, kind: 'text_control' }
        return {
          matchCount: 1,
          disabled: false,
          target: {
            role: 'textbox', name: '語句を入力', editable: true, enabled: true, visible: true,
            box: { x: 100, y: 100, width: 300, height: 40 },
          },
          clickPoint: { x: 250, y: 120, vw: 1000, vh: 800 },
        }
      },
    })

    const result = parseTool(await executeBrowserTool('browser_search', {
      query: '北欧家具',
      scope: 'current_site',
      tab_id: 'tab-1',
    }, controller))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.searchTarget.name, '語句を入力')
    assert.equal(controller.calls.typed.at(-1), '北欧家具')
  })

  it('fills and submits an exact form on an attached parked browser surface', async () => {
    const formAction = 'https://example.com/search'
    const controller = createControllerMock({
      getBrowserInputEnvironment: () => ({
        mainWindowForeground: true,
        hostPresentation: 'hidden',
        tabActive: false,
      }),
      getViewportMetrics: async () => ({ width: 0, height: 0, pageX: 0, pageY: 0, scale: 1 }),
      executeJS: async (_tabId, code) => {
        if (!String(code || '').includes('__READY_AGENT_PAGE_MAP__')) return null
        return {
          identity: { url: 'https://example.com/search', title: 'Archive' },
          viewport: { width: 0, height: 0 },
          rawRoots: [{
            role: 'generic',
            children: [
              {
                role: 'searchbox',
                name: 'Archive query',
                backendDOMNodeId: 1,
                frameId: '0',
                box: { x: 20, y: 30, width: 320, height: 44 },
                rendered: true,
                visible: false,
                editable: true,
                inputType: 'search',
                formAction,
              },
              {
                role: 'button',
                name: 'Run search',
                backendDOMNodeId: 2,
                frameId: '0',
                box: { x: 350, y: 30, width: 80, height: 44 },
                rendered: true,
                visible: false,
                editable: false,
                formAction,
              },
            ],
          }],
          riskFlags: {},
        }
      },
      callFunctionOnBackendNode: async (_tabId, _backendNodeId, _declaration, args) => {
        const operation = String(args[0] || 'probe')
        if (operation === 'focus') return { ok: true, kind: 'editable', tag: 'input', label: 'Archive query' }
        if (operation === 'select_all') return { ok: true, kind: 'text_control' }
        if (operation === 'submit') {
          return { ok: true, submitted: true, delivery: 'delivered', submitCount: 1, trustedSubmitCount: 1 }
        }
        return {
          matchCount: 1,
          disabled: false,
          target: {
            role: 'searchbox',
            name: 'Archive query',
            editable: true,
            enabled: true,
            rendered: true,
            visible: false,
            inputType: 'search',
            formAction,
            box: { x: 20, y: 30, width: 320, height: 44 },
          },
          clickPoint: { x: 180, y: 52, vw: 0, vh: 0 },
        }
      },
    })

    const snapshot = parseTool(await executeBrowserTool('browser_snapshot', {
      tab_id: 'tab-1',
    }, controller))
    const snapshotTargets = snapshot.pageMap.targets as Array<{ targetId: string; role: string }>
    const result = parseTool(await executeBrowserTool('browser_search', {
      query: 'atlante verde',
      scope: 'current_site',
      tab_id: 'tab-1',
      input_target_id: snapshotTargets.find((target) => target.role === 'searchbox')?.targetId,
      submit_target_id: snapshotTargets.find((target) => target.role === 'button')?.targetId,
    }, controller))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.submitted, true)
    assert.equal(result.delivery, 'delivered')
    assert.deepEqual(controller.calls.typed, ['atlante verde'])
    assert.equal(controller.calls.mouse.length, 0)
    assert.equal(controller.calls.keys.length, 0)
  })

  it('returns all structural search candidates and performs no write when the page is ambiguous', async () => {
    const controller = createControllerMock({
      executeJS: async (_tabId, code) => {
        if (!String(code || '').includes('__READY_AGENT_PAGE_MAP__')) return null
        return {
          identity: { url: 'https://example.com/home', title: 'Form' },
          viewport: { width: 1000, height: 800 },
          rawRoots: [{
            role: 'generic',
            children: [
              { role: 'textbox', name: 'Primo', backendDOMNodeId: 1, frameId: '0' },
              { role: 'textbox', name: 'Secondo', backendDOMNodeId: 2, frameId: '0' },
            ],
          }],
          riskFlags: {},
        }
      },
    })

    const result = parseTool(await executeBrowserTool('browser_search', {
      query: 'fixture', scope: 'current_site', tab_id: 'tab-1',
    }, controller))

    assert.equal(result.ok, false)
    assert.equal(result.errorKind, 'search_input_target_ambiguous')
    assert.equal(result.count, 2)
    assert.equal(result.writesPerformed, 0)
    assert.equal(controller.calls.typed.length, 0)
  })

  it('returns recovery guidance for a hidden zero-sized viewport', async () => {
    const controller = createControllerMock({
      getViewportMetrics: async () => ({ width: 0, height: 0, pageX: 0, pageY: 0, scale: 1 }),
    })
    const result = parseTool(await executeBrowserTool('browser_screenshot', {}, controller))
    assert.equal(result.warning, 'viewport_zero_or_hidden')
    assert.match(String(result.nextSuggestedAction || ''), /browser_cdp/)
  })

  it('delegates structured collection to the browser capability layer', async () => {
    const controller = createControllerMock({
      extractStructured: async () => ({
        items: [{ sourceUrl: 'https://example.com/feed', title: 'First post' }],
        template: 'article_list',
      }),
    })
    const result = parseTool(await executeBrowserTool('browser_collect', {
      mode: 'structured', template: 'article_list',
    }, controller))
    assert.equal(result.result.items.length, 1)
    assert.equal(result.result.items[0].title, 'First post')
  })

  it('reads result and status from the same durable browser task', async () => {
    let reads = 0
    const controller = createControllerMock({
      getTask: async (taskId) => {
        reads += 1
        return {
          taskId,
          kind: 'download_urls',
          status: 'completed',
          progress: { total: 1, completed: 1, failed: 0, currentLabel: null },
          result: { files: ['/tmp/file.bin'] },
        } as never
      },
    })

    const status = parseTool(await executeBrowserTool('browser_task', {
      action: 'get', task_id: 'browser-task-1',
    }, controller))
    const result = parseTool(await executeBrowserTool('browser_task', {
      action: 'result', task_id: 'browser-task-1',
    }, controller))

    assert.equal(status.status, 'completed')
    assert.deepEqual(result.result.files, ['/tmp/file.bin'])
    assert.equal(reads, 2)
  })

  it('reports a non-browser task id after the durable browser store has no match', async () => {
    let reads = 0
    const controller = createControllerMock({
      getTask: async () => {
        reads += 1
        return null
      },
    })
    const result = parseTool(await executeBrowserTool('browser_task', {
      action: 'result', task_id: 'skill-child:fixture',
    }, controller))
    assert.equal(result.status, 'wrong_id_type')
    assert.equal(reads, 1)
  })
})
