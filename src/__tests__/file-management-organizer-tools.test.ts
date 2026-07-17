import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import test, { after, before } from 'node:test'

import { Document, Packer, Paragraph } from 'docx'
import * as xlsx from 'xlsx'

import { executeFileManagementTool } from '../main/modules/tools/file-management-tools'
import {
  DocumentWorkerBridge,
  setDocumentWorkerForTests,
  shutdownDocumentWorker,
  type DocumentWorkerLike,
} from '../main/modules/document-engine/document-worker-bridge'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

function createSourceDocumentWorker(): DocumentWorkerLike {
  const tsxApiUrl = import.meta.resolve('tsx/esm/api')
  const workerModuleUrl = new URL('../main/modules/document-engine/document-worker.ts', import.meta.url).href
  const bootstrap = [
    `import { tsImport } from ${JSON.stringify(tsxApiUrl)};`,
    `await tsImport(${JSON.stringify(workerModuleUrl)}, import.meta.url);`,
  ].join('\n')
  return new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), {
    type: 'module',
  }) as unknown as DocumentWorkerLike
}

before(() => {
  setDocumentWorkerForTests(new DocumentWorkerBridge(createSourceDocumentWorker, 60_000))
})

after(async () => {
  await shutdownDocumentWorker()
})

test('file-management-organizer-tools declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'file-management-organizer-tools transitive sqlite load')
})

function fakeSearchEngine(root: string) {
  const canonicalRoot = realpathSync(root)
  const contains = (path: string, candidate: string) =>
    path === candidate || path.startsWith(`${candidate}/`)
  const db = {
    prepare() {
      return {
        get: () => undefined,
        all: () => [],
        run: () => undefined,
      }
    },
  }
  return {
    findWorkspaceRootForPath: (path: string) =>
      contains(path, root) || contains(path, canonicalRoot) ? root : null,
    indexDocument: async () => ({ ok: true }),
    getRepository: () => ({
      getConnection: () => db,
      ensureWorkspace: () => 1,
      deletePath: () => undefined,
    }),
  }
}

function fakeSearchEngineForRoots(roots: string[], indexedPaths: string[]) {
  const rootPairs = roots.map((root) => ({ root, canonicalRoot: realpathSync(root) }))
  const indexed = new Set(indexedPaths)
  const db = {
    prepare() {
      return {
        get: (path: string) => indexed.has(path)
          ? { id: indexedPaths.indexOf(path) + 1, path, source_type: 'document' }
          : undefined,
        all: () => [],
        run: () => undefined,
      }
    },
  }
  return {
    findWorkspaceRootForPath: (path: string) => rootPairs.find(({ root, canonicalRoot }) =>
      path === root
      || path.startsWith(`${root}/`)
      || path === canonicalRoot
      || path.startsWith(`${canonicalRoot}/`))?.root || null,
    indexDocument: async () => ({ ok: true }),
    getRepository: () => ({
      getConnection: () => db,
      ensureWorkspace: () => 1,
      deletePath: () => undefined,
    }),
  }
}

async function makeDocx(path: string, text: string): Promise<void> {
  const doc = new Document({ sections: [{ children: [new Paragraph(text)] }] })
  await writeFile(path, await Packer.toBuffer(doc))
}

async function makeXlsx(path: string, text: string): Promise<void> {
  const workbook = xlsx.utils.book_new()
  const sheet = xlsx.utils.aoa_to_sheet([['title', 'body'], ['row', text]])
  xlsx.utils.book_append_sheet(workbook, sheet, 'Sheet1')
  await writeFile(path, xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
}

test('file organizer tools preview, apply, and undo a confirmed folder cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-file-organizer-root-'))
  const store = await mkdtemp(join(tmpdir(), 'ready-file-organizer-store-'))
  try {
    const source = join(root, 'draft.md')
    await writeFile(source, '# Draft\n整理目标正文', 'utf-8')
    const context = { searchEngine: fakeSearchEngine(root) as never, organizeStoreDir: store }

    const inventory = JSON.parse(await executeFileManagementTool('file_inventory', {
      rootPath: root,
      includeSummaries: true,
    }, context))
    assert.equal(inventory.ok, true)
    assert.equal(inventory.items[0].name, 'draft.md')
    assert.match(inventory.items[0].summary, /整理目标正文/)

    const extracted = JSON.parse(await executeFileManagementTool('file_extract_text', {
      path: source,
      maxChars: 8,
    }, context))
    assert.equal(extracted.ok, true)
    assert.equal(extracted.truncated, true)
    assert.match(extracted.text, /^# Draft/)

    const preview = JSON.parse(await executeFileManagementTool('file_organize_preview', {
      rootPath: root,
      createFolders: ['sorted'],
      operations: [{ path: source, destDir: join(root, 'sorted'), newName: 'final.md' }],
    }, context))
    assert.equal(preview.ok, true)
    assert.equal(preview.requiresConfirmation, true)
    assert.equal(existsSync(join(root, 'sorted', 'final.md')), false)

    const denied = JSON.parse(await executeFileManagementTool('file_organize_apply', {
      planId: preview.planId,
      confirmed: false,
      confirmedVia: 'ask_user_questions',
    }, context))
    assert.equal(denied.ok, false)
    assert.equal(existsSync(source), true)

    const applied = JSON.parse(await executeFileManagementTool('file_organize_apply', {
      planId: preview.planId,
      confirmed: true,
      confirmedVia: 'ask_user_questions',
    }, context))
    assert.equal(applied.ok, true)
    const moved = join(root, 'sorted', 'final.md')
    assert.equal(existsSync(source), false)
    assert.equal(await readFile(moved, 'utf-8'), '# Draft\n整理目标正文')

    const undone = JSON.parse(await executeFileManagementTool('file_organize_undo', {
      journalId: applied.journalId,
    }, context))
    assert.equal(undone.ok, true)
    assert.equal(existsSync(source), true)
    assert.equal(existsSync(moved), false)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(store, { recursive: true, force: true })
  }
})

test('file tools honor current file-manager roots over stale indexed roots', async () => {
  const allowedRoot = await mkdtemp(join(tmpdir(), 'ready-file-scope-allowed-'))
  const staleRoot = await mkdtemp(join(tmpdir(), 'ready-file-scope-stale-'))
  try {
    const allowedPath = join(allowedRoot, 'note.md')
    const stalePath = join(staleRoot, 'old.md')
    await writeFile(allowedPath, '# Allowed\n当前文件管理器目录内容', 'utf-8')
    await writeFile(stalePath, '# Stale\n旧索引目录内容', 'utf-8')
    const context = {
      searchEngine: fakeSearchEngineForRoots([allowedRoot, staleRoot], [allowedPath, stalePath]) as never,
      workspaceRoots: [allowedRoot],
    }

    const allowed = JSON.parse(await executeFileManagementTool('file_read_excerpt', {
      path: allowedPath,
    }, context))
    assert.equal(allowed.ok, true)
    assert.match(allowed.content, /当前文件管理器目录内容/)

    const denied = JSON.parse(await executeFileManagementTool('file_read_excerpt', {
      path: stalePath,
    }, context))
    assert.equal(denied.ok, false)
    assert.match(denied.error, /outside any known workspace/)
  } finally {
    await rm(allowedRoot, { recursive: true, force: true })
    await rm(staleRoot, { recursive: true, force: true })
  }
})

test('file organizer preview reports conflicts before touching disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-file-organizer-conflict-'))
  const store = await mkdtemp(join(tmpdir(), 'ready-file-organizer-store-'))
  try {
    const source = join(root, 'source.md')
    const destDir = join(root, 'dest')
    const target = join(destDir, 'source.md')
    await mkdir(destDir)
    await writeFile(source, 'source', 'utf-8')
    await writeFile(target, 'existing', 'utf-8')
    const preview = JSON.parse(await executeFileManagementTool('file_organize_preview', {
      rootPath: root,
      operations: [{ path: source, destDir }],
    }, { searchEngine: fakeSearchEngine(root) as never, organizeStoreDir: store }))
    assert.equal(preview.ok, false)
    assert.equal(preview.conflicts[0].kind, 'target_exists')
    assert.equal(await readFile(source, 'utf-8'), 'source')
    assert.equal(await readFile(target, 'utf-8'), 'existing')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(store, { recursive: true, force: true })
  }
})

test('file extraction supports docx and xlsx text paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-file-organizer-extract-'))
  try {
    const context = { searchEngine: fakeSearchEngine(root) as never }
    const docxPath = join(root, 'brief.docx')
    const xlsxPath = join(root, 'sheet.xlsx')
    await makeDocx(docxPath, '0123456789 DOCX 分类正文')
    await makeXlsx(xlsxPath, 'XLSX 分类正文')

    const docxText = JSON.parse(await executeFileManagementTool('file_extract_text', { path: docxPath }, context))
    assert.equal(docxText.ok, true, JSON.stringify(docxText))
    assert.match(docxText.text, /DOCX 分类正文/)

    const docxWindow = JSON.parse(await executeFileManagementTool('file_extract_text', {
      path: docxPath,
      offset: 5,
      maxChars: 4,
    }, context))
    assert.equal(docxWindow.text, '5678')
    assert.equal(docxWindow.offset, 5)
    assert.equal(docxWindow.nextOffset, 9)
    assert.ok(docxWindow.totalChars > docxWindow.text.length)

    const xlsxText = JSON.parse(await executeFileManagementTool('file_extract_text', { path: xlsxPath }, context))
    assert.equal(xlsxText.ok, true)
    assert.match(xlsxText.text, /XLSX 分类正文/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('file extraction supports pdf text when a system PDF generator is available', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ready-file-organizer-pdf-'))
  try {
    const sourceText = join(root, 'source.txt')
    const pdfPath = join(root, 'brief.pdf')
    await writeFile(sourceText, 'PDF classify body\n', 'utf-8')
    const generated = spawnSync('/usr/sbin/cupsfilter', ['-m', 'application/pdf', sourceText], {
      encoding: 'buffer',
      maxBuffer: 2 * 1024 * 1024,
    })
    if (generated.status !== 0 || generated.stdout.length === 0) {
      t.skip('cupsfilter is unavailable for generating a test PDF')
      return
    }
    await writeFile(pdfPath, generated.stdout)
    const pdfText = JSON.parse(await executeFileManagementTool('file_extract_text', {
      path: pdfPath,
    }, { searchEngine: fakeSearchEngine(root) as never }))
    assert.equal(pdfText.ok, true, JSON.stringify(pdfText))
    assert.match(pdfText.text, /PDF classify body/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('file organizer rejects symlink escapes from an authorized root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-file-organizer-symlink-'))
  const outside = await mkdtemp(join(tmpdir(), 'ready-file-organizer-outside-'))
  const store = await mkdtemp(join(tmpdir(), 'ready-file-organizer-store-'))
  try {
    const outsideFile = join(outside, 'outside.md')
    const linkedFile = join(root, 'linked.md')
    const destDir = join(root, 'dest')
    await mkdir(destDir)
    await writeFile(outsideFile, 'outside', 'utf-8')
    await symlink(outsideFile, linkedFile)
    const preview = JSON.parse(await executeFileManagementTool('file_organize_preview', {
      rootPath: root,
      operations: [{ path: linkedFile, destDir }],
    }, { searchEngine: fakeSearchEngine(root) as never, organizeStoreDir: store }))
    assert.equal(preview.ok, false)
    assert.equal(preview.conflicts[0].kind, 'source_invalid')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
    await rm(store, { recursive: true, force: true })
  }
})


test('file_copy copies within one workspace root and refuses unsafe overwrite targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-file-copy-root-'))
  try {
    const source = join(root, 'source.md')
    const destDir = join(root, 'exports')
    await mkdir(destDir, { recursive: true })
    await writeFile(source, '# Source', 'utf-8')
    const context = { searchEngine: fakeSearchEngine(root) as never }

    const copied = JSON.parse(await executeFileManagementTool('file_copy', {
      path: source,
      destDir,
      newName: 'copy.md',
    }, context))
    assert.equal(copied.ok, true)
    assert.equal(await readFile(join(destDir, 'copy.md'), 'utf-8'), '# Source')

    const refusedExisting = JSON.parse(await executeFileManagementTool('file_copy', {
      path: source,
      destDir,
      newName: 'copy.md',
    }, context))
    assert.equal(refusedExisting.ok, false)
    assert.match(refusedExisting.error, /EEXIST|target exists/i)

    await writeFile(join(destDir, 'copy.md'), 'old', 'utf-8')
    const overwritten = JSON.parse(await executeFileManagementTool('file_copy', {
      path: source,
      destDir,
      newName: 'copy.md',
      overwrite: true,
    }, context))
    assert.equal(overwritten.ok, true)
    assert.equal(await readFile(join(destDir, 'copy.md'), 'utf-8'), '# Source')

    const outside = await mkdtemp(join(tmpdir(), 'ready-file-copy-outside-'))
    try {
      const crossRoot = await executeFileManagementTool('file_copy', {
        path: source,
        destDir: outside,
        newName: 'copy.md',
      }, context)
      assert.match(crossRoot, /outside any known workspace|cross-workspace copy not supported/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('file_copy refuses to overwrite a symlink target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-file-copy-symlink-'))
  try {
    const source = join(root, 'source.md')
    const outside = join(root, 'outside.md')
    const destDir = join(root, 'exports')
    await mkdir(destDir, { recursive: true })
    await writeFile(source, '# Source', 'utf-8')
    await writeFile(outside, 'outside', 'utf-8')
    await symlink(outside, join(destDir, 'copy.md'))
    const context = { searchEngine: fakeSearchEngine(root) as never }

    const result = JSON.parse(await executeFileManagementTool('file_copy', {
      path: source,
      destDir,
      newName: 'copy.md',
      overwrite: true,
    }, context))
    assert.equal(result.ok, false)
    assert.match(result.error, /symlink/i)
    assert.equal(await readFile(outside, 'utf-8'), 'outside')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
