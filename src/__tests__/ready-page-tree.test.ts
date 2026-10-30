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
