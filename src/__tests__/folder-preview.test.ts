import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { FolderPreview } from '../renderer/components/layout/FolderPreview'
import {
  describeFolderPreview,
  selectFolderPreviewItems,
} from '../renderer/components/layout/folderPreviewModel'

interface PreviewTestItem {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modified: Date
}

function makeItem(name: string, isDirectory = false): PreviewTestItem {
  return {
    name,
    path: `/workspace/${name}`,
    isDirectory,
    size: isDirectory ? 0 : 1024,
    modified: new Date('2026-03-26T10:57:06.000Z'),
  }
}

test('selectFolderPreviewItems prioritizes richer content and ignores hidden or unsupported entries', () => {
  const previewItems = selectFolderPreviewItems([
    makeItem('.DS_Store'),
    makeItem('notes.md'),
    makeItem('cover.png'),
    makeItem('shots.mp4'),
    makeItem('archive.psd'),
    makeItem('references', true),
  ])

  assert.deepStrictEqual(
    previewItems.map((item) => item.name),
    ['cover.png', 'shots.mp4', 'notes.md', 'references'],
  )
})

test('describeFolderPreview shows empty state and counts only visible entries', () => {
  assert.strictEqual(describeFolderPreview([]), '空文件夹')
  assert.strictEqual(
    describeFolderPreview([
      makeItem('cover.png'),
      makeItem('.DS_Store'),
      makeItem('archive.psd'),
      makeItem('notes.md'),
    ]),
    '2 项内容',
  )
})

test('FolderPreview renders a collage layout with image and file tiles', () => {
  const html = renderToStaticMarkup(
    React.createElement(FolderPreview, {
      childrenItems: [
        makeItem('cover.png'),
        makeItem('notes.md'),
        makeItem('references', true),
      ],
      previewHeight: 88,
    }),
  )

  assert.match(html, /data-folder-preview="true"/)
  assert.match(html, /cover\.png/)
  assert.match(html, /data-folder-preview-tile-kind="document"/)
  assert.match(html, /data-folder-preview-tile-kind="folder"/)
})

test('FolderPreview switches to compact label tiles when there are no images', () => {
  const html = renderToStaticMarkup(
    React.createElement(FolderPreview, {
      childrenItems: [
        makeItem('templates', true),
        makeItem('chat.md'),
        makeItem('notes.md'),
      ],
      previewHeight: 88,
    }),
  )

  assert.match(html, /data-folder-preview-compact="true"/)
  assert.doesNotMatch(html, /<svg/)
  assert.match(html, /templates/)
  assert.match(html, /chat/)
  assert.match(html, /notes/)
  assert.match(html, /padding:6px/)
  assert.match(html, /justify-center/)
  assert.match(html, /text-center/)
  assert.doesNotMatch(html, /class="[^"]*border[^"]*"/)
})
