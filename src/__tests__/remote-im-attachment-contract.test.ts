import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  hasLocalSendImFileIntent,
  hasRemoteFileDeliveryIntent,
} from '../shared/remote-im-file-intent'
import { normalizeChannelDeliveryResult } from '../main/modules/agent-control/runtime-core/channel-delivery-result'

test('remote IM attachment-only inbound messages continue into the agent payload', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- private runtime guard: full AgentControlRuntime construction needs Electron/DB wiring; this locks the regression-prone early return.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/runtime.ts', import.meta.url), 'utf8')
  const calendarMarker = 'this.maybeEmitRemoteCalendarSuggestions(pending, inboundText)'
  const payloadMarker = 'const promptPayload = this.buildInboundChannelPayload(inboundText, pending.attachments)'
  const calendarIndex = source.indexOf(calendarMarker)
  const payloadIndex = source.indexOf(payloadMarker)

  assert.notEqual(calendarIndex, -1)
  assert.notEqual(payloadIndex, -1)
  assert.ok(calendarIndex < payloadIndex)
  const between = source.slice(calendarIndex, payloadIndex)
  assert.doesNotMatch(between, /if\s*\(\s*!mergedText\s*\)/)
})

test('remote IM outbound file delivery uses projection artifact proofs', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- contract pins safe source of outbound files to task projection proofs, not final-text path scraping.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/runtime.ts', import.meta.url), 'utf8')

  assert.match(source, /collectOutboundChannelAttachments/)
  assert.match(source, /record\.kind !== 'artifact'/)
  assert.match(source, /record\.ref === 'present_file' \|\| record\.ref === 'document_save_tab'/)
  assert.doesNotMatch(source, /finalText\.matchAll/)
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
  // eslint-disable-next-line ready/no-source-grep-test -- private SDK runtime guard: this pins the regression where image-send turns were blocked as vision input or exposed collection tools.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/agent-sdk-runtime.ts', import.meta.url), 'utf8')

  assert.match(source, /function hasLocalSendImIntentForTurn/)
  assert.match(source, /function stripMediaBlocksForLocalSendIm/)
  assert.match(source, /typedActionNames\.add\('skill_send_im_file'\)/)
  assert.match(source, /!localSendImIntent\s*&&\s*\(\s*msgIntent \|\| params\.recentCollectionIntent === true\s*\)/)
  assert.match(source, /this\.collectionIntentTtl\.delete\(sessionId\)/)
  assert.match(source, /this\.batchCollectionIntentTtl\.delete\(sessionId\)/)
  assert.match(source, /const providerContent = stripMediaBlocksForLocalSendIm/)
  assert.match(source, /let nextInput = toSdkInput\(providerContent\)/)
})

test('renderer keeps a parseable local path next to image and video attachment blocks', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- renderer composer is the only place that has both attachment path and base64 media block.
  const source = readFileSync(new URL('../renderer/modules/agent/messageComposer.ts', import.meta.url), 'utf8')

  assert.match(source, /--- 附件: \$\{att\.name\} ---\\n- 路径: \$\{att\.path\}\\n- 类型: image/)
  assert.match(source, /--- 附件: \$\{att\.name\} ---\\n- 路径: \$\{att\.path\}\\n- 类型: video/)
  assert.match(source, /blocks\.push\(\{ type: 'image'/)
  assert.match(source, /blocks\.push\(\{ type: 'video'/)
})

test('send-im host tool context receives the current request envelope', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- private turn-engine guard: direct skill tools must see request resources/recent artifacts from the same turn.
  const source = readFileSync(new URL('../main/modules/agent-control/turn-engine.ts', import.meta.url), 'utf8')

  assert.match(source, /currentUserText:\s*toolContextCurrentUserText/)
  assert.match(source, /requestEnvelope:\s*toolContextRequestEnvelope/)
  assert.match(source, /toolContextCurrentUserText\s*=\s*requestEnvelope\.primaryInstruction \|\| requestEnvelope\.pureUserText \|\| userText/)
  assert.match(source, /toolContextRequestEnvelope\s*=\s*requestEnvelope/)
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

test('sendScoped keeps successful Send IM attachment runs green when only the channel ack text fails', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- private AgentControlRuntime callback: this pins the narrow non-fatal guard without constructing the full Electron runtime.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/runtime.ts', import.meta.url), 'utf8')
  const block = source.match(/onSuccess:\s*async\s*\(result\)[\s\S]*?throw new Error\(sendOk\.error \|\| 'Failed to send channel reply'\)/)?.[0] || ''

  assert.match(block, /result\.success && result\.usedTools\.includes\('skill_send_im_file'\)/)
  assert.match(block, /send_scoped_channel_ack_failed_after_send_im/)
  assert.match(block, /return\s*\n\s*}/)
  assert.match(block, /throw new Error\(sendOk\.error \|\| 'Failed to send channel reply'\)/)
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

test('remote IM outbound file delivery is gated by explicit inbound send intent', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- private runtime guard: attachment sending must be driven by the remote user's request, not a generic "已整理好" model reply.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/runtime.ts', import.meta.url), 'utf8')
  const intentSource = readFileSync(new URL('../shared/remote-im-file-intent.ts', import.meta.url), 'utf8')

  assert.match(intentSource, /笔记/)
  assert.match(intentSource, /脚本/)
  assert.match(intentSource, /报告/)
  assert.match(intentSource, /资料/)
  assert.match(intentSource, /搜索/)
  assert.match(intentSource, /查/)
  assert.doesNotMatch(source, /hasOutboundFileDeliveryClaim/)
  assert.match(source, /collectOutboundChannelAttachments\(\s*executionResult,\s*inboundText,\s*pending\.channelId\s*\)/)
  assert.doesNotMatch(source, /collectOutboundChannelAttachments\(\s*executionResult,\s*inboundText,\s*finalText\s*\)/)
  assert.doesNotMatch(source, /collectOutboundChannelAttachments\(\s*executionResult,\s*inboundText,\s*failure\.reply\s*\)/)
  assert.match(source, /remote_channel_outbound_attachments_collected/)
})

test('remote IM outbound attachments are limited to WeChat and explicit artifact proofs', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- private runtime guard: non-WeChat adapters drop attachments, so runtime must not attach files for them.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/runtime.ts', import.meta.url), 'utf8')
  const collectBlock = source.match(/private collectOutboundChannelAttachments[\s\S]*?\n\s{2}\}/)?.[0] || ''

  assert.match(source, /channelSupportsOutboundAttachments\(channelId\)/)
  assert.match(source, /channel\?\.type === 'wechat-openclaw'/)
  assert.match(collectBlock, /record\.kind !== 'artifact'/)
  assert.doesNotMatch(collectBlock, /projection\.recentArtifacts/)
})

test('remote IM probe treats sidecar body errors as failures', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- private runtime guard: connection tests must not treat {success:false} body responses as success.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/runtime.ts', import.meta.url), 'utf8')
  const probeBlock = source.match(/async sendChannelProbe[\s\S]*?\n\s{2}\}/)?.[0] || ''

  assert.match(probeBlock, /normalizeChannelDeliveryResult\(response,\s*'远程 IM 连接测试发送失败'\)/)
  assert.match(probeBlock, /recordChannelDeliveryResult\(id,\s*result\)/)
})

test('remote IM runtime status counts persisted outbound delivery errors', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- private runtime guard: sidecar liveness alone must not hide persisted send failures.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/runtime.ts', import.meta.url), 'utf8')
  const statusBlock = source.match(/async getRuntimeStatus[\s\S]*?async getCapabilityRuntimeSnapshot/)?.[0] || ''

  assert.match(statusBlock, /persistedErrorCount/)
  assert.match(statusBlock, /Math\.max\(sidecarErrors,\s*persistedErrorCount\)/)
})

test('remote IM delayed progress uses native typing state instead of a chat message', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- private runtime guard: prevents regressing to a visible "处理中…" upstream message.
  const runtimeSource = readFileSync(new URL('../main/modules/agent-control/runtime-core/runtime.ts', import.meta.url), 'utf8')
  const sidecarSource = readFileSync(new URL('../main/modules/agent-control/sidecar-manager.ts', import.meta.url), 'utf8')

  assert.match(sidecarSource, /sendChannelTyping/)
  assert.match(runtimeSource, /sendChannelTyping/)
  assert.match(runtimeSource, /typing:\s*true/)
  assert.match(runtimeSource, /typing:\s*false/)
  assert.doesNotMatch(runtimeSource, /text:\s*'处理中…'/)
  assert.doesNotMatch(runtimeSource, /delayedStatusSent/)
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

test('remote IM slash commands are handled before agent execution', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- private runtime guard: command-only messages must not enter the Agent loop.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/runtime.ts', import.meta.url), 'utf8')
  const commandMarker = 'const commandHandled = await this.handleInboundChannelCommand(pending, inboundText, agent)'
  const userMessageMarker = 'const inboundMessage = this.createConversationMessage(scope.id, {'
  const agentMarker = 'const result = await this.runCoordinator.runInboundChannel('
  const commandIndex = source.indexOf(commandMarker)
  const userMessageIndex = source.indexOf(userMessageMarker)
  const agentIndex = source.indexOf(agentMarker)

  assert.notEqual(commandIndex, -1)
  assert.notEqual(userMessageIndex, -1)
  assert.notEqual(agentIndex, -1)
  assert.ok(commandIndex < userMessageIndex)
  assert.ok(commandIndex < agentIndex)
  assert.match(source, /case 'status':/)
  assert.match(source, /case 'new':/)
  assert.match(source, /case 'model':/)
})

test('remote IM new-session command preserves old conversation history', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- private runtime guard: /new should switch the channel session pointer, not delete or truncate history.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/runtime.ts', import.meta.url), 'utf8')
  const newSessionBlock = source.match(/private startNewRemoteChannelSession[\s\S]*?\n\s{2}\}/)?.[0] || ''

  assert.match(newSessionBlock, /setSetting\(/)
  assert.match(newSessionBlock, /ensureChannelScope/)
  assert.match(source, /getScopedRemoteThreadKey/)
  assert.doesNotMatch(newSessionBlock, /deleteConversation|DELETE FROM chat_messages|DELETE FROM chat_conversations/)
})

test('remote IM model command is read-only until model scope is explicit', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- private runtime guard: WeChat commands must not silently mutate the global model config.
  const source = readFileSync(new URL('../main/modules/agent-control/runtime-core/runtime.ts', import.meta.url), 'utf8')
  const modelBlock = source.match(/private formatRemoteModelCommand[\s\S]*?\n\s{2}\}/)?.[0] || ''

  assert.match(modelBlock, /当前模型/)
  assert.match(modelBlock, /暂不通过远程 IM 修改/)
  assert.doesNotMatch(modelBlock, /setAIConfig|setSetting\(['"]ai_model_config/)
})
