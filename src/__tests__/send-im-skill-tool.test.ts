import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { executeSendImFileTool } from '../main/modules/tools/send-im-skill-tool'

function withTempFile<T>(name: string, body: string, run: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'ready-send-im-'))
  const path = join(dir, name)
  writeFileSync(path, body)
  return run(path).finally(() => {
    rmSync(dir, { recursive: true, force: true })
  })
}

function withTempFiles<T>(files: Array<{ name: string; body: string }>, run: (paths: string[]) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'ready-send-im-'))
  const paths = files.map((file) => {
    const path = join(dir, file.name)
    writeFileSync(path, file.body)
    return path
  })
  return run(paths).finally(() => {
    rmSync(dir, { recursive: true, force: true })
  })
}

function withTempDirectoryFiles<T>(
  files: Array<{ name: string; body: string }>,
  run: (dir: string, paths: string[]) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'ready-send-im-dir-'))
  const paths = files.map((file) => {
    const path = join(dir, file.name)
    writeFileSync(path, file.body)
    return path
  })
  return run(dir, paths).finally(() => {
    rmSync(dir, { recursive: true, force: true })
  })
}

test('send-im file tool sends the referenced local file to the bound WeChat account', async () => {
  await withTempFile('《置身钉内》学习笔记拷貝.md', '# note\n', async (filePath) => {
    const sentPayloads: Array<{
      id: string
      thread?: string
      text: string
      attachments?: Array<Record<string, unknown>>
    }> = []
    let started = false

    const output = await executeSendImFileTool(
      { fileName: '《置身钉内》学习笔记拷貝.md', target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => false,
          start: async () => {
            started = true
          },
          sendChannel: async (payload) => {
            sentPayloads.push(payload)
            return { success: true }
          },
        },
        currentUserText: '把@[《置身钉内》学习笔记拷貝.md]这个文件发到我微信',
        requestEnvelope: {
          resources: [{
            name: '《置身钉内》学习笔记拷貝.md',
            path: filePath,
          }],
        },
      },
    )

    assert.equal(started, true)
    assert.equal(output.data?.status, 'done')
    assert.equal(output.data?.usesSelfTarget, true)
    assert.equal(sentPayloads.length, 1)
    assert.equal(sentPayloads[0]?.id, 'channel-wechat-openclaw-default')
    assert.equal(sentPayloads[0]?.thread, undefined)
    assert.equal(sentPayloads[0]?.attachments?.[0]?.path, filePath)
    assert.equal(sentPayloads[0]?.attachments?.[0]?.mimeType, 'text/markdown')
    assert.equal(sentPayloads[0]?.attachments?.[0]?.type, 'text')
    assert.deepEqual(output.data?.filePaths, [filePath])
    assert.deepEqual(output.data?.fileNames, ['《置身钉内》学习笔记拷貝.md'])
    assert.equal(output.projectionPatch?.skillExecutionForm, 'direct')
    assert.deepEqual(
      (output.projectionPatch?.recentArtifacts as Array<{ path?: string; source?: string }> | undefined)
        ?.map((artifact) => ({ path: artifact.path, source: artifact.source })),
      [{ path: filePath, source: 'send-im' }],
    )
  })
})

test('send-im file tool sends explicit multiple file paths in one WeChat payload', async () => {
  await withTempFiles([
    { name: 'one.md', body: '# one\n' },
    { name: 'two.docx', body: 'docx bytes' },
  ], async (paths) => {
    const sentPayloads: Array<{ attachments?: Array<Record<string, unknown>> }> = []
    const output = await executeSendImFileTool(
      { filePaths: paths, target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async (payload) => {
            sentPayloads.push(payload)
            return { success: true }
          },
        },
      },
    )

    assert.equal(output.data?.status, 'done')
    assert.equal(output.data?.count, 2)
    assert.equal(sentPayloads.length, 1)
    assert.deepEqual(sentPayloads[0]?.attachments?.map((item) => item.path), paths)
  })
})

test('send-im file tool resolves four recent media artifacts without explicit paths', async () => {
  await withTempFiles([
    { name: '无人天中佳景__1.jpg', body: 'jpg1' },
    { name: '无人天中佳景__2.jpg', body: 'jpg2' },
    { name: '无人天中佳景__3.jpg', body: 'jpg3' },
    { name: '无人天中佳景__4.jpg', body: 'jpg4' },
  ], async (paths) => {
    const sentPayloads: Array<{ attachments?: Array<Record<string, unknown>> }> = []
    const output = await executeSendImFileTool(
      { target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async (payload) => {
            sentPayloads.push(payload)
            return { success: true }
          },
        },
        currentUserText: '@[Send IM]把这四张图发到我微信',
        requestEnvelope: {
          recentArtifacts: paths.map((path, index) => ({
            id: `artifact-${index + 1}`,
            module: 'browser',
            kind: 'image',
            label: `图 ${index + 1}`,
            path,
            mimeType: 'image/jpeg',
            createdAt: new Date(0).toISOString(),
          })),
        },
      },
    )

    assert.equal(output.data?.status, 'done')
    assert.equal(output.data?.count, 4)
    assert.equal(sentPayloads.length, 1)
    assert.equal(sentPayloads[0]?.attachments?.length, 4)
    assert.deepEqual(sentPayloads[0]?.attachments?.map((item) => item.path), paths)
    assert.deepEqual(sentPayloads[0]?.attachments?.map((item) => item.type), ['image', 'image', 'image', 'image'])
    assert.deepEqual(sentPayloads[0]?.attachments?.map((item) => item.mimeType), ['image/jpeg', 'image/jpeg', 'image/jpeg', 'image/jpeg'])
    assert.deepEqual(sentPayloads[0]?.attachments?.map((item) => item.name), [
      '无人天中佳景__1.jpg',
      '无人天中佳景__2.jpg',
      '无人天中佳景__3.jpg',
      '无人天中佳景__4.jpg',
    ])
  })
})

test('send-im file tool sends the most recent requested media count', async () => {
  await withTempFiles([
    { name: 'old-1.jpg', body: 'jpg1' },
    { name: 'old-2.jpg', body: 'jpg2' },
    { name: 'new-3.jpg', body: 'jpg3' },
    { name: 'new-4.jpg', body: 'jpg4' },
    { name: 'new-5.jpg', body: 'jpg5' },
    { name: 'new-6.jpg', body: 'jpg6' },
  ], async (paths) => {
    const sentPayloads: Array<{ attachments?: Array<Record<string, unknown>> }> = []
    const output = await executeSendImFileTool(
      { target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async (payload) => {
            sentPayloads.push(payload)
            return { success: true }
          },
        },
        currentUserText: '把这四张图发到我微信',
        requestEnvelope: {
          recentArtifacts: paths.map((path, index) => ({
            id: `artifact-${index + 1}`,
            module: 'browser',
            kind: 'image',
            label: `图 ${index + 1}`,
            path,
            mimeType: 'image/jpeg',
            createdAt: new Date(index).toISOString(),
          })).reverse(),
        },
      },
    )

    assert.equal(output.data?.status, 'done')
    assert.deepEqual(sentPayloads[0]?.attachments?.map((item) => item.path), paths.slice(-4))
  })
})

test('send-im file tool expands a referenced folder when the user asks for images inside it', async () => {
  await withTempDirectoryFiles([
    { name: '元人天中佳景_-1.jpg', body: 'jpg1' },
    { name: '元人天中佳景_-2.jpg', body: 'jpg2' },
    { name: '元人天中佳景_-3.jpg', body: 'jpg3' },
    { name: '元人天中佳景_-4.jpg', body: 'jpg4' },
    { name: '说明.md', body: '# note\n' },
  ], async (dir, paths) => {
    const sentPayloads: Array<{ attachments?: Array<Record<string, unknown>> }> = []
    const output = await executeSendImFileTool(
      { filePath: dir, target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async (payload) => {
            sentPayloads.push(payload)
            return { success: true }
          },
        },
        currentUserText: '@[Send IM]把@[07-项目验证与网页抓取]里的 4 张图发到我的微信',
        requestEnvelope: {
          resources: [{
            name: '07-项目验证与网页抓取',
            path: dir,
            kind: 'folder',
          }],
        },
      },
    )

    assert.equal(output.data?.status, 'done')
    assert.equal(output.data?.count, 4)
    assert.deepEqual(sentPayloads[0]?.attachments?.map((item) => item.path), paths.slice(0, 4))
    assert.deepEqual(sentPayloads[0]?.attachments?.map((item) => item.type), ['image', 'image', 'image', 'image'])
  })
})

test('send-im file tool restores explicit local paths from a retry context', async () => {
  await withTempFiles([
    { name: '元人天中佳景_-1.jpg', body: 'jpg1' },
    { name: '元人天中佳景_-2.jpg', body: 'jpg2' },
    { name: '元人天中佳景_-3.jpg', body: 'jpg3' },
    { name: '元人天中佳景_-4.jpg', body: 'jpg4' },
  ], async (paths) => {
    const sentPayloads: Array<{ attachments?: Array<Record<string, unknown>> }> = []
    const priorList = paths.map((path) => `- \`${path}\``).join('\n')
    const output = await executeSendImFileTool(
      { target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async (payload) => {
            sentPayloads.push(payload)
            return { success: true }
          },
        },
        currentUserText: [
          '用户: @[Send IM]把@[07-项目验证与网页抓取]里的 4 张图发到我的微信',
          '助手: 已确认文件存在：',
          priorList,
          '用户: 重试一次',
        ].join('\n'),
      },
    )

    assert.equal(output.data?.status, 'done')
    assert.equal(output.data?.count, 4)
    assert.deepEqual(sentPayloads[0]?.attachments?.map((item) => item.path), paths)
  })
})

test('send-im file tool restores retry media paths without repeated media wording', async () => {
  await withTempFiles([
    { name: '元人天中佳景_-1.jpg', body: 'jpg1' },
    { name: '元人天中佳景_-2.jpg', body: 'jpg2' },
    { name: '元人天中佳景_-3.jpg', body: 'jpg3' },
    { name: '元人天中佳景_-4.jpg', body: 'jpg4' },
  ], async (paths) => {
    const sentPayloads: Array<{ attachments?: Array<Record<string, unknown>> }> = []
    const output = await executeSendImFileTool(
      { target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async (payload) => {
            sentPayloads.push(payload)
            return { success: true }
          },
        },
        currentUserText: [
          '重试一次',
          '上次要发送的文件：',
          ...paths,
        ].join('\n'),
        requestEnvelope: { primaryInstruction: '重试一次' },
      },
    )

    assert.equal(output.data?.status, 'done')
    assert.equal(output.data?.count, 4)
    assert.deepEqual(sentPayloads[0]?.attachments?.map((item) => item.path), paths)
  })
})

test('send-im file tool preserves resolved files as retry artifacts when sending fails', async () => {
  await withTempFiles([
    { name: 'one.jpg', body: 'jpg1' },
    { name: 'two.jpg', body: 'jpg2' },
  ], async (paths) => {
    const output = await executeSendImFileTool(
      { filePaths: paths, target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async () => ({ success: false, error: 'network down' }),
        },
      },
    )

    assert.equal(output.data?.status, 'error')
    assert.equal(output.data?.errorKind, 'send_failed')
    assert.equal(output.projectionPatch?.terminalFailureReason, 'delivery_failed')
    assert.equal(output.projectionPatch?.terminalFailureTool, 'skill_send_im_file')
    assert.deepEqual(
      (output.projectionPatch?.recentArtifacts as Array<{ path?: string }> | undefined)
        ?.map((artifact) => artifact.path),
      paths,
    )
  })
})

test('send-im file tool classifies WeChat ret=-2 sendmessage as a binding-side rejection', async () => {
  await withTempFile('report.pdf', '%PDF-1.4\n', async (filePath) => {
    let recorded: { channelId: string; result: { success: boolean; error?: string } } | null = null
    const output = await executeSendImFileTool(
      { filePath, target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
          recordChannelDeliveryResult: (channelId, result) => {
            recorded = { channelId, result }
          },
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async () => ({
            success: false,
            error: '微信接口返回错误 ret=-2 (ilink/bot/sendmessage)',
          }),
        },
      },
    )

    assert.equal(output.data?.status, 'error')
    assert.equal(output.data?.errorKind, 'blocked_external')
    assert.equal(output.data?.errorCode, 'wechat_sendmessage_ret_-2')
    assert.equal(output.data?.retryable, false)
    assert.match(output.text, /ret=-2/)
    assert.match(output.text, /从微信给 Ready 发一条新消息/)
    assert.doesNotMatch(output.text, /文件过大|临时异常|稍后重试/)
    assert.equal(output.projectionPatch?.terminalFailureReason, 'delivery_failed')
    assert.equal(output.projectionPatch?.terminalFailureErrorKind, 'blocked_external')
    assert.deepEqual(recorded, {
      channelId: 'channel-wechat-openclaw-default',
      result: {
        success: false,
        error: '微信出站发送会话已失效：ret=-2 (sendmessage)。这不是文件大小或文件类型问题；请先从微信给 Ready 发一条新消息后重试，仍失败就重新绑定微信。',
      },
    })
  })
})

test('send-im file tool classifies WeChat ret=-3 sendmessage as a binding-side rejection', async () => {
  await withTempFile('report.pdf', '%PDF-1.4\n', async (filePath) => {
    const output = await executeSendImFileTool(
      { filePath, target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async () => ({
            success: false,
            error: '微信接口返回错误 ret=-3 (ilink/bot/sendmessage)',
          }),
        },
      },
    )

    assert.equal(output.data?.status, 'error')
    assert.equal(output.data?.errorKind, 'blocked_external')
    assert.equal(output.data?.errorCode, 'wechat_sendmessage_ret_-3')
    assert.equal(output.data?.retryable, false)
    assert.match(output.text, /ret=-3/)
    assert.match(output.text, /从微信给 Ready 发一条新消息/)
    assert.doesNotMatch(output.text, /文件过大|临时异常|稍后重试/)
    assert.equal(output.projectionPatch?.terminalFailureReason, 'delivery_failed')
    assert.equal(output.projectionPatch?.terminalFailureErrorKind, 'blocked_external')
  })
})

test('send-im file tool does not send a folder unless the user asks for media inside it', async () => {
  await withTempDirectoryFiles([
    { name: 'one.jpg', body: 'jpg1' },
  ], async (dir) => {
    let sendCalled = false
    const output = await executeSendImFileTool(
      { filePath: dir, target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async () => {
            sendCalled = true
            return { success: true }
          },
        },
        currentUserText: '把这个文件夹发到我微信',
      },
    )

    assert.equal(output.data?.status, 'error')
    assert.equal(output.data?.errorKind, 'directory_not_supported')
    assert.equal(sendCalled, false)
  })
})

test('send-im file tool asks for clarification when recent media is too broad', async () => {
  await withTempFiles([
    { name: 'one.jpg', body: 'jpg1' },
    { name: 'two.jpg', body: 'jpg2' },
    { name: 'three.jpg', body: 'jpg3' },
    { name: 'four.jpg', body: 'jpg4' },
    { name: 'five.jpg', body: 'jpg5' },
  ], async (paths) => {
    let sendCalled = false
    const output = await executeSendImFileTool(
      { target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async () => {
            sendCalled = true
            return { success: true }
          },
        },
        currentUserText: '把这些图发到我微信',
        requestEnvelope: {
          recentArtifacts: paths.map((path, index) => ({
            id: `artifact-${index + 1}`,
            module: 'browser',
            kind: 'image',
            label: `图 ${index + 1}`,
            path,
            mimeType: 'image/jpeg',
            createdAt: new Date(index).toISOString(),
          })),
        },
      },
    )

    assert.equal(output.data?.status, 'error')
    assert.equal(output.data?.errorKind, 'file_ambiguous')
    assert.equal(sendCalled, false)
  })
})

test('send-im file tool cancels when the current user text negates sending', async () => {
  await withTempFiles([
    { name: 'one.jpg', body: 'jpg1' },
    { name: 'two.jpg', body: 'jpg2' },
    { name: 'three.jpg', body: 'jpg3' },
    { name: 'four.jpg', body: 'jpg4' },
  ], async (paths) => {
    let sendCalled = false
    const output = await executeSendImFileTool(
      { target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async () => {
            sendCalled = true
            return { success: true }
          },
        },
        currentUserText: '不要把这四张图发到我微信',
        requestEnvelope: {
          recentArtifacts: paths.map((path, index) => ({
            id: `artifact-${index + 1}`,
            module: 'browser',
            kind: 'image',
            label: `图 ${index + 1}`,
            path,
            mimeType: 'image/jpeg',
            createdAt: new Date(index).toISOString(),
          })),
        },
      },
    )

    assert.equal(output.data?.status, 'error')
    assert.equal(output.data?.errorKind, 'intent_negated')
    assert.equal(sendCalled, false)
  })
})

test('send-im file tool cancels when negation appears after the IM target', async () => {
  await withTempFiles([
    { name: 'one.jpg', body: 'jpg1' },
    { name: 'two.jpg', body: 'jpg2' },
    { name: 'three.jpg', body: 'jpg3' },
    { name: 'four.jpg', body: 'jpg4' },
  ], async (paths) => {
    let sendCalled = false
    const output = await executeSendImFileTool(
      { target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async () => {
            sendCalled = true
            return { success: true }
          },
        },
        currentUserText: '把这四张图发到我微信，但先别发',
        requestEnvelope: {
          recentArtifacts: paths.map((path, index) => ({
            id: `artifact-${index + 1}`,
            module: 'browser',
            kind: 'image',
            label: `图 ${index + 1}`,
            path,
            mimeType: 'image/jpeg',
            createdAt: new Date(index).toISOString(),
          })),
        },
      },
    )

    assert.equal(output.data?.status, 'error')
    assert.equal(output.data?.errorKind, 'intent_negated')
    assert.equal(sendCalled, false)
  })
})

test('send-im file tool cancels when the user cancels after the IM target', async () => {
  await withTempFiles([
    { name: 'one.jpg', body: 'jpg1' },
    { name: 'two.jpg', body: 'jpg2' },
    { name: 'three.jpg', body: 'jpg3' },
    { name: 'four.jpg', body: 'jpg4' },
  ], async (paths) => {
    let sendCalled = false
    const output = await executeSendImFileTool(
      { target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async () => {
            sendCalled = true
            return { success: true }
          },
        },
        currentUserText: '把这四张图发到我微信，取消',
        requestEnvelope: {
          recentArtifacts: paths.map((path, index) => ({
            id: `artifact-${index + 1}`,
            module: 'browser',
            kind: 'image',
            label: `图 ${index + 1}`,
            path,
            mimeType: 'image/jpeg',
            createdAt: new Date(index).toISOString(),
          })),
        },
      },
    )

    assert.equal(output.data?.status, 'error')
    assert.equal(output.data?.errorKind, 'intent_negated')
    assert.equal(sendCalled, false)
  })
})

test('send-im file tool cancels when the user cancels before explicit Send IM mention', async () => {
  await withTempFile('报告.md', '# report\n', async (filePath) => {
    let sendCalled = false
    const output = await executeSendImFileTool(
      { fileName: '报告.md', target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async () => {
            sendCalled = true
            return { success: true }
          },
        },
        currentUserText: '取消 @[Send IM]@@[报告.md]',
        requestEnvelope: {
          resources: [{
            name: '报告.md',
            path: filePath,
          }],
        },
      },
    )

    assert.equal(output.data?.status, 'error')
    assert.equal(output.data?.errorKind, 'intent_negated')
    assert.equal(sendCalled, false)
  })
})

test('send-im file tool prefers explicit recent-media wording over a single generic resource', async () => {
  await withTempFiles([
    { name: 'report.md', body: '# report\n' },
    { name: 'one.jpg', body: 'jpg1' },
    { name: 'two.jpg', body: 'jpg2' },
    { name: 'three.jpg', body: 'jpg3' },
    { name: 'four.jpg', body: 'jpg4' },
  ], async (paths) => {
    const [reportPath, ...imagePaths] = paths
    const sentPayloads: Array<{ attachments?: Array<Record<string, unknown>> }> = []
    const output = await executeSendImFileTool(
      { target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async (payload) => {
            sentPayloads.push(payload)
            return { success: true }
          },
        },
        currentUserText: '把这四张图发到我微信',
        requestEnvelope: {
          resources: [{ name: 'report.md', path: reportPath }],
          recentArtifacts: imagePaths.map((path, index) => ({
            id: `artifact-${index + 1}`,
            module: 'browser',
            kind: 'image',
            label: `图 ${index + 1}`,
            path,
            mimeType: 'image/jpeg',
            createdAt: new Date(index).toISOString(),
          })),
        },
      },
    )

    assert.equal(output.data?.status, 'done')
    assert.deepEqual(sentPayloads[0]?.attachments?.map((item) => item.path), imagePaths)
  })
})

test('send-im file tool returns structured disambiguation for multiple unmatched files', async () => {
  await withTempFiles([
    { name: 'a.md', body: '# a\n' },
    { name: 'b.md', body: '# b\n' },
  ], async (paths) => {
    const output = await executeSendImFileTool(
      { target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async () => ({ success: true }),
        },
        currentUserText: '@[Send IM]把文件发到我微信',
        requestEnvelope: {
          resources: paths.map((path) => ({ name: path.split('/').pop(), path })),
        },
      },
    )

    assert.equal(output.data?.status, 'error')
    assert.equal(output.data?.errorKind, 'file_ambiguous')
    const detail = output.data?.detail as { candidates?: Array<{ path: string }> } | undefined
    assert.deepEqual(detail?.candidates?.map((item) => item.path), paths)
  })
})

test('send-im file tool does not send the only resource when an explicit fileName misses', async () => {
  await withTempFile('actual.md', '# actual\n', async (filePath) => {
    let sendCalled = false
    const output = await executeSendImFileTool(
      { fileName: 'missing.md', target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async () => {
            sendCalled = true
            return { success: true }
          },
        },
        currentUserText: '把 missing.md 发到我微信',
        requestEnvelope: {
          resources: [{ name: 'actual.md', path: filePath }],
        },
      },
    )

    assert.equal(output.data?.status, 'error')
    assert.equal(output.data?.errorKind, 'file_not_found')
    assert.equal(output.projectionPatch?.terminalFailureReason, 'no_artifact')
    assert.equal(sendCalled, false)
  })
})

test('send-im file tool rejects explicit WeChat recipients', async () => {
  await withTempFile('report.md', '# report\n', async (filePath) => {
    let sendCalled = false

    const output = await executeSendImFileTool(
      { filePath, target: 'wechat', recipient: 'friend@im.wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async () => {
            sendCalled = true
            return { success: true }
          },
        },
      },
    )

    assert.equal(output.data?.status, 'error')
    assert.equal(output.data?.errorKind, 'channel_not_ready')
    assert.match(output.text, /只支持发送到已绑定账号本人/)
    assert.equal(sendCalled, false)
  })
})
