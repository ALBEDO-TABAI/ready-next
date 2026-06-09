import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Document, Packer, Paragraph } from 'docx'
import * as xlsx from 'xlsx'

import { executeFileManagementTool } from '../main/modules/tools/file-management-tools'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('file-management-organizer-tools declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'file-management-organizer-tools transitive sqlite load')
})

function fakeSearchEngine(root: string) {
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
    findWorkspaceRootForPath: (path: string) => path === root || path.startsWith(`${root}/`) ? root : null,
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
    await makeDocx(docxPath, 'DOCX 分类正文')
    await makeXlsx(xlsxPath, 'XLSX 分类正文')

    const docxText = JSON.parse(await executeFileManagementTool('file_extract_text', { path: docxPath }, context))
    assert.equal(docxText.ok, true)
    assert.match(docxText.text, /DOCX 分类正文/)

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
    assert.equal(pdfText.ok, true)
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
