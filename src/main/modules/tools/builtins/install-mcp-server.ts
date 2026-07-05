/**
 * Phase M（2026-07-05）—— `install_mcp_server`：agent 代用户接入 MCP server
 * 的两阶段前门（镜像 install_skill 的 trustAck 范式）。
 *
 * 非专业用户只会说「帮我装个能读文件的 MCP」——由模型解析成包名（判断题），
 * 由本工具的代码承担全部安全边界（合同：模型只做判断题）：
 *   - 命令白名单只有 npx / uvx（发布制品），任意其他命令机械拒绝；
 *   - 包名正则校验（npm / PyPI），杜绝把 shell 片段塞进 args；
 *   - 阶段 1 只读：产出将写入的 pendingConfig + riskNotes，绝不落盘；
 *   - 阶段 2 必须 confirmAck:true 且回传 pendingConfig，重新全量校验后才
 *     写 `mcp_servers_json` 并重连（复用设置页同一 reload 通道）；
 *   - 不接受 env（密钥不走对话明文）；现有配置解析不动就拒绝改写。
 */

import { ToolDomainError } from '../tool-errors'
import { MCP_INSTALL_ERROR_KINDS } from '../../agent-control/contracts/error-kinds'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../../agent-control/tools-runtime/tool-result-types'
import {
  getMcpRuntimeStatus,
  MCP_SERVERS_SETTING_KEY,
  reloadMcpServersFromSettings,
  type McpBootstrapServerOutcome,
} from '../../mcp/bootstrap'
import { listMcpServerRegistrations } from '../../mcp/registry'

const NPM_PACKAGE_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const PYPI_PACKAGE_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/
const SERVER_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/

export interface McpInstallPendingConfig {
  id: string
  command: 'npx' | 'uvx'
  args: string[]
}

export interface InstallMcpServerDeps {
  getSetting: (key: string) => string | null | undefined
  setSetting: (key: string, value: string) => void
  /** 默认真实 reload（关客户端→清注册表→按配置重连）；测试注入假实现。 */
  reloadServers?: () => Promise<McpBootstrapServerOutcome[]>
  log?: (line: string) => void
}

function deriveServerId(packageName: string): string {
  const lastSegment = packageName.split('/').pop() || packageName
  const stripped = lastSegment
    .toLowerCase()
    .replace(/^(mcp-server-|server-|mcp-)/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return stripped || 'mcp-server'
}

function readExistingConfigEntries(raw: string): Array<Record<string, unknown>> {
  const text = String(raw || '').trim()
  if (!text) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ToolDomainError(
      MCP_INSTALL_ERROR_KINDS.configUnreadable.code,
      `现有 MCP 配置不是可解析的 JSON（${error instanceof Error ? error.message : String(error)}），拒绝自动改写。请让用户在 设置 → MCP 修复后重试。`,
    )
  }
  if (!Array.isArray(parsed)) {
    throw new ToolDomainError(
      MCP_INSTALL_ERROR_KINDS.configUnreadable.code,
      '现有 MCP 配置不是 JSON 数组，拒绝自动改写。请让用户在 设置 → MCP 修复后重试。',
    )
  }
  return parsed.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
}

function existingIds(entries: Array<Record<string, unknown>>): Set<string> {
  return new Set(entries.map((entry) => String(entry.id || '').trim()).filter(Boolean))
}

/** 阶段 1：source → 白名单命令 + 校验后的 pendingConfig（纯函数，可单测）。 */
export function resolveMcpInstallSource(input: {
  source: string
  serverId?: string
  extraArgs?: string[]
}): { pendingConfig: McpInstallPendingConfig; packageName: string; runner: 'npx' | 'uvx' } {
  const raw = String(input.source || '').trim()
  if (!raw) {
    throw new ToolDomainError(
      MCP_INSTALL_ERROR_KINDS.invalidSource.code,
      '安装阶段 1 需要 source：npm 包名（如 @modelcontextprotocol/server-filesystem）或 uvx:<PyPI 包名>。',
    )
  }
  if (/^(https?:|git@)/i.test(raw)) {
    throw new ToolDomainError(
      MCP_INSTALL_ERROR_KINDS.invalidSource.code,
      'agent 安装只接受已发布的包（npm / uvx:PyPI），不接受 URL/仓库地址。请先确认该 server 发布的包名；确实只有源码时，让用户在 设置 → MCP 手工配置。',
    )
  }
  let runner: 'npx' | 'uvx' = 'npx'
  let packageName = raw
  if (/^uvx:/i.test(raw)) {
    runner = 'uvx'
    packageName = raw.slice(4).trim()
  } else if (/^(npx|npm):/i.test(raw)) {
    packageName = raw.replace(/^(npx|npm):/i, '').trim()
  }
  const packageOk = runner === 'npx' ? NPM_PACKAGE_RE.test(packageName) : PYPI_PACKAGE_RE.test(packageName)
  if (!packageOk) {
    throw new ToolDomainError(
      MCP_INSTALL_ERROR_KINDS.invalidSource.code,
      `「${packageName.slice(0, 80)}」不是合法的${runner === 'npx' ? ' npm' : ' PyPI'} 包名。确认真实包名后重试。`,
      { source: raw.slice(0, 120) },
    )
  }
  const extraArgs = (input.extraArgs || []).map((value) => String(value)).filter((value) => value.length > 0)
  for (const value of extraArgs) {
    if (/[;&|`$<>\n\r]/.test(value)) {
      throw new ToolDomainError(
        MCP_INSTALL_ERROR_KINDS.invalidSource.code,
        `args 含不允许的 shell 元字符：${value.slice(0, 60)}（参数按原样传给 server 进程，不经 shell——不需要也不允许这些字符）。`,
      )
    }
  }
  const id = String(input.serverId || '').trim() || deriveServerId(packageName)
  if (!SERVER_ID_RE.test(id)) {
    throw new ToolDomainError(
      MCP_INSTALL_ERROR_KINDS.invalidSource.code,
      `serverId「${id.slice(0, 60)}」不合法：小写字母数字与连字符，≤48 字符。`,
    )
  }
  return {
    runner,
    packageName,
    pendingConfig: {
      id,
      command: runner,
      args: runner === 'npx' ? ['-y', packageName, ...extraArgs] : [packageName, ...extraArgs],
    },
  }
}

function normalizePendingConfig(raw: unknown): McpInstallPendingConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as { id?: unknown; command?: unknown; args?: unknown }
  const id = String(value.id || '').trim()
  const command = String(value.command || '').trim()
  if (!SERVER_ID_RE.test(id)) return null
  if (command !== 'npx' && command !== 'uvx') return null
  if (!Array.isArray(value.args) || value.args.length === 0) return null
  const args = value.args.map((item) => String(item))
  return { id, command, args }
}

export async function executeInstallMcpServer(
  rawArgs: Record<string, unknown>,
  deps: InstallMcpServerDeps,
): Promise<ToolExecutionOutput> {
  const action = String(rawArgs.action || 'install')

  // ---- list：只读状态 -------------------------------------------------------
  if (action === 'list') {
    const status = getMcpRuntimeStatus(deps.getSetting)
    const lines = status.servers.length === 0
      ? '当前没有配置任何 MCP server。'
      : status.servers.map((server) =>
        `- ${server.serverId}：${server.clientConnected ? '已连接' : '未连接'}，${server.toolCount} 个工具${server.lastError ? `（${server.lastError}）` : ''}`).join('\n')
    return createToolExecutionOutput(`MCP server 状态：\n${lines}`, {
      shape: 'json',
      data: { servers: status.servers, configuredCount: status.configuredCount },
    })
  }

  // ---- remove：按 id 移除并重连 ---------------------------------------------
  if (action === 'remove') {
    const serverId = String(rawArgs.serverId || '').trim()
    if (!serverId) {
      throw new ToolDomainError(
        MCP_INSTALL_ERROR_KINDS.serverNotFound.code,
        'remove 需要 serverId。先用 action=list 查看已配置的 server。',
      )
    }
    const entries = readExistingConfigEntries(String(deps.getSetting(MCP_SERVERS_SETTING_KEY) || ''))
    const remaining = entries.filter((entry) => String(entry.id || '').trim() !== serverId)
    if (remaining.length === entries.length) {
      throw new ToolDomainError(
        MCP_INSTALL_ERROR_KINDS.serverNotFound.code,
        `没有 id 为「${serverId}」的 server。用 action=list 查看现有配置。`,
      )
    }
    try {
      deps.setSetting(MCP_SERVERS_SETTING_KEY, remaining.length > 0 ? JSON.stringify(remaining, null, 2) : '')
      const reload = deps.reloadServers ?? (() => reloadMcpServersFromSettings({ getSetting: deps.getSetting, log: deps.log }))
      await reload()
    } catch (error) {
      if (error instanceof ToolDomainError) throw error
      throw new ToolDomainError(
        MCP_INSTALL_ERROR_KINDS.applyFailed.code,
        `移除后重连失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return createToolExecutionOutput(`已移除 MCP server「${serverId}」并重连其余 server。`, {
      shape: 'json',
      data: { removed: serverId, remainingCount: remaining.length },
    })
  }

  // ---- install 阶段 2：confirmAck + pendingConfig ---------------------------
  if (rawArgs.confirmAck === true) {
    const pending = normalizePendingConfig(rawArgs.pendingConfig)
    if (!pending) {
      throw new ToolDomainError(
        'input_validation',
        '带 confirmAck 的安装阶段缺少有效的 pendingConfig；先用阶段 1（只传 source）解析，把返回的 pendingConfig 原样回传。',
      )
    }
    // 阶段 2 重新全量校验（防模型改写回传内容）：白名单 + 包名 + 元字符。
    if (pending.command !== 'npx' && pending.command !== 'uvx') {
      throw new ToolDomainError(
        MCP_INSTALL_ERROR_KINDS.commandNotAllowed.code,
        `命令「${String(pending.command).slice(0, 40)}」不在白名单（npx/uvx）。需要其他命令时让用户在 设置 → MCP 手工配置。`,
      )
    }
    const packageIndex = pending.command === 'npx' ? pending.args.indexOf('-y') + 1 : 0
    const packageName = String(pending.args[packageIndex] || '')
    const packageOk = pending.command === 'npx'
      ? pending.args[0] === '-y' && NPM_PACKAGE_RE.test(packageName)
      : PYPI_PACKAGE_RE.test(packageName)
    if (!packageOk) {
      throw new ToolDomainError(
        MCP_INSTALL_ERROR_KINDS.invalidSource.code,
        'pendingConfig 的 args 不符合阶段 1 的产出形状（npx 必须 [-y, 包名, …]；uvx 必须 [包名, …]）。请重新走阶段 1。',
      )
    }
    for (const value of pending.args) {
      if (/[;&|`$<>\n\r]/.test(value)) {
        throw new ToolDomainError(
          MCP_INSTALL_ERROR_KINDS.invalidSource.code,
          `args 含不允许的 shell 元字符：${value.slice(0, 60)}。请重新走阶段 1。`,
        )
      }
    }
    const entries = readExistingConfigEntries(String(deps.getSetting(MCP_SERVERS_SETTING_KEY) || ''))
    if (existingIds(entries).has(pending.id)) {
      throw new ToolDomainError(
        MCP_INSTALL_ERROR_KINDS.duplicateServer.code,
        `已存在 id 为「${pending.id}」的 server。换一个 serverId，或先 action=remove 移除旧的。`,
      )
    }
    const nextEntries = [...entries, {
      id: pending.id,
      transport: 'stdio',
      command: pending.command,
      args: pending.args,
    }]
    let outcomes: McpBootstrapServerOutcome[]
    try {
      deps.setSetting(MCP_SERVERS_SETTING_KEY, JSON.stringify(nextEntries, null, 2))
      const reload = deps.reloadServers ?? (() => reloadMcpServersFromSettings({ getSetting: deps.getSetting, log: deps.log }))
      outcomes = await reload()
    } catch (error) {
      if (error instanceof ToolDomainError) throw error
      throw new ToolDomainError(
        MCP_INSTALL_ERROR_KINDS.applyFailed.code,
        `写入配置或重连失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const outcome = outcomes.find((item) => item.serverId === pending.id)
    if (!outcome || !outcome.ok) {
      // 配置已写入但连接失败——如实报告，配置保留（用户可在设置页看到失败原因）
      return createToolExecutionOutput(
        `配置已写入，但「${pending.id}」连接失败：${outcome?.error || '未知原因'}。配置保留在 设置 → MCP，可修正参数后点「保存并重连」。`,
        {
          shape: 'json',
          data: { installed: false, serverId: pending.id, error: outcome?.error || 'unknown' },
        },
      )
    }
    const registration = listMcpServerRegistrations().find((item) => item.serverId === pending.id)
    const toolNames = registration?.toolNames ?? []
    return createToolExecutionOutput(
      `已安装并连接 MCP server「${pending.id}」，发现 ${outcome.toolCount} 个工具${toolNames.length > 0 ? `：${toolNames.slice(0, 8).join('、')}${toolNames.length > 8 ? ' …' : ''}` : ''}。新工具从下一轮起可用；未声明只读的外部工具执行前仍会单独确认。`,
      {
        shape: 'json',
        data: {
          installed: true,
          serverId: pending.id,
          toolCount: outcome.toolCount,
          toolNames: toolNames.slice(0, 24),
          ...(outcome.dropped.length > 0 ? { droppedByCap: outcome.dropped } : {}),
        },
      },
    )
  }

  // ---- install 阶段 1：只读解析（绝不写配置） -------------------------------
  const resolved = resolveMcpInstallSource({
    source: String(rawArgs.source || ''),
    serverId: typeof rawArgs.serverId === 'string' ? rawArgs.serverId : undefined,
    extraArgs: Array.isArray(rawArgs.args) ? rawArgs.args.map((item) => String(item)) : undefined,
  })
  const entries = readExistingConfigEntries(String(deps.getSetting(MCP_SERVERS_SETTING_KEY) || ''))
  if (existingIds(entries).has(resolved.pendingConfig.id)) {
    throw new ToolDomainError(
      MCP_INSTALL_ERROR_KINDS.duplicateServer.code,
      `已存在 id 为「${resolved.pendingConfig.id}」的 server。传入不同的 serverId，或先 action=remove。`,
    )
  }
  const commandLine = `${resolved.pendingConfig.command} ${resolved.pendingConfig.args.join(' ')}`
  const riskNotes = [
    `将以本地子进程运行第三方包：${commandLine}（首次运行会从 ${resolved.runner === 'npx' ? 'npm' : 'PyPI'} 下载）。`,
    '包名是否是你要的官方实现，需要用户确认（存在同名仿冒包的可能）。',
    ...(resolved.pendingConfig.args.some((value) => value.startsWith('/'))
      ? [`args 里的路径将对该 server 完全开放：${resolved.pendingConfig.args.filter((value) => value.startsWith('/')).join('、')}`]
      : []),
    '该 server 的工具进入 Agent 工具面后，未声明只读的动作执行前仍会单独向用户确认。',
  ]
  const text = [
    `已只读解析（未安装）。将写入的配置：${commandLine}（id: ${resolved.pendingConfig.id}）`,
    `风险提示：${riskNotes.join(' ')}`,
    '下一步：用 ask_user_questions 把命令与风险讲清楚让用户决定；用户明确同意后，用 install_mcp_server({ confirmAck: true, pendingConfig }) 原样回传 pendingConfig 完成安装。',
  ].join('\n')
  return createToolExecutionOutput(text, {
    shape: 'json',
    data: {
      needsConfirmation: true,
      pendingConfig: resolved.pendingConfig,
      packageName: resolved.packageName,
      runner: resolved.runner,
      riskNotes,
    },
  })
}
