import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DatabaseConnection } from '../main/modules/database'
import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { executeFileManagementTool } from '../main/modules/tools/file-management-tools'

type Ctor = new(path: string) => DatabaseConnection & MigrationDatabase
const require = createRequire(import.meta.url)

function openDb() {
  const module = require('better-sqlite3') as Ctor & { default?: Ctor }
  const Constructor = module.default || module
  const db = new Constructor(':memory:')
  runMigrations(db)
  return db
}

test('Tag Forge folder batch prepares full text, persists progress, and resumes after a partial apply', async () => {
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-batch-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-batch-state-'))
    await writeFile(join(root, 'a.md'), '# 教程 A\n\nAI 工作流与 Claude。')
    await writeFile(join(root, 'b.md'), '# 教程 B\n\n另一个 AI 工作流。')
    await writeFile(join(root, 'already.md'), '---\ntags: [教程]\n---\n已有标签')
    const context = {
      searchEngine: new SearchEngine(db, { fts5Available: false }),
      workspaceRoots: [root],
      organizeStoreDir: store,
      runId: 'run-batch',
    }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', {
      rootPath: root,
      limit: 1,
    }, context))
    assert.equal(prepared.total, 2)
    assert.equal(prepared.documents.length, 1)
    assert.match(prepared.documents[0].content, /AI 工作流/)
    assert.equal(typeof prepared.documents[0].expectedRevision, 'string')

    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{
        path: prepared.documents[0].path,
        expectedRevision: prepared.documents[0].expectedRevision,
        proposals: [
          { facet: 'form', label: '教程', evidenceCode: 'form', confidence: 0.9 },
          { facet: 'domain', label: 'AI工作流', evidenceCode: 'domain', confidence: 0.9 },
        ],
      }],
    }, context))
    assert.equal(applied.completed, 1)
    assert.equal(applied.remaining, 1)

    const resumed = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', {
      rootPath: root,
      batchId: prepared.batchId,
      limit: 8,
    }, context))
    assert.equal(resumed.completed, 1)
    assert.equal(resumed.documents.length, 1)
    assert.notEqual(resumed.documents[0].path, prepared.documents[0].path)
    assert.match(await readFile(prepared.documents[0].path, 'utf8'), /tags:/)
  } finally {
    db.close()
  }
})

test('Tag Forge batch records a revision conflict without overwriting changed content', async () => {
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-conflict-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-conflict-state-'))
    const path = join(root, 'doc.md')
    await writeFile(path, '# 原文\n\nAI 工作流。')
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    await writeFile(path, '# 用户刚刚修改的内容')
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{ path, expectedRevision: prepared.documents[0].expectedRevision, proposals: [] }],
    }, context))
    assert.equal(applied.results[0].errorKind, 'revision_conflict')
    assert.equal(await readFile(path, 'utf8'), '# 用户刚刚修改的内容')
  } finally {
    db.close()
  }
})
