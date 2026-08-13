import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCodexIngressInputWithDiagnostics,
  resolveReferencedFilePoolAttachments,
} from '../renderer/modules/agent/messageComposer'

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

test('browser, calendar and selected document text use narrow structured reference contracts', async () => {
  const result = await buildCodexIngressInputWithDiagnostics({
    content: '看看这个',
    attachments: [
      {
        id: 'browser-1', name: '网页', path: 'browser-tab://tab-1', type: 'other',
        size: 0, ext: '', source: 'browser-tab', browserTabId: 'tab-1',
      },
      {
        id: 'calendar-1', name: '评审会', path: 'calendar-event://event-1', type: 'text',
        size: 0, ext: '.calendar', source: 'calendar-event', eventId: 'event-1',
      },
      {
        id: 'quote-1', name: '方案.md', path: '/workspace/方案.md', type: 'text',
        size: 4, ext: '.quote', source: 'document-quote', selection: '准确摘录',
        documentTitle: '方案.md', lineStart: 4, lineEnd: 4,
      },
    ],
  })
  assert.deepEqual(result.resources, [
    { kind: 'browser_tab', id: 'browser-1', name: '网页', tabId: 'tab-1' },
    { kind: 'calendar_event', id: 'calendar-1', name: '评审会', eventId: 'event-1' },
    {
      kind: 'quoted_text', id: 'quote-1', name: '方案.md', text: '准确摘录',
      documentTitle: '方案.md', lineStart: 4, lineEnd: 4,
    },
  ])
  assert.equal(result.message, '看看这个')
  assert.equal(result.diagnostics.inputIncludedCount, 3)
  assert.equal(result.diagnostics.inputFailedCount, 0)
})

test('a clean Windows document tab remains a file reference instead of being mistaken for an unsaved quote', async () => {
  const result = await buildCodexIngressInputWithDiagnostics({
    content: '阅读这个文档',
    attachments: [{
      id: 'windows-doc', name: '方案.md', path: 'C:\\workspace\\方案.md', type: 'text',
      size: 12, ext: '.md', source: 'document-tab', dirty: false, selection: 'visible selection',
    }],
  })
  assert.deepEqual(result.resources, [{
    kind: 'local_file', id: 'windows-doc', name: '方案.md', path: 'C:\\workspace\\方案.md',
    size: 12, ext: '.md', rendererType: 'text',
  }])
})

test('@ references reuse the same structured resource identities without duplicating a repeated mention', async () => {
  const filePool = [
    {
      id: 'browser-pool', name: '网页资料', path: 'browser-tab://tab-pool', type: 'text' as const,
      size: 0, ext: '.url', source: 'browser-tab' as const, browserTabId: 'tab-pool',
    },
    {
      id: 'quote-pool', name: '摘录', path: 'document-quote://quote-pool', type: 'text' as const,
      size: 4, ext: '.quote', source: 'document-quote' as const, selection: '原文事实',
    },
  ]
  const referenced = resolveReferencedFilePoolAttachments(
    '比较 @[网页资料] 和 @[摘录]，再看一次 @[网页资料]',
    filePool,
  )
  assert.deepEqual(referenced.map((item) => item.id), ['browser-pool', 'quote-pool'])
  const result = await buildCodexIngressInputWithDiagnostics({
    content: '比较 @[网页资料] 和 @[摘录]',
    attachments: referenced,
  })
  assert.deepEqual(result.resources, [
    { kind: 'browser_tab', id: 'browser-pool', name: '网页资料', tabId: 'tab-pool' },
    { kind: 'quoted_text', id: 'quote-pool', name: '摘录', text: '原文事实' },
  ])
})
