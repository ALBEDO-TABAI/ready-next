import assert from 'node:assert/strict'
import test from 'node:test'

import { FEISHU_TOOL_ERROR_KINDS } from '../main/modules/agent-control/contracts/error-kinds'
import {
  digestFeishuChannelSnapshot,
  digestFeishuReadResult,
  executeFeishuTool,
  type FeishuReadAuthority,
  type FeishuToolContext,
} from '../main/modules/tools/feishu-tools'
import { mapErrorKindToEnvelopeKind } from '../main/modules/tools/tool-result-envelope'

const READ_ARGS = {
  channel_id: 'channel-1',
  doc_token: 'doc-1',
  doc_type: 'docx',
}

const CHANNEL = {
  id: 'channel-1',
  type: 'feishu-app',
  enabled: true,
  config: { appId: 'app-1', appSecret: 'secret-1' },
}
const READ_RESULT = { success: true, content: 'current body' }
const READ_AUTHORITY: FeishuReadAuthority = {
  channelId: 'channel-1',
  docToken: 'doc-1',
  docType: 'docx',
  allowedToolName: 'feishu_doc_read',
  channelIdentityDigest: digestFeishuChannelSnapshot(CHANNEL),
  expectedResultDigest: digestFeishuReadResult(READ_RESULT),
}

function readContext(
  read: (channelId: string, docToken: string, docType: string) => Promise<Record<string, unknown>>,
  feishuReadAuthority: FeishuReadAuthority | null = null,
): FeishuToolContext {
  return {
    feishuReadAuthority,
    sidecarManager: {
      listChannels: async () => ({ channels: [CHANNEL] }),
      feishuDocRead: read,
    } as FeishuToolContext['sidecarManager'],
  }
}

test('feishu_doc_read success returns a structured ok output', async () => {
  const output = await executeFeishuTool(
    'feishu_doc_read',
    READ_ARGS,
    readContext(async () => READ_RESULT, READ_AUTHORITY),
  )

  assert.equal(output.shape, 'json')
  assert.equal(output.data?.ok, true)
  assert.equal(output.data?.success, true)
  assert.equal(output.data?.content, 'current body')
  assert.equal(output.data?.errorKind, undefined)
})

test('exact Feishu authority rejects channel replacement and content-version drift', async () => {
  let dispatchCount = 0
  const replacedContext = readContext(async () => {
    dispatchCount += 1
    return READ_RESULT
  }, READ_AUTHORITY)
  replacedContext.sidecarManager!.listChannels = async () => ({
    channels: [{ ...CHANNEL, config: { appId: 'app-2', appSecret: 'secret-2' } }],
  })
  const replaced = await executeFeishuTool('feishu_doc_read', READ_ARGS, replacedContext)
  assert.equal(replaced.data?.errorKind, FEISHU_TOOL_ERROR_KINDS.authorityMismatch.code)
  assert.equal(dispatchCount, 0)

  const drifted = await executeFeishuTool(
    'feishu_doc_read',
    READ_ARGS,
    readContext(async () => ({ success: true, content: 'new body' }), READ_AUTHORITY),
  )
  assert.equal(drifted.data?.ok, false)
  assert.equal(drifted.data?.errorKind, FEISHU_TOOL_ERROR_KINDS.authorityMismatch.code)
})

test('feishu_doc_read classifies sidecar and thrown failures without turning them into success', async (t) => {
  const fixtures: Array<{
    name: string
    result?: Record<string, unknown>
    thrown?: Error & { code?: string }
    expected: string
  }> = [
    { name: 'auth', result: { success: false, status_code: 401, error: 'token expired' }, expected: FEISHU_TOOL_ERROR_KINDS.authRequired.code },
    { name: 'permission', result: { success: false, status_code: 403, error: 'forbidden' }, expected: FEISHU_TOOL_ERROR_KINDS.permissionDenied.code },
    { name: 'not found', result: { success: false, status_code: 404, error: 'not found' }, expected: FEISHU_TOOL_ERROR_KINDS.notFound.code },
    { name: 'rate limited', result: { success: false, status_code: 429, error: 'too many requests' }, expected: FEISHU_TOOL_ERROR_KINDS.rateLimited.code },
    { name: 'upstream 5xx', result: { success: false, status_code: 503, error: 'service unavailable' }, expected: FEISHU_TOOL_ERROR_KINDS.upstreamUnavailable.code },
    { name: 'generic upstream failure', result: { success: false, error: 'provider rejected operation' }, expected: FEISHU_TOOL_ERROR_KINDS.operationFailed.code },
    { name: 'network throw', thrown: Object.assign(new Error('socket ECONNRESET'), { code: 'ECONNRESET' }), expected: FEISHU_TOOL_ERROR_KINDS.networkError.code },
  ]

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const output = await executeFeishuTool(
        'feishu_doc_read',
        READ_ARGS,
        readContext(async () => {
          if (fixture.thrown) throw fixture.thrown
          return fixture.result || { success: false }
        }),
      )

      assert.equal(output.data?.ok, false)
      assert.equal(output.data?.success, false)
      assert.equal(output.data?.errorKind, fixture.expected)
    })
  }
})

test('exact Feishu read authority rejects every mismatch before sidecar dispatch', async () => {
  let dispatchCount = 0
  const context = readContext(async () => {
    dispatchCount += 1
    return { success: true }
  }, READ_AUTHORITY)

  const mismatches: Array<{ toolName: string; args: Record<string, unknown> }> = [
    { toolName: 'feishu_doc_read', args: { ...READ_ARGS, channel_id: 'channel-2' } },
    { toolName: 'feishu_doc_read', args: { ...READ_ARGS, doc_token: 'doc-2' } },
    { toolName: 'feishu_doc_read', args: { ...READ_ARGS, doc_type: 'sheet' } },
    { toolName: 'feishu_doc_list', args: { channel_id: 'channel-1' } },
  ]

  for (const mismatch of mismatches) {
    const output = await executeFeishuTool(mismatch.toolName, mismatch.args, context)
    assert.equal(output.data?.ok, false)
    assert.equal(output.data?.errorKind, FEISHU_TOOL_ERROR_KINDS.authorityMismatch.code)
  }
  assert.equal(dispatchCount, 0)
})

test('Feishu error kinds map to action-oriented tool envelopes', () => {
  const expected = new Map<string, string>([
    [FEISHU_TOOL_ERROR_KINDS.invalidRequest.code, 'arg_error'],
    [FEISHU_TOOL_ERROR_KINDS.authorityMismatch.code, 'denied_by_policy'],
    [FEISHU_TOOL_ERROR_KINDS.sidecarUnavailable.code, 'upstream_error'],
    [FEISHU_TOOL_ERROR_KINDS.authRequired.code, 'auth_expired'],
    [FEISHU_TOOL_ERROR_KINDS.permissionDenied.code, 'denied_by_policy'],
    [FEISHU_TOOL_ERROR_KINDS.notFound.code, 'not_found'],
    [FEISHU_TOOL_ERROR_KINDS.rateLimited.code, 'rate_limited'],
    [FEISHU_TOOL_ERROR_KINDS.networkError.code, 'network_error'],
    [FEISHU_TOOL_ERROR_KINDS.upstreamUnavailable.code, 'upstream_error'],
    [FEISHU_TOOL_ERROR_KINDS.operationFailed.code, 'upstream_error'],
  ])

  for (const [errorKind, envelopeKind] of expected) {
    assert.deepEqual(mapErrorKindToEnvelopeKind(errorKind), { kind: envelopeKind, mapped: true })
  }
})
