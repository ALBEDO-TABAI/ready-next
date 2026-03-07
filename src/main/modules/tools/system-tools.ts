import { appendFileSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const LOG = '/tmp/ready-system-tools.log'

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
