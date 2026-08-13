/**
 * Handler for `skill_run_shell`.
 *
 * Phase 1 design: simple commands are split into argv and spawned directly.
 * Real skill docs also contain common shell-style snippets (`cd`, `$VAR`,
 * `&&`, pipes, redirection), so those are routed through `bash -c` while
 * keeping an explicit deny-list for destructive file commands.
 */

import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

import { createToolExecutionOutput, type ToolExecutionOutput } from '../../agent-control/tools-runtime/tool-result-types'
import { ToolDomainError } from '../tool-errors'
import { logAgentMetric } from '../../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../../agent-control/tools-runtime/tool-error-metrics'
import { DESTRUCTIVE_SHELL_COMMANDS } from '../../../../shared/skill-host-contract'
import { auditBashCommand } from './bash-risk-patterns'
import { redactHostPaths } from './host-path-redactor'
import { defaultLookupSkillRoots, type LookupSkillRoots } from './root-resolver'
import {
  assertFrozenDesktopExecutableAuthority,
  DesktopExecutableAuthorityError,
  materializeFrozenDesktopExecutableSnapshot,
  type FrozenDesktopExecutableAuthority,
  type FrozenDesktopExecutableSnapshot,
} from '../../skills-runtime/desktop-executable-authority'
import { tokenizeLarkCliCommand } from '../../skills-runtime/lark-cli-argv'

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

const WRITE_SURFACE_SHELL_COMMANDS: ReadonlySet<string> = new Set([
  'tee',
  'truncate',
  'rsync',
  'install',
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
  baseEnv?: NodeJS.ProcessEnv
  runtimeBinDir?: string | null
  venvBinDir?: string | null
  /** Disable full-stream overflow files for commands whose stdout may contain ephemeral credentials. */
  persistOverflowArtifacts?: boolean
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
  executableAuthority?: FrozenDesktopExecutableAuthority
  requiredMethod?: Readonly<{
    methodId: string
    commandName: string
    executableAuthority: FrozenDesktopExecutableAuthority
    allowedArgv: readonly (readonly string[])[]
    expectedStdoutSha256?: string
  }>
  requiredMethodPreflight?: () => Promise<void>
  assertRequiredResourcesRead?: () => void
}

interface ParsedCommand {
  bin: string
  args: string[]
}

function shouldUseShell(command: string): boolean {
  const trimmed = command.trim()
  if (/^lark-cli(?:\s|$)/.test(trimmed)) return false
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
  const deniedAlt = [...DESTRUCTIVE_SHELL_COMMANDS, ...WRITE_SURFACE_SHELL_COMMANDS].join('|')
  const matched = command.match(new RegExp(`(?:^|[;&|]\\s*|\\|\\|\\s*|&&\\s*)(?:sudo\\s+)?(${deniedAlt})\\b`, 'i'))
    || command.match(new RegExp(`-exec\\s+(?:sudo\\s+)?(${deniedAlt})\\b`, 'i'))
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

function canonicalRoot(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    // silent-catch: nonexistent path canonicalizes lexically via resolve()
    return resolve(path)
  }
}

function isPathWithinRoot(root: string, targetPath: string): boolean {
  const rel = relative(canonicalRoot(root), resolve(targetPath))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function findOutsideSandboxRedirection(command: string, workspaceRoot: string): string | null {
  const redirectionPattern = /(?:^|[\s;&|])(?:\d*)>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g
  let match: RegExpExecArray | null
  while ((match = redirectionPattern.exec(command))) {
    const target = match[1] || match[2] || match[3] || ''
    if (!target || !isAbsolute(target)) continue
    if (!isPathWithinRoot(workspaceRoot, target)) return target
  }
  return null
}

function assertExplicitWritesStayInWorkspace(command: string, workspaceRoot: string): void {
  const outsideTarget = findOutsideSandboxRedirection(command, workspaceRoot)
  if (!outsideTarget) return
  logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
    primitive: 'skill_run_shell',
    reason: 'write_outside_sandbox',
    target: outsideTarget,
  })
  throw new ToolDomainError(
    'write_outside_sandbox',
    'skill_run_shell: explicit shell redirection must write inside CLAUDE_SKILL_OUTPUT_DIR.',
    { target: outsideTarget, workspaceRoot },
  )
}

const LARK_CLI_LOCAL_PATH_FLAGS = new Set([
  '-o',
  '--file', '--file-name', '--file-path', '--input-file', '--local-dir', '--local-file',
  '--output', '--output-dir', '--output-path',
])

function deepestExistingAncestorOrSelf(targetPath: string): string {
  let current = targetPath
  for (let index = 0; index < 64; index += 1) {
    if (existsSync(current)) return current
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

function assertLarkCliLocalPath(value: string, workspaceRoot: string): void {
  const trimmed = value.trim()
  const hasTraversal = trimmed.split(/[\\/]/).includes('..')
  if (!trimmed || isAbsolute(trimmed) || hasTraversal) {
    throw new ToolDomainError(
      'write_outside_sandbox',
      'skill_run_shell: Lark CLI local paths must be relative paths inside CLAUDE_SKILL_OUTPUT_DIR.',
      { target: value },
    )
  }
  const targetPath = resolve(workspaceRoot, trimmed)
  if (!isPathWithinRoot(workspaceRoot, targetPath)) {
    throw new ToolDomainError(
      'write_outside_sandbox',
      'skill_run_shell: Lark CLI local path escapes CLAUDE_SKILL_OUTPUT_DIR.',
      { target: value },
    )
  }
  const ancestor = deepestExistingAncestorOrSelf(targetPath)
  const realAncestor = realpathSync.native(ancestor)
  const projectedTarget = resolve(realAncestor, relative(ancestor, targetPath))
  if (!isPathWithinRoot(workspaceRoot, projectedTarget)
    || (existsSync(targetPath) && lstatSync(targetPath).isSymbolicLink())) {
    throw new ToolDomainError(
      'symlink_rejected',
      'skill_run_shell: Lark CLI local path must not traverse a symlink outside CLAUDE_SKILL_OUTPUT_DIR.',
      { target: value },
    )
  }
}

function assertLarkCliLocalPathsStayInWorkspace(args: readonly string[], workspaceRoot: string): void {
  args.forEach((token, index) => {
    if (token.startsWith('-o') && token !== '-o' && !token.startsWith('--')) {
      const compactOutput = token.slice(2).replace(/^=/, '')
      if (compactOutput) assertLarkCliLocalPath(compactOutput, workspaceRoot)
    }
    const equalsIndex = token.indexOf('=')
    const flag = equalsIndex > 0 ? token.slice(0, equalsIndex) : token
    if (LARK_CLI_LOCAL_PATH_FLAGS.has(flag)) {
      const value = equalsIndex > 0 ? token.slice(equalsIndex + 1) : args[index + 1]
      if (value) assertLarkCliLocalPath(value, workspaceRoot)
    }
    if (token.startsWith('@') && token !== '@-' && token.length > 1) {
      assertLarkCliLocalPath(token.slice(1), workspaceRoot)
    }
  })
}

/**
 * Surfaces a distinct failure when the minimal tokenizer sees syntax it
 * deliberately refuses (unsupported single quotes, unbalanced quotes). Callers
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
 * spaces still work. Lark CLI additionally accepts single-quoted JSON/XML as
 * a direct argv value; no shell is involved. Other programs retain the
 * existing single-quote rejection.
 */
export function parseCommand(command: string): ParsedCommand | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  const allowSingleQuotedArgv = /^lark-cli(?:\s|$)/.test(trimmed)
  if (allowSingleQuotedArgv) {
    const tokens = tokenizeLarkCliCommand(trimmed)
    if (!tokens) {
      throw new CommandParseError(
        'unbalanced_quote',
        'skill_run_shell.command contains invalid Lark CLI quoting or shell syntax.',
      )
    }
    const [bin, ...args] = tokens
    return { bin, args }
  }
  if (!allowSingleQuotedArgv && trimmed.includes("'")) {
    throw new CommandParseError(
      'single_quote',
      "skill_run_shell.command does not support POSIX single-quote quoting; use double quotes for arguments that contain spaces.",
    )
  }
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const ch of trimmed) {
    if (ch === '"' || (allowSingleQuotedArgv && ch === "'")) {
      if (quote === ch) quote = null
      else if (quote === null) quote = ch
      else current += ch
      continue
    }
    if (quote === null && /\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (quote !== null) {
    throw new CommandParseError(
      'unbalanced_quote',
      'skill_run_shell.command contains an unbalanced quote.',
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
  const pathKey = Object.keys(next).find((key) => key.toLowerCase() === 'path') || 'PATH'
  const inherited = String(next[pathKey] || '').split(delimiter).filter(Boolean)
  const standardDesktopBins = process.platform === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
    : process.platform === 'win32'
      ? []
      : ['/usr/local/bin', '/usr/bin', '/bin']
  next[pathKey] = [...new Set([
    runtimeBinDir,
    venvBinDir,
    ...inherited,
    ...standardDesktopBins,
  ].filter((entry): entry is string => Boolean(entry)))].join(delimiter)
  return next
}

function truncate(buffer: string): { text: string; truncated: boolean } {
  if (buffer.length <= STDOUT_LIMIT) return { text: buffer, truncated: false }
  return { text: buffer.slice(0, STDOUT_LIMIT), truncated: true }
}

function argvMatches(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function classifyRequiredMethodFailure(exitCode: number, stdout: string, stderr: string): string {
  if (exitCode === 10) return 'confirmation_required'
  const detail = `${stdout}\n${stderr}`
  if (/\b(?:401|unauthorized|login required|not authenticated|auth required|token expired)\b/i.test(detail)) {
    return 'auth_required'
  }
  if (/\b(?:403|forbidden|permission denied|access denied)\b/i.test(detail)) return 'permission_denied'
  if (/\b(?:404|not found|does not exist)\b/i.test(detail)) return 'not_found'
  if (/\b(?:429|rate limit|too many requests)\b/i.test(detail)) return 'rate_limited'
  if (/\b(?:econn|enotfound|socket|dns|network|timed?\s*out)\b/i.test(detail)) return 'network_error'
  if (/\b(?:500|502|503|504|upstream|service unavailable)\b/i.test(detail)) return 'upstream_error'
  return 'program_failed'
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
    // Stage T W7.3 (round 12 fix) — redact host paths BEFORE persisting the
    // overflow log so the on-disk artifact never carries `/Users/<name>`.
    const redacted = redactHostPaths(fullText)
    writeFileSync(abs, redacted, 'utf-8')
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
  if (!existsSync(roots.assetRoot)) {
    throw new ToolDomainError(
      'missing_skill',
      `Skill asset root ${roots.assetRoot} does not exist on disk.`,
      { assetRoot: roots.assetRoot },
    )
  }

  // Ensure artifactRoot exists so CLAUDE_SKILL_OUTPUT_DIR is always valid and
  // shell cwd defaults to the writable workspace, not the read-only asset root.
  mkdirSync(roots.artifactRoot, { recursive: true })

  const isDirectLarkCli = /^lark-cli(?:\s|$)/.test(args.command.trim())
  if (!isDirectLarkCli) {
    // Stage T W7.1 — high-risk pattern audit. Runs BEFORE the shouldUseShell
    // branch so both the `bash -c <full command>` compound path and the
    // `parseCommand` argv path share the same gate. Fixed Lark CLI commands
    // are tokenized first instead: unquoted shell syntax is rejected there,
    // while quoted document content remains inert argv data.
    const audit = auditBashCommand(args.command)
    if (!audit.allowed && audit.matched) {
      logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
        primitive: 'skill_run_shell',
        reason: 'command_high_risk_blocked',
        pattern: audit.matched.pattern,
        description: audit.matched.description,
      })
      throw new ToolDomainError(
        'command_high_risk_blocked',
        `skill_run_shell: command rejected by high-risk pattern audit (${audit.matched.description}).`,
        {
          pattern: audit.matched.pattern,
          description: audit.matched.description,
        },
      )
    }
    assertExplicitWritesStayInWorkspace(args.command, roots.artifactRoot)
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
  if (parsed.bin === 'lark-cli') {
    assertLarkCliLocalPathsStayInWorkspace(parsed.args, roots.artifactRoot)
  }
  if (deps.requiredMethod) {
    const method = deps.requiredMethod
    const validShape = Boolean(
      method.methodId.trim()
      && /^[A-Za-z0-9._+-]+$/.test(method.commandName)
      && method.allowedArgv.length > 0
      && method.allowedArgv.every((candidate) => Array.isArray(candidate)),
    )
    if (!validShape
      || (typeof args.stdin === 'string' && args.stdin.length > 0)
      || parsed.bin !== method.commandName
      || !method.allowedArgv.some((candidate) => argvMatches(parsed?.args || [], candidate))) {
      throw new ToolDomainError(
        'required_method_violation',
        'skill_run_shell: this turn only permits the pinned read-only method.',
        { methodId: method.methodId, commandName: method.commandName },
      )
    }
  }
  if (WRITE_SURFACE_SHELL_COMMANDS.has(parsed.bin)) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_run_shell',
      reason: 'cmd_not_allowlisted',
      bin: parsed.bin,
    })
    throw new ToolDomainError(
      'cmd_not_allowlisted',
      `skill_run_shell: command "${parsed.bin}" is not allowed as a shell write surface.`,
      { bin: parsed.bin, allowlist: Array.from(SHELL_ALLOWLIST) },
    )
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

  const timeoutMs = Math.min(
    typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS,
    HARD_CAP_TIMEOUT_MS,
  )

  const env = buildEnv(deps.baseEnv ?? process.env, roots, deps.runtimeBinDir, deps.venvBinDir)
  const spawnFn = deps.spawnFn || spawn
  const started = Date.now()

  let spawnBin = parsed.bin
  let spawnArgs = parsed.args
  if (deps.requiredMethod && deps.executableAuthority
    && deps.requiredMethod.executableAuthority.authorityDigest
      !== deps.executableAuthority.authorityDigest) {
    throw new ToolDomainError(
      'dependency_identity_drift',
      'skill_run_shell: the confirmation authority does not match the required execution method.',
      { program: parsed.bin },
    )
  }
  const executableAuthority = deps.requiredMethod?.executableAuthority || deps.executableAuthority
  if (deps.executableAuthority && parsed.bin !== deps.executableAuthority.program) {
    throw new ToolDomainError(
      'dependency_identity_drift',
      'skill_run_shell: the authorized executable identity does not match the requested command.',
      { program: deps.executableAuthority.program },
    )
  }
  if (executableAuthority) {
    try {
      assertFrozenDesktopExecutableAuthority(executableAuthority)
    } catch (error) {
      const errorKind = error instanceof DesktopExecutableAuthorityError
        ? error.code
        : 'dependency_identity_drift'
      throw new ToolDomainError(
        errorKind,
        'skill_run_shell: the pinned executable identity is no longer valid.',
        { program: executableAuthority.program },
      )
    }
  }
  if (parsed.bin === 'lark-cli' && executableAuthority) {
    env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1'
    env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1'
  }
  if (deps.requiredMethod) {
    try {
      deps.assertRequiredResourcesRead?.()
    } catch {
      throw new ToolDomainError(
        'required_method_violation',
        'skill_run_shell: required read-only method guidance was not fully consumed.',
        { methodId: deps.requiredMethod.methodId },
      )
    }
    try {
      await deps.requiredMethodPreflight?.()
    } catch {
      throw new ToolDomainError(
        'dependency_identity_drift',
        'skill_run_shell: the pinned authorization identity is no longer valid.',
        { methodId: deps.requiredMethod.methodId },
      )
    }
    try {
      assertFrozenDesktopExecutableAuthority(deps.requiredMethod.executableAuthority)
    } catch (error) {
      const errorKind = error instanceof DesktopExecutableAuthorityError
        ? error.code
        : 'dependency_identity_drift'
      throw new ToolDomainError(
        errorKind,
        'skill_run_shell: the pinned executable identity is no longer valid.',
        { methodId: deps.requiredMethod.methodId },
      )
    }
  }

  let executableSnapshot: FrozenDesktopExecutableSnapshot | null = null
  if (executableAuthority) {
    try {
      executableSnapshot = materializeFrozenDesktopExecutableSnapshot({
        authority: executableAuthority,
      })
      spawnBin = executableSnapshot.spawnPath
      spawnArgs = [...executableSnapshot.launchPrefixArgs, ...parsed.args]
    } catch (error) {
      const errorKind = error instanceof DesktopExecutableAuthorityError
        ? error.code
        : 'dependency_snapshot_unavailable'
      throw new ToolDomainError(
        errorKind,
        'skill_run_shell: the pinned executable could not be fixed for execution.',
        { program: executableAuthority.program },
      )
    }
  }

  let stdout = ''
  let stderr = ''
  let timedOut = false
  let aborted = false
  // On Unix we want to create a new process group so `kill(-pid)` can reap
  // grandchildren spawned by bash/sh wrappers. Windows doesn't support
  // detached in the same way — `child.kill('SIGTERM')` with `/T /F` semantics
  // is approximated via taskkill below if needed.
  // A required read-only method stays in Ready Main's already-owned process
  // group so an abrupt Main exit cannot orphan an unleased detached CLI group.
  const useProcessGroup = process.platform !== 'win32' && !deps.requiredMethod
  const child = (() => {
    try {
      return spawnFn(spawnBin, spawnArgs, {
        cwd: roots.artifactRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: useProcessGroup,
      })
    } catch (error) {
      executableSnapshot?.release()
      throw error
    }
  })()

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
    executableSnapshot?.release()
  }).catch((error: unknown) => {
    if (deps.requiredMethod) {
      throw new ToolDomainError(
        'dependency_unavailable',
        'skill_run_shell: the pinned executable could not be started.',
        {
          methodId: deps.requiredMethod.methodId,
          detail: error instanceof Error ? error.message : String(error),
        },
      )
    }
    throw error
  }) as number

  const durationMs = Date.now() - started

  if (exitCode === 0 && deps.requiredMethod?.expectedStdoutSha256
    && createHash('sha256').update(stdout).digest('hex') !== deps.requiredMethod.expectedStdoutSha256) {
    throw new ToolDomainError(
      'dependency_identity_drift',
      'skill_run_shell: the fetched resource does not match the authorized version.',
      { methodId: deps.requiredMethod.methodId },
    )
  }

  const stdoutSafe = deps.requiredMethod && exitCode === 0
    ? { text: stdout, truncated: false }
    : truncate(stdout)
  const stderrSafe = truncate(stderr)
  // Stage T W7.3 — host-path redaction is applied to stdout/stderr before
  // the model ever sees them. Overflow log write (inside writeOverflowArtifact)
  // re-redacts the FULL stream so the persisted file is also clean. Together
  // these are the ≥3 redaction sites the gate enforces.
  const stdoutRedacted = redactHostPaths(stdoutSafe.text)
  const stderrRedacted = redactHostPaths(stderrSafe.text)
  const stdoutArtifact: OverflowResult = !deps.requiredMethod && stdoutSafe.truncated
    ? deps.persistOverflowArtifacts === false
      ? { path: null, error: null }
      : writeOverflowArtifact(roots.artifactRoot, 'stdout', stdout)
    : { path: null, error: null }
  const stderrArtifact: OverflowResult = !deps.requiredMethod && stderrSafe.truncated
    ? deps.persistOverflowArtifacts === false
      ? { path: null, error: null }
      : writeOverflowArtifact(roots.artifactRoot, 'stderr', stderr)
    : { path: null, error: null }
  // Round-12 — artifact path strings themselves carry `<artifactRoot>` which
  // typically lives under the user's home dir; redact before surfacing.
  const stdoutArtifactPathRedacted = stdoutArtifact.path ? redactHostPaths(stdoutArtifact.path) : null
  const stderrArtifactPathRedacted = stderrArtifact.path ? redactHostPaths(stderrArtifact.path) : null
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
  if (stdoutRedacted) textLines.push('STDOUT:', stdoutRedacted)
  if (stderrRedacted) textLines.push('STDERR:', stderrRedacted)
  if (stdoutSafe.truncated) {
    textLines.push(
      deps.persistOverflowArtifacts === false
        ? '(stdout truncated; full log intentionally not persisted)'
        : stdoutArtifactPathRedacted
        ? `(stdout truncated; full log at ${stdoutArtifactPathRedacted})`
        : `(stdout truncated; overflow log write failed: ${stdoutArtifact.error})`,
    )
  }
  if (stderrSafe.truncated) {
    textLines.push(
      deps.persistOverflowArtifacts === false
        ? '(stderr truncated; full log intentionally not persisted)'
        : stderrArtifactPathRedacted
        ? `(stderr truncated; full log at ${stderrArtifactPathRedacted})`
        : `(stderr truncated; overflow log write failed: ${stderrArtifact.error})`,
    )
  }

  const errorKind = exitCode === 0 || !deps.requiredMethod
    ? null
    : classifyRequiredMethodFailure(exitCode, stdout, stderr)
  return createToolExecutionOutput(textLines.join('\n'), {
    shape: 'json',
    data: {
      ok: exitCode === 0,
      ...(errorKind ? { errorKind } : {}),
      exitCode,
      durationMs,
      stdout: stdoutRedacted,
      stderr: stderrRedacted,
      stdoutTruncated: stdoutSafe.truncated,
      stderrTruncated: stderrSafe.truncated,
      stdoutArtifactPath: stdoutArtifactPathRedacted,
      stderrArtifactPath: stderrArtifactPathRedacted,
      stdoutArtifactError: stdoutArtifact.error,
      stderrArtifactError: stderrArtifact.error,
      command: { bin: parsed.bin, args: parsed.args },
      ...(deps.requiredMethod ? {
        requiredMethod: {
          methodId: deps.requiredMethod.methodId,
          commandName: deps.requiredMethod.commandName,
          authorityDigest: deps.requiredMethod.executableAuthority.authorityDigest,
          payloadSha256: deps.requiredMethod.executableAuthority.payloadSha256,
          version: deps.requiredMethod.executableAuthority.version,
        },
      } : {}),
    },
  })
}
