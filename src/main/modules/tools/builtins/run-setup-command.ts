/**
 * Phase M+（2026-07-05）—— `run_setup_command`：agent 代用户跑一次性
 * 安装/配置命令（飞书 CLI `npx @larksuite/cli@latest install`、即梦 CLI 等）。
 *
 * 与 install_mcp_server 的本质区别：MCP server 是常驻 stdio 进程（写进配置、
 * reload spawn）；这里是**跑完即退**的一次性命令。用户明确授权"任意命令 +
 * 用户确认"（设备主人对本地开发工具的合法授权），安全形状由代码承担：
 *   - 命令**不经 shell**：`{ command, args[] }` 数组式直接 spawn，元字符
 *     ($ ` ; | & 等) 不被解释——从根上消除 shell 注入，args 里出现它们
 *     也只是普通字面量传给子进程；
 *   - 两阶段确认：阶段 1 只展示完整命令 + 风险，绝不执行；阶段 2 必须
 *     confirmAck + 回传阶段 1 的 command/args（重新校验形状）；
 *   - 超时 + 输出上限：默认 180s，stdout/stderr 各截 8KB 回给模型；
 *   - 工作目录默认家目录，可指定绝对路径（存在性校验）。
 *
 * 确认是硬闸门（阶段 2），命令行对用户完全可见——这是"人在回路"的实处。
 */

import { spawn } from 'child_process'
import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute } from 'path'

import { ToolDomainError } from '../tool-errors'
import { SETUP_COMMAND_ERROR_KINDS } from '../../agent-control/contracts/error-kinds'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../../agent-control/tools-runtime/tool-result-types'

export const SETUP_COMMAND_TOOL_NAMES = ['run_setup_command'] as const

const DEFAULT_TIMEOUT_MS = 180_000
const MAX_TIMEOUT_MS = 600_000
const OUTPUT_CAP_BYTES = 8 * 1024
// 命令名（arg0）里出现 shell 元字符 = 模型试图把整条 shell 塞进 command 位
const COMMAND_METACHAR_RE = /[;&|`$<>(){}\n\r]/

export interface SetupCommandDescriptor {
  command: string
  args: string[]
  cwd?: string
}

export interface RunSetupCommandDeps {
  /** 测试注入：替换真实 spawn 执行。 */
  runProcess?: (descriptor: Required<Pick<SetupCommandDescriptor, 'command' | 'args' | 'cwd'>>, timeoutMs: number, abortSignal?: AbortSignal) => Promise<{
    code: number | null
    signal: string | null
    stdout: string
    stderr: string
    spawnError?: string
    timedOut?: boolean
  }>
  /** 执行器传入：用户停止 run 时必须连带杀掉命令进程树。 */
  abortSignal?: AbortSignal
}

function validateCommandName(command: string): string {
  const value = String(command || '').trim()
  if (!value) {
    throw new ToolDomainError(
      SETUP_COMMAND_ERROR_KINDS.invalidCommand.code,
      'run_setup_command 需要 command（可执行程序名或绝对路径，如 npx / uvx）。',
    )
  }
  if (COMMAND_METACHAR_RE.test(value)) {
    throw new ToolDomainError(
      SETUP_COMMAND_ERROR_KINDS.invalidCommand.code,
      `command 含 shell 元字符（${value.slice(0, 60)}）——命令不经 shell 执行，请把程序名放 command、每个参数放进 args 数组，不要拼成一整条 shell。`,
    )
  }
  return value
}

function validateArgs(rawArgs: unknown): string[] {
  if (rawArgs === undefined || rawArgs === null) return []
  if (!Array.isArray(rawArgs)) {
    throw new ToolDomainError(
      SETUP_COMMAND_ERROR_KINDS.invalidCommand.code,
      'args 必须是字符串数组（每个参数一项），不要拼成一整条命令。',
    )
  }
  return rawArgs.map((item) => String(item))
}

function validateCwd(rawCwd: unknown): string {
  const value = String(rawCwd || '').trim()
  if (!value) return homedir()
  if (!isAbsolute(value)) {
    throw new ToolDomainError(
      SETUP_COMMAND_ERROR_KINDS.invalidCommand.code,
      `cwd 必须是绝对路径（收到：${value.slice(0, 80)}）。`,
    )
  }
  if (!existsSync(value) || !statSync(value).isDirectory()) {
    throw new ToolDomainError(
      SETUP_COMMAND_ERROR_KINDS.invalidCommand.code,
      `工作目录不存在或不是目录：${value.slice(0, 120)}。`,
    )
  }
  return value
}

function resolveDescriptor(raw: Record<string, unknown>): SetupCommandDescriptor {
  const command = validateCommandName(String(raw.command || ''))
  const args = validateArgs(raw.args)
  const cwd = validateCwd(raw.cwd)
  return { command, args, cwd }
}

function commandLineOf(descriptor: SetupCommandDescriptor): string {
  return [descriptor.command, ...descriptor.args].join(' ')
}

async function defaultRunProcess(
  descriptor: Required<Pick<SetupCommandDescriptor, 'command' | 'args' | 'cwd'>>,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string; spawnError?: string; timedOut?: boolean }> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const child = spawn(descriptor.command, descriptor.args, {
      cwd: descriptor.cwd,
      env: process.env,
      // 关键 1：不经 shell。数组式参数直接传子进程，元字符不被解释。
      shell: false,
      // 关键 2：stdin 立即 EOF。交互式命令（config init 之类等键盘输入的）
      // 读到 EOF 会立刻退出/报错，而不是挂在提示符上等到超时——Ready 的
      // 产品边界是「识别交互式命令并让用户去终端」，不是模拟终端。
      stdio: ['ignore', 'pipe', 'pipe'],
      // 关键 3：独立进程组。npx/包装器会再 spawn 真正的 CLI 孙进程，只杀
      // 直接子进程会留下孤儿（副作用继续跑、还握着 stdout 管道）。
      detached: process.platform !== 'win32',
    })
    const killTree = (signal: NodeJS.Signals): void => {
      // 组信号覆盖孙进程；组杀不可用（win32/已退出）降级单杀。
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        try { child.kill(signal) } catch { /* silent-catch: 进程已自退，ESRCH 无害 */ }
      }
    }
    const onAbort = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killTree('SIGKILL')
      const error = new Error('setup command aborted by user')
      error.name = 'AbortError'
      reject(error)
    }
    if (abortSignal) {
      if (abortSignal.aborted) { onAbort(); return }
      abortSignal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree('SIGKILL')
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP_BYTES) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP_BYTES) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      abortSignal?.removeEventListener('abort', onAbort)
      resolve({ code: null, signal: null, stdout, stderr, spawnError: error instanceof Error ? error.message : String(error) })
    })
    // 关键 4：settle 在 'exit' 而不是 'close'。'close' 要等 stdio 排空——
    // 存活的孙进程握着管道时它永远不来，超时杀掉直接子进程后 Promise 依然
    // 悬死（真机复测抓到的卡死形态）。'exit' 在进程终止即触发；此刻已捕获
    // 的 stdout/stderr 足够诊断。
    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      abortSignal?.removeEventListener('abort', onAbort)
      resolve({
        code,
        signal: signal ? String(signal) : null,
        stdout: stdout.slice(0, OUTPUT_CAP_BYTES),
        stderr: stderr.slice(0, OUTPUT_CAP_BYTES),
        timedOut,
      })
    })
  })
}

export async function executeRunSetupCommand(
  rawArgs: Record<string, unknown>,
  deps: RunSetupCommandDeps = {},
): Promise<ToolExecutionOutput> {
  // ---- 阶段 2：确认后执行 ---------------------------------------------------
  if (rawArgs.confirmAck === true) {
    const descriptor = resolveDescriptor(rawArgs)
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(5_000, Number(rawArgs.timeoutMs) || DEFAULT_TIMEOUT_MS),
    )
    const run = deps.runProcess ?? defaultRunProcess
    const result = await run({ command: descriptor.command, args: descriptor.args, cwd: descriptor.cwd! }, timeoutMs, deps.abortSignal)
    if (result.spawnError) {
      throw new ToolDomainError(
        SETUP_COMMAND_ERROR_KINDS.executionFailed.code,
        `无法启动命令：${result.spawnError}（命令：${commandLineOf(descriptor)}）。确认程序已安装、路径无误。`,
        { command: descriptor.command },
      )
    }
    if (result.timedOut) {
      // 带上已捕获的输出尾巴：模型必须能看见命令死前在干什么（比如停在
      // 交互提示符上），才能给用户「去终端执行」这类正确建议。
      const tailOf = (text: string): string => text.trim().slice(-600)
      const outputHint = [
        tailOf(result.stdout) ? `stdout 尾部：${tailOf(result.stdout)}` : '',
        tailOf(result.stderr) ? `stderr 尾部：${tailOf(result.stderr)}` : '',
      ].filter(Boolean).join('\n') || '（超时前无任何输出）'
      throw new ToolDomainError(
        SETUP_COMMAND_ERROR_KINDS.timedOut.code,
        `命令执行超时（>${Math.round(timeoutMs / 1000)}s）已终止进程树：${commandLineOf(descriptor)}。\n${outputHint}\n若输出停在提问/提示符上=交互式命令，请让用户在终端自行执行；如属正常的长时间安装，可加大 timeoutMs 重试一次。`,
        { command: descriptor.command, stdoutTail: tailOf(result.stdout), stderrTail: tailOf(result.stderr) },
      )
    }
    const ok = result.code === 0
    const tail = (label: string, text: string): string => {
      const trimmed = text.trim()
      return trimmed ? `\n${label}：\n${trimmed.slice(-1500)}` : ''
    }
    const text = `${ok ? '✅ 命令执行成功' : `⚠️ 命令退出码 ${result.code ?? result.signal ?? '未知'}`}：${commandLineOf(descriptor)}`
      + tail('stdout', result.stdout)
      + tail('stderr', result.stderr)
    return createToolExecutionOutput(text, {
      shape: 'json',
      data: {
        ok,
        exitCode: result.code,
        signal: result.signal,
        command: descriptor.command,
        args: descriptor.args,
        cwd: descriptor.cwd,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    })
  }

  // ---- 阶段 1：只读展示（绝不执行） ----------------------------------------
  const descriptor = resolveDescriptor(rawArgs)
  const commandLine = commandLineOf(descriptor)
  const riskNotes = [
    `将在本机执行命令（不经 shell，参数按原样传子进程）：${commandLine}`,
    `工作目录：${descriptor.cwd}`,
    '这类安装/配置命令可能下载并运行第三方代码、写入系统文件或修改工具链，需要用户确认这确实是他要装的工具。',
    '如命令需要交互式输入（登录、选择项），本工具无法应答——那种情况请让用户在终端自行执行。',
  ]
  const text = [
    `已解析（未执行）。命令：${commandLine}`,
    `风险提示：${riskNotes.join(' ')}`,
    '下一步：用 ask_user_questions 把完整命令与风险讲清楚让用户决定；用户明确同意后，用 run_setup_command({ confirmAck: true, command, args, cwd }) 原样回传完成执行。',
  ].join('\n')
  return createToolExecutionOutput(text, {
    shape: 'json',
    data: {
      needsConfirmation: true,
      command: descriptor.command,
      args: descriptor.args,
      cwd: descriptor.cwd,
      riskNotes,
    },
  })
}
