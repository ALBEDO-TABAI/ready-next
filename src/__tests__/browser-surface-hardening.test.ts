import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { BrowserActionExecutor, type BrowserWorkflowJournalPort } from '../main/modules/tools/browser-action-executor'
import { browserMutationController } from '../main/modules/tools/browser-mutation-controller'
import { executeBrowserActTool } from '../main/modules/tools/browser-act-tools'
import { AgentRepository } from '../main/modules/repositories/agent-repository'
import type { BrowserActionOutcome } from '../shared/browser-action-outcome'
import { BrowserAutomationService } from '../main/modules/browser-engine/automation-service'

const PINNED = {
  tabId: 'tab-a',
  physicalTargetToken: 'physical-tab-a',
  mainFrameDocumentToken: 'document-v1',
}

function outputData(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, unknown> } catch { return {} }
  }
  const output = value as { data?: Record<string, unknown>; text?: string }
  if (output.data) return output.data
  try { return JSON.parse(String(output.text || '{}')) as Record<string, unknown> } catch { return {} }
}

function journal(): BrowserWorkflowJournalPort & { outcomes: BrowserActionOutcome[] } {
  let sequence = 0
  const outcomes: BrowserActionOutcome[] = []
  return {
    taskId: 'browser-workflow-1',
    ownerRunId: 'run-1',
    outcomes,
    beginAction(input) {
      sequence += 1
      return {
        actionId: `action-${sequence}`,
        actionSeq: sequence,
        identity: input.identity,
      }
    },
    settleAction(_actionId, outcome) {
      outcomes.push(outcome)
      return { receiptId: `receipt-${_actionId}`, outcome }
    },
    recordObservation() {
      return {
        receiptId: 'obs-1',
        observationSeq: 1,
        operationId: 'click_coordinate',
        ownerRunId: 'run-1',
        observedAfterActionSeq: 1,
        identity: {
          documentState: 'document',
          tabId: 'tab-a',
          physicalTargetToken: 'physical-tab-a',
          frameId: '0',
          frameDocumentToken: 'document-v1',
          targetRef: null,
        },
        searchActionId: null,
        queryDigest: null,
        causalActions: [],
        resultDigest: 'x',
        observedAt: new Date().toISOString(),
      }
    },
  }
}

function identityFor(token: string) {
  return {
    documentState: 'document' as const,
    tabId: 'tab-a',
    physicalTargetToken: 'physical-tab-a',
    frameId: '0',
    frameDocumentToken: token,
    targetRef: null,
  }
}

test('every keyboard dispatch emulates target focus, including shortcuts after a focused-document probe', async () => {
  const commands: Array<[string, unknown]> = []
  const service = new BrowserAutomationService({
    resolveTabView: () => ({ tabId: 'hidden', tab: { id: 'hidden', url: '', title: '' }, view: {} as never }),
    createBrowserError: (_code, message) => new Error(message),
    getViewBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    cdpSession: { sendCommand: async (_tabId: string, method: string, params: unknown) => {
      commands.push([method, params])
      return {}
    } } as never,
  })
  await service.dispatchKey('hidden', { type: 'keyDown', key: 's', code: 'KeyS', modifiers: 4 })
  assert.deepEqual(commands.map(([method]) => method), [
    // The page round trip sits between the emulation and the key: the key must not overtake the focus change.
    'Emulation.setFocusEmulationEnabled', 'Runtime.evaluate', 'Input.dispatchKeyEvent', 'Emulation.setFocusEmulationEnabled',
  ])
  assert.deepEqual(commands[0][1], { enabled: true })
  assert.deepEqual(commands[3][1], { enabled: false })
})

function pointerController(options: {
  flipAfter?: 'mouseMoved' | 'mousePressed'
  throwOn?: 'mouseMoved' | 'mousePressed'
  hidden?: boolean
}): { controller: BrowserController; mouse: string[] } {
  let token = 'document-v1'
  const mouse: string[] = []
  const controller = {
    getBrowserInputEnvironment: () => ({
      mainWindowForeground: !options.hidden,
      hostPresentation: options.hidden ? 'hidden' : 'visible',
      tabActive: !options.hidden,
    }),
    getPhysicalTargetToken: () => 'physical-tab-a',
    normalizedToCss: async (_tabId: string | null, x: number, y: number) => ({
      x: x / 2,
      y: y / 2,
      width: 500,
      height: 500,
    }),
    getTabList: () => [],
    executeJS: async (_tabId: string | null, script: string) => {
      if (script.includes('__readyClickDeliveryProbe') && script.includes("const token = 'click-'")) return 'click-token'
      if (script.includes('__readyClickDeliveryProbe') && script.includes('Number(state.count')) return 0
      if (script.includes('activeElementEditable') || script.includes('document.readyState')) {
        return { ready: true, focused: true, activeElementEditable: false }
      }
      if (script.includes('frameDocumentToken') || script.includes('__readyBrowserTargetIdentityV3')) {
        return {
          url: 'https://example.test',
          title: 'Example',
          timeOrigin: 1,
          mutationRevision: 0,
          frameDocumentToken: token,
        }
      }
      return { label: 'Go', tag: 'a', editable: false, url: 'https://example.test' }
    },
    dispatchMouse: async (_tabId: string | null, event: { type?: string }) => {
      const type = String(event.type || '')
      mouse.push(type)
      if (options.throwOn && type === options.throwOn) throw new Error('CDP_COMMAND_FAILED')
      if (options.flipAfter && type === options.flipAfter) token = 'document-v2'
    },
  } as unknown as BrowserController
  return { controller, mouse }
}

async function runAct(toolName: string, args: Record<string, unknown>, controller: BrowserController, sessionId?: string) {
  const port = journal()
  const result = await new BrowserActionExecutor().execute({
    toolName,
    args,
    journal: port,
    trustedPageRef: PINNED,
    resolveTargetIdentity: () => identityFor(PINNED.mainFrameDocumentToken),
    dispatch: async (invocation, signal, boundary) => {
      const guarded = browserMutationController(controller, invocation.operation, boundary)
      return executeBrowserActTool(invocation.operation, invocation.args, {
        controller: guarded,
        abortSignal: signal,
        mutationBoundary: boundary,
        attachBrowserToolOutput: (value) => value,
        trustedPageRef: PINNED,
        sessionId,
      })
    },
  })
  const data = outputData(result)
  const outcome = (data.browserActionOutcome || port.outcomes[0] || null) as BrowserActionOutcome | null
  return { data, outcome, port }
}

test('click after move but before press stays zero in public and durable results', async () => {
  const { controller, mouse } = pointerController({ flipAfter: 'mouseMoved' })
  const { data, outcome } = await runAct('browser_click', { tab_id: 'tab-a', x: 500, y: 500 }, controller)
  assert.deepEqual(mouse, ['mouseMoved'])
  assert.equal(data.dispatch, 'rejected')
  assert.equal(data.delivery, 'not_delivered')
  assert.equal(data.mayHaveCommitted, false)
  assert.equal(outcome?.dispatch, 'rejected')
  assert.equal(outcome?.delivery, 'not_delivered')
  assert.equal(outcome?.mayHaveCommitted, false)
})

test('click after press cannot settle as zero execution in public or durable results', async () => {
  const { controller, mouse } = pointerController({ flipAfter: 'mousePressed' })
  const { data, outcome } = await runAct('browser_click', { tab_id: 'tab-a', x: 500, y: 500 }, controller)
  assert.deepEqual(mouse, ['mouseMoved', 'mousePressed'])
  assert.equal(data.dispatch, 'accepted')
  assert.equal(data.delivery, 'unknown')
  assert.equal(data.mayHaveCommitted, true)
  assert.equal(data.needsObservation, true)
  assert.equal(outcome?.dispatch, 'accepted')
  assert.equal(outcome?.delivery, 'unknown')
  assert.equal(outcome?.mayHaveCommitted, true)
})

test('drag typed denial before press is not durable committed', async () => {
  const { controller, mouse } = pointerController({ hidden: true })
  const { data, outcome } = await runAct('browser_drag', {
    tab_id: 'tab-a',
    source_x: 100,
    source_y: 100,
    target_x: 400,
    target_y: 400,
  }, controller)
  assert.equal(mouse.includes('mousePressed'), false)
  assert.equal(data.dispatch, 'rejected')
  assert.equal(data.delivery, 'not_delivered')
  assert.equal(data.mayHaveCommitted, false)
  if (outcome) {
    assert.equal(outcome.mayHaveCommitted, false)
    assert.equal(outcome.delivery, 'not_delivered')
  }
})

test('drag transport failure before press is not durable committed', async () => {
  const { controller, mouse } = pointerController({ throwOn: 'mouseMoved' })
  const { data, outcome } = await runAct('browser_drag', {
    tab_id: 'tab-a',
    source_x: 100,
    source_y: 100,
    target_x: 400,
    target_y: 400,
  }, controller)
  assert.deepEqual(mouse, ['mouseMoved'])
  assert.equal(data.mayHaveCommitted, false)
  assert.equal(outcome?.mayHaveCommitted, false)
  assert.equal(outcome?.delivery, 'not_delivered')
})

test('drag press transport unknown stays unknown and committed', async () => {
  const { controller, mouse } = pointerController({ throwOn: 'mousePressed' })
  const { data, outcome } = await runAct('browser_drag', {
    tab_id: 'tab-a',
    source_x: 100,
    source_y: 100,
    target_x: 400,
    target_y: 400,
  }, controller)
  assert.deepEqual(mouse, ['mouseMoved', 'mousePressed'])
  assert.equal(data.dispatch, 'accepted')
  assert.equal(data.delivery, 'unknown')
  assert.equal(data.mayHaveCommitted, true)
  assert.equal(outcome?.dispatch, 'accepted')
  assert.equal(outcome?.delivery, 'unknown')
  assert.equal(outcome?.mayHaveCommitted, true)
})

test('drag after press does not release on a successor document', async () => {
  const { controller, mouse } = pointerController({ flipAfter: 'mousePressed' })
  const { data, outcome } = await runAct('browser_drag', {
    tab_id: 'tab-a',
    source_x: 100,
    source_y: 100,
    target_x: 400,
    target_y: 400,
  }, controller)
  assert.equal(mouse[0], 'mouseMoved')
  assert.equal(mouse[1], 'mousePressed')
  assert.equal(mouse.includes('mouseReleased'), false)
  assert.equal(data.mayHaveCommitted, true)
  assert.equal(outcome?.mayHaveCommitted, true)
  assert.equal(outcome?.delivery, 'unknown')
})

function installAttachmentStub() {
  const dir = mkdtempSync(join(tmpdir(), 'ready-upload-'))
  const filePath = join(dir, 'poster.png')
  writeFileSync(filePath, 'png')
  const original = AgentRepository.prototype.listConversationAttachments
  AgentRepository.prototype.listConversationAttachments = async () => [{
    attachment_id: 'att-1',
    conversation_id: 'scope-1',
    source_message_id: 'm-1',
    name: 'poster.png',
    path: filePath,
    type: 'image',
    size: 3,
    ext: 'png',
    url: null,
    mime_type: 'image/png',
    remote_id: null,
    channel_id: null,
    thread_key: null,
    created_at: new Date().toISOString(),
  }]
  return () => {
    AgentRepository.prototype.listConversationAttachments = original
  }
}

test('upload selector on a successor document does not assign files', async () => {
  const restore = installAttachmentStub()
  try {
    let assigned = 0
    const controller = {
      getBrowserInputEnvironment: () => ({
        mainWindowForeground: true,
        hostPresentation: 'visible',
        tabActive: true,
      }),
      getPhysicalTargetToken: () => 'physical-tab-a',
      getTabList: () => [{ id: 'tab-a', url: 'https://example.test', title: 'Example', active: true }],
      findUploadTargets: async () => [],
      executeJS: async () => ({
        url: 'https://example.test/next',
        title: 'Next',
        timeOrigin: 2,
        mutationRevision: 1,
        frameDocumentToken: 'document-v2',
      }),
      setFileInputFiles: async () => {
        assigned += 1
        return { ok: true, targetDescription: 'file', inputFound: true, filesAssigned: true, assignedFileNames: ['poster.png'] }
      },
    } as unknown as BrowserController
    const { data, outcome } = await runAct(
      'browser_upload',
      { tab_id: 'tab-a', selector: 'input[type="file"]', attachment_id: 'att-1' },
      controller,
      'scope-1',
    )
    assert.equal(assigned, 0)
    assert.equal(data.dispatch, 'rejected')
    assert.equal(data.delivery, 'not_delivered')
    assert.equal(data.mayHaveCommitted, false)
    if (outcome) {
      assert.equal(outcome.delivery, 'not_delivered')
      assert.equal(outcome.mayHaveCommitted, false)
    }
  } finally {
    restore()
  }
})

test('upload selector on the same document still assigns without a snapshot map', async () => {
  const restore = installAttachmentStub()
  try {
    const payloads: Array<Record<string, unknown>> = []
    const controller = {
      getBrowserInputEnvironment: () => ({
        mainWindowForeground: true,
        hostPresentation: 'visible',
        tabActive: true,
      }),
      getPhysicalTargetToken: () => 'physical-tab-a',
      getTabList: () => [{ id: 'tab-a', url: 'https://example.test', title: 'Example', active: true }],
      findUploadTargets: async () => [],
      executeJS: async () => ({
        url: 'https://example.test',
        title: 'Example',
        timeOrigin: 1,
        mutationRevision: 0,
        frameDocumentToken: 'document-v1',
      }),
      setFileInputFiles: async (_tabId: string | null, payload: Record<string, unknown>) => {
        payloads.push(payload)
        return {
          ok: true,
          targetDescription: 'file',
          inputFound: true,
          filesAssigned: true,
          assignedFileNames: ['poster.png'],
        }
      },
    } as unknown as BrowserController
    const { data, outcome } = await runAct(
      'browser_upload',
      { tab_id: 'tab-a', selector: 'input[type="file"]', attachment_id: 'att-1' },
      controller,
      'scope-1',
    )
    assert.equal(payloads.length, 1)
    assert.equal(payloads[0]?.frameDocumentToken, 'document-v1')
    assert.equal(data.ok, true)
    assert.equal(outcome?.delivery, 'delivered')
    assert.equal(data.effect, 'target_value')
    assert.equal(outcome?.effect, 'observed')
  } finally {
    restore()
  }
})

test('upload name mismatch is not recorded as durable delivered', async () => {
  const restore = installAttachmentStub()
  try {
    const controller = {
      getBrowserInputEnvironment: () => ({
        mainWindowForeground: true,
        hostPresentation: 'visible',
        tabActive: true,
      }),
      getPhysicalTargetToken: () => 'physical-tab-a',
      getTabList: () => [{ id: 'tab-a', url: 'https://example.test', title: 'Example', active: true }],
      findUploadTargets: async () => [],
      executeJS: async () => ({
        url: 'https://example.test',
        title: 'Example',
        timeOrigin: 1,
        mutationRevision: 0,
        frameDocumentToken: 'document-v1',
      }),
      setFileInputFiles: async () => ({
        ok: true,
        targetDescription: 'file',
        inputFound: true,
        filesAssigned: true,
        assignedFileNames: ['other.png'],
      }),
    } as unknown as BrowserController
    const { data, outcome } = await runAct(
      'browser_upload',
      { tab_id: 'tab-a', selector: 'input[type="file"]', attachment_id: 'att-1' },
      controller,
      'scope-1',
    )
    assert.equal(data.ok, false)
    assert.notEqual(outcome?.delivery, 'delivered')
    assert.equal(outcome?.delivery, 'unknown')
    assert.equal(outcome?.mayHaveCommitted, true)
    assert.notEqual(outcome?.effect, 'target_value')
  } finally {
    restore()
  }
})

function makeUploadService(options: {
  documentToken: string
  expectedToken?: string
  hasSnapshotNodes?: boolean
}) {
  const cdp: string[] = []
  const marks: unknown[] = []
  const fileInput = {
    type: 'file',
    files: [],
    attrs: {} as Record<string, string>,
    setAttribute(name: string, value: string) { this.attrs[name] = value },
    getAttribute(name: string) { return this.attrs[name] || '' },
    removeAttribute(name: string) { delete this.attrs[name] },
    closest() { return null },
  }
  const pageDocument = {
    querySelector: (sel: string) => {
      if (sel.startsWith('[data-ready-upload-target') || sel === 'input[type="file"]') return fileInput
      return null
    },
    querySelectorAll: () => [],
  }
  const identityState = {
    document: pageDocument,
    documentToken: options.documentToken,
    nextTargetSequence: 1,
    nodesByToken: new Map(options.hasSnapshotNodes ? [['node-1', fileInput]] : []),
    tokenByNode: new WeakMap(),
  }
  const globalThisValue: Record<string, unknown> = {
    __readyBrowserTargetIdentityV3: identityState,
  }
  const host = {
    resolveTabView: () => ({
      tabId: 'tab-1',
      tab: { id: 'tab-1', url: 'https://example.test', title: 'T' },
      view: {
        webContents: {
          executeJavaScript: async (code: string) => {
            class HTMLInputElement {}
            class HTMLLabelElement {}
            class HTMLElement {}
            Object.setPrototypeOf(fileInput, HTMLInputElement.prototype)
            const fn = new Function(
              'document',
              'HTMLInputElement',
              'HTMLLabelElement',
              'HTMLElement',
              'globalThis',
              `return (${code.trim()})`,
            )
            try {
              const marked = fn(pageDocument, HTMLInputElement, HTMLLabelElement, HTMLElement, globalThisValue)
              marks.push(marked)
              return marked
            } catch (error) {
              marks.push(String(error))
              throw Object.assign(error instanceof Error ? error : new Error(String(error)), { evalCodeHead: code.slice(0, 200) })
            }
          },
          debugger: {
            isAttached: () => true,
            attach: () => undefined,
            sendCommand: async (method: string) => {
              cdp.push(method)
              if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
              if (method === 'DOM.querySelector') return { nodeId: 2 }
              return {}
            },
          },
        },
      },
    }),
    createBrowserError: (_code: string, message: string) => new Error(message),
    getViewBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
  }
  return { service: new BrowserAutomationService(host as never), cdp, marks, globalThisValue }
}

test('automation marker rejects selector assignment on a successor document token', async () => {
  const { service, cdp } = makeUploadService({ documentToken: 'document-v2', hasSnapshotNodes: true })
  const result = await service.setFileInputFiles('tab-1', {
    files: ['/tmp/poster.png'],
    selector: 'input[type="file"]',
    frameDocumentToken: 'document-v1',
  })
  assert.equal(result.ok, false)
  assert.equal(result.inputFound, false)
  assert.equal(cdp.includes('DOM.setFileInputFiles'), false)
})

test('automation marker still locates a same-document selector without snapshot target nodes', async () => {
  const { service, cdp, marks } = makeUploadService({ documentToken: 'document-v1', hasSnapshotNodes: false })
  const result = await service.setFileInputFiles('tab-1', {
    files: ['/tmp/poster.png'],
    selector: 'input[type="file"]',
    frameDocumentToken: 'document-v1',
  })
  assert.equal(result.inputFound, true, `upload mark failed: ${JSON.stringify(result)}`)
  assert.equal(result.ok, true)
  assert.equal(cdp.includes('DOM.setFileInputFiles'), true)
})
