import type { BrowserController } from '../../main/modules/browser-engine/ipc-handler'
import { createBrowserTurnLease } from '../../main/modules/browser-engine/agent-browser-turn-lease'
import { BrowserTargetClaimService, MemoryBrowserTargetClaimRepository } from '../../main/modules/browser-engine/browser-target-claims'
import { buildExplicitNoSkillAuthorization } from '../../main/modules/agent-control/skills/skill-tool-authorization'
import type { ToolContext } from '../../main/modules/tools/tool-executor'

/** Only the physical browser and journal storage are replaced; admission,
 * schemas, action execution and the real in-memory claim service remain live. */
export function browserSequenceFixture() {
  const actions: Parameters<BrowserController['beginBrowserWorkflowAction']>[0][] = []
  const outcomes: Parameters<BrowserController['settleBrowserWorkflowAction']>[2][] = []
  const observations: Parameters<BrowserController['recordBrowserWorkflowObservation']>[0][] = []
  const events: Array<{ toolName: string; phase: string }> = []
  const calls: string[] = []
  /** `keyDelivered: null` is a key press whose delivery cannot be read back, as after a navigation. */
  const state = { origin: 'https://sequence.test', physical: 'physical-sequence', document: 'document-sequence',
    body: 'FINAL SNAPSHOT CONTENT', dialog: false, challenge: false, matched: true,
    keyDelivered: true as boolean | null, writable: true }
  const tab = () => ({ id: 'tab-sequence', url: `${state.origin}/form`, title: 'Sequence page', active: true })
  const controller = {
    getActiveTab: tab,
    getTabList: () => [tab()],
    getTaskWorkTabIds: () => [],
    getPhysicalTargetToken: () => state.physical,
    getTaskPayload: () => ({ approvedWriteOrigins: [] }),
    readBrowserWorkflowSettledOutcomes: () => outcomes,
    getBrowserInputEnvironment: () => ({ mainWindowForeground: false, hostPresentation: 'hidden', tabActive: false }),
    getBrowserDialog: async () => state.dialog ? { type: 'confirm', message: 'Continue?', url: tab().url } : null,
    executeJS: async (_tabId: string | null, code: string) => {
      if (code === 'location.origin') return state.origin
      if (code.includes('return readySetControlValue(nodes[0]')) {
        calls.push('type')
        return { ok: true, delivery: 'delivered', value: '42' }
      }
      if (code.includes("const targetKey = '__readyBrowserTargetIdentityV3'")) return { url: tab().url, title: tab().title,
        timeOrigin: 1, mutationRevision: 0, frameDocumentToken: state.document }
      if (code.includes('__READY_BLOCKING_CHALLENGE_PROBE__')) return { blocked: state.challenge, blockerCount: state.challenge ? 1 : 0,
        matchedKinds: state.challenge ? ['captcha'] : [], pageError: false, emptyShell: false }
      if (code.includes('__READY_AGENT_PAGE_MAP__')) return { identity: { url: tab().url, title: tab().title },
        viewport: { width: 1000, height: 800 }, bodyText: state.body,
        rawRoots: [{ role: 'button', name: state.body, backendDOMNodeId: 1, frameId: '0' }],
        riskFlags: {}, structureHints: { iframes: [], shadowRoots: [], hiddenLoaded: [] } }
      if (code.includes('String(node.type')) return { inputType: 'number' }
      if (code.includes('activeElementEditable') && code.includes('document.hasFocus')) return { ready: true, focused: true, activeElementEditable: true }
      if (code.includes('globalThis.__readyKeyDeliveryProbe = state')) return 'key-probe'
      if (code.includes('__readyKeyDeliveryProbe') && code.includes('Number(state.count')) return state.keyDelivered === null ? null : state.keyDelivered ? 1 : 0
      return null
    },
    dispatchKey: async (_tabId: string | null, event: { type: string }) => { calls.push(event.type) },
    getPageContent: async () => { calls.push('read'); return state.body },
    waitForCondition: async () => { calls.push('wait'); return { matched: state.matched, elapsedMs: 1 } },
    bindBrowserWorkflowPhysicalTarget: () => () => undefined,
    isBrowserWorkflowWriteAdmitted: () => state.writable,
    consumeBrowserSiteNotices: () => [],
    recordTaskAttention: () => { calls.push('attention') },
    requestAgentInterruption: async () => { calls.push('interrupt') },
    beginBrowserWorkflowAction: (input: Parameters<BrowserController['beginBrowserWorkflowAction']>[0]) => {
      actions.push(input)
      return { actionId: `action-${actions.length}`, actionSeq: actions.length, identity: input.identity }
    },
    settleBrowserWorkflowAction: (_taskId: string, actionId: string, outcome: Parameters<BrowserController['settleBrowserWorkflowAction']>[2]) => {
      outcomes.push(outcome)
      return { receiptId: `receipt-${actionId}`, outcome }
    },
    recordBrowserWorkflowObservation: (input: Parameters<BrowserController['recordBrowserWorkflowObservation']>[0]) => {
      observations.push(input)
      return { receiptId: `observation-${observations.length}`, observationSeq: observations.length, operationId: input.operationId,
        ownerRunId: input.ownerRunId, observedAfterActionSeq: actions.length, identity: input.identity,
        searchActionId: null, queryDigest: null, causalActions: [], resultDigest: input.resultDigest, observedAt: new Date(0).toISOString() }
    },
    publishAgentBrowserAction: (event: typeof events[number]) => { events.push(event) },
  } as unknown as BrowserController
  const lease = createBrowserTurnLease({ taskId: 'task-sequence', runId: 'run-sequence' },
    new BrowserTargetClaimService(new MemoryBrowserTargetClaimRepository()))
  const context: ToolContext = {
    browserController: controller, browserLease: lease,
    sessionId: 'scope-sequence', scopeId: 'scope-sequence', taskId: 'task-sequence', runId: 'run-sequence',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    allowedToolNames: new Set(['browser_sequence', 'browser_type', 'browser_press_key', 'browser_snapshot', 'browser_find', 'browser_read', 'browser_wait', 'browser_click']),
    browserWorkflowRoute: { browserTaskId: 'browser-task-sequence', requestAnchorSnapshotDigest: 'anchor' },
    requestEnvelope: { environmentHints: { workbenchMode: 'browser', browserWriteOrigins: ['https://sequence.test'],
      browserPageRef: { tabId: 'tab-sequence', physicalTargetToken: state.physical, mainFrameDocumentToken: state.document } } },
  }
  return { context, controller, state, calls, actions, outcomes, observations, events, lease }
}
