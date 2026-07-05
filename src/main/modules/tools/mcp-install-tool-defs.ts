/**
 * LLM-facing tool defs for the `mcp_install` capability group（Phase M）。
 *
 * Single tool: `install_mcp_server` — 非专业用户对 agent 说「帮我装个 XX 的
 * MCP」时的前门。命名同 install_skill 策略：不带 `mcp_` 前缀（那是外部 MCP
 * 工具的 dispatch / 确认闸保留前缀），不带 `skill_` 前缀（不受 skill
 * authorization 剥离）。
 *
 * Schema 手写：描述是承重件——必须教会模型两阶段确认合同（绝不未经用户
 * 确认写配置）与 npx/uvx 白名单边界（代码强制，模型只做包名判断题）。
 */

import {
  normalizeAnthropicToolSchema,
  normalizeOpenAIToolSchema,
} from './tool-schema'

export const MCP_INSTALL_TOOL_NAMES: readonly string[] = [
  'install_mcp_server',
] as const

const INSTALL_MCP_SERVER_DESCRIPTION = [
  '当用户希望「安装 / 接入 / 添加一个 MCP server」时使用（用户可能只说得出用途或名字，如"装个能读本地文件的 MCP"、"接一下 filesystem 那个 MCP"）。也支持 action=list（查看已配置的 server）和 action=remove（按 serverId 移除）。',
  '',
  '**安装是两阶段、必须经用户确认的流程，禁止一步到位：**',
  '',
  '阶段 1（解析，只读，绝不写配置）——调用 `install_mcp_server({ source })`。source 是 npm 包名（如 `@modelcontextprotocol/server-filesystem`）或 `uvx:<PyPI 包名>`（Python 系 server，如 `uvx:mcp-server-time`）。用户只描述用途时，由你先判断对应哪个官方/知名包再传入；不确定就先问用户或用搜索确认包名。可选 `serverId`（自定义 id）、`args`（server 附加参数，如 filesystem 的允许目录绝对路径——该目录将对 server 完全开放，必须让用户明确指定）。返回 `needsConfirmation:true` + `pendingConfig`（将写入的完整配置）+ `riskNotes`。',
  '',
  '阶段 1.5（强制确认）——用 `ask_user_questions` 把将要执行的命令（npx/uvx + 包名 + 参数）、riskNotes 逐条讲清楚让用户决定。绝不可替用户确认。',
  '',
  '阶段 2（写入并连接，需用户已批准）——仅当用户明确同意后，调用 `install_mcp_server({ confirmAck: true, pendingConfig })`，把阶段 1 返回的 `pendingConfig` 原样回传。宿主写入配置、启动 stdio 子进程、发现工具并返回工具清单；新工具从下一轮起可用（外部工具未声明只读的执行前仍会单独确认）。',
  '',
  '硬性安全约束（代码强制，违背会被机械拒绝）：',
  '- 命令白名单只有 npx（npm 包）与 uvx（PyPI 包）；任意其他命令/本地二进制/shell 一律拒绝——需要的话让用户在 设置 → MCP 手工编辑配置。',
  '- 需要 API key / 环境变量的 server：本工具不接受 env（避免密钥走对话明文）；安装后告诉用户在 设置 → MCP 的配置里补 env 字段。',
  '- 没走完阶段 1 + 用户确认，绝不调用带 `confirmAck:true` 的阶段 2。',
  '',
  '不要使用此工具的场景：用户要装的是「技能 / skill」（用 install_skill）；或用户要的是浏览器/文件等 Ready 内置能力（无需安装）。',
].join('\n')

const PENDING_CONFIG_SCHEMA = {
  type: 'object',
  description: '阶段 2 回传的配置对象：把阶段 1 返回的 pendingConfig 原样带回。',
  properties: {
    id: { type: 'string', description: 'server id（小写字母数字与连字符）。' },
    command: { type: 'string', enum: ['npx', 'uvx'], description: '启动命令（白名单）。' },
    args: {
      type: 'array',
      items: { type: 'string' },
      description: '完整启动参数（npx 含 -y 与包名；uvx 含包名）。',
    },
  },
  required: ['id', 'command', 'args'],
  additionalProperties: false,
} as const

const INSTALL_MCP_SERVER_PARAMS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['install', 'list', 'remove'],
      description: '默认 install。list=查看已配置 server 与连接状态；remove=按 serverId 移除并重连。',
    },
    source: {
      type: 'string',
      description: '安装阶段 1：npm 包名（可带 @scope/），或 `uvx:<PyPI 包名>`。',
    },
    serverId: {
      type: 'string',
      description: '可选：自定义 server id（安装）；remove 时必填。',
    },
    args: {
      type: 'array',
      items: { type: 'string' },
      description: '可选：server 附加参数（如 filesystem 的允许目录绝对路径）。',
    },
    confirmAck: {
      type: 'boolean',
      description: '安装阶段 2 专用：用户已通过反问卡明确同意后置 true。',
    },
    pendingConfig: PENDING_CONFIG_SCHEMA,
  },
  required: [],
} as const

export function getMcpInstallAnthropicTools(): Array<Record<string, unknown>> {
  return [normalizeAnthropicToolSchema({
    name: 'install_mcp_server',
    description: INSTALL_MCP_SERVER_DESCRIPTION,
    input_schema: INSTALL_MCP_SERVER_PARAMS,
  })]
}

export function getMcpInstallOpenAITools(): Array<Record<string, unknown>> {
  return [normalizeOpenAIToolSchema({
    type: 'function',
    function: {
      name: 'install_mcp_server',
      description: INSTALL_MCP_SERVER_DESCRIPTION,
      parameters: INSTALL_MCP_SERVER_PARAMS,
    },
  })]
}
