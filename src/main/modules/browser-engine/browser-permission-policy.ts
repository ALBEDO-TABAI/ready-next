/**
 * 站点权限请求的路径判决与 agent 自动拒绝注记（electron-free）。
 *
 * 真机第十二轮实锚（XHS 发布页定位请求）：站点权限 modal sheet 在无人值守
 * run 里让站点回调永远悬着，还把整个 Ready 窗口挡在 sheet 后面。判决核心
 * 与注记队列放在本模块（不 import electron），session-policy-service 负责
 * 接 Electron session 回调，browser-tools 负责把注记随下一次浏览器动作输出
 * 带给模型——两侧都能被普通 Node 行为测试直接执行。
 */

import {
  requiresUserApprovalBrowserPermission,
  shouldAllowBrowserPermission,
  supportsBrowserPermissionRequest,
} from './popup-policy'

export interface BrowserSitePermissionNotice {
  kind: 'site_permission_auto_denied' | 'file_chooser_intercepted'
  permission: string
  origin: string
  at: string
  guidance: string
}

/**
 * Agent 驾驶期间的站点事件注记（权限自动拒绝 / 文件选择器拦截），等下一次
 * 浏览器工具输出时带给模型（attachBrowserActionSessionOutput 排空）。
 */
const pendingSitePermissionNotices: BrowserSitePermissionNotice[] = []

function pushSiteNotice(notice: BrowserSitePermissionNotice): void {
  pendingSitePermissionNotices.push(notice)
  if (pendingSitePermissionNotices.length > 8) {
    pendingSitePermissionNotices.splice(0, pendingSitePermissionNotices.length - 8)
  }
}

export function consumePendingBrowserSitePermissionNotices(): BrowserSitePermissionNotice[] {
  return pendingSitePermissionNotices.splice(0, pendingSitePermissionNotices.length)
}

export function recordAgentAutoDeniedSitePermission(permission: string, origin: string): void {
  pushSiteNotice({
    kind: 'site_permission_auto_denied',
    permission: String(permission || ''),
    origin,
    at: new Date().toISOString(),
    guidance: 'Agent 驾驶期间站点权限请求已自动拒绝（站点会拿到 PERMISSION_DENIED 并继续）。若任务确实需要该权限，请告知用户在场时手动允许后重试。',
  })
}

/** D16 — 原生文件选择器被拦截时给模型的改道注记。 */
export function recordFileChooserInterceptedNotice(tabId: string, url: string): void {
  pushSiteNotice({
    kind: 'file_chooser_intercepted',
    permission: '',
    origin: url || tabId,
    at: new Date().toISOString(),
    guidance: '页面尝试打开原生文件选择器，已被拦截（agent 模式下原生对话框会挂起工具环）。请用 browser_find 定位上传点，再用 browser_upload 完成文件上传；站点会在文件注入后继续原流程。',
  })
}

export type BrowserPermissionPath =
  | 'unsupported_deny'
  | 'auto_allow'
  | 'policy_deny'
  | 'cached_allow'
  | 'cached_deny'
  | 'agent_auto_deny'
  | 'prompt'

/**
 * 权限请求的路径判决（纯函数，行为测试入口）。顺序即合同：
 * 1. 不支持的权限类型直接拒；2. 策略允许直接放；3. 需要人工批准的类型
 * 里，本运行期用户已有决定的沿用（用户在场时点过允许，agent 后续复用）；
 * 4. agent 正在驾驶（持浏览器写租约）→ 自动拒绝不弹窗（modal 会挂死无人
 * 值守 run，拒绝对站点是安全默认）；5. 其余弹窗问用户。
 */
export function resolveBrowserPermissionPath(params: {
  permission: string
  requestingUrl: string
  cachedDecision: boolean | undefined
  agentDriveActive: boolean
}): BrowserPermissionPath {
  if (!supportsBrowserPermissionRequest(params.permission)) return 'unsupported_deny'
  if (shouldAllowBrowserPermission(params.permission, params.requestingUrl)) return 'auto_allow'
  if (!requiresUserApprovalBrowserPermission(params.permission)) return 'policy_deny'
  if (params.cachedDecision === true) return 'cached_allow'
  if (params.cachedDecision === false) return 'cached_deny'
  if (params.agentDriveActive) return 'agent_auto_deny'
  return 'prompt'
}
