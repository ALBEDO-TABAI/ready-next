interface BrowserCloseController {
  activeTabId: string | null
  closeTab(tabId: string): { success: boolean; error?: string }
}

interface BrowserTabUpdateSender {
  send(channel: 'browser:tabUpdate', payload: {
    type: 'closed'
    tabId: string
    activeTabId: string | null
  }): void
}

export function closeBrowserTabAndNotify(
  controller: BrowserCloseController,
  sender: BrowserTabUpdateSender,
  tabId: string,
): { success: boolean; error?: string } {
  try {
    const result = controller.closeTab(tabId)
    if (result.success) {
      sender.send('browser:tabUpdate', {
        type: 'closed',
        tabId,
        activeTabId: controller.activeTabId,
      })
    }
    return result
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
