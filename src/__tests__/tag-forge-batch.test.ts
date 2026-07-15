import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

import type { DatabaseConnection } from '../main/modules/database'
import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import { TagForgeRepository } from '../main/modules/repositories/tag-forge-repository'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import {
  buildRequestEnvelope,
  trustedFolderReferencesFromMessageMeta,
} from '../main/modules/agent-control/contracts/request-envelope'
import {
  executeFileManagementTool,
  resolveFileToolWorkspaceRoots,
} from '../main/modules/tools/file-management-tools'

type Ctor = new(path: string) => DatabaseConnection & MigrationDatabase
const require = createRequire(import.meta.url)

function openDb() {
  const module = require('better-sqlite3') as Ctor & { default?: Ctor }
  const Constructor = module.default || module
  const db = new Constructor(':memory:')
  runMigrations(db)
  return db
}

function proposal(facet: 'form' | 'domain' | 'entity' | 'use', label: string, evidenceExcerpt: string, confidence = 0.9) {
  return { facet, label, evidenceCode: `${facet}_evidence`, evidenceExcerpt, confidence }
}

function insertSubmittedReviewCard(
  db: DatabaseConnection,
  waiting: Record<string, any>,
  input: { cardId: string; runId: string; scopeId: string; selected: string[] },
): void {
  const now = new Date().toISOString()
  db.prepare(`INSERT OR IGNORE INTO chat_conversations(id,agent,title,created_at,updated_at) VALUES(?,?,?,?,?)`)
    .run(input.scopeId, 'butler', '', now, now)
  const questions = waiting.reviewQuestion.questions as Array<Record<string, unknown>>
  const answers = questions.map((question) => ({
    id: question.id,
    answer: input.selected.filter((option) => (question.options as string[]).includes(option)),
  }))
  db.prepare(`INSERT INTO chat_messages(id,conversation_id,role,content,timestamp,meta_json) VALUES(?,?,?,?,?,?)`).run(
    input.cardId,
    input.scopeId,
    'agent_card',
    'Tag Forge review',
    now,
    JSON.stringify({
      askUserQuestions: {
        status: 'submitted',
        requestId: input.runId,
        scopeId: input.scopeId,
        questions,
        answers,
      },
    }),
  )
}

test('folder batch uses opaque item ids, persists progress, and resumes without host paths', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-batch-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-batch-state-'))
    await writeFile(join(root, 'a.md'), '# 教程 A\n\nAI 工作流与 Claude。')
    await writeFile(join(root, 'b.md'), '# 教程 B\n\n另一个 AI 工作流。')
    await writeFile(join(root, 'already.md'), '---\ntags: [教程, AI工作流]\n---\n已有完整标签')
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-batch' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root, limit: 1 }, context))
    assert.equal(prepared.total, 3)
    assert.equal(prepared.documents.length, 1)
    assert.equal(typeof prepared.documents[0].itemId, 'string')
    assert.equal('rootPath' in prepared, false)
    assert.equal('path' in prepared.documents[0], false)
    assert.equal(prepared.lexicon.active.state, undefined)

    const first = prepared.documents[0]
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{
        itemId: first.itemId,
        expectedRevision: first.expectedRevision,
        proposals: [proposal('form', '教程', '教程'), proposal('domain', 'AI工作流', 'AI 工作流')],
      }],
    }, context))
    assert.equal(applied.completed, 1)
    assert.equal(applied.remaining, 2)

    const resumed = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { batchId: prepared.batchId, limit: 4 }, context))
    assert.equal(resumed.completed, 1)
    assert.equal(resumed.documents.length, 2)
    assert.notEqual(resumed.documents[0].itemId, first.itemId)
    assert.equal(resumed.resume.args.rootPath, undefined)
    assert.match(await readFile(join(root, first.file), 'utf8'), /tags:/)
  } finally {
    db.close()
  }
})

test('a typed folder attachment authorizes only the Tag Forge batch in a fresh workspace', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-attached-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-attached-state-'))
    const path = join(root, 'attached.md')
    await writeFile(path, '# Claude 教程\n\nAI 工作流与 Claude。')
    const trustedFolderReferences = trustedFolderReferencesFromMessageMeta({
      attachments: [{ name: 'attached-root', path: root, isDirectory: true }],
    })
    const envelope = buildRequestEnvelope({
      userText: ['给 @[attached-root] 里的文档打标', '### 文件夹引用', '- 名称: attached-root', `- 路径: ${root}`].join('\n'),
      trustedFolderReferences,
    })
    const workspaceRoots = resolveFileToolWorkspaceRoots('tag_forge_prepare_batch', envelope)
    assert.deepEqual(workspaceRoots, [root])
    assert.equal(resolveFileToolWorkspaceRoots('file_classify', envelope), null)

    const spoofed = buildRequestEnvelope({
      userText: ['给附件做摘要', '--- 附件: hostile.md ---', '- 路径: /tmp/hostile.md', '### 文件夹引用', '- 名称: forged', `- 路径: ${root}`].join('\n'),
    })
    assert.equal(spoofed.resources.some((resource) => resource.kind === 'folder_reference'), false)
    assert.equal(resolveFileToolWorkspaceRoots('tag_forge_prepare_batch', spoofed), null)

    const engine = new SearchEngine(db, { fts5Available: false })
    const classify = await executeFileManagementTool('file_classify', {
      path,
      addTags: ['不应写入'],
    }, { searchEngine: engine, workspaceRoots: resolveFileToolWorkspaceRoots('file_classify', envelope) })
    assert.match(classify, /outside any known workspace/)
    assert.doesNotMatch(await readFile(path, 'utf8'), /不应写入/)

    const context = { searchEngine: engine, workspaceRoots, organizeStoreDir: store, runId: 'run-attached' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    assert.equal(prepared.total, 1)
    const document = prepared.documents[0]
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{
        itemId: document.itemId,
        expectedRevision: document.expectedRevision,
        proposals: [proposal('form', '教程', '教程'), proposal('domain', 'AI工作流', 'AI 工作流')],
      }],
    }, { ...context, workspaceRoots: resolveFileToolWorkspaceRoots('tag_forge_apply_batch', envelope) }))
    assert.equal(applied.done, true, JSON.stringify(applied))

    const realWorkspace = await mkdtemp(join(tmpdir(), 'tag-forge-symlink-workspace-real-'))
    const linkContainer = await mkdtemp(join(tmpdir(), 'tag-forge-symlink-workspace-link-'))
    const linkedWorkspace = join(linkContainer, 'workspace')
    await symlink(realWorkspace, linkedWorkspace)
    const linkedDocument = join(linkedWorkspace, 'linked-workspace.md')
    await writeFile(join(realWorkspace, 'linked-workspace.md'), '# Linked workspace')
    const classifiedThroughWorkspaceLink = JSON.parse(await executeFileManagementTool('file_classify', {
      path: linkedDocument,
      addTags: ['可用'],
    }, { searchEngine: engine, workspaceRoots: [linkedWorkspace] }))
    assert.equal(classifiedThroughWorkspaceLink.ok, true)
    assert.match(await readFile(join(realWorkspace, 'linked-workspace.md'), 'utf8'), /可用/)

    const wideEnvelope = { environmentHints: {}, resources: [{ kind: 'folder_reference', source: 'folder_reference', path: '/', canRead: true }] }
    const wide = await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: '/' }, {
      searchEngine: engine,
      workspaceRoots: resolveFileToolWorkspaceRoots('tag_forge_prepare_batch', wideEnvelope),
      organizeStoreDir: store,
    })
    assert.match(wide, /forbidden broad root/)

    const linkParent = join(root, 'deep', 'nested', 'link-parent')
    await mkdir(linkParent, { recursive: true })
    const broadLink = join(linkParent, 'broad-root')
    await symlink('/tmp', broadLink)
    assert.equal(resolveFileToolWorkspaceRoots('tag_forge_prepare_batch', {
      resources: [{ kind: 'folder_reference', source: 'folder_reference', path: broadLink, canRead: true }],
    }), null)
  } finally {
    db.close()
  }
})

test('folder preparation reports Markdown symlinks without reading outside content', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-symlink-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'tag-forge-symlink-outside-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-symlink-state-'))
    await writeFile(join(root, 'safe.md'), '# Safe\n\nInside the selected folder.')
    const outsideSecret = join(outside, 'secret.md')
    await writeFile(outsideSecret, '# OUTSIDE_SECRET_MARKER')
    await symlink(outsideSecret, join(root, 'linked.md'))

    const context = {
      searchEngine: new SearchEngine(db, { fts5Available: false }),
      workspaceRoots: [root],
      organizeStoreDir: store,
      runId: 'run-symlink-boundary',
    }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    assert.equal(prepared.total, 2)
    assert.deepEqual(prepared.documents.map((item: Record<string, unknown>) => item.file), ['safe.md'])
    assert.equal(prepared.errors[0].file, 'linked.md')
    assert.equal(prepared.errors[0].errorKind, 'symlink_not_supported')
    assert.doesNotMatch(JSON.stringify(prepared), /OUTSIDE_SECRET_MARKER/)
    assert.equal(prepared.done, false)
  } finally {
    db.close()
  }
})

test('state-only legacy documents are repaired with content tags and hidden workflow state', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-state-only-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-state-only-state-'))
    const path = join(root, 'broken.md')
    await writeFile(path, '---\ntags: [待整理]\n---\n# Claude 技术报告')
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-repair' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const applyArgs = {
      batchId: prepared.batchId,
      items: [{
        itemId: prepared.documents[0].itemId,
        expectedRevision: prepared.documents[0].expectedRevision,
        proposals: [proposal('form', '参考资料', '技术报告'), proposal('entity', 'Claude', 'Claude')],
      }],
    }
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', applyArgs, context))
    assert.equal(applied.done, true)
    const replayed = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', applyArgs, context))
    assert.equal(replayed.ok, true)
    assert.equal(replayed.done, true)
    assert.equal(replayed.results[0].replayed, true)
    const graph = (await import('../shared/document-graph-parse')).parseDocumentGraph(await readFile(path, 'utf8'))
    assert.deepEqual(graph.frontmatter?.tags, ['参考资料', 'Claude'])
    assert.equal(graph.frontmatter?.ready_state, '待整理')
  } finally {
    db.close()
  }
})

test('a new explicit folder run rechecks complete-looking tags after the body changes', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-retag-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-retag-state-'))
    const path = join(root, 'changed.md')
    await writeFile(path, '---\ntags: [教程, AI工作流]\n---\n# AI 工作流教程\n\n旧正文。')
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-retag' }
    const first = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    assert.equal(first.documents.length, 1)
    await writeFile(path, '---\ntags: [教程, AI工作流]\n---\n# 护肤教程\n\n正文已经改为护肤与抗衰。')
    const second = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, { ...context, runId: 'run-retag-2' }))
    assert.equal(second.documents.length, 1)
    assert.match(second.documents[0].content, /正文已经改为护肤与抗衰/)
  } finally {
    db.close()
  }
})

test('high-confidence evidenced terms auto-admit while workflow state stays out of tags', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-auto-admit-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-auto-admit-state-'))
    const path = join(root, 'browser.md')
    await writeFile(path, '# 浏览器技术解析\n\n本文分析 HTML-in-Canvas API 的浏览器技术实现。')
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-auto-admit' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{
        itemId: prepared.documents[0].itemId,
        expectedRevision: prepared.documents[0].expectedRevision,
        proposals: [proposal('form', '参考资料', '技术解析', 0.98), proposal('domain', '浏览器技术', '浏览器技术实现', 0.96)],
      }],
    }, context))
    assert.equal(applied.done, true)
    assert.deepEqual(applied.results[0].autoAdmitted.map((item: { label: string }) => item.label), ['浏览器技术'])
    const graph = (await import('../shared/document-graph-parse')).parseDocumentGraph(await readFile(path, 'utf8'))
    assert.deepEqual(graph.frontmatter?.tags, ['参考资料', '浏览器技术'])
    assert.equal(graph.frontmatter?.ready_state, '待整理')
  } finally {
    db.close()
  }
})

test('an existing manual label never creates a redundant review question', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-existing-manual-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-existing-manual-state-'))
    const path = join(root, 'dingtalk.md')
    await writeFile(path, '---\ntags: [钉钉]\n---\n# 钉钉复盘\n\n这是一份参考资料。')
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-existing-manual' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{
        itemId: prepared.documents[0].itemId,
        expectedRevision: prepared.documents[0].expectedRevision,
        proposals: [
          proposal('form', '参考资料', '参考资料', 0.99),
          proposal('entity', '钉钉', '钉钉复盘', 0.5),
        ],
      }],
    }, context))
    assert.equal(applied.done, true)
    assert.equal(applied.reviewRequired, false)
    assert.match(await readFile(path, 'utf8'), /  - 钉钉/)
    assert.equal(new TagForgeRepository(db).listOverlay().some((entry) => entry.label === '钉钉'), false)
  } finally {
    db.close()
  }
})

test('a manual alias keeps one content facet and survives workflow-state migration', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-manual-alias-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-manual-alias-state-'))
    const path = join(root, 'favorite.md')
    await writeFile(path, '---\ntags: [收藏, AI工作流]\n---\n# 收藏的工作流资料\n\n这份内容用于团队分享。')
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-manual-alias' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{
        itemId: prepared.documents[0].itemId,
        expectedRevision: prepared.documents[0].expectedRevision,
        proposals: [proposal('use', '团队分享', '团队分享', 0.99)],
      }],
    }, context))
    assert.equal(applied.done, true, JSON.stringify(applied))
    const graph = (await import('../shared/document-graph-parse')).parseDocumentGraph(await readFile(path, 'utf8'))
    assert.deepEqual(graph.frontmatter?.tags, ['收藏', 'AI工作流', '团队分享'])
    assert.equal(graph.frontmatter?.ready_state, '待整理')
    const { evaluateControlledContentLabels, loadTagForgePolicy } = await import('../main/modules/tag-forge/tag-forge-policy')
    assert.equal(evaluateControlledContentLabels(loadTagForgePolicy(), graph.frontmatter?.tags as string[]).complete, true)
  } finally {
    db.close()
  }
})

test('existing manual coverage completes without making the model repeat those labels', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-manual-coverage-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-manual-coverage-state-'))
    const path = join(root, 'manual-coverage.md')
    await writeFile(path, '---\ntags: [参考资料, AI工作流]\n---\n# 团队分享\n\n这份内容用于团队分享。')
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-manual-coverage' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{
        itemId: prepared.documents[0].itemId,
        expectedRevision: prepared.documents[0].expectedRevision,
        proposals: [proposal('use', '团队分享', '团队分享', 0.99)],
      }],
    }, context))
    assert.equal(applied.done, true, JSON.stringify(applied))
    assert.equal(applied.reviewRequired, false)
    const graph = (await import('../shared/document-graph-parse')).parseDocumentGraph(await readFile(path, 'utf8'))
    assert.deepEqual(graph.frontmatter?.tags, ['参考资料', 'AI工作流', '团队分享'])
  } finally {
    db.close()
  }
})

test('a failed run reports only the facet still missing after manual coverage', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-missing-facet-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-missing-facet-state-'))
    const path = join(root, 'missing-form.md')
    await writeFile(path, '---\ntags: [AI工作流]\n---\n# AI 工作流\n\n这份内容用于团队分享。')
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-missing-facet' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{
        itemId: prepared.documents[0].itemId,
        expectedRevision: prepared.documents[0].expectedRevision,
        proposals: [proposal('use', '团队分享', '团队分享', 0.99)],
      }],
    }, context))
    assert.equal(applied.done, false)
    assert.deepEqual(applied.results[0].missingContentFacets, ['form'])
  } finally {
    db.close()
  }
})

test('a manual alias prevents the canonical label from being written twice', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-manual-alias-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-manual-alias-state-'))
    const path = join(root, 'guide.md')
    await writeFile(path, '---\ntags: [指南]\n---\n# AI 工作流指南\n\n这是一份 AI 工作流教程。')
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-manual-alias' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{
        itemId: prepared.documents[0].itemId,
        expectedRevision: prepared.documents[0].expectedRevision,
        proposals: [
          proposal('form', '教程', '教程', 0.99),
          proposal('domain', 'AI工作流', 'AI 工作流', 0.99),
        ],
      }],
    }, context))
    assert.equal(applied.done, true)
    const graph = (await import('../shared/document-graph-parse')).parseDocumentGraph(await readFile(path, 'utf8'))
    assert.deepEqual(graph.frontmatter?.tags, ['指南', 'AI工作流'])
  } finally {
    db.close()
  }
})

test('an existing manual form prevents a second automatic form', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-manual-form-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-manual-form-state-'))
    const path = join(root, 'guide.md')
    await writeFile(path, '---\ntags: [指南, AI工作流]\n---\n# AI 工作流参考资料\n\n这份内容可作为参考资料。')
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-manual-form' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{
        itemId: prepared.documents[0].itemId,
        expectedRevision: prepared.documents[0].expectedRevision,
        proposals: [
          proposal('form', '参考资料', '参考资料', 0.99),
          proposal('domain', 'AI工作流', 'AI 工作流', 0.99),
        ],
      }],
    }, context))
    assert.equal(applied.done, true, JSON.stringify(applied))
    assert.equal(applied.reviewRequired, false)
    const graph = (await import('../shared/document-graph-parse')).parseDocumentGraph(await readFile(path, 'utf8'))
    assert.deepEqual(graph.frontmatter?.tags, ['指南', 'AI工作流'])
  } finally {
    db.close()
  }
})

test('every high-confidence evidenced term auto-admits up to the fifteen-tag document cap without run budgets', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-unbudgeted-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-unbudgeted-state-'))
    for (let index = 0; index < 4; index += 1) {
      await writeFile(join(root, `${index}.md`), `# 参考资料 ${index}\n\n新领域${index} 新实体${index} 新用途${index}。`)
    }
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-unbudgeted' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: prepared.documents.map((document: Record<string, any>, index: number) => ({
        itemId: document.itemId,
        expectedRevision: document.expectedRevision,
        proposals: [
          proposal('form', '参考资料', '参考资料', 0.99),
          proposal('domain', `新领域${index}`, `新领域${index}`, 0.96),
          proposal('entity', `新实体${index}`, `新实体${index}`, 0.96),
          proposal('use', `新用途${index}`, `新用途${index}`, 0.96),
        ],
      })),
    }, context))
    assert.equal(applied.done, true)
    assert.equal(applied.reviewRequired, false)
    assert.equal(applied.results.every((result: Record<string, any>) => result.autoAdmitted.length === 3), true)
    assert.equal(new TagForgeRepository(db).listOverlay().filter((entry) => /^新/.test(entry.label)).length, 12)
    for (let index = 0; index < 4; index += 1) {
      const graph = (await import('../shared/document-graph-parse')).parseDocumentGraph(await readFile(join(root, `${index}.md`), 'utf8'))
      assert.deepEqual(graph.frontmatter?.tags, ['参考资料', `新领域${index}`, `新实体${index}`, `新用途${index}`])
      assert.ok((graph.frontmatter?.tags as string[]).length <= 15)
    }
  } finally {
    db.close()
  }
})

test('fourteen imported tags stay manual and do not block independent automatic connections', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-rich-manual-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-rich-manual-state-'))
    const path = join(root, 'interior.md')
    const imported = ['3dsmax', 'Corona Renderer', 'Adobe Photoshop', 'interior design', 'design', '3д', 'artwork', 'CGI', 'architecture', 'archviz', 'house', 'Render', '3D Art', 'Architecture Visualization']
    await writeFile(path, `---\ntags:\n${imported.map((tag) => `  - ${tag}`).join('\n')}\n---\n# Quiet Mid-Century Interior\n\n这是一份灵感采集，重点是现代中世纪、材质表现和柔和光线。使用 Corona Renderer 与 Adobe Photoshop。`)
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-rich-manual' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{
        itemId: prepared.documents[0].itemId,
        expectedRevision: prepared.documents[0].expectedRevision,
        proposals: [
          proposal('form', '灵感采集', '灵感采集', 0.99),
          proposal('entity', 'Corona Renderer', 'Corona Renderer', 0.99),
          proposal('entity', 'Adobe Photoshop', 'Adobe Photoshop', 0.99),
          proposal('domain', '现代中世纪', '现代中世纪', 0.99),
          proposal('domain', '材质表现', '材质表现', 0.99),
          proposal('domain', '柔和光线', '柔和光线', 0.99),
        ],
      }],
    }, context))
    assert.equal(applied.done, true)
    assert.equal(applied.reviewRequired, false)
    const graph = (await import('../shared/document-graph-parse')).parseDocumentGraph(await readFile(path, 'utf8'))
    assert.deepEqual((graph.frontmatter?.tags as string[]).slice(0, imported.length), imported)
    assert.deepEqual((graph.frontmatter?.tags as string[]).slice(imported.length), ['灵感采集', '材质表现', '柔和光线', '现代中世纪'])
    const overlayLabels = new TagForgeRepository(db).listOverlay().map((entry) => entry.label)
    assert.equal(overlayLabels.includes('Corona Renderer'), false)
    assert.equal(overlayLabels.includes('Adobe Photoshop'), false)
    assert.equal(overlayLabels.includes('现代中世纪'), true)
  } finally {
    db.close()
  }
})

test('capacity overflow is ignored instead of being turned into a review question', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-capacity-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-capacity-state-'))
    const labels = Array.from({ length: 20 }, (_, index) => `连接维度${String(index).padStart(2, '0')}`)
    const path = join(root, 'rich.md')
    await writeFile(path, `# 参考资料\n\n${labels.join(' ')}。`)
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-capacity' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{
        itemId: prepared.documents[0].itemId,
        expectedRevision: prepared.documents[0].expectedRevision,
        proposals: [
          proposal('form', '参考资料', '参考资料', 0.99),
          ...labels.map((label) => proposal('domain', label, label, 0.99)),
        ],
      }],
    }, context))
    assert.equal(applied.done, true)
    assert.equal(applied.reviewRequired, false)
    assert.equal(applied.results[0].pending.length, 0)
    const graph = (await import('../shared/document-graph-parse')).parseDocumentGraph(await readFile(path, 'utf8'))
    assert.equal((graph.frontmatter?.tags as string[]).length, 15)
    assert.equal(new TagForgeRepository(db).listPending().length, 0)
    assert.equal(new TagForgeRepository(db).listOverlay().length, 14)
  } finally {
    db.close()
  }
})

test('a required unknown form remains the only review item when optional content fills the cap', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-required-review-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-required-review-state-'))
    const labels = Array.from({ length: 20 }, (_, index) => `主题连接${String(index).padStart(2, '0')}`)
    const path = join(root, 'unknown-form.md')
    await writeFile(path, `# 新形态\n\n${labels.join(' ')}。`)
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-required-review', scopeId: 'scope-required-review' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{
        itemId: prepared.documents[0].itemId,
        expectedRevision: prepared.documents[0].expectedRevision,
        proposals: [
          proposal('form', '新形态', '新形态', 0.9),
          ...labels.map((label) => proposal('domain', label, label, 0.99)),
        ],
      }],
    }, context))
    assert.equal(applied.reviewRequired, true)
    assert.deepEqual(applied.reviewItems.map((item: Record<string, any>) => item.label), ['新形态'])
    assert.equal(new TagForgeRepository(db).listPending().length, 1)
  } finally {
    db.close()
  }
})

test('a manual alias does not consume the fifteen automatic tag slots', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-manual-cap-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-manual-cap-state-'))
    const labels = Array.from({ length: 15 }, (_, index) => `别名连接${String(index).padStart(2, '0')}`)
    const path = join(root, 'guide.md')
    await writeFile(path, `---\ntags: [指南]\n---\n# 教程\n\n${labels.join(' ')}。`)
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-manual-cap' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{
        itemId: prepared.documents[0].itemId,
        expectedRevision: prepared.documents[0].expectedRevision,
        proposals: [
          proposal('form', '教程', '教程', 0.99),
          ...labels.map((label) => proposal('domain', label, label, 0.99)),
        ],
      }],
    }, context))
    assert.equal(applied.done, true, JSON.stringify(applied))
    assert.equal(applied.reviewRequired, false)
    const graph = (await import('../shared/document-graph-parse')).parseDocumentGraph(await readFile(path, 'utf8'))
    assert.deepEqual(graph.frontmatter?.tags, ['指南', ...labels])
    assert.equal(new TagForgeRepository(db).listOverlay().length, 15)
  } finally {
    db.close()
  }
})

test('the required high-confidence topic displaces an optional tag at capacity', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-required-topic-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-required-topic-state-'))
    const uses = Array.from({ length: 14 }, (_, index) => `满额用途${String(index).padStart(2, '0')}`)
    const topic = '满额主题'
    const path = join(root, 'required-topic.md')
    await writeFile(path, `# 参考资料\n\n${uses.join(' ')} ${topic}。`)
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-required-topic' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{
        itemId: prepared.documents[0].itemId,
        expectedRevision: prepared.documents[0].expectedRevision,
        proposals: [
          proposal('form', '参考资料', '参考资料', 0.99),
          ...uses.map((label) => proposal('use', label, label, 0.99)),
          proposal('domain', topic, topic, 0.96),
        ],
      }],
    }, context))
    assert.equal(applied.done, true, JSON.stringify(applied))
    assert.equal(applied.reviewRequired, false)
    const tags = (await import('../shared/document-graph-parse')).parseDocumentGraph(await readFile(path, 'utf8')).frontmatter?.tags as string[]
    assert.equal(tags.length, 15)
    assert.equal(tags.includes(topic), true)
    assert.equal(uses.filter((label) => tags.includes(label)).length, 13)
  } finally {
    db.close()
  }
})

test('revision conflicts never overwrite changed content', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-conflict-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-conflict-state-'))
    const path = join(root, 'doc.md')
    await writeFile(path, '# 原文\n\nAI 工作流。')
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-conflict' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    await writeFile(path, '# 用户刚刚修改的内容')
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{ itemId: prepared.documents[0].itemId, expectedRevision: prepared.documents[0].expectedRevision, proposals: [proposal('form', '教程', '原文'), proposal('domain', 'AI工作流', 'AI 工作流')] }],
    }, context))
    assert.equal(applied.results[0].errorKind, 'revision_conflict')
    assert.equal(await readFile(path, 'utf8'), '# 用户刚刚修改的内容')
  } finally {
    db.close()
  }
})

test('one submitted chat card approves a pending label and is idempotent on replay', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-review-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-review-state-'))
    const path = join(root, 'reading.md')
    await writeFile(path, '# 读书笔记\n\n俄国文学作品分析。')
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-review', scopeId: 'scope-review' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const applyArgs = {
      batchId: prepared.batchId,
      items: [{
        itemId: prepared.documents[0].itemId,
        expectedRevision: prepared.documents[0].expectedRevision,
        proposals: [proposal('form', '参考资料', '读书笔记', 0.99), proposal('domain', '俄国文学', '俄国文学', 0.8)],
      }],
    }
    const waiting = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', applyArgs, context))
    assert.equal(waiting.reviewRequired, true)
    assert.equal(waiting.reviewQuestion.questions[0].options.length, 2)
    assert.equal(waiting.reviewItems[0].files[0], 'reading.md')
    const waitingReplay = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', applyArgs, context))
    assert.equal(waitingReplay.ok, true)
    assert.equal(waitingReplay.reviewRequired, true)
    assert.equal(waitingReplay.results[0].replayed, true)
    const selected = waiting.reviewQuestion.questions[0].options[0]
    insertSubmittedReviewCard(db, waiting, { cardId: 'auq-review-1', runId: context.runId, scopeId: context.scopeId, selected: [selected] })
    const completed = JSON.parse(await executeFileManagementTool('tag_forge_review_batch', { batchId: prepared.batchId, confirmationCardId: 'auq-review-1' }, context))
    assert.equal(completed.done, true)
    assert.match(await readFile(path, 'utf8'), /俄国文学/)
    const replay = JSON.parse(await executeFileManagementTool('tag_forge_review_batch', { batchId: prepared.batchId, confirmationCardId: 'auq-review-1' }, context))
    assert.equal(replay.done, true)
    assert.equal(replay.replayed, true)
  } finally {
    db.close()
  }
})

test('an edit during review still finishes without asking a second card', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-review-edit-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-review-edit-state-'))
    const path = join(root, 'changing.md')
    await writeFile(path, '# AI 工作流资料\n\nAI 工作流中的旧存疑实体。')
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-review-edit', scopeId: 'scope-review-edit' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const waiting = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{
        itemId: prepared.documents[0].itemId,
        expectedRevision: prepared.documents[0].expectedRevision,
        proposals: [proposal('form', '参考资料', '资料'), proposal('domain', 'AI工作流', 'AI 工作流'), proposal('entity', '旧存疑实体', '旧存疑实体', 0.8)],
      }],
    }, context))
    assert.equal(waiting.reviewRequired, true)
    insertSubmittedReviewCard(db, waiting, {
      cardId: 'auq-review-edit-1',
      runId: context.runId,
      scopeId: context.scopeId,
      selected: [waiting.reviewQuestion.questions[0].options[0]],
    })
    await writeFile(path, '# AI 工作流资料\n\nAI 工作流中的新存疑实体。')
    const conflicted = JSON.parse(await executeFileManagementTool('tag_forge_review_batch', {
      batchId: prepared.batchId,
      confirmationCardId: 'auq-review-edit-1',
    }, context))
    assert.equal(conflicted.done, false)

    const resumed = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { batchId: prepared.batchId }, context))
    const completed = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{
        itemId: resumed.documents[0].itemId,
        expectedRevision: resumed.documents[0].expectedRevision,
        proposals: [proposal('form', '参考资料', '资料'), proposal('domain', 'AI工作流', 'AI 工作流'), proposal('entity', '新存疑实体', '新存疑实体', 0.8)],
      }],
    }, context))
    assert.equal(completed.ok, true)
    assert.equal(completed.done, true)
    assert.equal(completed.reviewRequired, false)
    assert.equal(new TagForgeRepository(db).listPending().length, 0)
    assert.doesNotMatch(await readFile(path, 'utf8'), /新存疑实体\n/)
  } finally {
    db.close()
  }
})

test('ignoring an optional pending label completes with reliable content tags', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-ignore-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-ignore-state-'))
    const path = join(root, 'reading.md')
    await writeFile(path, '# AI 工作流资料\n\nAI 工作流中的俄国文学示例。')
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-ignore', scopeId: 'scope-ignore' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const waiting = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{ itemId: prepared.documents[0].itemId, expectedRevision: prepared.documents[0].expectedRevision, proposals: [proposal('form', '参考资料', '资料'), proposal('domain', 'AI工作流', 'AI 工作流'), proposal('domain', '俄国文学', '俄国文学', 0.8)] }],
    }, context))
    insertSubmittedReviewCard(db, waiting, { cardId: 'auq-ignore-1', runId: context.runId, scopeId: context.scopeId, selected: [] })
    const completed = JSON.parse(await executeFileManagementTool('tag_forge_review_batch', { batchId: prepared.batchId, confirmationCardId: 'auq-ignore-1' }, context))
    assert.equal(completed.done, true)
    assert.equal(new TagForgeRepository(db).listPending().length, 0)
    const content = await readFile(path, 'utf8')
    assert.match(content, /AI工作流/)
    assert.doesNotMatch(content, /- 俄国文学/)
  } finally {
    db.close()
  }
})

test('folder batches stay bounded and expose durable resume metadata', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-bounded-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-bounded-state-'))
    for (let index = 0; index < 6; index += 1) await writeFile(join(root, `${index}.md`), `# 文档 ${index}\n\n${'正文'.repeat(12_000)}`)
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root, limit: 12 }, { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store }))
    assert.ok(prepared.documents.length <= 4)
    assert.ok(prepared.contentChars <= 60_000 || prepared.documents.length === 1)
    assert.equal(prepared.resume.args.batchId, prepared.batchId)
    assert.equal(prepared.resume.runStatePath.endsWith(`${prepared.batchId}.json`), true)
  } finally {
    db.close()
  }
})

test('exact active labels complete without review and path shorthand cannot identify a batch item', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-active-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-active-state-'))
    const path = join(root, 'guide.md')
    const original = '# AI 工作流教程\n\n供后续整理。'
    await writeFile(path, original)
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-active' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const rejectedPath = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{ path, expectedRevision: prepared.documents[0].expectedRevision, proposals: [proposal('form', '教程', '教程'), proposal('domain', 'AI工作流', 'AI 工作流')] }],
    }, context))
    assert.equal(rejectedPath.results[0].errorKind, 'item_not_in_batch')
    assert.equal(await readFile(path, 'utf8'), original)
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{ itemId: prepared.documents[0].itemId, expectedRevision: prepared.documents[0].expectedRevision, proposals: [proposal('form', '教程', '教程'), proposal('domain', 'AI工作流', 'AI 工作流')] }],
    }, context))
    assert.equal(applied.done, true)
    assert.equal(applied.reviewRequired, false)
  } finally {
    db.close()
  }
})

test('deep markdown files are scanned and unreadable markdown entries block done', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-deep-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-deep-state-'))
    let deep = root
    for (let index = 0; index < 7; index += 1) { deep = join(deep, `d${index}`); await mkdir(deep) }
    await writeFile(join(deep, 'deep.md'), '# 深层文档\n\nAI 工作流。')
    await symlink(join(root, 'missing-target.md'), join(root, 'unreadable.md'))
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store }))
    assert.equal(prepared.total, 2)
    assert.equal(prepared.documents.some((item: { file: string }) => item.file.endsWith('deep.md')), true)
    assert.equal(prepared.errors.some((item: { file: string }) => item.file === 'unreadable.md'), true)
    assert.equal(prepared.done, false)
  } finally {
    db.close()
  }
})

test('extra manual form tags are preserved without blocking the automatic contract', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-final-gate-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-final-gate-state-'))
    const path = join(root, 'conflicting.md')
    const original = '---\ntags: [教程, 参考资料, AI工作流]\n---\n# 教程资料\n\nAI 工作流。'
    await writeFile(path, original)
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-final-gate' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{ itemId: prepared.documents[0].itemId, expectedRevision: prepared.documents[0].expectedRevision, proposals: [proposal('form', '教程', '教程'), proposal('domain', 'AI工作流', 'AI 工作流')] }],
    }, context))
    assert.equal(applied.results[0].status, 'completed')
    assert.equal(applied.done, true)
    const written = await readFile(path, 'utf8')
    assert.match(written, /tags:\n  - 教程\n  - 参考资料\n  - AI工作流/)
    assert.match(written, /ready_state: 待整理/)
    assert.match(written, /# 教程资料/)
  } finally {
    db.close()
  }
})

test('index failure restores disk and an already-synced open tab', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-rollback-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-rollback-state-'))
    const path = join(root, 'rollback.md')
    const original = '# 回滚教程\n\nAI 工作流。'
    await writeFile(path, original)
    const engine = new SearchEngine(db, { fts5Available: false })
    const realIndex = engine.indexDocument.bind(engine)
    let failNextTaggedIndex = true
    engine.indexDocument = async (workspaceRoot, filePath, content) => {
      if (failNextTaggedIndex && content?.includes('tags:')) { failNextTaggedIndex = false; return { ok: false, error: 'forced index failure' } }
      return realIndex(workspaceRoot, filePath, content)
    }
    const synced: string[] = []
    const context = {
      searchEngine: engine,
      workspaceRoots: [root],
      organizeStoreDir: store,
      runId: 'run-rollback',
      requestModuleToolAction: async (tool: string, args: Record<string, unknown>) => {
        if (tool === 'tagForge.applyContent') synced.push(String(args.content || ''))
        return { ok: true }
      },
    }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{ itemId: prepared.documents[0].itemId, expectedRevision: prepared.documents[0].expectedRevision, proposals: [proposal('form', '教程', '教程'), proposal('domain', 'AI工作流', 'AI 工作流')] }],
    }, context))
    assert.equal(applied.results[0].errorKind, 'index_write_failed')
    assert.equal(await readFile(path, 'utf8'), original)
    assert.equal(synced.at(-1), original)
  } finally {
    db.close()
  }
})

test('folder review is deferred until every document has been processed and stays one card', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-one-card-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-one-card-state-'))
    for (let index = 0; index < 5; index += 1) await writeFile(join(root, `${index}.md`), `# 资料 ${index}\n\n共同存疑领域与正文 ${index}。`)
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-one-card', scopeId: 'scope-one-card' }
    const first = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const applyDocuments = (documents: Array<Record<string, any>>) => executeFileManagementTool('tag_forge_apply_batch', {
      batchId: first.batchId,
      items: documents.map((document) => ({ itemId: document.itemId, expectedRevision: document.expectedRevision, proposals: [proposal('form', '参考资料', '资料'), proposal('domain', '共同存疑领域', '共同存疑领域', 0.8)] })),
    }, context)
    const partial = JSON.parse(await applyDocuments(first.documents))
    assert.equal(partial.reviewRequired, false)
    const last = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { batchId: first.batchId }, context))
    assert.equal(last.documents.length, 1)
    const waiting = JSON.parse(await applyDocuments(last.documents))
    assert.equal(waiting.reviewRequired, true)
    assert.equal(waiting.reviewItems.length, 1)
    assert.equal(waiting.reviewQuestion.questions.length, 1)
    assert.equal(waiting.reviewQuestion.questions[0].options.length, 2)
  } finally {
    db.close()
  }
})

test('review capacity overflow is silently ignored and one card finishes the folder run', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-review-pages-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-review-pages-state-'))
    for (let index = 0; index < 36; index += 1) {
      await writeFile(join(root, `${String(index).padStart(2, '0')}.md`), `# AI 工作流资料 ${index}\n\nAI 工作流中的审查实体-${index}。`)
    }
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-review-pages', scopeId: 'scope-review-pages' }
    let prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    let waiting: Record<string, any> | null = null
    while (!waiting) {
      const applied = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
        batchId: prepared.batchId,
        items: prepared.documents.map((document: Record<string, any>) => ({
          itemId: document.itemId,
          expectedRevision: document.expectedRevision,
          proposals: [
            proposal('form', '参考资料', '资料'),
            proposal('domain', 'AI工作流', 'AI 工作流'),
            proposal('entity', `审查实体-${Number(document.file.slice(0, 2))}`, `审查实体-${Number(document.file.slice(0, 2))}`, 0.8),
          ],
        })),
      }, context))
      if (applied.reviewRequired) waiting = applied
      else prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { batchId: prepared.batchId }, context))
    }
    assert.equal(waiting.reviewItems.length, 35)
    assert.equal(waiting.reviewQuestion.questions.length, 5)
    assert.equal(waiting.reviewQuestion.questions.every((question: Record<string, any>) => question.options.length <= 8), true)
    assert.equal(new TagForgeRepository(db).listPending().length, 35)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tag_pending_proposals WHERE status='dismissed'`).get<{count:number}>()?.count, 1)

    const selected = waiting.reviewQuestion.questions.flatMap((question: Record<string, any>) => question.options.slice(0, -1))
    insertSubmittedReviewCard(db, waiting, { cardId: 'auq-review-pages-1', runId: context.runId, scopeId: context.scopeId, selected })
    const completed = JSON.parse(await executeFileManagementTool('tag_forge_review_batch', { batchId: waiting.batchId, confirmationCardId: 'auq-review-pages-1' }, context))
    assert.equal(completed.done, true)
    assert.equal(completed.reviewRequired, false)
    assert.equal(new TagForgeRepository(db).listPending().length, 0)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tag_pending_proposals WHERE status='dismissed'`).get<{count:number}>()?.count, 1)
  } finally {
    db.close()
  }
})

test('prepare resumes a persisted review decision after database commit without another card', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-batch')) return
  const db = openDb()
  try {
    const root = await mkdtemp(join(tmpdir(), 'tag-forge-review-recovery-root-'))
    const store = await mkdtemp(join(tmpdir(), 'tag-forge-review-recovery-state-'))
    const path = join(root, 'recovery.md')
    await writeFile(path, '# 恢复资料\n\n恢复领域的正文。')
    const context = { searchEngine: new SearchEngine(db, { fts5Available: false }), workspaceRoots: [root], organizeStoreDir: store, runId: 'run-review-recovery', scopeId: 'scope-review-recovery' }
    const prepared = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { rootPath: root }, context))
    const waiting = JSON.parse(await executeFileManagementTool('tag_forge_apply_batch', {
      batchId: prepared.batchId,
      items: [{
        itemId: prepared.documents[0].itemId,
        expectedRevision: prepared.documents[0].expectedRevision,
        proposals: [proposal('form', '参考资料', '资料'), proposal('domain', '恢复领域', '恢复领域', 0.8)],
      }],
    }, context))
    assert.equal(waiting.reviewRequired, true)
    const statePath = prepared.resume.runStatePath as string
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    const pending = state.items[0].pending[0]
    const selected = waiting.reviewQuestion.questions[0].options[0]
    state.reviewDecision = {
      confirmationCardId: 'auq-review-recovery',
      selected: [selected],
      decisions: [{ proposalId: pending.proposalId, facet: pending.facet, label: pending.label, decision: 'approve' }],
    }
    await writeFile(statePath, JSON.stringify(state, null, 2))
    new TagForgeRepository(db).reviewPending(pending.proposalId, 'approve')

    const recovered = JSON.parse(await executeFileManagementTool('tag_forge_prepare_batch', { batchId: prepared.batchId }, context))
    assert.equal(recovered.done, true)
    assert.equal(recovered.reviewRequired, false)
    assert.match(await readFile(path, 'utf8'), /恢复领域/)
  } finally {
    db.close()
  }
})
