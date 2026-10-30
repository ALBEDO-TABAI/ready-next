import assert from 'node:assert/strict'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { DocumentMarksRepository } from '../main/modules/document-engine/document-marks-repository'
import { fixture } from './utils/ready-object-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('document marks follow a moved markdown file when the old path is gone', (t) => {
  if (skipIfSqliteUnavailable(t, 'Document marks identity')) return
  const f = fixture()
  t.after(() => f.close())
  const oldPath = join(f.root, '原书名.md')
  const newPath = join(f.root, '新目录', '新书名.md')
  writeFileSync(oldPath, '# 正文\n')
  mkdirSync(dirname(newPath))
  const repo = new DocumentMarksRepository(f.db)
  const note = repo.create({ kind: 'note', documentPath: oldPath, groupName: '感慨', noteText: '保留笔记' })
  const objectId = f.registry.find(oldPath)!.id

  renameSync(oldPath, newPath)
  f.registry.reconcile([oldPath, newPath])

  assert.equal(existsSync(oldPath), false)
  assert.equal(f.registry.find(newPath)!.id, objectId)
  assert.deepEqual(repo.list(newPath), [{ ...note, documentPath: newPath }])
  assert.deepEqual(repo.list(oldPath), [])
})

test('document marks do not merge two existing copies with the same folder and file name', (t) => {
  if (skipIfSqliteUnavailable(t, 'Document marks identity')) return
  const f = fixture()
  t.after(() => f.close())
  const oldPath = join(f.root, '遥远的向日葵地', '遥远的向日葵地.md')
  const newPath = join(f.root, '多看书', '遥远的向日葵地', '遥远的向日葵地.md')
  for (const path of [oldPath, newPath]) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '# 相同正文\n')
  }
  const repo = new DocumentMarksRepository(f.db)
  const oldNote = repo.create({ kind: 'note', documentPath: oldPath, groupName: '感慨', noteText: '旧副本' })
  const newNote = repo.create({ kind: 'note', documentPath: newPath, groupName: '默认', noteText: '新副本' })

  assert.notEqual(f.registry.find(oldPath)!.id, f.registry.find(newPath)!.id)
  assert.deepEqual(repo.list(oldPath), [oldNote])
  assert.deepEqual(repo.list(newPath), [newNote])
})
