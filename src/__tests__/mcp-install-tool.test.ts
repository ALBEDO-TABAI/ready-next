/**
 * Phase M（2026-07-05）—— install_mcp_server 两阶段安装合同。
 *
 * 用户场景：非专业用户对 agent 说「帮我装个 XX 的 MCP」。断言：
 *   1. 阶段 1 只读：产出 pendingConfig + riskNotes，绝不写配置；
 *   2. 命令白名单（npx/uvx）与包名/元字符校验由代码机械强制；
 *   3. 阶段 2 必须 confirmAck + 回传 pendingConfig，重新全量校验后写
 *      `mcp_servers_json` 并触发 reload，回报发现的工具；
 *   4. 重复 id / 现有配置不可解析 / URL 源 → 结构化拒绝；
 *   5. list / remove 闭环。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  executeInstallMcpServer,
  resolveMcpInstallSource,
} from '../main/modules/tools/builtins/install-mcp-server'
import { ToolDomainError } from '../main/modules/tools/tool-errors'
import { MCP_SERVERS_SETTING_KEY } from '../main/modules/mcp/bootstrap'
import {
  __resetMcpRegistryForTests,
  registerMcpServer,
} from '../main/modules/mcp/registry'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('mcp-install-tool declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'mcp-install-tool transitive sqlite load')
})

function makeDeps(initial?: string) {
  const settings = new Map<string, string>()
  if (initial !== undefined) settings.set(MCP_SERVERS_SETTING_KEY, initial)
  const reloads: number[] = []
  return {
    settings,
    reloads,
    deps: {
      getSetting: (key: string) => settings.get(key) ?? null,
      setSetting: (key: string, value: string) => { settings.set(key, value) },
      reloadServers: async () => {
        reloads.push(1)
        return [{ serverId: 'filesystem', ok: true, toolCount: 3, dropped: [] }]
      },
    },
  }
}

test('resolve: npm/uvx sources map to whitelisted commands with derived ids', () => {
  const npm = resolveMcpInstallSource({ source: '@modelcontextprotocol/server-filesystem', extraArgs: ['/Users/demo/Docs'] })
  assert.deepEqual(npm.pendingConfig, {
    id: 'filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/demo/Docs'],
  })
  const uvx = resolveMcpInstallSource({ source: 'uvx:mcp-server-time' })
  assert.deepEqual(uvx.pendingConfig, { id: 'time', command: 'uvx', args: ['mcp-server-time'] })

  assert.throws(() => resolveMcpInstallSource({ source: 'https://github.com/x/y' }),
    (e: unknown) => e instanceof ToolDomainError && e.errorKind === 'mcp_install_invalid_source')
  assert.throws(() => resolveMcpInstallSource({ source: 'not a package!!' }),
    (e: unknown) => e instanceof ToolDomainError && e.errorKind === 'mcp_install_invalid_source')
  assert.throws(() => resolveMcpInstallSource({ source: 'ok-pkg', extraArgs: ['$(rm -rf /)'] }),
    (e: unknown) => e instanceof ToolDomainError && e.errorKind === 'mcp_install_invalid_source')
})

test('phase 1 is read-only: returns pendingConfig + riskNotes and never writes the setting', async () => {
  const { deps, settings, reloads } = makeDeps()
  const output = await executeInstallMcpServer(
    { source: '@modelcontextprotocol/server-filesystem', args: ['/Users/demo/Docs'] },
    deps,
  )
  assert.match(output.text, /已只读解析（未安装）/)
  assert.match(output.text, /npx -y @modelcontextprotocol\/server-filesystem \/Users\/demo\/Docs/)
  assert.match(output.text, /Ready 确认卡/)
  const data = output.data as Record<string, unknown>
  assert.equal(data.needsConfirmation, true)
  assert.ok(Array.isArray(data.riskNotes) && (data.riskNotes as string[]).some((note) => note.includes('/Users/demo/Docs')))
  assert.equal(settings.has(MCP_SERVERS_SETTING_KEY), false, 'phase 1 must not write config')
  assert.equal(reloads.length, 0, 'phase 1 must not reload')
})

test('phase 2 requires confirmAck + pendingConfig, revalidates, writes config and reloads', async () => {
  __resetMcpRegistryForTests()
  registerMcpServer({
    serverId: 'filesystem',
    toolNames: ['mcp_filesystem_read_file', 'mcp_filesystem_list_dir', 'mcp_filesystem_write_file'],
    requiresAuthorization: false,
  })
  const { deps, settings, reloads } = makeDeps()
  const pendingConfig = {
    id: 'filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/demo/Docs'],
  }
  const output = await executeInstallMcpServer({ confirmAck: true, pendingConfig }, deps)
  assert.match(output.text, /已安装并连接 MCP server「filesystem」/)
  assert.match(output.text, /3 个工具/)
  const saved = JSON.parse(settings.get(MCP_SERVERS_SETTING_KEY) || '[]') as Array<Record<string, unknown>>
  assert.equal(saved.length, 1)
  assert.equal(saved[0].id, 'filesystem')
  assert.equal(saved[0].transport, 'stdio')
  assert.equal(reloads.length, 1)

  // 白名单外命令 / 篡改 args 形状 → 机械拒绝
  await assert.rejects(
    executeInstallMcpServer({ confirmAck: true, pendingConfig: { id: 'x', command: 'bash', args: ['-c', 'evil'] } }, deps),
    (e: unknown) => e instanceof ToolDomainError,
  )
  await assert.rejects(
    executeInstallMcpServer({ confirmAck: true, pendingConfig: { id: 'x', command: 'npx', args: ['not-dash-y', 'pkg'] } }, deps),
    (e: unknown) => e instanceof ToolDomainError && e.errorKind === 'mcp_install_invalid_source',
  )
  __resetMcpRegistryForTests()
})

test('local binary source (Pencil.app-style): absolute path to an executable is accepted; interpreters/missing are refused', async () => {
  const { deps, settings, reloads } = makeDeps()
  // 造一个真实存在、可执行、非解释器名的"本地 server 二进制"
  const dir = mkdtempSync(join(tmpdir(), 'ready-mcp-local-'))
  const localBin = join(dir, 'mcp-server-darwin-arm64')
  writeFileSync(localBin, '#!/bin/sh\necho stub\n')
  chmodSync(localBin, 0o755)
  try {
    const resolved = resolveMcpInstallSource({ source: localBin, serverId: 'pencil', extraArgs: ['--app', 'desktop'] })
    assert.equal(resolved.runner, 'local')
    assert.deepEqual(resolved.pendingConfig, { id: 'pencil', command: localBin, args: ['--app', 'desktop'] })

    const output = await executeInstallMcpServer({ source: localBin, serverId: 'pencil', args: ['--app', 'desktop'] }, deps)
    assert.match(output.text, /本机可执行文件/)
    assert.equal(settings.has(MCP_SERVERS_SETTING_KEY), false, 'phase 1 stays read-only for local binaries too')
    assert.equal(reloads.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // 通用解释器（bash/python/node basename）→ commandNotAllowed
  assert.throws(() => resolveMcpInstallSource({ source: '/bin/bash' }),
    (e: unknown) => e instanceof ToolDomainError && e.errorKind === 'mcp_install_command_not_allowed')
  // 不存在的绝对路径 → invalidSource
  assert.throws(() => resolveMcpInstallSource({ source: '/nonexistent/mcp-server-x' }),
    (e: unknown) => e instanceof ToolDomainError && e.errorKind === 'mcp_install_invalid_source')
})

test('phase 2 revalidates local binary configs the same way (interpreter smuggled back is rejected)', async () => {
  const { deps } = makeDeps()
  await assert.rejects(
    executeInstallMcpServer({ confirmAck: true, pendingConfig: { id: 'evil', command: '/bin/zsh', args: ['-c', 'x'] } }, deps),
    (e: unknown) => e instanceof ToolDomainError && e.errorKind === 'mcp_install_command_not_allowed',
  )
})

test('duplicate id and unreadable existing config are structured refusals', async () => {
  const existing = JSON.stringify([{ id: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', 'p'] }])
  const dup = makeDeps(existing)
  await assert.rejects(
    executeInstallMcpServer({ source: '@modelcontextprotocol/server-filesystem' }, dup.deps),
    (e: unknown) => e instanceof ToolDomainError && e.errorKind === 'mcp_install_duplicate_server',
  )
  const broken = makeDeps('{not json')
  await assert.rejects(
    executeInstallMcpServer({ source: 'some-server' }, broken.deps),
    (e: unknown) => e instanceof ToolDomainError && e.errorKind === 'mcp_install_config_unreadable',
  )
})

test('phase 2 reports connect failure honestly while keeping the written config', async () => {
  const { settings } = makeDeps()
  const deps = {
    getSetting: (key: string) => settings.get(key) ?? null,
    setSetting: (key: string, value: string) => { settings.set(key, value) },
    reloadServers: async () => [{ serverId: 'broken', ok: false, toolCount: 0, dropped: [], error: 'spawn ENOENT' }],
  }
  const output = await executeInstallMcpServer({
    confirmAck: true,
    pendingConfig: { id: 'broken', command: 'npx', args: ['-y', 'broken-server'] },
  }, deps)
  assert.match(output.text, /连接失败：spawn ENOENT/)
  assert.ok(settings.get(MCP_SERVERS_SETTING_KEY)?.includes('broken'), 'config stays for the user to fix in settings')
})

test('remove deletes the entry and reloads; list summarizes configured servers', async () => {
  const existing = JSON.stringify([
    { id: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', 'p'] },
    { id: 'time', transport: 'stdio', command: 'uvx', args: ['mcp-server-time'] },
  ])
  const { deps, settings, reloads } = makeDeps(existing)

  const removed = await executeInstallMcpServer({ action: 'remove', serverId: 'time' }, deps)
  assert.match(removed.text, /已移除 MCP server「time」/)
  const saved = JSON.parse(settings.get(MCP_SERVERS_SETTING_KEY) || '[]') as Array<Record<string, unknown>>
  assert.deepEqual(saved.map((entry) => entry.id), ['filesystem'])
  assert.equal(reloads.length, 1)

  await assert.rejects(
    executeInstallMcpServer({ action: 'remove', serverId: 'ghost' }, deps),
    (e: unknown) => e instanceof ToolDomainError && e.errorKind === 'mcp_install_server_not_found',
  )

  const listed = await executeInstallMcpServer({ action: 'list' }, deps)
  assert.match(listed.text, /filesystem/)
})
