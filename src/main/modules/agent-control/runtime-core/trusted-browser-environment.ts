import type { BrowserController } from '../../browser-engine/ipc-handler'
import { browserSnapshotService } from '../../browser-engine/browser-snapshot-service'
import type { TrustedRequestEnvironment } from '../contracts/request-envelope'

/**
 * Bind the current Browser workbench page by physical identity. Host
 * presentation is an action-level readiness fact: an overlay may detach the
 * native surface while the same WebContents/CDP target remains observable and
 * exact direct-text/form transports remain usable.
 */
export async function resolveTrustedBrowserEnvironment(
  controller: BrowserController,
): Promise<TrustedRequestEnvironment> {
  const activeTab = controller.getActiveTab()
  if (!activeTab) return { workbenchMode: 'browser' }
  const identity = await browserSnapshotService.documentIdentity(controller, activeTab.id)
  if (!identity.physicalTargetToken || !identity.frameDocumentToken) {
    return { workbenchMode: 'browser' }
  }
  return {
    workbenchMode: 'browser',
    browserPageRef: {
      tabId: activeTab.id,
      physicalTargetToken: identity.physicalTargetToken,
      mainFrameId: '0',
      mainFrameDocumentToken: identity.frameDocumentToken,
      profileId: activeTab.profile || null,
    },
  }
}
