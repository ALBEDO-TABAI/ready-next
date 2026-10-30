import assert from 'node:assert/strict'
import test from 'node:test'
import { confirmDocumentIndex } from '../main/modules/document-engine/document-index-confirmation'

type Engine = Parameters<typeof confirmDocumentIndex>[0]

test('a save outside every indexed workspace needs no index confirmation', async () => {
  let indexed = 0
  const engine = { findWorkspaceRootForPath: () => undefined, indexDocument: async () => { indexed++; return { ok: true } } } as unknown as Engine
  await confirmDocumentIndex(engine, '/Users/someone/Downloads/note.md', '# note')
  assert.equal(indexed, 0)
})

test('a save before the search engine starts still succeeds', async () => {
  await confirmDocumentIndex(null, '/vault/page.md', '# page')
})

test('an indexed file whose index update fails is reported as a write failure', async () => {
  const engine = { findWorkspaceRootForPath: () => '/vault', indexDocument: async () => ({ ok: false, error: 'boom' }) } as unknown as Engine
  await assert.rejects(confirmDocumentIndex(engine, '/vault/page.md', '# page'), (error: Error & { code?: string }) => error.code === 'write_failed')
})
