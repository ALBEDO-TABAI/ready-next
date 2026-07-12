import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import type { DatabaseConnection } from '../main/modules/database'
import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import { FileProjectIdentityRepository } from '../main/modules/repositories/file-project-identity-repository'

type SqliteCtor = new (path: string) => DatabaseConnection & MigrationDatabase
const require = createRequire(import.meta.url)

function openDb(): DatabaseConnection & MigrationDatabase {
  const mod = require('better-sqlite3') as SqliteCtor & { default?: SqliteCtor }
  const Sqlite = mod.default || mod
  const db = new Sqlite(':memory:')
  runMigrations(db)
  return db
}

test('migration 068 creates file and project identity tables idempotently', () => {
  const db = openDb()
  try {
    runMigrations(db)
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
        'file_identities', 'file_move_receipts', 'project_identities', 'project_identity_members'
      ) ORDER BY name
    `).all<{ name: string }>().map((row) => row.name)
    assert.deepEqual(tables, [
      'file_identities',
      'file_move_receipts',
      'project_identities',
      'project_identity_members',
    ])
  } finally {
    db.close()
  }
})

test('file identity survives Ready file and directory moves with idempotent receipts', () => {
  const db = openDb()
  try {
    const repository = new FileProjectIdentityRepository(db)
    const first = repository.ensureFile({ workspaceRoot: '/workspace/root', path: '/workspace/root/a/one.md', observedAt: 10 })
    const second = repository.ensureFile({ workspaceRoot: '/workspace/root', path: '/workspace/root/a/two.md', observedAt: 10 })
    const project = repository.resolveOrCreateProject({
      workspaceRoot: '/workspace/root',
      displayName: '可靠项目',
      source: 'directory_consensus',
      confidence: 0.8,
      anchorPath: '/workspace/root/a',
      filePaths: [first.currentPath, second.currentPath],
      observedAt: 10,
    })

    repository.recordInternalMove({
      workspaceRoot: '/workspace/root',
      oldPath: '/workspace/root/a',
      newPath: '/workspace/root/renamed',
      kind: 'directory',
      movedAt: 20,
    })
    repository.recordInternalMove({
      workspaceRoot: '/workspace/root',
      oldPath: '/workspace/root/renamed/one.md',
      newPath: '/workspace/root/renamed/final.md',
      kind: 'file',
      movedAt: 30,
    })
    repository.recordInternalMove({
      workspaceRoot: '/workspace/root',
      oldPath: '/workspace/root/renamed/one.md',
      newPath: '/workspace/root/renamed/final.md',
      kind: 'file',
      movedAt: 31,
    })

    assert.equal(repository.resolveFileByObservedPath('/workspace/root', '/workspace/root/a/one.md')?.fileKey, first.fileKey)
    assert.equal(repository.getFile(first.fileKey)?.currentPath, '/workspace/root/renamed/final.md')
    assert.equal(repository.getFile(second.fileKey)?.currentPath, '/workspace/root/renamed/two.md')
    assert.equal(repository.getProject(project.projectKey)?.anchorPath, '/workspace/root/renamed')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM file_move_receipts').get<{ count: number }>()?.count, 3)
  } finally {
    db.close()
  }
})

test('equal content hashes do not merge external files without an internal move receipt', () => {
  const db = openDb()
  try {
    const repository = new FileProjectIdentityRepository(db)
    const left = repository.ensureFile({
      workspaceRoot: '/workspace/root',
      path: '/workspace/root/a/copy.md',
      contentHash: 'same-content',
    })
    const right = repository.ensureFile({
      workspaceRoot: '/workspace/root',
      path: '/workspace/root/b/copy.md',
      contentHash: 'same-content',
    })
    assert.notEqual(left.fileKey, right.fileKey)
  } finally {
    db.close()
  }
})

test('project rename preserves projectKey and user authority over later automatic refreshes', () => {
  const db = openDb()
  try {
    const repository = new FileProjectIdentityRepository(db)
    const project = repository.resolveOrCreateProject({
      workspaceRoot: '/workspace/root',
      displayName: '自动名称',
      source: 'fallback',
      confidence: 0.5,
      anchorPath: '/workspace/root/work',
      filePaths: ['/workspace/root/work/a.md'],
      observedAt: 10,
    })
    const renamed = repository.renameProject(project.projectKey, '用户命名', 20)
    const refreshed = repository.resolveOrCreateProject({
      workspaceRoot: '/workspace/root',
      displayName: '另一个自动名称',
      source: 'frontmatter',
      confidence: 0.95,
      anchorPath: '/workspace/root/work',
      filePaths: ['/workspace/root/work/a.md'],
      observedAt: 30,
    })

    assert.equal(renamed.projectKey, project.projectKey)
    assert.equal(refreshed.projectKey, project.projectKey)
    assert.equal(refreshed.displayName, '用户命名')
    assert.ok(refreshed.aliases.includes('自动名称'))
  } finally {
    db.close()
  }
})

test('user file assignment moves one stable file identity between projects', () => {
  const db = openDb()
  try {
    const repository = new FileProjectIdentityRepository(db)
    const first = repository.resolveOrCreateProject({
      workspaceRoot: '/workspace/root', displayName: '甲', source: 'fallback', confidence: 0.5,
      anchorPath: '/workspace/root/a', filePaths: ['/workspace/root/a/shared.md'], observedAt: 10,
    })
    const second = repository.resolveOrCreateProject({
      workspaceRoot: '/workspace/root', displayName: '乙', source: 'fallback', confidence: 0.5,
      anchorPath: '/workspace/root/b', filePaths: ['/workspace/root/b/own.md'], observedAt: 10,
    })
    const fileKey = repository.resolveFileByObservedPath('/workspace/root', '/workspace/root/a/shared.md')?.fileKey
    repository.assignPathToProject({
      projectKey: second.projectKey,
      workspaceRoot: '/workspace/root',
      path: '/workspace/root/a/shared.md',
      updatedAt: 20,
    })

    assert.equal(repository.listProjectFiles(first.projectKey).some((file) => file.fileKey === fileKey), false)
    assert.equal(repository.listProjectFiles(second.projectKey).some((file) => file.fileKey === fileKey), true)
    const third = repository.createUserProjectForPath({
      workspaceRoot: '/workspace/root',
      path: '/workspace/root/a/shared.md',
      displayName: '用户新项目',
      updatedAt: 30,
    })
    assert.notEqual(third.projectKey, second.projectKey)
    assert.equal(third.source, 'user')
    assert.equal(repository.listProjectFiles(third.projectKey)[0]?.fileKey, fileKey)
  } finally {
    db.close()
  }
})
