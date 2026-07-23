import { redactModelVisibleToolText } from '../tools-runtime/model-visible-tool-output'
import type { InterruptedToolExecution } from './agent-sdk-types'

const SECRET_FLAG_PATTERN = /(?:key|token|secret|password|authorization)/i

function safeSetupCommand(args: Record<string, unknown>): string | null {
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (!command) return null
  const rawArgs = Array.isArray(args.args) ? args.args.map((value) => String(value)) : []
  let redactNext = false
  const safeArgs = rawArgs.map((value) => {
    if (redactNext) {
      redactNext = false
      return '[已隐藏]'
    }
    const equalsIndex = value.indexOf('=')
    if (equalsIndex > 0 && SECRET_FLAG_PATTERN.test(value.slice(0, equalsIndex))) {
      return `${value.slice(0, equalsIndex + 1)}[已隐藏]`
    }
    if (
      value.startsWith('-')
      && SECRET_FLAG_PATTERN.test(value)
      && !/(?:stdin|file)$/i.test(value)
    ) {
      redactNext = true
    }
    return value
  })
  return redactModelVisibleToolText([command, ...safeArgs].join(' ').slice(0, 240))
}

function operationLabel(snapshot: InterruptedToolExecution): string {
  if (snapshot.toolName === 'run_setup_command') {
    const command = safeSetupCommand(snapshot.args)
    return command ? `本地安装或配置命令“${command}”` : '本地安装或配置命令'
  }
  if (snapshot.toolName === 'skill_run_shell') return '技能声明的本地程序'
  return `工具“${snapshot.toolName}”`
}

export function buildDeliveryDeadlineTerminalText(
  snapshot: InterruptedToolExecution | null,
  nowMs = Date.now(),
): string {
  if (!snapshot) {
    return '本轮连续一段时间没有产生新的文字、推理或工具结果，Ready 已停止运行，避免继续无期限等待。'
  }
  const elapsedSeconds = Math.max(1, Math.round((nowMs - snapshot.startedAtMs) / 1_000))
  const expectedSeconds = Math.max(1, Math.round(snapshot.expectedTimeoutMs / 1_000))
  return [
    `本轮停在${operationLabel(snapshot)}：执行约 ${elapsedSeconds} 秒后仍未返回，超过了该工具登记的 ${expectedSeconds} 秒执行上限。`,
    'Ready 已停止本轮；这次操作没有返回结果，不能视为已经成功。',
  ].join('')
}
