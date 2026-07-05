/**
 * Phase M+（2026-07-05）—— run_setup_command 两阶段一次性命令执行合同。
 *
 * 用户场景：「帮我装一下飞书 CLI」→ `npx @larksuite/cli@latest install`。
 * 断言：
 *   1. 阶段 1 只展示不执行（needsConfirmation + 完整命令 + riskNotes）；
 *   2. 命令不经 shell：command 位含元字符即拒；args 必须是数组；
 *   3. 阶段 2 confirmAck 才执行，回报 stdout/stderr/退出码；
 *   4. spawn 失败 / 超时 → 结构化响亮错误。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { executeRunSetupCommand } from '../main/modules/tools/builtins/run-setup-command'
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
  assert.match(output.text, /ask_user_questions/)
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
