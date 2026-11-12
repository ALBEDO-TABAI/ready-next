export const WEBMCP_SETTING_KEY = 'browser.webmcpExperiment'
/** Read through settings:get; this computed key cannot be written. */
export const WEBMCP_STATUS_KEY = 'browser.webmcpExperimentStatus'
export const WEBMCP_TOOL_NAMES = ['browser_page_tools', 'browser_call_page_tool'] as const
export interface WebMcpExperimentStatus {
  enabled: boolean
  active: boolean
  restartRequired: boolean
}
