import type { DatabaseConnection } from '../main/modules/database/connection'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'


import { FileEmergenceService } from '../main/modules/file-emergence/service'
import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import { FileActivityRepository } from '../main/modules/repositories/file-activity-repository'
import { FileReadingSessionRepository } from '../main/modules/repositories/file-reading-session-repository'
import { FileProjectIdentityRepository } from '../main/modules/repositories/file-project-identity-repository'
import { TagForgeRepository } from '../main/modules/repositories/tag-forge-repository'
import { createDocumentMetadataPort } from '../main/modules/file-emergence/document-metadata-port'

type SqliteCtor = new (path: string) => DatabaseConnection & MigrationDatabase
const require = createRequire(import.meta.url)
const now = new Date('2026-07-12T10:00:00+08:00').getTime()

function openDb(): DatabaseConnection & MigrationDatabase {
  const mod = require('better-sqlite3') as SqliteCtor & { default?: SqliteCtor }
  const Sqlite = mod.default || mod
  const db = new Sqlite(':memory:')
  runMigrations(db)
  return db
}

test('native repositories carry one open fact and real reading progress into a snapshot', async (t) => {
  if (skipIfSqliteUnavailable(t, 'file-emergence-native-integration')) return
  const db = openDb()
  try {
    const activity = new FileActivityRepository(db)
    const readingSessions = new FileReadingSessionRepository(db)
    const identities = new FileProjectIdentityRepository(db)
    const firstOpen = activity.recordEvent({
      path: '/workspace/books/白痴.epub',
      workspaceRoot: '/workspace',
      eventType: 'open',
      source: 'file_tree',
      createdAt: now - 60_000,
    })
    const secondOpen = activity.recordEvent({
      path: '/workspace/books/白痴.epub',
      workspaceRoot: '/workspace',
      eventType: 'open',
      source: 'document_mode',
      createdAt: now - 59_000,
    })
    readingSessions.recordSession({
      path: '/workspace/books/白痴.epub',
      workspaceRoot: '/workspace',
      source: 'document_mode',
      startedAt: now - 45 * 60_000,
      endedAt: now - 1_000,
      activeMs: 35 * 60_000,
      progressStart: 0.2,
      progressEnd: 0.48,
      progressKind: 'ebook',
    })

    assert.equal(firstOpen.id, secondOpen.id)
    const storedSessions = readingSessions.listRecent({ workspaceRoots: ['/workspace'], since: 0, limit: 10 })
    assert.equal(storedSessions[0]?.progressKind, 'ebook')
    assert.equal(storedSessions[0]?.progressEnd, 0.48)

    const service = new FileEmergenceService({
      settings: { getSetting: () => undefined },
      activity,
      readingSessions,
      calendar: {
        getEvents: () => [],
        getRecurringEventsAndOverrides: () => ({ events: [], overridesByParent: new Map() }),
      },
      browser: { getHistory: () => [] },
      chat: { listRecentConversations: () => [], getMessages: () => [] },
      search: null,
      identity: {
        resolveCurrentFile: (workspaceRoot, observedPath) => {
          const file = identities.resolveFileByObservedPath(workspaceRoot, observedPath)
          return file ? { fileKey: file.fileKey, currentPath: file.currentPath } : null
        },
        resolveProject: (input) => {
          const project = identities.resolveOrCreateProject(input)
          return {
            projectKey: project.projectKey,
            displayName: project.displayName,
            source: project.source,
            confidence: project.confidence,
            files: identities.listProjectFiles(project.projectKey).map((file) => ({ fileKey: file.fileKey, currentPath: file.currentPath })),
          }
        },
      },
      now: () => now,
    })
    const snapshot = await service.getSnapshot({ workspaceRoots: ['/workspace'] })

    assert.equal(snapshot.buckets.today[0]?.title, '白痴')
    assert.equal(snapshot.diagnostics?.sourceCounts.reading_session, 1)
    assert.equal(snapshot.diagnostics?.sourceCounts.file_activity, 1)
    const projectKey = snapshot.buckets.today[0]?.projectKey
    assert.ok(projectKey)
    assert.ok(snapshot.buckets.today[0]?.files[0]?.fileKey)

    identities.renameProject(projectKey, '用户书单')
    const renamed = await service.getSnapshot({ workspaceRoots: ['/workspace'], forceRefresh: true })
    assert.equal(renamed.buckets.today[0]?.projectKey, projectKey)
    assert.equal(renamed.buckets.today[0]?.title, '用户书单')

    identities.recordInternalMove({
      workspaceRoot: '/workspace',
      oldPath: '/workspace/books/白痴.epub',
      newPath: '/workspace/archive/白痴.epub',
      kind: 'file',
      movedAt: now + 1,
    })
    const moved = await service.getSnapshot({ workspaceRoots: ['/workspace'], forceRefresh: true })
    assert.equal(moved.buckets.today[0]?.projectKey, projectKey)
    assert.equal(moved.buckets.today[0]?.files[0]?.path, '/workspace/archive/白痴.epub')
  } finally {
    db.close()
  }
})

test('native metadata port reads controlled assignments and never promotes raw CSS body tags',(t)=>{
  if(skipIfSqliteUnavailable(t,'file-emergence-native-integration'))return
  const db=openDb()
  try{
    db.prepare(`INSERT INTO workspaces(root) VALUES(?)`).run('/workspace')
    const workspaceId=db.prepare(`SELECT id FROM workspaces WHERE root=?`).get<{id:number}>('/workspace')!.id
    db.prepare(`INSERT INTO documents(workspace_id,path,name,frontmatter_json,indexed_at) VALUES(?,?,?,?,?)`).run(workspaceId,'/workspace/theme.md','theme.md',JSON.stringify({title:'主题'}),now)
    const documentId=db.prepare(`SELECT id FROM documents WHERE path=?`).get<{id:number}>('/workspace/theme.md')!.id
    db.prepare(`INSERT INTO tags(doc_id,tag) VALUES(?,?)`).run(documentId,'fff')
    const file=new FileProjectIdentityRepository(db).ensureFile({workspaceRoot:'/workspace',path:'/workspace/theme.md'})
    const tags=new TagForgeRepository(db)
    tags.replaceAutomaticAssignments(file.fileKey,[{tagId:'domain-design',facet:'domain',label:'设计系统',confidence:.9,evidenceCode:'topic',resolution:'exact'}],'tag_forge_auto','v1')
    const beforeReadback=createDocumentMetadataPort(db).getTitleMetadata(['/workspace/theme.md'],['/workspace']).get('/workspace/theme.md')
    assert.deepEqual(beforeReadback?.controlledTags,[],'unverified assignments must not influence emergence')
    tags.markReadback(file.fileKey)
    const metadata=createDocumentMetadataPort(db).getTitleMetadata(['/workspace/theme.md'],['/workspace']).get('/workspace/theme.md')
    assert.deepEqual(metadata?.controlledTags?.map((tag)=>tag.label),['设计系统'])
    assert.equal(metadata?.controlledTags?.some((tag)=>tag.label==='fff'),false)
  }finally{db.close()}
})
