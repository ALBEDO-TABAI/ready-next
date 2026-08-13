import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCodexIngressInputWithDiagnostics } from '../renderer/modules/agent/messageComposer'

test('Codex renderer ingress sends verbatim user text and a body-free local image selection', async () => {
  const priorWindow = globalThis.window
  let readFileForAICalls = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        chat: {
          async readFileForAI() {
            readFileForAICalls += 1
            return {
              success: true,
              data: { type: 'image', base64: 'aW1hZ2U=', mimeType: 'image/png' },
            }
          },
        },
      },
    },
  })
  try {
    const result = await buildCodexIngressInputWithDiagnostics({
      content: '用户原文',
      attachments: [{
        id: 'image-1', name: 'secret.png', path: '/private/secret.png',
        type: 'image', size: 5, ext: '.png', source: 'file',
      }],
    })
    assert.equal(result.message, '用户原文')
    assert.deepEqual(result.resources, [{
      kind: 'local_file',
      id: 'image-1',
      name: 'secret.png',
      path: '/private/secret.png',
      size: 5,
      ext: '.png',
      rendererType: 'image',
    }])
    assert.equal(JSON.stringify(result.message).includes('/private/secret.png'), false)
    assert.equal(JSON.stringify(result).includes('aW1hZ2U='), false)
    assert.equal(readFileForAICalls, 0)
    assert.equal(result.diagnostics.inputIncludedCount, 1)
    assert.equal(result.diagnostics.inputFailedCount, 0)
  } finally {
    if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow })
  }
})

test('non-image resources remain body-free selections instead of becoming prompt text', async () => {
  const result = await buildCodexIngressInputWithDiagnostics({
    content: '阅读这个文件',
    attachments: [{
      id: 'doc-1', name: 'secret.txt', path: '/private/secret.txt',
      type: 'text', size: 5, ext: '.txt', source: 'file',
    }],
  })
  assert.equal(result.message, '阅读这个文件')
  assert.deepEqual(result.resources, [{
    kind: 'local_file',
    id: 'doc-1',
    name: 'secret.txt',
    path: '/private/secret.txt',
    size: 5,
    ext: '.txt',
    rendererType: 'text',
  }])
  assert.equal(result.diagnostics.inputIncludedCount, 1)
  assert.equal(result.diagnostics.inputFailedCount, 0)
  assert.equal(JSON.stringify(result.message).includes('/private/secret.txt'), false)
})

test('directory and installed-skill selections use distinct body-free contracts', async () => {
  const result = await buildCodexIngressInputWithDiagnostics({
    content: '使用这些资源',
    attachments: [
      {
        id: 'folder-1', name: '资料', path: '/private/资料', type: 'other',
        isDirectory: true, size: 0, ext: '', source: 'file',
      },
      {
        id: 'skill-1', name: '总结技能', path: '/managed/skills/summary', type: 'other',
        size: 0, ext: '', source: 'skill-folder', skillId: 'summary',
      },
    ],
  })
  assert.deepEqual(result.resources, [
    { kind: 'local_directory', id: 'folder-1', name: '资料', path: '/private/资料' },
    {
      kind: 'skill', id: 'skill-1', name: '总结技能', path: '/managed/skills/summary',
      skillId: 'summary',
    },
  ])
  assert.equal(result.diagnostics.inputIncludedCount, 2)
  assert.equal(result.diagnostics.inputFailedCount, 0)
})

test('browser and document-tab references stay rejected until the host can read them exactly', async () => {
  const result = await buildCodexIngressInputWithDiagnostics({
    content: '看看这个',
    attachments: [{
      id: 'browser-1', name: '网页', path: 'https://example.com', type: 'other',
      size: 0, ext: '', source: 'browser-tab', url: 'https://example.com',
    }],
  })
  assert.equal(result.resources.length, 0)
  assert.equal(result.diagnostics.inputIncludedCount, 0)
  assert.equal(result.diagnostics.inputFailedCount, 1)
})
