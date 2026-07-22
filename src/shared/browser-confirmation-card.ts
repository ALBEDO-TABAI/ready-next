import type {
  BrowserConfirmationSuspensionRequest,
  BrowserPermissionSuspensionRequest,
  BrowserPowerConfirmationSuspensionRequest,
} from './browser-workflow-control'

export interface BrowserConfirmationCard {
  kind: BrowserConfirmationSuspensionRequest['kind']
  requestId: string
  title: string
  description: string
  detail: string
  allowLabel: string
  denyLabel: string
}

function powerEffectLabel(effect: BrowserPowerConfirmationSuspensionRequest['effects'][number]): string {
  const labels: Record<string, string> = {
    observe: '读取页面信息',
    navigate: '跳转网页',
    page_mutation: '修改页面内容',
    download: '下载文件',
    upload: '上传文件',
    external_submit: '向网站提交内容',
    credential_use: '使用登录凭据',
    challenge_interaction: '处理网站验证',
    payment: '发起付款',
    remote_delete: '删除网站数据',
    account_delete: '删除账号',
    credential_change: '修改登录凭据',
    secret_export: '导出敏感信息',
    access_control_circumvention: '绕过访问限制',
  }
  return labels[effect] || String(effect)
}

function powerCard(request: BrowserPowerConfirmationSuspensionRequest): BrowserConfirmationCard {
  const effects = request.effects.map(powerEffectLabel).join('、') || '执行高权限网页操作'
  return {
    kind: request.kind,
    requestId: request.requestId,
    title: '需要你确认浏览器操作',
    description: `Ready 准备${effects}。`,
    detail: request.target.origin
      ? `目标网站：${request.target.origin}`
      : `用途：${request.purpose}`,
    allowLabel: '允许并继续',
    denyLabel: '拒绝',
  }
}

function permissionCard(request: BrowserPermissionSuspensionRequest): BrowserConfirmationCard {
  return {
    kind: request.kind,
    requestId: request.requestId,
    title: '网站正在请求权限',
    description: `${request.actionIntent.origin} 请求“${request.actionIntent.permission}”权限。`,
    detail: '请选择是否允许，Ready 会按你的选择继续。',
    allowLabel: '允许',
    denyLabel: '拒绝',
  }
}

export function buildBrowserConfirmationCard(
  request: BrowserConfirmationSuspensionRequest,
): BrowserConfirmationCard {
  return request.kind === 'browser_power_confirmation'
    ? powerCard(request)
    : permissionCard(request)
}

export function browserConfirmationNotice(
  request: BrowserConfirmationSuspensionRequest,
): string {
  const card = buildBrowserConfirmationCard(request)
  return `${card.description}正在等待你的确认，请选择“${card.allowLabel}”或“${card.denyLabel}”后继续。`
}

export function readBrowserConfirmationRequest(
  continuation: unknown,
): BrowserConfirmationSuspensionRequest | null {
  if (!continuation || typeof continuation !== 'object' || Array.isArray(continuation)) return null
  const request = (continuation as Record<string, unknown>).suspensionRequest
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null
  const value = request as Partial<BrowserConfirmationSuspensionRequest>
  if (
    value.version !== 1
    || (value.kind !== 'browser_power_confirmation' && value.kind !== 'browser_permission')
    || typeof value.requestId !== 'string'
    || !value.actionIntent
    || !value.target
  ) return null
  return value as BrowserConfirmationSuspensionRequest
}
