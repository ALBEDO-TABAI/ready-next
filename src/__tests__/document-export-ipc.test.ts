import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import JSZip from 'jszip'

import {
  exportGroup,
  _exportGroupHandledChannelsForTest,
  type ExportGroupDeps,
} from '../main/modules/document-engine/ipc/export-group'
import type { DocumentExportResult } from '../shared/document-export'

type HandlerFn = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function createMockIpc() {
  const handlers = new Map<string, HandlerFn>()
  const removeHandlerCalls: string[] = []
  const ipc = {
    handle(channel: string, handler: HandlerFn) {
      handlers.set(channel, handler)
    },
    removeHandler(channel: string) {
      removeHandlerCalls.push(channel)
      handlers.delete(channel)
    },
  } as unknown as IpcMain
  return { ipc, handlers, removeHandlerCalls }
}

function makeDeps(overrides: Partial<ExportGroupDeps> = {}): ExportGroupDeps & {
  dialogRequests: Array<{ title: string; defaultPath: string }>
  renderedHtml: string[]
} {
  const dialogRequests: Array<{ title: string; defaultPath: string }> = []
  const renderedHtml: string[] = []
  return {
    dialogRequests,
    renderedHtml,
    showExportSaveDialog: async (request) => {
      dialogRequests.push({ title: request.title, defaultPath: request.defaultPath })
      return { canceled: true }
    },
    renderHtmlToPdf: async (html) => {
      renderedHtml.push(html)
      return Buffer.from(`PDF:${html.length}`)
    },
    getFallbackExportDir: () => '/fallback-home',
    ...overrides,
  }
}

function invoke(handlers: Map<string, HandlerFn>, channel: string, payload: unknown): Promise<DocumentExportResult> {
  const handler = handlers.get(channel)
  assert.ok(handler, `handler registered for ${channel}`)
  return handler({} as IpcMainInvokeEvent, payload) as Promise<DocumentExportResult>
}

test('exportGroup registers both channels and dispose removes them', () => {
  const { ipc, handlers, removeHandlerCalls } = createMockIpc()
  const handle = exportGroup.register(ipc, makeDeps())

  assert.deepEqual(
    [...handlers.keys()].sort(),
    [..._exportGroupHandledChannelsForTest].sort(),
  )

  handle.dispose()
  assert.equal(handlers.size, 0)
  for (const channel of _exportGroupHandledChannelsForTest) {
    assert.ok(removeHandlerCalls.includes(channel), `dispose removed ${channel}`)
  }
})

test('exportPdf cancel path stays side-effect free', async () => {
  const { ipc, handlers } = createMockIpc()
  const deps = makeDeps()
  exportGroup.register(ipc, deps)

  const result = await invoke(handlers, 'document:exportPdf', {
    html: '<html><body>hi</body></html>',
    suggestedName: '我的文档',
    sourcePath: '/docs/我的文档.md',
  })

  assert.deepEqual(result, { success: false, canceled: true })
  assert.equal(deps.renderedHtml.length, 0, 'canceled dialog must not render a PDF')
  assert.equal(deps.dialogRequests[0].title, '导出为 PDF')
  assert.ok(deps.dialogRequests[0].defaultPath.endsWith('/docs/我的文档.pdf'))
})

test('exportPdf writes the rendered buffer to the chosen path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-export-pdf-'))
  try {
    const target = join(root, 'out.pdf')
    const { ipc, handlers } = createMockIpc()
    const deps = makeDeps({
      showExportSaveDialog: async () => ({ canceled: false, filePath: target }),
    })
    exportGroup.register(ipc, deps)

    const result = await invoke(handlers, 'document:exportPdf', {
      html: '<html><body>正文</body></html>',
      suggestedName: 'doc',
      sourcePath: null,
    })

    assert.equal(result.success, true)
    assert.equal((result as { path?: string }).path, target)
    assert.equal(readFileSync(target, 'utf-8'), `PDF:${'<html><body>正文</body></html>'.length}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exportPdf rejects empty and oversized html without opening the dialog', async () => {
  const { ipc, handlers } = createMockIpc()
  const deps = makeDeps()
  exportGroup.register(ipc, deps)

  const empty = await invoke(handlers, 'document:exportPdf', { html: '   ' })
  assert.deepEqual(empty, { success: false, error: 'empty_export_html' })

  const oversized = await invoke(handlers, 'document:exportPdf', {
    html: 'x'.repeat(33 * 1024 * 1024),
  })
  assert.deepEqual(oversized, { success: false, error: 'export_html_too_large' })
  assert.equal(deps.dialogRequests.length, 0)
})

test('exportMarkdownBundle zips rewritten markdown with its assets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-export-bundle-'))
  try {
    const docDir = join(root, 'notes')
    mkdirSync(join(docDir, 'images'), { recursive: true })
    writeFileSync(join(docDir, 'images', 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const sourcePath = join(docDir, '旅行笔记.md')
    const content = [
      '# 旅行',
      '![照片](./images/shot.png)',
      '![缺失](./images/gone.png)',
      '![远端](https://example.com/r.png)',
    ].join('\n')
    writeFileSync(sourcePath, content, 'utf-8')

    const target = join(root, 'bundle.zip')
    const { ipc, handlers } = createMockIpc()
    const deps = makeDeps({
      showExportSaveDialog: async (request) => {
        assert.equal(request.title, '导出 Markdown 压缩包')
        return { canceled: false, filePath: target }
      },
    })
    exportGroup.register(ipc, deps)

    const result = await invoke(handlers, 'document:exportMarkdownBundle', {
      content,
      sourcePath,
      suggestedName: '旅行笔记',
    })

    assert.equal(result.success, true)
    const success = result as Extract<DocumentExportResult, { success: true }>
    assert.equal(success.assetCount, 1)
    assert.equal(success.missingAssetCount, 1)
    assert.ok(existsSync(target))

    const zip = await JSZip.loadAsync(readFileSync(target))
    const markdownEntry = zip.file('旅行笔记/旅行笔记.md')
    assert.ok(markdownEntry, 'zip contains <name>/<name>.md')
    const markdown = await markdownEntry.async('string')
    assert.ok(markdown.includes('![照片](assets/shot.png)'), '打包引用被改写为 assets/ 相对路径')
    assert.ok(markdown.includes('![缺失](./images/gone.png)'), '缺失文件引用保持原样')
    assert.ok(markdown.includes('https://example.com/r.png'), '远端引用不动')

    const assetEntry = zip.file('旅行笔记/assets/shot.png')
    assert.ok(assetEntry, 'zip contains the packed asset')
    const assetBytes = await assetEntry.async('nodebuffer')
    assert.deepEqual([...assetBytes], [0x89, 0x50, 0x4e, 0x47])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exportMarkdownBundle for an untitled draft still produces a markdown-only zip', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-export-draft-'))
  try {
    const target = join(root, 'draft.zip')
    const { ipc, handlers } = createMockIpc()
    const deps = makeDeps({
      showExportSaveDialog: async (request) => {
        assert.ok(request.defaultPath.startsWith('/fallback-home'), '未命名草稿回退到 fallback 目录')
        return { canceled: false, filePath: target }
      },
    })
    exportGroup.register(ipc, deps)

    const result = await invoke(handlers, 'document:exportMarkdownBundle', {
      content: '# 草稿\n![相对](./x.png)',
      sourcePath: null,
      suggestedName: '新文档',
    })

    assert.equal(result.success, true)
    const success = result as Extract<DocumentExportResult, { success: true }>
    assert.equal(success.assetCount, 0)
    assert.equal(success.missingAssetCount, 1)

    const zip = await JSZip.loadAsync(readFileSync(target))
    const markdownEntry = zip.file('新文档/新文档.md')
    assert.ok(markdownEntry)
    assert.ok((await markdownEntry.async('string')).includes('![相对](./x.png)'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
