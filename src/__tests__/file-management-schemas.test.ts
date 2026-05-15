/**
 * Shape tests for the file_management Zod schemas (Phase 2.5 PR 6).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FileSearchSchema,
  FileLocateSchema,
  FileReadExcerptSchema,
  FileGetBacklinksSchema,
  FileGetGraphSchema,
  FileClassifySchema,
  FileRenameSchema,
  FileMoveSchema,
} from '../main/modules/tools/schemas/file-management-schemas'

test('FileSearchSchema requires query; sources must be string[]', () => {
  assert.equal(FileSearchSchema.safeParse({ query: 'x' }).success, true)
  assert.equal(FileSearchSchema.safeParse({}).success, false)
  assert.equal(FileSearchSchema.safeParse({ query: 'x', sources: ['document'] }).success, true)
  assert.equal(FileSearchSchema.safeParse({ query: 'x', sources: [1, 2] }).success, false)
  assert.equal(FileSearchSchema.safeParse({ query: 'x', sources: 'not-array' }).success, false)
})

test('FileLocateSchema requires path, anchor optional', () => {
  assert.equal(FileLocateSchema.safeParse({ path: '/x' }).success, true)
  assert.equal(FileLocateSchema.safeParse({ path: '/x', anchor: 'intro' }).success, true)
  assert.equal(FileLocateSchema.safeParse({}).success, false)
})

test('FileReadExcerptSchema requires path and accepts anchor or line ranges', () => {
  assert.equal(FileReadExcerptSchema.safeParse({ path: '/x' }).success, true)
  assert.equal(FileReadExcerptSchema.safeParse({ path: '/x', anchor: '第二章' }).success, true)
  assert.equal(
    FileReadExcerptSchema.safeParse({ path: '/x', lineStart: 10, lineEnd: 30, maxChars: 12000 }).success,
    true,
  )
  assert.equal(FileReadExcerptSchema.safeParse({}).success, false)
  assert.equal(FileReadExcerptSchema.safeParse({ path: '/x', lineStart: '10' }).success, false)
})

test('FileGetBacklinksSchema requires path', () => {
  assert.equal(FileGetBacklinksSchema.safeParse({ path: '/x' }).success, true)
  assert.equal(FileGetBacklinksSchema.safeParse({}).success, false)
})

test('FileGetGraphSchema accepts empty object', () => {
  assert.equal(FileGetGraphSchema.safeParse({}).success, true)
  assert.equal(FileGetGraphSchema.safeParse({ depth: 3 }).success, true)
})

test('FileClassifySchema requires path; setFrontmatter must be object', () => {
  assert.equal(FileClassifySchema.safeParse({ path: '/x' }).success, true)
  assert.equal(
    FileClassifySchema.safeParse({
      path: '/x',
      addTags: ['a'],
      removeTags: ['b'],
      setFrontmatter: { author: 'me' },
    }).success,
    true,
  )
  assert.equal(FileClassifySchema.safeParse({ path: '/x', setFrontmatter: 'nope' }).success, false)
})

test('FileRenameSchema requires path + newName', () => {
  assert.equal(FileRenameSchema.safeParse({ path: '/x', newName: 'y.md' }).success, true)
  assert.equal(FileRenameSchema.safeParse({ path: '/x' }).success, false)
  assert.equal(FileRenameSchema.safeParse({ newName: 'y.md' }).success, false)
})

test('FileMoveSchema requires path + destDir', () => {
  assert.equal(FileMoveSchema.safeParse({ path: '/x', destDir: '/y' }).success, true)
  assert.equal(FileMoveSchema.safeParse({ path: '/x' }).success, false)
  assert.equal(FileMoveSchema.safeParse({ destDir: '/y' }).success, false)
  assert.equal(
    FileMoveSchema.safeParse({ path: '/x', destDir: '/y', overwrite: 'yes' }).success,
    false,
  )
})
