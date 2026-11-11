import { httpOrigin } from '../../browser-engine/browser-origin-write-scope'
import type { BrowserController } from '../../browser-engine/ipc-handler'
import type { BrowserTabContextData } from '../../browser-engine/automation-types'
import { browserSnapshotService } from '../../browser-engine/browser-snapshot-service'
import type { TrustedRequestEnvironment } from '../contracts/request-envelope'

export type TrustedBrowserReference = {
  environment: TrustedRequestEnvironment
  context: BrowserTabContextData
}

/**
 * Bind the current Browser workbench page by physical identity. Host
 * presentation is an action-level readiness fact: an overlay may detach the
 * native surface while the same WebContents/CDP target remains observable and
 * exact direct-text/form transports remain usable.
 */
export async function resolveTrustedBrowserEnvironment(
  controller: BrowserController,
  tabId?: string | null,
): Promise<TrustedRequestEnvironment> {
  const targetTab = tabId
    ? controller.getTabList().find((tab) => tab.id === tabId)
    : controller.getActiveTab()
  if (!targetTab) return { workbenchMode: 'browser' }
  const identity = await browserSnapshotService.documentIdentity(controller, targetTab.id)
  if (!identity.physicalTargetToken || !identity.frameDocumentToken) {
    return { workbenchMode: 'browser' }
  }
  return {
    workbenchMode: 'browser',
    browserPageRef: {
      tabId: targetTab.id,
      physicalTargetToken: identity.physicalTargetToken,
      mainFrameId: '0',
      mainFrameDocumentToken: identity.frameDocumentToken,
      origin: httpOrigin(identity.url),
      profileId: targetTab.profile || null,
    },
  }
}

export async function resolveTrustedBrowserReference(
  controller: BrowserController,
  tabId: string,
): Promise<TrustedBrowserReference | null> {
  const targetTab = controller.getTabList().find((tab) => tab.id === tabId)
  if (!targetTab) return null
  const before = await browserSnapshotService.documentIdentity(controller, tabId)
  const context = await controller.getTabContext(tabId)
  const after = await browserSnapshotService.documentIdentity(controller, tabId)
  if (
    !before.physicalTargetToken
    || !before.frameDocumentToken
    || before.physicalTargetToken !== after.physicalTargetToken
    || before.frameDocumentToken !== after.frameDocumentToken
    || before.key !== after.key
    || context.url !== after.url
  ) return null
  return {
    environment: {
      workbenchMode: 'browser',
      browserPageRef: {
        tabId,
        physicalTargetToken: after.physicalTargetToken,
        mainFrameId: '0',
        mainFrameDocumentToken: after.frameDocumentToken,
        origin: httpOrigin(after.url),
        profileId: targetTab.profile || null,
      },
    },
    context,
  }
}
