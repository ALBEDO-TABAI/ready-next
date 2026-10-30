import { newRepositoryFixture, prepareObjectFixtures, registeredFixtureFile, moveFixture } from './utils/object-repository-fixtures'
let fixtureRoot = ''
import type { DatabaseConnection } from '../main/modules/database/connection'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'


import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import { FileProjectIdentityRepository } from '../main/modules/repositories/file-project-identity-repository'

type SqliteCtor = new (path: string) => DatabaseConnection & MigrationDatabase
const require = createRequire(import.meta.url)

function openDb(): DatabaseConnection & MigrationDatabase {
  const mod = require('better-sqlite3') as SqliteCtor & { default?: SqliteCtor }
  const Sqlite = mod.default || mod
  const db = new Sqlite(':memory:')
  runMigrations(db)
  fixtureRoot=newRepositoryFixture();prepareObjectFixtures(db,[`${fixtureRoot}/workspace/root`],[`${fixtureRoot}/workspace/root/work/a.md`,`${fixtureRoot}/workspace/root/b/copy.md`,`${fixtureRoot}/workspace/root/a/copy.md`,`${fixtureRoot}/workspace/root/a/two.md`,`${fixtureRoot}/workspace/root/a/one.md`,`${fixtureRoot}/workspace/root/b/own.md`,`${fixtureRoot}/workspace/root/a/shared.md`]);
  return db
}

test('migration 068 creates file and project identity tables idempotently', async (t) => {
  if (skipIfSqliteUnavailable(t, 'file-project-identity-repository')) return
  const db = openDb()
  try {
    runMigrations(db)
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
        'objects', 'file_move_receipts', 'project_identities', 'project_identity_members'
      ) ORDER BY name
    `).all<{ name: string }>().map((row) => row.name)
    assert.deepEqual(tables, [
      'file_move_receipts',
      'objects',
      'project_identities',
      'project_identity_members',
    ])
  } finally {
    db.close()
  }
})

test('file identity survives Ready file and directory moves with idempotent receipts', async (t) => {
  if (skipIfSqliteUnavailable(t, 'file-project-identity-repository')) return
  const db = openDb()
  try {
    const repository = new FileProjectIdentityRepository(db)
    const first = registeredFixtureFile(db,{ workspaceRoot: `${fixtureRoot}/workspace/root`, path: `${fixtureRoot}/workspace/root/a/one.md`, observedAt: 10 })
    const second = registeredFixtureFile(db,{ workspaceRoot: `${fixtureRoot}/workspace/root`, path: `${fixtureRoot}/workspace/root/a/two.md`, observedAt: 10 })
    const project = repository.resolveOrCreateProject({
      workspaceRoot: `${fixtureRoot}/workspace/root`,
      displayName: '可靠项目',
      source: 'directory_consensus',
      confidence: 0.8,
      anchorPath: `${fixtureRoot}/workspace/root/a`,
      filePaths: [first.currentPath, second.currentPath],
      observedAt: 10,
    })

    await moveFixture(db,{
      workspaceRoot: `${fixtureRoot}/workspace/root`,
      oldPath: `${fixtureRoot}/workspace/root/a`,
      newPath: `${fixtureRoot}/workspace/root/renamed`,
      kind: 'directory',
      movedAt: 20,
    })
    await moveFixture(db,{
      workspaceRoot: `${fixtureRoot}/workspace/root`,
      oldPath: `${fixtureRoot}/workspace/root/renamed/one.md`,
      newPath: `${fixtureRoot}/workspace/root/renamed/final.md`,
      kind: 'file',
      movedAt: 30,
    })


    assert.equal(repository.findFileByCurrentPath(`${fixtureRoot}/workspace/root`, `${fixtureRoot}/workspace/root/a/one.md`), null)
    assert.equal(repository.getFile(first.fileKey)?.currentPath, `${fixtureRoot}/workspace/root/renamed/final.md`)
    assert.equal(repository.getFile(second.fileKey)?.currentPath, `${fixtureRoot}/workspace/root/renamed/two.md`)
    assert.equal(repository.getProject(project.projectKey)?.anchorPath, `${fixtureRoot}/workspace/root/renamed`)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM file_move_receipts').get<{ count: number }>()?.count, 6)
  } finally {
    db.close()
  }
})

test('equal content hashes do not merge external files without an internal move receipt', async (t) => {
  if (skipIfSqliteUnavailable(t, 'file-project-identity-repository')) return
  const db = openDb()
  try {
    const left = registeredFixtureFile(db,{
      workspaceRoot: `${fixtureRoot}/workspace/root`,
      path: `${fixtureRoot}/workspace/root/a/copy.md`,
      contentHash: 'same-content',
    })
    const right = registeredFixtureFile(db,{
      workspaceRoot: `${fixtureRoot}/workspace/root`,
      path: `${fixtureRoot}/workspace/root/b/copy.md`,
      contentHash: 'same-content',
    })
    assert.notEqual(left.fileKey, right.fileKey)
  } finally {
    db.close()
  }
})

test('project rename preserves projectKey and user authority over later automatic refreshes', async (t) => {
  if (skipIfSqliteUnavailable(t, 'file-project-identity-repository')) return
  const db = openDb()
  try {
    const repository = new FileProjectIdentityRepository(db)
    const project = repository.resolveOrCreateProject({
      workspaceRoot: `${fixtureRoot}/workspace/root`,
      displayName: '自动名称',
      source: 'fallback',
      confidence: 0.5,
      anchorPath: `${fixtureRoot}/workspace/root/work`,
      filePaths: [`${fixtureRoot}/workspace/root/work/a.md`],
      observedAt: 10,
    })
    const renamed = repository.renameProject(project.projectKey, '用户命名', 20)
    const refreshed = repository.resolveOrCreateProject({
      workspaceRoot: `${fixtureRoot}/workspace/root`,
      displayName: '另一个自动名称',
      source: 'frontmatter',
      confidence: 0.95,
      anchorPath: `${fixtureRoot}/workspace/root/work`,
      filePaths: [`${fixtureRoot}/workspace/root/work/a.md`],
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

test('user file assignment moves one stable file identity between projects', async (t) => {
  if (skipIfSqliteUnavailable(t, 'file-project-identity-repository')) return
  const db = openDb()
  try {
    const repository = new FileProjectIdentityRepository(db)
    const first = repository.resolveOrCreateProject({
      workspaceRoot: `${fixtureRoot}/workspace/root`, displayName: '甲', source: 'fallback', confidence: 0.5,
      anchorPath: `${fixtureRoot}/workspace/root/a`, filePaths: [`${fixtureRoot}/workspace/root/a/shared.md`], observedAt: 10,
    })
    const second = repository.resolveOrCreateProject({
      workspaceRoot: `${fixtureRoot}/workspace/root`, displayName: '乙', source: 'fallback', confidence: 0.5,
      anchorPath: `${fixtureRoot}/workspace/root/b`, filePaths: [`${fixtureRoot}/workspace/root/b/own.md`], observedAt: 10,
    })
    const fileKey = repository.findFileByCurrentPath(`${fixtureRoot}/workspace/root`, `${fixtureRoot}/workspace/root/a/shared.md`)?.fileKey
    repository.assignPathToProject({
      projectKey: second.projectKey,
      workspaceRoot: `${fixtureRoot}/workspace/root`,
      path: `${fixtureRoot}/workspace/root/a/shared.md`,
      updatedAt: 20,
    })

    assert.equal(repository.listProjectFiles(first.projectKey).some((file) => file.fileKey === fileKey), false)
    assert.equal(repository.listProjectFiles(second.projectKey).some((file) => file.fileKey === fileKey), true)
    const third = repository.createUserProjectForPath({
      workspaceRoot: `${fixtureRoot}/workspace/root`,
      path: `${fixtureRoot}/workspace/root/a/shared.md`,
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
