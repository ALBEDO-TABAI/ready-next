/**
 * Phase M+（2026-07-05）—— run_setup_command 两阶段一次性命令执行合同。
 *
 * 用户场景：「帮我装一下飞书 CLI」→ `npx @larksuite/cli@latest install`。
 * 断言：
 *   1. 阶段 1 只展示不执行（needsConfirmation + 完整命令 + riskNotes）；
 *   2. 命令不经 shell：command 位含元字符即拒；args 必须是数组；
 *   3. 阶段 2 confirmAck 进入代码侧确认卡，放行后才执行并回报结果；
 *   4. spawn 失败 / 超时 → 结构化响亮错误。
 */
import assert from 'node:assert/strict'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FROZEN_CALL_CONFIRM_OPTION,
  FROZEN_CALL_QUESTION_ID,
} from '../main/modules/agent-control/safety/frozen-call-confirmation'
import {
  _resetFrozenCallBridgeForTests,
  registerFrozenCallStore,
} from '../main/modules/agent-control/safety/frozen-call-bridge'
import { FrozenCallStore } from '../main/modules/agent-control/safety/frozen-call-store'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { executeRunSetupCommand } from '../main/modules/tools/builtins/run-setup-command'
import {
  _resetAskUserQuestionsStoreForTests,
  getAskUserQuestionsStore,
} from '../main/modules/tools/builtins/ask-user-questions-store'
import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import { ToolDomainError } from '../main/modules/tools/tool-errors'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('run-setup-command declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'run-setup-command transitive sqlite load')
})

test('phase 1 previews the full command without executing', async () => {
  const runProcess = async () => { throw new Error('phase 1 must not execute') }
  const output = await executeRunSetupCommand(
    { command: 'npx', args: ['@larksuite/cli@latest', 'install'] },
    { runProcess },
  )
  assert.match(output.text, /已解析（未执行）/)
  assert.match(output.text, /npx @larksuite\/cli@latest install/)
  assert.match(output.text, /Ready 会冻结完整调用并显示行动确认卡/)
  const data = output.data as Record<string, unknown>
  assert.equal(data.needsConfirmation, true)
  assert.deepEqual(data.args, ['@larksuite/cli@latest', 'install'])
  assert.ok(Array.isArray(data.riskNotes))
})

test('command must not carry shell metacharacters; args must be an array', async () => {
  await assert.rejects(
    executeRunSetupCommand({ command: 'npx foo && rm -rf /' }),
    (e: unknown) => e instanceof ToolDomainError && e.errorKind === 'setup_command_invalid',
  )
  await assert.rejects(
    executeRunSetupCommand({ command: '$(evil)' }),
    (e: unknown) => e instanceof ToolDomainError && e.errorKind === 'setup_command_invalid',
  )
  await assert.rejects(
    executeRunSetupCommand({ command: 'npx', args: 'not-an-array' as unknown as string[] }),
    (e: unknown) => e instanceof ToolDomainError && e.errorKind === 'setup_command_invalid',
  )
  await assert.rejects(
    executeRunSetupCommand({ command: '' }),
    (e: unknown) => e instanceof ToolDomainError && e.errorKind === 'setup_command_invalid',
  )
})

test('phase 2 executes with confirmAck and reports stdout/stderr/exit code (never through a shell)', async () => {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = []
  const runProcess = async (descriptor: { command: string; args: string[]; cwd: string }) => {
    calls.push(descriptor)
    return { code: 0, signal: null, stdout: 'Lark CLI installed.', stderr: '', timedOut: false }
  }
  const output = await executeRunSetupCommand(
    { confirmAck: true, command: 'npx', args: ['@larksuite/cli@latest', 'install'] },
    { runProcess },
  )
  assert.match(output.text, /命令执行成功/)
  assert.match(output.text, /Lark CLI installed\./)
  const data = output.data as Record<string, unknown>
  assert.equal(data.ok, true)
  assert.equal(data.exitCode, 0)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['@larksuite/cli@latest', 'install'])
  // 元字符字面量作为 args 是安全的（不经 shell，只是普通参数）
  const safeArg = await executeRunSetupCommand(
    { confirmAck: true, command: 'echo', args: ['a && b'] },
    { runProcess: async () => ({ code: 0, signal: null, stdout: 'a && b', stderr: '' }) },
  )
  assert.equal((safeArg.data as Record<string, unknown>).ok, true)
})

test('real dispatch freezes phase 2 until the Ready confirmation card is approved', async (t) => {
  _resetAskUserQuestionsStoreForTests()
  registerFrozenCallStore(new FrozenCallStore(null))
  const dir = await mkdtemp(join(tmpdir(), 'ready-setup-confirm-'))
  const sentinel = join(dir, 'executed.txt')
  t.after(async () => {
    _resetFrozenCallBridgeForTests()
    _resetAskUserQuestionsStoreForTests()
    await rm(dir, { recursive: true, force: true })
  })

  const sessionId = `setup-confirm-${Date.now()}`
  const context: ToolContext = {
    invoker: 'model',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    allowedToolNames: new Set(['run_setup_command']),
    sessionId,
  }
  const pending = executeToolCall('run_setup_command', {
    confirmAck: true,
    command: process.execPath,
    args: ['-e', "require('node:fs').writeFileSync(process.argv[1], 'ran')", sentinel],
  }, context)

  const startedAt = Date.now()
  let card = getAskUserQuestionsStore().findPendingForSession(sessionId)
  while (!card && Date.now() - startedAt < 2_000) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    card = getAskUserQuestionsStore().findPendingForSession(sessionId)
  }
  assert.ok(card, 'Ready must show a confirmation card before executing the command')
  await assert.rejects(access(sentinel), 'the command must not run before confirmation')

  getAskUserQuestionsStore().resolve(card.cardId, {
    answers: [{ id: FROZEN_CALL_QUESTION_ID, answer: FROZEN_CALL_CONFIRM_OPTION }],
    answeredAt: Date.now(),
  })
  const output = await pending

  assert.equal(await readFile(sentinel, 'utf8'), 'ran')
  assert.equal((output.data as Record<string, unknown>).ok, true)
})

test('structured device authorization output preserves the clickable URL and resume code', async () => {
  const verificationUrl = 'https://open.feishu.cn/open-apis/authen/v1/device?state=abc123'
  const output = await executeRunSetupCommand(
    {
      confirmAck: true,
      command: 'lark-cli',
      args: ['auth', 'login', '--no-wait', '--json'],
    },
    {
      runProcess: async () => ({
        code: 0,
        signal: null,
        stdout: JSON.stringify({ verification_url: verificationUrl, device_code: 'device-42' }),
        stderr: '',
      }),
    },
  )

  const data = output.data as Record<string, unknown>
  assert.equal(data.ok, true, 'authorization handoff is a resumable wait, not a tool failure')
  assert.equal(data.status, 'waiting_authorization')
  assert.equal(data.authorizationRequired, true)
  assert.equal(data.authorizationUrl, verificationUrl)
  assert.equal(data.deviceCode, 'device-42')
  assert.match(output.text, new RegExp(verificationUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(output.text, /device-42/)
})

test('CLI confirmation_required never auto-retries and returns an explicit --yes retry', async () => {
  const output = await executeRunSetupCommand(
    {
      confirmAck: true,
      command: 'lark-cli',
      args: ['im', 'message', 'send', '--receive-id', 'oc_123'],
    },
    {
      runProcess: async () => ({
        code: 10,
        signal: null,
        stdout: '',
        stderr: JSON.stringify({
          ok: false,
          error: {
            type: 'confirmation_required',
            hint: 'add --yes',
            risk: { level: 'high-risk-write', action: 'send message to oc_123' },
          },
        }),
      }),
    },
  )

  const data = output.data as Record<string, unknown>
  assert.equal(data.ok, true, 'CLI confirmation request is a resumable wait, not a tool failure')
  assert.equal(data.status, 'waiting_confirmation')
  assert.equal(data.needsConfirmation, true)
  assert.equal(data.confirmationType, 'cli_high_risk')
  assert.deepEqual(data.retryArgs, ['im', 'message', 'send', '--receive-id', 'oc_123', '--yes'])
  assert.equal(data.riskLevel, 'high-risk-write')
  assert.equal(data.riskAction, 'send message to oc_123')
  assert.match(output.text, /未自动重试/)
  assert.match(output.text, /--yes/)
})

test('non-zero exit is reported as a warning with stderr, not thrown', async () => {
  const output = await executeRunSetupCommand(
    { confirmAck: true, command: 'npx', args: ['broken-cli'] },
    { runProcess: async () => ({ code: 1, signal: null, stdout: '', stderr: 'command not found' }) },
  )
  assert.match(output.text, /退出码 1/)
  assert.match(output.text, /command not found/)
  assert.equal((output.data as Record<string, unknown>).ok, false)
})

test('spawn error and timeout are structured refusals', async () => {
  await assert.rejects(
    executeRunSetupCommand(
      { confirmAck: true, command: '/nope/missing' },
      { runProcess: async () => ({ code: null, signal: null, stdout: '', stderr: '', spawnError: 'ENOENT' }) },
    ),
    (e: unknown) => e instanceof ToolDomainError && e.errorKind === 'setup_command_execution_failed',
  )
  await assert.rejects(
    executeRunSetupCommand(
      { confirmAck: true, command: 'sleep', args: ['999'] },
      { runProcess: async () => ({ code: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true }) },
    ),
    (e: unknown) => e instanceof ToolDomainError && e.errorKind === 'setup_command_timed_out',
  )
})

test('desktop launch PATH finds a CLI in the standard user bin without a shell', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the executable fixture uses a POSIX shebang')
    return
  }
  const home = await mkdtemp(join(tmpdir(), 'ready-desktop-cli-home-'))
  const bin = join(home, '.local', 'bin')
  const executable = join(bin, 'ready-cli-path-fixture')
  await mkdir(bin, { recursive: true })
  await writeFile(executable, '#!/usr/bin/env node\nprocess.stdout.write("desktop-path-ok")\n')
  await chmod(executable, 0o755)
  t.after(() => rm(home, { recursive: true, force: true }))

  const output = await executeRunSetupCommand({
    confirmAck: true,
    command: 'ready-cli-path-fixture',
    args: [],
  }, {
    processEnv: { HOME: home, PATH: '/usr/bin:/bin' },
  })
  assert.equal((output.data as Record<string, unknown>).ok, true)
  assert.equal((output.data as Record<string, unknown>).stdout, 'desktop-path-ok')
})

// ── 2026-07-06 真机回测（飞书 CLI B5）抓获的卡死修复合同 ──────────────────
// lark-cli config init 类交互式命令曾把工具挂死：stdin 管道敞开等输入 +
// 超时只杀 npx 不杀孙进程 + settle 在 'close'（被孙进程握住的管道永不排空）。
// 以下用真实 spawn 直驱 defaultRunProcess（不注 runProcess）钉死修复语义。

test('交互式命令因 stdin 立即 EOF 而快速退出，不等到超时', async () => {
  const startedAt = Date.now()
  const output = await executeRunSetupCommand({
    confirmAck: true,
    command: process.execPath,
    // 模拟交互式 CLI：打印提示后等 stdin——EOF 应让它立刻走 end 分支退出
    args: ['-e', "process.stdout.write('? App ID: '); process.stdin.on('data', () => {}); process.stdin.on('end', () => { console.error('eof-no-tty'); process.exit(2) }); setTimeout(() => process.exit(3), 8000)"],
    timeoutMs: 10_000,
  })
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 6_000, `stdin EOF 应秒退（实际 ${elapsed}ms）`)
  assert.equal((output.data as Record<string, unknown>).ok, false)
  assert.match(output.text, /退出码 2/)
  assert.match(output.text, /eof-no-tty/)
})

test('超时杀进程树且 Promise 及时归来（孙进程握管道不再悬死），错误带输出尾巴', async () => {
  const startedAt = Date.now()
  await assert.rejects(
    executeRunSetupCommand({
      confirmAck: true,
      command: process.execPath,
      // 包装器形态：父进程 spawn 一个继承 stdio 的长命孙进程后自己悬住——
      // 旧实现超时 SIGKILL 父进程后 'close' 永不触发，Promise 悬死。
      args: ['-e', "const { spawn } = require('child_process'); process.stdout.write('wrapper-started'); spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000)"],
      timeoutMs: 5_000,
    }),
    (e: unknown) => e instanceof ToolDomainError
      && e.errorKind === 'setup_command_timed_out'
      && /wrapper-started/.test(e.message),
  )
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 9_000, `超时后必须及时归来（实际 ${elapsed}ms）`)
})

test('用户中断（abortSignal）立即终止并以 AbortError 冒泡', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 300)
  const startedAt = Date.now()
  await assert.rejects(
    executeRunSetupCommand({
      confirmAck: true,
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 30_000,
    }, { abortSignal: controller.signal }),
    (e: unknown) => e instanceof Error && e.name === 'AbortError',
  )
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 5_000, `中断应即时生效（实际 ${elapsed}ms）`)
})
