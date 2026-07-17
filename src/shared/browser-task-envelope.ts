import type { BrowserPowerEffect } from './browser-power'

export type BrowserSensitiveOperation =
  | 'session.clear_origin'
  | 'session.clear_site_data'
  | 'session.switch_profile'
  | 'permission.set'
  | 'permission.reset'

/**
 * Code-owned authority for one browser tool turn. It is assembled from the
 * canonical current user instruction plus runtime identity; page text and tool
 * arguments cannot add operations to it.
 */
export interface BrowserTaskEnvelope {
  version: 1
  scopeId: string
  runId: string
  taskId: string
  agentId: string | null
  primaryInstruction: string
  allowedToolNames: string[]
  allowedEffects: BrowserPowerEffect[]
  allowedSensitiveOperations: BrowserSensitiveOperation[]
  tabId: string | null
  origin: string | null
  destination: string | null
  workspaceRoots: string[]
  createdAt: number
}

export function browserSensitiveOperationsForInstruction(
  instruction: string,
): BrowserSensitiveOperation[] {
  const text = String(instruction || '')
  const operations: BrowserSensitiveOperation[] = []
  if (/(?:清理|清除|删除|抹掉).{0,20}(?:cookie|缓存|站点数据|网站数据|本地存储|登录态|浏览器会话)/i.test(text)) {
    operations.push('session.clear_origin', 'session.clear_site_data')
  }
  if (/(?:切换|新建|使用).{0,18}(?:浏览器配置|会话配置|独立会话|身份配置|profile)/i.test(text)) {
    operations.push('session.switch_profile')
  }
  if (/(?:允许|拒绝|授权|设置|改成).{0,22}(?:站点|网站|网页|定位|通知|剪贴板|摄像头|麦克风).{0,12}(?:权限|访问)|(?:权限).{0,12}(?:允许|拒绝|设置|改成)/i.test(text)) {
    operations.push('permission.set')
  }
  if (/(?:重置|恢复|清除).{0,18}(?:站点|网站|网页|定位|通知|剪贴板|摄像头|麦克风).{0,12}(?:权限|授权)|(?:权限).{0,12}(?:重置|恢复|清除)/i.test(text)) {
    operations.push('permission.reset')
  }
  return Array.from(new Set(operations))
}

export function browserTaskEnvelopeAllowsSensitiveOperation(
  envelope: BrowserTaskEnvelope | null | undefined,
  operation: BrowserSensitiveOperation,
): boolean {
  return Boolean(
    envelope
    && envelope.scopeId
    && envelope.runId
    && envelope.taskId
    && envelope.allowedSensitiveOperations.includes(operation),
  )
}
