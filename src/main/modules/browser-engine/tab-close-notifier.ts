interface BrowserCloseController {
  closeTab(tabId: string): { success: boolean; error?: string }
  notifyTabClosed(tabId: string): void
}

export function closeBrowserTabAndNotify(
  controller: BrowserCloseController,
  tabId: string,
): { success: boolean; error?: string } {
  try {
    const result = controller.closeTab(tabId)
    if (result.success) controller.notifyTabClosed(tabId)
    return result
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
