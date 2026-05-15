import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveIndexedDocumentCandidate,
  type IndexedDocumentConnection,
  type IndexedDocumentRow,
} from '../main/modules/tools/file-locate-path'

function fakeConnection(rows: IndexedDocumentRow[]): IndexedDocumentConnection {
  return {
    prepare(sql) {
      return {
        get(path: unknown) {
          if (!sql.includes('WHERE path = ? LIMIT 1')) return undefined
          return rows.find((row) => row.path === path)
        },
        all(matchName: unknown, name: unknown, suffixLike: unknown) {
          if (!sql.includes('AND name = ?')) return []
          const suffix = String(suffixLike).replace(/^%\//, '').replace(/\\([\\%_])/g, '$1')
          return rows.filter((row) => {
            const nameMatches = Boolean(matchName) && row.path.split('/').at(-1) === name
            return row.path.endsWith(`/${suffix}`) || nameMatches
          })
        },
      }
    },
  }
}

test('file locate path resolver accepts an exact indexed path', () => {
  const result = resolveIndexedDocumentCandidate(fakeConnection([
    { id: 1, path: '/workspace/docs/a.md', source_type: 'document' },
  ]), '/workspace/docs/a.md')

  assert.equal(result.kind, 'found')
  if (result.kind === 'found') assert.equal(result.row.path, '/workspace/docs/a.md')
})

test('file locate path resolver accepts a unique attachment-style filename', () => {
  const result = resolveIndexedDocumentCandidate(fakeConnection([
    { id: 1, path: '/workspace/novels/白痴.md', source_type: 'document' },
  ]), '白痴.md')

  assert.equal(result.kind, 'found')
  if (result.kind === 'found') assert.equal(result.row.path, '/workspace/novels/白痴.md')
})

test('file locate path resolver accepts a unique relative suffix', () => {
  const result = resolveIndexedDocumentCandidate(fakeConnection([
    { id: 1, path: '/workspace/a/notes.md', source_type: 'document' },
    { id: 2, path: '/workspace/books/notes.md', source_type: 'document' },
  ]), 'books/notes.md')

  assert.equal(result.kind, 'found')
  if (result.kind === 'found') assert.equal(result.row.path, '/workspace/books/notes.md')
})

test('file locate path resolver reports ambiguous filenames instead of guessing', () => {
  const result = resolveIndexedDocumentCandidate(fakeConnection([
    { id: 1, path: '/workspace/a/notes.md', source_type: 'document' },
    { id: 2, path: '/workspace/b/notes.md', source_type: 'document' },
  ]), 'notes.md')

  assert.equal(result.kind, 'ambiguous')
  if (result.kind === 'ambiguous') {
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), [
      '/workspace/a/notes.md',
      '/workspace/b/notes.md',
    ])
  }
})
