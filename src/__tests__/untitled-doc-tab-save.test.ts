import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildUntitledDocFileName,
  pickAvailableUntitledDocFileName,
  sanitizeUntitledDocTitle,
  saveUntitledDocTabToDirectory,
} from '../renderer/modules/document/untitledDocSave'
import { parseUntitledDocTabDragPayload } from '../renderer/components/layout/fileTreeExternalDrop'
import { useDocTabs } from '../renderer/stores/useDocTabs'

/**
 * 行为合同：标签栏新建的未保存文档（path=null）拖到目录后落盘——
 * 文件名由标题派生并自动避让重名；createFile 先占名防止覆盖；
 * 已保存的标签不走这条路径。
 */

type FakeFs = {
  existing: Set<string>
  created: string[]
  written: Array<{ path: string; content: string }>
  failCreate?: boolean
}

function installFakeDocumentApi(fs: FakeFs): () => void {
  const previous = (globalThis as { window?: unknown }).window
  const electronAPI = {
    document: {
      stat: async (path: string) => (fs.existing.has(path) ? { success: true } : { success: false }),
      createFile: async (path: string) => {
        if (fs.failCreate) return { success: false, error: '磁盘拒绝' }
        if (fs.existing.has(path)) return { success: false, error: '已存在' }
        fs.existing.add(path)
        fs.created.push(path)
        return { success: true }
      },
      writeFile: async (path: string, content: string) => {
        fs.written.push({ path, content })
        return { success: true }
      },
    },
  }
  Object.defineProperty(globalThis, 'window', {
    value: { electronAPI },
    configurable: true,
    writable: true,
  })
  return () => {
    Object.defineProperty(globalThis, 'window', {
      value: previous,
      configurable: true,
      writable: true,
    })
  }
}

function resetDocTabs(): void {
  useDocTabs.setState({
    tabs: [{ id: 'doc-t1', path: null, title: '新文档', content: '', isDirty: false }],
    tabGroups: [],
    activeTabId: 'doc-t1',
    splitTabId: null,
  })
}

describe('untitled doc filename derivation', () => {
  it('sanitizes illegal filename characters and empty titles', () => {
    assert.equal(sanitizeUntitledDocTitle('新文档'), '新文档')
    assert.equal(sanitizeUntitledDocTitle('a/b:c*d?e'), 'a b c d e')
    assert.equal(sanitizeUntitledDocTitle('...'), '新文档')
    assert.equal(sanitizeUntitledDocTitle('  周报 - 07  '), '周报 - 07')
  })

  it('builds ordinal filenames', () => {
    assert.equal(buildUntitledDocFileName('新文档', 1), '新文档.md')
    assert.equal(buildUntitledDocFileName('新文档', 3), '新文档 3.md')
  })

  it('picks the first available candidate', async () => {
    const taken = new Set(['新文档.md', '新文档 2.md'])
    const picked = await pickAvailableUntitledDocFileName('新文档', async (name) => taken.has(name))
    assert.equal(picked, '新文档 3.md')
  })
})

describe('saveUntitledDocTabToDirectory', () => {
  let restore: (() => void) | null = null
  let fs: FakeFs

  beforeEach(() => {
    fs = { existing: new Set(), created: [], written: [] }
    restore = installFakeDocumentApi(fs)
    resetDocTabs()
  })

  afterEach(() => {
    restore?.()
    restore = null
  })

  it('saves an untitled tab into the target directory and flips the tab to saved', async () => {
    useDocTabs.getState().updateTabContent('doc-t1', '# 草稿内容\n')
    const result = await saveUntitledDocTabToDirectory('doc-t1', '/ws/笔记')
    assert.ok(result.success)
    assert.equal(result.path, '/ws/笔记/新文档.md')
    assert.deepEqual(fs.created, ['/ws/笔记/新文档.md'])
    assert.deepEqual(fs.written, [{ path: '/ws/笔记/新文档.md', content: '# 草稿内容\n' }])
    const tab = useDocTabs.getState().tabs.find((item) => item.id === 'doc-t1')
    assert.equal(tab?.path, '/ws/笔记/新文档.md')
    assert.equal(tab?.title, '新文档.md')
    assert.equal(tab?.isDirty, false)
  })

  it('avoids name collisions with an ordinal suffix', async () => {
    fs.existing.add('/ws/笔记/新文档.md')
    const result = await saveUntitledDocTabToDirectory('doc-t1', '/ws/笔记')
    assert.ok(result.success)
    assert.equal(result.fileName, '新文档 2.md')
  })

  it('refuses tabs that already have a path', async () => {
    useDocTabs.getState().setTabPath('doc-t1', '/ws/已保存.md')
    const result = await saveUntitledDocTabToDirectory('doc-t1', '/ws/笔记')
    assert.equal(result.success, false)
    if (!result.success) assert.equal(result.reason, 'not-untitled')
    assert.equal(fs.created.length, 0)
  })

  it('surfaces create failures without touching the tab', async () => {
    fs.failCreate = true
    const result = await saveUntitledDocTabToDirectory('doc-t1', '/ws/笔记')
    assert.equal(result.success, false)
    if (!result.success) assert.equal(result.reason, 'write-failed')
    const tab = useDocTabs.getState().tabs.find((item) => item.id === 'doc-t1')
    assert.equal(tab?.path, null)
  })
})

describe('untitled doc tab drag payload', () => {
  it('parses only well-formed payloads', () => {
    const good = JSON.stringify({ type: 'untitled-doc-tab', tabId: 'doc-9', title: '新文档' })
    assert.deepEqual(parseUntitledDocTabDragPayload(good), { type: 'untitled-doc-tab', tabId: 'doc-9', title: '新文档' })
    assert.equal(parseUntitledDocTabDragPayload(JSON.stringify({ type: 'doc-tab', tabId: 'doc-9' })), null)
    assert.equal(parseUntitledDocTabDragPayload('not json'), null)
    assert.equal(parseUntitledDocTabDragPayload(''), null)
  })
})
