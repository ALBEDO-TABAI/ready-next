/**
 * LLM-facing tool defs for the `command_exec` capability group（Phase M+）。
 *
 * Single tool: `run_setup_command` — agent 代用户跑一次性安装/配置命令
 * （飞书 CLI / 即梦 CLI 等）。命名无 mcp_/skill_ 前缀（不受对应授权域剥离）。
 *
 * Schema 手写：描述教会模型两阶段确认、device-code 授权合同 + "命令不经
 * shell、程序名放 command、参数逐个放 args" 的形状约束（模型只做判断题，
 * 确认与注入防护靠代码）。
 */

import {
  normalizeAnthropicToolSchema,
  normalizeOpenAIToolSchema,
} from './tool-schema'

export const SETUP_COMMAND_TOOL_NAMES: readonly string[] = [
  'run_setup_command',
] as const

const RUN_SETUP_COMMAND_DESCRIPTION = [
  '当用户明确要求你代为运行一条一次性的安装/配置命令行工具时使用——例如飞书 CLI `npx @larksuite/cli@latest install`、即梦 CLI、某工具的 setup/login 脚本等。这是跑完即退的一次性命令，区别于 install_mcp_server（那是接入常驻的 MCP server）与 install_skill（那是装 Ready 技能）。',
  '',
  '**这是两阶段、必须经用户确认的工具，禁止一步到位执行：**',
  '',
  '阶段 1（解析，只展示不执行）——调用 `run_setup_command({ command, args })`。**命令不经 shell 执行**：把可执行程序名放 `command`（如 `npx`），把每个参数**逐个**放进 `args` 数组（如 `["@larksuite/cli@latest", "install"]`），不要把整条命令拼成一个字符串。可选 `cwd`（工作目录绝对路径，默认用户家目录）。返回 `needsConfirmation:true` + 完整命令预览 + `riskNotes`。',
  '',
  '阶段 2（Ready 确认卡后执行）——调用 `run_setup_command({ confirmAck: true, command, args, cwd })`，把阶段 1 的 command/args/cwd 原样回传。`confirmAck` 只表示进入执行阶段，不代表用户已经授权；代码会冻结完整调用并显示 Ready 行动确认卡，用户确认后才执行。不要另建一张 `ask_user_questions` 卡重复确认命令。',
  '',
  '浏览器授权流程——优先使用 CLI 提供的非阻塞 JSON/device-code 模式。飞书 CLI 使用 `lark-cli auth login --scope <scopes> --no-wait --json`；工具返回 `authorizationRequired:true` 后，把 `authorizationUrl` 原样发给用户（Ready 中可点击），用 `ask_user_questions` 等待用户完成授权，再按返回的 `resumeArgs` 或 `lark-cli auth login --device-code <deviceCode>` 重新走阶段 1/2。不要重复创建新的 device code。',
  '',
  'CLI 高风险确认——退出码 10 且 JSON 为 `confirmation_required` 时，工具不会自动重试，而会返回 `retryArgs`（含 `--yes`）和风险说明。只有用户决定继续时，才把 retryArgs 重新走阶段 1/2；新的执行仍由 Ready 行动确认卡放行。',
  '',
  '硬性约束：',
  '- command 里不能含 shell 元字符（$ ` ; | & 等）——命令不经 shell，元字符不会被解释，出现即说明你把 shell 拼进了 command 位，会被拒绝。把程序放 command、参数放 args。',
  '- 依赖键盘输入、账号密码或 TTY 的传统交互命令本工具无法应答：子进程 stdin 已关闭（立即 EOF），这类命令会快速失败或超时并回显它停在什么提示上——把该输出转告用户、请其在终端自行执行，不要原样重试。浏览器跳转授权不属于这个限制，应使用上面的 device-code 流程。',
  '- 阶段 1 未返回有效预览时，绝不调用带 `confirmAck:true` 的阶段 2；也绝不把模型生成的 confirmAck 当作用户授权。',
  '',
  '不要使用的场景：接入 MCP server（用 install_mcp_server）；装 Ready 技能（用 install_skill）；纯读文件/查信息（用对应的只读工具）。',
].join('\n')

const RUN_SETUP_COMMAND_PARAMS = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: '可执行程序名或绝对路径（如 npx / uvx / /usr/local/bin/xxx）。不含 shell 元字符。',
    },
    args: {
      type: 'array',
      items: { type: 'string' },
      description: '参数数组，每个参数一项（如 ["@larksuite/cli@latest", "install"]）。不要拼成一整条命令。',
    },
    cwd: {
      type: 'string',
      description: '可选：工作目录绝对路径，默认用户家目录。',
    },
    timeoutMs: {
      type: 'number',
      description: '可选：执行超时毫秒数，默认 180000，上限 600000。',
    },
    confirmAck: {
      type: 'boolean',
      description: '阶段 2 专用：置 true 后进入代码侧 Ready 行动确认卡；此字段本身不是用户授权凭证。',
    },
  },
  required: ['command'],
} as const

export function getSetupCommandAnthropicTools(): Array<Record<string, unknown>> {
  return [normalizeAnthropicToolSchema({
    name: 'run_setup_command',
    description: RUN_SETUP_COMMAND_DESCRIPTION,
    input_schema: RUN_SETUP_COMMAND_PARAMS,
  })]
}

export function getSetupCommandOpenAITools(): Array<Record<string, unknown>> {
  return [normalizeOpenAIToolSchema({
    type: 'function',
    function: {
      name: 'run_setup_command',
      description: RUN_SETUP_COMMAND_DESCRIPTION,
      parameters: RUN_SETUP_COMMAND_PARAMS,
    },
  })]
}
