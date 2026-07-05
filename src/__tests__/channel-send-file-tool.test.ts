/**
 * Phase I（2026-07-05）—— 远程会话文件直达回传行为合同。
 *
 * 真机实锚：微信里"把今天 sepc commercial 的视听报告发我"——模型定位到
 * PDF 却没有任何发送工具。断言四层：
 *   1. channel_outbound 组仅在 scope 绑定渠道线程（channelScopeBound）时可见；
 *   2. channel_send_file 工具：无桥/无 scope 拒绝、路径校验、成功回执、
 *      投递失败响亮；
 *   3. RemoteChannelService.sendFileToScopeThread 反查线程并把附件发往
 *      当前线程（非微信渠道明确拒绝）；
 *   4. 触发本轮修复的原话必须命中出站意图正则（回归钉）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveCapabilityResolution } from '../main/modules/agent-control/domain-adapters/capability-resolver'
import { getDefaultConfig } from '../shared/ai-providers'
import {
  registerChannelOutboundSender,
  _resetChannelOutboundBridgeForTests,
} from '../main/modules/agent-control/channel-outbound-bridge'
import { executeChannelSendFile } from '../main/modules/tools/builtins/channel-send-file'
import { ToolDomainError } from '../main/modules/tools/tool-errors'
import { RemoteChannelService } from '../main/modules/agent-control/runtime-core/remote-channel-service'
import type { RemoteChannelServiceDeps } from '../main/modules/agent-control/runtime-core/remote-channel-service'
import { hasRemoteFileDeliveryIntent } from '../shared/remote-im-file-intent'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('channel-send-file declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'channel-send-file transitive sqlite load')
})

function resolveGroups(channelScopeBound: boolean): { visible: string[]; suppressed: string[] } {
  const resolution = resolveCapabilityResolution({
    config: getDefaultConfig(),
    profile: 'local_chat',
    browserDecisionMode: 'free_tool_loop',
    runtimeAvailability: {
      browserHostAvailable: true,
      feishuConnected: false,
      channelScopeBound,
    },
  })
  return {
    visible: resolution.visibleCapabilityGroupIds,
    suppressed: resolution.suppressedCapabilityGroupIds,
  }
}

test('channel_outbound group is visible only when the scope is channel-bound', () => {
  const unbound = resolveGroups(false)
  assert.ok(!unbound.visible.includes('channel_outbound'), 'local scopes must not see the group')
  assert.ok(unbound.suppressed.includes('channel_outbound'), 'unbound scope suppresses as environment_unavailable')

  const bound = resolveGroups(true)
  assert.ok(bound.visible.includes('channel_outbound'), 'channel-bound scope exposes channel_send_file')
})

test('channel_send_file validates bridge, scope and file before sending', async () => {
  _resetChannelOutboundBridgeForTests()
  // 无桥（渠道回传未就绪）→ scopeUnbound
  await assert.rejects(
    executeChannelSendFile({ path: '/tmp/x.pdf' }, { scopeId: 'scope-1' }),
    (error: unknown) => error instanceof ToolDomainError && error.errorKind === 'channel_scope_unbound',
  )

  const sent: Array<{ scopeId: string; path: string; caption?: string }> = []
  registerChannelOutboundSender(async (scopeId, file) => {
    sent.push({ scopeId, path: file.path, caption: file.caption })
    return { success: true, channelId: 'wechat-openclaw', attachmentName: 'report.pdf' }
  })

  // 无 scope → scopeUnbound
  await assert.rejects(
    executeChannelSendFile({ path: '/tmp/x.pdf' }, {}),
    (error: unknown) => error instanceof ToolDomainError && error.errorKind === 'channel_scope_unbound',
  )
  // 相对路径 / 不存在 → fileInvalid
  await assert.rejects(
    executeChannelSendFile({ path: 'relative.pdf' }, { scopeId: 'scope-1' }),
    (error: unknown) => error instanceof ToolDomainError && error.errorKind === 'channel_file_invalid',
  )
  await assert.rejects(
    executeChannelSendFile({ path: '/definitely/not/here/miss.pdf' }, { scopeId: 'scope-1' }),
    (error: unknown) => error instanceof ToolDomainError && error.errorKind === 'channel_file_invalid',
  )
  assert.equal(sent.length, 0, 'no delivery may happen before validation passes')

  // 真实临时文件 → 成功回执带名字与大小
  const dir = mkdtempSync(join(tmpdir(), 'ready-channel-send-'))
  const filePath = join(dir, 'BV_audiovisual_analysis.pdf')
  writeFileSync(filePath, 'pdf-bytes')
  try {
    const output = await executeChannelSendFile(
      { path: filePath, caption: '这是今天的视听报告' },
      { scopeId: 'scope-1' },
    )
    assert.match(output.text, /已把文件发送到当前远程会话：BV_audiovisual_analysis\.pdf/)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].scopeId, 'scope-1')
    assert.equal(sent[0].caption, '这是今天的视听报告')

    // 投递失败 → deliveryFailed 响亮
    registerChannelOutboundSender(async () => ({ success: false, error: '微信接口返回错误 ret=-3' }))
    await assert.rejects(
      executeChannelSendFile({ path: filePath }, { scopeId: 'scope-1' }),
      (error: unknown) => error instanceof ToolDomainError
        && error.errorKind === 'channel_delivery_failed'
        && /ret=-3/.test(error.message),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
    _resetChannelOutboundBridgeForTests()
  }
})

test('sendFileToScopeThread resolves the bound thread and ships the attachment to it', async () => {
  const sent: Array<{ id: string; thread: string; text: string; attachments?: Array<{ name: string }> }> = []
  const dir = mkdtempSync(join(tmpdir(), 'ready-channel-svc-'))
  const filePath = join(dir, 'report.pdf')
  writeFileSync(filePath, 'x'.repeat(2048))
  const makeService = (channelType: string): RemoteChannelService => new RemoteChannelService({
    db: {
      getAgentChannelThreadBySession: () => ({ channel_id: 'chan-1', remote_thread: 'wxid_demo' }),
      getAgentChannel: () => ({ type: channelType }),
      getSetting: () => null,
    },
    sidecar: {
      sendChannel: async (payload: { id: string; thread: string; text: string; attachments?: Array<{ name: string }> }) => {
        sent.push(payload)
        return { success: true }
      },
    },
    recordChannelDeliveryResult: () => {},
  } as unknown as RemoteChannelServiceDeps)

  try {
    const wechat = await makeService('wechat-openclaw').sendFileToScopeThread('scope-1', {
      path: filePath,
      caption: '视听报告',
    })
    assert.equal(wechat.success, true)
    assert.equal(wechat.attachmentName, 'report.pdf')
    const attachmentSend = sent.find((item) => (item.attachments?.length ?? 0) > 0)
    assert.ok(attachmentSend, 'sidecar must receive an attachment payload')
    assert.equal(attachmentSend?.id, 'chan-1')
    assert.equal(attachmentSend?.thread, 'wxid_demo')
    assert.equal(attachmentSend?.attachments?.[0].name, 'report.pdf')

    const unsupported = await makeService('generic-webhook').sendFileToScopeThread('scope-1', { path: filePath })
    assert.equal(unsupported.success, false)
    assert.match(String(unsupported.error), /暂不支持出站附件/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the real-world trigger phrase hits the outbound delivery intent (collector consent stays valid)', () => {
  assert.equal(hasRemoteFileDeliveryIntent('把今天 sepc commercial 的视听报告发我'), true)
  assert.equal(hasRemoteFileDeliveryIntent('这份 PDF 再发一次'), true)
  assert.equal(hasRemoteFileDeliveryIntent('不用发文件了，说结论就行'), false)
})
