import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import ChatAttachments from '../renderer/components/agent/ChatAttachments'
import { AttachmentPreviewModal } from '../renderer/components/agent/chat-panel/attachments-preview'
import { buildSlashCommandInsertion } from '../renderer/modules/agent/slash-skill-selection'
import type { AgentMessage } from '../renderer/modules/agent/types'
import {
  generatedImageArtifactToAttachment,
  generatedImagesFromMessage,
} from '../renderer/modules/image-generation/generatedImageArtifacts'
import {
  parseGeneratedImageDragPayload,
} from '../renderer/modules/image-generation/generatedImageDrag'
import { isImageGenerationReferencePath } from '../shared/image-generation'

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

test('generated image drag payload requires a local absolute path and preserves image identity', () => {
  const raw = JSON.stringify({
    type: 'generated-image',
    id: artifact.id,
    path: artifact.path,
    name: artifact.label,
    ext: 'png',
    size: 0,
    mimeType: 'image/png',
  })
  assert.deepEqual(parseGeneratedImageDragPayload(raw), {
    type: 'generated-image',
    id: artifact.id,
    path: artifact.path,
    name: artifact.label,
    ext: 'png',
    size: 0,
    mimeType: 'image/png',
  })
  assert.equal(parseGeneratedImageDragPayload(raw.replace(artifact.path, 'relative/image.png')), null)
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

test('generated images can drop into both document editing surfaces', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed UI wiring contract; real Electron live proof covers preview-mode asset copy and rendered insertion.
  const source = readFileSync(resolve(process.cwd(), 'src/renderer/components/document/MarkdownEditor.tsx'), 'utf8')
  const editSurface = source.slice(
    source.indexOf('className="panel-hover-scrollbar document-editor-surface'),
    source.indexOf('{/* ── Preview pane'),
  )
  const previewSurface = source.slice(
    source.indexOf('className="panel-hover-scrollbar document-preview-surface'),
    source.indexOf('<WidgetEditDrawer'),
  )
  for (const surface of [editSurface, previewSurface]) {
    assert.match(surface, /onDragOver=\{handleEditorDragOver\}/)
    assert.match(surface, /onDrop=\{handleEditorDrop\}/)
  }
})
