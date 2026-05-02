/**
 * Handler for `skill_run_shell`.
 *
 * Phase 1 design: simple commands are split into argv and spawned directly.
 * Real skill docs also contain common shell-style snippets (`cd`, `$VAR`,
 * `&&`, pipes, redirection), so those are routed through `bash -c` while
 * keeping an explicit deny-list for destructive file commands.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { createToolExecutionOutput, type ToolExecutionOutput } from '../../agent-control/tool-result-types'
import { ToolDomainError } from '../tool-errors'
import { logAgentMetric } from '../../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../../agent-control/tool-error-metrics'
import { defaultLookupSkillRoots, type LookupSkillRoots } from './root-resolver'

const STDOUT_LIMIT = 8_192
const DEFAULT_TIMEOUT_MS = 60_000
const HARD_CAP_TIMEOUT_MS = 600_000
/** Grace period between SIGTERM and SIGKILL when killing a runaway child. */
const SIGKILL_ESCALATION_MS = 5_000

export const SHELL_ALLOWLIST: ReadonlySet<string> = new Set([
  'python',
  'python3',
  'node',
  'bash',
  'sh',
  'curl',
  'cat',
  'ls',
  'head',
  'tail',
  'grep',
  'find',
  'which',
  'mkdir',
  'pwd',
  'echo',
  'awk',
  'sed',
])

const SINGLE_QUOTE_SHELL_COMPAT_BINS: ReadonlySet<string> = new Set([
  'python',
  'python3',
  'node',
  'grep',
  'find',
  'awk',
  'sed',
])

export interface RunShellArgs {
  command: string
  timeoutMs?: number
  stdin?: string
}

export interface RunShellHandlerDeps {
  skillId: string
  signal?: AbortSignal
  lookupSkillRoots?: LookupSkillRoots
  runtimeBinDir?: string | null
  venvBinDir?: string | null
  // Test injection — swap the actual spawn for a mock.
  spawnFn?: typeof spawn
  /**
   * B-arch-4 — effective allowlist for the current session. Computed by the
   * dispatcher (skills-tools.ts) via
   * `SkillHostController.getEffectiveShellAllowlist(sessionId, refSkillId,
   * SHELL_ALLOWLIST, hostRequirements)` so a reference-skill that declares
   * `shell_allowlist_extensions` in host_requirements gets those commands
   * temporarily honored. Defaults to `SHELL_ALLOWLIST` when omitted (the
   * common case for tests + non-skill code paths).
   */
  effectiveAllowlist?: ReadonlySet<string>
}

interface ParsedCommand {
  bin: string
  args: string[]
}

function shouldUseShell(command: string): boolean {
  const trimmed = command.trim()
  const startsWithShell = /^(bash|sh)\s+/i.test(trimmed)
  if (startsWithShell && trimmed.includes("'")) return true
  if (startsWithShell) return false
  if (trimmed.includes("'") && SINGLE_QUOTE_SHELL_COMPAT_BINS.has((trimmed.match(/^\S+/)?.[0] || '').toLowerCase())) {
    return true
  }
  return /^\s*cd(?:\s|$)/.test(trimmed)
    || /\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}]+\}/.test(trimmed)
    || /&&|\|\||[|;<>]/.test(trimmed)
    || /\\\s/.test(trimmed)
}

function findDeniedShellCommand(command: string): string | null {
  const matched = command.match(/(?:^|[;&|]\s*|\|\|\s*|&&\s*)(?:sudo\s+)?(rm|cp|mv)\b/)
    || command.match(/-exec\s+(?:sudo\s+)?(rm|cp|mv)\b/)
  return matched?.[1] || null
}

function assertShellCommandAllowed(command: string): void {
  const denied = findDeniedShellCommand(command)
  if (!denied) return
  logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
    primitive: 'skill_run_shell',
    reason: 'cmd_not_allowlisted',
    bin: denied,
  })
  throw new ToolDomainError(
    'cmd_not_allowlisted',
    `skill_run_shell: command "${denied}" is not allowed inside shell snippets.`,
    { bin: denied, allowlist: Array.from(SHELL_ALLOWLIST) },
  )
}

/**
 * Surfaces a distinct failure when the minimal tokenizer sees syntax it
 * deliberately refuses (single quotes, unbalanced double quotes). Callers
 * convert this into a `command_parse_failed` ToolDomainError so the LLM gets
 * a clear signal rather than a half-mangled argv.
 */
export class CommandParseError extends Error {
  constructor(public readonly reason: 'single_quote' | 'unbalanced_quote', message: string) {
    super(message)
    this.name = 'CommandParseError'
  }
}

/**
 * Minimal whitespace-split tokenizer. Respects double quotes so paths with
 * spaces still work. Explicitly refuses POSIX single-quote quoting and
 * unbalanced double quotes instead of silently mangling argv.
 */
export function parseCommand(command: string): ParsedCommand | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  if (trimmed.includes("'")) {
    throw new CommandParseError(
      'single_quote',
      "skill_run_shell.command does not support POSIX single-quote quoting; use double quotes for arguments that contain spaces.",
    )
  }
  const tokens: string[] = []
  let current = ''
  let inQuote = false
  for (const ch of trimmed) {
    if (ch === '"') {
      inQuote = !inQuote
      continue
    }
    if (!inQuote && /\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (inQuote) {
    throw new CommandParseError(
      'unbalanced_quote',
      'skill_run_shell.command contains an unbalanced double quote.',
    )
  }
  if (current) tokens.push(current)
  if (tokens.length === 0) return null
  const [bin, ...args] = tokens
  return { bin, args }
}

function buildEnv(
  env: NodeJS.ProcessEnv,
  roots: { assetRoot: string; artifactRoot: string },
  runtimeBinDir?: string | null,
  venvBinDir?: string | null,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env }
  next.CLAUDE_SKILL_DIR = roots.assetRoot
  next.CLAUDE_SKILL_OUTPUT_DIR = roots.artifactRoot
  if (runtimeBinDir || venvBinDir) {
    const sep = process.platform === 'win32' ? ';' : ':'
    next.PATH = [runtimeBinDir, venvBinDir, env.PATH || ''].filter(Boolean).join(sep)
  }
  return next
}

function truncate(buffer: string): { text: string; truncated: boolean } {
  if (buffer.length <= STDOUT_LIMIT) return { text: buffer, truncated: false }
  return { text: buffer.slice(0, STDOUT_LIMIT), truncated: true }
}

interface OverflowResult {
  path: string | null
  error: string | null
}

function writeOverflowArtifact(artifactRoot: string, streamLabel: string, fullText: string): OverflowResult {
  try {
    const logsDir = join(artifactRoot, '.logs')
    mkdirSync(logsDir, { recursive: true })
    const name = `shell-${Date.now()}-${randomUUID().slice(0, 8)}-${streamLabel}.txt`
    const abs = join(logsDir, name)
    writeFileSync(abs, fullText, 'utf-8')
    return { path: abs, error: null }
  } catch (err) {
    return { path: null, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function executeRunShell(
  args: RunShellArgs,
  deps: RunShellHandlerDeps,
): Promise<ToolExecutionOutput> {
  const lookup = deps.lookupSkillRoots || defaultLookupSkillRoots
  const roots = lookup(deps.skillId)
  if (!roots) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_run_shell',
      reason: 'missing_skill',
      skillId: deps.skillId || null,
    })
    throw new ToolDomainError(
      'missing_skill',
      `Skill "${deps.skillId}" is not registered; cannot resolve shell cwd.`,
      { skillId: deps.skillId || null },
    )
  }

  let parsed: ParsedCommand | null
  if (shouldUseShell(args.command)) {
    assertShellCommandAllowed(args.command)
    parsed = { bin: 'bash', args: ['-c', args.command] }
  } else {
    try {
      parsed = parseCommand(args.command)
    } catch (error) {
      if (error instanceof CommandParseError) {
        logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
          primitive: 'skill_run_shell',
          reason: 'command_parse_failed',
          detail: error.reason,
        })
        throw new ToolDomainError('command_parse_failed', error.message, { detail: error.reason })
      }
      throw error
    }
  }
  if (!parsed) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_run_shell',
      reason: 'command_empty',
    })
    throw new ToolDomainError('command_empty', 'skill_run_shell.command is empty after tokenization.')
  }

  // B-arch-4 — when the dispatcher passes an `effectiveAllowlist` (computed
  // from the active reference-skill's host_requirements.shell_allowlist_extensions),
  // honor it; otherwise fall back to the Phase 1 base allowlist. The metric
  // payload still surfaces the FULL allowlist the model was checked against so
  // operators can debug why a command was rejected.
  const allowlistInUse = deps.effectiveAllowlist ?? SHELL_ALLOWLIST
  if (!allowlistInUse.has(parsed.bin)) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_run_shell',
      reason: 'cmd_not_allowlisted',
      bin: parsed.bin,
    })
    throw new ToolDomainError(
      'cmd_not_allowlisted',
      `skill_run_shell: command "${parsed.bin}" is not in the Phase 1 allowlist.`,
      { bin: parsed.bin, allowlist: Array.from(allowlistInUse) },
    )
  }

  if (!existsSync(roots.assetRoot)) {
    throw new ToolDomainError(
      'missing_skill',
      `Skill asset root ${roots.assetRoot} does not exist on disk.`,
      { assetRoot: roots.assetRoot },
    )
  }

  // Ensure artifactRoot exists so CLAUDE_SKILL_OUTPUT_DIR is always valid.
  mkdirSync(roots.artifactRoot, { recursive: true })

  const timeoutMs = Math.min(
    typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS,
    HARD_CAP_TIMEOUT_MS,
  )

  const env = buildEnv(process.env, roots, deps.runtimeBinDir, deps.venvBinDir)
  const spawnFn = deps.spawnFn || spawn
  const started = Date.now()

  let stdout = ''
  let stderr = ''
  let timedOut = false
  let aborted = false
  // On Unix we want to create a new process group so `kill(-pid)` can reap
  // grandchildren spawned by bash/sh wrappers. Windows doesn't support
  // detached in the same way — `child.kill('SIGTERM')` with `/T /F` semantics
  // is approximated via taskkill below if needed.
  const useProcessGroup = process.platform !== 'win32'
  const child = spawnFn(parsed.bin, parsed.args, {
    cwd: roots.assetRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: useProcessGroup,
  })

  if (args.stdin != null && child.stdin) {
    child.stdin.write(args.stdin)
    child.stdin.end()
  } else if (child.stdin) {
    child.stdin.end()
  }

  child.stdout?.setEncoding('utf-8')
  child.stderr?.setEncoding('utf-8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })

  let sigkillTimer: NodeJS.Timeout | null = null
  const terminateChild = (signal: NodeJS.Signals = 'SIGTERM') => {
    if (child.killed) return
    try {
      if (useProcessGroup && typeof child.pid === 'number') {
        // Negative pid -> process group; kills grandchildren too.
        process.kill(-child.pid, signal)
      } else {
        child.kill(signal)
      }
    } catch {
      /* child already exited or pgid missing — fall through */
    }
  }
  const scheduleSigkillEscalation = () => {
    if (sigkillTimer) return
    sigkillTimer = setTimeout(() => {
      if (!child.killed) terminateChild('SIGKILL')
    }, SIGKILL_ESCALATION_MS)
  }

  const timer = setTimeout(() => {
    timedOut = true
    terminateChild('SIGTERM')
    scheduleSigkillEscalation()
  }, timeoutMs)

  const onAbort = () => {
    aborted = true
    terminateChild('SIGTERM')
    scheduleSigkillEscalation()
  }
  if (deps.signal) {
    if (deps.signal.aborted) onAbort()
    else deps.signal.addEventListener('abort', onAbort, { once: true })
  }

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? -1))
  }).finally(() => {
    clearTimeout(timer)
    if (sigkillTimer) clearTimeout(sigkillTimer)
    if (deps.signal) deps.signal.removeEventListener('abort', onAbort)
  }) as number

  const durationMs = Date.now() - started

  const stdoutSafe = truncate(stdout)
  const stderrSafe = truncate(stderr)
  const stdoutArtifact: OverflowResult = stdoutSafe.truncated
    ? writeOverflowArtifact(roots.artifactRoot, 'stdout', stdout)
    : { path: null, error: null }
  const stderrArtifact: OverflowResult = stderrSafe.truncated
    ? writeOverflowArtifact(roots.artifactRoot, 'stderr', stderr)
    : { path: null, error: null }
  if (stdoutArtifact.error) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_run_shell',
      reason: 'overflow_artifact_write_failed',
      stream: 'stdout',
      error: stdoutArtifact.error,
    })
  }
  if (stderrArtifact.error) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_run_shell',
      reason: 'overflow_artifact_write_failed',
      stream: 'stderr',
      error: stderrArtifact.error,
    })
  }

  if (aborted) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_run_shell',
      reason: 'aborted',
      durationMs,
    })
    throw new ToolDomainError('aborted', 'skill_run_shell was aborted.', { durationMs })
  }

  if (timedOut) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_run_shell',
      reason: 'timeout',
      timeoutMs,
      durationMs,
    })
    throw new ToolDomainError(
      'timeout',
      `skill_run_shell timed out after ${timeoutMs}ms.`,
      { bin: parsed.bin, timeoutMs, durationMs },
    )
  }

  logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveUsed, {
    primitive: 'skill_run_shell',
    skillId: roots.skillId,
    bin: parsed.bin,
    exitCode,
    durationMs,
    stdoutTruncated: stdoutSafe.truncated,
    stderrTruncated: stderrSafe.truncated,
  })

  const textLines: string[] = [
    `exitCode=${exitCode} durationMs=${durationMs}`,
  ]
  if (stdoutSafe.text) textLines.push('STDOUT:', stdoutSafe.text)
  if (stderrSafe.text) textLines.push('STDERR:', stderrSafe.text)
  if (stdoutSafe.truncated) {
    textLines.push(
      stdoutArtifact.path
        ? `(stdout truncated; full log at ${stdoutArtifact.path})`
        : `(stdout truncated; overflow log write failed: ${stdoutArtifact.error})`,
    )
  }
  if (stderrSafe.truncated) {
    textLines.push(
      stderrArtifact.path
        ? `(stderr truncated; full log at ${stderrArtifact.path})`
        : `(stderr truncated; overflow log write failed: ${stderrArtifact.error})`,
    )
  }

  return createToolExecutionOutput(textLines.join('\n'), {
    shape: 'json',
    data: {
      exitCode,
      durationMs,
      stdout: stdoutSafe.text,
      stderr: stderrSafe.text,
      stdoutTruncated: stdoutSafe.truncated,
      stderrTruncated: stderrSafe.truncated,
      stdoutArtifactPath: stdoutArtifact.path,
      stderrArtifactPath: stderrArtifact.path,
      stdoutArtifactError: stdoutArtifact.error,
      stderrArtifactError: stderrArtifact.error,
      command: { bin: parsed.bin, args: parsed.args },
    },
  })
}
