import { beginGeneratedImageDrag } from '../renderer/modules/image-generation/generatedImageDrag'
import { writeReadyRefTransfer } from '../shared/ready-ref'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { editorFixture } from './helpers/ready-block-editor-fixture'
import test from 'node:test'
import { act, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import ChatAttachments from '../renderer/components/agent/ChatAttachments'
import { GeneratedImageGallery } from '../renderer/components/agent/GeneratedImageGallery'
import { AttachmentPreviewModal } from '../renderer/components/agent/chat-panel/attachments-preview'
import { buildSlashCommandInsertion } from '../renderer/modules/agent/slash-skill-selection'
import type { AgentMessage } from '../renderer/modules/agent/types'
import {
  generatedImageArtifactToAttachment,
  generatedImagesFromArtifacts,
  generatedImagesFromMessage,
} from '../renderer/modules/image-generation/generatedImageArtifacts'
import {
  getGeneratedImageDragPayload, endGeneratedImageDrag,
} from '../renderer/modules/image-generation/generatedImageDrag'
import { isImageGenerationReferencePath } from '../shared/image-generation'
import { buildCanonicalCoreCloseoutMessage } from '../main/modules/repositories/canonical-core-closeout-message'

const artifact = {
  id: 'generated-image:one',
  module: 'system',
  kind: 'generated_image',
  label: 'ready-image.png',
  path: '/tmp/ready-image-generation/ready-image.png',
  mimeType: 'image/png',
  createdAt: '2026-07-15T00:00:00.000Z',
  meta: { model: 'gpt-image-test' },
}

test('generated image artifacts round-trip from projection snapshot into chat attachments', () => {
  const message: AgentMessage = {
    id: 'message-1',
    agent: 'ready',
    content: '已生成图片。',
    type: 'agent',
    timestamp: new Date('2026-07-15T00:00:00.000Z'),
    meta: {
      taskSnapshot: JSON.stringify({ recentArtifacts: [artifact, artifact] }),
    },
  }
  const images = generatedImagesFromMessage(message)
  assert.equal(images.length, 1)
  assert.equal(images[0]?.kind, 'generated_image')
  const attachment = generatedImageArtifactToAttachment(images[0])
  assert.equal(attachment.type, 'image')
  assert.equal(attachment.source, 'generated-image')
  assert.equal(attachment.path, artifact.path)
  assert.equal(attachment.contentType, 'image/png')
})

test('canonical terminal messages retain generated image artifacts for immediate and restored previews', () => {
  const canonical = buildCanonicalCoreCloseoutMessage({
    parentTaskId: 'task-image',
    ownerRunId: 'run-image',
    conversationId: 'scope-image',
    finalText: '已生成图片。',
    timestamp: '2026-07-23T10:30:06.000Z',
    terminalReason: 'done',
    recentArtifacts: [artifact],
  })
  const message: AgentMessage = {
    id: canonical.id,
    agent: 'ready',
    content: canonical.content,
    type: 'agent',
    timestamp: new Date(canonical.timestamp),
    meta: canonical.meta,
  }

  assert.equal(generatedImagesFromMessage(message)[0]?.path, artifact.path)
})

test('live task artifacts restore the preview before canonical message metadata is refreshed', () => {
  assert.equal(generatedImagesFromArtifacts([artifact, artifact])[0]?.path, artifact.path)
})

test('generated image drag preserves the selected object identity and rejects a stale gesture', () => {
  const payload = { type: 'generated-image' as const, id: artifact.id, path: artifact.path, name: artifact.label, ext: 'png', size: 0, mimeType: 'image/png' }
  beginGeneratedImageDrag(payload, 'image-object')
  const values = new Map<string, string>()
  const data = { getData: (key: string) => values.get(key) || '', setData: (key: string, value: string) => { values.set(key, value) } }
  writeReadyRefTransfer(data, { kind: 'file', id: 'image-object' }, artifact.label)
  assert.deepEqual(getGeneratedImageDragPayload(data), payload)
  writeReadyRefTransfer(data, { kind: 'file', id: 'different-object' }, '其他图片')
  assert.equal(getGeneratedImageDragPayload(data), null)
  endGeneratedImageDrag()
})

test('/imag command replacement keeps surrounding input and leaves the cursor after the command', () => {
  assert.deepEqual(
    buildSlashCommandInsertion('请 /ima 后续', '请 /ima'.length, 'imag'),
    { nextValue: '请 /imag  后续', cursorPosition: '请 /imag '.length },
  )
  assert.equal(buildSlashCommandInsertion('没有命令', 4, 'imag'), null)
})

test('reference labels only include formats accepted by the generation service', () => {
  assert.equal(isImageGenerationReferencePath('/tmp/reference.PNG'), true)
  assert.equal(isImageGenerationReferencePath('C:\\images\\reference.webp'), true)
  assert.equal(isImageGenerationReferencePath('/tmp/vector.svg'), false)
})

test('composer marks supported image attachments in submission order', () => {
  const html = renderToStaticMarkup(createElement(ChatAttachments, {
    attachments: [
      { id: 'image-1', name: 'one.jpg', path: '/tmp/one.jpg', type: 'image', source: 'user_attachment' },
      { id: 'vector', name: 'vector.svg', path: '/tmp/vector.svg', type: 'image', source: 'user_attachment' },
      { id: 'image-2', name: 'two.webp', path: '/tmp/two.webp', type: 'image', source: 'user_attachment' },
    ],
    onRemove: () => undefined,
    onPreview: () => undefined,
    onRevealDocumentQuote: () => undefined,
    getDocumentQuoteTooltip: () => '',
    getAttachmentMetaSummary: () => null,
    renderAttachmentIcon: () => null,
    toLocalFileUrl: (path: string) => `file://${path}`,
  }))

  assert.match(html, /data-reference-image-order="1"[^>]*>参考图 1</)
  assert.match(html, /data-reference-image-order="2"[^>]*>参考图 2</)
  assert.equal((html.match(/参考图/g) || []).length, 2)
})

test('generated image preview keeps the chat visible and exposes only three icon actions', () => {
  const html = renderToStaticMarkup(createElement(AttachmentPreviewModal, {
    preview: {
      attachment: generatedImageArtifactToAttachment(artifact),
      mode: 'image' as const,
    },
    loading: false,
    onClose: () => undefined,
    onReveal: () => undefined,
    onOpen: () => undefined,
  }))

  assert.match(html, /class="attachment-preview-overlay"/)
  assert.match(html, /class="attachment-preview-panel ready-app-liquid-panel"/)
  assert.equal((html.match(/class="attachment-preview-action"/g) || []).length, 3)
  assert.doesNotMatch(html, />ready-image\.png</)
  assert.doesNotMatch(html, />在 Finder 中显示</)
  assert.doesNotMatch(html, />系统打开</)
})

test('generated image card uses a quiet green dot for the current image', () => {
  const html = renderToStaticMarkup(createElement(GeneratedImageGallery, {
    images: [artifact],
    onPreview: () => undefined,
    onReferenceSelect: () => undefined,
  }))

  assert.match(html, /aria-label="当前图片"/)
  assert.match(html, /background:var\(--color-green\)/)
  assert.doesNotMatch(html, /已激活/)
})

test('generated images can drop into both document editing surfaces', async t => {
  const f = await editorFixture(t, '保留正文')
  const css = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context) } })
  t.after(() => css.deregister())
  const { default: MarkdownEditor } = await import('../renderer/components/document/MarkdownEditor')
  const { MemoryRouter } = await import('react-router-dom')
  const copied: { sourcePath: string; documentPath: string }[] = []
  Object.assign(window, { electronAPI: { imageGeneration: { persistToDocument: async (input: { sourcePath: string; documentPath: string }) => {
    copied.push(input); return { success: true, data: { relativePath: 'note.assets/ready-image.png' } }
  } } } })
  const initial = f.useDocTabs.getState().tabs[0].content
  for (const mode of ['edit', 'preview'] as const) {
    await act(async () => f.useDocTabs.setState({ tabs: [{ id: t.name, path: '/vault/note.md', title: 'note', content: initial, isDirty: false }], activeTabId: t.name }))
    function Surface() { const tab = f.useDocTabs(state => state.tabs[0]); return createElement(MarkdownEditor, { tab, viewMode: mode, previewEditable: true, previewClassName: 'ink-page' }) }
    await act(async () => f.root.render(createElement(MemoryRouter, null, createElement(Surface))))
    const surface = document.querySelector(`.document-${mode === 'edit' ? 'editor' : 'preview'}-surface`); assert.ok(surface)
    beginGeneratedImageDrag({ type: 'generated-image', id: artifact.id, path: artifact.path, name: artifact.label, ext: 'png', size: 0, mimeType: 'image/png' }, artifact.id)
    const values = new Map<string, string>()
    writeReadyRefTransfer({ setData: (key, value) => { values.set(key, value) } }, { kind: 'file', id: artifact.id }, artifact.label)
    const dataTransfer = { types: [...values.keys()], getData: (type: string) => values.get(type) || '', dropEffect: '' }
    for (const type of ['dragover', 'drop']) {
      const event = new f.dom.window.Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      await act(async () => surface.dispatchEvent(event))
      assert.equal(event.defaultPrevented, true)
    }
    assert.equal(dataTransfer.dropEffect, 'copy')
    const tab = f.useDocTabs.getState().tabs[0]
    assert.ok(tab.content.includes('保留正文'))
    assert.ok(tab.content.includes('![ready-image](note.assets/ready-image.png)'))
    assert.equal(tab.isDirty, true)
  }
  assert.deepEqual(copied, Array.from({ length: 2 }, () => ({ sourcePath: artifact.path, documentPath: '/vault/note.md' })))
})
