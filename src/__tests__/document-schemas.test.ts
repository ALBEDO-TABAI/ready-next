/**
 * Shape tests for the document domain Zod schemas (Phase 2.5 PR 7).
 *
 * Focused on the high-signal invariants: required field coverage, optional
 * passthrough, and that the object-typed componentSpec/componentSpecPatch
 * accept record-shaped values (not strings / primitives).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DocumentNewTabSchema,
  DocumentOpenTabSchema,
  DocumentSwitchTabSchema,
  DocumentRenameTabSchema,
  DocumentSetContentSchema,
  DocumentInsertWidgetSchema,
  DocumentListWidgetsSchema,
  DocumentUpdateWidgetSchema,
  DocumentRemoveWidgetSchema,
  DocumentReplaceTextSchema,
  DocumentReplaceExactSchema,
  DocumentFormatSectionSchema,
  DocumentRewriteSectionSchema,
  DocumentSaveTabSchema,
} from '../main/modules/tools/schemas/document-schemas'

test('DocumentNewTabSchema accepts empty + title-only', () => {
  assert.equal(DocumentNewTabSchema.safeParse({}).success, true)
  assert.equal(DocumentNewTabSchema.safeParse({ title: '我的文档' }).success, true)
  assert.equal(DocumentNewTabSchema.safeParse({ title: '我的文档', path: '/tmp/我的文档.md' }).success, true)
  assert.equal(DocumentNewTabSchema.safeParse({ title: 42 }).success, false)
})

test('DocumentOpenTabSchema requires path', () => {
  assert.equal(DocumentOpenTabSchema.safeParse({ path: '/x.md' }).success, true)
  assert.equal(DocumentOpenTabSchema.safeParse({}).success, false)
})

test('DocumentSwitchTabSchema requires target', () => {
  assert.equal(DocumentSwitchTabSchema.safeParse({ target: 'tab-1' }).success, true)
  assert.equal(DocumentSwitchTabSchema.safeParse({}).success, false)
})

test('DocumentRenameTabSchema requires title, tabId optional', () => {
  assert.equal(DocumentRenameTabSchema.safeParse({ title: 't' }).success, true)
  assert.equal(DocumentRenameTabSchema.safeParse({ title: 't', tabId: 'x' }).success, true)
  assert.equal(DocumentRenameTabSchema.safeParse({}).success, false)
})

test('DocumentSetContentSchema requires content', () => {
  assert.equal(DocumentSetContentSchema.safeParse({ content: '# H' }).success, true)
  assert.equal(DocumentSetContentSchema.safeParse({}).success, false)
})

test('DocumentInsertWidgetSchema requires title + position; accepts componentSpec object', () => {
  const ok = DocumentInsertWidgetSchema.safeParse({
    title: 'w',
    position: 'append_end',
    componentSpec: { component: 'StatCard', props: { value: 1 } },
  })
  assert.equal(ok.success, true)
  assert.equal(
    DocumentInsertWidgetSchema.safeParse({ title: 'w' }).success,
    false,
  )
  assert.equal(
    DocumentInsertWidgetSchema.safeParse({ title: 'w', position: 'append_end', componentSpec: 'oops' })
      .success,
    false,
  )
})

test('DocumentListWidgetsSchema accepts empty object', () => {
  assert.equal(DocumentListWidgetsSchema.safeParse({}).success, true)
})

test('DocumentUpdateWidgetSchema requires target; componentSpec + patch must be objects if present', () => {
  assert.equal(DocumentUpdateWidgetSchema.safeParse({ target: 'w' }).success, true)
  assert.equal(DocumentUpdateWidgetSchema.safeParse({}).success, false)
  assert.equal(
    DocumentUpdateWidgetSchema.safeParse({
      target: 'w',
      componentSpec: { component: 'X' },
      componentSpecPatch: { props: { a: 1 } },
      occurrence: 2,
    }).success,
    true,
  )
  assert.equal(
    DocumentUpdateWidgetSchema.safeParse({ target: 'w', occurrence: 'not-number' }).success,
    false,
  )
})

test('DocumentRemoveWidgetSchema requires target', () => {
  assert.equal(DocumentRemoveWidgetSchema.safeParse({ target: 'w' }).success, true)
  assert.equal(DocumentRemoveWidgetSchema.safeParse({}).success, false)
})

test('DocumentReplaceTextSchema requires from + to', () => {
  assert.equal(DocumentReplaceTextSchema.safeParse({ from: 'a', to: 'b' }).success, true)
  assert.equal(DocumentReplaceTextSchema.safeParse({ from: 'a' }).success, false)
})

test('DocumentReplaceExactSchema requires target + replacement', () => {
  assert.equal(
    DocumentReplaceExactSchema.safeParse({ target: 't', replacement: 'r' }).success,
    true,
  )
  assert.equal(DocumentReplaceExactSchema.safeParse({ target: 't' }).success, false)
})

test('DocumentFormatSectionSchema requires sectionTitle', () => {
  assert.equal(
    DocumentFormatSectionSchema.safeParse({ sectionTitle: '引言' }).success,
    true,
  )
  assert.equal(DocumentFormatSectionSchema.safeParse({}).success, false)
})

test('DocumentRewriteSectionSchema requires sectionTitle + content', () => {
  assert.equal(
    DocumentRewriteSectionSchema.safeParse({ sectionTitle: '引言', content: '...' }).success,
    true,
  )
  assert.equal(
    DocumentRewriteSectionSchema.safeParse({ sectionTitle: '引言' }).success,
    false,
  )
})

test('DocumentSaveTabSchema accepts empty object', () => {
  assert.equal(DocumentSaveTabSchema.safeParse({}).success, true)
  assert.equal(DocumentSaveTabSchema.safeParse({ tabId: 'tab-1' }).success, true)
  assert.equal(DocumentSaveTabSchema.safeParse({ path: '/tmp/new.md' }).success, true)
  assert.equal(DocumentSaveTabSchema.safeParse({ tabId: 7 }).success, false)
})
