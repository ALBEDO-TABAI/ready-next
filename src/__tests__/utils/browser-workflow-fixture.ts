import type { BrowserController } from '../../main/modules/browser-engine/ipc-handler'
import type { executeBrowserTool } from '../../main/modules/tools/browser-tools'
import { answerPageMarkdownFromPageContent } from './browser-page-markdown-fixture'

export type BrowserWorkflowTestContext = NonNullable<Parameters<typeof executeBrowserTool>[8]>

export function attachBrowserWorkflowFixture(
  controller: BrowserController,
  overrides: Partial<BrowserWorkflowTestContext> = {},
): { controller: BrowserController; context: BrowserWorkflowTestContext } {
  let actionSeq = 0
  let observationSeq = 0
  let writeTarget: Record<string, unknown> | null = null
  const originalExecuteJS = typeof controller.executeJS === 'function'
    ? controller.executeJS.bind(controller)
    : null
  const originalPhysicalTargetToken = typeof controller.getPhysicalTargetToken === 'function'
    ? controller.getPhysicalTargetToken.bind(controller)
    : null

  controller.getPhysicalTargetToken = ((tabId: string | null) => (
    originalPhysicalTargetToken?.(tabId) || `physical-${tabId || 'active'}`
  )) as BrowserController['getPhysicalTargetToken']
  controller.executeJS = (async (tabId: string | null, code: string) => {
    if (String(code).includes('__readyBrowserTargetIdentityV3')) {
      const active = controller.getActiveTab?.()
      const selected = (tabId
        ? controller.getTabList?.().find((tab) => tab.id === tabId)
        : active) || active || null
      return {
        url: selected?.url || 'https://example.test/',
        title: selected?.title || 'Browser workflow fixture',
        timeOrigin: 1,
        mutationRevision: 0,
        frameDocumentToken: `document-${tabId || selected?.id || 'active'}`,
      }
    }
    return originalExecuteJS ? originalExecuteJS(tabId, code) : null
  }) as BrowserController['executeJS']
  // A fake page says what its getPageContent holds when the read tool asks it for its Markdown.
  answerPageMarkdownFromPageContent(controller)

  if (typeof controller.beginBrowserWorkflowAction !== 'function') {
    controller.beginBrowserWorkflowAction = ((input: {
      identity: unknown
      searchActionId?: string | null
    }) => ({
      actionId: `action-${++actionSeq}`,
      actionSeq,
      identity: input.identity,
      ...(input.searchActionId ? { searchActionId: input.searchActionId } : {}),
    })) as BrowserController['beginBrowserWorkflowAction']
  }
  if (typeof controller.settleBrowserWorkflowAction !== 'function') {
    controller.settleBrowserWorkflowAction = ((_taskId: string, actionId: string, outcome: unknown) => ({
      receiptId: `receipt-${actionId}`,
      outcome,
    })) as BrowserController['settleBrowserWorkflowAction']
  }
  if (typeof controller.recordBrowserWorkflowObservation !== 'function') {
    controller.recordBrowserWorkflowObservation = ((input: {
      operationId: string
      ownerRunId: string
      identity: unknown
      resultDigest: string
    }) => ({
      receiptId: `observation-${++observationSeq}`,
      observationSeq,
      operationId: input.operationId,
      ownerRunId: input.ownerRunId,
      observedAfterActionSeq: actionSeq,
      identity: input.identity,
      searchActionId: null,
      queryDigest: null,
      causalActions: [],
      resultDigest: input.resultDigest,
      observedAt: new Date(0).toISOString(),
    })) as BrowserController['recordBrowserWorkflowObservation']
  }
  if (typeof controller.bindBrowserWorkflowPhysicalTarget !== 'function') {
    controller.bindBrowserWorkflowPhysicalTarget = ((input: Record<string, unknown>) => {
      const bound = { ...input }
      writeTarget = bound
      return () => {
        if (writeTarget === bound) writeTarget = null
      }
    }) as BrowserController['bindBrowserWorkflowPhysicalTarget']
  }
  if (typeof controller.isBrowserWorkflowWriteAdmitted !== 'function') {
    controller.isBrowserWorkflowWriteAdmitted = ((input: Record<string, unknown>) => Boolean(
      writeTarget
      && Object.entries(input).every(([key, value]) => writeTarget?.[key] === value),
    )) as BrowserController['isBrowserWorkflowWriteAdmitted']
  }

  return {
    controller,
    context: {
      ownerRunId: 'run-browser-workflow-test',
      browserTaskId: 'browser-task-workflow-test',
      parentTaskId: 'parent-browser-workflow-test',
      inputSource: 'trusted_internal',
      ...overrides,
    },
  }
}
