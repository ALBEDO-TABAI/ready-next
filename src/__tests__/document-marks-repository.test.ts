import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DocumentMarksRepository } from '../main/modules/document-engine/document-marks-repository'

interface TestMarkRow {
  id: string
  kind: 'bookmark' | 'note'
  document_path: string
  title: string
  group_name: string
  note_text: string | null
  excerpt: string | null
  line_start: number | null
  line_end: number | null
  anchor_title: string | null
  anchor_ordinal: number | null
  anchor_progress: number | null
  anchor_status: 'linked' | 'stale'
  sort_order: number
  created_at: string
  updated_at: string
}

class FakeMarkDb {
  constructor(private readonly rows: TestMarkRow[]) {}

  exec(_sql: string): void {}
  close(): void {}

  prepare(sql: string) {
    const unsupported = () => {
      throw new Error(`Unsupported FakeMarkDb statement: ${sql}`)
    }
    if (sql.includes('SELECT DISTINCT document_path')) {
      return {
        run: unsupported,
        get: unsupported,
        all: <R = unknown>(documentPath: unknown, likePattern: unknown): R[] => {
          const suffix = String(likePattern).replace(/^%/, '')
          const paths = new Set(
            this.rows
              .map((row) => row.document_path)
              .filter((path) => path !== documentPath && path.endsWith(suffix)),
          )
          return Array.from(paths).map((path) => ({ document_path: path })) as R[]
        },
      }
    }

    if (sql.includes('SELECT *') && sql.includes('document_path IN')) {
      return {
        run: unsupported,
        get: unsupported,
        all: <R = unknown>(...paths: unknown[]): R[] => this.rows
          .filter((row) => paths.includes(row.document_path))
          .sort((a, b) => (
            a.kind.localeCompare(b.kind) ||
            a.group_name.localeCompare(b.group_name) ||
            a.sort_order - b.sort_order ||
            b.updated_at.localeCompare(a.updated_at)
          )) as R[],
      }
    }

    throw new Error(`Unexpected SQL in FakeMarkDb: ${sql}`)
  }
}

function makeNote(id: string, documentPath: string, groupName: string): TestMarkRow {
  return {
    id,
    kind: 'note',
    document_path: documentPath,
    title: `note ${id}`,
    group_name: groupName,
    note_text: `body ${id}`,
    excerpt: `excerpt ${id}`,
    line_start: 1,
    line_end: 1,
    anchor_title: null,
    anchor_ordinal: null,
    anchor_progress: null,
    anchor_status: 'linked',
    sort_order: Date.now(),
    created_at: '2026-06-20T00:00:00.000Z',
    updated_at: '2026-06-20T00:00:00.000Z',
  }
}

test('document marks follow a moved markdown file when the old path is gone', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ready-doc-marks-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const newPath = join(root, '多看书', '遥远的向日葵地', '遥远的向日葵地.md')
  const oldPath = join(root, '遥远的向日葵地', '遥远的向日葵地.md')
  mkdirSync(join(root, '多看书', '遥远的向日葵地'), { recursive: true })
  rmSync(join(root, '遥远的向日葵地'), { recursive: true, force: true })
  writeFileSync(newPath, '# 遥远的向日葵地\n', { flag: 'wx' })
  assert.equal(existsSync(oldPath), false)

  const db = new FakeMarkDb([
    makeNote('old-note', oldPath, '感慨'),
    makeNote('new-note', newPath, '默认'),
  ])

  const marks = new DocumentMarksRepository(db).list(newPath)

  assert.deepEqual(new Set(marks.map((mark) => `${mark.id}:${mark.groupName}`)), new Set([
    'new-note:默认',
    'old-note:感慨',
  ]))
})

test('document marks do not merge two existing copies with the same folder and file name', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ready-doc-marks-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const newPath = join(root, '多看书', '遥远的向日葵地', '遥远的向日葵地.md')
  const oldPath = join(root, '遥远的向日葵地', '遥远的向日葵地.md')
  mkdirSync(join(root, '多看书', '遥远的向日葵地'), { recursive: true })
  mkdirSync(join(root, '遥远的向日葵地'), { recursive: true })
  writeFileSync(newPath, '# new\n', { flag: 'wx' })
  writeFileSync(oldPath, '# old\n', { flag: 'wx' })

  const db = new FakeMarkDb([
    makeNote('old-note', oldPath, '感慨'),
    makeNote('new-note', newPath, '默认'),
  ])

  const marks = new DocumentMarksRepository(db).list(newPath)

  assert.deepEqual(
    marks.map((mark) => mark.id),
    ['new-note'],
  )
})
