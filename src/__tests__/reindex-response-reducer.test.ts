/**
 * Unit tests for `reduceReindexResponse`. The reducer is what saves the panel
 * from persisting a "successful" IndexStatus on top of a root that actually
 * failed — it must catch transport failures, missing data, top-level
 * `data.ok=false`, AND per-source adapter errors (which can fire even when
 * the FS pass succeeded).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { reduceReindexResponse } from '../renderer/components/layout/reindex-response-reducer'

const ROOT = '/Users/test/Documents/proj-a'

test('reduceReindexResponse: transport failure → rootIndexed=false, error, docCount=0', () => {
  const outcome = reduceReindexResponse(ROOT, { success: false, error: 'bridge crashed' }, 'fs-only')
  assert.equal(outcome.docCount, 0)
  assert.equal(outcome.rootIndexed, false)
  assert.ok(outcome.error, 'must surface a failure when success=false')
  assert.match(outcome.error!, /bridge crashed/)
})

test('reduceReindexResponse: success=true but data missing → rootIndexed=false, error, docCount=0', () => {
  const outcome = reduceReindexResponse(ROOT, { success: true }, 'fs-only')
  assert.equal(outcome.docCount, 0)
  assert.equal(outcome.rootIndexed, false)
  assert.ok(outcome.error, 'must surface a failure when data is undefined')
})

test('reduceReindexResponse fs-only: data.ok=false → rootIndexed=false, error wins, docCount=0', () => {
  // The bug the reducer is named after: the previous code only checked
  // transport success, so `{success:true, data:{ok:false, error:'…'}}`
  // slipped through and the panel persisted a "success".
  const outcome = reduceReindexResponse(
    ROOT,
    {
      success: true,
      data: { ok: false, error: 'ENOENT: workspace gone', indexed: 0, skipped: 0 },
    },
    'fs-only',
  )
  assert.equal(outcome.docCount, 0, 'failed FS pass contributes no docs')
  assert.equal(outcome.rootIndexed, false, 'FS pass failure means root is NOT indexed')
  assert.ok(outcome.error, 'engine-level ok=false must surface as an error')
  assert.match(outcome.error!, /ENOENT|workspace gone/)
})

test('reduceReindexResponse fs-only: data.ok=true → rootIndexed=true, docCount aggregated, no error', () => {
  const outcome = reduceReindexResponse(
    ROOT,
    { success: true, data: { ok: true, indexed: 42, skipped: 8 } },
    'fs-only',
  )
  assert.equal(outcome.docCount, 50)
  assert.equal(outcome.rootIndexed, true)
  assert.equal(outcome.error, null)
})

test('reduceReindexResponse all-sources: data.ok=false → rootIndexed=false, error, docCount=0', () => {
  const outcome = reduceReindexResponse(
    ROOT,
    {
      success: true,
      data: {
        ok: false,
        perSource: {
          document: { indexed: 12, skipped: 3, removed: 0, scanned: 15 },
        },
      },
    },
    'all-sources',
  )
  assert.equal(outcome.docCount, 0, 'when the FS pass fails, perSource counts are not trusted')
  assert.equal(outcome.rootIndexed, false, 'FS pass failure means root is NOT indexed')
  assert.ok(outcome.error, 'top-level ok=false must surface')
})

test('reduceReindexResponse all-sources: ok=true BUT perSource.document.error populated → rootIndexed=false (defensive)', () => {
  // Regression test for the malformed-envelope case: even when the response's
  // top-level `ok: true` says "we ran without aborting", a failed FS pass
  // leaves its error in `perSource[FS_SOURCE_TYPE]`. The reducer must NOT
  // trust the envelope flag in isolation — otherwise a stale or buggy main
  // process could trick the panel into persisting a "successful" IndexStatus
  // on top of a root whose file tree never actually indexed.
  // (The main process's reindexAllSources also now propagates fsResult.ok
  // into the top-level ok field, so this state should be unreachable in
  // practice. This test locks the reducer's defense-in-depth.)
  const outcome = reduceReindexResponse(
    ROOT,
    {
      success: true,
      data: {
        ok: true,
        perSource: {
          document: { indexed: 0, skipped: 0, error: 'ENOENT: workspace gone' },
          rss: { indexed: 4, skipped: 0 },
        },
      },
    },
    'all-sources',
  )
  assert.equal(outcome.rootIndexed, false, 'FS adapter error invalidates the root regardless of top-level ok')
  assert.equal(outcome.docCount, 0, 'failed FS root cannot contribute trustable docs')
  assert.ok(outcome.error, 'must surface the FS adapter error')
  assert.match(outcome.error!, /ENOENT|workspace gone/)
})

test('reduceReindexResponse all-sources: FS ok + per-source error → rootIndexed=true (partial-success contract)', () => {
  // Critical contract: a shared adapter (RSS / bookmark / calendar / agent)
  // failure must NOT invalidate the root's FS index. The panel relies on
  // `rootIndexed` to decide whether to count this root as a successful pass
  // — treating it as a failure would discard a perfectly valid file-tree
  // index just because one auxiliary adapter timed out. The error is still
  // surfaced as a non-blocking warning.
  const outcome = reduceReindexResponse(
    ROOT,
    {
      success: true,
      data: {
        ok: true,
        perSource: {
          document: { indexed: 10, skipped: 2 },
          rss: { indexed: 0, skipped: 0, error: 'RSS adapter timed out' },
          bookmark: { indexed: 5, skipped: 1 },
        },
      },
    },
    'all-sources',
  )
  assert.equal(outcome.docCount, 18, 'docs from healthy adapters are counted')
  assert.equal(outcome.rootIndexed, true, 'FS index is valid; only a shared adapter failed')
  assert.ok(outcome.error, 'failing adapter must surface an error string')
  assert.match(outcome.error!, /rss.*timed out/i)
})

test('reduceReindexResponse all-sources: all healthy → rootIndexed=true, docCount aggregated, no error', () => {
  const outcome = reduceReindexResponse(
    ROOT,
    {
      success: true,
      data: {
        ok: true,
        perSource: {
          document: { indexed: 10, skipped: 2 },
          rss: { indexed: 4, skipped: 0 },
          calendar: { indexed: 1, skipped: 0 },
        },
      },
    },
    'all-sources',
  )
  assert.equal(outcome.docCount, 17)
  assert.equal(outcome.rootIndexed, true)
  assert.equal(outcome.error, null)
})
