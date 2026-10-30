import assert from 'node:assert/strict'
import test from 'node:test'
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPageTree } from '../main/modules/document-pages/tree'

test('M3-P1 merges exact filenames, keeps ambiguous pairs, excludes metadata and never writes source', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ready-page-tree-')))
  try {
    for (const dir of ['A', 'A.assets', 'b', '.ready']) mkdirSync(join(root, dir))
    const source = '---\r\ntitle: Display\r\nicon: 🌱\r\ncover: A.assets/c.png\r\n---\r\n# body'
    writeFileSync(join(root, 'A.md'), source)
    writeFileSync(join(root, 'A', 'child.md'), 'child')
    writeFileSync(join(root, 'B.md'), 'B')
    writeFileSync(join(root, 'board.canvas'), '{}')
    writeFileSync(join(root, 'other.txt'), 'other')
    const before = readdirSync(root)
    const tree = readPageTree({ path: root, kind: 'vault' }, path => ({ objectId: path, revision: 1 }), () => [])
    const page = tree.children.find(node => node.name === 'A.md')!
    assert.equal(tree.kind, 'vault')
    assert.equal(page.title, 'Display'); assert.equal(page.icon, '🌱')
    assert.equal(page.children[0].name, 'child.md'); assert.equal(page.hasChildren, true)
    assert.equal(page.assetsPath, join(root, 'A.assets'))
    assert.equal(tree.children.some(node => ['A', 'A.assets', '.ready'].includes(node.name)), false)
    assert.ok(tree.children.find(node => node.name === 'B.md')?.ambiguity)
    assert.ok(tree.children.find(node => node.name === 'b')?.ambiguity)
    assert.equal(tree.children.find(node => node.name === 'board.canvas')?.kind, 'canvas')
    assert.equal(readPageTree({ path: root, kind: 'external' }, path => ({ objectId: path, revision: 1 }), () => []).kind, 'folder')
    assert.equal(readFileSync(join(root, 'A.md'), 'utf8'), source)
    assert.deepEqual(readdirSync(root), before)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// M3-P1 Renderer contract: an absent root is not the filesystem root.
test('Renderer without an opened root issues zero directory reads, including refresh and reveal', async () => {
  const { useWorkspace } = await import('../renderer/stores/useWorkspace')
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let reads = 0
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { document: {
    listFiles: async () => { reads++; return { success: true, items: [] } },
  } } } })
  try {
    useWorkspace.getState().clearWorkspace()
    await useWorkspace.getState().refreshFiles()
    await useWorkspace.getState().loadDirChildren('/')
    await useWorkspace.getState().revealFile('/orphan.md')
    assert.equal(reads, 0)
    assert.equal(useWorkspace.getState().currentPath, '')
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('Renderer consumes the merged Main tree and shows ambiguity with a file-view exit', async () => {
  const React = await import('react')
  const { PageSidebar } = await import('../renderer/modules/document/page-ui/PageSidebar')
  const { mountPageUI, pageAPI } = await import('./utils/page-ui-harness')
  const rootPath = realpathSync(mkdtempSync(join(tmpdir(), 'ready-page-renderer-')))
  mkdirSync(join(rootPath, 'A')); mkdirSync(join(rootPath, 'b'))
  writeFileSync(join(rootPath, 'A.md'), '---\ntitle: 合并页面\n---\n正文')
  writeFileSync(join(rootPath, 'A', 'child.md'), 'child'); writeFileSync(join(rootPath, 'B.md'), 'B')
  const tree = readPageTree({ path: rootPath, kind: 'vault' }, path => ({ objectId: path, revision: 1 }), () => [])
  const fixture = pageAPI(tree), ui = await mountPageUI()
  let fileView = ''
  try {
    await ui.render(React.createElement(PageSidebar, { roots: [{ path: rootPath, kind: 'vault' }], api: fixture.api, onOpen: () => {}, beforeTrash: async () => {}, onShowFiles: node => { fileView = node.path } }))
    assert.equal(ui.body.querySelectorAll(`[data-page-id="${join(rootPath, 'A')}"]`).length, 0)
    await ui.click('展开 合并页面')
    assert.match(ui.body.textContent!, /child/)
    assert.ok(ui.body.querySelector('[role="note"]'))
    await ui.click('在文件视角中查看')
    assert.ok([join(rootPath, 'B.md'), join(rootPath, 'b')].includes(fileView))
  } finally { await ui.close(); rmSync(rootPath, { recursive: true, force: true }) }
  assert.equal(fixture.subscribed, false)
})
