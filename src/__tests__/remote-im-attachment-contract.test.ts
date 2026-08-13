import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  hasLocalSendImFileIntent,
  hasRemoteFileDeliveryIntent,
} from '../shared/remote-im-file-intent'
import { normalizeChannelDeliveryResult } from '../main/modules/agent-control/runtime-core/channel-delivery-result'
import { AgentSdkRuntime, type AgentSdkRuntimeDeps } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import type { RunMessage } from '../main/modules/agent-control/contracts/run-contracts'
import { toSdkInput } from '../main/modules/agent-control/runtime-core/agent-sdk-execution-utils'
import { stripMediaBlocksForLocalSendIm } from '../main/modules/agent-control/runtime-core/agent-sdk-foundation-utils'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const fakeConfig: NonNullable<ReturnType<NonNullable<AgentSdkRuntimeDeps['loadAIConfig']>>['config']> = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
}

function createRuntimeToolNames(params: {
  message: string
  requestEnvelope?: unknown
  localSendImIntent?: boolean
  skillSurfaceComposition?: 'additive' | 'exclusive'
}): string[] {
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
  })
  const privateRuntime = runtime as unknown as {
    resolveSkillAuthorizationForTurn: (
      message: string,
      sessionId?: string,
      requestEnvelope?: unknown,
      forceLocalSendImIntent?: boolean,
    ) => unknown
    toolExecutor: {
      listDefaultToolDefinitionsForTurn: (input: {
        message: string
        sessionId?: string
        scopeId?: string
        config: typeof fakeConfig
        browserHostAvailable: boolean
        feishuConnected: boolean
        authorization: unknown
        localSendImIntent?: boolean
        requestEnvelope?: unknown
      }) => Array<{ name: string }>
    }
  }
  const authorization = privateRuntime.resolveSkillAuthorizationForTurn(
    params.message,
    'scope-send-im-browser-tools',
    params.requestEnvelope,
    params.localSendImIntent === true,
  )
  return privateRuntime.toolExecutor.listDefaultToolDefinitionsForTurn({
    message: params.message,
    sessionId: 'scope-send-im-browser-tools',
    scopeId: 'scope-send-im-browser-tools',
    config: fakeConfig,
    browserHostAvailable: true,
    feishuConnected: false,
    authorization,
    skillSurfaceComposition: params.skillSurfaceComposition,
    localSendImIntent: params.localSendImIntent,
    requestEnvelope: params.requestEnvelope,
  }).map((definition) => definition.name)
}

test('remote-im-attachment-contract declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'remote-im-attachment-contract transitive sqlite load')
})

test('remote IM attachment-only inbound messages are retained as scope resources', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- resource metadata is the durable attachment contract consumed by listConversationAttachments.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/remote-channel-service.ts', import.meta.url), 'utf8')
  assert.match(source, /content:\s*inboundText/)
  assert.match(source, /attachments:\s*pending\.attachments/)
  assert.match(source, /remote_inbound_resource_stored/)
  assert.doesNotMatch(source, /buildInboundChannelPayload|runInboundChannel/)
})

test('remote IM does not infer an automatic outbound file from Agent projections', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- outbound files must use the explicit channel_send_file path.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/remote-channel-service.ts', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /collectOutboundChannelAttachments|taskProjectionId|proofRefs/)
  assert.match(source, /async sendFileToScopeThread/)
})

test('remote IM outbound file intent requires directed send wording', () => {
  const positives = [
    '把相关资料发给我',
    '把 md 文档发一下给我',
    '帮我写成 md 文件发给我',
    '学习笔记也发一下',
    '报告传过来',
    '帮我发一份脚本',
    '上次没发成功，再试一次把 pdf 文档发给我',
    '把图片发我',
  ]
  const negatives = [
    '帮我搜集相关资料',
    '帮我写一个报告',
    '帮我整理学习笔记',
    '给我写一个报告',
    '给我整理学习笔记',
    '帮我找一些图片资料',
    '帮我写一个报告发给我',
    '帮我整理学习笔记发给我',
    '帮我搜集相关资料发给我',
    '帮我找一些图片资料发到微信',
    '帮我搜资料然后发给我总结',
    '帮我查资料发给我结论',
    '帮我找图片资料不要发附件，只发总结给我',
    '图片不要发给我，只给总结',
    '资料不要发给我，只给结论',
    '报告不要发给我，只给结论',
    '图片发给我，但不要附件，只给总结',
    '报告发给我，但不要附件，只给结论',
  ]

  for (const input of positives) {
    assert.equal(hasRemoteFileDeliveryIntent(input), true, input)
  }
  for (const input of negatives) {
    assert.equal(hasRemoteFileDeliveryIntent(input), false, input)
  }
})

test('local send-im file intent accepts referenced files or recent media with directed IM target', () => {
  const positives = [
    '把@[《置身钉内》学习笔记拷貝.md]这个文件发到我微信',
    '请把@[素材.png]发送到微信',
    '把@[报告.docx]传到远程 IM',
    '微信里发一下@[学习笔记.md]',
    '把这四张图发到我微信',
    '把最近下载的图片发微信',
    '@[Send IM]@@[实习纲要.md]',
    '@send-im 把这四张图发出去',
    // Explicit skill mention / directed send + an inline absolute file path is unambiguous
    //   even with no attachment context (regression: this used to short-circuit to BLOCK).
    '@[Send IM]把 /Users/user/outputs/send-im-live/ready-send-im-live.md 发到我微信',
    '把 /Users/user/outputs/report.pdf 发到我微信',
    '用 sendim 把 /Users/user/x/foo.md 发到我微信',
  ]
  const negatives = [
    '帮我整理@[《置身钉内》学习笔记拷貝.md]这个学习笔记',
    '把@[报告.md]改写成适合微信发的版本',
    '帮我搜集资料发散一下微信案例',
    '把这个文件发到我微信',
    '把@[报告.md]发给我',
    '不要把这四张图发到我微信',
    '不要把@[报告.md]发到我微信',
    '把这四张图发到我微信，但先别发',
    '把这四张图发到我微信，取消',
    '把这四张图发到我微信，不用了',
    '把这四张图发到我微信，算了',
    '@[Send IM] 这个技能能做什么',
    '不要 @[Send IM]@@[报告.md]',
    '取消 @[Send IM]@@[报告.md]',
    '算了 @[Send IM]@@[报告.md]',
  ]

  for (const input of positives) {
    assert.equal(hasLocalSendImFileIntent(input), true, input)
  }
  for (const input of negatives) {
    assert.equal(hasLocalSendImFileIntent(input), false, input)
  }

  const attachmentContextPositives = [
    '把图片发到我微信',
    '请把附件发送到微信',
    '把这个文件发到我微信',
    '把它传到远程 IM',
    '@[Send IM] 把这个文件发出去',
  ]
  const attachmentContextNegatives = [
    '帮我找一些图片资料发到微信',
    '帮我搜集相关资料发到微信',
    '帮我整理学习笔记发到微信',
    '帮我写一个报告发到微信',
  ]

  for (const input of attachmentContextPositives) {
    assert.equal(hasLocalSendImFileIntent(input, { hasAttachmentContext: true }), true, input)
    assert.equal(hasLocalSendImFileIntent(input), false, input)
  }
  for (const input of attachmentContextNegatives) {
    assert.equal(hasLocalSendImFileIntent(input, { hasAttachmentContext: true }), false, input)
  }
})

test('local send-im attached media turns bypass model vision input and browser collection exposure', () => {
  const mediaMessage: RunMessage = [
    { type: 'text', text: '把这张图发到我微信' },
    { type: 'image', base64: 'ZmFrZS1pbWFnZQ==', mimeType: 'image/png' },
  ]
  const stripped = stripMediaBlocksForLocalSendIm(mediaMessage, undefined, true)
  const modelInput = toSdkInput(stripped)
  assert.doesNotMatch(JSON.stringify(modelInput), /input_image|data:image\/png/)
  assert.match(JSON.stringify(modelInput), /不发送给模型解析/)
})

test('an exclusive local send-im skill suppresses an otherwise active browser surface', () => {
  const collectionMessage = '把小红书这个博主的图片都采集下来'
  const browserEnvironment = {
    workbenchMode: 'browser',
    browserPageRef: {
      tabId: 'tab-1',
      physicalTargetToken: 'physical-tab-1',
      mainFrameDocumentToken: 'document-tab-1',
    },
  }
  const collectionToolNames = createRuntimeToolNames({
    message: collectionMessage,
    requestEnvelope: { primaryInstruction: collectionMessage, environmentHints: browserEnvironment },
  })
  assert.ok(collectionToolNames.includes('browser_collect'))

  const sendImMessage = '把小红书这个博主的图片都采集下来，并把这四张图发到我微信'
  const requestEnvelope = {
    primaryInstruction: sendImMessage,
    environmentHints: browserEnvironment,
    resources: [
      { name: '图1.png', path: '/tmp/ready-send-im-proof/图1.png', kind: 'image' },
    ],
  }
  const sendImToolNames = createRuntimeToolNames({
    message: sendImMessage,
    requestEnvelope,
    skillSurfaceComposition: 'exclusive',
  })

  assert.ok(sendImToolNames.includes('skill_send_im_file'))
  assert.equal(sendImToolNames.some((name) => name.startsWith('browser_')), false)
})

test('renderer keeps a parseable local path next to image and video attachment blocks', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- renderer composer is the only place that has both attachment path and base64 media block.
  const source = readFileSync(new URL('../renderer/modules/agent/messageComposer.ts', import.meta.url), 'utf8')

  assert.match(source, /--- 附件: \$\{att\.name\} ---\\n- 路径: \$\{att\.path\}\\n- 类型: image/)
  assert.match(source, /--- 附件: \$\{att\.name\} ---\\n- 路径: \$\{att\.path\}\\n- 类型: video/)
  assert.match(source, /blocks\.push\(\{ type: 'image'/)
  assert.match(source, /blocks\.push\(\{ type: 'video'/)
})

test('remote IM channel delivery treats sidecar body errors as failures', () => {
  assert.deepEqual(
    normalizeChannelDeliveryResult({ success: false, error: 'upload failed' }, 'fallback'),
    { success: false, error: 'upload failed' },
  )
  assert.deepEqual(
    normalizeChannelDeliveryResult({ error: 'send failed' }, 'fallback'),
    { success: false, error: 'send failed' },
  )
  assert.deepEqual(
    normalizeChannelDeliveryResult({ success: false }, 'fallback'),
    { success: false, error: 'fallback' },
  )
  assert.deepEqual(normalizeChannelDeliveryResult({ success: true }, 'fallback'), { success: true })
})

test('remote IM channel delivery explains WeChat ret=-2 as an outbound session failure', () => {
  const result = normalizeChannelDeliveryResult(
    { success: false, error: '微信接口返回错误 ret=-2 (ilink/bot/sendmessage)' },
    'fallback',
  )

  assert.equal(result.success, false)
  assert.match(result.error || '', /出站发送会话已失效/)
  assert.match(result.error || '', /从微信给 Ready 发一条新消息/)
  assert.doesNotMatch(result.error || '', /文件过大|临时异常|稍后重试/)
})

test('remote IM channel delivery explains WeChat ret=-3 as an outbound session failure', () => {
  const result = normalizeChannelDeliveryResult(
    { success: false, error: '微信接口返回错误 ret=-3 (ilink/bot/sendmessage)' },
    'fallback',
  )

  assert.equal(result.success, false)
  assert.match(result.error || '', /ret=-3/)
  assert.match(result.error || '', /出站发送会话已失效/)
  assert.match(result.error || '', /从微信给 Ready 发一条新消息/)
})

test('Codex sendScoped does not retain the retired Ready-owned channel acknowledgement callback', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed E1 live-graph contract: the old callback must not return as a hidden compatibility path.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/runtime.ts', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /send_scoped_channel_ack_failed_after_send_im/)
  assert.doesNotMatch(source, /Failed to send channel reply/)
})

test('send-im skill only exposes the direct file send tool and no recipient option', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../assets/embedded-skills/send-im/ready-skill.json', import.meta.url), 'utf8'),
  ) as { allowed_tools?: unknown; actions?: Array<{ params?: Array<{ name?: string }>; description?: string }> }
  const serialized = JSON.stringify(manifest)
  const paramNames = manifest.actions?.flatMap((action) => action.params?.map((param) => param.name) || []) || []

  assert.deepEqual(manifest.allowed_tools, ['skill_send_im_file'])
  assert.equal(paramNames.includes('filePaths'), true)
  assert.equal(paramNames.includes('fileNames'), true)
  assert.equal(paramNames.includes('recipient'), false)
  assert.doesNotMatch(serialized, /默认收件人|defaultTarget/)
})

test('remote IM automatic outbound file collection is retired', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- ordinary inbound is resource-only; explicit outbound uses channel_send_file.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/remote-channel-service.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /collectOutboundChannelAttachments|remote_channel_outbound_attachments_collected/)
  assert.match(source, /sendFileToScopeThread/)
})

test('explicit remote IM outbound attachments remain limited to WeChat', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- direct send keeps its channel-type boundary.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/remote-channel-service.ts', import.meta.url), 'utf8')

  assert.match(source, /private channelSupportsOutboundAttachments\(channelId/)
  assert.match(source, /this\.channelSupportsOutboundAttachments\(thread\.channel_id\)/)
  assert.match(source, /channel\?\.type === 'wechat-openclaw'/)
  assert.match(source, /async sendFileToScopeThread/)
})

test('remote IM probe treats sidecar body errors as failures', () => {
  // B8-D R3 — sendChannelProbe moved from runtime.ts into the delegated
  // ChannelConfigService; the probe contract is pinned on the service body,
  // and the runtime one-line delegate keeps the IPC→runtime→service chain.
  // eslint-disable-next-line ready/no-source-grep-test -- private service guard: connection tests must not treat {success:false} body responses as success.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/channel-config-service.ts', import.meta.url), 'utf8')
  const probeBlock = source.match(/async sendChannelProbe[\s\S]*?\n\s{2}\}/)?.[0] || ''

  assert.match(probeBlock, /normalizeChannelDeliveryResult\(response,\s*'远程 IM 连接测试发送失败'\)/)
  assert.match(probeBlock, /recordChannelDeliveryResult\(id,\s*result\)/)

  // eslint-disable-next-line ready/no-source-grep-test -- delegate wiring pin: the runtime public face must route probes through the extracted service.
  const runtimeSource = readFileSync(new URL('../main/modules/agent-control/runtime-core/runtime.ts', import.meta.url), 'utf8')
  assert.match(runtimeSource, /return this\.channelConfig\.sendChannelProbe\(id,\s*text\)/)
})

test('remote IM runtime status counts persisted outbound delivery errors', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- private runtime guard: sidecar liveness alone must not hide persisted send failures.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/runtime.ts', import.meta.url), 'utf8')
  const statusBlock = source.match(/async getRuntimeStatus[\s\S]*?async getCapabilityRuntimeSnapshot/)?.[0] || ''

  assert.match(statusBlock, /persistedErrorCount/)
  assert.match(statusBlock, /Math\.max\(sidecarErrors,\s*persistedErrorCount\)/)
})

test('ordinary remote IM inbound emits no typing state or automatic progress message', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- resource-only ingress has no background work to narrate.
  const serviceSource = readFileSync(new URL('../main/modules/agent-control/runtime-core/remote-channel-service.ts', import.meta.url), 'utf8')

  assert.doesNotMatch(serviceSource, /sendChannelTyping|typing:\s*(?:true|false)/)
  assert.doesNotMatch(serviceSource, /text:\s*'处理中…'/)
})

test('WeChat settings preserves OpenClaw routing config before login', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- renderer settings contract: routeTag is the current missing bridge between UI config and the adapter.
  const source = readFileSync(new URL('../renderer/components/settings/RemoteIMSettingsPanel.tsx', import.meta.url), 'utf8')

  assert.match(source, /wechatRouteTag/)
  assert.match(source, /wechatBotAgent/)
  assert.match(source, /config\.routeTag = routeTag/)
  assert.match(source, /config\.botAgent = botAgent/)
  assert.match(source, /saveWechatChannel\(undefined,\s*\{\s*enabled:\s*Boolean\(wechatChannel\?\.enabled\),\s*silent:\s*true\s*\}\)/)
  assert.match(source, /OpenClaw routeTag/)
})

test('remote IM slash commands are handled before ordinary resource persistence', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- command-only messages keep their explicit control path without an Agent loop.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/remote-channel-service.ts', import.meta.url), 'utf8')
  const commandMarker = 'const commandHandled = await this.handleInboundChannelCommand(pending, inboundText, agent)'
  const userMessageMarker = 'const inboundMessage = this.deps.createConversationMessage(scope.id, {'
  const commandIndex = source.indexOf(commandMarker)
  const userMessageIndex = source.indexOf(userMessageMarker)

  assert.notEqual(commandIndex, -1)
  assert.notEqual(userMessageIndex, -1)
  assert.ok(commandIndex < userMessageIndex)
  assert.doesNotMatch(source, /runInboundChannel/)
  assert.match(source, /case 'status':/)
  assert.match(source, /case 'new':/)
  assert.match(source, /case 'model':/)
})

test('remote IM new-session command preserves old conversation history', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- private service guard: /new should switch the channel session pointer, not delete or truncate history. B8-D R5: cluster lives in RemoteChannelService.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/remote-channel-service.ts', import.meta.url), 'utf8')
  const newSessionBlock = source.match(/private startNewRemoteChannelSession[\s\S]*?\n\s{2}\}/)?.[0] || ''

  assert.match(newSessionBlock, /setSetting\(/)
  assert.match(newSessionBlock, /ensureChannelScope/)
  assert.match(source, /getScopedRemoteThreadKey/)
  assert.doesNotMatch(newSessionBlock, /deleteConversation|DELETE FROM chat_messages|DELETE FROM chat_conversations/)
})

test('remote IM model command is read-only until model scope is explicit', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- private service guard: WeChat commands must not silently mutate the global model config. B8-D R5: cluster lives in RemoteChannelService.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/remote-channel-service.ts', import.meta.url), 'utf8')
  const modelBlock = source.match(/private formatRemoteModelCommand[\s\S]*?\n\s{2}\}/)?.[0] || ''

  assert.match(modelBlock, /当前模型/)
  assert.match(modelBlock, /暂不通过远程 IM 修改/)
  assert.doesNotMatch(modelBlock, /setAIConfig|setSetting\(['"]ai_model_config/)
})
