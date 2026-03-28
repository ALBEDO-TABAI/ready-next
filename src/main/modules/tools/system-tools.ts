import { appendFileSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getLogPath } from '../../utils/platform'
import { getSkillsRuntimeManager } from '../skills-runtime/runtime-manager'

const execFileAsync = promisify(execFile)
const LOG = getLogPath('ready-system-tools.log')

function log(msg: string) {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`) } catch { /* */ }
}

interface ToolParam {
  name: string
  type: string
  description: string
  required: boolean
  enum?: string[]
}

interface SystemToolDef {
  name: string
  description: string
  params: ToolParam[]
}

const SYSTEM_TOOLS: SystemToolDef[] = [
  {
    name: 'system_run_embedded_python',
    description: '使用 Ready 内置的 skills runtime Python 执行代码或脚本。优先用于手动控制 skill 阶段、检查文件或运行辅助 Python 逻辑。',
    params: [
      { name: 'code', type: 'string', description: '可选，直接执行的 Python 代码', required: false },
      { name: 'scriptPath', type: 'string', description: '可选，要执行的 Python 脚本绝对路径', required: false },
      { name: 'args', type: 'array', description: '可选，脚本参数数组', required: false },
      { name: 'cwd', type: 'string', description: '可选，执行目录', required: false },
      { name: 'timeoutMs', type: 'number', description: '可选，超时时间毫秒', required: false },
    ],
  },
  {
    name: 'system_run_openclaw',
    description: '执行本地 openclaw 配对/插件命令。当前仅允许 openclaw pairing 子命令，用于批准飞书等插件配对请求。',
    params: [
      { name: 'command', type: 'string', description: '完整命令，例如 openclaw pairing approve feishu FNXQH9PN', required: true },
    ],
  },
]

function toSchemaParam(param: ToolParam): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: param.type,
    description: param.description,
  }
  if (param.type === 'array') {
    schema.items = { type: 'string' }
  }
  if (param.type === 'object') {
    schema.additionalProperties = true
  }
  if (param.enum) schema.enum = param.enum
  return schema
}

export function getSystemAnthropicTools(): Array<Record<string, unknown>> {
  return SYSTEM_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map((param) => [param.name, toSchemaParam(param)])),
      required: tool.params.filter((param) => param.required).map((param) => param.name),
    },
  }))
}

export function getSystemOpenAITools(): Array<Record<string, unknown>> {
  return SYSTEM_TOOLS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(tool.params.map((param) => [param.name, toSchemaParam(param)])),
        required: tool.params.filter((param) => param.required).map((param) => param.name),
      },
    },
  }))
}

function tokenizeCommand(command: string): string[] {
  return String(command || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

async function resolveOpenclawPath(): Promise<string> {
  const candidates = [
    process.env.OPENCLAW_BIN,
    `${process.env.HOME || ''}/.npm-global/bin/openclaw`,
    'openclaw',
  ].filter((item): item is string => Boolean(item && item.trim()))

  for (const candidate of candidates) {
    try {
      if (candidate === 'openclaw') {
        const { stdout } = await execFileAsync(process.env.SHELL || '/bin/zsh', ['-lc', 'command -v openclaw'], {
          timeout: 5_000,
        })
        const resolved = stdout.trim()
        if (resolved) return resolved
      } else {
        await execFileAsync(candidate, ['--help'], { timeout: 5_000, maxBuffer: 256 * 1024 })
        return candidate
      }
    } catch {
      // try next
    }
  }
  throw new Error('openclaw command not found')
}

function validateOpenclawArgs(args: string[]): void {
  if (args.length < 2) throw new Error('openclaw command is empty')
  if (args[0] !== 'openclaw') throw new Error('only openclaw command is allowed')
  if (args[1] !== 'pairing') throw new Error('only openclaw pairing subcommands are allowed')
  if (args.some((arg) => /[;&|><`$]/.test(arg))) {
    throw new Error('unsafe shell characters are not allowed')
  }
}

export async function executeSystemTool(toolName: string, args: Record<string, unknown>): Promise<string> {
  if (toolName === 'system_run_embedded_python') {
    const manager = getSkillsRuntimeManager()
    const result = await manager.runEmbeddedPython({
      code: typeof args.code === 'string' ? args.code : undefined,
      scriptPath: typeof args.scriptPath === 'string' ? args.scriptPath : undefined,
      args: Array.isArray(args.args) ? args.args.map((item) => String(item)) : undefined,
      cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
    })
    if (!result.success) {
      return `Embedded Python failed.\n${[result.error, result.stderr, result.stdout].filter(Boolean).join('\n')}`.trim()
    }
    return [
      result.command.length > 0 ? `Command: ${result.command.join(' ')}` : '',
      result.stdout ? `STDOUT:\n${result.stdout}` : '',
      result.stderr ? `STDERR:\n${result.stderr}` : '',
    ].filter(Boolean).join('\n\n') || 'Embedded Python completed.'
  }

  if (toolName !== 'system_run_openclaw') {
    return `Unknown system tool: ${toolName}`
  }

  const command = String(args.command || '').trim()
  if (!command) return 'Missing command'

  const tokens = tokenizeCommand(command)
  validateOpenclawArgs(tokens)

  const openclawPath = await resolveOpenclawPath()
  const subArgs = tokens.slice(1)
  log(`run ${openclawPath} ${subArgs.join(' ')}`)
  try {
    const { stdout, stderr } = await execFileAsync(openclawPath, subArgs, {
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    const output = `${stdout || ''}${stderr || ''}`.trim()
    return output || 'openclaw command completed'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`error ${message}`)
    if (/No pending pairing request found for code:/i.test(message)) {
      return [
        '飞书配对失败：当前没有找到这枚配对码对应的待批准请求。',
        '这通常表示配对码已过期、已被消费，或者飞书侧还没有成功发起新的 pairing 请求。',
        '请先在飞书侧重新发起配对，再把新的完整命令发送给 agent。',
        '你也可以先在终端确认当前待批准请求：openclaw pairing list feishu',
      ].join('\n')
    }
    return `openclaw command failed: ${message}`
  }
}
