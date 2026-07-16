import type { RequestedCapabilityConflict } from '../domain-adapters/capability-resolver'
import type { SystemReminderRegistry } from './system-reminder-registry'

export const TOOL_CAPABILITY_CONFLICT_REMINDER_MARKER =
  '<ready:system-reminder:tool-capability-conflict>'

function explainConflict(conflict: RequestedCapabilityConflict): string {
  switch (conflict.reason) {
    case 'provider_disabled_tools':
      return '当前模型配置关闭了工具调用。若端点支持 function calling，可在“设置 > AI 模型 > 能力 > 工具调用”选择“强制开启”。'
    case 'disabled_by_config':
      return '该能力组已在设置中关闭。'
    case 'environment_unavailable':
      return '该能力所需的本地运行环境当前不可用。'
    case 'profile_disabled':
      return '当前运行配置没有开放该能力组。'
    case 'inactive':
      return '该能力尚未接入当前运行链路。'
    default:
      return `该能力被运行时策略阻止（${conflict.reason}）。`
  }
}

export function registerToolCapabilityConflictReminder(
  registry: SystemReminderRegistry,
  conflicts: readonly RequestedCapabilityConflict[]
): boolean {
  if (conflicts.length === 0) return false
  const details = conflicts.map(
    (conflict) => `- ${conflict.label}（${conflict.groupId}）：${explainConflict(conflict)}`
  )
  registry.register({
    topic: 'tool-capability-conflict',
    priority: 88,
    text: [
      TOOL_CAPABILITY_CONFLICT_REMINDER_MARKER,
      '本轮用户请求了能力，但完整能力组没有开放：',
      ...details,
      '只能使用当前实际列出的工具，并必须按上述真实原因说明缺口。不得声称“已收到授权”、不得承诺稍后自动挂载工具，也不要建议在同一旧工具面上无效重试。聊天文字本身不能直接修改设置。',
      '</ready:system-reminder:tool-capability-conflict>'
    ].join('\n')
  })
  return true
}
