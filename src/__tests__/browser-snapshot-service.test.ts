import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import {
  BrowserSnapshotService,
  parseBrowserSnapshotRef,
} from '../main/modules/browser-engine/browser-snapshot-service'
import { DEFAULT_AGENT_PAGE_MAP_MAX_BYTES } from '../main/modules/tools/browser-observe-tools'

function fixture() {
  let url = 'https://example.test/a'
  let timeOrigin = 100
  let mutationRevision = 0
  const controller = {
    getActiveTab: () => ({ id: 'tab-a' }),
    executeJS: async () => ({ url, title: 'Fixture', timeOrigin, mutationRevision }),
  } as unknown as BrowserController
  return {
    controller,
    mutate: () => { mutationRevision += 1 },
    navigate: (next: string) => { url = next; timeOrigin += 100; mutationRevision = 0 },
  }
}

function rawPayload(revision: number, names = ['Save']): Record<string, unknown> {
  return {
    pageIdentity: { url: 'https://example.test/a' },
    pageMap: {
      generation: revision,
      targets: names.map((name, index) => ({
        targetId: `${revision}:0:${index + 1}`,
        role: 'button',
        name,
      })),
    },
  }
}

test('snapshot cache reuses a clean document and refreshes after mutation', async () => {
  const service = new BrowserSnapshotService()
  const page = fixture()
  let captures = 0
  const capture = (revision: number) => {
    captures += 1
    return Promise.resolve(rawPayload(revision))
  }
  const first = await service.capture(page.controller, 'tab-a', 16_384, capture)
  const second = await service.capture(page.controller, 'tab-a', 16_384, capture)
  assert.equal(captures, 1)
  assert.equal(second, first)

  page.mutate()
  const third = await service.capture(page.controller, 'tab-a', 16_384, capture)
  assert.equal(captures, 2)
  assert.equal((third.pageIdentity as Record<string, unknown>).snapshotRevision, 2)
})

test('opaque refs bind tab, document epoch and snapshot revision', async () => {
  const service = new BrowserSnapshotService()
  const page = fixture()
  const first = await service.capture(page.controller, 'tab-a', 16_384, async (revision) => rawPayload(revision))
  const ref = String(((first.pageMap as { targets: Array<{ targetId: string }> }).targets[0]).targetId)
  assert.deepEqual(parseBrowserSnapshotRef(ref), {
    tabId: 'tab-a',
    documentEpoch: 1,
    snapshotRevision: 1,
    rawTargetId: '1:0:1',
  })
  assert.equal((await service.resolveRef(page.controller, 'tab-b', ref)).ok, false)
  assert.equal((await service.resolveRef(page.controller, 'tab-a', ref)).ok, true)

  page.mutate()
  const staleSnapshot = await service.resolveRef(page.controller, 'tab-a', ref)
  assert.equal(staleSnapshot.ok, false)
  if (!staleSnapshot.ok) assert.equal(staleSnapshot.errorCode, 'stale_snapshot')

  await service.capture(page.controller, 'tab-a', 16_384, async (revision) => rawPayload(revision))
  assert.equal(service.rebindRef(page.controller, 'tab-a', ref).ok, true)

  page.navigate('https://example.test/b')
  const staleDocument = await service.resolveRef(page.controller, 'tab-a', ref)
  assert.equal(staleDocument.ok, false)
  if (!staleDocument.ok) assert.equal(staleDocument.errorCode, 'stale_document')
})

test('snapshot rebind refuses ambiguous semantic matches', async () => {
  const service = new BrowserSnapshotService()
  const page = fixture()
  const first = await service.capture(page.controller, 'tab-a', 16_384, async (revision) => rawPayload(revision))
  const ref = String(((first.pageMap as { targets: Array<{ targetId: string }> }).targets[0]).targetId)
  page.mutate()
  await service.capture(page.controller, 'tab-a', 16_384, async (revision) => rawPayload(revision, ['Save', 'Save']))
  const rebound = service.rebindRef(page.controller, 'tab-a', ref)
  assert.equal(rebound.ok, false)
})

test('default page-map budget is half the previous 32 KiB baseline', () => {
  assert.equal(DEFAULT_AGENT_PAGE_MAP_MAX_BYTES, 16_384)
})

test('one snapshot budget covers text and targets while find retains tail recall', async () => {
  const service = new BrowserSnapshotService()
  const page = fixture()
  const names = Array.from({ length: 1_000 }, (_, index) => (
    index === 999 ? 'Tail Submit' : `Very descriptive page target ${index} ${'x'.repeat(48)}`
  ))
  const payload = await service.capture(
    page.controller,
    'tab-a',
    DEFAULT_AGENT_PAGE_MAP_MAX_BYTES,
    async (revision) => ({
      ...rawPayload(revision, names),
      pageMap: {
        ...(rawPayload(revision, names).pageMap as Record<string, unknown>),
        text: `${'large page body '.repeat(3_000)}Tail Submit`,
      },
    }),
  )

  assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= DEFAULT_AGENT_PAGE_MAP_MAX_BYTES)
  const publicMap = payload.pageMap as { returnedTargets: number; totalTargets: number }
  assert.ok(publicMap.returnedTargets < publicMap.totalTargets)
  assert.equal(publicMap.totalTargets, 1_000)

  const found = service.find(page.controller, 'tab-a', { query: 'Tail Submit', limit: 20 })
  assert.equal(found?.total, 1)
  assert.equal(found?.matches[0]?.name, 'Tail Submit')
})
